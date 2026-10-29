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
  AD_GROUP_CAMPAIGNS_PER_PAGE,
  APPLE_ADS_AD_GROUP_METRIC_KEYS,
  APPLE_ADS_BACKFILL_DAYS,
  APPLE_ADS_METRIC_KEYS,
  appleAdsDaysLabel,
  AppleAdsApiError,
  AppleAdsReportError,
  chunkRange,
  createAppleAdsClient,
  createAppleAdsConnector,
  decodeCursor,
  DELETED_CAMPAIGN_NOTE,
  encodeCursor,
  APPLE_ADS_KEYWORD_METRIC_KEYS,
  FAN_OUT_BUDGET_MS,
  KEYWORD_REPORT_ROWS,
  LOOKBACK_DAYS,
  NO_KEYWORD_REPORT_NOTE,
  TOP_KEYWORDS,
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

function connector(now = NOW, clock?: () => number) {
  return createAppleAdsConnector({
    sleep: noSleep,
    now: () => now,
    ...(clock ? { clock } : {}),
  });
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
  filters?: Array<{ field: string; operator: string; value: unknown }>;
  groupBy?: string[];
  sorting?: Array<{ field: string; order: string }>;
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

/** One page on the documented fixtures (fixtures/report-*.json). */
async function documentedPage(
  adGroupAnswer: (campaignId: string) => [number, unknown] = (campaignId) => [
    200,
    fixture(`report-adgroups-${campaignId}`),
  ],
  keywordAnswer: (campaignId: string) => [number, unknown] = (campaignId) => [
    200,
    fixture(`report-keywords-${campaignId}`),
  ],
) {
  const totals = fixture("report-campaigns-4100000001");
  const countries = fixture("report-countries-4100000001");
  const adGroupCampaigns: string[] = [];
  const keywordBodies: ReportBody[] = [];
  const fetch = async (url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as ReportBody;
    const headers = { "ratelimit-remaining": "90" };
    if (new URL(url).pathname === "/v1/reports/apps/keywords/query") {
      keywordBodies.push(body);
      const [status, answer] = keywordAnswer(String(body.filters?.[0]?.value));
      return jsonResponse(status, answer, headers);
    }
    if (new URL(url).pathname === "/v1/reports/apps/adgroups/query") {
      const campaignId = String(body.filters?.[0]?.value);
      adGroupCampaigns.push(campaignId);
      const [status, answer] = adGroupAnswer(campaignId);
      return jsonResponse(status, answer, headers);
    }
    return jsonResponse(200, body.groupBy ? countries : totals, headers);
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
  return { result, notes, adGroupCampaigns, keywordBodies };
}

const MAIN_KEYS = new Set<string>(Object.values(APPLE_ADS_METRIC_KEYS));
const AD_GROUP_KEYS = new Set<string>(
  Object.values(APPLE_ADS_AD_GROUP_METRIC_KEYS),
);

/** The main `apple_ads.*` observations (campaign × country or region). */
function mainRows(observations: Observation[]): Observation[] {
  return observations.filter((o) => MAIN_KEYS.has(o.metricKey));
}

/** The `*_by_ad_group` observations. */
function adGroupRows(observations: Observation[]): Observation[] {
  return observations.filter((o) => AD_GROUP_KEYS.has(o.metricKey));
}

describe("documented report shapes", () => {
  it("stores campaign × country rows whose sum is the campaign total, the gap as Others", async () => {
    const { result } = await documentedPage();
    const observations = mainRows(result.observations);
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
    // Rows of zeros: paged like any, but no ad-group fan-out (that is
    // tested under "ad groups"), which would take 101 pages here.
    const campaigns = Array.from({ length: REPORT_PAGE_SIZE + 5 }, (_, i) =>
      campaign(String(5200000000 + i), { "2026-10-20": { US: {} } }),
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

// ─── Ad groups (#376) ───────────────────────────────────────────────────────

/** The campaign IDs of the ad-group requests, in order. */
function adGroupCampaignsAsked(api: FakeAppleAds): string[] {
  return api.requests
    .filter((r) => r.url.pathname === "/v1/reports/apps/adgroups/query")
    .map((r) => String((r.body as ReportBody).filters?.[0]?.value));
}

const PAIRS = [
  ["spend", APPLE_ADS_METRIC_KEYS.spend, APPLE_ADS_AD_GROUP_METRIC_KEYS.spend],
  [
    "impressions",
    APPLE_ADS_METRIC_KEYS.impressions,
    APPLE_ADS_AD_GROUP_METRIC_KEYS.impressions,
  ],
  ["taps", APPLE_ADS_METRIC_KEYS.taps, APPLE_ADS_AD_GROUP_METRIC_KEYS.taps],
  [
    "installs",
    APPLE_ADS_METRIC_KEYS.installs,
    APPLE_ADS_AD_GROUP_METRIC_KEYS.installs,
  ],
  [
    "newDownloads",
    APPLE_ADS_METRIC_KEYS.newDownloads,
    APPLE_ADS_AD_GROUP_METRIC_KEYS.newDownloads,
  ],
  [
    "redownloads",
    APPLE_ADS_METRIC_KEYS.redownloads,
    APPLE_ADS_AD_GROUP_METRIC_KEYS.redownloads,
  ],
] as const;

/**
 * Ad-group sums equal campaign sums: per campaign, day and attribution,
 * for every quantity.
 */
function expectAdGroupsMatchCampaigns(observations: Observation[]): void {
  const groups = new Set(
    observations.map(
      (o) =>
        `${o.dimensions.campaign}|${o.sourceTimestamp}|${o.dimensions.attribution ?? ""}`,
    ),
  );
  for (const group of groups) {
    const [campaignId, stamp, attribution] = group.split("|");
    const of = observations.filter(
      (o) =>
        o.dimensions.campaign === campaignId &&
        o.sourceTimestamp === stamp &&
        (o.dimensions.attribution ?? "") === attribution,
    );
    for (const [field, main, byAdGroup] of PAIRS) {
      expect(sum(of, byAdGroup), `${field} of ${group}`).toBe(sum(of, main));
    }
  }
}

describe("ad groups", () => {
  it("ad-group totals equal campaign totals on the documented fixtures", async () => {
    const { result, adGroupCampaigns } = await documentedPage();
    const all = result.observations;
    expect(adGroupCampaigns).toEqual(["5100000001", "5100000002"]);
    expectAdGroupsMatchCampaigns(all);
    const byAdGroup = adGroupRows(all);
    expect(byAdGroup.length).toBeGreaterThan(0);
    // Ad-group rows are campaign × ad group: no country, never the main
    // keys; nothing is left for "Others" when the ad groups add up.
    for (const o of byAdGroup) {
      expect(o.dimensions.country).toBeUndefined();
      expect(o.dimensions.ad_group).toMatch(/^\d+$/);
      expect(o.dimensions.resource).toBe(APP);
    }
    for (const o of mainRows(all)) {
      expect(o.dimensions.ad_group).toBeUndefined();
    }
    const spend = APPLE_ADS_AD_GROUP_METRIC_KEYS.spend;
    expect(sum(byAdGroup, spend, { ad_group: "6100000001" })).toBe(4525);
    // A deleted ad group, and the deleted campaign's, keep their history.
    expect(sum(byAdGroup, spend, { ad_group: "6100000002" })).toBe(1550);
    expect(sum(byAdGroup, spend, { campaign: "5100000002" })).toBe(500);
    expect(
      sum(byAdGroup, APPLE_ADS_AD_GROUP_METRIC_KEYS.installs, {
        ad_group: "6100000001",
        attribution: "view",
      }),
    ).toBe(7);
    expect(
      new Set(
        byAdGroup
          .filter((o) => o.metricKey === spend)
          .map((o) => o.dimensions.currency),
      ),
    ).toEqual(new Set(["USD"]));
  });

  it("asks per campaign with the campaignId filter, on the campaign report's days", async () => {
    const report: FakeReport = {
      currency: "USD",
      campaigns: [campaign("5100000001", { "2026-10-27": { US: d("2.00") } })],
    };
    const api = fake({ [US]: report });
    await syncAll(
      api,
      request({ mode: "incremental", from: "2026-10-20T00:00:00.000Z" }),
    );
    const [campaignBody, , adGroupBody] = api.requests
      .filter((r) => r.url.pathname.startsWith("/v1/reports/"))
      .map((r) => r.body as ReportBody);
    expect(adGroupBody).toEqual({
      timeRange: campaignBody!.timeRange,
      filters: [
        { field: "campaignId", operator: "EQUALS", value: "5100000001" },
      ],
      pagination: { offset: 0, pageSize: REPORT_PAGE_SIZE },
    });
    expect(adGroupBody!.timeRange.timeZone).toBe("ORTZ");
    expect(
      api.requests
        .filter((r) => r.url.pathname === "/v1/reports/apps/adgroups/query")
        .every((r) => r.context === `adAccountId=${US}`),
    ).toBe(true);
  });

  it("fans out over several sync pages, at most N campaigns each, skipping campaigns without numbers", async () => {
    const ids = [
      "999",
      ...Array.from({ length: 24 }, (_, i) => String(5200000000 + i)),
    ];
    const report: FakeReport = {
      currency: "USD",
      campaigns: [
        ...ids.map((id, i) =>
          campaign(
            id,
            {
              "2026-10-21": { US: d("1.00"), DE: d("0.50") },
              "2026-10-27": { US: d(`${i + 1}.00`) },
            },
            { adGroups: { DE: `${id}02` } },
          ),
        ),
        // Numbers only before the window: no ad-group request.
        campaign("5300000001", { "2026-10-05": { US: d("4.00") } }),
        // A row of zeros: no ad-group request either.
        campaign("5300000002", { "2026-10-22": { US: {} } }),
      ],
    };
    const api = fake({ [US]: report });
    const { pages, observations } = await syncAll(
      api,
      request({ mode: "incremental", from: "2026-10-20T00:00:00.000Z" }),
    );
    // 25 campaigns with numbers: pages of 10, 10 and 5.
    expect(AD_GROUP_CAMPAIGNS_PER_PAGE).toBe(10);
    expect(pages).toHaveLength(3);
    expect(pages.map((p) => p.nextCursor)).toEqual([
      `apple-ads:1:2026-10-20:2026-10-29:2026-10-29:${ids[9]}`,
      `apple-ads:1:2026-10-20:2026-10-29:2026-10-29:${ids[19]}`,
      "2026-10-27T00:00:00.000Z",
    ]);
    // Each campaign once, by ID as a number ("999" first).
    expect(adGroupCampaignsAsked(api)).toEqual(ids);
    // Later pages read the totals again, not the country breakdown.
    expect(
      reportBodies(api).map((body) => (body.groupBy ? "country" : "total")),
    ).toEqual(["total", "country", "total", "total"]);
    // Main rows come from the first page only, so nothing twice.
    expect(mainRows(pages[1]!.observations)).toEqual([]);
    expect(new Set(observations.map(observationKey)).size).toBe(
      observations.length,
    );
    expectAdGroupsMatchCampaigns(observations);
    const spend = APPLE_ADS_AD_GROUP_METRIC_KEYS.spend;
    expect(sum(observations, spend, { ad_group: "99902" })).toBe(50);
    expect(sum(observations, spend, { ad_group: "99901" })).toBe(200);
    // The skipped campaigns have no numbers in the window at either level.
    expect(sum(adGroupRows(observations), spend)).toBe(
      sum(mainRows(observations), APPLE_ADS_METRIC_KEYS.spend),
    );
    expect(sum(observations, spend, { campaign: "5300000001" })).toBe(0);
  });

  it("keeps the backfill's ranges for ad groups, newest first, the cursor per campaign within a range", async () => {
    const report: FakeReport = {
      currency: "USD",
      campaigns: [
        ...Array.from({ length: 12 }, (_, i) =>
          campaign(String(5200000000 + i), {
            "2026-10-27": { US: d("1.00") },
          }),
        ),
        campaign("5100000001", { "2026-06-15": { US: d("5.00") } }),
      ],
    };
    const api = fake({ [US]: report });
    const { pages, observations } = await syncAll(api, request());
    const ranges = (path: string) =>
      api.requests
        .filter((r) => r.url.pathname === path)
        .map((r) => (r.body as ReportBody).timeRange)
        .map(({ start, end }) => `${start}..${end}`);
    const campaignRanges = [
      ...new Set(ranges("/v1/reports/apps/campaigns/query")),
    ];
    // Every ad-group request is on one of the campaign report's ranges.
    for (const range of ranges("/v1/reports/apps/adgroups/query")) {
      expect(campaignRanges).toContain(range);
    }
    expect(ranges("/v1/reports/apps/adgroups/query")).toEqual([
      ...Array.from({ length: 12 }, () => campaignRanges[0]),
      campaignRanges[1],
    ]);
    // The newest range takes two pages (10 + 2), then one per range.
    expect(pages).toHaveLength(campaignRanges.length + 1);
    expect(decodeCursor(pages[0]!.nextCursor)?.after).toBe("5200000009");
    expect(decodeCursor(pages[1]!.nextCursor)?.after).toBeUndefined();
    expectAdGroupsMatchCampaigns(observations);
    expect(
      sum(adGroupRows(observations), APPLE_ADS_AD_GROUP_METRIC_KEYS.spend),
    ).toBe(1700);
  });

  it("goes on after a campaign removed between pages", async () => {
    const report: FakeReport = {
      currency: "USD",
      campaigns: Array.from({ length: 13 }, (_, i) =>
        campaign(String(5200000000 + i), { "2026-10-27": { US: d("1.00") } }),
      ),
    };
    const api = fake({ [US]: report });
    const window = request({
      mode: "incremental",
      from: "2026-10-27T00:00:00.000Z",
    });
    const first = await connector().sync(context(), window, api.runtime);
    expect(decodeCursor(first.nextCursor)?.after).toBe("5200000009");
    // The cursor's campaign, and the next one, are removed in Apple Ads.
    report.campaigns = report.campaigns.filter(
      (c) => c.id !== "5200000009" && c.id !== "5200000010",
    );
    const rest = await syncAll(api, { ...window, cursor: first.nextCursor! });
    expect(rest.pages).toHaveLength(1);
    expect(adGroupCampaignsAsked(api).slice(10)).toEqual([
      "5200000011",
      "5200000012",
    ]);
    expect(
      new Set(adGroupRows(rest.observations).map((o) => o.dimensions.campaign)),
    ).toEqual(new Set(["5200000011", "5200000012"]));
  });

  it("keeps a deleted campaign Apple answers 404 for under the ad group Others", async () => {
    const { result, notes } = await documentedPage((campaignId) =>
      campaignId === "5100000002"
        ? [404, fixture("error-not-found")]
        : [200, fixture(`report-adgroups-${campaignId}`)],
    );
    const all = result.observations;
    expectAdGroupsMatchCampaigns(all);
    const spend = APPLE_ADS_AD_GROUP_METRIC_KEYS.spend;
    expect(sum(all, spend, { campaign: "5100000002", ad_group: OTHERS })).toBe(
      500,
    );
    // The live campaign's ad groups add up: no Others there.
    expect(
      all.some(
        (o) =>
          o.dimensions.campaign === "5100000001" &&
          o.dimensions.ad_group === OTHERS,
      ),
    ).toBe(false);
    expect(notes).toContain(DELETED_CAMPAIGN_NOTE);
  });

  it("fails the page on a 404 for a campaign that is not deleted", async () => {
    const failure = await documentedPage((campaignId) =>
      campaignId === "5100000001"
        ? [404, fixture("error-not-found")]
        : [200, fixture(`report-adgroups-${campaignId}`)],
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppleAdsApiError);
    expect((failure as AppleAdsApiError).status).toBe(404);
  });

  it("refuses an ad-group row of another campaign", async () => {
    const failure = await documentedPage(() => [
      200,
      fixture("report-adgroups-5100000002"),
    ]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppleAdsReportError);
  });

  it("resumes the fan-out from its campaign after a 429", async () => {
    const report: FakeReport = {
      currency: "USD",
      campaigns: Array.from({ length: 15 }, (_, i) =>
        campaign(String(5200000000 + i), { "2026-10-27": { US: d("1.00") } }),
      ),
    };
    const window = request({
      mode: "incremental",
      from: "2026-10-27T00:00:00.000Z",
    });
    const first = await connector().sync(
      context(),
      window,
      fake({ [US]: report }).runtime,
    );
    // The next page's totals pass meets a 429 too long to wait for.
    const limited = fake({ [US]: report }, [
      {
        status: 429,
        fixture: "error-rate-limit",
        headers: { "retry-after": "120" },
      },
    ]);
    const failure = await connector()
      .sync(
        context(),
        { ...window, cursor: first.nextCursor! },
        limited.runtime,
      )
      .catch((error: unknown) => error);
    expect((failure as AppleAdsApiError).isRetryable).toBe(true);
    // The retry asks only for the campaigns after the cursor's.
    const retry = fake({ [US]: report });
    const rest = await syncAll(retry, { ...window, cursor: first.nextCursor! });
    expect(adGroupCampaignsAsked(retry)).toEqual(
      Array.from({ length: 5 }, (_, i) => String(5200000010 + i)),
    );
    expectAdGroupsMatchCampaigns([...first.observations, ...rest.observations]);
  });

  it("writes zeros for an ad group's settled days without data, never in the lookback", async () => {
    const report: FakeReport = {
      currency: "USD",
      campaigns: [
        campaign("5100000001", {
          "2026-10-21": { US: d("1.00") },
          "2026-10-29": { US: d("2.00") },
        }),
      ],
    };
    const api = fake({ [US]: report });
    const { observations } = await syncAll(
      api,
      request({ mode: "incremental", from: "2026-10-21T00:00:00.000Z" }),
    );
    const spendDays = adGroupRows(observations)
      .filter((o) => o.metricKey === APPLE_ADS_AD_GROUP_METRIC_KEYS.spend)
      .map((o) => [o.sourceTimestamp.slice(0, 10), o.value]);
    expect(spendDays).toEqual([
      ["2026-10-21", 100],
      ["2026-10-22", 0],
      ["2026-10-23", 0],
      ["2026-10-24", 0],
      ["2026-10-25", 0],
      ["2026-10-26", 0],
      // 27 and 28 are in the lookback: left out.
      ["2026-10-29", 200],
    ]);
  });

  it("reads ad groups only for the selected apps' campaigns", async () => {
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
    await syncAll(
      api,
      request({
        mode: "incremental",
        from: "2026-10-27T00:00:00.000Z",
        resources: ["1000000002"],
      }),
    );
    expect(adGroupCampaignsAsked(api)).toEqual(["5100000002"]);
  });

  it("round-trips the per-campaign cursor and refuses a malformed one", () => {
    const position = {
      floor: "2026-10-01",
      newest: "2026-10-29",
      next: "2026-10-29",
      after: "5100000001",
    };
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
    for (const cursor of [
      "apple-ads:1:2026-10-01:2026-10-29:2026-10-29:x",
      "apple-ads:1:2026-10-01:2026-10-29:2026-10-29:01",
      "apple-ads:1:2026-10-01:2026-10-29:2026-10-29:1:2",
    ]) {
      expect(decodeCursor(cursor)).toBeUndefined();
    }
  });
});

// ─── Keywords (#396) ────────────────────────────────────────────────────────

const KEYWORD_KEYS = new Set<string>(
  Object.values(APPLE_ADS_KEYWORD_METRIC_KEYS),
);

/** The `*_by_keyword` observations. */
function keywordRows(observations: Observation[]): Observation[] {
  return observations.filter((o) => KEYWORD_KEYS.has(o.metricKey));
}

/** The campaign IDs of the keyword requests, in order. */
function keywordCampaignsAsked(api: FakeAppleAds): string[] {
  return api.requests
    .filter((r) => r.url.pathname === "/v1/reports/apps/keywords/query")
    .map((r) => String((r.body as ReportBody).filters?.[0]?.value));
}

/**
 * Keyword sums equal campaign sums: per campaign, day and attribution, for
 * every quantity.
 */
function expectKeywordsMatchCampaigns(observations: Observation[]): void {
  const groups = new Set(
    observations.map(
      (o) =>
        `${o.dimensions.campaign}|${o.sourceTimestamp}|${o.dimensions.attribution ?? ""}`,
    ),
  );
  for (const group of groups) {
    const [campaignId, stamp, attribution] = group.split("|");
    const of = observations.filter(
      (o) =>
        o.dimensions.campaign === campaignId &&
        o.sourceTimestamp === stamp &&
        (o.dimensions.attribution ?? "") === attribution,
    );
    for (const [field, main] of PAIRS) {
      const byKeyword =
        APPLE_ADS_KEYWORD_METRIC_KEYS[
          field as keyof typeof APPLE_ADS_KEYWORD_METRIC_KEYS
        ];
      expect(sum(of, byKeyword), `${field} of ${group}`).toBe(sum(of, main));
    }
  }
}

/** `count` two-letter country codes ("AA", "AB", …), one per keyword. */
function codes(count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) =>
      String.fromCharCode(65 + Math.floor(i / 26)) +
      String.fromCharCode(65 + (i % 26)),
  );
}

/** Keyword `${base + i}` for the i-th code. */
function keywordsOf(list: string[], base = 8100000000): Record<string, string> {
  return Object.fromEntries(list.map((code, i) => [code, String(base + i)]));
}

describe("keywords", () => {
  it("keyword totals equal campaign totals on the documented fixtures, the rest as Others", async () => {
    const { result, keywordBodies } = await documentedPage();
    const all = result.observations;
    expectKeywordsMatchCampaigns(all);
    const byKeyword = keywordRows(all);
    // Keyword rows are campaign × keyword: never a country or an ad group.
    for (const o of byKeyword) {
      expect(o.dimensions.country).toBeUndefined();
      expect(o.dimensions.ad_group).toBeUndefined();
      expect(o.dimensions.resource).toBe(APP);
    }
    for (const o of [...mainRows(all), ...adGroupRows(all)]) {
      expect(o.dimensions.keyword).toBeUndefined();
    }
    const spend = APPLE_ADS_KEYWORD_METRIC_KEYS.spend;
    expect(sum(byKeyword, spend, { keyword: "7100000001" })).toBe(3700);
    // Deleted keywords keep their history and names.
    expect(sum(byKeyword, spend, { keyword: "7100000002" })).toBe(825);
    expect(sum(byKeyword, spend, { keyword: "7100000003" })).toBe(800);
    // Search Match (no keyword row) is Others: 2.50 + 5.00.
    expect(
      sum(byKeyword, spend, { campaign: "5100000001", keyword: OTHERS }),
    ).toBe(750);
    // The deleted Search Match campaign has no keyword rows at all.
    expect(sum(byKeyword, spend, { campaign: "5100000002" })).toBe(500);
    expect(
      new Set(
        byKeyword
          .filter((o) => o.dimensions.campaign === "5100000002")
          .map((o) => o.dimensions.keyword),
      ),
    ).toEqual(new Set([OTHERS]));
    expect(
      sum(byKeyword, APPLE_ADS_KEYWORD_METRIC_KEYS.installs, {
        keyword: "7100000001",
        attribution: "view",
      }),
    ).toBe(5);
    // One page of the keywords with the most spend, per campaign.
    expect(keywordBodies.map((body) => body.filters)).toEqual([
      [{ field: "campaignId", operator: "EQUALS", value: "5100000001" }],
      [{ field: "campaignId", operator: "EQUALS", value: "5100000002" }],
    ]);
    expect(keywordBodies[0]).toMatchObject({
      sorting: [{ field: "localSpend", order: "DESC" }],
      pagination: { offset: 0, pageSize: KEYWORD_REPORT_ROWS },
    });
    expect(keywordBodies[0]!.groupBy).toBeUndefined();
  });

  it("keeps the 20 keywords with the most spend per campaign and month, the rest as Others", async () => {
    const list = codes(25);
    const days: FakeReportCampaign["days"] = {};
    for (const date of ["2026-10-01", "2026-10-02"]) {
      // Keyword i spends 25 - i dollars a day.
      days[date] = Object.fromEntries(
        list.map((code, i) => [code, d(`${25 - i}.00`)]),
      );
    }
    // September: the five smallest of October lead.
    days["2026-09-15"] = Object.fromEntries(
      list.map((code, i) => [code, d(i >= 20 ? "50.00" : "1.00")]),
    );
    const api = fake({
      [US]: {
        currency: "USD",
        campaigns: [
          campaign("5100000001", days, { keywords: keywordsOf(list) }),
        ],
      },
    });
    const { observations } = await syncAll(
      api,
      request({ mode: "incremental", from: "2026-09-01T00:00:00.000Z" }),
    );
    const rows = keywordRows(observations);
    const spend = APPLE_ADS_KEYWORD_METRIC_KEYS.spend;
    const named = (month: string) =>
      new Set(
        rows
          .filter(
            (o) =>
              o.metricKey === spend &&
              o.sourceTimestamp.startsWith(month) &&
              o.value !== 0,
          )
          .map((o) => o.dimensions.keyword),
      );
    const ids = Object.values(keywordsOf(list));
    expect(TOP_KEYWORDS).toBe(20);
    expect(named("2026-10")).toEqual(new Set([...ids.slice(0, 20), OTHERS]));
    // Others in October: keywords 21 to 25, 5 + 4 + 3 + 2 + 1 a day.
    const october = rows.filter((o) => o.sourceTimestamp.startsWith("2026-10"));
    expect(sum(october, spend, { keyword: OTHERS })).toBe(2 * 1500);
    // September ranks on its own: the five big ones and 15 of the rest.
    const september = named("2026-09");
    for (const id of ids.slice(20)) expect(september).toContain(id);
    expect(september.size).toBe(21);
    expectKeywordsMatchCampaigns(observations);
    expect(sum(rows, spend)).toBe(
      sum(mainRows(observations), APPLE_ADS_METRIC_KEYS.spend),
    );
  });

  it("writes 0 for a keyword that left the top 20, so a replay never counts it twice", async () => {
    const list = codes(21);
    // On the 1st only keyword 0 spends; from the 2nd the other 20 outspend it.
    const days: FakeReportCampaign["days"] = {
      "2026-09-01": { [list[0]!]: d("5.00") },
      "2026-09-02": Object.fromEntries(
        list.slice(1).map((code) => [code, d("10.00")]),
      ),
    };
    const api = fake({
      [US]: {
        currency: "USD",
        campaigns: [
          campaign("5100000001", days, { keywords: keywordsOf(list) }),
        ],
      },
    });
    const { observations } = await syncAll(
      api,
      request({ mode: "incremental", from: "2026-09-01T00:00:00.000Z" }),
    );
    const spend = APPLE_ADS_KEYWORD_METRIC_KEYS.spend;
    const sept1 = keywordRows(observations).filter(
      (o) =>
        o.sourceTimestamp === "2026-09-01T00:00:00.000Z" &&
        o.metricKey === spend,
    );
    // Keyword 0 led the month up to the 1st: now an explicit 0, and its
    // 5.00 is in Others.
    expect(
      sept1.find((o) => o.dimensions.keyword === "8100000000")?.value,
    ).toBe(0);
    expect(sum(sept1, spend, { keyword: OTHERS })).toBe(500);
    expectKeywordsMatchCampaigns(observations);
  });

  it("keeps a removed keyword under its ID with its history", async () => {
    const report: FakeReport = {
      currency: "USD",
      campaigns: [
        campaign(
          "5100000001",
          {
            "2026-10-20": { US: d("4.00"), DE: d("1.00") },
            "2026-10-27": { DE: d("2.00") },
          },
          { keywords: { US: "8100000001", DE: "8100000002" } },
        ),
      ],
    };
    const api = fake({ [US]: report });
    const window = request({
      mode: "incremental",
      from: "2026-10-20T00:00:00.000Z",
    });
    const before = await syncAll(api, window);
    // The keyword is removed in Apple Ads; the report still has its rows.
    report.campaigns[0]!.deletedKeywords = ["8100000001"];
    const after = await syncAll(api, window);
    const spend = APPLE_ADS_KEYWORD_METRIC_KEYS.spend;
    for (const run of [before, after]) {
      expect(
        sum(keywordRows(run.observations), spend, { keyword: "8100000001" }),
      ).toBe(400);
      expectKeywordsMatchCampaigns(run.observations);
    }
    // The same series, so the replay overwrites instead of adding.
    expect(keywordRows(after.observations).map(observationKey).sort()).toEqual(
      keywordRows(before.observations).map(observationKey).sort(),
    );
  });

  it("reads keywords with the ad groups over several sync pages, each campaign once", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => String(5200000000 + i));
    const report: FakeReport = {
      currency: "USD",
      campaigns: [
        ...ids.map((id, i) =>
          campaign(
            id,
            {
              "2026-10-21": { US: d("1.00"), DE: d("0.50") },
              "2026-10-27": { US: d(`${i + 1}.00`) },
            },
            { keywords: { US: `${id}1` } },
          ),
        ),
        // No numbers in the window: neither report is asked for.
        campaign("5300000001", { "2026-10-05": { US: d("4.00") } }),
      ],
    };
    const api = fake({ [US]: report });
    const { pages, observations } = await syncAll(
      api,
      request({ mode: "incremental", from: "2026-10-20T00:00:00.000Z" }),
    );
    expect(pages).toHaveLength(3);
    expect(keywordCampaignsAsked(api)).toEqual(ids);
    expect(adGroupCampaignsAsked(api)).toEqual(ids);
    expect(new Set(observations.map(observationKey)).size).toBe(
      observations.length,
    );
    expectKeywordsMatchCampaigns(observations);
    const spend = APPLE_ADS_KEYWORD_METRIC_KEYS.spend;
    // DE has no keyword (Search Match): Others.
    expect(sum(observations, spend, { keyword: OTHERS })).toBe(25 * 50);
    expect(sum(observations, spend, { keyword: `${ids[0]}1` })).toBe(200);
  });

  it("goes on from a cursor of the ad-group sync (#376), keywords included", async () => {
    const report: FakeReport = {
      currency: "USD",
      campaigns: Array.from({ length: 13 }, (_, i) =>
        campaign(
          String(5200000000 + i),
          { "2026-10-27": { US: d("1.00") } },
          { keywords: { US: `${5200000000 + i}1` } },
        ),
      ),
    };
    // Written by #376 before keywords existed: the range after 5200000009.
    const old = "apple-ads:1:2026-10-27:2026-10-29:2026-10-29:5200000009";
    expect(decodeCursor(old)).toEqual({
      floor: "2026-10-27",
      newest: "2026-10-29",
      next: "2026-10-29",
      after: "5200000009",
    });
    const api = fake({ [US]: report });
    const { pages, observations } = await syncAll(
      api,
      request({
        mode: "incremental",
        from: "2026-10-27T00:00:00.000Z",
        cursor: old,
      }),
    );
    expect(pages).toHaveLength(1);
    expect(keywordCampaignsAsked(api)).toEqual([
      "5200000010",
      "5200000011",
      "5200000012",
    ]);
    // A later page of a range has no main rows; each campaign's keywords
    // add up to its 1.00 total.
    for (const campaignId of keywordCampaignsAsked(api)) {
      expect(
        sum(observations, APPLE_ADS_KEYWORD_METRIC_KEYS.spend, {
          campaign: campaignId,
        }),
      ).toBe(100);
    }
    expect(
      sum(keywordRows(observations), APPLE_ADS_KEYWORD_METRIC_KEYS.spend),
    ).toBe(300);
  });

  it("keeps a campaign without a keyword report (404, 400) under Others and goes on", async () => {
    const report: FakeReport = {
      currency: "USD",
      campaigns: [
        campaign(
          "5100000001",
          { "2026-10-27": { US: d("2.00") } },
          { keywords: "not-found" },
        ),
        campaign(
          "5100000002",
          { "2026-10-27": { US: d("3.00") } },
          { keywords: "refused" },
        ),
        campaign(
          "5100000003",
          { "2026-10-27": { US: d("4.00") } },
          { keywords: { US: "8100000003" } },
        ),
      ],
    };
    const notes: string[] = [];
    const api = fake({ [US]: report });
    const result = await createAppleAdsConnector({
      sleep: noSleep,
      now: () => NOW,
      log: (line) => notes.push(line),
    }).sync(
      context(),
      request({ mode: "incremental", from: "2026-10-27T00:00:00.000Z" }),
      api.runtime,
    );
    const spend = APPLE_ADS_KEYWORD_METRIC_KEYS.spend;
    const rows = keywordRows(result.observations);
    expect(sum(rows, spend, { campaign: "5100000001", keyword: OTHERS })).toBe(
      200,
    );
    expect(sum(rows, spend, { campaign: "5100000002", keyword: OTHERS })).toBe(
      300,
    );
    expect(sum(rows, spend, { keyword: "8100000003" })).toBe(400);
    expect(notes.some((line) => line.startsWith(NO_KEYWORD_REPORT_NOTE))).toBe(
      true,
    );
    expectKeywordsMatchCampaigns(result.observations);
  });

  it("stops starting campaigns once the page's time budget is spent, and goes on next page", async () => {
    const report: FakeReport = {
      currency: "USD",
      campaigns: Array.from({ length: 6 }, (_, i) =>
        campaign(
          String(5200000000 + i),
          { "2026-10-27": { US: d("1.00") } },
          { keywords: { US: `${5200000000 + i}1` } },
        ),
      ),
    };
    const api = fake({ [US]: report });
    let now = 0;
    const original = api.runtime.fetch;
    // Every keyword report takes a third of the budget.
    const slow: FakeAppleAds = {
      ...api,
      runtime: {
        ...api.runtime,
        fetch: async (url, init) => {
          if (url.endsWith("/v1/reports/apps/keywords/query")) {
            now += FAN_OUT_BUDGET_MS / 3;
          }
          return original(url, init);
        },
      },
    };
    const window = request({
      mode: "incremental",
      from: "2026-10-27T00:00:00.000Z",
    });
    const pages: SyncResult[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await connector(NOW, () => now).sync(
        context(),
        { ...window, ...(cursor ? { cursor } : {}) },
        slow.runtime,
      );
      pages.push(result);
      if (result.done) break;
      cursor = result.nextCursor;
      now = 0;
    }
    // Three campaigns a page instead of six.
    expect(pages).toHaveLength(2);
    expect(decodeCursor(pages[0]!.nextCursor)?.after).toBe("5200000002");
    expect(keywordCampaignsAsked(api)).toEqual(
      Array.from({ length: 6 }, (_, i) => String(5200000000 + i)),
    );
    expectKeywordsMatchCampaigns(pages.flatMap((p) => p.observations));
  });
});
