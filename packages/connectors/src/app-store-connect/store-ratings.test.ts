import { describe, expect, it, vi } from "vitest";

import type {
  ConnectorRuntime,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";
import { syncResultSchema, validateDatasetPage } from "@netrics/connector-sdk";

import { createAppStoreConnectConnector, listApps } from "./index.js";
import {
  ratingStorefront,
  readStoreRatings,
  storeRatingsDataset,
  syncWithStoreRatings,
} from "./store-ratings.js";
import { createFakeAppStoreConnect, jsonResponse } from "./test-helpers.js";

const NOW = Date.parse("2026-11-05T12:30:00.000Z");
const CAPTURED = new Date(NOW).toISOString();
const request: SyncRequest = {
  mode: "backfill",
  from: "2026-11-01T00:00:00.000Z",
  to: CAPTURED,
  resources: ["101", "102"],
};
function runtime(results: unknown, status = 200) {
  return {
    signal: new AbortController().signal,
    fetch: vi
      .fn<ConnectorRuntime["fetch"]>()
      .mockResolvedValue(jsonResponse(status, results)),
  };
}

describe("overall storefront rating snapshots", () => {
  it("keeps all-version facts and scope distinct from current-version and written-review values", async () => {
    const rt = runtime({
      results: [
        {
          trackId: 101,
          trackName: "Notes",
          averageUserRating: 4.32145,
          userRatingCount: 1234,
          averageUserRatingForCurrentVersion: 2,
          userRatingCountForCurrentVersion: 3,
        },
        {
          trackId: 102,
          trackName: "New app",
          averageUserRating: 0,
          userRatingCount: 0,
        },
        { trackId: 999, averageUserRating: 1, userRatingCount: 9000 },
      ],
    });
    const records = await readStoreRatings(
      rt,
      ["101", "102", "103"],
      "DE",
      CAPTURED,
    );
    expect(records.map((r) => r.values)).toEqual([
      {
        app_id: "101",
        storefront: "DE",
        day: "2026-11-05",
        captured_at: CAPTURED,
        app_name: "Notes",
        rating: "4.32145",
        rating_count: 1234,
        availability: "available",
        provider_fields: {
          averageUserRating: 4.32145,
          userRatingCount: 1234,
          averageUserRatingForCurrentVersion: 2,
          userRatingCountForCurrentVersion: 3,
        },
      },
      {
        app_id: "102",
        storefront: "DE",
        day: "2026-11-05",
        captured_at: CAPTURED,
        app_name: "New app",
        rating: null,
        rating_count: 0,
        availability: "unrated",
        provider_fields: { averageUserRating: 0, userRatingCount: 0 },
      },
      {
        app_id: "103",
        storefront: "DE",
        day: "2026-11-05",
        captured_at: CAPTURED,
        app_name: null,
        rating: null,
        rating_count: null,
        availability: "not_listed",
        provider_fields: null,
      },
    ]);
    const [url, init] = rt.fetch.mock.calls[0]!;
    expect(new URL(url).searchParams.get("country")).toBe("de");
    expect(new URL(url).searchParams.get("id")).toBe("101,102,103");
    expect(init?.headers).toEqual({ accept: "application/json" });
    expect(
      validateDatasetPage(storeRatingsDataset, {
        datasetKey: "store_ratings",
        schemaVersion: 1,
        refreshKey: "run",
        pageKey: "0",
        previousPageKey: null,
        records,
        complete: true,
      }).records,
    ).toEqual(records);
    expect(storeRatingsDataset.retentionDays).toBeNull();
  });

  it("isolates malformed or incomplete app results without fabricating zeros", async () => {
    const rt = runtime({
      results: [
        { trackId: 101, averageUserRating: 8, userRatingCount: 4 },
        { trackId: 102, averageUserRating: 4.5 },
        { trackId: 103, averageUserRating: 4.6, userRatingCount: 10 },
        { trackId: 104, averageUserRating: 4.6, userRatingCount: 10 },
        { trackId: 104, averageUserRating: 3.6, userRatingCount: 20 },
      ],
    });
    const records = await readStoreRatings(
      rt,
      ["101", "102", "103", "104"],
      "US",
      CAPTURED,
    );
    expect(
      records.map((r) => [
        r.values.rating,
        r.values.rating_count,
        r.values.availability,
      ]),
    ).toEqual([
      [null, null, "temporarily_unavailable"],
      ["4.5", null, "incomplete"],
      ["4.6", 10, "available"],
      [null, null, "temporarily_unavailable"],
    ]);
  });

  it("records safe missing states for rate limits, outages, invalid envelopes and thrown errors", async () => {
    for (const rt of [
      runtime({}, 429),
      runtime({}, 503),
      runtime({ unexpected: true }),
      runtime({ results: [] }),
    ]) {
      const result = await readStoreRatings(rt, ["101"], "US", CAPTURED);
      expect(result[0]?.values.rating).toBeNull();
      expect(result[0]?.values.rating_count).toBeNull();
    }
    const rt = runtime({});
    rt.fetch.mockRejectedValue(new Error("sensitive provider text"));
    const result = await readStoreRatings(rt, ["101"], "US", CAPTURED);
    expect(result[0]?.values.availability).toBe("temporarily_unavailable");
    expect(JSON.stringify(result)).not.toContain("sensitive");
    const controller = new AbortController();
    controller.abort();
    await expect(
      readStoreRatings(
        { ...rt, signal: controller.signal },
        ["101"],
        "US",
        CAPTURED,
      ),
    ).rejects.toThrow("cancelled");
  });

  it("defaults the explicitly named storefront and validates before requesting data", () => {
    expect(ratingStorefront({})).toBe("US");
    expect(ratingStorefront({ ratingStorefront: " de " })).toBe("DE");
    for (const bad of ["", "USA", 123, "<>"])
      expect(() => ratingStorefront({ ratingStorefront: bad })).toThrow(
        "two-letter",
      );
  });
});

describe("rating checkpoint protocol", () => {
  it("pages a portfolio, commits one complete generation, and unwraps the original sales checkpoint", async () => {
    const appIds = Array.from({ length: 121 }, (_, i) => String(1000 + i));
    const rt = runtime({ results: [] });
    const legacy = vi
      .fn()
      .mockResolvedValueOnce({
        observations: [],
        done: false,
        nextCursor: "analytics:0:2026-11-05T00:00:00.000Z",
      })
      .mockResolvedValueOnce({
        observations: [],
        done: true,
        nextCursor: "2026-11-05T00:00:00.000Z",
      });
    const options = {
      storefront: "US",
      now: NOW,
      appIds: async () => appIds,
      legacy,
    };
    let cursor: string | undefined = "2026-11-01T00:00:00.000Z";
    const pages: SyncResult[] = [];
    for (let i = 0; i < 5; i++) {
      const result = await syncWithStoreRatings({ ...request, cursor }, rt, {
        ...options,
        now: NOW + i * 60_000,
      });
      pages.push(result);
      cursor = result.nextCursor;
    }
    const datasets = pages.flatMap((p) => p.datasetPages ?? []);
    expect(
      datasets.map((p) => [
        p.pageKey,
        p.previousPageKey,
        p.complete,
        p.records.length,
      ]),
    ).toEqual([
      ["0", null, false, 50],
      ["50", "0", false, 50],
      ["100", "50", true, 21],
    ]);
    expect(new Set(datasets.map((p) => p.refreshKey)).size).toBe(1);
    expect(
      new Set(
        datasets.flatMap((p) => p.records.map((r) => r.values.captured_at)),
      ),
    ).toEqual(new Set([CAPTURED]));
    expect(legacy.mock.calls[0]?.[0].cursor).toBe("2026-11-01T00:00:00.000Z");
    expect(legacy.mock.calls[1]?.[0].cursor).toBe(
      "analytics:0:2026-11-05T00:00:00.000Z",
    );
    expect(pages.at(-1)).toMatchObject({
      done: true,
      nextCursor: "2026-11-05T00:00:00.000Z",
    });
    expect(rt.fetch).toHaveBeenCalledTimes(3);
  });

  it("restarts incomplete publication when selected apps or storefront change", async () => {
    const rt = runtime({ results: [] });
    const options = {
      storefront: "US",
      now: NOW,
      appIds: async () =>
        Array.from({ length: 51 }, (_, i) => String(1000 + i)),
      legacy: vi.fn(),
    };
    const first = await syncWithStoreRatings(request, rt, options);
    const second = await syncWithStoreRatings(
      { ...request, cursor: first.nextCursor },
      rt,
      { ...options, storefront: "DE", now: NOW + 1_000 },
    );
    expect(second.datasetPages?.[0]?.pageKey).toBe("0");
    expect(second.datasetPages?.[0]?.refreshKey).not.toBe(
      first.datasetPages?.[0]?.refreshKey,
    );
    expect(
      second.datasetPages?.[0]?.records.every(
        (r) => r.values.storefront === "DE",
      ),
    ).toBe(true);
    const third = await syncWithStoreRatings(
      { ...request, cursor: second.nextCursor },
      rt,
      { ...options, storefront: "DE", appIds: async () => ["2000"] },
    );
    expect(third.datasetPages?.[0]).toMatchObject({
      pageKey: "0",
      previousPageKey: null,
      complete: true,
    });
    expect(third.datasetPages?.[0]?.records[0]?.values.app_id).toBe("2000");
  });

  it("handles empty selections without a public request and resumes sales without a prior cursor", async () => {
    const rt = runtime({});
    const legacy = vi.fn().mockResolvedValue({
      observations: [],
      done: true,
      nextCursor: CAPTURED,
    });
    const options = {
      storefront: "US",
      now: NOW,
      appIds: async () => [],
      legacy,
    };
    const first = await syncWithStoreRatings(request, rt, options);
    expect(first.datasetPages?.[0]).toMatchObject({
      complete: true,
      records: [],
    });
    await syncWithStoreRatings(
      { ...request, cursor: first.nextCursor },
      rt,
      options,
    );
    expect(legacy.mock.calls[0]?.[0].cursor).toBeUndefined();
    expect(rt.fetch).not.toHaveBeenCalled();
  });

  it("enables snapshots by default before sales, even when their lookup fails", async () => {
    const fake = createFakeAppStoreConnect({
      teams: [
        { tokens: ["signed-token"], vendorNumbers: ["123"], reports: {} },
      ],
    });
    const connector = createAppStoreConnectConnector({
      now: () => NOW,
      analytics: false,
    });
    const context = {
      connectionId: "test",
      config: { vendorNumber: "123", ratingStorefront: "DE" },
      credentials: { accessToken: "signed-token" },
    };
    const first = syncResultSchema.parse(
      await connector.sync(context, request, fake.runtime),
    );
    expect(
      first.datasetPages?.[0]?.records.map((r) => r.values.availability),
    ).toEqual(["temporarily_unavailable", "temporarily_unavailable"]);
    expect(
      fake.requests.every((r) => r.url.hostname === "itunes.apple.com"),
    ).toBe(true);
    const second = syncResultSchema.parse(
      await connector.sync(
        context,
        {
          ...request,
          cursor: first.nextCursor,
        },
        fake.runtime,
      ),
    );
    expect(
      second.observations.every((row) =>
        row.metricKey.startsWith("app_store_connect."),
      ),
    ).toBe(true);
    expect(
      fake.requests.some((r) => r.url.pathname === "/v1/salesReports"),
    ).toBe(true);
  });
});

describe("app discovery pagination", () => {
  it("reads beyond the former fixed 50-page ceiling", async () => {
    const getJson = vi.fn(async () => {
      const n = getJson.mock.calls.length;
      return {
        data: [
          { id: String(n), type: "apps", attributes: { name: `App ${n}` } },
        ],
        links: n < 52 ? { next: `/v1/apps?cursor=${n}` } : {},
      };
    });
    const apps = await listApps({ getJson } as unknown as Parameters<
      typeof listApps
    >[0]);
    expect(apps).toHaveLength(52);
  });

  it("rejects repeated provider cursors instead of looping", async () => {
    const getJson = vi.fn().mockResolvedValue({
      data: [],
      links: { next: "https://api.appstoreconnect.apple.com/v1/apps" },
    });
    await expect(
      listApps({ getJson } as unknown as Parameters<typeof listApps>[0]),
    ).rejects.toThrow("repeated");
    expect(getJson).toHaveBeenCalledTimes(1);
  });
});
