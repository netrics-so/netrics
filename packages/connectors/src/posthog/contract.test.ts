import type {
  ConnectionContext,
  ConnectorRuntime,
  DatasetPage,
  Observation,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";
import {
  ConnectorError,
  RateLimitedError,
  syncResultSchema,
  validateDatasetPage,
} from "@netrics/connector-sdk";
import {
  expectValidFreshness,
  freshnessEntry,
  runConnectorContractTests,
} from "@netrics/connector-sdk/testing";
import { describe, expect, it } from "vitest";

import { MAX_RATE_LIMIT_HOLD_MS } from "../rate-limit-hold.js";

import {
  PostHogApiError,
  apiError,
  assertReadOnly,
  type PostHogClient,
} from "./api.js";
import { POSTHOG_DATASETS } from "./datasets.js";
import {
  ANALYTICS_STREAM,
  HOST_INVALID_CODE,
  INSIGHTS_INVALID_CODE,
  INSIGHTS_STREAM,
  INSIGHTS_UNAVAILABLE_CODE,
  MAX_INSIGHT_OPTIONS,
  KEY_REJECTED_CODE,
  KEY_REJECTED_MESSAGE,
  MAX_INSIGHT_ROWS,
  MAX_REQUESTS_PER_PAGE,
  METRICS,
  SCOPE_MISSING_CODE,
  createPostHogConnector,
  posthogManifest,
} from "./index.js";
import { insightsSchema, nextOffset, topEventsBody } from "./queries.js";
import { insightsOf, listProjects } from "./reading.js";
import { insightRows, topEventRows, trendValues } from "./sync.js";
import {
  FAKE_KEY,
  ORG,
  answer,
  createFakePostHog,
  fakeProjects,
  fixture,
  rateLimited,
  scopeMissing,
  trendsInsightQuery,
  type FakePostHogOptions,
} from "./test-helpers.js";

const NOW = "2024-01-10T12:00:00.000Z";
const noSleep = async () => {};
const clock = () => Date.parse(NOW);

function connector(now: () => number = clock) {
  return createPostHogConnector({ now, sleep: noSleep });
}

/**
 * The host's rules for one result (connector-runtime validateSyncResult,
 * ADR 0026 §7), which the connectors package may not import: a final result
 * carries only complete pages, received datasets only on the final result,
 * and every page fits its dataset. apps/server's posthog-sync.test.ts runs
 * whole syncs through the real validation.
 */
function expectHostAccepts(result: SyncResult): void {
  const parsed = syncResultSchema.safeParse(result);
  expect(parsed.success, parsed.error?.message).toBe(true);
  if (result.done) {
    for (const page of result.datasetPages ?? []) {
      expect(page.complete, `${page.datasetKey} ${page.pageKey}`).toBe(true);
      expect(page.records, `${page.datasetKey} ${page.pageKey}`).toEqual([]);
    }
    expectValidFreshness(posthogManifest, result);
  } else {
    expect(result.receivedDatasets ?? []).toEqual([]);
    for (const page of result.datasetPages ?? []) {
      expect(page.complete).toBe(false);
    }
  }
  const schemas = new Map(
    POSTHOG_DATASETS.map((dataset) => [dataset.key, dataset]),
  );
  for (const page of result.datasetPages ?? []) {
    expect(() =>
      validateDatasetPage(schemas.get(page.datasetKey)!, page),
    ).not.toThrow();
  }
}

function context(
  config: Record<string, unknown> = {},
  overrides: Partial<ConnectionContext> = {},
): ConnectionContext {
  return {
    connectionId: "posthog-test",
    config,
    credentials: { token: FAKE_KEY },
    ...overrides,
  };
}

function fake(options: FakePostHogOptions = {}) {
  return createFakePostHog(options);
}

const WINDOW: SyncRequest = {
  mode: "backfill",
  from: "2024-01-01T00:00:00.000Z",
  to: NOW,
};

interface Run {
  pages: SyncResult[];
  observations: Observation[];
  datasetPages: DatasetPage[];
  last: SyncResult;
}

/** Runs every page of one sync the way the engine does. */
async function syncAll(
  runtime: ConnectorRuntime,
  request: SyncRequest = WINDOW,
  ctx = context(),
  now: () => number = clock,
): Promise<Run> {
  const pages: SyncResult[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 300; guard += 1) {
    const page = await connector(now).sync(
      ctx,
      { ...request, ...(cursor ? { cursor } : {}) },
      runtime,
    );
    expectHostAccepts(page);
    pages.push(page);
    if (page.done) break;
    expect(page.nextCursor).not.toBe(cursor);
    cursor = page.nextCursor;
  }
  expect(pages.at(-1)!.done).toBe(true);
  return {
    pages,
    observations: pages.flatMap((page) => page.observations),
    datasetPages: pages.flatMap((page) => page.datasetPages ?? []),
    last: pages.at(-1)!,
  };
}

/** The values the engine keeps: the last observation of each identity. */
function latest(observations: Observation[]): Map<string, number> {
  const values = new Map<string, number>();
  for (const observation of observations) {
    values.set(
      JSON.stringify([
        observation.metricKey,
        observation.sourceTimestamp,
        observation.dimensions,
      ]),
      observation.value,
    );
  }
  return values;
}

function rowsOf(pages: DatasetPage[], key: string) {
  return pages
    .filter((page) => page.datasetKey === key)
    .flatMap((page) => page.records.map((record) => record.values));
}

function valuesOf(run: Run, metric: string, resource: string) {
  return run.observations
    .filter(
      (observation) =>
        observation.metricKey === metric &&
        observation.dimensions.resource === resource,
    )
    .map((observation) => [
      observation.sourceTimestamp.slice(0, 10),
      observation.value,
    ]);
}

runConnectorContractTests(connector(), {
  context: context(),
  runtime: fake().runtime,
  cursorOrder: "changing",
});

describe("PostHog manifest", () => {
  it("is a read-only connector of PostHog Cloud, and of a configured host", () => {
    expect(posthogManifest.outboundDomains).toEqual([
      "us.posthog.com",
      "eu.posthog.com",
    ]);
    expect(posthogManifest.configuredHosts).toEqual(["host"]);
    expect(posthogManifest.supportsResourceSelection).toBe(true);
    expect(posthogManifest.sdkVersion).toBe("^0.2.24");
    // Saved insights are chosen in a picker, per project (#891).
    expect(posthogManifest.configOptions).toEqual([
      { key: "insights", per: "resource", maxSelected: 20 },
    ]);
    // The connect form sends a token strategy's secret as `token`.
    const [strategy] = posthogManifest.authStrategies;
    expect(
      strategy?.strategy === "token"
        ? Object.keys(
            (strategy.credentialsSchema as { properties: object }).properties,
          )
        : [],
    ).toEqual(["token"]);
  });
});

describe("PostHog answers", () => {
  it("reads the recorded trends shape", () => {
    const values = trendValues(
      fixture("trends-response.json"),
      "2024-01-08",
      "2024-01-10",
    );
    expect([...values.get("events")!]).toEqual([
      ["2024-01-08", 140],
      ["2024-01-09", 160],
      ["2024-01-10", 151],
    ]);
    expect(values.get("pageviews")!.get("2024-01-09")).toBe(80);
    expect(values.get("dau")!.get("2024-01-10")).toBe(10);
    expect(values.get("wau")!.get("2024-01-08")).toBe(50);
    expect(values.get("mau")!.get("2024-01-10")).toBe(102);
    // Days outside the window are left out.
    expect([
      ...trendValues(
        fixture("trends-response.json"),
        "2024-01-09",
        "2024-01-09",
      )
        .get("events")!
        .keys(),
    ]).toEqual(["2024-01-09"]);
  });

  it("refuses a trends answer with series missing or out of line", () => {
    const recorded = fixture("trends-response.json") as {
      results: Array<Record<string, unknown>>;
    };
    expect(() =>
      trendValues(
        { ...recorded, results: recorded.results.slice(0, 4) },
        "2024-01-08",
        "2024-01-10",
      ),
    ).toThrow(PostHogApiError);
    expect(() =>
      trendValues(
        {
          ...recorded,
          results: recorded.results.map((series) => ({
            ...series,
            data: [1],
          })),
        },
        "2024-01-08",
        "2024-01-10",
      ),
    ).toThrow(/line up/);
    expect(() =>
      trendValues(
        { ...recorded, query_status: { complete: false } },
        "2024-01-08",
        "2024-01-10",
      ),
    ).toThrow(/still running/);
  });

  it("reads the recorded top events shape, and refuses a cut answer", () => {
    expect(topEventRows(fixture("hogql-top-events.json"))).toHaveLength(5);
    expect(() =>
      topEventRows({
        results: Array.from({ length: 1_000 }, () => ["2024-01-09", "x", 1]),
      }),
    ).toThrow(/cut off/);
    expect(() => topEventRows({ results: [], hasMore: true })).toThrow(
      /cut off/,
    );
  });

  it("reads a saved trends insight with a breakdown", () => {
    const page = insightsSchema.parse(fixture("insights-page.json"));
    const result = insightRows(
      page.results[0]!,
      "Signups by plan",
      "1000",
      NOW,
    );
    expect(result.status).toBe("ok");
    expect(result.interval).toBe("week");
    expect(result.rows.map((row) => row.values)).toEqual([
      expect.objectContaining({
        insight_id: "AbCd1234",
        series_index: 0,
        series_label: "signed_up - pro",
        breakdown_value: "pro",
        bucket: "2024-01-01",
        day: "2024-01-01",
        value: 3,
        computed_at: "2024-01-10T09:30:00.123Z",
        as_of: NOW,
      }),
      expect.objectContaining({ series_index: 0, bucket: "2024-01-08" }),
      expect.objectContaining({ series_index: 1, breakdown_value: "free" }),
      expect.objectContaining({ series_index: 1, value: 18 }),
    ]);
  });

  it("classifies PostHog's recorded errors", () => {
    expect(apiError(401, fixture("error-401.json")).kind).toBe("auth");
    const scope = apiError(403, fixture("error-403-scope.json"));
    expect(scope.kind).toBe("scope");
    expect(scope.scope).toBe("query:read");
    expect(apiError(403, { detail: "You don't have access." }).kind).toBe(
      "forbidden",
    );
    expect(apiError(404, { detail: "Not found." }).kind).toBe("not_found");
  });

  it("validates listing pages", () => {
    expect(nextOffset({ count: 3, next: null, results: [1, 2, 3] }, 0)).toBe(
      null,
    );
    expect(
      nextOffset(
        {
          count: 3,
          next: "http://x.test/a/?limit=2&offset=2",
          results: [1, 2],
        },
        0,
      ),
    ).toBe(2);
    // More entries than seen, but no next page.
    expect(() =>
      nextOffset({ count: 5, next: null, results: [1, 2] }, 0),
    ).toThrow(/no next page/);
    // A next page that does not move on, or has no offset.
    expect(() =>
      nextOffset({ next: "https://x.test/a/?offset=0", results: [1] }, 0),
    ).toThrow(/does not continue/);
    expect(() =>
      nextOffset({ next: "https://x.test/a/?cursor=abc", results: [1] }, 0),
    ).toThrow(/does not continue/);
    expect(() =>
      nextOffset({ next: "https://x.test/a/?offset=5", results: [] }, 0),
    ).toThrow(/does not continue/);
  });

  it("never sends anything but a read", () => {
    expect(() => assertReadOnly("GET", "/api/organizations/")).not.toThrow();
    expect(() =>
      assertReadOnly("GET", "/api/projects/1/insights/"),
    ).not.toThrow();
    expect(() =>
      assertReadOnly("GET", "/api/projects/1/feature_flags/"),
    ).toThrow();
    expect(() =>
      assertReadOnly("POST", "/api/projects/1/insights/", {
        query: { kind: "TrendsQuery" },
      }),
    ).toThrow();
    expect(() =>
      assertReadOnly("POST", "/api/projects/1/query/", {
        query: { kind: "HogQLQuery", query: "DELETE FROM events" },
      }),
    ).toThrow();
    expect(() =>
      assertReadOnly("POST", "/api/projects/1/query/", {
        query: { kind: "HogQLQuery", query: "SELECT 1; DROP TABLE x" },
      }),
    ).toThrow();
    expect(() =>
      assertReadOnly(
        "POST",
        "/api/projects/1/query/",
        topEventsBody("2024-01-01", "2024-01-02"),
      ),
    ).not.toThrow();
  });

  it("reads insight links and pairs from the configuration", () => {
    const parsed = insightsOf(
      context({
        insights:
          "https://us.posthog.com/project/12345/insights/AbCd1234, 12345/Xy99,\nhttps://eu.posthog.com/project/7/insights/Qq11/edit  12345/AbCd1234",
      }),
    );
    expect(parsed).toEqual({
      insights: [
        { project: "12345", shortId: "AbCd1234" },
        { project: "12345", shortId: "Xy99" },
        { project: "7", shortId: "Qq11" },
      ],
      invalid: 0,
    });
    expect(insightsOf(context({ insights: "not-an-insight" })).invalid).toBe(1);
  });
});

describe("PostHog check", () => {
  it("accepts a key on PostHog Cloud US, EU and a self-hosted host", async () => {
    for (const [config, host] of [
      [{}, "us.posthog.com"],
      [{ host: "us.posthog.com" }, "us.posthog.com"],
      [{ host: "eu.posthog.com" }, "eu.posthog.com"],
      [{ host: "https://posthog.example.com/" }, "posthog.example.com"],
    ] as const) {
      const posthog = fake({ host });
      await expect(
        connector().check(context(config), posthog.runtime),
      ).resolves.toEqual({ ok: true });
      expect(new Set(posthog.requests.map((request) => request.host))).toEqual(
        new Set([host]),
      );
      // The listing, one project, and the constant query.
      expect(posthog.requests.map((request) => request.path)).toEqual([
        "/api/organizations/",
        `/api/organizations/${ORG.id}/projects/`,
        "/api/projects/1000/query/",
      ]);
    }
  });

  it("names a wrong key without echoing it", async () => {
    const result = await connector().check(
      context({}, { credentials: { token: "phx_wrong" } }),
      fake().runtime,
    );
    expect(result).toEqual({
      ok: false,
      message: KEY_REJECTED_MESSAGE,
      code: KEY_REJECTED_CODE,
    });
    expect(JSON.stringify(result)).not.toContain("phx_wrong");
  });

  it("names a missing scope", async () => {
    const posthog = fake({
      intercept: (request) =>
        request.path.endsWith("/query/") ? scopeMissing() : undefined,
    });
    expect(await connector().check(context(), posthog.runtime)).toMatchObject({
      ok: false,
      code: SCOPE_MISSING_CODE,
    });
  });

  it("refuses an invalid self-hosted host before sending anything", async () => {
    for (const host of [
      "localhost",
      "http://posthog.example.com",
      "10.0.0.8",
      "posthog.example.com:8443",
    ]) {
      const posthog = fake();
      expect(
        await connector().check(context({ host }), posthog.runtime),
      ).toMatchObject({ ok: false, code: HOST_INVALID_CODE });
      expect(posthog.requests).toEqual([]);
    }
  });

  it("refuses insights it cannot read, and checks the insight scope", async () => {
    expect(
      await connector().check(
        context({ insights: "https://example.com/dashboard/1" }),
        fake().runtime,
      ),
    ).toMatchObject({ ok: false, code: INSIGHTS_INVALID_CODE });
    const posthog = fake({
      intercept: (request) =>
        request.path.endsWith("/insights/") ? scopeMissing() : undefined,
    });
    expect(
      await connector().check(
        context({ insights: "1000/AbCd" }),
        posthog.runtime,
      ),
    ).toMatchObject({ ok: false, code: SCOPE_MISSING_CODE });
  });

  it("asks for a key when none is stored", async () => {
    expect(
      await connector().check(context({}, { credentials: {} }), fake().runtime),
    ).toMatchObject({ ok: false });
  });
});

describe("PostHog discover", () => {
  it("lists every project of every organization, page by page", async () => {
    const second = { id: "0190b4c2-7d1e-7000-8000-000000000002", name: "Two" };
    const posthog = fake({
      orgs: [ORG, second],
      maxPage: 2,
      nextScheme: "http",
      projects: [
        ...fakeProjects(5),
        { id: 2000, name: "Other org", org: second.id },
      ],
    });
    const resources = await connector().discover(context(), posthog.runtime);
    expect(resources.map((resource) => resource.id)).toEqual([
      "1000",
      "1001",
      "1002",
      "1003",
      "1004",
      "2000",
    ]);
    expect(resources[5]).toEqual({
      id: "2000",
      name: "Other org",
      kind: "project",
      metadata: { organizationId: second.id },
    });
    // A self-hosted proxy's http next URL does not leave https.
    expect(
      posthog.requests.every((request) => request.host === "us.posthog.com"),
    ).toBe(true);
  });

  it("refuses a listing that says there is more without a next page", async () => {
    const posthog = fake({
      intercept: (request) =>
        request.path === "/api/organizations/"
          ? answer(200, { count: 3, next: null, results: [ORG] })
          : undefined,
    });
    await expect(
      connector().discover(context(), posthog.runtime),
    ).rejects.toThrow(/no next page/);
  });

  it("refuses a revoked key with the check's reason code", async () => {
    const error = await connector()
      .discover(
        context({}, { credentials: { token: "phx_revoked" } }),
        fake().runtime,
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectorError);
    expect((error as ConnectorError).code).toBe(KEY_REJECTED_CODE);
  });
});

describe("PostHog sync", () => {
  it("reads every daily number, the top events and freshness into valid pages", async () => {
    const posthog = fake({ projects: fakeProjects(2) });
    const run = await syncAll(posthog.runtime);
    const days = Array.from({ length: 10 }, (_, index) =>
      new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10),
    );
    expect(valuesOf(run, METRICS.events, "1000")).toEqual(
      days.map((day) => [day, 100 + Number(day.slice(8))]),
    );
    expect(valuesOf(run, METRICS.pageviews, "1001")).toEqual(
      days.map((day) => [day, Math.floor((100 + Number(day.slice(8))) / 2)]),
    );
    for (const [metric, value] of [
      [METRICS.dau, 10],
      [METRICS.wau, 50],
      [METRICS.mau, 100],
    ] as const) {
      expect(valuesOf(run, metric, "1001")).toEqual(
        days.map((day) => [day, value]),
      );
    }
    const top = rowsOf(run.datasetPages, "top_events");
    expect(top).toHaveLength(2 * 10 * 10);
    expect(top[0]).toEqual({
      project_id: "1000",
      project_name: "Project 0",
      day: "2024-01-01",
      rank: 1,
      event: "$pageview",
      events: 100,
    });
    expect(run.last.receivedDatasets).toEqual([
      "top_events",
      "insights",
      "insight_results",
    ]);
    for (const project of ["1000", "1001"]) {
      expect(freshnessEntry(run.last, ANALYTICS_STREAM, project)).toEqual({
        stream: ANALYTICS_STREAM,
        resource: project,
        dataThrough: "2024-01-09",
        expectedFrom: "2024-01-11T00:00:00.000Z",
        nextExpectedAt: "2024-01-11T01:00:00.000Z",
      });
    }
    expect(freshnessEntry(run.last, INSIGHTS_STREAM)).toEqual({
      stream: INSIGHTS_STREAM,
    });
    expect(run.last.nextFrom).toBe("2024-01-08T00:00:00.000Z");
    // Only reads, and only the documented hosts and paths.
    for (const request of posthog.requests) {
      expect(() =>
        assertReadOnly(
          request.method as "GET" | "POST",
          request.path,
          request.body ?? undefined,
        ),
      ).not.toThrow();
    }
  });

  it("asks PostHog for UTC days, a month at a time", async () => {
    const posthog = fake();
    await syncAll(posthog.runtime, {
      mode: "backfill",
      from: "2023-11-01T00:00:00.000Z",
      to: NOW,
    });
    const ranges = posthog.requests
      .filter(
        (request) =>
          (request.body?.query as { kind?: string } | undefined)?.kind ===
          "TrendsQuery",
      )
      .map((request) => {
        const query = request.body!.query as {
          dateRange: { date_from: string; date_to: string };
          modifiers: Record<string, unknown>;
        };
        expect(query.modifiers).toEqual({ convertToProjectTimezone: false });
        return [query.dateRange.date_from, query.dateRange.date_to];
      });
    expect(ranges).toEqual([
      ["2023-11-01", "2023-12-01"],
      ["2023-12-02", "2024-01-01"],
      ["2024-01-02", "2024-01-10"],
    ]);
  });

  it("reads only the selected projects", async () => {
    const posthog = fake({ projects: fakeProjects(3) });
    const run = await syncAll(posthog.runtime, {
      ...WINDOW,
      resources: ["1001"],
    });
    expect(
      new Set(run.observations.map((entry) => entry.dimensions.resource)),
    ).toEqual(new Set(["1001"]));
    expect(
      posthog.requests.filter((request) => request.path.includes("/1000/")),
    ).toEqual([]);
    expect(run.last.freshness?.map((entry) => entry.resource)).toEqual([
      "1001",
      undefined,
    ]);
  });

  it("reads PostHog Cloud EU and a self-hosted host only there", async () => {
    for (const [config, host] of [
      [{ host: "eu.posthog.com" }, "eu.posthog.com"],
      [{ host: "posthog.example.com" }, "posthog.example.com"],
    ] as const) {
      const posthog = fake({ host });
      const run = await syncAll(posthog.runtime, WINDOW, context(config));
      expect(valuesOf(run, METRICS.events, "1000")).toHaveLength(10);
      expect(new Set(posthog.requests.map((request) => request.host))).toEqual(
        new Set([host]),
      );
    }
  });

  it("completes an empty project with zeros and no top events", async () => {
    const posthog = fake({ projects: [{ id: 1000, events: () => 0 }] });
    const run = await syncAll(posthog.runtime);
    expect(
      valuesOf(run, METRICS.events, "1000").every(([, v]) => v === 0),
    ).toBe(true);
    // Every rank of every day is a tombstone: nothing stays stored.
    const top = run.datasetPages
      .filter((page) => page.datasetKey === "top_events")
      .flatMap((page) => page.records);
    expect(top.every((record) => record.deleted)).toBe(true);
    expect(top).toHaveLength(10 * 10);
    expect(
      freshnessEntry(run.last, ANALYTICS_STREAM, "1000")?.dataThrough,
    ).toBe("2024-01-09");
  });

  it("completes a key that sees no organization or project", async () => {
    const run = await syncAll(fake({ orgs: [] }).runtime);
    expect(run.observations).toEqual([]);
    expect(run.last.receivedDatasets).toContain("top_events");
    expect(freshnessEntry(run.last, INSIGHTS_STREAM)).toBeDefined();
  });

  it("goes on without a project PostHog refuses, and reports it stale", async () => {
    const posthog = fake({
      projects: [
        { id: 1000, refused: 403 },
        { id: 1001 },
        { id: 1002, refused: 404 },
      ],
    });
    const run = await syncAll(posthog.runtime);
    expect(valuesOf(run, METRICS.events, "1001")).toHaveLength(10);
    expect(valuesOf(run, METRICS.events, "1000")).toEqual([]);
    expect(freshnessEntry(run.last, ANALYTICS_STREAM, "1000")).toBeUndefined();
    expect(freshnessEntry(run.last, ANALYTICS_STREAM, "1001")).toBeDefined();
    expect(freshnessEntry(run.last, ANALYTICS_STREAM, "1002")).toBeUndefined();
  });

  it("skips a project whose PostHog refuses the query, without stopping the others", async () => {
    const posthog = fake({
      projects: fakeProjects(2),
      intercept: (request) =>
        request.path === "/api/projects/1000/query/" &&
        (request.body?.query as { kind?: string }).kind === "HogQLQuery"
          ? answer(400, {
              type: "validation_error",
              code: "invalid_input",
              detail: "Syntax error",
            })
          : undefined,
    });
    const run = await syncAll(posthog.runtime);
    expect(freshnessEntry(run.last, ANALYTICS_STREAM, "1000")).toBeUndefined();
    expect(freshnessEntry(run.last, ANALYTICS_STREAM, "1001")).toBeDefined();
    expect(valuesOf(run, METRICS.events, "1001")).toHaveLength(10);
  });

  it("refuses a revoked key and a missing scope with the check's reason codes", async () => {
    const revoked = await connector()
      .sync(
        context({}, { credentials: { token: "phx_revoked" } }),
        WINDOW,
        fake().runtime,
      )
      .catch((caught: unknown) => caught);
    expect((revoked as ConnectorError).code).toBe(KEY_REJECTED_CODE);
    expect((revoked as Error).message).not.toContain("phx_revoked");

    // A scope refused after other steps succeeded still fails the page.
    const posthog = fake({
      intercept: (request) =>
        request.path.endsWith("/query/") ? scopeMissing() : undefined,
    });
    const scope = await connector()
      .sync(context(), WINDOW, posthog.runtime)
      .catch((caught: unknown) => caught);
    expect(scope).toBeInstanceOf(ConnectorError);
    expect((scope as ConnectorError).code).toBe(SCOPE_MISSING_CODE);
  });

  it("hands a later rate-limit reset to the host, as a rate limit", async () => {
    const posthog = fake({
      intercept: (request) =>
        request.path === "/api/organizations/"
          ? rateLimited("1800")
          : undefined,
    });
    const error = await connector()
      .sync(context(), WINDOW, posthog.runtime)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).retryAt).toBe(
      "2024-01-10T12:30:00.000Z",
    );
  });

  it("keeps a page's progress when the rate limit hits a later step", async () => {
    let limited = true;
    const posthog = fake({
      intercept: (request) =>
        limited && request.path.endsWith("/query/")
          ? rateLimited("600")
          : undefined,
    });
    const first = await connector().sync(context(), WINDOW, posthog.runtime);
    expectHostAccepts(first);
    expect(first.done).toBe(false);
    // The listing is kept, and so is the reset: the next page hands it to
    // the host before it sends anything (#901 item 1).
    const before = posthog.requests.length;
    const second = await connector()
      .sync(
        context(),
        { ...WINDOW, cursor: first.nextCursor! },
        posthog.runtime,
      )
      .catch((caught: unknown) => caught);
    expect(second).toBeInstanceOf(RateLimitedError);
    expect((second as RateLimitedError).retryAt).toBe(
      "2024-01-10T12:10:00.000Z",
    );
    expect(posthog.requests.slice(before)).toEqual([]);
    // After the reset the next page starts with the query.
    limited = false;
    const rest = await connector(() => Date.parse(NOW) + 600_000).sync(
      context(),
      { ...WINDOW, cursor: first.nextCursor! },
      posthog.runtime,
    );
    expect(posthog.requests[before]!.path).toBe("/api/projects/1000/query/");
    expect(rest.observations.length).toBeGreaterThan(0);
  });

  it("waits for a near rate-limit reset and server errors, then goes on", async () => {
    let failures = 0;
    const posthog = fake({
      intercept: () => {
        failures += 1;
        if (failures === 1) return rateLimited("2");
        if (failures === 2) return answer(502, "<html>bad gateway</html>");
        return undefined;
      },
    });
    const run = await syncAll(posthog.runtime);
    expect(valuesOf(run, METRICS.events, "1000")).toHaveLength(10);
  });

  it("bounds the requests of every page", async () => {
    const posthog = fake({ projects: fakeProjects(4) });
    let counted = 0;
    const counting: ConnectorRuntime = {
      ...posthog.runtime,
      fetch: async (url, init) => {
        counted += 1;
        return posthog.runtime.fetch(url, init);
      },
    };
    const pages: number[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 100; guard += 1) {
      counted = 0;
      const page = await connector().sync(
        context(),
        {
          mode: "backfill",
          from: "2023-10-01T00:00:00.000Z",
          to: NOW,
          ...(cursor ? { cursor } : {}),
        },
        counting,
      );
      pages.push(counted);
      if (page.done) break;
      cursor = page.nextCursor;
    }
    expect(Math.max(...pages)).toBeLessThanOrEqual(MAX_REQUESTS_PER_PAGE);
  });

  it("stops starting steps when a page's time is used up", async () => {
    let ms = Date.parse(NOW);
    const slow = () => ms;
    const posthog = fake({ projects: fakeProjects(2) });
    const timed: ConnectorRuntime = {
      ...posthog.runtime,
      fetch: async (url, init) => {
        ms += 15_000; // every request takes 15 seconds
        return posthog.runtime.fetch(url, init);
      },
    };
    const before = posthog.requests.length;
    const page = await connector(slow).sync(context(), WINDOW, timed);
    expect(page.done).toBe(false);
    expect(posthog.requests.length - before).toBe(2);
  });

  it("continues a failed page from its checkpoint with the same result", async () => {
    const whole = await syncAll(fake({ projects: fakeProjects(3) }).runtime);
    for (const failAt of [1, 3, 4, 7]) {
      const posthog = fake({ projects: fakeProjects(3) });
      let calls = 0;
      let failed = 0;
      const failing: ConnectorRuntime = {
        ...posthog.runtime,
        fetch: async (url, init) => {
          calls += 1;
          if (calls === failAt) {
            failed += 1;
            throw new Error("connection reset");
          }
          return posthog.runtime.fetch(url, init);
        },
      };
      const pages: SyncResult[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 100; guard += 1) {
        const page = await connector()
          .sync(
            context(),
            { ...WINDOW, ...(cursor ? { cursor } : {}) },
            failing,
          )
          .catch(() => null);
        if (page === null) continue; // the host retries the same checkpoint
        expectHostAccepts(page);
        pages.push(page);
        if (page.done) break;
        cursor = page.nextCursor;
      }
      expect(failed).toBe(1);
      expect(latest(pages.flatMap((page) => page.observations))).toEqual(
        latest(whole.observations),
      );
      expect(
        rowsOf(
          pages.flatMap((page) => page.datasetPages ?? []),
          "top_events",
        ),
      ).toEqual(rowsOf(whole.datasetPages, "top_events"));
      // Nothing read twice: the failed request is the only one repeated.
      expect(posthog.requests.length).toBe(await countRequests(3));
    }
  });

  it("starts over when the key, the host or the selection changed since the checkpoint", async () => {
    const posthog = fake({ projects: fakeProjects(2) });
    const first = await connector().sync(context(), WINDOW, posthog.runtime);
    expect(first.done).toBe(false);
    const restarts: Array<[ConnectionContext, SyncRequest]> = [
      [context({}, { credentials: { token: `${FAKE_KEY}-rotated` } }), WINDOW],
      [context({ host: "eu.posthog.com" }), WINDOW],
      [context(), { ...WINDOW, resources: ["1001"] }],
      [context({ insights: "1000/AbCd" }), WINDOW],
    ];
    for (const [ctx, request] of restarts) {
      const recorder = fake({
        projects: fakeProjects(2),
        host: String(ctx.config.host ?? "us.posthog.com"),
        key: String(ctx.credentials.token),
      });
      await connector().sync(
        ctx,
        { ...request, cursor: first.nextCursor! },
        recorder.runtime,
      );
      expect(recorder.requests[0]!.path).toBe("/api/organizations/");
    }
    // The same scope continues.
    const recorder = fake({ projects: fakeProjects(2) });
    await connector().sync(
      context(),
      { ...WINDOW, cursor: first.nextCursor! },
      recorder.runtime,
    );
    expect(recorder.requests[0]!.path).not.toBe("/api/organizations/");
    expect(first.nextCursor).not.toContain(FAKE_KEY);
    expect(
      Buffer.from(first.nextCursor!.split(":")[1]!, "base64url").toString(),
    ).not.toContain(FAKE_KEY);
  });

  it("does not hand a refused project's window to the next project", async () => {
    let refuse = false;
    const posthog = fake({
      projects: fakeProjects(2),
      intercept: (request) => {
        if (request.path !== "/api/projects/1000/query/") return undefined;
        const query = request.body?.query as {
          dateRange?: { date_from: string };
        };
        // The first project's second window is refused.
        if (query.dateRange?.date_from === "2023-12-02") refuse = true;
        return refuse
          ? answer(404, { type: "invalid_request", detail: "Not found." })
          : undefined;
      },
    });
    const run = await syncAll(posthog.runtime, {
      mode: "backfill",
      from: "2023-11-01T00:00:00.000Z",
      to: NOW,
    });
    const second = posthog.requests
      .filter(
        (request) =>
          request.path === "/api/projects/1001/query/" &&
          (request.body?.query as { kind: string }).kind === "TrendsQuery",
      )
      .map(
        (request) =>
          (request.body!.query as { dateRange: { date_from: string } })
            .dateRange.date_from,
      );
    expect(second).toEqual(["2023-11-01", "2023-12-02", "2024-01-02"]);
    // What the first window of the refused project read stays.
    expect(valuesOf(run, METRICS.events, "1000")).toHaveLength(31);
    expect(freshnessEntry(run.last, ANALYTICS_STREAM, "1000")).toBeUndefined();
    expect(freshnessEntry(run.last, ANALYTICS_STREAM, "1001")).toBeDefined();
  });

  it("reports the days as of the run's start when it crosses midnight", async () => {
    let ms = Date.parse("2024-01-10T23:59:00.000Z");
    const posthog = fake({ projects: fakeProjects(2) });
    const pages: SyncResult[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard += 1) {
      const page = await connector(() => ms).sync(
        context(),
        {
          mode: "incremental",
          from: "2024-01-08T00:00:00.000Z",
          to: "2024-01-10T23:59:00.000Z",
          ...(cursor ? { cursor } : {}),
        },
        posthog.runtime,
      );
      expectHostAccepts(page);
      pages.push(page);
      ms += 60 * 60 * 1000; // the next page runs an hour later: the 11th
      if (page.done) break;
      cursor = page.nextCursor;
    }
    const last = pages.at(-1)!;
    expect(freshnessEntry(last, ANALYTICS_STREAM, "1001")?.dataThrough).toBe(
      "2024-01-09",
    );
    const ends = posthog.requests
      .filter(
        (request) =>
          (request.body?.query as { kind?: string } | undefined)?.kind ===
          "TrendsQuery",
      )
      .map(
        (request) =>
          (request.body!.query as { dateRange: { date_to: string } }).dateRange
            .date_to,
      );
    expect(new Set(ends)).toEqual(new Set(["2024-01-10"]));
  });
});

describe("PostHog saved insights", () => {
  it("reads selected trends insights and says what became of every one", async () => {
    const posthog = fake({
      projects: fakeProjects(2),
      insights: [
        { project: 1000, shortId: "Daily1", name: "Daily signups" },
        {
          project: 1000,
          shortId: "Funnel1",
          query: { kind: "InsightVizNode", source: { kind: "FunnelsQuery" } },
        },
        {
          project: 1000,
          shortId: "Hourly1",
          query: trendsInsightQuery("hour"),
        },
        { project: 1000, shortId: "Gone1", deleted: true },
      ],
    });
    const run = await syncAll(
      posthog.runtime,
      WINDOW,
      context({
        insights:
          "https://us.posthog.com/project/1000/insights/Daily1 1000/Funnel1 1000/Hourly1 1000/Gone1 1000/Missing1 9999/Other1",
      }),
    );
    const results = rowsOf(run.datasetPages, "insight_results");
    expect(results).toHaveLength(7);
    expect(results[0]).toMatchObject({
      project_id: "1000",
      insight_id: "Daily1",
      insight_name: "Daily signups",
      interval: "day",
      bucket: "2024-01-04",
      day: "2024-01-04",
      value: 10,
      as_of: NOW,
    });
    expect(
      rowsOf(run.datasetPages, "insights").map((row) => [
        row.insight_id,
        row.status,
        row.rows,
      ]),
    ).toEqual([
      ["Daily1", "ok", 7],
      ["Funnel1", "unsupported", 0],
      ["Hourly1", "unsupported", 0],
      ["Gone1", "not_found", 0],
      ["Missing1", "not_found", 0],
      ["Other1", "not_selected", 0],
    ]);
    expect(run.last.receivedDatasets).toContain("insight_results");
    expect(freshnessEntry(run.last, INSIGHTS_STREAM)).toBeDefined();
    // The insights are read once each, with their last results.
    const reads = posthog.requests.filter((request) =>
      request.path.endsWith("/insights/"),
    );
    expect(reads.map((request) => request.params.get("short_id"))).toEqual([
      "Daily1",
      "Funnel1",
      "Hourly1",
      "Gone1",
      "Missing1",
    ]);
    expect(
      reads.every((request) => request.params.get("refresh") === "blocking"),
    ).toBe(true);
  });

  it("keeps the stored results when an insight is not computed or refused", async () => {
    for (const insight of [
      {
        project: 1000,
        shortId: "Slow1",
        result: null,
        queryStatus: { complete: false },
      },
      { project: 1000, shortId: "Denied1", refused: 403 as const },
    ]) {
      const run = await syncAll(
        fake({ insights: [insight] }).runtime,
        WINDOW,
        context({ insights: `1000/${insight.shortId}` }),
      );
      expect(run.last.receivedDatasets).toEqual(["top_events", "insights"]);
      expect(
        run.last.datasetPages?.some(
          (page) => page.datasetKey === "insight_results",
        ),
      ).toBe(false);
      expect(freshnessEntry(run.last, INSIGHTS_STREAM)).toBeUndefined();
      // The daily numbers are fresh all the same.
      expect(freshnessEntry(run.last, ANALYTICS_STREAM, "1000")).toBeDefined();
      expect(rowsOf(run.datasetPages, "insights")[0]?.status).toBe(
        insight.refused ? "denied" : "not_ready",
      );
    }
  });

  it("drains a large insight over several results, and refuses a too large one", async () => {
    const days = Array.from({ length: 365 }, (_, index) =>
      new Date(Date.UTC(2023, 0, 1 + index)).toISOString().slice(0, 10),
    );
    const series = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        action: { order: 0 },
        label: `plan ${index}`,
        breakdown_value: `plan-${index}`,
        data: days.map(() => index),
        days,
      }));
    const posthog = fake({
      insights: [
        { project: 1000, shortId: "Big1", result: series(12) },
        { project: 1000, shortId: "Big2", result: series(10) },
        { project: 1000, shortId: "Huge1", result: series(14) },
      ],
    });
    const run = await syncAll(
      posthog.runtime,
      WINDOW,
      context({ insights: "1000/Big1 1000/Big2 1000/Huge1" }),
    );
    const rows = rowsOf(run.datasetPages, "insight_results");
    expect(rows).toHaveLength((12 + 10) * 365);
    expect(14 * 365).toBeGreaterThan(MAX_INSIGHT_ROWS);
    expect(
      rowsOf(run.datasetPages, "insights").map((row) => row.status),
    ).toEqual(["ok", "ok", "too_large"]);
    expect(run.last.receivedDatasets).toContain("insight_results");
    // One refresh chain across every result.
    const chain = run.datasetPages.filter(
      (page) => page.datasetKey === "insight_results",
    );
    chain.forEach((page, index) => {
      expect(page.previousPageKey).toBe(
        index === 0 ? null : chain[index - 1]!.pageKey,
      );
    });
    expect(new Set(chain.map((page) => page.refreshKey)).size).toBe(1);
    expect(chain.at(-1)!.complete).toBe(true);
  });
});

/** Requests a whole run of `count` default projects sends. */
async function countRequests(count: number): Promise<number> {
  const posthog = fake({ projects: fakeProjects(count) });
  await syncAll(posthog.runtime);
  return posthog.requests.length;
}

describe("review round 1 (#884)", () => {
  it("names a project-scoped key without project IDs, with a reason code", async () => {
    const posthog = fake({ scopedProjects: [1000] });
    expect(await connector().check(context(), posthog.runtime)).toMatchObject({
      ok: false,
      code: "posthog.projects_required",
    });
    const error = await connector()
      .sync(context(), WINDOW, posthog.runtime)
      .catch((caught: unknown) => caught);
    expect((error as ConnectorError).code).toBe("posthog.projects_required");
  });

  it("checks, discovers and syncs a project-scoped key through project endpoints only", async () => {
    const posthog = fake({
      scopedProjects: [1000, 1002],
      projects: fakeProjects(3),
    });
    const ctx = context({ projects: "1000, 1002" });
    expect(await connector().check(ctx, posthog.runtime)).toEqual({
      ok: true,
    });
    expect(
      (await connector().discover(ctx, posthog.runtime)).map(
        (resource) => resource.id,
      ),
    ).toEqual(["1000", "1002"]);
    const run = await syncAll(
      posthog.runtime,
      { ...WINDOW, resources: ["1002"] },
      ctx,
    );
    expect(valuesOf(run, METRICS.events, "1002")).toHaveLength(10);
    expect(valuesOf(run, METRICS.events, "1000")).toEqual([]);
    expect(freshnessEntry(run.last, ANALYTICS_STREAM, "1002")).toBeDefined();
    expect(
      posthog.requests.filter((request) =>
        request.path.startsWith("/api/organizations/"),
      ),
    ).toEqual([]);
  });

  it("refuses project IDs the key cannot read, or that are no IDs", async () => {
    const posthog = fake({ scopedProjects: [1000], projects: fakeProjects(2) });
    for (const projects of ["1001", "1000 abc"]) {
      expect(
        await connector().check(context({ projects }), posthog.runtime),
      ).toMatchObject({ ok: false, code: "posthog.projects_invalid" });
    }
  });

  it("refuses an insight whose rows need more pages than a result holds", async () => {
    const days = Array.from({ length: 450 }, (_, index) =>
      new Date(Date.UTC(2023, 0, 1 + index)).toISOString().slice(0, 10),
    );
    // 10 series × 450 days = 4,500 rows of about 5 KB: 45 byte-bound pages.
    const result = Array.from({ length: 10 }, (_, index) => ({
      action: { order: 0 },
      label: `series ${index}`,
      breakdown_value: `${index}-${"x".repeat(5_000)}`,
      data: days.map(() => 1),
      days,
    }));
    const posthog = fake({
      insights: [{ project: 1000, shortId: "Wide1", result }],
    });
    const run = await syncAll(
      posthog.runtime,
      WINDOW,
      context({ insights: "1000/Wide1" }),
    );
    expect(rowsOf(run.datasetPages, "insight_results")).toEqual([]);
    expect(rowsOf(run.datasetPages, "insights")[0]).toMatchObject({
      insight_id: "Wide1",
      status: "too_large",
    });
  });

  it("deletes the ranks a day no longer has when it is read again", async () => {
    let names = 10;
    const posthog = fake({
      projects: [{ id: 1000, eventNames: () => names }],
    });
    const incremental: SyncRequest = {
      mode: "incremental",
      from: "2024-01-09T00:00:00.000Z",
      to: NOW,
    };
    await syncAll(posthog.runtime, incremental);
    names = 3;
    const again = await syncAll(posthog.runtime, incremental);
    const records = again.datasetPages
      .filter((page) => page.datasetKey === "top_events")
      .flatMap((page) => page.records);
    expect(
      records
        .filter((record) => !record.deleted)
        .map((record) => [record.values.day, record.values.rank]),
    ).toEqual([
      ["2024-01-09", 1],
      ["2024-01-09", 2],
      ["2024-01-09", 3],
      ["2024-01-10", 1],
      ["2024-01-10", 2],
      ["2024-01-10", 3],
    ]);
    expect(
      records.filter((record) => record.deleted).map((record) => record.values),
    ).toEqual(
      ["2024-01-09", "2024-01-10"].flatMap((day) =>
        [4, 5, 6, 7, 8, 9, 10].map((rank) => ({
          project_id: "1000",
          day,
          rank,
        })),
      ),
    );
  });
});

describe("review round 2 (#884)", () => {
  it("passes the check when the first project refuses its query but another answers", async () => {
    const posthog = fake({
      projects: [{ id: 1000, refused: 403 }, { id: 1001 }],
    });
    expect(await connector().check(context(), posthog.runtime)).toEqual({
      ok: true,
    });
    // A missing scope still fails, whichever project answers it.
    const scoped = fake({
      projects: [{ id: 1000, refused: 403 }, { id: 1001 }],
      intercept: (request) =>
        request.path === "/api/projects/1001/query/"
          ? scopeMissing()
          : undefined,
    });
    expect(await connector().check(context(), scoped.runtime)).toMatchObject({
      ok: false,
      code: SCOPE_MISSING_CODE,
    });
  });

  it("refuses Project IDs that hold no ID", async () => {
    const posthog = fake({ scopedProjects: [1000] });
    for (const projects of [",,,", " , "]) {
      expect(
        await connector().check(context({ projects }), posthog.runtime),
      ).toMatchObject({ ok: false, code: "posthog.projects_invalid" });
    }
    expect(posthog.requests).toEqual([]);
  });

  it("probes only a few named projects in the check, and reports the others in the sync", async () => {
    const ids = Array.from({ length: 50 }, (_, index) => 1000 + index);
    const posthog = fake({
      scopedProjects: ids.slice(0, 49),
      projects: ids.map((id) => ({ id })),
    });
    const ctx = context({ projects: ids.join(" ") });
    expect(await connector().check(ctx, posthog.runtime)).toEqual({ ok: true });
    expect(posthog.requests.length).toBeLessThanOrEqual(3);
    const warnings: Array<Record<string, unknown>> = [];
    const logging: ConnectorRuntime = {
      ...posthog.runtime,
      log: {
        debug: () => {},
        info: () => {},
        warn: (_message, fields) => warnings.push({ ...fields }),
        error: () => {},
      },
    };
    const run = await syncAll(
      logging,
      { mode: "incremental", from: "2024-01-09T00:00:00.000Z", to: NOW },
      ctx,
    );
    expect(freshnessEntry(run.last, ANALYTICS_STREAM, "1048")).toBeDefined();
    expect(freshnessEntry(run.last, ANALYTICS_STREAM, "1049")).toBeUndefined();
    expect(warnings).toContainEqual(
      expect.objectContaining({ project: "1049", status: 403 }),
    );
  });

  it("goes past an organization whose projects become unreadable", async () => {
    const second = { id: "0190b4c2-7d1e-7000-8000-000000000002", name: "Two" };
    const posthog = fake({
      orgs: [second, ORG],
      projects: [{ id: 1000 }, { id: 2000, org: second.id }],
      intercept: (request) =>
        request.path === `/api/organizations/${second.id}/projects/`
          ? answer(403, { detail: "You do not have access." })
          : undefined,
    });
    const run = await syncAll(posthog.runtime);
    expect(valuesOf(run, METRICS.events, "1000")).toHaveLength(10);
    expect(freshnessEntry(run.last, ANALYTICS_STREAM, "1000")).toBeDefined();
  });

  it("refuses an insight with a record above the per-record limit", async () => {
    const posthog = fake({
      insights: [
        {
          project: 1000,
          shortId: "Huge1",
          result: [
            {
              action: { order: 0 },
              label: "x".repeat(70_000),
              data: [1],
              days: ["2024-01-10"],
            },
          ],
        },
      ],
    });
    const run = await syncAll(
      posthog.runtime,
      WINDOW,
      context({ insights: "1000/Huge1" }),
    );
    expect(rowsOf(run.datasetPages, "insights")[0]).toMatchObject({
      status: "too_large",
    });
    expect(rowsOf(run.datasetPages, "insight_results")).toEqual([]);
  });

  it("never copies PostHog's error text into its errors", async () => {
    const echo = `${FAKE_KEY} secret-detail`;
    for (const status of [400, 403, 404, 418]) {
      const error = apiError(status, { detail: echo });
      expect(error.message).not.toContain("secret-detail");
      expect(error.message).not.toContain(FAKE_KEY);
    }
    const posthog = fake({
      intercept: (request) =>
        request.path.endsWith("/query/")
          ? answer(418, { detail: echo })
          : undefined,
    });
    const error = await connector()
      .sync(context(), WINDOW, posthog.runtime)
      .catch((caught: unknown) => caught);
    expect(String((error as Error).message)).not.toContain("secret-detail");
  });
});

describe("review follow-ups (#888)", () => {
  const OTHER = { id: "0190b4c2-7d1e-7000-8000-000000000002", name: "Two" };
  /** Organization OTHER's projects are refused (403). */
  function refusedOrg(options: FakePostHogOptions = {}) {
    return fake({
      orgs: [OTHER, ORG],
      projects: [{ id: 1000 }, { id: 2000, org: OTHER.id }],
      insights: [
        { project: 1000, shortId: "Ok1" },
        { project: 2000, shortId: "Two1" },
      ],
      intercept: (request) =>
        request.path === `/api/organizations/${OTHER.id}/projects/`
          ? answer(403, { detail: "You do not have access." })
          : undefined,
      ...options,
    });
  }

  it("1. leaves the insight snapshot incomplete when an organization was skipped", async () => {
    const posthog = refusedOrg();
    const run = await syncAll(
      posthog.runtime,
      WINDOW,
      context({ insights: "1000/Ok1 2000/Two1" }),
    );
    expect(rowsOf(run.datasetPages, "insights")).toEqual([
      expect.objectContaining({ insight_id: "Ok1", status: "ok" }),
      expect.objectContaining({ insight_id: "Two1", status: "denied" }),
    ]);
    // The stored results stay: no complete page, no insights freshness.
    expect(run.last.receivedDatasets).not.toContain("insight_results");
    expect(freshnessEntry(run.last, INSIGHTS_STREAM)).toBeUndefined();

    // An insight the selection leaves out is excluded, not unread.
    const selected = await syncAll(
      refusedOrg().runtime,
      { ...WINDOW, resources: ["1000"] },
      context({ insights: "1000/Ok1 2000/Two1" }),
    );
    expect(rowsOf(selected.datasetPages, "insights")).toEqual([
      expect.objectContaining({ insight_id: "Ok1", status: "ok" }),
      expect.objectContaining({ insight_id: "Two1", status: "not_selected" }),
    ]);
    expect(selected.last.receivedDatasets).toContain("insight_results");
  });

  it("2. discovers the readable projects past a refused organization", async () => {
    const resources = await connector().discover(
      context(),
      refusedOrg().runtime,
    );
    expect(resources.map((resource) => resource.id)).toEqual(["1000"]);
    // A wrong key or a missing scope still fails discovery.
    const scoped = refusedOrg({
      intercept: (request) =>
        request.path.startsWith("/api/organizations/") &&
        request.path.endsWith("/projects/")
          ? scopeMissing()
          : undefined,
    });
    const error = await connector()
      .discover(context(), scoped.runtime)
      .catch((caught: unknown) => caught);
    expect((error as ConnectorError).code).toBe(SCOPE_MISSING_CODE);
  });

  it("3. probes the saved selection of named projects, not the others", async () => {
    const posthog = fake({
      scopedProjects: [1001],
      projects: [{ id: 1000 }, { id: 1001 }],
    });
    const ctx = context({
      projects: "1000, 1001",
      resourceSelection: ["1001"],
    });
    expect(await connector().check(ctx, posthog.runtime)).toEqual({
      ok: true,
    });
    expect(posthog.requests.map((request) => request.path)).toEqual([
      "/api/projects/1001/query/",
    ]);
    // A selected project the key lost still fails the check.
    const lost = fake({
      scopedProjects: [1000],
      projects: [{ id: 1000 }, { id: 1001 }],
    });
    expect(await connector().check(ctx, lost.runtime)).toMatchObject({
      ok: false,
      code: "posthog.projects_invalid",
    });
  });

  it("3. checks the Project IDs when the stored selection names none of them (#888 review)", async () => {
    // Project IDs changed from 1000 to 2000, which the key cannot read;
    // the selection still names 1000.
    const posthog = fake({
      scopedProjects: [1000],
      projects: [{ id: 1000 }, { id: 2000 }],
    });
    expect(
      await connector().check(
        context({ projects: "2000", resourceSelection: ["1000"] }),
        posthog.runtime,
      ),
    ).toMatchObject({ ok: false, code: "posthog.projects_invalid" });
    // An explicitly empty selection reads nothing: a refusal is no failure.
    expect(
      await connector().check(
        context({ projects: "2000", resourceSelection: [] }),
        posthog.runtime,
      ),
    ).toEqual({ ok: true });
  });

  it("4. reads a single-number formula insight whose data is null", async () => {
    const posthog = fake({
      insights: [
        {
          project: 1000,
          shortId: "Formula1",
          result: [
            {
              action: null,
              label: "Formula (A / B)",
              data: null,
              aggregated_value: 0.42,
            },
          ],
        },
      ],
    });
    const run = await syncAll(
      posthog.runtime,
      WINDOW,
      context({ insights: "1000/Formula1" }),
    );
    expect(rowsOf(run.datasetPages, "insights")[0]).toMatchObject({
      status: "ok",
      rows: 1,
    });
    expect(rowsOf(run.datasetPages, "insight_results")).toEqual([
      expect.objectContaining({ bucket: "total", day: null, value: 0.42 }),
    ]);
  });

  it("5. reads 01000 and 1000 as the same project", async () => {
    expect(
      insightsOf(
        context({
          insights:
            "https://us.posthog.com/project/01000/insights/Ab1 1000/Ab1 0/Cd2",
        }),
      ),
    ).toEqual({
      insights: [
        { project: "1000", shortId: "Ab1" },
        { project: "0", shortId: "Cd2" },
      ],
      invalid: 0,
    });
    const posthog = fake({
      scopedProjects: [1000],
      insights: [{ project: 1000, shortId: "Ab1" }],
    });
    // The first spelling names the project; PostHog's paths get its
    // canonical ID, and it is read once.
    const ctx = context({ projects: "01000, 1000", insights: "1000/Ab1" });
    expect(await connector().check(ctx, posthog.runtime)).toEqual({ ok: true });
    expect(
      (await connector().discover(ctx, posthog.runtime)).map(
        (resource) => resource.id,
      ),
    ).toEqual(["01000"]);
    const run = await syncAll(posthog.runtime, WINDOW, ctx);
    expect(freshnessEntry(run.last, ANALYTICS_STREAM, "01000")).toBeDefined();
    expect(
      new Set(run.observations.map((entry) => entry.dimensions.resource)),
    ).toEqual(new Set(["01000"]));
    expect(rowsOf(run.datasetPages, "insights")).toEqual([
      expect.objectContaining({ project_id: "01000", status: "ok" }),
    ]);
    expect(
      posthog.requests.every((request) => !request.path.includes("/01000/")),
    ).toBe(true);
    expect(
      posthog.requests.filter(
        (request) =>
          request.path.endsWith("/query/") &&
          (request.body?.query as { kind?: string }).kind === "TrendsQuery",
      ),
    ).toHaveLength(1);
  });

  it("5. keeps the resource ID an existing connection stores (#888 review)", async () => {
    // A selection stored as 01000, of a project PostHog lists as 1000.
    const posthog = fake({ projects: [{ id: 1000 }, { id: 1001 }] });
    const stored = context({ resourceSelection: ["01000"] });
    expect(
      (await connector().discover(stored, posthog.runtime)).map(
        (resource) => resource.id,
      ),
    ).toEqual(["01000", "1001"]);
    const run = await syncAll(
      posthog.runtime,
      { ...WINDOW, resources: ["01000"] },
      context({ insights: "1000/Ab1" }),
    );
    expect(
      new Set(run.observations.map((entry) => entry.dimensions.resource)),
    ).toEqual(new Set(["01000"]));
    expect(freshnessEntry(run.last, ANALYTICS_STREAM, "01000")).toBeDefined();
    expect(freshnessEntry(run.last, ANALYTICS_STREAM, "1000")).toBeUndefined();
    expect(
      new Set(
        rowsOf(run.datasetPages, "top_events").map((row) => row.project_id),
      ),
    ).toEqual(new Set(["01000"]));

    // A selection holding both spellings: one project, read once, under
    // the first spelling the selection stores.
    const both = fake({ scopedProjects: [1000] });
    const ctx = context({ projects: "1000" });
    const twice = await syncAll(
      both.runtime,
      { ...WINDOW, resources: ["01000", "1000"] },
      ctx,
    );
    expect(
      new Set(twice.observations.map((entry) => entry.dimensions.resource)),
    ).toEqual(new Set(["01000"]));
    expect(
      both.requests.filter(
        (request) =>
          request.path.endsWith("/query/") &&
          (request.body?.query as { kind?: string }).kind === "TrendsQuery",
      ),
    ).toHaveLength(1);
    expect(
      await connector().check(
        context({ projects: "1000", resourceSelection: ["01000", "1000"] }),
        both.runtime,
      ),
    ).toEqual({ ok: true });
  });
});

describe("pages end before the host's deadline (#888, #901 item 1)", () => {
  /**
   * A clock the fake advances: `durations[n]` (default 1 s) per answer,
   * every wait, and a stalled request's whole time limit.
   */
  function timed(options: {
    durations?: number[];
    stallAt?: number;
    limitedAt?: { request: number; retryAfter: string };
  }) {
    const posthog = fake({ projects: fakeProjects(2) });
    let t = clock();
    let count = 0;
    const timeouts: Array<number | undefined> = [];
    const runtime: ConnectorRuntime = {
      ...posthog.runtime,
      fetch: async (url, init) => {
        count += 1;
        timeouts.push(init?.timeoutMs);
        if (count === options.stallAt) {
          // PostHog never answers: the request ends at its time limit.
          t += init?.timeoutMs ?? 60_000;
          throw Object.assign(new Error("egress timeout"), {
            name: "EgressTimeoutError",
          });
        }
        t += options.durations?.[count - 1] ?? 1_000;
        if (options.limitedAt?.request === count) {
          return rateLimited(options.limitedAt.retryAfter);
        }
        return posthog.runtime.fetch(url, init);
      },
    };
    const started = t;
    const posthogConnector = createPostHogConnector({
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    return {
      runtime,
      connector: posthogConnector,
      timeouts,
      requests: () => count,
      elapsed: () => t - started,
    };
  }

  it("a request that stalls late in a page ends in time to return the checkpoint", async () => {
    // Four answers take 18 s; the fifth step starts inside the budget and
    // its query never answers.
    const {
      runtime,
      connector: posthog,
      elapsed,
      timeouts,
    } = timed({
      durations: [4_500, 4_500, 4_500, 4_500],
      stallAt: 5,
    });
    const page = await posthog.sync(context(), WINDOW, runtime);
    expect(page.done).toBe(false);
    expectHostAccepts(page);
    expect(elapsed()).toBeLessThanOrEqual(45_000);
    for (const timeout of timeouts) {
      expect(timeout).toBeLessThanOrEqual(20_000);
    }
  });

  it("a rate-limit wait that would pass the deadline ends the page with its reset", async () => {
    // The fourth request starts at 18 s, answers at 36 s with a 429 that
    // asks for 9 s: the wait would end at the page's deadline.
    const {
      runtime,
      connector: posthog,
      elapsed,
      requests,
    } = timed({
      durations: [6_000, 6_000, 6_000, 18_000],
      limitedAt: { request: 4, retryAfter: "9" },
    });
    const page = await posthog.sync(context(), WINDOW, runtime);
    expect(page.done).toBe(false);
    expectHostAccepts(page);
    expect(elapsed()).toBeLessThanOrEqual(45_000);
    const sent = requests();
    const error = await posthog
      .sync(context(), { ...WINDOW, cursor: page.nextCursor! }, runtime)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(Date.parse((error as RateLimitedError).retryAt)).toBe(
      clock() + 36_000 + 9_000,
    );
    expect(requests()).toBe(sent);
  });

  it("holds a far-off reset no longer than the host defers a run (#888 review)", async () => {
    // A reset 30 days away, met by the third step.
    const { runtime, connector: posthog } = timed({
      limitedAt: { request: 3, retryAfter: String(30 * 24 * 60 * 60) },
    });
    const page = await posthog.sync(context(), WINDOW, runtime);
    expect(page.done).toBe(false);
    const error = await posthog
      .sync(context(), { ...WINDOW, cursor: page.nextCursor! }, runtime)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(Date.parse((error as RateLimitedError).retryAt)).toBe(
      clock() + 3_000 + MAX_RATE_LIMIT_HOLD_MS,
    );
  });

  it("asks PostHog again under a hold stored before the cap (#914 review)", async () => {
    const {
      runtime,
      connector: posthog,
      requests,
    } = timed({ limitedAt: { request: 3, retryAfter: "3600" } });
    const page = await posthog.sync(context(), WINDOW, runtime);
    expect(page.done).toBe(false);
    // The checkpoint as the uncapped version stored a reset 30 days away.
    const PREFIX = "posthog.v1:";
    const state = JSON.parse(
      Buffer.from(page.nextCursor!.slice(PREFIX.length), "base64url").toString(
        "utf8",
      ),
    ) as Record<string, unknown>;
    state.limitedUntil = clock() + 30 * 24 * 60 * 60 * 1000;
    const sent = requests();
    const next = await posthog.sync(
      context(),
      {
        ...WINDOW,
        cursor:
          PREFIX + Buffer.from(JSON.stringify(state)).toString("base64url"),
      },
      runtime,
    );
    expectHostAccepts(next);
    expect(requests()).toBeGreaterThan(sent);
  });

  it("bounds every request below the host's limit", async () => {
    const { runtime, connector: posthog, timeouts } = timed({});
    await posthog.sync(context(), WINDOW, runtime);
    expect(timeouts.length).toBeGreaterThan(0);
    for (const timeout of timeouts) {
      expect(timeout).toBeGreaterThan(0);
      expect(timeout).toBeLessThanOrEqual(20_000);
    }
  });
});

describe("discovery of a large selection (#914)", () => {
  // The configured projects are named without a request.
  const noClient = {} as PostHogClient;

  it("reports each project under the first spelling the connection stores", async () => {
    expect(
      await listProjects(
        noClient,
        ["1000", "02000", "3000"],
        ["01000", "1000", "2000"],
      ),
    ).toEqual([
      { id: "01000", name: "01000", organizationId: "" },
      { id: "2000", name: "2000", organizationId: "" },
      { id: "3000", name: "3000", organizationId: "" },
    ]);
  });

  it("names 20,000 projects against a 20,000-ID selection without a scan per project", async () => {
    // A scan of the selection per project is 400 million comparisons; an
    // index of it is 40,000 and ends in milliseconds.
    const ids = Array.from({ length: 20_000 }, (_, index) => String(index + 1));
    const started = performance.now();
    const projects = await listProjects(
      noClient,
      ids,
      ids.map((id) => `0${id}`),
    );
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(projects.at(-1)!.id).toBe("020000");
  });
});

describe("insight picker (#891)", () => {
  const options = (config: Record<string, unknown>, resourceId: string) =>
    connector().configOptions!(
      context(config),
      { key: "insights", resourceId },
      posthog.runtime,
    );
  let posthog = fake();

  it("lists a project's saved trends insights from the insight list, none chosen", async () => {
    posthog = fake({
      projects: fakeProjects(2),
      insights: [
        { project: 1000, shortId: "AbCd1234", name: "Signups" },
        { project: 1000, shortId: "EfGh5678", name: "" },
        {
          project: 1000,
          shortId: "Funnel01",
          query: { kind: "InsightVizNode", source: { kind: "FunnelsQuery" } },
        },
        { project: 1000, shortId: "Gone0001", deleted: true },
        { project: 1000, shortId: "Draft001", saved: false },
        { project: 1001, shortId: "Other001" },
      ],
    });
    const result = await options({}, "1000");
    expect(result).toEqual({
      options: [
        { value: "1000/AbCd1234", label: "Signups", description: "AbCd1234" },
        { value: "1000/EfGh5678", label: "EfGh5678" },
      ],
      selected: [],
    });
    // One listing request, never a query per insight.
    expect(posthog.requests.map((request) => request.path)).toEqual([
      "/api/projects/1000/insights/",
    ]);
    const [request] = posthog.requests;
    expect(request!.method).toBe("GET");
    expect(request!.params.get("basic")).toBe("true");
    expect(request!.params.get("saved")).toBe("true");
    expect(request!.params.get("refresh")).toBeNull();
  });

  it("reads pasted links and pairs as chosen, under the spelling the connection stores", async () => {
    posthog = fake({
      projects: fakeProjects(1),
      insights: [{ project: 1000, shortId: "AbCd1234" }],
    });
    const result = await options(
      {
        insights:
          "https://us.posthog.com/project/01000/insights/AbCd1234 2000/ZzZz0001",
        resourceSelection: ["01000"],
      },
      "01000",
    );
    expect(result.selected).toEqual([
      { value: "1000/AbCd1234", resourceId: "01000" },
      { value: "2000/ZzZz0001", resourceId: "2000" },
    ]);
    expect(result.options.map((option) => option.value)).toEqual([
      "1000/AbCd1234",
    ]);
    expect(posthog.requests[0]!.path).toBe("/api/projects/1000/insights/");
  });

  it("pages through the list and stops at its limit", async () => {
    posthog = fake({
      projects: fakeProjects(1),
      insights: Array.from(
        { length: MAX_INSIGHT_OPTIONS + 50 },
        (_, index) => ({
          project: 1000,
          shortId: `In${String(index).padStart(6, "0")}`,
        }),
      ),
    });
    const result = await options({}, "1000");
    expect(result.options).toHaveLength(MAX_INSIGHT_OPTIONS);
    expect(result.truncated).toBe(true);
    expect(posthog.requests).toHaveLength(MAX_INSIGHT_OPTIONS / 100);
    expect(
      posthog.requests.map((request) => request.params.get("offset")),
    ).toEqual(["0", "100", "200", "300", "400"]);
  });

  it("names a refused project, a wrong key and a missing scope with fixed reasons", async () => {
    posthog = fake({ projects: fakeProjects(1) });
    await expect(options({}, "4242")).rejects.toMatchObject({
      code: INSIGHTS_UNAVAILABLE_CODE,
    });
    await expect(options({}, "not-a-project")).rejects.toMatchObject({
      code: INSIGHTS_UNAVAILABLE_CODE,
    });
    posthog = fake({
      projects: fakeProjects(1),
      intercept: (request) =>
        request.path.endsWith("/insights/")
          ? answer(403, {
              type: "authentication_error",
              code: "permission_denied",
              detail: "secret-echo phx_should_not_leak",
            })
          : undefined,
    });
    const refused = await options({}, "1000").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ConnectorError);
    expect((refused as Error).message).not.toContain("secret-echo");
    posthog = fake({
      projects: fakeProjects(1),
      intercept: (request) =>
        request.path.endsWith("/insights/") ? scopeMissing() : undefined,
    });
    await expect(options({}, "1000")).rejects.toMatchObject({
      code: SCOPE_MISSING_CODE,
    });
    posthog = fake({ projects: fakeProjects(1), key: "phx_other" });
    await expect(options({}, "1000")).rejects.toMatchObject({
      code: KEY_REJECTED_CODE,
    });
  });

  it("lists on a self-hosted host only there", async () => {
    posthog = fake({
      host: "posthog.example.com",
      projects: fakeProjects(1),
      insights: [{ project: 1000, shortId: "AbCd1234" }],
    });
    const result = await options({ host: "posthog.example.com" }, "1000");
    expect(result.options).toHaveLength(1);
    expect(
      posthog.requests.every((r) => r.host === "posthog.example.com"),
    ).toBe(true);
  });
});
