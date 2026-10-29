import {
  observationKey,
  syncResultSchema,
  type ConnectionContext,
  type Observation,
  type SyncRequest,
  type SyncResult,
} from "@netrics/connector-sdk";
import { describe, expect, it } from "vitest";

import {
  addDays,
  adAccountToday,
  APPLE_ADS_BACKFILL_DAYS,
  APPLE_ADS_METRIC_KEYS,
  appleAdsDaysLabel,
  AppleAdsApiError,
  chunkRange,
  createAppleAdsClient,
  createAppleAdsConnector,
  LOOKBACK_DAYS,
  MAX_REPORT_DAYS,
  OTHERS,
  REPORT_PAGE_SIZE,
  syncCampaignPage,
} from "./index.js";
import {
  createFakeAppleAds,
  fixture,
  jsonResponse,
  type FakeAppleAds,
  type FakeDay,
  type FakeReport,
  type FakeReportCampaign,
} from "./test-helpers.js";

// Offline tests of the campaign report sync (#374) on a fake of Apple's
// campaign report shaped after its documentation, and on the documented
// response shape itself (fixtures/report-*.json). The clock is fixed.

const TOKEN = "apple-ads-access-token-sync";
const US = "4100000001";
const EU = "4100000002";
const APP = "1000000001";
/** 2026-10-29 12:00 UTC: 05:00 in Los Angeles, 13:00 in Berlin. */
const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const TODAY = "2026-10-29";

const noSleep = async () => {};

function connector(now = NOW) {
  return createAppleAdsConnector({ sleep: noSleep, now: () => now });
}

function context(
  adAccountId = US,
  extra: Record<string, unknown> = {
    currency: "USD",
    timeZone: "America/Los_Angeles",
  },
): ConnectionContext {
  return {
    connectionId: `apple-ads-${adAccountId}`,
    config: { adAccountId, ...extra },
    credentials: { accessToken: TOKEN },
  };
}

function fake(
  reports: Record<string, FakeReport>,
  failures: Parameters<typeof createFakeAppleAds>[0]["failures"] = [],
): FakeAppleAds {
  return createFakeAppleAds({
    users: [{ tokens: [TOKEN], acls: "acls-several" }],
    reports,
    failures,
  });
}

/** One day's numbers in one country. */
function d(spend: string, impressions = 100, tapInstalls = 1): FakeDay {
  return {
    spend,
    impressions,
    taps: Math.round(impressions / 10),
    tapInstalls,
    viewInstalls: 1,
    tapNewDownloads: tapInstalls,
    viewNewDownloads: 1,
  };
}

function campaign(
  id: string,
  days: FakeReportCampaign["days"],
  extra: Partial<FakeReportCampaign> = {},
): FakeReportCampaign {
  return { id, name: `Campaign ${id}`, app: APP, days, ...extra };
}

function request(overrides: Partial<SyncRequest> = {}): SyncRequest {
  return {
    mode: "backfill",
    from: new Date(NOW - APPLE_ADS_BACKFILL_DAYS * 86_400_000).toISOString(),
    to: new Date(NOW).toISOString(),
    ...overrides,
  };
}

/** Runs pages like the sync engine until done. */
async function syncAll(
  api: FakeAppleAds,
  req: SyncRequest,
  ctx: ConnectionContext = context(),
  now = NOW,
): Promise<{ pages: SyncResult[]; observations: Observation[] }> {
  const pages: SyncResult[] = [];
  let cursor = req.cursor;
  for (let page = 0; page < 100; page += 1) {
    const result = syncResultSchema.parse(
      await connector(now).sync(
        ctx,
        { ...req, ...(cursor ? { cursor } : {}) },
        api.runtime,
      ),
    );
    pages.push(result);
    if (result.done) {
      return { pages, observations: pages.flatMap((p) => p.observations) };
    }
    expect(result.nextCursor).not.toBe(cursor);
    cursor = result.nextCursor;
  }
  throw new Error("did not finish");
}

interface ReportBody {
  timeRange: {
    start: string;
    end: string;
    timeZone: string;
    granularity?: string;
  };
  groupBy?: string[];
  pagination: { offset: number; pageSize: number };
  options?: unknown;
}

function reportBodies(api: FakeAppleAds): ReportBody[] {
  return api.requests
    .filter((r) => r.url.pathname === "/v1/reports/apps/campaigns/query")
    .map((r) => r.body as ReportBody);
}

function sum(
  observations: Observation[],
  metricKey: string,
  where: Record<string, string> = {},
): number {
  return observations
    .filter(
      (o) =>
        o.metricKey === metricKey &&
        Object.entries(where).every(([k, v]) => o.dimensions[k] === v),
    )
    .reduce((total, o) => total + o.value, 0);
}

function span(start: string, end: string): number {
  return (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1;
}

describe("report windows", () => {
  it("backfills 12 months in whole-month ranges of at most 90 days, newest first, never past retention", async () => {
    const api = fake({ [US]: { currency: "USD", campaigns: [] } });
    const { pages } = await syncAll(api, request());
    const ranges = reportBodies(api)
      .filter((body) => body.groupBy === undefined)
      .map((body) => body.timeRange);
    expect(pages.length).toBe(ranges.length);
    expect(pages.length).toBeGreaterThanOrEqual(5);
    const oldest = addDays(TODAY, -(APPLE_ADS_BACKFILL_DAYS - 1));
    expect(ranges[0]!.end).toBe(TODAY);
    expect(ranges.at(-1)!.start).toBe(oldest);
    for (const [index, range] of ranges.entries()) {
      expect(span(range.start, range.end)).toBeLessThanOrEqual(MAX_REPORT_DAYS);
      expect(range.start >= oldest).toBe(true);
      expect(range.timeZone).toBe("ORTZ");
      expect(range.granularity).toBe("DAILY");
      // Whole months: each range starts on the 1st (or at retention) and
      // the next (older) one ends the day before.
      if (range.start !== oldest)
        expect(range.start.endsWith("-01")).toBe(true);
      const older = ranges[index + 1];
      if (older) expect(older.end).toBe(addDays(range.start, -1));
    }
  });

  it("keeps every range within 90 days and whole months whatever the position", () => {
    for (let offset = 0; offset < 400; offset += 7) {
      const next = addDays("2026-10-29", -offset);
      const range = chunkRange(
        { floor: "2025-10-30", newest: "2026-10-29", next },
        "2025-10-30",
      );
      expect(span(range.start, range.end)).toBeLessThanOrEqual(90);
      expect(range.end).toBe(next);
      expect(range.start >= "2025-10-30").toBe(true);
    }
  });

  it("asks for no EMPTY_METRICS rows, ORTZ days and pages of 1000, and one day without granularity", async () => {
    const api = fake({
      [US]: {
        currency: "USD",
        campaigns: [
          campaign("5100000001", { "2026-11-01": { US: d("4.00") } }),
        ],
      },
    });
    // A window of one day: the 1st, today in Berlin.
    const { observations } = await syncAll(
      api,
      request({
        mode: "incremental",
        from: "2026-11-01T00:00:00.000Z",
        to: "2026-11-01T12:00:00.000Z",
      }),
      context(US, { currency: "USD", timeZone: "Europe/Berlin" }),
      Date.parse("2026-11-01T12:00:00.000Z"),
    );
    const bodies = reportBodies(api);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.options).toBeUndefined();
      expect(body.timeRange).toEqual({
        start: "2026-11-01",
        end: "2026-11-01",
        timeZone: "ORTZ",
      });
      expect(body.pagination.pageSize).toBe(REPORT_PAGE_SIZE);
    }
    // One day answers in totalMetrics, read as that day.
    expect(sum(observations, APPLE_ADS_METRIC_KEYS.spend)).toBe(400);
  });

  it("re-reads the last 3 days on the next incremental sync", async () => {
    const api = fake({ [US]: { currency: "USD", campaigns: [] } });
    const { pages } = await syncAll(
      api,
      request({
        mode: "incremental",
        from: `${addDays(TODAY, -1)}T00:00:00.000Z`,
      }),
    );
    // Los Angeles is still on the 29th at 05:00: the newest day is the 29th.
    expect(pages.at(-1)!.nextCursor).toBe(
      `${addDays(TODAY, -(LOOKBACK_DAYS - 1))}T00:00:00.000Z`,
    );
  });
});

describe("time zone", () => {
  it("reads days of the ad account's zone and labels them", async () => {
    // 2026-10-29 03:00 UTC is still the 28th in Los Angeles.
    const early = Date.parse("2026-10-29T03:00:00.000Z");
    expect(adAccountToday(early, "America/Los_Angeles")).toBe("2026-10-28");
    expect(adAccountToday(early, "Europe/Berlin")).toBe("2026-10-29");
    expect(adAccountToday(early, "Pacific/Kiritimati")).toBe("2026-10-29");

    const api = fake({ [US]: { currency: "USD", campaigns: [] } });
    await syncAll(
      api,
      request({ mode: "incremental", from: "2026-10-27T00:00:00.000Z" }),
      context(),
      early,
    );
    expect(reportBodies(api)[0]!.timeRange.end).toBe("2026-10-28");

    expect(appleAdsDaysLabel("America/Los_Angeles")).toBe(
      "Days in America/Los_Angeles, as in Apple Ads",
    );
    expect(appleAdsDaysLabel("Europe/Berlin", "de")).toBe(
      "Tage in Europe/Berlin, wie in Apple Ads",
    );
  });

  it("refuses an unknown time zone instead of reading UTC days", async () => {
    const api = fake({ [US]: { currency: "USD", campaigns: [] } });
    await expect(
      connector().sync(
        context(US, { currency: "USD", timeZone: "Mars/Olympus" }),
        request(),
        api.runtime,
      ),
    ).rejects.toThrow("time zone");
  });

  it("asks Apple for currency and time zone when the connection has none", async () => {
    const api = fake({ [US]: { currency: "USD", campaigns: [] } });
    await syncAll(api, request({ mode: "incremental" }), context(US, {}));
    expect(
      api.requests.some((r) => r.url.pathname === `/v1/ad-accounts/${US}`),
    ).toBe(true);
  });
});

describe("documented report shapes", () => {
  it("stores campaign × country rows whose sum is the campaign total, the gap as Others", async () => {
    const totals = fixture("report-campaigns-4100000001");
    const countries = fixture("report-countries-4100000001");
    const fetch = async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as ReportBody;
      return jsonResponse(200, body.groupBy ? countries : totals, {
        "ratelimit-remaining": "90",
      });
    };
    const api = createAppleAdsClient(fetch, TOKEN);
    const notes: string[] = [];
    const result = await syncCampaignPage(
      api,
      request({ mode: "incremental", from: "2026-10-26T00:00:00.000Z" }),
      {
        now: Date.parse("2026-11-15T12:00:00.000Z"),
        adAccountId: US,
        currency: "USD",
        timeZone: "America/Los_Angeles",
        note: (code) => notes.push(code),
      },
    );
    const observations = result.observations;
    const spend = APPLE_ADS_METRIC_KEYS.spend;
    // Brand on the 27th: US 15.00 + CA 5.00 + Others 0.25 = 20.25.
    const day27 = { campaign: "5100000001" };
    const of27 = observations.filter(
      (o) => o.sourceTimestamp === "2026-10-27T00:00:00.000Z",
    );
    expect(sum(of27, spend, day27)).toBe(2025);
    expect(sum(of27, spend, { ...day27, country: OTHERS })).toBe(25);
    expect(
      sum(of27, APPLE_ADS_METRIC_KEYS.impressions, {
        ...day27,
        country: OTHERS,
      }),
    ).toBe(100);
    // Every row is campaign × country; none is a campaign-only total.
    for (const o of observations) {
      expect(o.dimensions.country).toBeDefined();
      expect(o.dimensions.resource).toBe(APP);
    }
    // A deleted campaign keeps its history; its country is read from the
    // day entry.
    expect(
      sum(observations, spend, { campaign: "5100000002", country: "GB" }),
    ).toBe(500);
    // Spend carries the account's currency; installs keep attribution.
    expect(
      new Set(
        observations
          .filter((o) => o.metricKey === spend)
          .map((o) => o.dimensions.currency),
      ),
    ).toEqual(new Set(["USD"]));
    expect(
      sum(observations, APPLE_ADS_METRIC_KEYS.installs, {
        campaign: "5100000001",
      }),
    ).toBe(80);
  });
});

describe("country breakdown", () => {
  const twelve = [
    "US",
    "GB",
    "DE",
    "FR",
    "JP",
    "CA",
    "AU",
    "IT",
    "ES",
    "NL",
    "SE",
    "NO",
  ];

  it("keeps the 10 countries with the most spend per campaign and month, the rest as Others", async () => {
    const days: FakeReportCampaign["days"] = {};
    for (const date of ["2026-10-01", "2026-10-02"]) {
      days[date] = Object.fromEntries(
        twelve.map((country, index) => [country, d(`${12 - index}.00`)]),
      );
    }
    const api = fake({
      [US]: { currency: "USD", campaigns: [campaign("5100000001", days)] },
    });
    const { observations } = await syncAll(
      api,
      request({ mode: "incremental", from: "2026-10-01T00:00:00.000Z" }),
    );
    const spend = APPLE_ADS_METRIC_KEYS.spend;
    const countries = new Set(
      observations
        .filter((o) => o.metricKey === spend)
        .map((o) => o.dimensions.country),
    );
    expect(countries).toEqual(new Set([...twelve.slice(0, 10), OTHERS]));
    // Others is SE + NO: 2.00 + 1.00 per day.
    expect(
      sum(observations, spend, {
        country: OTHERS,
      }),
    ).toBe(600);
    // The unfiltered sum is the campaign total.
    expect(sum(observations, spend)).toBe(2 * 7800);
  });

  it("writes 0 for a country that left the top 10, so a replay never counts it twice", async () => {
    // On the 1st NO leads; from the 2nd eleven others outspend it.
    const days: FakeReportCampaign["days"] = {
      "2026-10-01": { NO: d("50.00") },
      "2026-10-02": Object.fromEntries(
        twelve.slice(0, 11).map((country) => [country, d("10.00")]),
      ),
    };
    days["2026-10-01"]!.US = d("1.00");
    const api = fake({
      [US]: { currency: "USD", campaigns: [campaign("5100000001", days)] },
    });
    const { observations } = await syncAll(
      api,
      request({ mode: "incremental", from: "2026-10-01T00:00:00.000Z" }),
    );
    const spend = APPLE_ADS_METRIC_KEYS.spend;
    const day1 = observations.filter(
      (o) => o.sourceTimestamp === "2026-10-01T00:00:00.000Z",
    );
    // NO still leads the month (50 + 10): it keeps its name.
    expect(sum(day1, spend, { country: "NO" })).toBe(5000);

    // A month in which NO led only the first day, then fell out.
    const later: FakeReportCampaign["days"] = {
      "2026-09-01": { NO: d("5.00") },
      "2026-09-02": Object.fromEntries(
        twelve.slice(0, 10).map((country) => [country, d("10.00")]),
      ),
    };
    const api2 = fake({
      [US]: { currency: "USD", campaigns: [campaign("5100000001", later)] },
    });
    const replay = await syncAll(
      api2,
      request({ mode: "incremental", from: "2026-09-01T00:00:00.000Z" }),
    );
    const sept1 = replay.observations.filter(
      (o) =>
        o.sourceTimestamp === "2026-09-01T00:00:00.000Z" &&
        o.metricKey === spend,
    );
    // NO led the month up to the 1st, so an earlier sync may have stored
    // it by name: now 0, and its 5.00 is in Others.
    expect(sum(sept1, spend, { country: "NO" })).toBe(0);
    expect(sept1.some((o) => o.dimensions.country === "NO")).toBe(true);
    expect(sum(sept1, spend, { country: OTHERS })).toBe(500);
    expect(sum(sept1, spend)).toBe(500);
  });

  it("writes zeros for settled days without data, never for days in the lookback", async () => {
    const api = fake({
      [US]: {
        currency: "USD",
        campaigns: [
          campaign("5100000001", { "2026-10-20": { US: d("3.00") } }),
        ],
      },
    });
    const { observations } = await syncAll(
      api,
      request({ mode: "incremental", from: "2026-10-19T00:00:00.000Z" }),
    );
    const spend = observations.filter(
      (o) => o.metricKey === APPLE_ADS_METRIC_KEYS.spend,
    );
    const days = new Set(spend.map((o) => o.sourceTimestamp.slice(0, 10)));
    // The 19th to the 26th are settled (older than the 27th to 29th).
    expect(days.has("2026-10-19")).toBe(true);
    expect(days.has("2026-10-26")).toBe(true);
    expect(days.has("2026-10-27")).toBe(false);
    expect(days.has("2026-10-29")).toBe(false);
    expect(sum(spend, APPLE_ADS_METRIC_KEYS.spend)).toBe(300);
  });
});

describe("pagination, replay and revisions", () => {
  it("pages to totalCount", async () => {
    const campaigns = Array.from({ length: REPORT_PAGE_SIZE + 5 }, (_, i) =>
      campaign(String(5200000000 + i), { "2026-10-20": { US: d("1.00") } }),
    );
    const api = fake({ [US]: { currency: "USD", campaigns } });
    const { observations } = await syncAll(
      api,
      request({ mode: "incremental", from: "2026-10-20T00:00:00.000Z" }),
    );
    const offsets = reportBodies(api).map((body) => [
      body.groupBy ? "country" : "total",
      body.pagination.offset,
    ]);
    expect(offsets).toEqual([
      ["total", 0],
      ["total", REPORT_PAGE_SIZE],
      ["country", 0],
      ["country", REPORT_PAGE_SIZE],
    ]);
    const campaignsSeen = new Set(
      observations.map((o) => o.dimensions.campaign),
    );
    expect(campaignsSeen.size).toBe(REPORT_PAGE_SIZE + 5);
  });

  it("replays without duplicates and updates revised days", async () => {
    const report: FakeReport = {
      currency: "USD",
      campaigns: [
        campaign("5100000001", {
          "2026-10-26": { US: d("4.00"), DE: d("1.00") },
          "2026-10-27": { US: d("2.00") },
        }),
      ],
    };
    const api = fake({ [US]: report });
    const window = request({
      mode: "incremental",
      from: "2026-10-26T00:00:00.000Z",
    });
    const first = await syncAll(api, window);
    const second = await syncAll(api, window);
    const keys = (list: Observation[]) => list.map(observationKey);
    expect(new Set(keys(first.observations)).size).toBe(
      first.observations.length,
    );
    expect(keys(second.observations)).toEqual(keys(first.observations));

    // Apple revises the 27th: same identities, the new value.
    report.campaigns[0]!.days["2026-10-27"]!.US = d("2.50");
    const third = await syncAll(api, window);
    expect(keys(third.observations)).toEqual(keys(first.observations));
    const revised = third.observations.find(
      (o) =>
        o.metricKey === APPLE_ADS_METRIC_KEYS.spend &&
        o.sourceTimestamp === "2026-10-27T00:00:00.000Z" &&
        o.dimensions.country === "US",
    );
    expect(revised?.value).toBe(250);
  });

  it("names campaigns by ID, so a renamed campaign keeps its series", async () => {
    const report: FakeReport = {
      currency: "USD",
      campaigns: [campaign("5100000001", { "2026-10-27": { US: d("2.00") } })],
    };
    const api = fake({ [US]: report });
    const window = request({
      mode: "incremental",
      from: "2026-10-27T00:00:00.000Z",
    });
    const before = await syncAll(api, window);
    report.campaigns[0]!.name = "Renamed";
    const after = await syncAll(api, window);
    expect(after.observations.map(observationKey)).toEqual(
      before.observations.map(observationKey),
    );
  });

  it("reads only the selected apps", async () => {
    const api = fake({
      [US]: {
        currency: "USD",
        campaigns: [
          campaign("5100000001", { "2026-10-27": { US: d("2.00") } }),
          campaign(
            "5100000002",
            { "2026-10-27": { US: d("3.00") } },
            { app: "1000000002" },
          ),
        ],
      },
    });
    const { observations } = await syncAll(
      api,
      request({
        mode: "incremental",
        from: "2026-10-27T00:00:00.000Z",
        resources: ["1000000002"],
      }),
    );
    expect(new Set(observations.map((o) => o.dimensions.resource))).toEqual(
      new Set(["1000000002"]),
    );
  });
});

describe("currencies", () => {
  it("keeps two ad accounts' currencies apart, never converted", async () => {
    const api = fake({
      [US]: {
        currency: "USD",
        campaigns: [
          campaign("5100000001", { "2026-10-27": { US: d("2.00") } }),
        ],
      },
      [EU]: {
        currency: "EUR",
        campaigns: [
          campaign("5200000001", { "2026-10-27": { DE: d("3.00") } }),
        ],
      },
    });
    const window = request({
      mode: "incremental",
      from: "2026-10-27T00:00:00.000Z",
    });
    const us = await syncAll(api, window, context(US));
    const eu = await syncAll(
      api,
      window,
      context(EU, { currency: "EUR", timeZone: "Europe/Berlin" }),
    );
    const currencies = (list: Observation[]) =>
      new Set(
        list
          .filter((o) => o.metricKey === APPLE_ADS_METRIC_KEYS.spend)
          .map((o) => o.dimensions.currency),
      );
    expect(currencies(us.observations)).toEqual(new Set(["USD"]));
    expect(currencies(eu.observations)).toEqual(new Set(["EUR"]));
    expect(sum(eu.observations, APPLE_ADS_METRIC_KEYS.spend)).toBe(300);
  });

  it("refuses spend in another currency than the ad account's", async () => {
    const api = fake({
      [US]: {
        currency: "EUR",
        campaigns: [
          campaign("5100000001", { "2026-10-27": { US: d("2.00") } }),
        ],
      },
    });
    await expect(
      syncAll(
        api,
        request({ mode: "incremental", from: "2026-10-27T00:00:00.000Z" }),
      ),
    ).rejects.toThrow("not in the ad account's currency");
  });
});

describe("rate limits", () => {
  it("resumes a backfill from its cursor after a 429 in the middle", async () => {
    const report: FakeReport = {
      currency: "USD",
      campaigns: [
        campaign("5100000001", {
          "2026-10-27": { US: d("2.00") },
          "2026-06-15": { US: d("5.00") },
          "2026-01-10": { US: d("7.00") },
        }),
      ],
    };
    const api = fake({ [US]: report });
    const first = syncResultSchema.parse(
      await connector().sync(context(), request(), api.runtime),
    );
    expect(first.done).toBe(false);
    const cursor = first.nextCursor!;

    // The next page meets a 429 whose Retry-After is too long to wait for.
    const limited = fake({ [US]: report }, [
      {
        status: 429,
        fixture: "error-rate-limit",
        headers: { "retry-after": "120" },
      },
    ]);
    const failure = await connector()
      .sync(context(), { ...request(), cursor }, limited.runtime)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppleAdsApiError);
    expect((failure as AppleAdsApiError).isRetryable).toBe(true);
    expect((failure as AppleAdsApiError).retryAfterSeconds).toBe(120);

    // The retry starts at the cursor: the newest months are not read again.
    const retry = fake({ [US]: report });
    const rest = await syncAll(retry, { ...request(), cursor });
    const firstRange = reportBodies(retry)[0]!.timeRange;
    expect(firstRange.end < "2026-10-01").toBe(true);
    const all = [...first.observations, ...rest.observations];
    expect(sum(all, APPLE_ADS_METRIC_KEYS.spend)).toBe(1400);
  });
});
