import type {
  CheckResult,
  Connector,
  ConnectorManifest,
  ManifestTranslation,
  Resource,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";

import {
  RAILWAY_HOST,
  RailwayApiError,
  createRailwayClient,
  type ClientOptions,
} from "./api.js";
import {
  RAILWAY_DATASETS,
  deploymentsDataset,
  projectUsageDataset,
  serviceStatesDataset,
} from "./datasets.js";
import {
  TOKEN_REJECTED_CODE,
  TOKEN_REJECTED_MESSAGE,
  WORKSPACE_DENIED_CODE,
  WORKSPACE_DENIED_MESSAGE,
  listProjects,
  listWorkspaces,
  rethrow,
  tokenOf,
  workspaceIdOf,
} from "./reading.js";
import {
  COST_STREAM,
  DEPLOYS_STREAM,
  ESTIMATE_STREAM,
  METRICS,
  syncPage,
} from "./sync.js";

export { RailwayApiError, createRailwayClient } from "./api.js";
export { DEPLOYMENT_STATUSES } from "./queries.js";
export { serviceState, type ServiceState } from "./datasets.js";
export {
  TOKEN_REJECTED_CODE,
  TOKEN_REJECTED_MESSAGE,
  WORKSPACE_DENIED_CODE,
  WORKSPACE_DENIED_MESSAGE,
} from "./reading.js";
export {
  COST_STREAM,
  DEPLOYS_STREAM,
  ESTIMATE_STREAM,
  MAX_REQUESTS_PER_PAGE,
  METRICS,
} from "./sync.js";

/** How far a first sync reads deployments back. */
export const BACKFILL_DAYS = 90;

/** Kinds of the resources discover lists; each but "project" is a dimension. */
export const RESOURCE_KINDS = {
  project: "project",
  service: "service",
  environment: "environment",
} as const;

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
    [ESTIMATE_STREAM]: "Kostenschätzung",
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
      metrics: [METRICS.cost],
      datasets: [projectUsageDataset.key],
    },
    {
      // Railway's estimate is read on its own (review #881): a refused
      // estimate leaves the measured cost fresh and this stream stale.
      key: ESTIMATE_STREAM,
      name: "Cost estimate",
      kind: "continuous",
      metrics: [METRICS.estimatedCost],
    },
  ],
};

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
 * A sync is a resumable run of single-request steps (sync.ts): the
 * projects; per project its services' current state in every lasting
 * environment (the `service_states` snapshot) and the deployments created
 * in the window (the `deployments` dataset and daily counts); per workspace
 * and day the usage, priced as an estimate (cost.ts); and Railway's
 * estimate for the billing period (`project_usage` snapshot).
 */
export function createRailwayConnector(
  options: RailwayConnectorOptions = {},
): Connector {
  const now = options.now ?? Date.now;

  function client(
    context: Parameters<Connector["check"]>[0],
    runtime: Parameters<Connector["check"]>[1],
  ) {
    const token = tokenOf(context);
    if (!token) {
      throw new Error("Railway connection has no token");
    }
    return createRailwayClient(runtime, token, options);
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
        return await syncPage(query, context, request, { now });
      } catch (error) {
        rethrow(error, context);
      }
    },
  };
}
