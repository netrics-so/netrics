import { executeSync } from "@netrics/connector-runtime";
import {
  RateLimitedError,
  type ConnectionContext,
  type Connector,
  type ConnectorResponse,
  type ConnectorRuntime,
  type SyncRequest,
  type SyncResult,
} from "@netrics/connector-sdk";
import { createRailwayConnector } from "@netrics/connectors";
import { describe, expect, it } from "vitest";

// Whole Railway syncs through the host's own result validation
// (executeSync → validateSyncResult, ADR 0026 §7), which the connectors
// package cannot import (#881 review round 2). The connector talks to a
// small offline stand-in for Railway's GraphQL API.

const NOW = "2024-01-10T12:00:00.000Z";
const TOKEN = "railway-server-test-token";

interface Project {
  id: string;
  instances: number;
  deployments: number;
}

function answer(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): ConnectorResponse {
  const text = JSON.stringify(body);
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    text: () => text,
    json: () => JSON.parse(text) as unknown,
    bytes: () => new TextEncoder().encode(text),
  };
}

function pageOf<T>(items: T[], first: number, after: unknown) {
  const start = typeof after === "string" ? Number(after) : 0;
  const slice = items.slice(start, start + first);
  const end = start + slice.length;
  return {
    slice,
    pageInfo: {
      hasNextPage: end < items.length,
      endCursor: slice.length > 0 ? String(end) : null,
    },
  };
}

interface FakeOptions {
  /** Projects deleted before the run: billed, never listed (#883). */
  deleted?: string[];
  /** The request (1-based) that times out, once. */
  timeoutAt?: number;
  /** The request (1-based) answered with a 429 and a later reset, once. */
  rateLimitAt?: number;
  /** An operation whose pages say more follow without a cursor. */
  cursorless?: string;
}

function fakeRailway(
  projects: Project[],
  options: FakeOptions = {},
): ConnectorRuntime {
  let calls = 0;
  const instancesOf = (project: Project) =>
    Array.from({ length: project.instances }, (_, index) => ({
      serviceId: `${project.id}-svc-${index}`,
      serviceName: `service-${index}`,
      environmentId: `${project.id}-env`,
      latestDeployment: {
        id: `${project.id}-dep-0`,
        status: "SUCCESS",
        createdAt: "2024-01-10T09:00:00.000Z",
        statusUpdatedAt: "2024-01-10T09:02:00.000Z",
      },
      activeDeployments: [{ id: `${project.id}-dep-0`, status: "SUCCESS" }],
    }));
  const data = (operation: string, variables: Record<string, unknown>) => {
    const project = projects.find((entry) => entry.id === variables.projectId);
    switch (operation) {
      case "netricsMe":
        return { me: { workspaces: [{ id: "ws", name: "Team" }] } };
      case "netricsProjects": {
        const { slice, pageInfo } = pageOf(
          projects,
          Number(variables.first),
          variables.after,
        );
        return {
          projects: {
            pageInfo,
            edges: slice.map((entry) => ({
              node: {
                id: entry.id,
                name: entry.id,
                services: { pageInfo: { hasNextPage: false }, edges: [] },
                environments: { pageInfo: { hasNextPage: false }, edges: [] },
              },
            })),
          },
        };
      }
      case "netricsProjectState": {
        const instances = pageOf(
          instancesOf(project!),
          Number(variables.instFirst),
          null,
        );
        return {
          project: {
            id: project!.id,
            name: project!.id,
            environments: {
              pageInfo: { hasNextPage: false, endCursor: null },
              edges: [
                {
                  node: {
                    id: `${project!.id}-env`,
                    name: "production",
                    isEphemeral: false,
                    serviceInstances: {
                      pageInfo: instances.pageInfo,
                      edges: instances.slice.map((node) => ({ node })),
                    },
                  },
                },
              ],
            },
          },
        };
      }
      case "netricsEnvironmentInstances": {
        const instances = pageOf(
          instancesOf(project!),
          Number(variables.first),
          variables.after,
        );
        return {
          environment: {
            id: `${project!.id}-env`,
            serviceInstances: {
              pageInfo: instances.pageInfo,
              edges: instances.slice.map((node) => ({ node })),
            },
          },
        };
      }
      case "netricsDeployments": {
        const all = Array.from(
          { length: project!.deployments },
          (_, index) => ({
            id: `${project!.id}-dep-${index}`,
            status: index % 3 === 0 ? "FAILED" : "SUCCESS",
            createdAt: new Date(
              Date.parse("2024-01-10T09:00:00.000Z") - index * 60_000,
            ).toISOString(),
            updatedAt: null,
            statusUpdatedAt: null,
            serviceId: `${project!.id}-svc-0`,
            environmentId: `${project!.id}-env`,
            projectId: project!.id,
          }),
        );
        const { slice, pageInfo } = pageOf(
          all,
          Number(variables.first),
          variables.after,
        );
        return {
          deployments: {
            pageInfo,
            edges: slice.map((node) => ({ node })),
          },
        };
      }
      case "netricsUsage":
        return {
          usage: [
            ...projects.map((entry) => entry.id),
            ...(options.deleted ?? []),
          ].map((id) => ({
            measurement: "CPU_USAGE",
            value: 100,
            tags: { projectId: id },
          })),
        };
      case "netricsEstimatedUsage":
        return {
          estimatedUsage: projects.map((entry) => ({
            measurement: "CPU_USAGE",
            estimatedValue: 1_000,
            projectId: entry.id,
          })),
        };
      default:
        throw new Error(`unexpected operation ${operation}`);
    }
  };
  return {
    signal: new AbortController().signal,
    fetch: async (_url, init) => {
      const body = JSON.parse(init?.body ?? "{}") as {
        query: string;
        variables?: Record<string, unknown>;
      };
      const operation = /query\s+(\w+)/.exec(body.query)?.[1] ?? "";
      calls += 1;
      if (calls === options.timeoutAt) {
        throw new Error("The operation timed out");
      }
      if (calls === options.rateLimitAt) {
        return answer(429, {}, { "retry-after": "1800" });
      }
      const result = data(operation, body.variables ?? {});
      if (operation === options.cursorless) {
        const connection = Object.values(result)[0] as {
          pageInfo?: unknown;
          environments?: { pageInfo: unknown };
        };
        const pageInfo = { hasNextPage: true, endCursor: null };
        if (connection.environments)
          connection.environments.pageInfo = pageInfo;
        else connection.pageInfo = pageInfo;
      }
      return answer(200, { data: result });
    },
  };
}

/** The connector, reading Railway through the offline stand-in. */
function railwayWith(
  projects: Project[],
  options: FakeOptions & { pageRows?: number; now?: () => number } = {},
): Connector {
  const connector = createRailwayConnector({
    now: options.now ?? (() => Date.parse(NOW)),
    sleep: async () => {},
    ...(options.pageRows ? { pageRows: options.pageRows } : {}),
  });
  const runtime = fakeRailway(projects, options);
  return {
    ...connector,
    sync: (ctx, request) => connector.sync(ctx, request, runtime),
  };
}

async function syncThroughHost(
  connector: Connector,
  request: SyncRequest,
  onError?: (error: unknown) => void,
): Promise<SyncResult[]> {
  const context: ConnectionContext = {
    connectionId: "railway-host-test",
    config: {},
    credentials: { token: TOKEN },
  };
  const results: SyncResult[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 500; guard += 1) {
    const attempt = executeSync(connector, context, {
      ...request,
      ...(cursor ? { cursor } : {}),
    });
    // The host retries a failed page from the stored checkpoint.
    const result = onError
      ? await attempt.catch((error: unknown) => {
          onError(error);
          return null;
        })
      : await attempt;
    if (result === null) continue;
    results.push(result);
    if (result.done) return results;
    cursor = result.nextCursor;
  }
  throw new Error("the sync did not finish");
}

describe("Railway syncs through the host's validation (#870, #881)", () => {
  it("accepts a one-project incremental sync", async () => {
    const results = await syncThroughHost(
      railwayWith([{ id: "prj-one", instances: 2, deployments: 3 }]),
      { mode: "incremental", from: "2024-01-08T00:00:00.000Z", to: NOW },
    );
    const last = results.at(-1)!;
    expect(last.receivedDatasets).toEqual([
      "deployments",
      "service_states",
      "project_usage",
    ]);
    const rows = (key: string) =>
      results
        .flatMap((result) => result.datasetPages ?? [])
        .filter((page) => page.datasetKey === key)
        .flatMap((page) => page.records);
    expect(rows("service_states")).toHaveLength(2);
    expect(rows("deployments")).toHaveLength(3);
    expect(rows("project_usage")).toHaveLength(1);
  });

  it("accepts a usage snapshot and a state snapshot larger than one page", async () => {
    const projects: Project[] = Array.from({ length: 560 }, (_, index) => ({
      id: `prj-${index}`,
      instances: index === 0 ? 1_100 : 0,
      deployments: 0,
    }));
    const results = await syncThroughHost(railwayWith(projects), {
      mode: "incremental",
      from: "2024-01-10T00:00:00.000Z",
      to: NOW,
    });
    const pages = results.flatMap((result) => result.datasetPages ?? []);
    const usage = pages.filter((page) => page.datasetKey === "project_usage");
    expect(usage.length).toBeGreaterThan(1);
    expect(usage.flatMap((page) => page.records)).toHaveLength(560);
    expect(
      pages
        .filter((page) => page.datasetKey === "service_states")
        .flatMap((page) => page.records),
    ).toHaveLength(1_100);
  });

  it("accepts a usage snapshot of more than twenty pages, drained over several results (#883)", async () => {
    const projects: Project[] = Array.from({ length: 30 }, (_, index) => ({
      id: `prj-${index}`,
      instances: 0,
      deployments: 0,
    }));
    const results = await syncThroughHost(
      railwayWith(projects, { pageRows: 1 }),
      { mode: "incremental", from: "2024-01-10T00:00:00.000Z", to: NOW },
    );
    const usage = results
      .flatMap((result) => result.datasetPages ?? [])
      .filter((page) => page.datasetKey === "project_usage");
    expect(usage.length).toBeGreaterThan(20);
    expect(usage.flatMap((page) => page.records)).toHaveLength(30);
    expect(results.at(-1)!.receivedDatasets).toContain("project_usage");
  });

  it("accepts the progress of a page whose later request timed out (#883)", async () => {
    const results = await syncThroughHost(
      railwayWith([{ id: "prj-one", instances: 2, deployments: 3 }], {
        timeoutAt: 4,
      }),
      { mode: "incremental", from: "2024-01-08T00:00:00.000Z", to: NOW },
    );
    expect(results[0]!.done).toBe(false);
    expect(results.at(-1)!.receivedDatasets).toEqual([
      "deployments",
      "service_states",
      "project_usage",
    ]);
  });

  it("hands a rate limit after progress to the host as a rate limit (#883)", async () => {
    let nowMs = Date.parse(NOW);
    const errors: unknown[] = [];
    const results = await syncThroughHost(
      railwayWith([{ id: "prj-one", instances: 2, deployments: 3 }], {
        rateLimitAt: 4,
        now: () => nowMs,
      }),
      { mode: "incremental", from: "2024-01-08T00:00:00.000Z", to: NOW },
      (error) => {
        errors.push(error);
        if (!(error instanceof RateLimitedError)) throw error;
        nowMs = Date.parse(error.retryAt);
      },
    );
    expect(results[0]!.done).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(RateLimitedError);
    expect(results.at(-1)!.done).toBe(true);
  });

  it("accepts the cost of deleted projects (#883)", async () => {
    const results = await syncThroughHost(
      railwayWith([{ id: "prj-one", instances: 1, deployments: 1 }], {
        deleted: ["prj-deleted"],
      }),
      { mode: "incremental", from: "2024-01-08T00:00:00.000Z", to: NOW },
    );
    const resources = new Set(
      results
        .flatMap((result) => result.observations)
        .filter((item) => item.metricKey === "railway.cost")
        .map((item) => item.dimensions.resource),
    );
    expect(resources).toEqual(new Set(["prj-one", "prj-deleted"]));
    const usage = results
      .flatMap((result) => result.datasetPages ?? [])
      .filter((page) => page.datasetKey === "project_usage")
      .flatMap((page) => page.records);
    expect(usage.map((record) => record.values.project_id)).toEqual([
      "prj-one",
    ]);
  });

  for (const operation of [
    "netricsProjects",
    "netricsProjectState",
    "netricsDeployments",
  ]) {
    it(`never finishes from a ${operation} page without a cursor (#883)`, async () => {
      const results: SyncResult[] = [];
      const error = await syncThroughHost(
        railwayWith([{ id: "prj-one", instances: 1, deployments: 1 }], {
          cursorless: operation,
        }),
        { mode: "incremental", from: "2024-01-08T00:00:00.000Z", to: NOW },
      )
        .then((all) => {
          results.push(...all);
          return null;
        })
        .catch((caught: unknown) => caught);
      expect(results.some((result) => result.done)).toBe(false);
      expect(error).toBeInstanceOf(Error);
    });
  }
});
