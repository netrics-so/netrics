import type {
  CheckResult,
  ConnectionContext,
  Connector,
  ConnectorManifest,
  ManifestTranslation,
  ConnectorRuntime,
  Resource,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";

import {
  VercelApiError,
  createVercelClient,
  type ClientOptions,
} from "./api.js";
import {
  VERCEL_DATASETS,
  billingChargesDataset,
  deploymentsDataset,
  productionDeploymentsDataset,
} from "./datasets.js";
import {
  listProjects,
  selectionOf,
  teamIdOf,
  tokenOf,
  type VercelProject,
} from "./reading.js";
import {
  ANALYTICS_STREAM,
  BILLING_STREAM,
  DEPLOYS_STREAM,
  METRICS,
  TOP_LIMIT,
  emptyRun,
  syncPage,
} from "./sync.js";

export {
  ANALYTICS_STREAM,
  BILLING_STREAM,
  DEPLOYMENTS_BACKFILL_DAYS,
  DEPLOYS_STREAM,
  INCREMENTAL_LOOKBACK_DAYS,
  MAX_REQUESTS_PER_PAGE,
  METRICS,
  TOP_LIMIT,
} from "./sync.js";
export {
  DEPLOYMENT_STATES,
  productionState,
  type ProductionState,
} from "./datasets.js";

/**
 * German texts of the manifest (ADR 0016, #257): "du" where the text
 * addresses the reader; product names and stored values stay as they are.
 */
const vercelDe: ManifestTranslation = {
  name: "Vercel",
  description:
    "Deployments, der Zustand der Produktion und Web Analytics (Besucher, Seitenaufrufe, eigene Events) deiner Vercel-Projekte, dazu die Kosten dieses Monats.",
  resourceNoun: { singular: "Projekt", plural: "Projekte" },
  credentials: {
    token: {
      title: "Vercel-Zugriffstoken",
      description:
        "netrics liest damit nur Projekte, Deployments, Web Analytics und Abrechnungsdaten und ändert nichts. Das Token wird verschlüsselt gespeichert und nie wieder angezeigt.",
    },
  },
  // Vercel's own interface is English: its labels stay as they appear there.
  setupSteps: [
    "Öffne in Vercel Account Settings → Tokens.",
    "Gib dem Token einen Namen (zum Beispiel „netrics“) und setze seinen Scope auf das Projekt, das du sehen willst, oder auf das Team, dem es gehört, wenn du zwischen mehreren Projekten wählen willst.",
    "Wähle ein Ablaufdatum. Wenn das Token abläuft, fragt diese Verbindung nach einem neuen.",
    "Klicke auf Create, kopiere das Token und füge es unten ein. Vercel zeigt es nur einmal an.",
  ],
  config: {
    teamId: {
      title: "Team-ID",
      description:
        "Lass das Feld leer, außer das Token sieht mehrere Vercel-Teams. Gib dann die ID des Teams ein, das gelesen werden soll: Team Settings → General, sie beginnt mit team_.",
    },
  },
  metrics: {
    [METRICS.pageviews]: {
      name: "Seitenaufrufe",
      description: "Seitenaufrufe pro Tag und Projekt.",
    },
    [METRICS.visitors]: {
      name: "Tägliche Besucher",
      description:
        "Eindeutige Besucher pro Tag und Projekt. Über mehrere Tage summiert zählt ein wiederkehrender Besucher einmal pro Tag.",
    },
    [METRICS.routePageviews]: {
      name: "Seitenaufrufe nach Route",
      description: `Seitenaufrufe pro Tag für die ${TOP_LIMIT} meistbesuchten Routen jedes Kalendermonats; andere Routen werden als „Others“ zusammengefasst.`,
    },
    [METRICS.countryVisitors]: {
      name: "Besucher nach Land",
      description: `Eindeutige Besucher pro Tag für die ${TOP_LIMIT} größten Länder jedes Kalendermonats (ISO-Codes); andere Länder werden als „Others“ zusammengefasst.`,
    },
    [METRICS.events]: {
      name: "Eigene Events",
      description: `Eigene Events pro Tag für die ${TOP_LIMIT} häufigsten Event-Namen jedes Kalendermonats; andere Events werden als „Others“ zusammengefasst.`,
    },
    [METRICS.deployments]: {
      name: "Deployments",
      description:
        "Deployments pro Tag (UTC), Projekt und Umgebung (production oder preview), nach ihrem Erstellungszeitpunkt.",
    },
    [METRICS.failedDeployments]: {
      name: "Fehlgeschlagene Deployments",
      description:
        "Deployments pro Tag (UTC), Projekt und Umgebung, die fehlgeschlagen sind (Zustand ERROR).",
    },
  },
  dimensions: {
    resource: "Projekt",
    route: "Route",
    country: "Land",
    event: "Event",
    target: "Umgebung",
  },
  freshnessStreams: {
    [ANALYTICS_STREAM]: "Besucher und Seitenaufrufe",
    [DEPLOYS_STREAM]: "Deployments",
    [BILLING_STREAM]: "Kosten",
  },
};

export const vercelManifest: ConnectorManifest = {
  id: "vercel",
  version: "0.2.0",
  sdkVersion: "^0.2.19",
  category: "web",
  brandColor: "#000000",
  name: "Vercel",
  description:
    "Deployments, the production state and Web Analytics (visitors, page views, custom events) of your Vercel projects, plus this month's charges.",
  url: "https://vercel.com",
  docsUrl:
    "https://github.com/netrics-so/netrics/blob/main/docs/connectors/vercel.md",
  authStrategies: [
    {
      strategy: "token",
      credentialsSchema: {
        type: "object",
        properties: {
          token: {
            type: "string",
            title: "Vercel access token",
            description:
              "netrics only reads projects, deployments, Web Analytics and billing charges with it and changes nothing. It is stored encrypted and never shown again.",
          },
        },
        required: ["token"],
        additionalProperties: false,
      },
      setup: {
        steps: [
          "In Vercel, open Account Settings → Tokens.",
          "Name the token (for example “netrics”) and set its scope to the project you want to see, or to the team that owns it if you want to choose among several projects.",
          "Choose an expiration. When the token expires, this connection asks for a new one.",
          "Click Create, then copy the token and paste it below. Vercel shows it only once.",
        ],
        url: "https://vercel.com/account/settings/tokens",
      },
    },
  ],
  configSchema: {
    type: "object",
    properties: {
      teamId: {
        type: "string",
        title: "Team ID",
        description:
          "Leave empty unless the token can see several Vercel teams. Then enter the ID of the team to read: Team Settings → General, it starts with team_.",
      },
    },
    additionalProperties: false,
  },
  datasets: [...VERCEL_DATASETS],
  metrics: [
    {
      key: METRICS.pageviews,
      name: "Page views",
      description: "Page views per day and project.",
      kind: "delta",
      unit: "pageviews",
      granularity: "day",
      dimensions: ["resource"],
      aggregations: ["sum", "avg", "min", "max"],
    },
    {
      key: METRICS.visitors,
      name: "Daily visitors",
      description:
        "Unique visitors per day and project. Summed over several days, a visitor who returns counts once per day.",
      kind: "delta",
      unit: "visitors",
      granularity: "day",
      dimensions: ["resource"],
      aggregations: ["sum", "avg", "min", "max"],
    },
    {
      key: METRICS.routePageviews,
      name: "Page views by route",
      description: `Page views per day for the ${TOP_LIMIT} busiest routes of each calendar month; other routes are grouped as "Others".`,
      kind: "delta",
      unit: "pageviews",
      granularity: "day",
      dimensions: ["resource", "route"],
      aggregations: ["sum", "avg", "min", "max"],
    },
    {
      key: METRICS.countryVisitors,
      name: "Visitors by country",
      description: `Unique visitors per day for the ${TOP_LIMIT} largest countries of each calendar month (ISO codes); other countries are grouped as "Others".`,
      kind: "delta",
      unit: "visitors",
      granularity: "day",
      dimensions: ["resource", "country"],
      aggregations: ["sum", "avg", "min", "max"],
    },
    {
      key: METRICS.events,
      name: "Custom events",
      description: `Custom events per day for the ${TOP_LIMIT} most frequent event names of each calendar month; other events are grouped as "Others".`,
      kind: "delta",
      unit: "events",
      granularity: "day",
      dimensions: ["resource", "event"],
      aggregations: ["sum", "avg", "min", "max"],
    },
    {
      key: METRICS.deployments,
      name: "Deployments",
      description:
        "Deployments per day (UTC), project and environment (production or preview), by when they were created.",
      kind: "delta",
      unit: "deployments",
      granularity: "day",
      dimensions: ["resource", "target"],
      aggregations: ["sum", "avg", "min", "max"],
    },
    {
      key: METRICS.failedDeployments,
      name: "Failed deployments",
      description:
        "Deployments per day (UTC), project and environment that failed (state ERROR).",
      kind: "delta",
      unit: "deployments",
      granularity: "day",
      dimensions: ["resource", "target"],
      aggregations: ["sum", "avg", "min", "max"],
      better: "lower",
    },
  ],
  minRefreshIntervalSeconds: 900,
  supportsBackfill: true,
  // Web Analytics: Pro plans keep 366 days; smaller plans are clamped at
  // sync time. Deployments are read back DEPLOYMENTS_BACKFILL_DAYS.
  backfillDays: 366,
  outboundDomains: ["api.vercel.com"],
  resourceNoun: { singular: "project", plural: "projects" },
  // The synced projects can be changed after connecting (#782).
  supportsResourceSelection: true,
  // Discovery is the project list, one cheap request: the host may name
  // the projects before a first run's pages (SDK 0.2.19, #782).
  discoversBeforeFirstSync: true,
  translations: { de: vercelDe },
  rateLimit: { maxRequests: 400, windowSeconds: 60 },
  // When the numbers arrive (ADR 0025): every stream is continuous, "read"
  // by each completed sync. Web Analytics and deployments are reported per
  // project, so a project without Web Analytics never claims its numbers
  // (#871); charges for the connection.
  freshnessStreams: [
    {
      key: ANALYTICS_STREAM,
      name: "Visitors and page views",
      kind: "continuous",
      metrics: [
        METRICS.pageviews,
        METRICS.visitors,
        METRICS.routePageviews,
        METRICS.countryVisitors,
        METRICS.events,
      ],
    },
    {
      key: DEPLOYS_STREAM,
      name: "Deployments",
      kind: "continuous",
      metrics: [METRICS.deployments, METRICS.failedDeployments],
      datasets: [deploymentsDataset.key, productionDeploymentsDataset.key],
    },
    {
      key: BILLING_STREAM,
      name: "Charges",
      kind: "continuous",
      datasets: [billingChargesDataset.key],
    },
  ],
};

// ─── Connector ──────────────────────────────────────────────────────────────

export type VercelConnectorOptions = ClientOptions;

/**
 * Vercel (#871; Web Analytics since milestone 05). Resources are projects,
 * every one the token lists, with or without Web Analytics.
 *
 * A sync is a resumable run of single-request steps (sync.ts): the
 * projects; per project its production deployment (the
 * `production_deployments` snapshot), its deployments created in the
 * window (the `deployments` dataset and daily counts) and, with Web
 * Analytics enabled, its daily visits, top routes, countries and events;
 * per team this month's billing charges (`billing_charges`).
 *
 * Web Analytics metrics are daily deltas stamped at UTC midnight of
 * Vercel's reporting day (ADR 0008). Vercel ranks the top routes, countries
 * and events over the queried range, so every query spans a whole calendar
 * month (up to today) and only the days inside the window are emitted: the
 * ranking, and with it every value, is the same whichever window asks.
 */
export function createVercelConnector(
  options: VercelConnectorOptions = {},
): Connector {
  const now = options.now ?? Date.now;

  function client(context: ConnectionContext, runtime: ConnectorRuntime) {
    const token = tokenOf(context);
    if (!token) {
      throw new Error("Vercel connection has no access token");
    }
    return createVercelClient(runtime, token, options);
  }

  return {
    manifest: vercelManifest,

    async check(context, runtime): Promise<CheckResult> {
      if (!tokenOf(context)) {
        return {
          ok: false,
          message: "Add a Vercel access token to this connection.",
        };
      }
      let projects: VercelProject[];
      try {
        projects = await listProjects(
          client(context, runtime),
          teamIdOf(context),
        );
      } catch (error) {
        if (error instanceof VercelApiError && error.isAuth) {
          return {
            ok: false,
            message:
              "Vercel rejected the access token: it has expired or was revoked. Create a new token in Vercel (Account Settings → Tokens) and update this connection.",
          };
        }
        if (error instanceof VercelApiError && error.status === 403) {
          return {
            ok: false,
            message: teamIdOf(context)
              ? "The token has no access to the configured team. Create the token with that team as its scope, or remove the team id."
              : "The token may not list projects. Create a token scoped to the team or project that owns the site.",
          };
        }
        throw error;
      }
      const selection = selectionOf(context);
      // Nothing is collected (#782): the token was accepted, and no
      // project is asked for anything, so none can be missing.
      if (selection?.length === 0) {
        return { ok: true };
      }
      if (projects.length === 0) {
        return {
          ok: false,
          message:
            "The token cannot see any projects. Create it with the team (or project) that owns the site as its scope.",
        };
      }
      if (selection) {
        // Every listed project can be synced: its deployments always, its
        // Web Analytics where enabled (#871).
        const listed = new Set(projects.map((project) => project.id));
        const missing = selection.filter((id) => !listed.has(id));
        if (missing.length > 0) {
          return {
            ok: false,
            message: `The token no longer has access to ${missing.length === 1 ? "a selected project" : `${missing.length} selected projects`} (${missing.join(", ")}). Use a token that covers them, or change the selection.`,
          };
        }
      }
      return { ok: true };
    },

    async discover(context, runtime): Promise<Resource[]> {
      const projects = await listProjects(
        client(context, runtime),
        teamIdOf(context),
      );
      return projects.map((project) => ({
        id: project.id,
        name: project.name,
        kind: "project",
        metadata: {
          accountId: project.accountId,
          webAnalytics: project.analytics,
        },
      }));
    },

    async sync(context, request: SyncRequest, runtime): Promise<SyncResult> {
      // An empty window, or an explicit empty selection (#782): nothing is
      // read, and nothing is reported as checked.
      const empty = emptyRun(request);
      if (empty) return empty;
      return syncPage(client(context, runtime), context, request, {
        now,
        log: runtime.log,
      });
    },
  };
}
