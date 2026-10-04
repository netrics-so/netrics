import type {
  ConnectionContext,
  Observation,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";
import { syncResultSchema } from "@netrics/connector-sdk";
import { describe, expect, it } from "vitest";

import {
  MAX_REVIEW_PAGES,
  REVIEWS_ADMIN_MESSAGE,
  REVIEWS_KEY_MISMATCH_MESSAGE,
  REVIEWS_PAUSED_MESSAGE,
  REVIEWS_ROLE_MESSAGE,
  REVIEW_FIELDS,
  REVIEW_METRIC_KEYS,
  appStoreConnectManifest,
  createAppStoreConnectClient,
  createAppStoreConnectConnector,
  probeCustomerReviews,
  probeReviewsKeyNotAdmin,
  readAppReviews,
  reviewObservations,
  reviewsProbeApp,
  reviewsWindow,
  territoryAlpha2,
  type ReviewEntry,
} from "./index.js";
import {
  createFakeAppStoreConnect,
  fixture,
  type FakeAppStoreConnectOptions,
  type FakeTeam,
} from "./test-helpers.js";

// Ratings and reviews with the optional second key (#190, ADR 0014
// decision 2), offline against sanitized JSON:API pages.

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.sales-key-token.c2lnbmF0dXJl";
const REVIEWS_TOKEN = "eyJhbGciOiJFUzI1NiJ9.support-key-token.c2lnbmF0dXJl";
const VENDOR = "85012345";
const APP = "1000000001";
const QUIET_APP = "1000000002";
// 2026-10-01 18:00 UTC is 11:00 PDT: the Pacific day is Oct 1.
const NOW = Date.parse("2026-10-01T18:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const REVIEW_PAGES = {
  [`/v1/apps/${APP}/customerReviews`]: fixture("reviews-page-1"),
  [`/v1/apps/${APP}/customerReviews?cursor=Mw.AJ5kVmQ`]:
    fixture("reviews-page-2"),
};

const SALES_KEY: FakeTeam = {
  tokens: [TOKEN],
  appPages: [fixture("apps-page-1"), fixture("apps-page-2")],
  vendorNumbers: [VENDOR],
  reviewPages: REVIEW_PAGES,
};
const SUPPORT_KEY: FakeTeam = {
  tokens: [REVIEWS_TOKEN],
  appPages: [fixture("apps-page-1")],
  vendorNumbers: [VENDOR],
  role: "customer-support",
  reviewPages: REVIEW_PAGES,
};

function fake(
  support: Partial<FakeTeam> | null = {},
  options: Partial<FakeAppStoreConnectOptions> = {},
) {
  return createFakeAppStoreConnect({
    teams: support ? [SALES_KEY, { ...SUPPORT_KEY, ...support }] : [SALES_KEY],
    ...options,
  });
}

function context(reviewsToken: string | null = REVIEWS_TOKEN) {
  return {
    connectionId: "asc-reviews-test",
    config: { vendorNumber: VENDOR },
    credentials: {
      accessToken: TOKEN,
      ...(reviewsToken ? { reviewsAccessToken: reviewsToken } : {}),
    },
  } satisfies ConnectionContext;
}

function request(extra: Partial<SyncRequest> = {}): SyncRequest {
  return {
    mode: "incremental",
    from: "2026-09-28T00:00:00.000Z",
    to: new Date(NOW).toISOString(),
    resources: [APP, QUIET_APP],
    ...extra,
  };
}

async function runAll(
  api: ReturnType<typeof fake>,
  options: {
    context?: ConnectionContext;
    extra?: Partial<SyncRequest>;
    log?: string[];
  } = {},
) {
  const connector = createAppStoreConnectConnector({
    now: () => NOW,
    analytics: false,
    log: (message) => options.log?.push(message),
  });
  const pages: SyncResult[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 30; page += 1) {
    const result = syncResultSchema.parse(
      await connector.sync(
        options.context ?? context(),
        request({ ...options.extra, ...(cursor ? { cursor } : {}) }),
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

const reviewKeys = new Set<string>(Object.values(REVIEW_METRIC_KEYS));

function reviewRows(observations: Observation[]) {
  return observations.filter((entry) => reviewKeys.has(entry.metricKey));
}

function value(
  observations: Observation[],
  metricKey: string,
  day: string,
  dimensions: Record<string, string> = { resource: APP },
): number | undefined {
  return observations.find(
    (entry) =>
      entry.metricKey === metricKey &&
      entry.sourceTimestamp === `${day}T00:00:00.000Z` &&
      JSON.stringify(entry.dimensions) === JSON.stringify(dimensions),
  )?.value;
}

function reviewRequests(api: ReturnType<typeof fake>) {
  return api.requests.filter((entry) =>
    entry.url.pathname.endsWith("/customerReviews"),
  );
}

describe("manifest", () => {
  it("declares the review metrics, all delta per day and app", () => {
    const metrics = appStoreConnectManifest.metrics.filter((metric) =>
      reviewKeys.has(metric.key),
    );
    expect(
      metrics.map((metric) => [metric.key, metric.unit, metric.dimensions]),
    ).toEqual([
      ["app_store_connect.reviews", "reviews", ["resource"]],
      ["app_store_connect.review_rating_sum", "stars", ["resource"]],
      [
        "app_store_connect.reviews_by_rating",
        "reviews",
        ["resource", "rating"],
      ],
      [
        "app_store_connect.reviews_by_territory",
        "reviews",
        ["resource", "territory"],
      ],
    ]);
    expect(
      metrics.every(
        (metric) => metric.kind === "delta" && metric.granularity === "day",
      ),
    ).toBe(true);
    // Reviews come from the API host. itunes.apple.com is allowed for the
    // app icon lookup only (#226); reviews never use its public RSS feeds.
    expect(appStoreConnectManifest.outboundDomains).toContain(
      "api.appstoreconnect.apple.com",
    );
  });
});

describe("without a reviews key", () => {
  it("syncs exactly as before: no review request, no review metric, the sales cursor", async () => {
    const api = fake(null);
    const { pages, observations } = await runAll(api, {
      context: context(null),
    });
    expect(reviewRequests(api)).toHaveLength(0);
    expect(reviewRows(observations)).toEqual([]);
    expect(pages.at(-1)!.done).toBe(true);
    expect(
      pages.every((page) => !page.nextCursor?.startsWith("reviews:")),
    ).toBe(true);
  });

  it("ends a resumed reviews page when the key was removed meanwhile", async () => {
    const connector = createAppStoreConnectConnector({
      now: () => NOW,
      log: () => {},
    });
    const result = await connector.sync(
      context(null),
      request({ cursor: "reviews:2:2026-09-28T00:00:00.000Z" }),
      fake(null).runtime,
    );
    expect(result).toEqual({
      observations: [],
      nextCursor: "2026-09-28T00:00:00.000Z",
      done: true,
    });
  });
});

describe("reviews sync", () => {
  it("reads reviews after the sales with the reviews key, and ends with the sales cursor", async () => {
    const api = fake();
    const { pages, observations } = await runAll(api);
    const salesCursor = pages.at(-1)!.nextCursor!;
    expect(salesCursor).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(pages.map((page) => page.nextCursor)).toContain(
      `reviews:0:${salesCursor}`,
    );

    // Every review request carries the reviews key's token, every other
    // request the Sales key's.
    for (const entry of api.requests) {
      const reviews = entry.url.pathname.endsWith("/customerReviews");
      expect(entry.init?.headers?.authorization).toBe(
        `Bearer ${reviews ? REVIEWS_TOKEN : TOKEN}`,
      );
    }
    // Newest first, Apple's maximum page size, only rating, date and
    // territory; the second page through links.next.
    const [first, second] = reviewRequests(api).filter((entry) =>
      entry.url.pathname.includes(APP),
    );
    expect(first!.url.searchParams.get("sort")).toBe("-createdDate");
    expect(first!.url.searchParams.get("limit")).toBe("200");
    expect(first!.url.searchParams.get("fields[customerReviews]")).toBe(
      REVIEW_FIELDS,
    );
    expect(REVIEW_FIELDS).toBe("rating,createdDate,territory");
    expect(second!.url.searchParams.get("cursor")).toBe("Mw.AJ5kVmQ");

    const rows = reviewRows(observations);
    // Pacific days: 23:30 PDT on Sept 30 counts for Sept 30, not Oct 1 (UTC).
    expect(value(rows, REVIEW_METRIC_KEYS.reviews, "2026-10-01")).toBe(1);
    expect(value(rows, REVIEW_METRIC_KEYS.reviewRatingSum, "2026-10-01")).toBe(
      5,
    );
    expect(value(rows, REVIEW_METRIC_KEYS.reviews, "2026-09-30")).toBe(2);
    expect(value(rows, REVIEW_METRIC_KEYS.reviewRatingSum, "2026-09-30")).toBe(
      5,
    );
    expect(value(rows, REVIEW_METRIC_KEYS.reviews, "2026-09-28")).toBe(1);
    expect(value(rows, REVIEW_METRIC_KEYS.reviewRatingSum, "2026-09-28")).toBe(
      3,
    );
    // Days without reviews are 0, so a deleted review corrects its day.
    expect(value(rows, REVIEW_METRIC_KEYS.reviews, "2026-09-29")).toBe(0);
    expect(
      value(rows, REVIEW_METRIC_KEYS.reviewsByRating, "2026-09-30", {
        resource: APP,
        rating: "1",
      }),
    ).toBe(1);
    expect(
      value(rows, REVIEW_METRIC_KEYS.reviewsByRating, "2026-09-30", {
        resource: APP,
        rating: "5",
      }),
    ).toBe(0);
    // Territories as alpha-2 codes, like the sales report's.
    expect(
      value(rows, REVIEW_METRIC_KEYS.reviewsByTerritory, "2026-09-30", {
        resource: APP,
        territory: "DE",
      }),
    ).toBe(1);
    expect(
      value(rows, REVIEW_METRIC_KEYS.reviewsByTerritory, "2026-09-28", {
        resource: APP,
        territory: "GB",
      }),
    ).toBe(1);
    // An app without reviews gets its zeros.
    expect(
      value(rows, REVIEW_METRIC_KEYS.reviews, "2026-10-01", {
        resource: QUIET_APP,
      }),
    ).toBe(0);
    // Incremental: the last seven Pacific days and the window, not August.
    const days = new Set(
      rows.map((entry) => entry.sourceTimestamp.slice(0, 10)),
    );
    expect([...days].sort()).toEqual([
      "2026-09-24",
      "2026-09-25",
      "2026-09-26",
      "2026-09-27",
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
    ]);
  });

  it("never keeps review text or nicknames", async () => {
    const { observations } = await runAll(fake());
    const text = JSON.stringify(observations);
    expect(text).not.toContain("Synthetic review");
    expect(text).not.toContain("synthetic-reviewer");
  });

  it("reads the backfill window back to a year", async () => {
    const { observations } = await runAll(fake(), {
      extra: {
        mode: "backfill",
        from: new Date(NOW - 365 * DAY_MS).toISOString(),
      },
    });
    const rows = reviewRows(observations);
    expect(value(rows, REVIEW_METRIC_KEYS.reviews, "2026-08-15")).toBe(1);
    const days = new Set(
      rows
        .filter((entry) => entry.dimensions.resource === APP)
        .map((entry) => entry.sourceTimestamp.slice(0, 10)),
    );
    expect(days.size).toBe(365);
  });

  it.each([
    ["revoked (401)", { tokens: ["eyJ.revoked.key"] }],
    ["without a review-reading role (403)", { role: "sales" as const }],
  ])(
    "pauses only the reviews when the reviews key is %s",
    async (_label, support) => {
      const api = fake(support);
      const log: string[] = [];
      const { pages, observations } = await runAll(api, { log });
      expect(pages.at(-1)!.done).toBe(true);
      expect(pages.at(-1)!.nextCursor).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(reviewRows(observations)).toEqual([]);
      // Sales were synced as usual.
      expect(
        observations.some(
          (entry) => entry.metricKey === "app_store_connect.downloads",
        ),
      ).toBe(true);
      expect(log.some((line) => line.startsWith(REVIEWS_PAUSED_MESSAGE))).toBe(
        true,
      );
      // One refused request ends the reviews of the run.
      expect(reviewRequests(api)).toHaveLength(1);
      expect(log.join("\n")).not.toContain(REVIEWS_TOKEN);
    },
  );

  it("postpones the reviews on a rate limit without failing the run", async () => {
    const log: string[] = [];
    const connector = createAppStoreConnectConnector({
      now: () => NOW,
      log: (message) => log.push(message),
    });
    const limited = createFakeAppStoreConnect({
      teams: [SALES_KEY, SUPPORT_KEY],
      failures: [{ status: 429, fixture: "error-rate-limit" }],
    });
    const result = await connector.sync(
      context(),
      request({ cursor: "reviews:0:2026-09-28T00:00:00.000Z" }),
      limited.runtime,
    );
    expect(result).toEqual({
      observations: [],
      nextCursor: "2026-09-28T00:00:00.000Z",
      done: true,
    });
    expect(log.join("\n")).toMatch(/postponed/);
    expect(reviewRequests(limited)).toHaveLength(1);
  });

  it("skips an app whose reviews fail, and reads the next", async () => {
    const log: string[] = [];
    const connector = createAppStoreConnectConnector({
      now: () => NOW,
      log: (message) => log.push(message),
    });
    const api = createFakeAppStoreConnect({
      teams: [SALES_KEY, SUPPORT_KEY],
      failures: [{ status: 500, fixture: "error-unexpected" }],
    });
    const result = await connector.sync(
      context(),
      request({
        resources: [QUIET_APP, APP],
        cursor: "reviews:0:2026-09-28T00:00:00.000Z",
      }),
      api.runtime,
    );
    expect(result.done).toBe(true);
    expect(log.join("\n")).toMatch(
      /App Store reviews of app 1000000001 skipped/,
    );
    expect(
      value(result.observations, REVIEW_METRIC_KEYS.reviews, "2026-10-01", {
        resource: QUIET_APP,
      }),
    ).toBe(0);
  });

  it("pages two apps at a time when none is selected", async () => {
    const { pages } = await runAll(fake(), { extra: { resources: undefined } });
    const cursors = pages.map((page) => page.nextCursor ?? "");
    // Four apps in the fixtures: two reviews pages after the sales.
    expect(cursors.filter((cursor) => cursor.startsWith("reviews:"))).toEqual([
      expect.stringMatching(/^reviews:0:/),
      expect.stringMatching(/^reviews:2:/),
    ]);
  });
});

describe("reading one app", () => {
  it("stops at the first review older than the window", async () => {
    const api = fake();
    const client = createAppStoreConnectClient(api.fetch, REVIEWS_TOKEN);
    const result = await readAppReviews(
      client,
      APP,
      Date.parse("2026-09-29T00:00:00.000Z"),
    );
    expect(result).toEqual({
      status: "read",
      unreadable: 0,
      reviews: [
        { day: Date.parse("2026-10-01T00:00:00Z"), rating: 5, territory: "US" },
        { day: Date.parse("2026-09-30T00:00:00Z"), rating: 4, territory: "DE" },
        { day: Date.parse("2026-09-30T00:00:00Z"), rating: 1, territory: "US" },
      ],
    });
    // The second page holds the first older review; nothing after it.
    expect(reviewRequests(api)).toHaveLength(2);
  });

  it("marks the oldest day as incomplete when the page limit ends the read", async () => {
    const client = createAppStoreConnectClient(fake().fetch, REVIEWS_TOKEN);
    const result = await readAppReviews(
      client,
      APP,
      Date.parse("2026-01-01T00:00:00.000Z"),
      1,
    );
    expect(result).toMatchObject({
      status: "read",
      truncatedAt: Date.parse("2026-09-30T00:00:00Z"),
    });
    expect(MAX_REVIEW_PAGES).toBe(15);
  });
});

describe("observations", () => {
  const day = Date.parse("2026-09-10T00:00:00Z");
  const entries = (territory: string, count: number, on = day): ReviewEntry[] =>
    Array.from({ length: count }, () => ({ day: on, rating: 4, territory }));

  it("keeps the 10 territories with the most reviews per month and groups the rest", () => {
    const codes = ["US", "DE", "GB", "FR", "JP", "IT", "ES", "CA", "AU", "NL"];
    const reviews = [
      ...codes.flatMap((code, index) => entries(code, 20 - index)),
      ...entries("SE", 1),
      ...entries("NO", 1),
    ];
    const observations = reviewObservations(APP, reviews, {
      emitFrom: day,
      emitTo: day + DAY_MS,
    });
    const territories = observations
      .filter(
        (entry) => entry.metricKey === REVIEW_METRIC_KEYS.reviewsByTerritory,
      )
      .map((entry) => [entry.dimensions.territory, entry.value]);
    expect(territories).toHaveLength(11);
    expect(territories).toContainEqual(["Others", 2]);
    expect(territories).not.toContainEqual(["SE", 1]);
    expect(value(observations, REVIEW_METRIC_KEYS.reviews, "2026-09-10")).toBe(
      reviews.length,
    );
  });

  it("emits 0 for a territory that dropped out of the month's top 10", () => {
    // SE led on Sept 1 (an earlier sync could have stored it), then ten
    // territories overtook it.
    const first = Date.parse("2026-09-01T00:00:00Z");
    const codes = ["US", "DE", "GB", "FR", "JP", "IT", "ES", "CA", "AU", "NL"];
    const reviews = [
      ...entries("SE", 1, first),
      ...codes.flatMap((code) => entries(code, 3)),
      ...entries("SE", 1),
    ];
    const observations = reviewObservations(APP, reviews, {
      emitFrom: first,
      emitTo: day + DAY_MS,
    });
    expect(
      value(observations, REVIEW_METRIC_KEYS.reviewsByTerritory, "2026-09-10", {
        resource: APP,
        territory: "SE",
      }),
    ).toBe(0);
    expect(
      value(observations, REVIEW_METRIC_KEYS.reviewsByTerritory, "2026-09-01", {
        resource: APP,
        territory: "SE",
      }),
    ).toBe(0);
  });

  it("reads the window's whole first month for the ranking", () => {
    expect(reviewsWindow("2026-09-28T00:00:00.000Z", NOW, 365)).toEqual({
      emitFrom: Date.parse("2026-09-24T00:00:00Z"),
      emitTo: Date.parse("2026-10-02T00:00:00Z"),
      readFrom: Date.parse("2026-09-01T00:00:00Z"),
    });
  });

  it("maps App Store territories to alpha-2 codes", () => {
    expect(territoryAlpha2("USA")).toBe("US");
    expect(territoryAlpha2("DEU")).toBe("DE");
    expect(territoryAlpha2("GBR")).toBe("GB");
    expect(territoryAlpha2("XKS")).toBe("XK");
    expect(territoryAlpha2("ZZZ")).toBe("ZZZ");
    expect(territoryAlpha2(undefined)).toBeUndefined();
    expect(territoryAlpha2("not a code")).toBeUndefined();
  });
});

describe("reviews key probes", () => {
  it("accept a Customer Support key that reads reviews and no sales", async () => {
    const client = createAppStoreConnectClient(fake().fetch, REVIEWS_TOKEN);
    expect(await probeCustomerReviews(client, APP)).toEqual({ ok: true });
    expect(
      await probeReviewsKeyNotAdmin(client, { vendorNumber: VENDOR }, NOW),
    ).toEqual({ ok: true });
  });

  it("name the role for a Sales key, and the mismatch for a refused key", async () => {
    const api = fake();
    expect(
      await probeCustomerReviews(
        createAppStoreConnectClient(api.fetch, TOKEN),
        APP,
      ),
    ).toEqual({ ok: false, message: REVIEWS_ROLE_MESSAGE });
    expect(
      await probeCustomerReviews(
        createAppStoreConnectClient(api.fetch, "eyJ.unknown.key"),
        APP,
      ),
    ).toEqual({ ok: false, message: REVIEWS_KEY_MISMATCH_MESSAGE });
  });

  it("refuse an Admin key, which reads reviews and sales alike", async () => {
    const api = fake({ role: "admin" });
    const client = createAppStoreConnectClient(api.fetch, REVIEWS_TOKEN);
    expect(await probeCustomerReviews(client, APP)).toEqual({ ok: true });
    expect(
      await probeReviewsKeyNotAdmin(client, { vendorNumber: VENDOR }, NOW),
    ).toEqual({ ok: false, message: REVIEWS_ADMIN_MESSAGE });
  });

  it("probe the connection's first selected app, else the team's first app", async () => {
    const client = createAppStoreConnectClient(fake().fetch, REVIEWS_TOKEN);
    expect(
      await reviewsProbeApp(client, { resourceSelection: [QUIET_APP, APP] }),
    ).toBe(QUIET_APP);
    expect(await reviewsProbeApp(client, {})).toBe(APP);
  });

  it("throw on 429 so the user can try again", async () => {
    const api = fake(
      {},
      { failures: [{ status: 429, fixture: "error-rate-limit" }] },
    );
    await expect(
      probeCustomerReviews(
        createAppStoreConnectClient(api.fetch, REVIEWS_TOKEN),
        APP,
      ),
    ).rejects.toThrow(/429/);
  });
});
