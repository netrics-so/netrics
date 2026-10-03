import { gzipSync } from "node:zlib";

import type {
  ConnectionContext,
  Observation,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";
import { syncResultSchema } from "@netrics/connector-sdk";
import { describe, expect, it } from "vitest";

import {
  ANALYTICS_APPS_PER_PAGE,
  ANALYTICS_METRIC_KEYS,
  ANALYTICS_SEGMENT_HOSTS,
  AnalyticsReportError,
  AnalyticsSegmentHostError,
  AppStoreConnectApiError,
  createAppStoreConnectClient,
  createAppStoreConnectConnector,
  downloadSegment,
  ensureAnalyticsRequest,
  md5Hex,
  parseDiscoveryReport,
  parseDownloadsReport,
  readAppAnalytics,
  readSegment,
  reportDate,
  sourceLabel,
  syncAnalyticsApps,
} from "./index.js";
import {
  SEGMENT_HOST,
  createFakeAppStoreConnect,
  fixture,
  segmentFixture,
  type FakeAnalytics,
  type FakeTeam,
} from "./test-helpers.js";

// Analytics Reports (#174, ADR 0014) against sanitized fixtures: JSON:API
// pages, `.csv.gz` segments served from the pinned bucket host, a 409.

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.analytics-team.c2lnbmF0dXJl";
const VENDOR = "85012345";
// 2026-09-30 20:00 UTC is 13:00 PDT: the lookback reads instances processed
// from 2026-09-23 on.
const NOW = Date.parse("2026-09-30T20:00:00.000Z");
const APP = "1000000001";
const OTHER_APP = "1000000002";
const REQUEST_ID = "d48c69c5-9bcb-4592-abbd-000000000001";

type Page = {
  data: Array<{ attributes: { url: string; checksum: string } }>;
};

function segmentPath(name: string): string {
  return new URL((fixture(name) as Page).data[0]!.attributes.url).pathname;
}

function analytics(overrides: Partial<FakeAnalytics> = {}): FakeAnalytics {
  return {
    pages: {
      [`/v1/apps/${APP}/analyticsReportRequests`]:
        fixture("analytics-requests"),
      [`/v1/apps/${OTHER_APP}/analyticsReportRequests`]: fixture(
        "analytics-requests-empty",
      ),
      [`/v1/analyticsReportRequests/${REQUEST_ID}/reports`]:
        fixture("analytics-reports"),
      "/v1/analyticsReports/r3-0001/instances": fixture(
        "analytics-instances-discovery-page-1",
      ),
      "/v1/analyticsReports/r3-0001/instances?cursor=MQ": fixture(
        "analytics-instances-discovery-page-2",
      ),
      "/v1/analyticsReports/r5-0001/instances": fixture(
        "analytics-instances-downloads",
      ),
      "/v1/analyticsReportInstances/i-disc-0929/segments": fixture(
        "analytics-segments-empty",
      ),
      "/v1/analyticsReportInstances/i-disc-0928/segments": fixture(
        "analytics-segments-discovery-0928",
      ),
      "/v1/analyticsReportInstances/i-disc-0927/segments": fixture(
        "analytics-segments-discovery-0927",
      ),
      "/v1/analyticsReportInstances/i-disc-0927/segments?cursor=MQ": fixture(
        "analytics-segments-discovery-0927-page-2",
      ),
      "/v1/analyticsReportInstances/i-dl-0928/segments": fixture(
        "analytics-segments-downloads-0928",
      ),
      ...overrides.pages,
    },
    files: {
      [segmentPath("analytics-segments-discovery-0927")]: segmentFixture(
        "analytics-discovery-2026-09-27",
      ),
      [segmentPath("analytics-segments-discovery-0928")]: segmentFixture(
        "analytics-discovery-2026-09-28",
      ),
      [segmentPath("analytics-segments-downloads-0928")]: segmentFixture(
        "analytics-downloads-2026-09-28",
      ),
      ...overrides.files,
    },
    ...(overrides.create ? { create: overrides.create } : {}),
  };
}

function team(extra: Partial<FakeTeam> = {}): FakeTeam {
  return {
    tokens: [TOKEN],
    appPages: [fixture("apps-page-1"), fixture("apps-page-2")],
    vendorNumbers: [VENDOR],
    analytics: analytics(),
    ...extra,
  };
}

function fake(extra: Partial<FakeTeam> = {}, failures = []) {
  return createFakeAppStoreConnect({ teams: [team(extra)], failures });
}

function client(api: ReturnType<typeof fake>) {
  return createAppStoreConnectClient(api.fetch, TOKEN);
}

function find(
  observations: Observation[],
  metricKey: string,
  date: string,
  extra: Record<string, string> = {},
) {
  return observations.find(
    (entry) =>
      entry.metricKey === metricKey &&
      entry.sourceTimestamp === `${date}T00:00:00.000Z` &&
      JSON.stringify(entry.dimensions) ===
        JSON.stringify({ resource: APP, ...extra }),
  )?.value;
}

// ─── Reading the chain ──────────────────────────────────────────────────────

describe("analytics chain: request → reports → instances → segments", () => {
  it("maps impressions, product page views and first-time downloads by source", async () => {
    const api = fake();
    const result = await readAppAnalytics(client(api), api.fetch, APP, {
      now: NOW,
    });
    expect(result.status).toBe("read");
    const { impressions, productPageViews, storeDownloads } =
      ANALYTICS_METRIC_KEYS;
    // 2026-09-26 is in the oldest instance read, but an older instance
    // (2026-09-20) exists, so that day may be incomplete and is left out.
    expect(
      result.observations
        .filter((entry) => entry.metricKey !== storeDownloads)
        .map((entry) => [
          entry.metricKey,
          entry.sourceTimestamp.slice(0, 10),
          entry.value,
        ]),
    ).toEqual([
      // Late events of 2026-09-27 in the 09-28 instance are added.
      [impressions, "2026-09-27", 1200 + 300 + 25],
      // Product page and store sheet views; in-app event pages not.
      [productPageViews, "2026-09-27", 140 + 20],
      [impressions, "2026-09-28", 1000],
      [productPageViews, "2026-09-28", 100],
    ]);
    // Downloads: one instance and nothing older, so every day counts.
    // Redownloads and updates are not first-time downloads.
    expect(
      find(result.observations, storeDownloads, "2026-09-27", {
        source: "App Store search",
      }),
    ).toBe(42);
    expect(
      find(result.observations, storeDownloads, "2026-09-27", {
        source: "Web referrer",
      }),
    ).toBe(5);
    expect(
      find(result.observations, storeDownloads, "2026-09-27", {
        source: "Unavailable",
      }),
    ).toBe(1);
    expect(
      find(result.observations, storeDownloads, "2026-09-27", {
        source: "Other",
      }),
    ).toBe(3);
    expect(
      find(result.observations, storeDownloads, "2026-09-28", {
        source: "App Store browse",
      }),
    ).toBe(11);
    expect(
      result.observations.filter((entry) => entry.metricKey === storeDownloads),
    ).toHaveLength(5);
  });

  it("asks for ONGOING requests, DAILY instances, and reads every page", async () => {
    const api = fake();
    await readAppAnalytics(client(api), api.fetch, APP, { now: NOW });
    const apiCalls = api.requests
      .filter((entry) => entry.url.hostname === "api.appstoreconnect.apple.com")
      .map((entry) => `${entry.url.pathname}${entry.url.search}`);
    expect(apiCalls[0]).toBe(
      `/v1/apps/${APP}/analyticsReportRequests?filter%5BaccessType%5D=ONGOING&fields%5BanalyticsReportRequests%5D=accessType%2CstoppedDueToInactivity&limit=50`,
    );
    expect(apiCalls).toContain(
      "/v1/analyticsReports/r3-0001/instances?filter%5Bgranularity%5D=DAILY&fields%5BanalyticsReportInstances%5D=granularity%2CprocessingDate&limit=200",
    );
    // The second instance page and the second segment page (links.next).
    expect(apiCalls).toContain(
      "/v1/analyticsReports/r3-0001/instances?cursor=MQ&limit=200",
    );
    expect(apiCalls).toContain(
      "/v1/analyticsReportInstances/i-disc-0927/segments?cursor=MQ&limit=50",
    );
    // Instances outside the lookback (09-20) and WEEKLY ones are not read;
    // neither are the detailed reports.
    expect(apiCalls.join("\n")).not.toMatch(/i-disc-0920|i-disc-week|r2-|r4-/);
  });

  it("downloads segments from the pinned bucket host without the API token", async () => {
    const api = fake();
    await readAppAnalytics(client(api), api.fetch, APP, { now: NOW });
    const downloads = api.requests.filter(
      (entry) => entry.url.hostname === SEGMENT_HOST,
    );
    expect(downloads).toHaveLength(3);
    for (const entry of downloads) {
      expect(entry.init?.headers?.authorization).toBeUndefined();
      expect(JSON.stringify(entry.init ?? {})).not.toContain(TOKEN);
    }
  });

  it("reports a stopped request as paused, a missing one as not enabled", async () => {
    const stopped = fake({
      analytics: analytics({
        pages: {
          [`/v1/apps/${APP}/analyticsReportRequests`]: fixture(
            "analytics-requests-stopped",
          ),
        },
      }),
    });
    const paused = await readAppAnalytics(client(stopped), stopped.fetch, APP, {
      now: NOW,
    });
    expect(paused).toEqual({ status: "stopped", observations: [] });
    expect(stopped.requests).toHaveLength(1);

    const api = fake();
    expect(
      await readAppAnalytics(client(api), api.fetch, OTHER_APP, { now: NOW }),
    ).toEqual({ status: "not_enabled", observations: [] });
  });

  it("is pending while the reports have no instance yet", async () => {
    const empty = { data: [], links: {} };
    const api = fake({
      analytics: analytics({
        pages: {
          "/v1/analyticsReports/r3-0001/instances": empty,
          "/v1/analyticsReports/r5-0001/instances": empty,
        },
      }),
    });
    expect(
      await readAppAnalytics(client(api), api.fetch, APP, { now: NOW }),
    ).toEqual({ status: "pending", observations: [] });
  });
});

// ─── Segment downloads ─────────────────────────────────────────────────────

describe("segment downloads", () => {
  const segment = (fixture("analytics-segments-discovery-0927") as Page)
    .data[0]!.attributes;

  it("fails on a checksum mismatch", async () => {
    const api = fake();
    await expect(
      downloadSegment(api.fetch, { ...segment, checksum: "0".repeat(32) }),
    ).rejects.toThrow(
      new AnalyticsReportError(
        "App Store analytics segment does not match its checksum",
      ),
    );
  });

  it("refuses a host outside the pinned list before any request", async () => {
    const api = fake();
    for (const url of [
      "https://asp-qa-us-west-2.s3.us-west-2.amazonaws.com/reports/x.csv.gz?X-Amz-Signature=secret",
      "https://evil.s3.us-west-2.amazonaws.com/reports/x.csv.gz?X-Amz-Signature=secret",
      `http://${SEGMENT_HOST}/reports/x.csv.gz?X-Amz-Signature=secret`,
      "https://example.com/reports/x.csv.gz?X-Amz-Signature=secret",
    ]) {
      const error = await downloadSegment(api.fetch, {
        url,
        checksum: segment.checksum,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AnalyticsSegmentHostError);
      // Only the host is named; the presigned query never is.
      expect(String((error as Error).message)).not.toMatch(
        /X-Amz|secret|reports\//,
      );
    }
    expect(api.requests).toEqual([]);
    expect(ANALYTICS_SEGMENT_HOSTS).toEqual([SEGMENT_HOST]);
  });

  it("keeps the presigned URL out of errors", async () => {
    const expired = (await downloadSegment(fake().fetch, {
      url: `https://${SEGMENT_HOST}/reports/missing.csv.gz?X-Amz-Signature=secret-signature`,
      checksum: undefined,
    }).catch((caught: unknown) => caught)) as Error;
    expect(expired.message).toBe(
      "App Store analytics segment download answered 403",
    );
    const failing = (await downloadSegment(async (url) => {
      throw new TypeError(`fetch failed for ${url}`);
    }, segment).catch((caught: unknown) => caught)) as Error;
    expect(failing.message).toBe(
      "App Store analytics segment download failed (TypeError)",
    );
    expect(failing.cause).toBeUndefined();
  });

  it("inflates with a bound and verifies the checksum of what arrived", () => {
    const bytes = segmentFixture("analytics-discovery-2026-09-27");
    expect(readSegment(bytes, md5Hex(bytes))).toContain("Impression");
    expect(() => readSegment(bytes, undefined, 100)).toThrow(
      /exceeds 100 bytes when inflated/,
    );
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(4096, 0x41)));
    expect(() => readSegment(bomb, md5Hex(bomb), 1024)).toThrow(
      AnalyticsReportError,
    );
    expect(() =>
      readSegment(new Uint8Array([0x1f, 0x8b, 1, 2, 3]), undefined),
    ).toThrow("not a readable gzip file");
    // Already decoded by an HTTP layer (Content-Encoding: gzip).
    const plain = new TextEncoder().encode("Date\tCounts\n");
    expect(readSegment(plain, md5Hex(plain))).toBe("Date\tCounts\n");
  });
});

// ─── Parsing ────────────────────────────────────────────────────────────────

describe("analytics report parsing", () => {
  it("matches columns by name, ignores unknown columns, reads comma files", () => {
    const csv = [
      "Counts,Event,Unknown,Page Type,Date,App Apple Identifier",
      '7,Impression,"a, ""quoted"" value",No page,2026-09-27,1000000001',
      "",
    ].join("\r\n");
    expect(parseDiscoveryReport(csv)).toEqual([
      {
        date: "2026-09-27",
        appId: "1000000001",
        event: "Impression",
        pageType: "No page",
        sourceType: "",
        counts: 7,
      },
    ]);
    expect(parseDiscoveryReport("")).toEqual([]);
  });

  it("fails on a missing column, a bad count or a bad date", () => {
    expect(() =>
      parseDownloadsReport("Date\tApp Apple Identifier\tCounts\n"),
    ).toThrow('has no column "Download Type", "Source Type"');
    const header =
      "Date\tApp Apple Identifier\tDownload Type\tSource Type\tCounts";
    expect(() =>
      parseDownloadsReport(`${header}\n2026-09-27\t1\tRedownload\t\t1.5\n`),
    ).toThrow("count that is not a number");
    expect(() =>
      parseDownloadsReport(`${header}\n2026-02-30\t1\tRedownload\t\t1\n`),
    ).toThrow("date that is not a date");
  });

  it("reads Apple's date forms and bounds the source dimension", () => {
    expect(reportDate("2026-09-27")).toBe("2026-09-27");
    expect(reportDate("09/27/2026")).toBe("2026-09-27");
    expect(reportDate("27.09.2026")).toBeUndefined();
    expect(sourceLabel("app store SEARCH")).toBe("App Store search");
    expect(sourceLabel("")).toBe("Unavailable");
    expect(sourceLabel("Something New")).toBe("Other");
  });
});

// ─── Report requests (the one-time Admin step) ──────────────────────────────

describe("ensureAnalyticsRequest", () => {
  it("reuses a running request without creating one", async () => {
    const api = fake({ role: "admin" });
    expect(await ensureAnalyticsRequest(client(api), APP)).toEqual({
      status: "existing",
      requestId: REQUEST_ID,
    });
    expect(api.created).toEqual([]);
  });

  it("creates an ONGOING request when none exists, once", async () => {
    const pages = analytics().pages;
    const api = fake({ role: "admin", analytics: { pages } });
    expect(await ensureAnalyticsRequest(client(api), OTHER_APP)).toEqual({
      status: "created",
      requestId: "d48c69c5-9bcb-4592-abbd-000000000002",
    });
    expect(api.created).toEqual([
      {
        data: {
          type: "analyticsReportRequests",
          attributes: { accessType: "ONGOING" },
          relationships: { app: { data: { type: "apps", id: OTHER_APP } } },
        },
      },
    ]);
    // Apple now lists it: running the step again creates nothing.
    pages[`/v1/apps/${OTHER_APP}/analyticsReportRequests`] =
      fixture("analytics-requests");
    expect((await ensureAnalyticsRequest(client(api), OTHER_APP)).status).toBe(
      "existing",
    );
    expect(api.created).toHaveLength(1);
  });

  it("creates a new request when the only one stopped", async () => {
    const api = fake({
      role: "admin",
      analytics: analytics({
        pages: {
          [`/v1/apps/${APP}/analyticsReportRequests`]: fixture(
            "analytics-requests-stopped",
          ),
        },
      }),
    });
    expect((await ensureAnalyticsRequest(client(api), APP)).status).toBe(
      "created",
    );
  });

  it("treats 409 as already requested", async () => {
    const api = fake({ analytics: analytics({ create: "conflict" }) });
    expect(await ensureAnalyticsRequest(client(api), OTHER_APP)).toEqual({
      status: "existing",
      requestId: undefined,
    });
    expect(api.created).toHaveLength(1);
  });

  it("throws Apple's 403 for a key without the Admin role", async () => {
    const api = fake({ role: "sales" });
    const error = await ensureAnalyticsRequest(client(api), OTHER_APP).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppStoreConnectApiError);
    expect((error as AppStoreConnectApiError).status).toBe(403);
  });
});

// ─── Sync pages ─────────────────────────────────────────────────────────────

const CONTEXT: ConnectionContext = {
  connectionId: "asc-analytics-test",
  config: { vendorNumber: VENDOR },
  credentials: { accessToken: TOKEN },
};

function request(extra: Partial<SyncRequest> = {}): SyncRequest {
  return {
    mode: "incremental",
    from: "2026-09-28T00:00:00.000Z",
    to: new Date(NOW).toISOString(),
    ...extra,
  };
}

async function runAll(
  api: ReturnType<typeof fake>,
  extra: Partial<SyncRequest> = {},
  log: string[] = [],
) {
  const connector = createAppStoreConnectConnector({
    now: () => NOW,
    log: (message) => log.push(message),
  });
  const pages: SyncResult[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = syncResultSchema.parse(
      await connector.sync(
        CONTEXT,
        request({ ...extra, ...(cursor ? { cursor } : {}) }),
        api.runtime,
      ),
    );
    pages.push(result);
    if (result.done) break;
    expect(result.nextCursor).not.toBe(cursor);
    cursor = result.nextCursor;
  }
  return { pages, observations: pages.flatMap((page) => page.observations) };
}

describe("analytics sync pages", () => {
  it("follow the sales pages and end with the sales cursor", async () => {
    const api = fake();
    const { pages, observations } = await runAll(api, {
      resources: [APP, OTHER_APP],
    });
    expect(ANALYTICS_APPS_PER_PAGE).toBe(2);
    expect(pages.map((page) => [page.done, page.nextCursor])).toEqual([
      [false, "analytics:0:2026-09-28T00:00:00.000Z"],
      [true, "2026-09-28T00:00:00.000Z"],
    ]);
    expect(
      find(observations, ANALYTICS_METRIC_KEYS.impressions, "2026-09-28"),
    ).toBe(1000);
  });

  it("page through every app of the team when none is selected", async () => {
    const api = fake();
    const { pages } = await runAll(api);
    // Four apps in the fixtures: two analytics pages after the sales page.
    expect(pages.map((page) => page.nextCursor)).toEqual([
      "analytics:0:2026-09-28T00:00:00.000Z",
      "analytics:2:2026-09-28T00:00:00.000Z",
      "2026-09-28T00:00:00.000Z",
    ]);
  });

  it("skip an app whose analytics fail, and the sales stay", async () => {
    const segments = fixture("analytics-segments-discovery-0928") as Page;
    const outside = structuredClone(segments);
    outside.data[0]!.attributes.url =
      "https://other-bucket.s3.us-west-2.amazonaws.com/reports/0.csv.gz?X-Amz-Signature=presigned-secret";
    const api = fake({
      salesDays: ["2026-09-28"],
      analytics: analytics({
        pages: {
          "/v1/analyticsReportInstances/i-disc-0928/segments": outside,
        },
      }),
    });
    const log: string[] = [];
    const { pages, observations } = await runAll(
      api,
      { resources: [APP] },
      log,
    );
    expect(pages.at(-1)).toMatchObject({ done: true });
    expect(
      observations.some((entry) => entry.metricKey.endsWith(".downloads")),
    ).toBe(true);
    expect(
      observations.some((entry) =>
        Object.values(ANALYTICS_METRIC_KEYS).includes(entry.metricKey as never),
      ),
    ).toBe(false);
    expect(log.filter((line) => line.includes("analytics"))).toEqual([
      `App Store analytics of app ${APP} skipped: App Store analytics segment is hosted on other-bucket.s3.us-west-2.amazonaws.com, which netrics does not allow (allowed: ${SEGMENT_HOST})`,
    ]);
    expect(log.join("\n")).not.toContain("presigned-secret");
    expect(
      api.requests.some((entry) => entry.url.hostname.startsWith("other-")),
    ).toBe(false);
  });

  it("log a paused app and keep going", async () => {
    const api = fake({
      analytics: analytics({
        pages: {
          [`/v1/apps/${APP}/analyticsReportRequests`]: fixture(
            "analytics-requests-stopped",
          ),
        },
      }),
    });
    const log: string[] = [];
    const { pages } = await runAll(api, { resources: [APP] }, log);
    expect(pages.at(-1)).toMatchObject({ done: true });
    expect(log).toEqual([
      `App Store analytics of app ${APP} paused: Apple stopped its report request; enable analytics again`,
    ]);
  });

  it("end early on a rate limit, and throw a refused key", async () => {
    const limited = createFakeAppStoreConnect({
      teams: [team()],
      remaining: 50,
    });
    const log: string[] = [];
    const result = await syncAnalyticsApps(
      createAppStoreConnectClient(limited.fetch, TOKEN),
      limited.fetch,
      [APP, OTHER_APP],
      { now: NOW, log: (message) => log.push(message) },
    );
    expect(result.rateLimited).toBe(true);
    expect(log).toEqual([
      "App Store analytics postponed: the key's hourly request budget is used up",
    ]);

    const api = fake();
    await expect(
      syncAnalyticsApps(
        createAppStoreConnectClient(api.fetch, "revoked-token"),
        api.fetch,
        [APP],
        { now: NOW, log: () => {} },
      ),
    ).rejects.toMatchObject({ name: "AccessTokenRejectedError" });
  });
});
