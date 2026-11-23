import { createHash } from "node:crypto";

import {
  ConnectorError,
  type CheckResult,
  type ConnectionContext,
  type Connector,
  type ConnectorManifest,
  type ConnectorRuntime,
  type DatasetPage,
  type DatasetRecord,
  type FreshnessEntry,
  type ManifestTranslation,
  type Observation,
  type Resource,
  type SyncRequest,
  type SyncResult,
} from "@netrics/connector-sdk";

import { boundFreshness } from "../freshness.js";

import {
  RAILWAY_HOST,
  RailwayApiError,
  createRailwayClient,
  type ClientOptions,
  type RailwayQuery,
} from "./api.js";
import {
  COST_MEASUREMENTS,
  addUsage,
  cents,
  quantity,
  usageCostUsd,
  usdDecimal,
  type Usage,
} from "./cost.js";
import {
  RAILWAY_DATASETS,
  deploymentRecord,
  deploymentsDataset,
  isFailed,
  projectUsageDataset,
  serviceState,
  serviceStatesDataset,
  utc,
} from "./datasets.js";
import {
  DEPLOYMENTS_QUERY,
  ESTIMATED_USAGE_QUERY,
  ME_QUERY,
  PROJECTS_QUERY,
  PROJECT_STATE_QUERY,
  USAGE_QUERY,
  WORKSPACE_QUERY,
  deploymentsSchema,
  estimatedUsageSchema,
  meSchema,
  projectStateSchema,
  projectsSchema,
  usageSchema,
  workspaceAnswerSchema,
} from "./queries.js";

export { RailwayApiError, createRailwayClient } from "./api.js";
export { DEPLOYMENT_STATUSES } from "./queries.js";
export { serviceState, type ServiceState } from "./datasets.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Days re-read on every incremental sync: deployments change status after
 * they are created (building → success, later removed or crashed), and
 * today's usage keeps growing.
 */
const INCREMENTAL_LOOKBACK_DAYS = 2;
/** How far a first sync reads deployments back. */
export const BACKFILL_DAYS = 90;
/** Deployments per request, and requests per project and sync page. */
const DEPLOYMENTS_PER_REQUEST = 50;
const DEPLOYMENT_REQUESTS_PER_PAGE = 10;
const PROJECTS_PER_REQUEST = 50;
const MAX_PROJECT_REQUESTS = 20;
/** Days of usage read per sync page (each one request per workspace). */
const COST_DAYS_PER_PAGE = 16;

/** Freshness streams (ADR 0025). */
export const DEPLOYS_STREAM = "deploys";
export const COST_STREAM = "cost";

export const METRICS = {
  deployments: "railway.deployments",
  failedDeployments: "railway.failed_deployments",
  cost: "railway.cost",
  estimatedCost: "railway.estimated_cost",
} as const;

/** Kinds of the resources discover lists; each but "project" is a dimension. */
export const RESOURCE_KINDS = {
  project: "project",
  service: "service",
  environment: "environment",
} as const;

// ─── Reason codes of a failed check (#795) ─────────────────────────────────

export const TOKEN_REJECTED_CODE = "railway.token_rejected";
export const TOKEN_REJECTED_MESSAGE =
  "Railway did not accept the token: it is wrong, was deleted, or is a project token. Create an account or workspace token in Railway (Account Settings → Tokens). For a workspace token, also enter its workspace ID.";
export const WORKSPACE_DENIED_CODE = "railway.workspace_denied";
export const WORKSPACE_DENIED_MESSAGE =
  "Railway did not accept the token for this connection's workspace ID: the ID is wrong, the token belongs to another workspace, or it was deleted. Check the workspace ID, or create a new token for that workspace.";

// ─── Manifest ───────────────────────────────────────────────────────────────

/**
 * German texts of the manifest (ADR 0016, #257): "du" where the text
 * addresses the reader; Railway's own labels stay as they appear there.
 */
const railwayDe: ManifestTranslation = {
  name: "Railway",
  description:
    "Deployments, der aktuelle Zustand jedes Service und die geschätzten Kosten dieses Monats aus Railway, pro Projekt.",
  resourceNoun: { singular: "Projekt", plural: "Projekte" },
  credentials: {
    token: {
      title: "Railway-Token",
      description:
        "Ein Account- oder Workspace-Token. netrics liest damit nur Projekte, Deployments und Nutzung und ändert nichts. Das Token wird verschlüsselt gespeichert und nie wieder angezeigt.",
    },
  },
  setupSteps: [
    "Öffne in Railway Account Settings → Tokens.",
    "Wähle unter Workspace den Workspace, den netrics lesen soll (ein Workspace-Token), oder „No workspace“ für ein Account-Token, das alle deine Workspaces sieht.",
    "Gib dem Token einen Namen (zum Beispiel „netrics“), klicke auf Create und kopiere es. Railway zeigt es nur einmal an.",
    "Füge das Token unten ein. Für ein Workspace-Token trägst du auch die Workspace-ID ein.",
  ],
  config: {
    workspaceId: {
      title: "Workspace-ID",
      description:
        "Für ein Workspace-Token nötig, für ein Account-Token optional (dann liest netrics nur diesen Workspace). Du findest sie in Railway unter Workspace Settings → General.",
    },
  },
  metrics: {
    [METRICS.deployments]: {
      name: "Deployments",
      description:
        "Deployments pro Tag (UTC), Projekt, Service und Umgebung, nach ihrem Erstellungszeitpunkt.",
    },
    [METRICS.failedDeployments]: {
      name: "Fehlgeschlagene Deployments",
      description:
        "Deployments pro Tag (UTC), die fehlgeschlagen oder abgestürzt sind (FAILED oder CRASHED), pro Projekt, Service und Umgebung.",
    },
    [METRICS.cost]: {
      name: "Geschätzte Kosten",
      description:
        "Die Ressourcennutzung eines Tages (UTC) pro Projekt zu Railways Listenpreisen in US-Dollar. Über einen Monat summiert ergibt das die Nutzung bis heute; ohne Abo-Gebühr, enthaltene Nutzung und Guthaben.",
    },
    [METRICS.estimatedCost]: {
      name: "Geschätzte Kosten im Abrechnungszeitraum",
      description:
        "Railways Schätzung der Nutzung bis zum Ende des aktuellen Abrechnungszeitraums pro Projekt, zu Listenpreisen in US-Dollar.",
    },
  },
  dimensions: {
    resource: "Projekt",
    service: "Service",
    environment: "Umgebung",
  },
  freshnessStreams: {
    [DEPLOYS_STREAM]: "Deployments und Zustand",
    [COST_STREAM]: "Kosten",
  },
};

export const railwayManifest: ConnectorManifest = {
  id: "railway",
  version: "0.1.0",
  sdkVersion: "^0.2.19",
  category: "other",
  brandColor: "#0b0d0e",
  name: "Railway",
  description:
    "Deployments, the current state of every service and this month's estimated cost from Railway, per project.",
  url: "https://railway.com",
  docsUrl:
    "https://github.com/netrics-so/netrics/blob/main/docs/connectors/railway.md",
  authStrategies: [
    {
      strategy: "token",
      credentialsSchema: {
        type: "object",
        properties: {
          token: {
            type: "string",
            title: "Railway token",
            description:
              "An account or workspace token. netrics only reads projects, deployments and usage with it and changes nothing. It is stored encrypted and never shown again.",
          },
        },
        required: ["token"],
        additionalProperties: false,
      },
      setup: {
        steps: [
          "In Railway, open Account Settings → Tokens.",
          "Under Workspace, choose the workspace netrics should read (a workspace token), or “No workspace” for an account token that sees all your workspaces.",
          "Name the token (for example “netrics”), click Create and copy it. Railway shows it only once.",
          "Paste the token below. For a workspace token, also enter the workspace ID.",
        ],
        url: "https://railway.com/account/tokens",
      },
    },
  ],
  configSchema: {
    type: "object",
    properties: {
      workspaceId: {
        type: "string",
        title: "Workspace ID",
        description:
          "Needed for a workspace token, optional for an account token (netrics then reads only this workspace). Find it in Railway under Workspace Settings → General.",
      },
    },
    additionalProperties: false,
  },
  datasets: [...RAILWAY_DATASETS],
  metrics: [
    {
      key: METRICS.deployments,
      name: "Deployments",
      description:
        "Deployments per day (UTC), project, service and environment, by when they were created.",
      kind: "delta",
      unit: "deployments",
      granularity: "day",
      dimensions: ["resource", "service", "environment"],
      aggregations: ["sum", "avg", "min", "max"],
    },
    {
      key: METRICS.failedDeployments,
      name: "Failed deployments",
      description:
        "Deployments per day (UTC) that failed or crashed (FAILED or CRASHED), per project, service and environment.",
      kind: "delta",
      unit: "deployments",
      granularity: "day",
      dimensions: ["resource", "service", "environment"],
      aggregations: ["sum", "avg", "min", "max"],
      better: "lower",
    },
    {
      key: METRICS.cost,
      name: "Estimated cost",
      description:
        "One day's (UTC) resource usage per project at Railway's list prices, in US dollars. Summed over a month it is the usage so far; without the subscription fee, included usage and credits.",
      kind: "delta",
      unit: "USD_minor",
      granularity: "day",
      dimensions: ["resource"],
      aggregations: ["sum", "avg", "min", "max"],
      better: "lower",
    },
    {
      key: METRICS.estimatedCost,
      name: "Estimated cost this billing period",
      description:
        "Railway's estimate of the usage up to the end of the current billing period per project, at list prices in US dollars.",
      kind: "gauge",
      unit: "USD_minor",
      granularity: "day",
      dimensions: ["resource"],
      aggregations: ["last", "min", "max"],
      better: "lower",
    },
  ],
  minRefreshIntervalSeconds: 300,
  supportsBackfill: true,
  backfillDays: BACKFILL_DAYS,
  outboundDomains: [RAILWAY_HOST],
  resourceNoun: { singular: "project", plural: "projects" },
  // Discovery is the workspace and project lists: a few cheap requests.
  discoversBeforeFirstSync: true,
  translations: { de: railwayDe },
  // The Hobby plan's budget; Free allows 100 an hour, Pro 10,000.
  rateLimit: { maxRequests: 1000, windowSeconds: 3600 },
  freshnessStreams: [
    {
      key: DEPLOYS_STREAM,
      name: "Deployments and state",
      kind: "continuous",
      metrics: [METRICS.deployments, METRICS.failedDeployments],
      datasets: [deploymentsDataset.key, serviceStatesDataset.key],
    },
    {
      key: COST_STREAM,
      name: "Cost",
      kind: "periodic",
      period: "day",
      timeZone: "UTC",
      metrics: [METRICS.cost, METRICS.estimatedCost],
      datasets: [projectUsageDataset.key],
    },
  ],
};

// ─── Configuration ──────────────────────────────────────────────────────────

function tokenOf(context: ConnectionContext): string | undefined {
  const token = context.credentials.token;
  return typeof token === "string" && token.trim() !== ""
    ? token.trim()
    : undefined;
}

function workspaceIdOf(context: ConnectionContext): string | undefined {
  const id = context.config.workspaceId;
  return typeof id === "string" && id.trim() !== "" ? id.trim() : undefined;
}

// ─── Reading ────────────────────────────────────────────────────────────────

interface ProjectListing {
  id: string;
  name: string;
  workspaceId: string;
  services: Array<{ id: string; name: string }>;
  environments: Array<{ id: string; name: string }>;
}

async function listWorkspaces(
  query: RailwayQuery,
  configured: string | undefined,
): Promise<Array<{ id: string; name: string }>> {
  if (configured) {
    const answer = workspaceAnswerSchema.parse(
      await query(WORKSPACE_QUERY, { workspaceId: configured }),
    );
    return [answer.workspace];
  }
  return meSchema.parse(await query(ME_QUERY)).me.workspaces;
}

async function listProjects(
  query: RailwayQuery,
  workspaceId: string,
  first = PROJECTS_PER_REQUEST,
  maxRequests = MAX_PROJECT_REQUESTS,
): Promise<ProjectListing[]> {
  const projects: ProjectListing[] = [];
  let after: string | null = null;
  for (let request = 0; request < maxRequests; request += 1) {
    const answer = projectsSchema.parse(
      await query(PROJECTS_QUERY, { workspaceId, first, after }),
    );
    for (const { node } of answer.projects.edges) {
      projects.push({
        id: node.id,
        name: node.name,
        workspaceId,
        services: node.services.edges.map((edge) => edge.node),
        environments: node.environments.edges.map((edge) => edge.node),
      });
    }
    const { hasNextPage, endCursor } = answer.projects.pageInfo;
    if (!hasNextPage || !endCursor) break;
    after = endCursor;
  }
  return projects;
}

// ─── Time ───────────────────────────────────────────────────────────────────

function startOfUtcDay(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function startOfUtcMonth(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function startOfPreviousUtcMonth(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1);
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ─── Run state (the cursor) ─────────────────────────────────────────────────

/** Deployment counts of one day: "service|environment" → [all, failed]. */
type DayCounts = Record<string, [number, number]>;

interface RunState {
  v: 1;
  /** The refresh of this run's dataset pages (stable across retries). */
  refresh: string;
  /** Where this run reads from (start of a UTC day) and up to. */
  startMs: number;
  toMs: number;
  /** [project id, workspace id], in reading order. */
  projects: Array<[string, string]>;
  workspaces: string[];
  /** The next project to read, or projects.length in the cost phase. */
  index: number;
  /** The deployments page after which the current project continues. */
  after?: string;
  /** Counts of the oldest day read so far of the current project. */
  pending?: { day: number; counts: DayCounts };
  /** The next day whose usage is read. */
  costDay?: number;
  /** Last page keys of each dataset's refresh, and the page counter. */
  last: Record<string, string | null>;
  pages: number;
  /** Something was skipped: no freshness for that stream. */
  deploysPartial?: boolean;
  costPartial?: boolean;
}

const CURSOR_PREFIX = "railway.v1:";

function encodeState(state: RunState): string {
  return (
    CURSOR_PREFIX + Buffer.from(JSON.stringify(state)).toString("base64url")
  );
}

function decodeState(cursor: string | undefined): RunState | null {
  if (!cursor?.startsWith(CURSOR_PREFIX)) return null;
  try {
    const state = JSON.parse(
      Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString(
        "utf8",
      ),
    ) as RunState;
    return state.v === 1 ? state : null;
  } catch {
    return null;
  }
}

function refreshKey(connectionId: string, startMs: number, toMs: number) {
  return createHash("sha256")
    .update(`${connectionId}|${startMs}|${toMs}`)
    .digest("hex")
    .slice(0, 32);
}

// ─── Connector ──────────────────────────────────────────────────────────────

export interface RailwayConnectorOptions extends ClientOptions {
  /** The clock of the sync windows and snapshots; replaced in tests. */
  now?: () => number;
}

/**
 * Railway (#870), over its public GraphQL API with an account or workspace
 * token. Read only: every request is a query (see api.ts).
 *
 * Resources are projects (the `resource` dimension); services and
 * environments are discovered too, as the `service` and `environment`
 * dimensions, so dashboards can name them. A connection reads the
 * configured workspace, or every workspace of an account token.
 *
 * A sync reads, page by page: the projects; per project its services'
 * current state (a `service_states` snapshot) and the deployments created
 * in the window (the `deployments` dataset and daily deployment counts);
 * then per workspace the usage of every day in the window (this and the
 * previous calendar month at most), priced as an estimate (cost.ts), and
 * Railway's estimate for the billing period (`project_usage` snapshot).
 */
export function createRailwayConnector(
  options: RailwayConnectorOptions = {},
): Connector {
  const now = options.now ?? Date.now;

  function client(context: ConnectionContext, runtime: ConnectorRuntime) {
    const token = tokenOf(context);
    if (!token) {
      throw new Error("Railway connection has no token");
    }
    return createRailwayClient(runtime, token, options);
  }

  /** Auth failures in a sync carry the check's reason code. */
  function rethrow(error: unknown, context: ConnectionContext): never {
    if (
      error instanceof RailwayApiError &&
      (error.kind === "auth" ||
        (error.kind === "not_found" && workspaceIdOf(context)))
    ) {
      throw workspaceIdOf(context)
        ? new ConnectorError(WORKSPACE_DENIED_MESSAGE, WORKSPACE_DENIED_CODE)
        : new ConnectorError(TOKEN_REJECTED_MESSAGE, TOKEN_REJECTED_CODE);
    }
    throw error;
  }

  async function startRun(
    query: RailwayQuery,
    context: ConnectionContext,
    request: SyncRequest,
  ): Promise<RunState> {
    const workspaces = await listWorkspaces(query, workspaceIdOf(context));
    const projects: Array<[string, string]> = [];
    for (const workspace of workspaces) {
      for (const project of await listProjects(query, workspace.id)) {
        projects.push([project.id, workspace.id]);
      }
    }
    const startMs = startOfUtcDay(Date.parse(request.from));
    const toMs = Date.parse(request.to);
    return {
      v: 1,
      refresh: refreshKey(context.connectionId, startMs, toMs),
      startMs,
      toMs,
      projects,
      workspaces: workspaces.map((workspace) => workspace.id),
      index: 0,
      last: {},
      pages: 0,
    };
  }

  function datasetPage(
    state: RunState,
    datasetKey: string,
    records: DatasetRecord[],
    complete: boolean,
  ): DatasetPage {
    state.pages += 1;
    const pageKey = `p${String(state.pages).padStart(6, "0")}`;
    const page: DatasetPage = {
      datasetKey,
      schemaVersion: 1,
      refreshKey: `${state.refresh}:${datasetKey}`,
      pageKey,
      previousPageKey: state.last[datasetKey] ?? null,
      records,
      complete,
    };
    state.last[datasetKey] = pageKey;
    return page;
  }

  /** One project: its state snapshot rows, deployments and daily counts. */
  async function readProject(
    query: RailwayQuery,
    state: RunState,
    projectId: string,
  ): Promise<{
    observations: Observation[];
    deployments: DatasetRecord[];
    states: DatasetRecord[];
    finished: boolean;
  }> {
    let project;
    try {
      project = projectStateSchema.parse(
        await query(PROJECT_STATE_QUERY, { projectId }),
      ).project;
    } catch (error) {
      // Deleted (or unshared) since the listing: skipped, and the run
      // reports no deploy freshness.
      if (error instanceof RailwayApiError && error.kind === "not_found") {
        state.deploysPartial = true;
        return {
          observations: [],
          deployments: [],
          states: [],
          finished: true,
        };
      }
      throw error;
    }
    const services = new Map(
      project.services.edges.map(({ node }) => [node.id, node.name]),
    );
    const environments = new Map(
      project.environments.edges.map(({ node }) => [node.id, node.name]),
    );

    // The state snapshot is written once per project, with its first page.
    const states: DatasetRecord[] = [];
    if (state.after === undefined) {
      const checkedAt = iso(now());
      for (const { node: environment } of project.environments.edges) {
        if (environment.isEphemeral) continue;
        for (const { node: instance } of environment.serviceInstances.edges) {
          const latest = instance.latestDeployment ?? null;
          const active = (instance.activeDeployments ?? []).map(
            (deployment) => deployment.status,
          );
          states.push({
            values: {
              project_id: project.id,
              project_name: project.name,
              service_id: instance.serviceId,
              service_name:
                services.get(instance.serviceId) ?? instance.serviceId,
              environment_id: environment.id,
              environment_name: environment.name,
              state: serviceState(latest?.status ?? null, active),
              active_deployments: active.length,
              latest_deployment_id: latest?.id ?? null,
              latest_status: latest?.status ?? null,
              latest_created_at: utc(latest?.createdAt),
              latest_status_updated_at: utc(latest?.statusUpdatedAt),
              checked_at: checkedAt,
            },
          });
        }
      }
    }

    // Deployments, newest first, until one older than the window.
    const deployments: DatasetRecord[] = [];
    const days = new Map<number, DayCounts>();
    if (state.pending) days.set(state.pending.day, state.pending.counts);
    let after = state.after ?? null;
    let finished = false;
    for (
      let request = 0;
      request < DEPLOYMENT_REQUESTS_PER_PAGE;
      request += 1
    ) {
      const answer = deploymentsSchema.parse(
        await query(DEPLOYMENTS_QUERY, {
          projectId,
          first: DEPLOYMENTS_PER_REQUEST,
          after,
        }),
      ).deployments;
      let older = false;
      for (const { node } of answer.edges) {
        const created = Date.parse(node.createdAt);
        if (created < state.startMs) {
          older = true;
          continue;
        }
        if (created >= state.toMs) continue;
        deployments.push(deploymentRecord(node, { services, environments }));
        const day = startOfUtcDay(created);
        const key = `${node.serviceId ?? ""}|${node.environmentId}`;
        const counts = days.get(day) ?? {};
        const [all, failed] = counts[key] ?? [0, 0];
        counts[key] = [all + 1, failed + (isFailed(node.status) ? 1 : 0)];
        days.set(day, counts);
      }
      const { hasNextPage, endCursor } = answer.pageInfo;
      after = endCursor ?? null;
      if (older || !hasNextPage || !endCursor) {
        finished = true;
        break;
      }
    }

    // Newest first: every day but the oldest one read is complete. The
    // oldest is counted on with the next page unless the project is done.
    const oldest = Math.min(...days.keys());
    delete state.pending;
    if (!finished && days.size > 0) {
      state.pending = { day: oldest, counts: days.get(oldest)! };
      days.delete(oldest);
    }
    state.after = finished ? undefined : (after ?? undefined);

    const observations: Observation[] = [];
    for (const [day, counts] of [...days].sort(([a], [b]) => a - b)) {
      for (const key of Object.keys(counts).sort()) {
        const [serviceId, environmentId] = key.split("|") as [string, string];
        const [all, failed] = counts[key]!;
        const dimensions = {
          resource: projectId,
          service: serviceId === "" ? "unknown" : serviceId,
          environment: environmentId,
        };
        observations.push(
          {
            metricKey: METRICS.deployments,
            sourceTimestamp: iso(day),
            value: all,
            dimensions,
          },
          {
            metricKey: METRICS.failedDeployments,
            sourceTimestamp: iso(day),
            value: failed,
            dimensions,
          },
        );
      }
    }
    return { observations, deployments, states, finished };
  }

  /**
   * Usage of every project of a workspace from its month's start to
   * `endMs`. Answers are kept for the call: a day's end is the next day's
   * start, so consecutive days share one request.
   */
  async function monthToDate(
    query: RailwayQuery,
    workspaceId: string,
    endMs: number,
    cache: Map<string, Map<string, Usage>>,
  ): Promise<Map<string, Usage>> {
    const key = `${workspaceId}|${endMs}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const byProject = new Map<string, Usage>();
    const startMs = startOfUtcMonth(endMs - 1);
    if (endMs <= startMs) return byProject;
    const answer = usageSchema.parse(
      await query(USAGE_QUERY, {
        workspaceId,
        measurements: [...COST_MEASUREMENTS],
        startDate: iso(startMs),
        endDate: iso(endMs),
      }),
    );
    for (const row of answer.usage) {
      addUsage(byProject, row.tags.projectId, row.measurement, row.value);
    }
    // Only a successful answer is kept: a refused one is asked again.
    cache.set(key, byProject);
    return byProject;
  }

  /** The cost phase: daily cost observations, and the final snapshot. */
  async function readCost(
    query: RailwayQuery,
    state: RunState,
  ): Promise<{
    observations: Observation[];
    usage: DatasetRecord[] | null;
    finished: boolean;
  }> {
    const nowMs = now();
    const today = startOfUtcDay(nowMs);
    const lastDay = Math.min(startOfUtcDay(state.toMs - 1), today);
    const firstDay = Math.max(state.startMs, startOfPreviousUtcMonth(nowMs));
    let day = state.costDay ?? firstDay;
    const observations: Observation[] = [];
    const usableWorkspaces = new Set(state.workspaces);
    const projectsOf = (workspaceId: string) =>
      state.projects
        .filter(([, workspace]) => workspace === workspaceId)
        .map(([project]) => project);
    let todayUsage: Map<string, Usage> | null = null;
    const cache = new Map<string, Map<string, Usage>>();

    for (let read = 0; read < COST_DAYS_PER_PAGE && day <= lastDay; read += 1) {
      const end = Math.min(day + DAY_MS, nowMs);
      for (const workspaceId of state.workspaces) {
        if (!usableWorkspaces.has(workspaceId)) continue;
        let current: Map<string, Usage>;
        let previous: Map<string, Usage>;
        try {
          current = await monthToDate(query, workspaceId, end, cache);
          // The day before, within the same month: the day's cost is the
          // difference, so the days of a month add up to its total exactly.
          previous =
            day === startOfUtcMonth(day)
              ? new Map()
              : await monthToDate(query, workspaceId, day, cache);
        } catch (error) {
          // A token that may read projects but not usage: no cost, the
          // rest of the sync goes on.
          if (
            error instanceof RailwayApiError &&
            (error.kind === "auth" || error.kind === "not_found")
          ) {
            usableWorkspaces.delete(workspaceId);
            state.costPartial = true;
            continue;
          }
          throw error;
        }
        for (const projectId of projectsOf(workspaceId)) {
          const value =
            cents(usageCostUsd(current.get(projectId) ?? {})) -
            cents(usageCostUsd(previous.get(projectId) ?? {}));
          observations.push({
            metricKey: METRICS.cost,
            sourceTimestamp: iso(day),
            value,
            dimensions: { resource: projectId },
          });
        }
        if (day === today) {
          todayUsage ??= new Map();
          for (const [projectId, usage] of current) {
            todayUsage.set(projectId, usage);
          }
        }
      }
      day += DAY_MS;
    }
    state.costDay = day;
    if (day <= lastDay) {
      return { observations, usage: null, finished: false };
    }
    if (todayUsage === null || lastDay !== today) {
      return { observations, usage: null, finished: true };
    }

    // Today was read: Railway's estimate, and the month's usage snapshot.
    const estimates = new Map<string, Usage>();
    for (const workspaceId of state.workspaces) {
      if (!usableWorkspaces.has(workspaceId)) continue;
      try {
        const answer = estimatedUsageSchema.parse(
          await query(ESTIMATED_USAGE_QUERY, {
            workspaceId,
            measurements: [...COST_MEASUREMENTS],
          }),
        );
        for (const row of answer.estimatedUsage) {
          addUsage(
            estimates,
            row.projectId,
            row.measurement,
            row.estimatedValue,
          );
        }
      } catch (error) {
        if (
          error instanceof RailwayApiError &&
          (error.kind === "auth" || error.kind === "not_found")
        ) {
          continue;
        }
        throw error;
      }
    }
    for (const [projectId, usage] of [...estimates].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (!state.projects.some(([id]) => id === projectId)) continue;
      observations.push({
        metricKey: METRICS.estimatedCost,
        sourceTimestamp: iso(today),
        value: cents(usageCostUsd(usage)),
        dimensions: { resource: projectId },
      });
    }
    const names = await projectNames(query, state);
    const records: DatasetRecord[] = state.projects
      .filter(([, workspaceId]) => usableWorkspaces.has(workspaceId))
      .map(([projectId]) => {
        const usage = todayUsage.get(projectId) ?? {};
        const estimate = estimates.get(projectId);
        return {
          values: {
            project_id: projectId,
            project_name: names.get(projectId) ?? projectId,
            month: isoDay(startOfUtcMonth(nowMs)),
            as_of: iso(nowMs),
            cpu_vcpu_minutes: quantity(usage.CPU_USAGE),
            memory_gb_minutes: quantity(usage.MEMORY_USAGE_GB),
            egress_gb: quantity(usage.NETWORK_TX_GB),
            disk_gb_minutes: quantity(usage.DISK_USAGE_GB),
            cost_usd: usdDecimal(usageCostUsd(usage)),
            estimated_cost_usd:
              estimate !== undefined
                ? usdDecimal(usageCostUsd(estimate))
                : null,
            currency: "USD",
          },
        };
      });
    return { observations, usage: records, finished: true };
  }

  /** Project names for the usage snapshot (the cursor keeps only ids). */
  async function projectNames(
    query: RailwayQuery,
    state: RunState,
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const workspaceId of state.workspaces) {
      for (const project of await listProjects(query, workspaceId)) {
        names.set(project.id, project.name);
      }
    }
    return names;
  }

  function freshnessOf(state: RunState, costRead: boolean): FreshnessEntry[] {
    const entries: FreshnessEntry[] = [];
    if (!state.deploysPartial) entries.push({ stream: DEPLOYS_STREAM });
    if (costRead && !state.costPartial) {
      const today = startOfUtcDay(now());
      const lastDay = Math.min(startOfUtcDay(state.toMs - 1), today);
      // Today's usage is still growing: the last complete day is the one
      // before; the next one is complete at midnight UTC.
      const through = lastDay === today ? today - DAY_MS : lastDay;
      entries.push({
        stream: COST_STREAM,
        dataThrough: isoDay(through),
        expectedFrom: iso(through + 2 * DAY_MS),
        nextExpectedAt: iso(through + 2 * DAY_MS + 60 * 60 * 1000),
      });
    }
    return boundFreshness(entries);
  }

  return {
    manifest: railwayManifest,

    async check(context, runtime): Promise<CheckResult> {
      if (!tokenOf(context)) {
        return {
          ok: false,
          message: "Add a Railway token to this connection.",
        };
      }
      const workspaceId = workspaceIdOf(context);
      try {
        const query = client(context, runtime);
        const workspaces = await listWorkspaces(query, workspaceId);
        // The cheapest read of what a sync needs: one project.
        for (const workspace of workspaces.slice(0, 1)) {
          await listProjects(query, workspace.id, 1, 1);
        }
      } catch (error) {
        if (
          error instanceof RailwayApiError &&
          (error.kind === "auth" || error.kind === "not_found")
        ) {
          return workspaceId
            ? {
                ok: false,
                message: WORKSPACE_DENIED_MESSAGE,
                code: WORKSPACE_DENIED_CODE,
              }
            : {
                ok: false,
                message: TOKEN_REJECTED_MESSAGE,
                code: TOKEN_REJECTED_CODE,
              };
        }
        throw error;
      }
      return { ok: true };
    },

    async discover(context, runtime): Promise<Resource[]> {
      const query = client(context, runtime);
      try {
        const resources: Resource[] = [];
        const seen = new Set<string>();
        const add = (resource: Resource) => {
          const key = `${resource.kind}:${resource.id}`;
          if (seen.has(key)) return;
          seen.add(key);
          resources.push(resource);
        };
        for (const workspace of await listWorkspaces(
          query,
          workspaceIdOf(context),
        )) {
          for (const project of await listProjects(query, workspace.id)) {
            add({
              id: project.id,
              name: project.name,
              kind: RESOURCE_KINDS.project,
              metadata: { workspaceId: workspace.id },
            });
            for (const service of project.services) {
              add({
                id: service.id,
                name: service.name,
                kind: RESOURCE_KINDS.service,
                metadata: { projectId: project.id },
              });
            }
            for (const environment of project.environments) {
              add({
                id: environment.id,
                name: environment.name,
                kind: RESOURCE_KINDS.environment,
                metadata: { projectId: project.id },
              });
            }
          }
        }
        return resources;
      } catch (error) {
        rethrow(error, context);
      }
    },

    async sync(context, request: SyncRequest, runtime): Promise<SyncResult> {
      const query = client(context, runtime);
      try {
        const state =
          decodeState(request.cursor) ??
          (await startRun(query, context, request));
        const observations: Observation[] = [];
        const datasetPages: DatasetPage[] = [];

        if (state.index < state.projects.length) {
          const [projectId] = state.projects[state.index]!;
          const read = await readProject(query, state, projectId);
          observations.push(...read.observations);
          if (read.states.length > 0) {
            datasetPages.push(
              datasetPage(state, serviceStatesDataset.key, read.states, false),
            );
          }
          if (read.deployments.length > 0) {
            datasetPages.push(
              datasetPage(
                state,
                deploymentsDataset.key,
                read.deployments,
                false,
              ),
            );
          }
          if (read.finished) state.index += 1;
          return {
            observations,
            datasetPages,
            nextCursor: encodeState(state),
            done: false,
          };
        }

        const cost = await readCost(query, state);
        observations.push(...cost.observations);
        if (!cost.finished) {
          return {
            observations,
            datasetPages,
            nextCursor: encodeState(state),
            done: false,
          };
        }

        // The last page completes every refresh of this run.
        datasetPages.push(
          datasetPage(state, deploymentsDataset.key, [], true),
          datasetPage(state, serviceStatesDataset.key, [], true),
        );
        const received: string[] = [
          deploymentsDataset.key,
          serviceStatesDataset.key,
        ];
        if (cost.usage !== null) {
          datasetPages.push(
            datasetPage(state, projectUsageDataset.key, cost.usage, true),
          );
          received.push(projectUsageDataset.key);
        }
        const resumeAt = iso(
          Math.max(
            startOfUtcDay(state.toMs) - INCREMENTAL_LOOKBACK_DAYS * DAY_MS,
            state.startMs,
          ),
        );
        const freshness = freshnessOf(state, cost.usage !== null);
        return {
          observations,
          datasetPages,
          receivedDatasets: received,
          ...(freshness.length > 0 ? { freshness } : {}),
          nextCursor: resumeAt,
          nextFrom: resumeAt,
          done: true,
        };
      } catch (error) {
        rethrow(error, context);
      }
    },
  };
}
