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
  EU_HOST,
  PostHogApiError,
  US_HOST,
  createPostHogClient,
  type ClientOptions,
} from "./api.js";
import {
  POSTHOG_DATASETS,
  insightResultsDataset,
  insightsDataset,
  topEventsDataset,
} from "./datasets.js";
import { PROBE_BODY } from "./queries.js";
import {
  HOST_INVALID_CODE,
  HOST_INVALID_MESSAGE,
  INSIGHTS_INVALID_CODE,
  INSIGHTS_INVALID_MESSAGE,
  KEY_REJECTED_CODE,
  KEY_REJECTED_MESSAGE,
  MAX_INSIGHTS,
  REGIONS,
  SCOPE_MISSING_CODE,
  SCOPE_MISSING_MESSAGE,
  apiKeyOf,
  hostOf,
  insightsOf,
  listProjects,
  organizationsPage,
  projectsPage,
  rethrow,
} from "./reading.js";
import {
  ANALYTICS_STREAM,
  INSIGHTS_STREAM,
  METRICS,
  syncPage,
} from "./sync.js";

export { PostHogApiError, createPostHogClient } from "./api.js";
export {
  HOST_INVALID_CODE,
  HOST_INVALID_MESSAGE,
  INSIGHTS_INVALID_CODE,
  INSIGHTS_INVALID_MESSAGE,
  KEY_REJECTED_CODE,
  KEY_REJECTED_MESSAGE,
  REQUIRED_SCOPES,
  SCOPE_MISSING_CODE,
  SCOPE_MISSING_MESSAGE,
} from "./reading.js";
export {
  ANALYTICS_STREAM,
  INSIGHTS_STREAM,
  MAX_INSIGHT_ROWS,
  MAX_REQUESTS_PER_PAGE,
  METRICS,
} from "./sync.js";

/** How far a first sync reads back. */
export const BACKFILL_DAYS = 90;

// ─── Manifest ───────────────────────────────────────────────────────────────

/**
 * German texts of the manifest (ADR 0016, #257): "du" where the text
 * addresses the reader; PostHog's own labels stay as they appear there.
 */
const posthogDe: ManifestTranslation = {
  name: "PostHog",
  description:
    "Events, Seitenaufrufe und aktive Nutzer pro Tag aus PostHog, pro Projekt, dazu die Ergebnisse ausgewählter gespeicherter Insights.",
  resourceNoun: { singular: "Projekt", plural: "Projekte" },
  credentials: {
    token: {
      title: "Personal API Key",
      description:
        "Ein Personal API Key mit den Lese-Scopes Organization, Project, Query und Insight. netrics liest damit nur und ändert nichts. Der Key wird verschlüsselt gespeichert und nie wieder angezeigt.",
    },
  },
  setupSteps: [
    "Öffne in PostHog Settings → Personal API keys (oben rechts über dein Profil).",
    "Klicke auf „Create personal API key“, gib ihm einen Namen (zum Beispiel „netrics“) und wähle die Organisation oder die Projekte, die netrics lesen soll.",
    "Wähle die Scopes Organization: Read, Project: Read, Query: Read und Insight: Read, klicke auf Create und kopiere den Key. PostHog zeigt ihn nur einmal an.",
    "Wähle unten die Region deines PostHog (US oder EU Cloud) oder „self-hosted“ mit dem Host deiner Instanz, und füge den Key ein.",
  ],
  config: {
    region: {
      title: "Region",
      description:
        "„us“ für PostHog Cloud US (us.posthog.com), „eu“ für PostHog Cloud EU (eu.posthog.com), „self-hosted“ für deine eigene Instanz.",
    },
    host: {
      title: "Host (self-hosted)",
      description:
        "Nur für „self-hosted“: der Host-Name deiner PostHog-Instanz, zum Beispiel posthog.example.com. netrics erreicht ihn über https; er muss öffentlich erreichbar sein.",
    },
    insights: {
      title: "Gespeicherte Insights",
      description:
        "Optional: Links zu gespeicherten Trends-Insights, deren Ergebnisse netrics liest (…/project/12345/insights/AbCd1234), getrennt durch Leerzeichen oder Kommas, höchstens 20.",
    },
  },
  metrics: {
    [METRICS.events]: {
      name: "Events",
      description: "Alle Events pro Tag (UTC) und Projekt.",
    },
    [METRICS.pageviews]: {
      name: "Seitenaufrufe",
      description: "$pageview-Events pro Tag (UTC) und Projekt.",
    },
    [METRICS.dau]: {
      name: "Täglich aktive Nutzer",
      description:
        "Verschiedene Personen mit mindestens einem Event an einem Tag (UTC), pro Projekt.",
    },
    [METRICS.wau]: {
      name: "Wöchentlich aktive Nutzer",
      description:
        "Verschiedene Personen mit mindestens einem Event in den 7 Tagen bis zu einem Tag (UTC), pro Projekt.",
    },
    [METRICS.mau]: {
      name: "Monatlich aktive Nutzer",
      description:
        "Verschiedene Personen mit mindestens einem Event in den 30 Tagen bis zu einem Tag (UTC), pro Projekt.",
    },
  },
  dimensions: { resource: "Projekt" },
  freshnessStreams: {
    [ANALYTICS_STREAM]: "Tageszahlen",
    [INSIGHTS_STREAM]: "Insights",
  },
};

const ACTIVE_USERS = {
  kind: "gauge",
  unit: "users",
  granularity: "day",
  dimensions: ["resource"],
  aggregations: ["last", "avg", "min", "max"],
  better: "higher",
} as const;

export const posthogManifest: ConnectorManifest = {
  id: "posthog",
  version: "0.1.0",
  sdkVersion: "^0.2.20",
  category: "web",
  brandColor: "#1d4aff",
  name: "PostHog",
  description:
    "Events, pageviews and active users per day from PostHog, per project, and the results of saved insights you choose.",
  url: "https://posthog.com",
  docsUrl:
    "https://github.com/netrics-so/netrics/blob/main/docs/connectors/posthog.md",
  authStrategies: [
    {
      strategy: "token",
      credentialsSchema: {
        type: "object",
        properties: {
          token: {
            type: "string",
            title: "Personal API key",
            description:
              "A personal API key with the read scopes Organization, Project, Query and Insight. netrics only reads with it and changes nothing. It is stored encrypted and never shown again.",
          },
        },
        required: ["token"],
        additionalProperties: false,
      },
      setup: {
        steps: [
          "In PostHog, open Settings → Personal API keys (top right, through your profile).",
          "Click “Create personal API key”, name it (for example “netrics”) and choose the organization or the projects netrics should read.",
          "Choose the scopes Organization: Read, Project: Read, Query: Read and Insight: Read, click Create and copy the key. PostHog shows it only once.",
          "Below, choose your PostHog's region (US or EU Cloud), or “self-hosted” with your instance's host, and paste the key.",
        ],
        url: "https://us.posthog.com/settings/user-api-keys",
      },
    },
  ],
  configSchema: {
    type: "object",
    properties: {
      region: {
        type: "string",
        title: "Region",
        description:
          "“us” for PostHog Cloud US (us.posthog.com), “eu” for PostHog Cloud EU (eu.posthog.com), “self-hosted” for your own instance.",
        enum: [...REGIONS],
        default: "us",
      },
      host: {
        type: "string",
        title: "Host (self-hosted)",
        description:
          "Only for “self-hosted”: the host name of your PostHog instance, such as posthog.example.com. netrics reaches it over https; it must be reachable from the internet.",
        maxLength: 253,
      },
      insights: {
        type: "string",
        title: "Saved insights",
        description: `Optional: links to saved trends insights whose results netrics reads (…/project/12345/insights/AbCd1234), separated by spaces or commas, at most ${MAX_INSIGHTS}.`,
        maxLength: 4000,
      },
    },
    additionalProperties: false,
  },
  datasets: [...POSTHOG_DATASETS],
  metrics: [
    {
      key: METRICS.events,
      name: "Events",
      description: "All events per day (UTC) and project.",
      kind: "delta",
      unit: "events",
      granularity: "day",
      dimensions: ["resource"],
      aggregations: ["sum", "avg", "min", "max"],
    },
    {
      key: METRICS.pageviews,
      name: "Pageviews",
      description: "$pageview events per day (UTC) and project.",
      kind: "delta",
      unit: "pageviews",
      granularity: "day",
      dimensions: ["resource"],
      aggregations: ["sum", "avg", "min", "max"],
      better: "higher",
    },
    {
      key: METRICS.dau,
      name: "Daily active users",
      description:
        "Distinct people with at least one event on a day (UTC), per project.",
      ...ACTIVE_USERS,
      aggregations: [...ACTIVE_USERS.aggregations],
      dimensions: [...ACTIVE_USERS.dimensions],
    },
    {
      key: METRICS.wau,
      name: "Weekly active users",
      description:
        "Distinct people with at least one event in the 7 days through a day (UTC), per project.",
      ...ACTIVE_USERS,
      aggregations: [...ACTIVE_USERS.aggregations],
      dimensions: [...ACTIVE_USERS.dimensions],
    },
    {
      key: METRICS.mau,
      name: "Monthly active users",
      description:
        "Distinct people with at least one event in the 30 days through a day (UTC), per project.",
      ...ACTIVE_USERS,
      aggregations: [...ACTIVE_USERS.aggregations],
      dimensions: [...ACTIVE_USERS.dimensions],
    },
  ],
  minRefreshIntervalSeconds: 900,
  supportsBackfill: true,
  backfillDays: BACKFILL_DAYS,
  outboundDomains: [US_HOST, EU_HOST],
  // A self-hosted connection reaches its own host, and only that one.
  configuredHosts: ["host"],
  resourceNoun: { singular: "project", plural: "projects" },
  supportsResourceSelection: true,
  // Discovery is the organization and project lists: a few cheap requests.
  discoversBeforeFirstSync: true,
  translations: { de: posthogDe },
  // Some PostHog plans allow 120 queries an hour (most 2,400).
  rateLimit: { maxRequests: 120, windowSeconds: 3600 },
  freshnessStreams: [
    {
      key: ANALYTICS_STREAM,
      name: "Daily numbers",
      kind: "periodic",
      period: "day",
      timeZone: "UTC",
      metrics: Object.values(METRICS),
      datasets: [topEventsDataset.key],
    },
    {
      key: INSIGHTS_STREAM,
      name: "Insights",
      kind: "continuous",
      datasets: [insightResultsDataset.key, insightsDataset.key],
    },
  ],
};

// ─── Connector ──────────────────────────────────────────────────────────────

export interface PostHogConnectorOptions extends ClientOptions {
  /** The clock of the sync windows; replaced in tests. */
  now?: () => number;
}

/**
 * PostHog (#873), over its private API with a personal API key, on PostHog
 * Cloud US or EU or a self-hosted host. Read only (see api.ts).
 *
 * Resources are projects (the `resource` dimension), chosen after
 * connecting. Per project and UTC day: events, pageviews and active users
 * (one TrendsQuery per window) and the top events (one HogQL query per
 * window); per configured saved insight, its last results.
 */
export function createPostHogConnector(
  options: PostHogConnectorOptions = {},
): Connector {
  const now = options.now ?? Date.now;

  function client(
    context: Parameters<Connector["check"]>[0],
    runtime: Parameters<Connector["check"]>[1],
  ) {
    const apiKey = apiKeyOf(context);
    if (!apiKey) throw new Error("PostHog connection has no API key");
    const host = hostOf(context);
    if (!host) throw new Error(HOST_INVALID_MESSAGE);
    return createPostHogClient(runtime, host, apiKey, options);
  }

  return {
    manifest: posthogManifest,

    async check(context, runtime): Promise<CheckResult> {
      if (!apiKeyOf(context)) {
        return {
          ok: false,
          message: "Add a PostHog personal API key to this connection.",
        };
      }
      if (!hostOf(context)) {
        return {
          ok: false,
          message: HOST_INVALID_MESSAGE,
          code: HOST_INVALID_CODE,
        };
      }
      const { insights, invalid } = insightsOf(context);
      if (invalid > 0) {
        return {
          ok: false,
          message: INSIGHTS_INVALID_MESSAGE,
          code: INSIGHTS_INVALID_CODE,
        };
      }
      try {
        const api = client(context, runtime);
        // The cheapest reads of what a sync needs: one organization, one
        // project, a constant query, and the configured insights' listing.
        const [organization] = (await organizationsPage(api, 0)).organizations;
        if (organization) {
          const [project] = (await projectsPage(api, organization.id, 0, 1))
            .projects;
          if (project) await api.query(project.id, PROBE_BODY);
        }
        if (insights[0]) {
          await api
            .get(`/api/projects/${insights[0].project}/insights/`, {
              basic: "true",
              limit: 1,
            })
            .catch((error: unknown) => {
              // A project the key cannot see is the sync's to report.
              if (
                error instanceof PostHogApiError &&
                (error.kind === "forbidden" || error.kind === "not_found")
              ) {
                return null;
              }
              throw error;
            });
        }
      } catch (error) {
        if (error instanceof PostHogApiError && error.kind === "auth") {
          return {
            ok: false,
            message: KEY_REJECTED_MESSAGE,
            code: KEY_REJECTED_CODE,
          };
        }
        if (error instanceof PostHogApiError && error.kind === "scope") {
          return {
            ok: false,
            message: SCOPE_MISSING_MESSAGE,
            code: SCOPE_MISSING_CODE,
          };
        }
        throw error;
      }
      return { ok: true };
    },

    async discover(context, runtime): Promise<Resource[]> {
      try {
        return (await listProjects(client(context, runtime))).map(
          (project) => ({
            id: project.id,
            name: project.name,
            kind: "project",
            metadata: { organizationId: project.organizationId },
          }),
        );
      } catch (error) {
        rethrow(error);
      }
    },

    async sync(context, request: SyncRequest, runtime): Promise<SyncResult> {
      try {
        return await syncPage(client(context, runtime), context, request, {
          now,
          ...(runtime.log ? { log: runtime.log } : {}),
        });
      } catch (error) {
        rethrow(error);
      }
    },
  };
}
