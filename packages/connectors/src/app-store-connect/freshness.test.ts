import type {
  ConnectionContext,
  ConnectorRuntime,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";
import { syncResultSchema } from "@netrics/connector-sdk";
import {
  expectValidFreshness,
  freshnessEntry,
} from "@netrics/connector-sdk/testing";
import { describe, expect, it } from "vitest";

import {
  ITUNES_LOOKUP_URL,
  LISTING_RATINGS_STREAM,
  REVIEWS_STREAM,
  SALES_STREAM,
  appStoreConnectManifest,
  createAppStoreConnectConnector,
} from "./index.js";
import {
  createFakeAppStoreConnect,
  fixture,
  jsonResponse,
  type FakeTeam,
} from "./test-helpers.js";

// Freshness of App Store Connect (ADR 0025, #703), offline with fixed
// clocks around Apple's publication times: a Pacific day D is expected
// from 12:00 PT on D + 1, typically from 05:00 PT.

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.freshness-sales.c2lnbmF0dXJl";
const REVIEWS_TOKEN = "eyJhbGciOiJFUzI1NiJ9.freshness-support.c2lnbmF0dXJl";
const VENDOR = "85012345";
const APP = "1000000001";
const QUIET_APP = "1000000002";
const REVIEW_PAGES = {
  [`/v1/apps/${APP}/customerReviews`]: fixture("reviews-page-1"),
  [`/v1/apps/${APP}/customerReviews?cursor=Mw.AJ5kVmQ`]:
    fixture("reviews-page-2"),
};

function salesTeam(extra: Partial<FakeTeam> = {}): FakeTeam {
  return {
    tokens: [TOKEN],
    appPages: [fixture("apps-page-1"), fixture("apps-page-2")],
    vendorNumbers: [VENDOR],
    reviewPages: REVIEW_PAGES,
    ...extra,
  };
}

const SUPPORT_TEAM: FakeTeam = {
  tokens: [REVIEWS_TOKEN],
  appPages: [fixture("apps-page-1")],
  vendorNumbers: [VENDOR],
  role: "customer-support",
  reviewPages: REVIEW_PAGES,
};

function context(reviewsKey = false): ConnectionContext {
  return {
    connectionId: "asc-freshness-test",
    config: { vendorNumber: VENDOR },
    credentials: {
      accessToken: TOKEN,
      ...(reviewsKey ? { reviewsAccessToken: REVIEWS_TOKEN } : {}),
    },
  };
}

/** Every page of one run at a fixed clock, as the engine pages it. */
async function run(
  now: string,
  options: {
    team?: Partial<FakeTeam>;
    support?: Partial<FakeTeam> | null;
    reviewsKey?: boolean;
    ratings?: boolean;
    rawSales?: boolean;
    lookup?: (url: string) => ReturnType<typeof jsonResponse> | undefined;
    request?: Partial<SyncRequest>;
  } = {},
): Promise<SyncResult> {
  const nowMs = Date.parse(now);
  const api = createFakeAppStoreConnect({
    teams: [
      salesTeam(options.team),
      ...(options.support === null
        ? []
        : [{ ...SUPPORT_TEAM, ...options.support }]),
    ],
  });
  const runtime: ConnectorRuntime = {
    signal: new AbortController().signal,
    fetch: async (url, init) =>
      options.lookup?.(url) ?? (await api.fetch(url, init)),
  };
  const connector = createAppStoreConnectConnector({
    now: () => nowMs,
    ratings: options.ratings ?? false,
    rawSales: options.rawSales ?? false,
    analytics: false,
    log: () => undefined,
  });
  const base: SyncRequest = {
    mode: "incremental",
    from: new Date(nowMs - 5 * 24 * 60 * 60 * 1000).toISOString(),
    to: new Date(nowMs).toISOString(),
    resources: [APP, QUIET_APP],
    ...options.request,
  };
  let cursor: string | undefined;
  for (let page = 0; page < 30; page += 1) {
    const result = syncResultSchema.parse(
      await connector.sync(
        context(options.reviewsKey),
        { ...base, ...(cursor ? { cursor } : {}) },
        runtime,
      ),
    );
    if (result.done) {
      expectValidFreshness(appStoreConnectManifest, result);
      return result;
    }
    expect(result.freshness).toBeUndefined();
    cursor = result.nextCursor;
  }
  throw new Error("the run did not finish");
}

describe("App Store Connect freshness: the sales stream", () => {
  it("before 12:00 PT: the day before yesterday, yesterday expected at noon today", async () => {
    // 11:00 PDT on 1 October: 30 September may not be published yet.
    const result = await run("2026-10-01T18:00:00.000Z");
    expect(freshnessEntry(result, SALES_STREAM)).toEqual({
      stream: SALES_STREAM,
      dataThrough: "2026-09-29",
      expectedFrom: "2026-10-01T12:00:00.000Z", // 05:00 PDT
      nextExpectedAt: "2026-10-01T19:00:00.000Z", // 12:00 PDT
    });
  });

  it("after 12:00 PT: yesterday, today's day expected at noon tomorrow", async () => {
    // 13:00 PDT: a 404 for 30 September now means a day without sales.
    const result = await run("2026-10-01T20:00:00.000Z");
    expect(freshnessEntry(result, SALES_STREAM)).toEqual({
      stream: SALES_STREAM,
      dataThrough: "2026-09-30",
      expectedFrom: "2026-10-02T12:00:00.000Z",
      nextExpectedAt: "2026-10-02T19:00:00.000Z",
    });
  });

  it("inside the expectedFrom window: a report Apple published early counts", async () => {
    // 07:00 PDT, and Apple has published 30 September already.
    const early = await run("2026-10-01T14:00:00.000Z", {
      team: { salesDays: ["2026-09-30"] },
    });
    expect(freshnessEntry(early, SALES_STREAM)?.dataThrough).toBe("2026-09-30");
    // Not yet published at 07:00: the expected times stay those of today.
    const waiting = await run("2026-10-01T14:00:00.000Z");
    expect(freshnessEntry(waiting, SALES_STREAM)).toMatchObject({
      dataThrough: "2026-09-29",
      expectedFrom: "2026-10-01T12:00:00.000Z",
      nextExpectedAt: "2026-10-01T19:00:00.000Z",
    });
  });

  it("follows daylight saving time when it starts in March", async () => {
    // Saturday 7 March 2026, 13:00 PST; clocks go forward on Sunday 8 March.
    const saturday = await run("2026-03-07T21:00:00.000Z");
    expect(freshnessEntry(saturday, SALES_STREAM)).toEqual({
      stream: SALES_STREAM,
      dataThrough: "2026-03-06",
      expectedFrom: "2026-03-08T12:00:00.000Z", // 05:00 PDT
      nextExpectedAt: "2026-03-08T19:00:00.000Z", // 12:00 PDT
    });
    // Sunday 8 March, 11:00 PDT (after the change): still the 6th.
    const sunday = await run("2026-03-08T18:00:00.000Z");
    expect(freshnessEntry(sunday, SALES_STREAM)).toMatchObject({
      dataThrough: "2026-03-06",
      nextExpectedAt: "2026-03-08T19:00:00.000Z",
    });
    // Friday 6 March, 13:00 PST: Saturday's noon is still standard time.
    const friday = await run("2026-03-06T21:00:00.000Z");
    expect(freshnessEntry(friday, SALES_STREAM)).toMatchObject({
      dataThrough: "2026-03-05",
      expectedFrom: "2026-03-07T13:00:00.000Z", // 05:00 PST
      nextExpectedAt: "2026-03-07T20:00:00.000Z", // 12:00 PST
    });
  });

  it("follows daylight saving time when it ends in November", async () => {
    // Saturday 31 October 2026, 13:00 PDT; clocks go back on Sunday 1 November.
    const saturday = await run("2026-10-31T20:00:00.000Z");
    expect(freshnessEntry(saturday, SALES_STREAM)).toEqual({
      stream: SALES_STREAM,
      dataThrough: "2026-10-30",
      expectedFrom: "2026-11-01T13:00:00.000Z", // 05:00 PST
      nextExpectedAt: "2026-11-01T20:00:00.000Z", // 12:00 PST
    });
    // Sunday 1 November, 11:30 PST: before noon, still the 30th.
    const sunday = await run("2026-11-01T19:30:00.000Z");
    expect(freshnessEntry(sunday, SALES_STREAM)).toMatchObject({
      dataThrough: "2026-10-30",
      nextExpectedAt: "2026-11-01T20:00:00.000Z",
    });
    // Sunday 1 November, 12:30 PST: the 31st.
    const afterNoon = await run("2026-11-01T20:30:00.000Z");
    expect(freshnessEntry(afterNoon, SALES_STREAM)).toMatchObject({
      dataThrough: "2026-10-31",
      nextExpectedAt: "2026-11-02T20:00:00.000Z",
    });
  });

  it("passes the sales entry through the retained sales rows", async () => {
    const result = await run("2026-10-01T20:00:00.000Z", {
      rawSales: true,
      team: { salesDays: ["2026-09-29", "2026-09-30"] },
    });
    expect(freshnessEntry(result, SALES_STREAM)?.dataThrough).toBe(
      "2026-09-30",
    );
  });

  it("reports the vendor's sales once, for the whole connection", async () => {
    const result = await run("2026-10-01T20:00:00.000Z");
    expect(
      result.freshness?.filter((entry) => entry.stream === SALES_STREAM),
    ).toHaveLength(1);
    expect(freshnessEntry(result, SALES_STREAM)?.resource).toBeUndefined();
  });

  it("claims nothing for a window whose month ends before the newest day", async () => {
    const result = await run("2026-10-01T20:00:00.000Z", {
      request: {
        mode: "backfill",
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-08-10T00:00:00.000Z",
      },
    });
    expect(freshnessEntry(result, SALES_STREAM)).toBeUndefined();
    // A window inside the newest month: the page reads the whole month up
    // to the newest day (the territory ranking), so that day is confirmed.
    const month = await run("2026-10-01T20:00:00.000Z", {
      request: {
        mode: "backfill",
        from: "2026-09-01T00:00:00.000Z",
        to: "2026-09-10T00:00:00.000Z",
      },
    });
    expect(freshnessEntry(month, SALES_STREAM)?.dataThrough).toBe("2026-09-30");
  });
});

describe("App Store Connect freshness: reviews", () => {
  it("reports reviews as read when the connection has a reviews key", async () => {
    const result = await run("2026-10-01T20:00:00.000Z", { reviewsKey: true });
    expect(freshnessEntry(result, REVIEWS_STREAM)).toEqual({
      stream: REVIEWS_STREAM,
    });
    expect(freshnessEntry(result, SALES_STREAM)).toBeDefined();
  });

  it("reports no reviews without a reviews key", async () => {
    const result = await run("2026-10-01T20:00:00.000Z", { support: null });
    expect(freshnessEntry(result, REVIEWS_STREAM)).toBeUndefined();
    expect(freshnessEntry(result, SALES_STREAM)).toBeDefined();
  });

  it("reports no reviews when Apple refuses the reviews key", async () => {
    const result = await run("2026-10-01T20:00:00.000Z", {
      reviewsKey: true,
      support: null,
    });
    expect(freshnessEntry(result, REVIEWS_STREAM)).toBeUndefined();
    expect(freshnessEntry(result, SALES_STREAM)).toBeDefined();
  });
});

describe("App Store Connect freshness: listing ratings", () => {
  const lookup = (url: string) =>
    url.startsWith(ITUNES_LOOKUP_URL)
      ? jsonResponse(200, {
          results: [{ trackId: Number(APP), averageUserRating: 4.5 }],
        })
      : undefined;

  it("reports the rating snapshot as read when every app's lookup answered", async () => {
    const result = await run("2026-10-01T20:00:00.000Z", {
      ratings: true,
      lookup,
    });
    expect(freshnessEntry(result, LISTING_RATINGS_STREAM)).toEqual({
      stream: LISTING_RATINGS_STREAM,
    });
    expect(freshnessEntry(result, SALES_STREAM)?.dataThrough).toBe(
      "2026-09-30",
    );
  });

  it("reports no rating snapshot when the lookup failed", async () => {
    const result = await run("2026-10-01T20:00:00.000Z", {
      ratings: true,
      lookup: (url) =>
        url.startsWith(ITUNES_LOOKUP_URL)
          ? jsonResponse(503, { error: "unavailable" })
          : undefined,
    });
    expect(freshnessEntry(result, LISTING_RATINGS_STREAM)).toBeUndefined();
    expect(freshnessEntry(result, SALES_STREAM)).toBeDefined();
  });
});

describe("App Store Connect freshness streams", () => {
  it("declares sales, analytics, reviews and listing ratings", () => {
    expect(
      appStoreConnectManifest.freshnessStreams?.map((stream) => [
        stream.key,
        stream.kind,
        stream.timeZone,
      ]),
    ).toEqual([
      ["sales", "periodic", "America/Los_Angeles"],
      ["analytics", "periodic", "America/Los_Angeles"],
      ["reviews", "continuous", undefined],
      ["listing_ratings", "continuous", undefined],
    ]);
  });
});
