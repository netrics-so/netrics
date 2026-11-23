import { executeSync } from "@netrics/connector-runtime";
import type {
  ConnectionContext,
  Connector,
  ConnectorResponse,
  ConnectorRuntime,
  SyncRequest,
  SyncResult,
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

function answer(status: number, body: unknown): ConnectorResponse {
  const text = JSON.stringify(body);
  return {
    status,
    headers: { "content-type": "application/json" },
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

function fakeRailway(projects: Project[]): ConnectorRuntime {
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
          usage: projects.map((entry) => ({
            measurement: "CPU_USAGE",
            value: 100,
            tags: { projectId: entry.id },
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
      return answer(200, { data: data(operation, body.variables ?? {}) });
    },
  };
}

/** The connector, reading Railway through the offline stand-in. */
function railwayWith(projects: Project[]): Connector {
  const connector = createRailwayConnector({
    now: () => Date.parse(NOW),
    sleep: async () => {},
  });
  const runtime = fakeRailway(projects);
  return {
    ...connector,
    sync: (ctx, request) => connector.sync(ctx, request, runtime),
  };
}

async function syncThroughHost(
  connector: Connector,
  request: SyncRequest,
): Promise<SyncResult[]> {
  const context: ConnectionContext = {
    connectionId: "railway-host-test",
    config: {},
    credentials: { token: TOKEN },
  };
  const results: SyncResult[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 500; guard += 1) {
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
});
