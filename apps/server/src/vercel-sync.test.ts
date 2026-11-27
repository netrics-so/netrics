import { executeSync } from "@netrics/connector-runtime";
import type {
  ConnectionContext,
  Connector,
  ConnectorResponse,
  ConnectorRuntime,
  DatasetPage,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";
import { RateLimitedError } from "@netrics/connector-sdk";
import { createVercelConnector, vercelManifest } from "@netrics/connectors";
import {
  createDatabase,
  createRawSqlClient,
  ingestDatasetPage,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// Whole Vercel syncs through the host's own result validation
// (executeSync → validateSyncResult, ADR 0026 §7), which the connectors
// package cannot import (#871, the lessons of #881). The connector talks to
// a small offline stand-in for Vercel's REST API.

const NOW = "2024-12-31T13:00:00.000Z";
const TOKEN = "vercel-server-test-token";
const DAY_MS = 24 * 60 * 60 * 1000;

interface Project {
  id: string;
  analytics: boolean;
  deployments: number;
  /** Minutes between two deployments, back from NOW. */
  every?: number;
}

function answer(status: number, body: unknown): ConnectorResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers: { "content-type": "application/json" },
    text: () => text,
    json: () => JSON.parse(text) as unknown,
    bytes: () => new TextEncoder().encode(text),
  };
}

const STATES = ["READY", "ERROR", "BUILDING", "CANCELED", "QUEUED"];

function fakeVercel(projects: Project[], skus = 2): ConnectorRuntime {
  const deploymentsOf = (project: Project) =>
    Array.from({ length: project.deployments }, (_, index) => {
      const created =
        Date.parse(NOW) - 60_000 - index * (project.every ?? 60) * 60_000;
      const state = STATES[index % STATES.length]!;
      return {
        uid: `dpl_${project.id}_${index}`,
        projectId: project.id,
        name: project.id,
        url: `${project.id}-${index}.vercel.app`,
        created,
        createdAt: created,
        buildingAt: created + 1_000,
        ...(state === "READY"
          ? { ready: created + 30_000, readySubstate: "PROMOTED" }
          : {}),
        state,
        readyState: state,
        target: index % 2 === 0 ? "production" : null,
        meta: { githubCommitRef: "main" },
      };
    });
  return {
    signal: new AbortController().signal,
    fetch: async (raw, init) => {
      if (init?.headers?.authorization !== `Bearer ${TOKEN}`) {
        return answer(401, { error: { code: "forbidden" } });
      }
      const url = new URL(raw);
      const query = url.searchParams;
      const single = /^\/v9\/projects\/([^/]+)$/.exec(url.pathname);
      if (single) {
        const project = projects.find((entry) => entry.id === single[1])!;
        const live = deploymentsOf(project).find(
          (deployment) =>
            deployment.target === "production" &&
            deployment.readyState === "READY",
        );
        return answer(200, {
          id: project.id,
          name: project.id,
          accountId: "team_server",
          targets: live
            ? {
                production: {
                  id: live.uid,
                  createdAt: live.created,
                  readyAt: live.ready,
                  readyState: "READY",
                  url: live.url,
                },
              }
            : {},
        });
      }
      if (url.pathname === "/v10/projects") {
        const start = Number(query.get("from") ?? "0");
        const page = projects.slice(start, start + 100);
        return answer(200, {
          projects: page.map((project) => ({
            id: project.id,
            name: project.id,
            accountId: "team_server",
            ...(project.analytics
              ? { webAnalytics: { id: "wa", enabledAt: 1 } }
              : {}),
          })),
          pagination: {
            count: page.length,
            next: start + 100 < projects.length ? start + 100 : null,
          },
        });
      }
      if (url.pathname === "/v7/deployments") {
        const project = projects.find(
          (entry) => entry.id === query.get("projectId"),
        )!;
        const since = Number(query.get("since") ?? "-1");
        const until = Number(query.get("until") ?? Number.POSITIVE_INFINITY);
        const target = query.get("target");
        const limit = Number(query.get("limit"));
        const matching = deploymentsOf(project).filter(
          (deployment) =>
            deployment.created > since &&
            deployment.created < until &&
            (target === null || deployment.target === target),
        );
        const page = matching.slice(0, limit);
        return answer(200, {
          deployments: page,
          pagination: {
            count: page.length,
            next:
              matching.length > limit ? page[page.length - 1]!.created : null,
          },
        });
      }
      if (url.pathname.startsWith("/v1/query/web-analytics/")) {
        const since = Date.parse(`${query.get("since")}T00:00:00.000Z`);
        const until = Date.parse(`${query.get("until")}T00:00:00.000Z`);
        const data = [];
        for (let day = since; day <= until; day += DAY_MS) {
          const timestamp = new Date(day).toISOString();
          data.push(
            url.pathname.includes("events")
              ? { timestamp, eventName: "Signup", count: 3 }
              : {
                  timestamp,
                  visitors: 10,
                  pageviews: 20,
                  route: "/",
                  country: "DE",
                },
          );
        }
        return answer(200, { data });
      }
      if (url.pathname === "/v1/billing/charges") {
        const lines = projects.flatMap((project) =>
          Array.from({ length: skus }, (_, sku) =>
            JSON.stringify({
              BilledCost: 0.5,
              EffectiveCost: 0.5,
              BillingCurrency: "USD",
              ChargeCategory: "Usage",
              ChargePeriodStart: "2024-12-01T00:00:00.000Z",
              ServiceName: `Product ${sku}`,
              SkuId: `sku-${sku}`,
              SubAccountId: "team_server",
              Tags: { ProjectId: project.id, ProjectName: project.id },
            }),
          ),
        );
        return answer(200, lines.join("\n"));
      }
      throw new Error(`unexpected request ${url.pathname}`);
    },
  };
}

/** The connector, reading Vercel through the offline stand-in. */
function vercelWith(
  projects: Project[],
  skus?: number,
  wrap: (runtime: ConnectorRuntime) => ConnectorRuntime = (runtime) => runtime,
  now: () => number = () => Date.parse(NOW),
): Connector {
  const connector = createVercelConnector({ now, sleep: async () => {} });
  const runtime = wrap(fakeVercel(projects, skus));
  return {
    ...connector,
    sync: (ctx, request) => connector.sync(ctx, request, runtime),
  };
}

async function syncThroughHost(
  connector: Connector,
  request: SyncRequest,
  cursor?: string,
): Promise<SyncResult[]> {
  const context: ConnectionContext = {
    connectionId: "vercel-host-test",
    config: {},
    credentials: { token: TOKEN },
  };
  const results: SyncResult[] = [];
  for (let guard = 0; guard < 2_000; guard += 1) {
    const result = await executeSync(connector, context, {
      ...request,
      ...(cursor ? { cursor } : {}),
    });
    results.push(result);
    if (result.done) return results;
    cursor = result.nextCursor;
  }
  throw new Error("the sync did not finish");
}

function rows(results: SyncResult[], key: string) {
  return results
    .flatMap((result) => result.datasetPages ?? [])
    .filter((page) => page.datasetKey === key)
    .flatMap((page) => page.records);
}

/** Every refresh chain is unbroken and completed exactly once. */
function expectChains(results: SyncResult[]) {
  const chains = new Map<string, DatasetPage[]>();
  for (const page of results.flatMap((result) => result.datasetPages ?? [])) {
    chains.set(page.refreshKey, [...(chains.get(page.refreshKey) ?? []), page]);
  }
  for (const [key, pages] of chains) {
    expect(pages[0]!.previousPageKey, key).toBeNull();
    pages.slice(1).forEach((page, index) => {
      expect(page.previousPageKey).toBe(pages[index]!.pageKey);
    });
    expect(pages.filter((page) => page.complete)).toHaveLength(1);
    expect(pages.at(-1)!.complete).toBe(true);
  }
}

describe("Vercel syncs through the host's validation (#871)", () => {
  it("accepts an incremental sync of a project with and one without Web Analytics", async () => {
    const results = await syncThroughHost(
      vercelWith([
        { id: "prj_site", analytics: true, deployments: 6 },
        { id: "prj_api", analytics: false, deployments: 4 },
      ]),
      { mode: "incremental", from: "2024-12-29T00:00:00.000Z", to: NOW },
    );
    const last = results.at(-1)!;
    expect([...(last.receivedDatasets ?? [])].sort()).toEqual([
      "billing_charges",
      "deployments",
      "production_deployments",
    ]);
    expect(rows(results, "deployments")).toHaveLength(10);
    expect(
      rows(results, "production_deployments").map(
        (record) => record.values.project_id,
      ),
    ).toEqual(["prj_site", "prj_api"]);
    expect(
      last.freshness?.filter((entry) => entry.stream === "web_analytics"),
    ).toEqual([{ stream: "web_analytics", resource: "prj_site" }]);
    expectChains(results);
  });

  it("accepts many projects and a large deployment history", async () => {
    const projects: Project[] = Array.from({ length: 240 }, (_, index) => ({
      id: `prj_${index}`,
      analytics: index % 3 !== 0,
      deployments: index === 0 ? 4_000 : 3,
      every: index === 0 ? 20 : 600,
    }));
    const results = await syncThroughHost(vercelWith(projects, 15), {
      mode: "incremental",
      from: "2024-12-29T00:00:00.000Z",
      to: NOW,
    });
    expect(results.length).toBeGreaterThan(2);
    const deployments = rows(results, "deployments");
    // prj_0 deploys every 20 minutes: 2.5 days of the window hold 180.
    const busy = deployments.filter(
      (record) => record.values.project_id === "prj_0",
    );
    expect(
      new Set(busy.map((record) => record.values.deployment_id)).size,
    ).toBe(busy.length);
    expect(busy.length).toBeGreaterThan(150);
    expect(rows(results, "production_deployments")).toHaveLength(240);
    expect(rows(results, "billing_charges")).toHaveLength(240 * 15);
    expect(results.at(-1)!.receivedDatasets).toContain("billing_charges");
    expectChains(results);
  });

  it("accepts a 90-day deployment backfill of a busy project", async () => {
    const results = await syncThroughHost(
      vercelWith([
        { id: "prj_busy", analytics: false, deployments: 6_000, every: 15 },
      ]),
      { mode: "backfill", from: "2024-01-01T00:00:00.000Z", to: NOW },
    );
    const deployments = rows(results, "deployments");
    expect(deployments).toHaveLength(6_000);
    for (const result of results) {
      expect((result.datasetPages ?? []).length).toBeLessThanOrEqual(20);
    }
    expectChains(results);
  });
});

// The follow-ups of #894 through the host's validation.
describe("Vercel follow-ups through the host's validation (#894)", () => {
  const request: SyncRequest = {
    mode: "incremental",
    from: "2024-12-29T00:00:00.000Z",
    to: NOW,
  };
  const context: ConnectionContext = {
    connectionId: "vercel-host-test",
    config: {},
    credentials: { token: TOKEN },
  };

  it("publishes the month's cost once, every day, adding up to the rounded month", async () => {
    const results = await syncThroughHost(
      vercelWith([
        { id: "prj_site", analytics: true, deployments: 2 },
        { id: "prj_api", analytics: false, deployments: 2 },
      ]),
      request,
    );
    const withCost = results.filter((result) =>
      result.observations.some((o) => o.metricKey === "vercel.cost"),
    );
    // One result carries the whole month, after every day was read.
    expect(withCost).toHaveLength(1);
    const cost = withCost[0]!.observations.filter(
      (o) => o.metricKey === "vercel.cost",
    );
    for (const project of ["prj_site", "prj_api"]) {
      const own = cost.filter((o) => o.dimensions.resource === project);
      expect(own).toHaveLength(31);
      // Two SKUs of 0.50 USD on the 1st: 100 cents, zero after.
      expect(own.reduce((total, o) => total + o.value, 0)).toBe(100);
      expect(own[0]).toMatchObject({
        sourceTimestamp: "2024-12-01T00:00:00.000Z",
        value: 100,
      });
    }
  });

  it("a rate limit that ended a page holds for the next page", async () => {
    let deployments = 0;
    const limited = (runtime: ConnectorRuntime): ConnectorRuntime => ({
      ...runtime,
      fetch: async (raw, init) => {
        const url = new URL(raw);
        if (url.pathname === "/v7/deployments" && (deployments += 1) === 3) {
          return {
            ...answer(429, { error: { code: "rate_limited" } }),
            headers: { "retry-after": "3600" },
          };
        }
        return runtime.fetch(raw, init);
      },
    });
    const vercel = vercelWith(
      [{ id: "prj_site", analytics: false, deployments: 2 }],
      1,
      limited,
    );
    const first = await executeSync(vercel, context, request);
    expect(first.done).toBe(false);
    const asked = deployments;
    const error = await executeSync(vercel, context, {
      ...request,
      cursor: first.nextCursor!,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).retryAt).toBe(
      new Date(Date.parse(NOW) + 3600 * 1000).toISOString(),
    );
    expect(deployments).toBe(asked);
    // After the reset the run continues and completes.
    const later = vercelWith(
      [{ id: "prj_site", analytics: false, deployments: 2 }],
      1,
      undefined,
      () => Date.parse(NOW) + 3601 * 1000,
    );
    const rest = await syncThroughHost(later, request, first.nextCursor);
    expect(rest.at(-1)!.done).toBe(true);
  });

  it("an analytics answer of JSON null is repeated, not taken as no data", async () => {
    let nulled = false;
    let visits = 0;
    const nulling = (runtime: ConnectorRuntime): ConnectorRuntime => ({
      ...runtime,
      fetch: async (raw, init) => {
        const url = new URL(raw);
        if (url.pathname === "/v1/query/web-analytics/visits/aggregate") {
          if (url.searchParams.getAll("by").join() === "day") visits += 1;
          if (!nulled) {
            nulled = true;
            return answer(200, "null");
          }
        }
        return runtime.fetch(raw, init);
      },
    });
    const results = await syncThroughHost(
      vercelWith(
        [{ id: "prj_site", analytics: true, deployments: 2 }],
        1,
        nulling,
      ),
      request,
    );
    expect(visits).toBe(2);
    const pageviews = results
      .flatMap((result) => result.observations)
      .filter((o) => o.metricKey === "vercel.pageviews");
    expect(pageviews).toHaveLength(3);
    expect(results.at(-1)!.freshness).toContainEqual({
      stream: "web_analytics",
      resource: "prj_site",
    });
  });
});

// The follow-ups of #905 through the host's validation.
describe("Vercel follow-ups through the host's validation (#905)", () => {
  const request: SyncRequest = {
    mode: "incremental",
    from: "2024-12-29T00:00:00.000Z",
    to: NOW,
  };
  const costOf = (results: SyncResult[], resource: string) =>
    results
      .flatMap((result) => result.observations)
      .filter(
        (o) =>
          o.metricKey === "vercel.cost" && o.dimensions.resource === resource,
      );
  const total = (results: SyncResult[], resource: string) =>
    costOf(results, resource).reduce((sum, o) => sum + o.value, 0);
  /** The billing export, its lines changed by `edit`. */
  const billing =
    (edit: (lines: string[]) => string[]) =>
    (runtime: ConnectorRuntime): ConnectorRuntime => ({
      ...runtime,
      fetch: async (raw, init) => {
        const response = await runtime.fetch(raw, init);
        if (new URL(raw).pathname !== "/v1/billing/charges") return response;
        const lines = edit(response.text().split("\n"));
        return answer(response.status, lines.join("\n"));
      },
    });
  const projects: Project[] = [
    { id: "prj_site", analytics: true, deployments: 2 },
    { id: "prj_api", analytics: false, deployments: 2 },
  ];

  it("zeroes a project's cost the export no longer has after a history reload", async () => {
    const first = await syncThroughHost(vercelWith(projects), request);
    expect(total(first, "prj_api")).toBe(100);
    // A fresh backfill: no cursor, the stored one as the baseline only.
    const reload = await syncThroughHost(
      vercelWith(
        projects,
        undefined,
        billing((lines) => lines.filter((line) => !line.includes("prj_api"))),
      ),
      {
        ...request,
        mode: "backfill",
        previousCursor: first.at(-1)!.nextCursor!,
      },
    );
    const api = costOf(reload, "prj_api");
    expect(api).toHaveLength(31);
    expect(api.every((o) => o.value === 0)).toBe(true);
    expect(total(reload, "prj_site")).toBe(100);
  });

  it("rounds only the total of charges with more than six decimals", async () => {
    const results = await syncThroughHost(
      vercelWith(
        projects,
        1,
        billing((lines) =>
          lines.map((line) =>
            line.replace('"EffectiveCost":0.5', '"EffectiveCost":0.0049996'),
          ),
        ),
      ),
      request,
    );
    expect(costOf(results, "prj_site")).toHaveLength(31);
    expect(total(results, "prj_site")).toBe(0);
  });

  it("reads a charge's cost from the export's text, not a double (#925)", async () => {
    const results = await syncThroughHost(
      vercelWith(
        projects,
        1,
        billing((lines) =>
          lines.map((line) =>
            line.replace(
              '"EffectiveCost":0.5',
              '"EffectiveCost":1.00499999999999999',
            ),
          ),
        ),
      ),
      request,
    );
    // As a double it is 1.005: 101 cents.
    expect(total(results, "prj_site")).toBe(100);
  });

  it("reports the completed deploy checks when a project vanishes after the listing", async () => {
    // 1,000 projects with Web Analytics: the listing alone does not fit
    // per-project deployment entries; one vanishes, the 999 others fit.
    const many: Project[] = Array.from({ length: 1_000 }, (_, index) => ({
      id: `prj_${String(index).padStart(4, "0")}`,
      analytics: true,
      deployments: 0,
    }));
    const vanishing = (runtime: ConnectorRuntime): ConnectorRuntime => ({
      ...runtime,
      fetch: async (raw, init) =>
        raw.includes("/v7/deployments") && raw.includes("projectId=prj_0005")
          ? answer(404, { error: { code: "not_found" } })
          : runtime.fetch(raw, init),
    });
    const results = await syncThroughHost(vercelWith(many, 1, vanishing), {
      ...request,
      from: "2024-12-31T00:00:00.000Z",
    });
    const freshness = results.at(-1)!.freshness ?? [];
    const deploys = freshness.filter((entry) => entry.stream === "deploys");
    expect(deploys).toHaveLength(999);
    expect(deploys.every((entry) => entry.resource !== undefined)).toBe(true);
    expect(
      freshness.filter((entry) => entry.stream === "web_analytics"),
    ).toHaveLength(999);
  }, 240_000);
});

// The pages of whole runs stored the way the host stores them (#889
// review): a run publishes one generation of the deployments dataset,
// whatever the number of projects, so a poll writes the dataset once.
describe("Vercel datasets stored by the host (#889)", () => {
  let db: Database;
  let admin: Sql;
  let workspaceId: string;
  let connectionId: string;

  beforeAll(async () => {
    const testDb = await createTestDatabase();
    db = createDatabase(testDb.appUrl);
    admin = createRawSqlClient(testDb.adminUrl, { max: 1 });
    const [workspace] = await admin`
      insert into workspaces (name) values ('Vercel') returning id`;
    workspaceId = workspace!.id as string;
    const [connection] = await admin`
      insert into connections (workspace_id, connector_id, name)
      values (${workspaceId}, 'vercel', 'Vercel') returning id`;
    connectionId = connection!.id as string;
  }, TEST_DATABASE_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 }).catch(() => undefined);
    await admin?.end({ timeout: 5 }).catch(() => undefined);
  });

  async function store(results: SyncResult[], now: Date) {
    for (const page of results.flatMap((result) => result.datasetPages ?? [])) {
      const definition = vercelManifest.datasets!.find(
        (dataset) => dataset.key === page.datasetKey,
      )!;
      await withWorkspace(db, { workspaceId }, (tx) =>
        ingestDatasetPage(tx, {
          workspaceId,
          connectionId,
          definition,
          page,
          now,
        }),
      );
    }
  }

  async function stored() {
    const [row] = await admin`
      select count(distinct g.id)::int as generations,
             count(r.*)::int as rows
      from data_datasets d
      join data_generations g on g.dataset_id = d.id
      left join data_records r on r.generation_id = g.id
      where d.connection_id = ${connectionId} and d.key = 'deployments'`;
    return row as { generations: number; rows: number };
  }

  it("writes one generation of deployments per run", async () => {
    const projects: Project[] = Array.from({ length: 30 }, (_, index) => ({
      id: `prj_${index}`,
      analytics: false,
      deployments: 5,
      every: 300,
    }));
    const request: SyncRequest = {
      mode: "incremental",
      from: "2024-12-29T00:00:00.000Z",
      to: NOW,
    };
    const first = await syncThroughHost(vercelWith(projects), request);
    await store(first, new Date(NOW));
    expect(await stored()).toEqual({ generations: 1, rows: 150 });
    // The next poll: its window ends a minute later.
    const second = await syncThroughHost(
      vercelWith(projects),
      { ...request, to: new Date(Date.parse(NOW) + 60_000).toISOString() },
      first.at(-1)!.nextCursor,
    );
    await store(second, new Date(Date.parse(NOW) + 60_000));
    // The second run's generation holds the 150 rows once: not one
    // generation (and copy of the dataset) per project.
    expect(await stored()).toEqual({ generations: 2, rows: 300 });
  });
});
