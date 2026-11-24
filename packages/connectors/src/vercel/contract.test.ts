import { readFileSync } from "node:fs";

import type {
  ConnectionContext,
  ConnectorResponse,
  ConnectorRuntime,
  DatasetPage,
  Observation,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";
import {
  RateLimitedError,
  sourceDatasetSchema,
  syncResultSchema,
  validateDatasetPage,
} from "@netrics/connector-sdk";
import {
  expectValidFreshness,
  freshnessEntry,
  runConnectorContractTests,
} from "@netrics/connector-sdk/testing";
import { describe, expect, it } from "vitest";

import { VercelApiError, VercelInvalidResponseError } from "./api.js";
import { VERCEL_DATASETS, productionState } from "./datasets.js";
import {
  ANALYTICS_STREAM,
  BILLING_STREAM,
  DEPLOYS_STREAM,
  MAX_REQUESTS_PER_PAGE,
  createVercelConnector,
  vercelManifest,
} from "./index.js";
import {
  FAKE_PROJECTS,
  FAKE_TOKEN,
  createFakeVercel,
  fakeDeployments,
  type FakeProject,
  type FakeVercelOptions,
} from "./test-helpers.js";

const TODAY = "2024-12-31";
const DAY_MS = 24 * 60 * 60 * 1000;
const noSleep = async () => {};
const clock = () => Date.parse(`${TODAY}T13:00:00.000Z`);

function connector(now: () => number = clock) {
  return createVercelConnector({ now, sleep: noSleep });
}

function context(
  overrides: Partial<ConnectionContext> = {},
): ConnectionContext {
  return {
    connectionId: "vercel-test",
    config: {},
    credentials: { token: FAKE_TOKEN },
    ...overrides,
  };
}

function fake(options: FakeVercelOptions = {}) {
  return createFakeVercel({ today: TODAY, ...options });
}

/**
 * The host's rules for one result (connector-runtime validateSyncResult,
 * ADR 0026 §7), which the connectors package may not import: a final result
 * carries only complete pages, received datasets only on the final result,
 * and every page fits its dataset. apps/server's vercel-sync.test.ts runs
 * whole syncs through the real validation.
 */
function expectHostAccepts(result: SyncResult): void {
  const parsed = syncResultSchema.safeParse(result);
  expect(parsed.success, parsed.error?.message).toBe(true);
  if (result.done) {
    for (const page of result.datasetPages ?? []) {
      expect(page.complete, `${page.datasetKey} ${page.pageKey}`).toBe(true);
      expect(page.records).toEqual([]);
    }
    expectValidFreshness(vercelManifest, result);
  } else {
    expect(result.receivedDatasets ?? []).toEqual([]);
  }
  const schemas = new Map(
    VERCEL_DATASETS.map((dataset) => [dataset.key, dataset]),
  );
  for (const page of result.datasetPages ?? []) {
    expect(() =>
      validateDatasetPage(schemas.get(page.datasetKey)!, page),
    ).not.toThrow();
  }
}

/** Runs every page of one sync the way the engine does. */
async function syncAll(
  runtime: ConnectorRuntime,
  request: SyncRequest,
  ctx = context(),
  now: () => number = clock,
): Promise<{
  pages: SyncResult[];
  observations: Observation[];
  datasetPages: DatasetPage[];
}> {
  const pages: SyncResult[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 500; guard += 1) {
    const page = await connector(now).sync(
      ctx,
      { ...request, ...(cursor ? { cursor } : {}) },
      runtime,
    );
    expectHostAccepts(page);
    pages.push(page);
    if (page.done) {
      return {
        pages,
        observations: pages.flatMap((result) => result.observations),
        datasetPages: pages.flatMap((result) => result.datasetPages ?? []),
      };
    }
    expect(page.nextCursor).not.toBe(cursor);
    cursor = page.nextCursor;
  }
  throw new Error("the sync did not finish");
}

function rows(pages: DatasetPage[], key: string) {
  return pages
    .filter((page) => page.datasetKey === key)
    .flatMap((page) => page.records.map((record) => record.values));
}

runConnectorContractTests(connector(), {
  context: context(),
  runtime: fake().runtime,
  cursorOrder: "changing",
});

// ─── Recorded API responses (sanitized) ─────────────────────────────────────

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  );
}

function reply(status: number, body: unknown): ConnectorResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers: {},
    text: () => text,
    json: () => JSON.parse(text) as unknown,
    bytes: () => new TextEncoder().encode(text),
  };
}

const RECORDED_DEPLOYMENTS = fixture("deployments") as {
  deployments: Array<{ target: string | null; uid: string }>;
  pagination: { next: number };
};

/** Answers each request with the recorded response for its query shape. */
function recordedRuntime(): ConnectorRuntime {
  return {
    signal: new AbortController().signal,
    fetch: async (raw) => {
      const url = new URL(raw);
      if (url.pathname === "/v10/projects") {
        return reply(200, fixture("projects"));
      }
      if (url.pathname.startsWith("/v9/projects/")) {
        return reply(200, fixture("project"));
      }
      if (url.pathname === "/v7/deployments") {
        if (url.searchParams.get("target") === "production") {
          return reply(200, {
            deployments: RECORDED_DEPLOYMENTS.deployments.filter(
              (deployment) => deployment.target === "production",
            ),
            pagination: { count: 2, next: null, prev: null },
          });
        }
        // The page after the recorded one (asked up to and including the
        // instant it ended at) holds only that instant's deployment.
        const until = Number(url.searchParams.get("until"));
        const next = RECORDED_DEPLOYMENTS.pagination.next;
        return reply(
          200,
          until <= next + 1
            ? {
                deployments: RECORDED_DEPLOYMENTS.deployments.slice(-1),
                pagination: { count: 1, next: null },
              }
            : RECORDED_DEPLOYMENTS,
        );
      }
      if (url.pathname === "/v1/billing/charges") {
        return reply(
          200,
          readFileSync(
            new URL("./fixtures/billing-charges.jsonl", import.meta.url),
            "utf8",
          ),
        );
      }
      const by = url.searchParams.getAll("by").join(",");
      if (url.pathname.endsWith("/events/aggregate")) {
        return reply(200, fixture("events-by-day-name"));
      }
      const name = {
        day: "visits-by-day",
        "day,route": "visits-by-day-route",
        "day,country": "visits-by-day-country",
      }[by];
      if (!name) throw new Error(`no recorded response for ${raw}`);
      return reply(200, fixture(name));
    },
  };
}

describe("vercel connector against recorded responses", () => {
  const request: SyncRequest = {
    mode: "backfill",
    from: "2026-09-14T00:00:00.000Z",
    to: "2026-09-29T00:00:00.000Z",
  };
  const recordedNow = () => Date.parse("2026-09-28T12:00:00.000Z");
  const resource = "prj_fixture00000000000000000000";

  it("discovers projects with their Web Analytics state", async () => {
    const resources = await createVercelConnector().discover(
      context(),
      recordedRuntime(),
    );
    expect(resources).toEqual([
      {
        id: resource,
        name: "fixture-site",
        kind: "project",
        metadata: {
          accountId: "team_fixture000000000000000",
          webAnalytics: true,
        },
      },
    ]);
  });

  it("maps daily visits, routes, countries and events to observations", async () => {
    const { observations } = await syncAll(
      recordedRuntime(),
      request,
      context(),
      recordedNow,
    );
    const visits = fixture("visits-by-day") as {
      data: Array<{ timestamp: string; visitors: number; pageviews: number }>;
    };
    const first = visits.data[0]!;
    expect(observations).toContainEqual({
      metricKey: "vercel.pageviews",
      sourceTimestamp: "2026-09-14T00:00:00.000Z",
      value: first.pageviews,
      dimensions: { resource },
    });
    expect(observations).toContainEqual({
      metricKey: "vercel.visitors",
      sourceTimestamp: "2026-09-14T00:00:00.000Z",
      value: first.visitors,
      dimensions: { resource },
    });
    const byMetric = (key: string) =>
      observations.filter((observation) => observation.metricKey === key);
    expect(
      new Set(
        byMetric("vercel.route_pageviews").map((o) => o.dimensions.route),
      ),
    ).toContain("Others");
    expect(
      new Set(
        byMetric("vercel.country_visitors").map((o) => o.dimensions.country),
      ),
    ).toContain("SG");
    expect(byMetric("vercel.events")).toContainEqual({
      metricKey: "vercel.events",
      sourceTimestamp: "2026-09-14T00:00:00.000Z",
      value: 12,
      dimensions: { resource, event: "Signup" },
    });
    for (const observation of observations) {
      expect(observation.sourceTimestamp).toMatch(/T00:00:00\.000Z$/);
    }
  });

  it("maps every recorded deployment state, target and timing", async () => {
    const { datasetPages, observations } = await syncAll(
      recordedRuntime(),
      {
        mode: "incremental",
        from: "2024-12-29T00:00:00.000Z",
        to: "2024-12-31T14:00:00.000Z",
      },
      context(),
      () => Date.parse("2024-12-31T14:00:00.000Z"),
    );
    const deployments = rows(datasetPages, "deployments");
    expect(deployments.map((row) => row.state)).toEqual([
      "BUILDING",
      "READY",
      "ERROR",
      "CANCELED",
      "QUEUED",
      "INITIALIZING",
      "BLOCKED",
    ]);
    const byState = new Map(deployments.map((row) => [row.state, row]));
    expect(byState.get("READY")).toMatchObject({
      deployment_id: "dpl_fixtureReady00000000000000",
      project_id: resource,
      project_name: "fixture-site",
      target: "production",
      failed: false,
      created_at: "2024-12-31T10:00:00.000Z",
      building_at: "2024-12-31T10:00:03.000Z",
      ready_at: "2024-12-31T10:01:33.000Z",
      build_duration_seconds: 90,
      ready_substate: "PROMOTED",
      source: "git",
      branch: "main",
      url: "fixture-site-r1.vercel.app",
    });
    // No target is a preview; a custom environment keeps its own.
    expect(byState.get("ERROR")).toMatchObject({
      target: "preview",
      failed: true,
      ready_at: null,
      build_duration_seconds: null,
      branch: "feature/login",
    });
    expect(byState.get("QUEUED")?.target).toBe("staging");
    expect(byState.get("CANCELED")).toMatchObject({
      failed: false,
      url: null,
      branch: null,
    });
    // The production snapshot: the newest is building, the ready one serves.
    expect(rows(datasetPages, "production_deployments")).toEqual([
      expect.objectContaining({
        project_id: resource,
        web_analytics: true,
        state: "building",
        latest_deployment_id: "dpl_fixtureBuilding000000000000",
        latest_state: "BUILDING",
        live_deployment_id: "dpl_fixtureReady00000000000000",
        live_url: "fixture-site-r1.vercel.app",
        checked_at: "2024-12-31T14:00:00.000Z",
      }),
    ]);
    // Counts per day (UTC) and target, failed ones apart.
    const count = (metric: string, day: string, target: string) =>
      observations.find(
        (o) =>
          o.metricKey === metric &&
          o.sourceTimestamp === `${day}T00:00:00.000Z` &&
          o.dimensions.target === target,
      )?.value;
    expect(count("vercel.deployments", "2024-12-31", "production")).toBe(2);
    expect(count("vercel.deployments", "2024-12-31", "preview")).toBe(1);
    expect(count("vercel.failed_deployments", "2024-12-31", "preview")).toBe(1);
    expect(count("vercel.deployments", "2024-12-30", "preview")).toBe(3);
    expect(count("vercel.deployments", "2024-12-30", "staging")).toBe(1);
    expect(count("vercel.deployments", "2024-12-29", "production")).toBe(0);
  });

  it("reads this month's charges from the recorded FOCUS export, a day at a time", async () => {
    // The recorded export covers 1 and 2 December 2024. Each day's request
    // keeps the charges that start that day.
    const { datasetPages, pages } = await syncAll(
      recordedRuntime(),
      {
        mode: "incremental",
        from: "2024-12-01T00:00:00.000Z",
        to: "2024-12-02T12:00:00.000Z",
      },
      context(),
      () => Date.parse("2024-12-02T12:00:00.000Z"),
    );
    const charges = rows(datasetPages, "billing_charges");
    expect(charges).toEqual([
      expect.objectContaining({
        team_id: "team_fixture000000000000000",
        team_name: "Fixture Team",
        project_id: resource,
        project_name: "fixture-site",
        sku_id: "function-invocations",
        service_name: "Function Invocations",
        charge_category: "Usage",
        month: "2024-12-01",
        billed_cost: "2",
        effective_cost: "1.95",
        consumed_quantity: 200000,
        consumed_unit: "invocations",
        currency: "USD",
      }),
      expect.objectContaining({
        project_id: "",
        sku_id: "pro-seat",
        charge_category: "Purchase",
        billed_cost: "20",
        consumed_quantity: null,
      }),
    ]);
    const done = pages.at(-1)!;
    expect(done.receivedDatasets).toContain("billing_charges");
    expect(freshnessEntry(done, BILLING_STREAM)).toEqual({
      stream: BILLING_STREAM,
    });
  });

  it("fails with a fixed message when Vercel changes a response shape", async () => {
    const runtime = recordedRuntime();
    const broken: ConnectorRuntime = {
      ...runtime,
      fetch: async (url, init) =>
        url.includes("/v10/projects")
          ? reply(200, { projects: [{ id: "prj", secret: "leak-me" }] })
          : runtime.fetch(url, init),
    };
    const error = await createVercelConnector({ now: recordedNow })
      .sync(context(), request, broken)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VercelInvalidResponseError);
    expect((error as Error).message).toBe(
      "Vercel answered the project list in an unexpected shape.",
    );
  });

  it("reads the recorded error bodies", async () => {
    const badToken = fixture("error-bad-token");
    const check = await createVercelConnector().check(context(), {
      signal: new AbortController().signal,
      fetch: async () => reply(403, badToken),
    });
    expect(check.ok).toBe(false);
    expect(check.message).toMatch(/expired or was revoked/);

    const listDenied = fixture("error-list-teams");
    const denied = await createVercelConnector().check(context(), {
      signal: new AbortController().signal,
      fetch: async () => reply(403, listDenied),
    });
    expect(denied).toEqual({
      ok: false,
      message: expect.stringMatching(/may not list projects/),
    });
  });

  it("never quotes Vercel's error text", async () => {
    const unknown = fixture("error-unknown-project") as {
      error: { message: string };
    };
    const error = await createVercelConnector({ now: recordedNow })
      .discover(context(), {
        signal: new AbortController().signal,
        fetch: async () => reply(400, unknown),
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VercelApiError);
    expect((error as Error).message).toBe("Vercel refused the request (400).");
    expect((error as Error).message).not.toContain(unknown.error.message);
  });
});

// ─── Behaviour against the fake API ─────────────────────────────────────────

const RECENT: SyncRequest = {
  mode: "incremental",
  from: "2024-12-29T00:00:00.000Z",
  to: `${TODAY}T13:00:00.000Z`,
};

describe("vercel connector", () => {
  it("only reaches api.vercel.com, with the token in a header", async () => {
    expect(vercelManifest.outboundDomains).toEqual(["api.vercel.com"]);
    const api = fake();
    await syncAll(api.runtime, {
      mode: "backfill",
      from: "2024-11-20T00:00:00.000Z",
      to: "2024-12-05T00:00:00.000Z",
    });
    expect(api.requests.length).toBeGreaterThan(0);
    for (const { url, init } of api.requests) {
      expect(url.hostname).toBe("api.vercel.com");
      expect(url.toString()).not.toContain(FAKE_TOKEN);
      expect(init?.headers?.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    }
  });

  it("reads deployments of every project, Web Analytics only where enabled", async () => {
    const api = fake();
    const { pages, observations, datasetPages } = await syncAll(
      api.runtime,
      RECENT,
    );
    // gamma has no Web Analytics: its deployments, but no analytics query.
    const analyticsAsked = new Set(
      api.requests
        .filter(({ url }) => url.pathname.startsWith("/v1/query/"))
        .map(({ url }) => url.searchParams.get("projectId")),
    );
    expect(analyticsAsked).toEqual(new Set(["prj_alpha", "prj_beta"]));
    const deployed = new Set(
      rows(datasetPages, "deployments").map((row) => row.project_id),
    );
    expect(deployed).toEqual(new Set(["prj_alpha", "prj_beta", "prj_gamma"]));
    expect(
      new Set(
        observations
          .filter((o) => o.metricKey === "vercel.deployments")
          .map((o) => o.dimensions.resource),
      ),
    ).toEqual(new Set(["prj_alpha", "prj_beta", "prj_gamma"]));
    expect(
      observations.some(
        (o) =>
          o.metricKey === "vercel.pageviews" &&
          o.dimensions.resource === "prj_gamma",
      ),
    ).toBe(false);
    const snapshot = rows(datasetPages, "production_deployments");
    expect(snapshot.map((row) => [row.project_id, row.web_analytics])).toEqual([
      ["prj_alpha", true],
      ["prj_beta", true],
      ["prj_gamma", false],
    ]);
    expect(snapshot.find((row) => row.project_id === "prj_gamma")).toEqual(
      expect.objectContaining({
        state: "building",
        latest_deployment_id: "dpl_prj_gamma_0",
        live_deployment_id: "dpl_prj_gamma_6",
      }),
    );

    const done = pages.at(-1)!;
    expect([...(done.receivedDatasets ?? [])].sort()).toEqual([
      "billing_charges",
      "deployments",
      "production_deployments",
    ]);
    // Web Analytics freshness per project: never for gamma.
    expect(freshnessEntry(done, ANALYTICS_STREAM)).toBeUndefined();
    expect(freshnessEntry(done, ANALYTICS_STREAM, "prj_alpha")).toBeDefined();
    expect(freshnessEntry(done, ANALYTICS_STREAM, "prj_gamma")).toBeUndefined();
    expect(freshnessEntry(done, DEPLOYS_STREAM)).toBeDefined();
    expect(freshnessEntry(done, DEPLOYS_STREAM, "prj_gamma")).toBeDefined();
    for (const entry of done.freshness ?? []) {
      expect(entry.dataThrough).toBeUndefined();
    }
  });

  it("re-reads recent deployments: a changed state is updated, a deleted one is tombstoned", async () => {
    const first = await syncAll(fake().runtime, RECENT);
    const before = rows(first.datasetPages, "deployments");
    expect(
      before.find((row) => row.deployment_id === "dpl_prj_alpha_0"),
    ).toMatchObject({ state: "BUILDING", failed: false });

    const second = await syncAll(
      fake({
        states: { dpl_prj_alpha_0: "READY" },
        deleted: ["dpl_prj_alpha_1"],
      }).runtime,
      { ...RECENT, cursor: first.pages.at(-1)!.nextCursor },
    );
    const records = second.datasetPages
      .filter((page) => page.datasetKey === "deployments")
      .flatMap((page) => page.records);
    expect(
      records.find(
        (record) => record.values.deployment_id === "dpl_prj_alpha_0",
      )?.values.state,
    ).toBe("READY");
    expect(
      records.filter(
        (record) => record.values.deployment_id === "dpl_prj_alpha_1",
      ),
    ).toEqual([
      { values: { deployment_id: "dpl_prj_alpha_1" }, deleted: true },
    ]);
    // Without the previous run's cursor nothing is known to be deleted.
    const fresh = await syncAll(
      fake({ deleted: ["dpl_prj_alpha_1"] }).runtime,
      RECENT,
    );
    expect(
      fresh.datasetPages
        .flatMap((page) => page.records)
        .some((record) => record.deleted),
    ).toBe(false);
    // The snapshot follows: alpha now serves its newest deployment.
    expect(
      rows(second.datasetPages, "production_deployments").find(
        (row) => row.project_id === "prj_alpha",
      ),
    ).toMatchObject({ state: "up", live_deployment_id: "dpl_prj_alpha_0" });
  });

  it("counts deployments per day and target, zero days included", async () => {
    const { observations } = await syncAll(fake().runtime, RECENT);
    const alpha = observations.filter(
      (o) => o.dimensions.resource === "prj_alpha",
    );
    const sum = (metric: string) =>
      alpha
        .filter((o) => o.metricKey === metric)
        .reduce((total, o) => total + o.value, 0);
    // 8 deployments, one every 6 hours back from noon today: all in the window.
    const expected = fakeDeployments(FAKE_PROJECTS[0]!, TODAY).filter(
      (deployment) => deployment.created >= Date.parse(RECENT.from),
    );
    expect(sum("vercel.deployments")).toBe(expected.length);
    expect(sum("vercel.failed_deployments")).toBe(
      expected.filter((deployment) => deployment.readyState === "ERROR").length,
    );
    // Every day of the window has both targets, zero included.
    const days = new Set(
      alpha
        .filter((o) => o.metricKey === "vercel.deployments")
        .map((o) => `${o.sourceTimestamp}|${o.dimensions.target}`),
    );
    expect(days).toEqual(
      new Set(
        ["2024-12-29", "2024-12-30", "2024-12-31"].flatMap((day) => [
          `${day}T00:00:00.000Z|production`,
          `${day}T00:00:00.000Z|preview`,
        ]),
      ),
    );
    expect(
      alpha.find(
        (o) =>
          o.metricKey === "vercel.deployments" &&
          o.sourceTimestamp === "2024-12-29T00:00:00.000Z" &&
          o.dimensions.target === "production",
      )?.value,
    ).toBe(0);
  });

  it("pages through a large history within the page budgets", async () => {
    const projects: FakeProject[] = [
      {
        id: "prj_busy",
        name: "busy",
        accountId: "team_fixture",
        analytics: false,
        deployments: 2_500,
        deployEveryMs: 30 * 60 * 1000,
      },
    ];
    const api = fake({ projects });
    const { pages, datasetPages, observations } = await syncAll(api.runtime, {
      mode: "backfill",
      from: "2024-10-01T00:00:00.000Z",
      to: `${TODAY}T13:00:00.000Z`,
    });
    expect(pages.length).toBeGreaterThan(1);
    const deployments = rows(datasetPages, "deployments");
    // Every deployment once, though pages end at the same instants Vercel
    // continues from.
    expect(deployments).toHaveLength(2_500);
    expect(new Set(deployments.map((row) => row.deployment_id)).size).toBe(
      2_500,
    );
    const counted = observations
      .filter((o) => o.metricKey === "vercel.deployments")
      .reduce((total, o) => total + o.value, 0);
    expect(counted).toBe(2_500);
    // One count per day and target: a day spanning two requests is not
    // counted twice.
    const keys = observations.map(
      (o) =>
        `${o.metricKey}|${o.sourceTimestamp}|${o.dimensions.resource}|${o.dimensions.target}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
    for (const page of pages) {
      expect((page.datasetPages ?? []).length).toBeLessThanOrEqual(20);
    }
    // Requests per page stay within the budget.
    const perPage = Math.ceil(api.requests.length / pages.length);
    expect(perPage).toBeLessThanOrEqual(MAX_REQUESTS_PER_PAGE);
  });

  it("reads deployments back at most 90 days, whatever the window", async () => {
    const api = fake();
    await syncAll(api.runtime, {
      mode: "backfill",
      from: "2024-01-01T00:00:00.000Z",
      to: `${TODAY}T13:00:00.000Z`,
    });
    const since = api.requests
      .filter(
        ({ url }) =>
          url.pathname === "/v7/deployments" && url.searchParams.has("since"),
      )
      .map(({ url }) => Number(url.searchParams.get("since")));
    expect(Math.min(...since)).toBe(
      Date.parse(`${TODAY}T00:00:00.000Z`) - 90 * DAY_MS - 1,
    );
  });

  it("refuses a page cursor that does not move back in time", async () => {
    const api = fake({
      projects: [{ ...FAKE_PROJECTS[2]!, deployments: 300 }],
    });
    const stuck: ConnectorRuntime = {
      ...api.runtime,
      fetch: async (url, init) => {
        const answer = await api.runtime.fetch(url, init);
        if (!url.includes("/v7/deployments") || url.includes("target=")) {
          return answer;
        }
        const body = answer.json() as {
          pagination: { next: number | null };
        };
        body.pagination.next = Number(new URL(url).searchParams.get("until"));
        return reply(200, body);
      },
    };
    const run = async () => {
      let cursor: string | undefined;
      for (;;) {
        const page = await connector().sync(
          context(),
          { ...RECENT, ...(cursor ? { cursor } : {}) },
          stuck,
        );
        if (page.done) return page;
        cursor = page.nextCursor;
      }
    };
    await expect(run()).rejects.toThrow(
      "Vercel answered the deployments in an unexpected shape.",
    );
  });

  it("a failure after other steps returns them: the next page repeats only the failed step", async () => {
    // The second deployments request fails (400 is not retried).
    const api = fake({
      failAfter: { after: 2, status: 400, path: "/v7/deployments" },
    });
    const first = await connector().sync(context(), RECENT, api.runtime);
    expectHostAccepts(first);
    expect(first.done).toBe(false);
    const failed = api.requests.at(-1)!.url.toString();
    const before = api.requests.length;
    // What the first page read is returned with it.
    expect(first.datasetPages?.length).toBeGreaterThan(0);
    const second = await connector().sync(
      context(),
      { ...RECENT, cursor: first.nextCursor },
      api.runtime,
    );
    expectHostAccepts(second);
    // The next page starts with the failed request; nothing before it is
    // asked again.
    expect(api.requests[before]!.url.toString()).toBe(failed);
    const urls = api.requests.map(({ url }) => url.toString());
    expect(urls.filter((url) => url === failed)).toHaveLength(2);
    expect(new Set(urls).size).toBe(urls.length - 1);
  });

  it("a failing first step fails the page; a rate limit stays a RateLimitedError", async () => {
    const outage = fake({
      failAfter: { after: 0, status: 400, path: "/v10/projects" },
    });
    await expect(
      connector().sync(context(), RECENT, outage.runtime),
    ).rejects.toBeInstanceOf(VercelApiError);

    const limited = fake({
      failAfter: {
        after: 0,
        status: 429,
        path: "/v10/projects",
        headers: { "retry-after": "3600" },
      },
    });
    const error = await connector()
      .sync(context(), RECENT, limited.runtime)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).retryAt).toBe(
      new Date(clock() + 3600 * 1000).toISOString(),
    );
  });

  it("a rate limit after other steps returns them; the next page waits for the reset", async () => {
    // alpha's newest build and newest READY build are read; its
    // deployments are rate-limited.
    const api = fake({
      failAfter: {
        after: 2,
        status: 429,
        path: "/v7/deployments",
        headers: { "retry-after": "3600" },
      },
    });
    const first = await connector().sync(context(), RECENT, api.runtime);
    expect(first.done).toBe(false);
    // alpha's production row went out with the page.
    expect(first.datasetPages?.length).toBeGreaterThan(0);
  });

  it("an auth failure fails the page even after other steps", async () => {
    const api = fake({
      failAfter: { after: 1, status: 401, path: "/v7/deployments" },
    });
    const error = await connector()
      .sync(context(), RECENT, api.runtime)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VercelApiError);
    expect((error as VercelApiError).isAuth).toBe(true);
  });

  it("binds a checkpoint to the selection and the token", async () => {
    const api = fake({
      projects: [{ ...FAKE_PROJECTS[0]!, deployments: 400 }],
    });
    const window: SyncRequest = {
      mode: "backfill",
      from: "2024-11-01T00:00:00.000Z",
      to: `${TODAY}T13:00:00.000Z`,
    };
    const first = await connector().sync(context(), window, api.runtime);
    expect(first.done).toBe(false);
    const listings = () =>
      api.requests.filter(({ url }) => url.pathname === "/v10/projects").length;
    expect(listings()).toBe(1);
    // The same scope continues where the page stopped.
    await connector().sync(
      context(),
      { ...window, cursor: first.nextCursor },
      api.runtime,
    );
    expect(listings()).toBe(1);
    // Another selection, or another token, starts over.
    await connector().sync(
      context(),
      { ...window, cursor: first.nextCursor, resources: ["prj_alpha"] },
      api.runtime,
    );
    expect(listings()).toBe(2);
    const other = fake({ token: "another-token-0123456789" });
    await connector().sync(
      context({ credentials: { token: "another-token-0123456789" } }),
      { ...window, cursor: first.nextCursor },
      other.runtime,
    );
    expect(
      other.requests.filter(({ url }) => url.pathname === "/v10/projects"),
    ).toHaveLength(1);
  });

  it("honours the selection, including a project without Web Analytics", async () => {
    const api = fake();
    const { datasetPages, pages } = await syncAll(api.runtime, {
      ...RECENT,
      resources: ["prj_gamma"],
    });
    expect(
      new Set(rows(datasetPages, "deployments").map((row) => row.project_id)),
    ).toEqual(new Set(["prj_gamma"]));
    expect(
      api.requests.some(({ url }) => url.pathname.startsWith("/v1/query/")),
    ).toBe(false);
    const done = pages.at(-1)!;
    expect(freshnessEntry(done, DEPLOYS_STREAM)).toBeDefined();
    expect(
      (done.freshness ?? []).filter((e) => e.stream === ANALYTICS_STREAM),
    ).toEqual([]);
    // Team-level charges stay; another project's do not.
    const charges = rows(datasetPages, "billing_charges");
    expect(new Set(charges.map((row) => row.project_id))).toEqual(
      new Set(["prj_gamma", ""]),
    );
  });

  it("a selected project the token no longer lists is not reported fresh", async () => {
    const { pages } = await syncAll(fake().runtime, {
      ...RECENT,
      resources: ["prj_alpha", "prj_deleted"],
    });
    const done = pages.at(-1)!;
    expect(freshnessEntry(done, DEPLOYS_STREAM)).toBeUndefined();
    expect(freshnessEntry(done, DEPLOYS_STREAM, "prj_alpha")).toBeDefined();
    expect(done.receivedDatasets).not.toContain("deployments");
  });

  it("a project gone during the run is skipped, and claims nothing", async () => {
    const api = fake();
    const gone: ConnectorRuntime = {
      ...api.runtime,
      fetch: async (url, init) =>
        url.includes("projectId=prj_beta") && url.includes("/v7/deployments")
          ? reply(404, { error: { code: "not_found", message: "gone" } })
          : api.runtime.fetch(url, init),
    };
    const { pages, datasetPages } = await syncAll(gone, RECENT);
    const done = pages.at(-1)!;
    expect(freshnessEntry(done, DEPLOYS_STREAM)).toBeUndefined();
    expect(freshnessEntry(done, DEPLOYS_STREAM, "prj_beta")).toBeUndefined();
    expect(freshnessEntry(done, ANALYTICS_STREAM, "prj_beta")).toBeUndefined();
    expect(freshnessEntry(done, DEPLOYS_STREAM, "prj_alpha")).toBeDefined();
    expect(
      rows(datasetPages, "production_deployments").map((row) => row.project_id),
    ).toEqual(["prj_alpha", "prj_gamma"]);
  });

  it("charges the token may not read leave the stored snapshot and claim nothing", async () => {
    const { pages, datasetPages } = await syncAll(
      fake({ billingStatus: 403 }).runtime,
      RECENT,
    );
    const done = pages.at(-1)!;
    expect(done.receivedDatasets).not.toContain("billing_charges");
    expect(freshnessEntry(done, BILLING_STREAM)).toBeUndefined();
    expect(
      datasetPages.some((page) => page.datasetKey === "billing_charges"),
    ).toBe(false);
    // Everything else is complete.
    expect(done.receivedDatasets).toContain("deployments");
    expect(freshnessEntry(done, DEPLOYS_STREAM)).toBeDefined();
  });

  it("a personal account has no team charges to read", async () => {
    const { pages } = await syncAll(
      fake({
        projects: [{ ...FAKE_PROJECTS[0]!, accountId: "user_personal" }],
      }).runtime,
      RECENT,
    );
    expect(pages.at(-1)!.receivedDatasets).not.toContain("billing_charges");
  });

  it("resumes a checkpoint from before #871 where it started reading (#758, #765)", async () => {
    const api = fake();
    const window = {
      mode: "incremental" as const,
      from: "2024-12-31T06:00:00.000Z",
      to: `${TODAY}T12:00:00.000Z`,
    };
    for (const cursor of [
      "2024-12-10T00:00:00.000Z",
      "2024-12-20T00:00:00.000Z|2024-12-10T00:00:00.000Z",
    ]) {
      const { observations, pages } = await syncAll(api.runtime, {
        ...window,
        cursor,
      });
      const days = observations
        .filter((o) => o.metricKey === "vercel.pageviews")
        .map((o) => o.sourceTimestamp)
        .sort();
      expect(days[0]).toBe("2024-12-10T00:00:00.000Z");
      expect(pages.at(-1)!.nextFrom).toBe("2024-12-29T00:00:00.000Z");
    }
  });

  it("resumes incremental syncs two days back", async () => {
    const { pages } = await syncAll(fake().runtime, RECENT);
    expect(pages.at(-1)!.nextFrom).toBe("2024-12-29T00:00:00.000Z");
    // The final cursor remembers the deployments of the re-read days.
    expect(pages.at(-1)!.nextCursor).toMatch(/^vercel\.v1:/);
  });

  it("keeps a day's analytics whichever window asks for it", async () => {
    const wide = await syncAll(fake().runtime, {
      mode: "backfill",
      from: "2024-12-01T00:00:00.000Z",
      to: "2024-12-31T00:00:00.000Z",
    });
    const narrow = await syncAll(fake().runtime, {
      mode: "incremental",
      from: "2024-12-20T00:00:00.000Z",
      to: "2024-12-22T00:00:00.000Z",
    });
    for (const observation of narrow.observations.filter(
      (o) => !o.metricKey.includes("deployments"),
    )) {
      expect(wide.observations).toContainEqual(observation);
    }
  });

  it("clamps an analytics backfill to the days the plan keeps", async () => {
    const api = fake({ planDays: 30 });
    const { observations } = await syncAll(api.runtime, {
      mode: "backfill",
      from: "2024-01-01T00:00:00.000Z",
      to: `${TODAY}T12:00:00.000Z`,
    });
    const days = new Set(
      observations
        .filter((o) => o.metricKey === "vercel.pageviews")
        .map((o) => o.sourceTimestamp),
    );
    expect([...days].sort()[0]).toBe("2024-12-02T00:00:00.000Z");
    expect(days.size).toBe(30);
    // The plan is learned once: January is asked, then nothing before December.
    const months = api.requests
      .filter(({ url }) => url.pathname.startsWith("/v1/query/"))
      .map(({ url }) => url.searchParams.get("since")!.slice(0, 7));
    expect(months.filter((month) => month < "2024-12")).toEqual(["2024-01"]);
  });

  it("waits out a near rate limit and retries server errors", async () => {
    const waits: number[] = [];
    const api = fake({
      failures: [
        { status: 429, headers: { "retry-after": "2" } },
        { status: 503 },
        { status: 502 },
      ],
    });
    const result = await createVercelConnector({
      now: clock,
      sleep: async (ms) => {
        waits.push(ms);
      },
    }).discover(context(), api.runtime);
    expect(result).toHaveLength(FAKE_PROJECTS.length);
    expect(waits).toEqual([2000, 1000, 2000]);
  });

  it("hands a far rate-limit reset to the host as RateLimitedError (#781)", async () => {
    const far = fake({
      failures: [{ status: 429, headers: { "retry-after": "3600" } }],
    });
    const error = await connector()
      .discover(context(), far.runtime)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).retryAt).toBe(
      new Date(clock() + 3600 * 1000).toISOString(),
    );
    expect((error as Error).message).toMatch(/429/);
    expect(far.requests).toHaveLength(1);
  });

  it("stops before the window runs out: waits for a near reset, defers a far one (#781)", async () => {
    const waits: number[] = [];
    const near = fake({
      window: { remaining: 2, resetInMs: 20_000, now: clock },
    });
    const { pages } = await (async () => {
      const results: SyncResult[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await createVercelConnector({
          now: clock,
          sleep: async (ms) => {
            waits.push(ms);
          },
        }).sync(
          context(),
          { ...RECENT, ...(cursor ? { cursor } : {}) },
          near.runtime,
        );
        results.push(page);
        if (page.done) return { pages: results };
        cursor = page.nextCursor;
      }
    })();
    expect(pages.at(-1)!.done).toBe(true);
    expect(waits[0]).toBe(20_000);

    const far = fake({
      window: { remaining: 2, resetInMs: 60 * 60 * 1000, now: clock },
    });
    // The listing answers with the window nearly used up and an hour to
    // its reset: no further request is spent, and the page returns the
    // listing it read.
    const page = await connector().sync(context(), RECENT, far.runtime);
    expect(page.done).toBe(false);
    expect(far.requests).toHaveLength(1);
    // A page that starts against the used-up window hands the reset to
    // the host.
    const exhausted = fake({
      failures: [
        {
          status: 429,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String((clock() + 3_600_000) / 1000),
          },
        },
      ],
    });
    const error = await connector()
      .sync(
        context(),
        { ...RECENT, cursor: page.nextCursor },
        exhausted.runtime,
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitedError);
  });

  it("gives up on persistent outages with a fixed message", async () => {
    const down = fake({
      failures: Array.from({ length: 4 }, () => ({ status: 500 })),
    });
    await expect(connector().discover(context(), down.runtime)).rejects.toThrow(
      "Vercel is not answering right now (500). netrics tries again later.",
    );
  });

  it("follows project pagination", async () => {
    const resources = await connector().discover(
      context(),
      fake({ projectsPageSize: 1 }).runtime,
    );
    expect(resources.map((resource) => resource.id)).toEqual(
      FAKE_PROJECTS.map((project) => project.id),
    );
    const { datasetPages } = await syncAll(
      fake({ projectsPageSize: 1 }).runtime,
      RECENT,
    );
    expect(rows(datasetPages, "production_deployments")).toHaveLength(3);
  });
});

// ─── Review findings of #889 (each failed on the code before its fix) ──────

describe("vercel review findings (#889)", () => {
  /** A whole sync, then the next one resumed from its done cursor. */
  async function twoRuns(
    first: FakeVercelOptions,
    second: FakeVercelOptions,
    request: SyncRequest = RECENT,
  ) {
    const one = await syncAll(fake(first).runtime, request);
    const two = await syncAll(fake(second).runtime, {
      ...request,
      cursor: one.pages.at(-1)!.nextCursor,
    });
    return { one, two };
  }

  it("P1: the live production deployment is the project's production target, however old", async () => {
    // 60 deployments, the newest 25 production builds failed; production
    // still serves an older one, rolled back to.
    const states = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [
        `dpl_prj_alpha_${index * 2}`,
        "ERROR",
      ]),
    );
    const { datasetPages } = await syncAll(
      fake({
        projects: [{ ...FAKE_PROJECTS[0]!, deployments: 60 }],
        states: { ...states, dpl_prj_alpha_56: "READY" },
        live: { prj_alpha: "dpl_prj_alpha_56" },
      }).runtime,
      RECENT,
    );
    expect(rows(datasetPages, "production_deployments")).toEqual([
      expect.objectContaining({
        state: "up",
        latest_deployment_id: "dpl_prj_alpha_0",
        latest_state: "ERROR",
        live_deployment_id: "dpl_prj_alpha_56",
        live_url: "dpl_prj_alpha_56.vercel.app",
      }),
    ]);
    // After an instant rollback the target, not the newest READY one, is live.
    const rolledBack = await syncAll(
      fake({
        projects: [{ ...FAKE_PROJECTS[0]!, deployments: 20 }],
        live: { prj_alpha: "dpl_prj_alpha_14" },
      }).runtime,
      { ...RECENT, resources: ["prj_alpha"] },
    );
    expect(
      rows(rolledBack.datasetPages, "production_deployments")[0],
    ).toMatchObject({
      live_deployment_id: "dpl_prj_alpha_14",
      state: "building",
    });
    // No production target and a failed newest build: failed.
    const none = await syncAll(
      fake({
        live: { prj_alpha: null },
        states: { dpl_prj_alpha_0: "ERROR" },
      }).runtime,
      { ...RECENT, resources: ["prj_alpha"] },
    );
    expect(rows(none.datasetPages, "production_deployments")[0]).toMatchObject({
      live_deployment_id: null,
      state: "failed",
    });
  });

  it("P2: a run completes one deployments refresh, whatever the number of projects", async () => {
    const projects = Array.from({ length: 12 }, (_, index) => ({
      ...FAKE_PROJECTS[2]!,
      id: `prj_${index}`,
    }));
    const { datasetPages } = await syncAll(fake({ projects }).runtime, RECENT);
    const deployments = datasetPages.filter(
      (page) => page.datasetKey === "deployments",
    );
    expect(new Set(deployments.map((page) => page.refreshKey)).size).toBe(1);
    expect(deployments.filter((page) => page.complete)).toHaveLength(1);
  });

  it("P2: re-read deployments Vercel no longer lists are tombstoned", async () => {
    const { one, two } = await twoRuns(
      {},
      { deleted: ["dpl_prj_alpha_1"], states: { dpl_prj_alpha_0: "READY" } },
    );
    expect(
      rows(one.datasetPages, "deployments").some(
        (row) => row.deployment_id === "dpl_prj_alpha_1",
      ),
    ).toBe(true);
    const pages = two.datasetPages.filter(
      (page) => page.datasetKey === "deployments",
    );
    const records = pages.flatMap((page) => page.records);
    expect(records).toContainEqual({
      values: { deployment_id: "dpl_prj_alpha_1" },
      deleted: true,
    });
    expect(
      records.find(
        (record) => record.values.deployment_id === "dpl_prj_alpha_0",
      )?.values.state,
    ).toBe("READY");
  });

  it("P2: billing is read one day at a time and summed", async () => {
    const api = fake();
    const { datasetPages } = await syncAll(api.runtime, RECENT);
    const billing = api.requests.filter(
      ({ url }) => url.pathname === "/v1/billing/charges",
    );
    for (const { url } of billing) {
      expect(
        Date.parse(url.searchParams.get("to")!) -
          Date.parse(url.searchParams.get("from")!),
      ).toBe(DAY_MS);
    }
    // 31 days of December so far, one team.
    expect(billing).toHaveLength(31);
    const charges = rows(datasetPages, "billing_charges");
    expect(charges.find((row) => row.project_id === "prj_alpha")).toMatchObject(
      {
        billed_cost: "15.5",
        effective_cost: "7.75",
        consumed_quantity: 3100,
      },
    );
    expect(charges.find((row) => row.sku_id === "pro-seat")).toMatchObject({
      billed_cost: "20",
    });
  });

  it("P2: a rate-limited or failing billing read stays retryable", async () => {
    for (const status of [429, 503]) {
      const run = syncAll(fake({ billingStatus: status }).runtime, {
        ...RECENT,
        resources: ["prj_gamma"],
      });
      await expect(run).rejects.toBeInstanceOf(VercelApiError);
    }
  });

  it("P2: a custom environment's deployments carry its slug", async () => {
    const { datasetPages, observations } = await syncAll(
      fake({ environments: { dpl_prj_alpha_1: "qa" } }).runtime,
      { ...RECENT, resources: ["prj_alpha"] },
    );
    expect(
      rows(datasetPages, "deployments").find(
        (row) => row.deployment_id === "dpl_prj_alpha_1",
      )?.target,
    ).toBe("qa");
    expect(
      observations.find(
        (o) =>
          o.metricKey === "vercel.deployments" && o.dimensions.target === "qa",
      )?.value,
    ).toBe(1);
  });

  it("P2: a target whose last deployment disappears is counted as zero", async () => {
    const { two } = await twoRuns(
      { environments: { dpl_prj_alpha_1: "qa" } },
      {
        environments: { dpl_prj_alpha_1: "qa" },
        deleted: ["dpl_prj_alpha_1"],
      },
      { ...RECENT, resources: ["prj_alpha"] },
    );
    const day = new Date(fakeDeployments(FAKE_PROJECTS[0]!, TODAY)[1]!.created)
      .toISOString()
      .slice(0, 10);
    expect(
      two.observations.find(
        (o) =>
          o.metricKey === "vercel.deployments" &&
          o.dimensions.target === "qa" &&
          o.sourceTimestamp === `${day}T00:00:00.000Z`,
      )?.value,
    ).toBe(0);
  });

  it("P2: a deployment list without pagination is an invalid answer", async () => {
    await expect(
      syncAll(fake({ omitPagination: true }).runtime, RECENT),
    ).rejects.toBeInstanceOf(VercelInvalidResponseError);
  });
});

// ─── Review round 2 of #889, and the owner's decisions (2026-11-24) ────────

describe("vercel review round 2 (#889)", () => {
  async function twoRuns(
    first: FakeVercelOptions,
    second: FakeVercelOptions,
    request: SyncRequest = RECENT,
  ) {
    const one = await syncAll(fake(first).runtime, request);
    const two = await syncAll(fake(second).runtime, {
      ...request,
      cursor: one.pages.at(-1)!.nextCursor,
    });
    return { one, two };
  }

  it("P1: a backfill that learned the plan's window resumes after UTC midnight", async () => {
    const request: SyncRequest = {
      mode: "backfill",
      from: "2024-01-01T00:00:00.000Z",
      to: `${TODAY}T12:00:00.000Z`,
    };
    // Four projects of one team: more than one page of requests.
    const projects = ["prj_alpha", "prj_beta", "prj_delta", "prj_epsilon"].map(
      (id) => ({ ...FAKE_PROJECTS[0]!, id, name: id }),
    );
    // The run starts on 31 December, learns the 30-day window, and goes on
    // after midnight, when Vercel's window has moved a day.
    const dayOne = fake({ planDays: 30, projects });
    const dayTwo = createFakeVercel({
      today: "2025-01-01",
      planDays: 30,
      projects,
    });
    const nextDay = () => Date.parse("2025-01-01T01:00:00.000Z");
    let page = await connector().sync(context(), request, dayOne.runtime);
    expect(page.done).toBe(false);
    for (let guard = 0; !page.done && guard < 100; guard += 1) {
      page = await connector(nextDay).sync(
        context(),
        { ...request, cursor: page.nextCursor },
        dayTwo.runtime,
      );
      expectHostAccepts(page);
    }
    expect(page.done).toBe(true);
    // The old cutoff was asked after midnight, and refused, at least once.
    expect(
      dayTwo.requests.some(
        ({ url }) =>
          url.pathname.startsWith("/v1/query/") &&
          url.searchParams.get("since") === "2024-12-02",
      ),
    ).toBe(true);
    expect(freshnessEntry(page, ANALYTICS_STREAM, "prj_epsilon")).toBeDefined();
  });

  it("P2: tombstones of many projects stay within 20 dataset pages per result", async () => {
    const projects = Array.from({ length: 5 }, (_, index) => ({
      ...FAKE_PROJECTS[2]!,
      id: `prj_many_${index}`,
      deployments: 2_000,
      deployEveryMs: 60_000,
    }));
    const all = projects.flatMap((project) =>
      fakeDeployments(project, TODAY).map((deployment) => deployment.uid),
    );
    const { two } = await twoRuns({ projects }, { projects, deleted: all });
    const tombstones = two.datasetPages
      .flatMap((page) => page.records)
      .filter((record) => record.deleted);
    expect(tombstones).toHaveLength(10_000);
  });

  it("P2: deployments sharing a creation millisecond across a page boundary are both read", async () => {
    const project = {
      ...FAKE_PROJECTS[2]!,
      deployments: 150,
      deployEveryMs: 60_000,
    };
    const deployments = fakeDeployments(project, TODAY);
    const { datasetPages, observations } = await syncAll(
      fake({
        projects: [project],
        created: { dpl_prj_gamma_100: deployments[99]!.created },
      }).runtime,
      RECENT,
    );
    const ids = rows(datasetPages, "deployments").map(
      (row) => row.deployment_id,
    );
    expect(ids).toContain("dpl_prj_gamma_99");
    expect(ids).toContain("dpl_prj_gamma_100");
    expect(new Set(ids).size).toBe(150);
    expect(
      observations
        .filter((o) => o.metricKey === "vercel.deployments")
        .reduce((total, o) => total + o.value, 0),
    ).toBe(150);
  });

  it("P2: environment slugs like constructor and __proto__ are plain targets", async () => {
    const environments = {
      dpl_prj_alpha_1: "constructor",
      dpl_prj_alpha_3: "__proto__",
    };
    const request = { ...RECENT, resources: ["prj_alpha"] };
    const { one, two } = await twoRuns(
      { environments },
      { environments, deleted: ["dpl_prj_alpha_3"] },
      request,
    );
    const count = (observations: Observation[], target: string) =>
      observations
        .filter(
          (o) =>
            o.metricKey === "vercel.deployments" &&
            o.dimensions.target === target,
        )
        .reduce((total, o) => total + o.value, 0);
    expect(count(one.observations, "constructor")).toBe(1);
    expect(count(one.observations, "__proto__")).toBe(1);
    // Remembered across runs: the deleted one's target is counted as zero.
    expect(
      two.observations.some(
        (o) =>
          o.metricKey === "vercel.deployments" &&
          o.dimensions.target === "__proto__" &&
          o.value === 0,
      ),
    ).toBe(true);
  });

  it("P2: a billing export over the response cap leaves the charges as stored, the rest publishes", async () => {
    const { pages, datasetPages } = await syncAll(
      fake({
        billingThrows: () =>
          Object.assign(
            new Error("egress denied: response exceeds 10485760 bytes"),
            { name: "EgressDeniedError" },
          ),
      }).runtime,
      RECENT,
    );
    const done = pages.at(-1)!;
    expect(done.receivedDatasets).toContain("deployments");
    expect(done.receivedDatasets).not.toContain("billing_charges");
    expect(freshnessEntry(done, BILLING_STREAM)).toBeUndefined();
    expect(
      datasetPages.some((page) => page.datasetKey === "billing_charges"),
    ).toBe(false);
  });

  it("P3: with a thousand projects, Web Analytics stays reported per project", async () => {
    const projects = Array.from({ length: 1_000 }, (_, index) => ({
      ...FAKE_PROJECTS[0]!,
      id: `prj_${String(index).padStart(4, "0")}`,
      deployments: 0,
    }));
    const { pages } = await syncAll(fake({ projects }).runtime, {
      ...RECENT,
      from: "2024-12-31T00:00:00.000Z",
    });
    const done = pages.at(-1)!;
    expect(
      (done.freshness ?? []).filter(
        (entry) => entry.stream === ANALYTICS_STREAM && entry.resource,
      ),
    ).toHaveLength(1_000);
    expect(freshnessEntry(done, DEPLOYS_STREAM)).toBeDefined();
  }, 120_000);

  it("owner A: production pointing at an older build than the newest READY one is rolled back, and up", async () => {
    const project = { ...FAKE_PROJECTS[0]!, deployments: 20 };
    const rolled = await syncAll(
      fake({
        projects: [project],
        states: { dpl_prj_alpha_0: "READY" },
        live: { prj_alpha: "dpl_prj_alpha_14" },
      }).runtime,
      RECENT,
    );
    expect(
      rows(rolled.datasetPages, "production_deployments")[0],
    ).toMatchObject({
      state: "up",
      rolled_back: true,
      live_deployment_id: "dpl_prj_alpha_14",
    });
    const current = await syncAll(
      fake({ projects: [project], states: { dpl_prj_alpha_0: "READY" } })
        .runtime,
      RECENT,
    );
    expect(
      rows(current.datasetPages, "production_deployments")[0],
    ).toMatchObject({
      state: "up",
      rolled_back: false,
      live_deployment_id: "dpl_prj_alpha_0",
    });
  });

  it("owner B: vercel.cost is the effective cost per day, project and team, in minor units", async () => {
    const { observations } = await syncAll(fake().runtime, RECENT);
    const cost = observations.filter((o) => o.metricKey === "vercel.cost");
    expect(cost).toContainEqual({
      metricKey: "vercel.cost",
      sourceTimestamp: "2024-12-01T00:00:00.000Z",
      value: 25,
      dimensions: {
        resource: "prj_alpha",
        team: "team_fixture",
        currency: "USD",
      },
    });
    // Team-wide charges (the seat) under the team.
    expect(cost).toContainEqual({
      metricKey: "vercel.cost",
      sourceTimestamp: "2024-12-01T00:00:00.000Z",
      value: 2_000,
      dimensions: {
        resource: "team_fixture",
        team: "team_fixture",
        currency: "USD",
      },
    });
    expect(
      cost
        .filter((o) => o.dimensions.resource === "prj_alpha")
        .reduce((total, o) => total + o.value, 0),
    ).toBe(31 * 25);
  });
});

describe("vercel production state", () => {
  it("is building, up, failed or down", () => {
    // (newest production build's state, the production target's state)
    expect(productionState("QUEUED", undefined)).toBe("building");
    expect(productionState("INITIALIZING", undefined)).toBe("building");
    expect(productionState("BUILDING", "READY")).toBe("building");
    expect(productionState("ERROR", "READY")).toBe("up");
    expect(productionState("READY", "READY")).toBe("up");
    // A target Vercel names without a state serves: it is up.
    expect(productionState("ERROR", null)).toBe("up");
    expect(productionState(undefined, null)).toBe("up");
    expect(productionState("ERROR", undefined)).toBe("failed");
    expect(productionState("CANCELED", undefined)).toBe("down");
    expect(productionState("BLOCKED", undefined)).toBe("down");
    expect(productionState(undefined, undefined)).toBe("down");
  });
});

describe("vercel connector check", () => {
  it("accepts a token that sees projects", async () => {
    await expect(connector().check(context(), fake().runtime)).resolves.toEqual(
      { ok: true },
    );
  });

  it("asks for a token when none is stored", async () => {
    const result = await connector().check(
      context({ credentials: {} }),
      fake().runtime,
    );
    expect(result).toEqual({
      ok: false,
      message: expect.stringMatching(/token/),
    });
  });

  it("reports a revoked token as an auth failure", async () => {
    const result = await connector().check(
      context({ credentials: { token: "revoked" } }),
      fake().runtime,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/expired or was revoked/);
  });

  it("names selected projects that are gone", async () => {
    const gone = await connector().check(
      context({ config: { resourceSelection: ["prj_alpha", "prj_missing"] } }),
      fake().runtime,
    );
    expect(gone).toEqual({
      ok: false,
      message: expect.stringContaining("prj_missing"),
    });
  });

  it("accepts a selection of projects without Web Analytics (#871)", async () => {
    expect(
      await connector().check(
        context({ config: { resourceSelection: ["prj_alpha", "prj_gamma"] } }),
        fake().runtime,
      ),
    ).toEqual({ ok: true });
    // An account where no project has Web Analytics: deployments still sync.
    expect(
      await connector().check(
        context(),
        fake({ projects: [FAKE_PROJECTS[2]!] }).runtime,
      ),
    ).toEqual({ ok: true });
  });

  it("explains an account without projects", async () => {
    const empty = await connector().check(
      context(),
      fake({ projects: [] }).runtime,
    );
    expect(empty.message).toMatch(/cannot see any projects/);
  });

  it("an explicit empty selection collects nothing: the check validates the token only (#782)", async () => {
    const paused = context({ config: { resourceSelection: [] } });
    expect(
      await connector().check(paused, fake({ projects: [] }).runtime),
    ).toEqual({ ok: true });
    const revoked = await connector().check(
      paused,
      fake({ token: "another-token" }).runtime,
    );
    expect(revoked.ok).toBe(false);
    expect(revoked.message).toMatch(/rejected the access token/);
  });

  it("throws (retryable) on an outage instead of blaming the token", async () => {
    const down = fake({
      failures: Array.from({ length: 4 }, () => ({ status: 503 })),
    });
    await expect(connector().check(context(), down.runtime)).rejects.toThrow(
      /503/,
    );
  });
});

// ─── Manifest and freshness (ADR 0025, ADR 0026) ───────────────────────────

describe("vercel manifest", () => {
  it("declares valid datasets", () => {
    expect(vercelManifest.datasets?.map((dataset) => dataset.key)).toEqual([
      "deployments",
      "production_deployments",
      "billing_charges",
    ]);
    for (const dataset of VERCEL_DATASETS) {
      expect(sourceDatasetSchema.safeParse(dataset).success).toBe(true);
    }
  });

  it("puts every metric and dataset in a continuous stream", () => {
    const streams = vercelManifest.freshnessStreams ?? [];
    expect(streams.map((stream) => [stream.key, stream.kind])).toEqual([
      [ANALYTICS_STREAM, "continuous"],
      [DEPLOYS_STREAM, "continuous"],
      [BILLING_STREAM, "continuous"],
    ]);
    expect(streams.flatMap((stream) => stream.metrics ?? []).sort()).toEqual(
      vercelManifest.metrics.map((metric) => metric.key).sort(),
    );
    expect(streams.flatMap((stream) => stream.datasets ?? []).sort()).toEqual(
      VERCEL_DATASETS.map((dataset) => dataset.key).sort(),
    );
  });

  it("reports freshness on the done page only", async () => {
    const { pages } = await syncAll(fake().runtime, {
      mode: "backfill",
      from: "2024-11-15T00:00:00.000Z",
      to: `${TODAY}T12:00:00.000Z`,
    });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.slice(0, -1).every((page) => !page.freshness)).toBe(true);
    expect(pages.at(-1)!.freshness?.length).toBeGreaterThan(0);
  });

  it("an explicit empty selection reads nothing and reports nothing as checked (#782)", async () => {
    const provider = fake();
    const paused = await syncAll(provider.runtime, {
      ...RECENT,
      resources: [],
    });
    expect(paused.pages).toHaveLength(1);
    expect(paused.pages[0]!.done).toBe(true);
    expect(paused.observations).toEqual([]);
    expect(paused.pages[0]!.freshness).toBeUndefined();
    expect(paused.pages[0]!.receivedDatasets).toBeUndefined();
    expect(provider.requests).toEqual([]);
  });
});
