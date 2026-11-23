import { readFileSync } from "node:fs";

import type {
  ConnectorFetchInit,
  ConnectorResponse,
  ConnectorRuntime,
} from "@netrics/connector-sdk";

import { RAILWAY_API } from "./api.js";

/**
 * An offline stand-in for the parts of Railway's GraphQL API the connector
 * uses, answering like the recorded fixtures (`fixtures/`). Queries are
 * told apart by their operation name. Usage grows at a constant rate per
 * project, so any window asking for a day gets the same numbers.
 */
export const FAKE_TOKEN = "railway-fake-token-0123456789";

export interface FakeDeployment {
  id: string;
  status: string;
  createdAt: string;
  statusUpdatedAt?: string | null;
  serviceId: string | null;
  environmentId: string;
}

export interface FakeInstance {
  serviceId: string;
  environmentId: string;
  latest: { id: string; status: string; createdAt: string } | null;
  active: string[];
}

export interface FakeProject {
  id: string;
  name: string;
  workspaceId: string;
  services: Array<{ id: string; name: string }>;
  environments: Array<{ id: string; name: string; isEphemeral?: boolean }>;
  instances: FakeInstance[];
  /** Newest first, as Railway lists them. */
  deployments: FakeDeployment[];
  /** Usage per minute: vCPU, GB memory, GB egress, GB volume. */
  rates: { cpu: number; memory: number; egress: number; disk: number };
}

export interface FakeRailwayOptions {
  token?: string;
  /** "workspace": `me` is refused, `workspace` only answers its own. */
  tokenKind?: "account" | "workspace";
  workspaces?: Array<{ id: string; name: string }>;
  projects?: FakeProject[];
  /** Workspaces whose usage the token may not read. */
  usageDenied?: string[];
  /** Workspaces whose estimated usage the token may not read. */
  estimateDenied?: string[];
  /** Projects deleted since the listing (mutable between sync pages). */
  gone?: Set<string>;
  /** Answers queued ahead of the normal ones (429s, 5xx, …). */
  failures?: Array<{
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
  }>;
  /** Page sizes the fake caps `first` at, to exercise pagination. */
  maxProjectsPage?: number;
  maxDeploymentsPage?: number;
  /** Rate-limit headers on every answer: `remaining`, counted down. */
  window?: { remaining: number; resetInMs: number; now: () => number };
}

export const FAKE_WORKSPACES = [{ id: "ws-fixture", name: "Fixture team" }];

/** Builds `count` deployments of one service, newest first, `stepMs` apart. */
export function deploymentsEvery(options: {
  prefix: string;
  count: number;
  newest: string;
  stepMs: number;
  serviceId: string | null;
  environmentId: string;
  statuses?: readonly string[];
}): FakeDeployment[] {
  const statuses = options.statuses ?? ["SUCCESS"];
  return Array.from({ length: options.count }, (_, index) => {
    const created = Date.parse(options.newest) - index * options.stepMs;
    const status = statuses[index % statuses.length]!;
    return {
      id: `${options.prefix}-${String(index).padStart(4, "0")}`,
      status,
      createdAt: new Date(created).toISOString(),
      statusUpdatedAt: new Date(created + 95_000).toISOString(),
      serviceId: options.serviceId,
      environmentId: options.environmentId,
    };
  });
}

export function fakeProjects(): FakeProject[] {
  return [
    {
      id: "prj-api",
      name: "api",
      workspaceId: "ws-fixture",
      services: [
        { id: "svc-web", name: "web" },
        { id: "svc-worker", name: "worker" },
      ],
      environments: [
        { id: "env-production", name: "production" },
        { id: "env-pr-12", name: "pr-12", isEphemeral: true },
      ],
      instances: [
        {
          serviceId: "svc-web",
          environmentId: "env-production",
          latest: {
            id: "dep-web-0000",
            status: "SUCCESS",
            createdAt: "2024-01-10T09:00:00.000Z",
          },
          active: ["SUCCESS"],
        },
        {
          serviceId: "svc-worker",
          environmentId: "env-production",
          latest: {
            id: "dep-worker-0000",
            status: "CRASHED",
            createdAt: "2024-01-09T10:00:00.000Z",
          },
          active: [],
        },
        {
          serviceId: "svc-web",
          environmentId: "env-pr-12",
          latest: null,
          active: [],
        },
      ],
      deployments: [
        ...deploymentsEvery({
          prefix: "dep-web",
          count: 30,
          newest: "2024-01-10T09:00:00.000Z",
          stepMs: 9 * 60 * 60 * 1000,
          serviceId: "svc-web",
          environmentId: "env-production",
          statuses: ["SUCCESS", "REMOVED", "FAILED", "REMOVED"],
        }),
        ...deploymentsEvery({
          prefix: "dep-worker",
          count: 6,
          newest: "2024-01-09T10:00:00.000Z",
          stepMs: 2 * 24 * 60 * 60 * 1000,
          serviceId: "svc-worker",
          environmentId: "env-production",
          statuses: ["CRASHED", "REMOVED"],
        }),
      ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
      rates: { cpu: 0.5, memory: 1, egress: 0.001, disk: 2 },
    },
    {
      id: "prj-site",
      name: "site",
      workspaceId: "ws-fixture",
      services: [{ id: "svc-site", name: "site" }],
      environments: [{ id: "env-site-production", name: "production" }],
      instances: [
        {
          serviceId: "svc-site",
          environmentId: "env-site-production",
          latest: {
            id: "dep-site-new",
            status: "BUILDING",
            createdAt: "2024-01-10T11:55:00.000Z",
          },
          active: ["SUCCESS"],
        },
      ],
      deployments: [
        {
          id: "dep-site-new",
          status: "BUILDING",
          createdAt: "2024-01-10T11:55:00.000Z",
          statusUpdatedAt: "2024-01-10T11:56:00.000Z",
          serviceId: "svc-site",
          environmentId: "env-site-production",
        },
        {
          id: "dep-site-old",
          status: "SUCCESS",
          createdAt: "2024-01-02T08:00:00.000Z",
          statusUpdatedAt: "2024-01-02T08:03:20.000Z",
          serviceId: "svc-site",
          environmentId: "env-site-production",
        },
      ],
      rates: { cpu: 0.1, memory: 0.25, egress: 0.0001, disk: 0 },
    },
    {
      // A new project without any deployment yet.
      id: "prj-empty",
      name: "empty",
      workspaceId: "ws-fixture",
      services: [],
      environments: [{ id: "env-empty-production", name: "production" }],
      instances: [],
      deployments: [],
      rates: { cpu: 0, memory: 0, egress: 0, disk: 0 },
    },
  ];
}

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): ConnectorResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    text: () => text,
    json: () => JSON.parse(text) as unknown,
    bytes: () => new TextEncoder().encode(text),
  };
}

export function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  );
}

/** Railway's answer to a query the token may not run (recorded). */
export function notAuthorized(field: string): unknown {
  const recorded = fixture("error-not-authorized") as {
    errors: Array<{ path: string[] }>;
  };
  return {
    ...recorded,
    errors: recorded.errors.map((error) => ({ ...error, path: [field] })),
  };
}

function notFound(what: "Workspace" | "Project"): unknown {
  const recorded = fixture("error-workspace-not-found") as {
    errors: Array<{ message: string }>;
  };
  return {
    ...recorded,
    errors: recorded.errors.map((error) => ({
      ...error,
      message: `${what} not found`,
    })),
  };
}

function page<T>(
  items: readonly T[],
  first: number,
  after: string | null | undefined,
  cap: number,
) {
  const start = after ? Number(after.replace("cursor-", "")) : 0;
  const size = Math.min(first, cap);
  const slice = items.slice(start, start + size);
  const end = start + slice.length;
  return {
    slice,
    pageInfo: {
      hasNextPage: end < items.length,
      endCursor: slice.length > 0 ? `cursor-${end}` : null,
    },
  };
}

const MEASUREMENT_RATE = {
  CPU_USAGE: "cpu",
  MEMORY_USAGE_GB: "memory",
  NETWORK_TX_GB: "egress",
  DISK_USAGE_GB: "disk",
} as const;

export interface FakeRailway {
  runtime: ConnectorRuntime;
  requests: Array<{
    url: string;
    init: ConnectorFetchInit | undefined;
    operation: string;
    variables: Record<string, unknown>;
  }>;
}

export function createFakeRailway(
  options: FakeRailwayOptions = {},
): FakeRailway {
  const token = options.token ?? FAKE_TOKEN;
  const workspaces = options.workspaces ?? FAKE_WORKSPACES;
  const projects = options.projects ?? fakeProjects();
  const failures = [...(options.failures ?? [])];
  const requests: FakeRailway["requests"] = [];

  function instancesOf(
    project: FakeProject,
    environmentId: string,
    first: number,
    after: string | null,
  ) {
    const { slice, pageInfo } = page(
      project.instances.filter(
        (instance) => instance.environmentId === environmentId,
      ),
      first,
      after,
      1_000,
    );
    return {
      pageInfo,
      edges: slice.map((instance) => ({
        node: {
          serviceId: instance.serviceId,
          serviceName:
            project.services.find(
              (service) => service.id === instance.serviceId,
            )?.name ?? instance.serviceId,
          environmentId: instance.environmentId,
          latestDeployment: instance.latest
            ? { ...instance.latest, statusUpdatedAt: instance.latest.createdAt }
            : null,
          activeDeployments: instance.active.map((status, index) => ({
            id: `${instance.serviceId}-active-${index}`,
            status,
          })),
        },
      })),
    };
  }
  let remaining = options.window?.remaining ?? 0;

  function windowHeaders(): Record<string, string> {
    if (!options.window) return {};
    remaining = Math.max(0, remaining - 1);
    return {
      "x-ratelimit-limit": "1000",
      "x-ratelimit-remaining": String(remaining),
      "x-ratelimit-reset": String(
        Math.ceil((options.window.now() + options.window.resetInMs) / 1000),
      ),
    };
  }

  function answer(
    operation: string,
    variables: Record<string, unknown>,
  ): unknown {
    const visibleWorkspaces =
      options.tokenKind === "workspace" ? workspaces.slice(0, 1) : workspaces;
    const workspaceVisible = (id: unknown) =>
      visibleWorkspaces.some((workspace) => workspace.id === id);
    switch (operation) {
      case "netricsMe":
        if (options.tokenKind === "workspace") return notAuthorized("me");
        return { data: { me: { workspaces } } };
      case "netricsWorkspace": {
        const workspace = visibleWorkspaces.find(
          (entry) => entry.id === variables.workspaceId,
        );
        return workspace ? { data: { workspace } } : notFound("Workspace");
      }
      case "netricsProjects": {
        if (!workspaceVisible(variables.workspaceId)) {
          return notAuthorized("projects");
        }
        const own = projects.filter(
          (project) => project.workspaceId === variables.workspaceId,
        );
        const { slice, pageInfo } = page(
          own,
          Number(variables.first),
          variables.after as string | null,
          options.maxProjectsPage ?? 50,
        );
        return {
          data: {
            projects: {
              pageInfo,
              edges: slice.map((project, index) => ({
                cursor: `cursor-${index}`,
                node: {
                  id: project.id,
                  name: project.name,
                  services: {
                    edges: project.services.map((node) => ({ node })),
                  },
                  environments: {
                    edges: project.environments.map((environment) => ({
                      node: {
                        isEphemeral: false,
                        ...environment,
                      },
                    })),
                  },
                },
              })),
            },
          },
        };
      }
      case "netricsProjectState": {
        const project = projects.find(
          (entry) => entry.id === variables.projectId,
        );
        if (
          !project ||
          !workspaceVisible(project.workspaceId) ||
          options.gone?.has(project.id)
        ) {
          return notFound("Project");
        }
        // Railway's defaults when the query names no page size.
        const environments = project.environments.filter(
          (environment) =>
            variables.ephemeral !== false || !environment.isEphemeral,
        );
        const envPage = page(
          environments,
          Number(variables.envFirst ?? 50),
          variables.envAfter as string | null,
          1_000,
        );
        return {
          data: {
            project: {
              id: project.id,
              name: project.name,
              services: { edges: project.services.map((node) => ({ node })) },
              environments: {
                pageInfo: envPage.pageInfo,
                edges: envPage.slice.map((environment) => ({
                  node: {
                    id: environment.id,
                    name: environment.name,
                    isEphemeral: environment.isEphemeral ?? false,
                    serviceInstances: instancesOf(
                      project,
                      environment.id,
                      Number(variables.instFirst ?? 100),
                      null,
                    ),
                  },
                })),
              },
            },
          },
        };
      }
      case "netricsEnvironmentInstances": {
        const project = projects.find(
          (entry) => entry.id === variables.projectId,
        );
        const environment = project?.environments.find(
          (entry) => entry.id === variables.environmentId,
        );
        if (
          !project ||
          !environment ||
          !workspaceVisible(project.workspaceId) ||
          options.gone?.has(project.id)
        ) {
          return notFound("Project");
        }
        return {
          data: {
            environment: {
              id: environment.id,
              serviceInstances: instancesOf(
                project,
                environment.id,
                Number(variables.first ?? 100),
                variables.after as string | null,
              ),
            },
          },
        };
      }
      case "netricsDeployments": {
        const project = projects.find(
          (entry) => entry.id === variables.projectId,
        );
        if (
          !project ||
          !workspaceVisible(project.workspaceId) ||
          options.gone?.has(project.id)
        ) {
          return notAuthorized("deployments");
        }
        const { slice, pageInfo } = page(
          project.deployments,
          Number(variables.first),
          variables.after as string | null,
          options.maxDeploymentsPage ?? 100,
        );
        return {
          data: {
            deployments: {
              pageInfo,
              edges: slice.map((deployment) => ({
                node: {
                  id: deployment.id,
                  status: deployment.status,
                  createdAt: deployment.createdAt,
                  updatedAt: deployment.statusUpdatedAt ?? deployment.createdAt,
                  statusUpdatedAt: deployment.statusUpdatedAt ?? null,
                  serviceId: deployment.serviceId,
                  environmentId: deployment.environmentId,
                  projectId: project.id,
                },
              })),
            },
          },
        };
      }
      case "netricsUsage":
      case "netricsEstimatedUsage": {
        const workspaceId = variables.workspaceId as string;
        if (
          !workspaceVisible(workspaceId) ||
          options.usageDenied?.includes(workspaceId) ||
          (operation === "netricsEstimatedUsage" &&
            options.estimateDenied?.includes(workspaceId))
        ) {
          return notAuthorized(
            operation === "netricsUsage" ? "usage" : "estimatedUsage",
          );
        }
        const measurements = variables.measurements as Array<
          keyof typeof MEASUREMENT_RATE
        >;
        const own = projects.filter(
          (project) => project.workspaceId === workspaceId,
        );
        if (operation === "netricsUsage") {
          const minutes =
            (Date.parse(variables.endDate as string) -
              Date.parse(variables.startDate as string)) /
            60_000;
          return {
            data: {
              usage: own.flatMap((project) =>
                measurements.map((measurement) => ({
                  measurement,
                  value: project.rates[MEASUREMENT_RATE[measurement]] * minutes,
                  tags: { projectId: project.id },
                })),
              ),
            },
          };
        }
        // A 30-day billing period at the same rate.
        const minutes = 30 * 24 * 60;
        return {
          data: {
            estimatedUsage: own.flatMap((project) =>
              measurements.map((measurement) => ({
                measurement,
                estimatedValue:
                  project.rates[MEASUREMENT_RATE[measurement]] * minutes,
                projectId: project.id,
              })),
            ),
          },
        };
      }
      default:
        return {
          errors: [
            {
              message: `Unknown operation ${operation}`,
              extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
            },
          ],
        };
    }
  }

  const runtime: ConnectorRuntime = {
    signal: new AbortController().signal,
    fetch: async (url, init) => {
      if (url !== RAILWAY_API || init?.method !== "POST") {
        throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
      }
      const body = JSON.parse(init.body ?? "{}") as {
        query: string;
        variables?: Record<string, unknown>;
      };
      const operation = /query\s+(\w+)/.exec(body.query)?.[1] ?? "";
      const variables = body.variables ?? {};
      requests.push({ url, init, operation, variables });
      const failure = failures.shift();
      if (failure) {
        return response(failure.status, failure.body ?? "", {
          ...windowHeaders(),
          ...failure.headers,
        });
      }
      if (init.headers?.authorization !== `Bearer ${token}`) {
        return response(200, notAuthorized(operation), windowHeaders());
      }
      return response(200, answer(operation, variables), windowHeaders());
    },
  };
  return { runtime, requests };
}
