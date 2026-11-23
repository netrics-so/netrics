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
  validateDatasetPage,
} from "@netrics/connector-sdk";
import {
  expectValidFreshness,
  freshnessEntry,
  runConnectorContractTests,
} from "@netrics/connector-sdk/testing";
import { describe, expect, it } from "vitest";

import { RailwayApiError, assertReadOnly, graphQlError } from "./api.js";
import { USD_PER_UNIT, usageCostUsd } from "./cost.js";
import {
  RAILWAY_DATASETS,
  deploymentRecord,
  serviceState,
} from "./datasets.js";
import {
  COST_STREAM,
  DEPLOYMENT_STATUSES,
  DEPLOYS_STREAM,
  METRICS,
  TOKEN_REJECTED_CODE,
  TOKEN_REJECTED_MESSAGE,
  WORKSPACE_DENIED_CODE,
  createRailwayConnector,
  railwayManifest,
} from "./index.js";
import { deploymentsSchema } from "./queries.js";
import {
  FAKE_TOKEN,
  createFakeRailway,
  deploymentsEvery,
  fakeProjects,
  fixture,
  type FakeRailwayOptions,
} from "./test-helpers.js";

const NOW = "2024-01-10T12:00:00.000Z";
const noSleep = async () => {};
const clock = () => Date.parse(NOW);
const DAY_MS = 24 * 60 * 60 * 1000;

function connector() {
  return createRailwayConnector({ now: clock, sleep: noSleep });
}

function context(
  overrides: Partial<ConnectionContext> = {},
): ConnectionContext {
  return {
    connectionId: "railway-test",
    config: {},
    credentials: { token: FAKE_TOKEN },
    ...overrides,
  };
}

function fake(options: FakeRailwayOptions = {}) {
  return createFakeRailway(options);
}

const WINDOW: SyncRequest = {
  mode: "backfill",
  from: "2024-01-01T00:00:00.000Z",
  to: NOW,
};

/** Runs every page of one sync the way the engine does. */
async function syncAll(
  runtime: ConnectorRuntime,
  request: SyncRequest = WINDOW,
  ctx = context(),
): Promise<{
  pages: SyncResult[];
  observations: Observation[];
  datasetPages: DatasetPage[];
  last: SyncResult;
}> {
  const pages: SyncResult[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 200; guard += 1) {
    const page = await connector().sync(
      ctx,
      { ...request, ...(cursor ? { cursor } : {}) },
      runtime,
    );
    pages.push(page);
    if (page.done) break;
    expect(page.nextCursor).not.toBe(cursor);
    cursor = page.nextCursor;
  }
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

runConnectorContractTests(connector(), {
  context: context(),
  runtime: fake().runtime,
  cursorOrder: "changing",
});

describe("Railway manifest", () => {
  it("is a read-only connector of Railway's GraphQL host", () => {
    expect(railwayManifest.outboundDomains).toEqual(["backboard.railway.com"]);
    expect(railwayManifest.datasets?.map((dataset) => dataset.key)).toEqual([
      "deployments",
      "service_states",
      "project_usage",
    ]);
  });
});

describe("Railway check", () => {
  it("accepts an account token", async () => {
    const { runtime, requests } = fake();
    expect(await connector().check(context(), runtime)).toEqual({ ok: true });
    expect(requests.map((request) => request.operation)).toEqual([
      "netricsMe",
      "netricsProjects",
    ]);
    expect(requests[1]!.variables).toMatchObject({ first: 1 });
  });

  it("accepts a workspace token with its workspace ID", async () => {
    const { runtime, requests } = fake({ tokenKind: "workspace" });
    const result = await connector().check(
      context({ config: { workspaceId: "ws-fixture" } }),
      runtime,
    );
    expect(result).toEqual({ ok: true });
    expect(requests[0]!.operation).toBe("netricsWorkspace");
  });

  it("asks for the workspace ID when `me` is refused", async () => {
    const { runtime } = fake({ tokenKind: "workspace" });
    const result = await connector().check(context(), runtime);
    expect(result).toEqual({
      ok: false,
      code: TOKEN_REJECTED_CODE,
      message: TOKEN_REJECTED_MESSAGE,
    });
  });

  it("names a wrong token without echoing it", async () => {
    const { runtime } = fake({ token: "the-real-one" });
    const result = await connector().check(context(), runtime);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(TOKEN_REJECTED_CODE);
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
  });

  it("names a workspace the token cannot read", async () => {
    const { runtime } = fake({ tokenKind: "workspace" });
    const result = await connector().check(
      context({ config: { workspaceId: "ws-other" } }),
      runtime,
    );
    expect(result).toMatchObject({ ok: false, code: WORKSPACE_DENIED_CODE });
  });

  it("asks for a token when none is stored", async () => {
    const { runtime, requests } = fake();
    const result = await connector().check(
      context({ credentials: {} }),
      runtime,
    );
    expect(result.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });
});

describe("Railway discover", () => {
  it("lists projects, and services and environments as dimensions", async () => {
    const resources = await connector().discover(context(), fake().runtime);
    expect(
      resources.map((resource) => [resource.kind, resource.id, resource.name]),
    ).toEqual([
      ["project", "prj-api", "api"],
      ["service", "svc-web", "web"],
      ["service", "svc-worker", "worker"],
      ["environment", "env-production", "production"],
      ["environment", "env-pr-12", "pr-12"],
      ["project", "prj-site", "site"],
      ["service", "svc-site", "site"],
      ["environment", "env-site-production", "production"],
      ["project", "prj-empty", "empty"],
      ["environment", "env-empty-production", "production"],
    ]);
  });

  it("pages through projects", async () => {
    const { runtime, requests } = fake({ maxProjectsPage: 1 });
    const resources = await connector().discover(context(), runtime);
    expect(
      resources.filter((resource) => resource.kind === "project"),
    ).toHaveLength(3);
    expect(
      requests.filter((request) => request.operation === "netricsProjects"),
    ).toHaveLength(3);
  });
});

describe("Railway sync", () => {
  it("reads deployments, service states and cost into valid pages", async () => {
    const { runtime, requests } = fake();
    const { pages, observations, datasetPages, last } = await syncAll(runtime);

    // Every page fits its dataset's schema, and each refresh is one chain
    // that ends with a complete page.
    const schemas = new Map(
      RAILWAY_DATASETS.map((dataset) => [dataset.key, dataset]),
    );
    for (const page of datasetPages) {
      expect(() =>
        validateDatasetPage(schemas.get(page.datasetKey)!, page),
      ).not.toThrow();
    }
    for (const key of schemas.keys()) {
      const chain = datasetPages.filter((page) => page.datasetKey === key);
      expect(chain.length, key).toBeGreaterThan(0);
      chain.forEach((page, index) => {
        expect(page.previousPageKey).toBe(
          index === 0 ? null : chain[index - 1]!.pageKey,
        );
        expect(page.complete).toBe(index === chain.length - 1);
        expect(page.refreshKey).toBe(chain[0]!.refreshKey);
      });
    }
    expect(last.receivedDatasets).toEqual([
      "deployments",
      "service_states",
      "project_usage",
    ]);
    for (const page of pages) expectValidFreshness(railwayManifest, page);

    // Deployments created in the window only (the fake goes back further).
    const deployments = rowsOf(datasetPages, "deployments");
    const projects = fakeProjects();
    const expected = projects
      .flatMap((project) => project.deployments)
      .filter(
        (deployment) =>
          Date.parse(deployment.createdAt) >= Date.parse(WINDOW.from) &&
          Date.parse(deployment.createdAt) < Date.parse(WINDOW.to),
      );
    expect(deployments.map((row) => row.deployment_id).sort()).toEqual(
      expected.map((deployment) => deployment.id).sort(),
    );
    const failedDeploy = deployments.find(
      (row) => row.deployment_id === "dep-web-0002",
    )!;
    expect(failedDeploy).toMatchObject({
      status: "FAILED",
      failed: true,
      service_name: "web",
      environment_name: "production",
      duration_seconds: 95,
    });
    const crashed = deployments.find(
      (row) => row.deployment_id === "dep-worker-0000",
    )!;
    expect(crashed).toMatchObject({
      status: "CRASHED",
      failed: true,
      finished_at: null,
      duration_seconds: null,
    });

    // The current state of every service in every lasting environment.
    const states = rowsOf(datasetPages, "service_states");
    expect(
      states.map((row) => [row.service_name, row.environment_name, row.state]),
    ).toEqual([
      ["web", "production", "up"],
      ["worker", "production", "failed"],
      ["site", "production", "building"],
    ]);

    // Daily deployment counts add up to the deployments of the window.
    const counts = observations.filter(
      (observation) => observation.metricKey === METRICS.deployments,
    );
    expect(counts.reduce((sum, item) => sum + item.value, 0)).toBe(
      expected.length,
    );
    const failed = observations.filter(
      (observation) => observation.metricKey === METRICS.failedDeployments,
    );
    expect(failed.reduce((sum, item) => sum + item.value, 0)).toBe(
      expected.filter((deployment) =>
        ["FAILED", "CRASHED"].includes(deployment.status),
      ).length,
    );
    expect(
      counts.find(
        (item) =>
          item.sourceTimestamp === "2024-01-10T00:00:00.000Z" &&
          item.dimensions.resource === "prj-site",
      ),
    ).toMatchObject({
      value: 1,
      dimensions: { service: "svc-site", environment: "env-site-production" },
    });

    // Daily cost adds up to the month so far at list prices.
    const cost = observations.filter(
      (observation) =>
        observation.metricKey === METRICS.cost &&
        observation.dimensions.resource === "prj-api",
    );
    expect(cost).toHaveLength(10);
    const minutes = (Date.parse(NOW) - Date.parse("2024-01-01")) / 60_000;
    const monthSoFar = usageCostUsd({
      CPU_USAGE: 0.5 * minutes,
      MEMORY_USAGE_GB: 1 * minutes,
      NETWORK_TX_GB: 0.001 * minutes,
      DISK_USAGE_GB: 2 * minutes,
    });
    expect(cost.reduce((sum, item) => sum + item.value, 0)).toBe(
      Math.round(monthSoFar * 100),
    );
    const usage = rowsOf(datasetPages, "project_usage");
    expect(usage.find((row) => row.project_id === "prj-api")).toMatchObject({
      project_name: "api",
      month: "2024-01-01",
      as_of: NOW,
      cpu_vcpu_minutes: 0.5 * minutes,
      cost_usd: monthSoFar.toFixed(4),
      currency: "USD",
    });
    const estimate = observations.find(
      (observation) =>
        observation.metricKey === METRICS.estimatedCost &&
        observation.dimensions.resource === "prj-site",
    );
    const periodMinutes = 30 * 24 * 60;
    expect(estimate).toMatchObject({
      sourceTimestamp: "2024-01-10T00:00:00.000Z",
      value: Math.round(
        (0.1 * periodMinutes * USD_PER_UNIT.CPU_USAGE +
          0.25 * periodMinutes * USD_PER_UNIT.MEMORY_USAGE_GB +
          0.0001 * periodMinutes * USD_PER_UNIT.NETWORK_TX_GB) *
          100,
      ),
    });

    // Freshness: deploys as of this run, cost through yesterday (UTC).
    expect(freshnessEntry(last, DEPLOYS_STREAM)).toEqual({
      stream: DEPLOYS_STREAM,
    });
    expect(freshnessEntry(last, COST_STREAM)).toEqual({
      stream: COST_STREAM,
      dataThrough: "2024-01-09",
      expectedFrom: "2024-01-11T00:00:00.000Z",
      nextExpectedAt: "2024-01-11T01:00:00.000Z",
    });
    // The next run re-reads the last two days.
    expect(last.nextFrom).toBe("2024-01-08T00:00:00.000Z");

    // Read only: every request is a query.
    for (const request of requests) {
      const body = JSON.parse(request.init!.body!) as { query: string };
      expect(body.query.trimStart().startsWith("query ")).toBe(true);
      expect(body.query).not.toMatch(/\bmutation\b/);
    }
  });

  it("gives the same numbers when Railway pages deployments and projects", async () => {
    const whole = await syncAll(fake().runtime);
    const paged = await syncAll(
      fake({ maxDeploymentsPage: 2, maxProjectsPage: 1 }).runtime,
    );
    expect(paged.pages.length).toBeGreaterThan(whole.pages.length);
    expect(latest(paged.observations)).toEqual(latest(whole.observations));
    expect(
      rowsOf(paged.datasetPages, "deployments")
        .map((row) => row.deployment_id)
        .sort(),
    ).toEqual(
      rowsOf(whole.datasetPages, "deployments")
        .map((row) => row.deployment_id)
        .sort(),
    );
    expect(rowsOf(paged.datasetPages, "service_states")).toEqual(
      rowsOf(whole.datasetPages, "service_states"),
    );
  });

  it("reads many deployments of one project over several pages", async () => {
    const projects = fakeProjects();
    projects[0]!.deployments = deploymentsEvery({
      prefix: "dep-busy",
      count: 1_200,
      newest: "2024-01-10T11:00:00.000Z",
      stepMs: 10 * 60 * 1000,
      serviceId: "svc-web",
      environmentId: "env-production",
      statuses: ["SUCCESS", "FAILED", "REMOVED"],
    });
    const { pages, observations, datasetPages } = await syncAll(
      fake({ projects }).runtime,
    );
    const rows = rowsOf(datasetPages, "deployments").filter(
      (row) => row.project_id === "prj-api",
    );
    expect(rows).toHaveLength(1_200);
    expect(pages.length).toBeGreaterThan(4);
    const busy = [...latest(observations)].filter(
      ([key]) =>
        key.includes(METRICS.deployments) &&
        !key.includes("failed") &&
        key.includes("prj-api"),
    );
    expect(busy.reduce((sum, [, value]) => sum + value, 0)).toBe(1_200);
    for (const page of datasetPages) {
      expect(page.records.length).toBeLessThanOrEqual(1_000);
    }
  });

  it("completes a workspace without projects", async () => {
    const { last, observations, datasetPages } = await syncAll(
      fake({ projects: [] }).runtime,
    );
    expect(last.done).toBe(true);
    expect(observations).toEqual([]);
    expect(datasetPages.every((page) => page.records.length === 0)).toBe(true);
    expect(freshnessEntry(last, DEPLOYS_STREAM)).toBeDefined();
  });

  it("goes on without cost when the token may not read usage", async () => {
    const { last, observations } = await syncAll(
      fake({ usageDenied: ["ws-fixture"] }).runtime,
    );
    expect(last.done).toBe(true);
    expect(observations.some((item) => item.metricKey === METRICS.cost)).toBe(
      false,
    );
    expect(
      observations.some((item) => item.metricKey === METRICS.deployments),
    ).toBe(true);
    expect(freshnessEntry(last, DEPLOYS_STREAM)).toBeDefined();
    expect(freshnessEntry(last, COST_STREAM)).toBeUndefined();
    expect(last.receivedDatasets).not.toContain("project_usage");
  });

  it("reads the configured workspace only", async () => {
    const projects = fakeProjects();
    projects.push({
      ...projects[2]!,
      id: "prj-elsewhere",
      workspaceId: "ws-other",
    });
    const { datasetPages, observations } = await syncAll(
      fake({
        projects,
        workspaces: [
          { id: "ws-fixture", name: "Fixture team" },
          { id: "ws-other", name: "Other" },
        ],
      }).runtime,
      WINDOW,
      context({ config: { workspaceId: "ws-fixture" } }),
    );
    expect(
      observations.some((item) => item.dimensions.resource === "prj-elsewhere"),
    ).toBe(false);
    expect(
      rowsOf(datasetPages, "project_usage").map((row) => row.project_id),
    ).toEqual(["prj-api", "prj-site", "prj-empty"]);
  });

  it("refuses a revoked token with the check's reason code", async () => {
    const { runtime } = fake({ token: "rotated" });
    const error = await connector()
      .sync(context(), WINDOW, runtime)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectorError);
    expect((error as ConnectorError).code).toBe(TOKEN_REJECTED_CODE);
    expect((error as Error).message).not.toContain(FAKE_TOKEN);
  });

  it("hands a later rate-limit reset to the host", async () => {
    const { runtime } = fake({
      failures: [{ status: 429, headers: { "retry-after": "1800" } }],
    });
    const error = await connector()
      .sync(context(), WINDOW, runtime)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).retryAt).toBe(
      new Date(Date.parse(NOW) + 1_800_000).toISOString(),
    );
  });

  it("waits for a near rate-limit reset and server errors, then goes on", async () => {
    const { runtime, requests } = fake({
      failures: [
        { status: 429, headers: { "retry-after": "2" } },
        { status: 502, body: "<html>Bad gateway</html>" },
      ],
    });
    const result = await connector().sync(context(), WINDOW, runtime);
    expect(result.done).toBe(false);
    expect(requests[0]!.operation).toBe(requests[2]!.operation);
  });

  it("stops before the hourly window runs out", async () => {
    const { runtime } = fake({
      window: { remaining: 6, resetInMs: 40 * 60 * 1000, now: clock },
    });
    const error = await syncAll(runtime).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitedError);
  });
});

describe("Railway answers", () => {
  it("parses every deployment status of the recorded shape", () => {
    const answer = deploymentsSchema.parse(
      (fixture("deployments-all-statuses") as { data: unknown }).data,
    );
    const statuses = answer.deployments.edges.map(({ node }) => node.status);
    expect([...statuses].sort()).toEqual([...DEPLOYMENT_STATUSES].sort());
    const names = {
      services: new Map([["svc-web", "web"]]),
      environments: new Map([["env-production", "production"]]),
    };
    const rows = answer.deployments.edges.map(
      ({ node }) => deploymentRecord(node, names).values,
    );
    const byStatus = new Map(rows.map((row) => [row.status, row]));
    expect(byStatus.get("SUCCESS")).toMatchObject({
      failed: false,
      finished_at: "2024-01-10T10:02:05.000Z",
      duration_seconds: 125,
    });
    expect(byStatus.get("FAILED")).toMatchObject({
      failed: true,
      duration_seconds: 70,
    });
    expect(byStatus.get("CRASHED")).toMatchObject({
      failed: true,
      finished_at: null,
    });
    expect(byStatus.get("QUEUED")).toMatchObject({
      status_updated_at: null,
      finished_at: null,
    });
    expect(byStatus.get("REMOVED")).toMatchObject({
      service_id: null,
      service_name: null,
    });
    for (const status of DEPLOYMENT_STATUSES) {
      expect(byStatus.has(status), status).toBe(true);
    }
  });

  it("keeps a status Railway adds later", () => {
    const answer = deploymentsSchema.parse({
      deployments: {
        pageInfo: { hasNextPage: false, endCursor: null },
        edges: [
          {
            node: {
              id: "dep-new",
              status: "HIBERNATING",
              createdAt: "2024-01-10T10:00:00.000Z",
              environmentId: "env",
              projectId: "prj",
            },
          },
        ],
      },
    });
    expect(answer.deployments.edges[0]!.node.status).toBe("HIBERNATING");
  });

  it("classifies a service by its deployments", () => {
    expect(serviceState("BUILDING", ["SUCCESS"])).toBe("building");
    expect(serviceState("FAILED", ["SUCCESS"])).toBe("up");
    expect(serviceState("SUCCESS", ["SLEEPING"])).toBe("sleeping");
    expect(serviceState("CRASHED", [])).toBe("failed");
    expect(serviceState("SUCCESS", ["CRASHED"])).toBe("failed");
    expect(serviceState("REMOVED", [])).toBe("down");
    expect(serviceState(null, [])).toBe("down");
  });

  it("classifies Railway's recorded errors", () => {
    const errors = (name: string) =>
      (fixture(name) as { errors: unknown[] }).errors;
    expect(graphQlError(200, errors("error-not-authorized")).kind).toBe("auth");
    expect(graphQlError(200, errors("error-workspace-not-found")).kind).toBe(
      "not_found",
    );
    const schema = graphQlError(200, errors("error-validation-failed"));
    expect(schema.kind).toBe("schema");
    expect(schema).toBeInstanceOf(RailwayApiError);
  });

  it("never sends anything but a query", () => {
    expect(() => assertReadOnly("query a { me { id } }")).not.toThrow();
    expect(() =>
      assertReadOnly('mutation { projectDelete(id: "x") }'),
    ).toThrow();
    expect(() =>
      assertReadOnly("# comment\nsubscription { deploymentLogs }"),
    ).toThrow();
  });
});

describe("request budget", () => {
  it("shares one usage request between consecutive days", async () => {
    const { runtime, requests } = fake();
    await syncAll(runtime, {
      mode: "incremental",
      from: "2024-01-08T00:00:00.000Z",
      to: NOW,
    });
    const usage = requests.filter(
      (request) => request.operation === "netricsUsage",
    );
    // The day before the window, then the end of each of its three days.
    expect(usage.map((request) => request.variables.endDate)).toEqual([
      "2024-01-09T00:00:00.000Z",
      "2024-01-08T00:00:00.000Z",
      "2024-01-10T00:00:00.000Z",
      NOW,
    ]);
  });
});

describe("contract window", () => {
  it("reads only days of the window", async () => {
    const { observations } = await syncAll(fake().runtime, {
      mode: "incremental",
      from: "2024-01-09T06:00:00.000Z",
      to: NOW,
    });
    for (const observation of observations) {
      expect(Date.parse(observation.sourceTimestamp)).toBeGreaterThanOrEqual(
        Date.parse("2024-01-09T00:00:00.000Z"),
      );
      expect(Date.parse(observation.sourceTimestamp)).toBeLessThan(
        Date.parse(NOW) + DAY_MS,
      );
    }
  });
});
