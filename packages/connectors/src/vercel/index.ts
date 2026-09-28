import type {
  CheckResult,
  ConnectionContext,
  Connector,
  ConnectorManifest,
  ConnectorRuntime,
  Observation,
  Resource,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";
import { z } from "zod";

import {
  VercelApiError,
  createVercelClient,
  type ClientOptions,
  type Query,
  type VercelGet,
} from "./api.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Days re-read on every incremental sync: Vercel keeps counting today. */
const INCREMENTAL_LOOKBACK_DAYS = 1;
/** Top routes, countries and events kept per calendar month; the rest is "Others". */
export const TOP_LIMIT = 10;
const MAX_PROJECT_PAGES = 10;

export const vercelManifest: ConnectorManifest = {
  id: "vercel",
  version: "0.1.1",
  sdkVersion: "^0.2.0",
  name: "Vercel Web Analytics",
  description:
    "Visitors, page views and custom events from Vercel Web Analytics, per project.",
  url: "https://vercel.com/docs/analytics",
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
              "netrics only reads project details and Web Analytics with it. It is stored encrypted and never shown again.",
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
  metrics: [
    {
      key: "vercel.pageviews",
      name: "Page views",
      description: "Page views per day and project.",
      kind: "delta",
      unit: "pageviews",
      granularity: "day",
      dimensions: ["resource"],
      aggregations: ["sum", "avg", "min", "max"],
    },
    {
      key: "vercel.visitors",
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
      key: "vercel.route_pageviews",
      name: "Page views by route",
      description: `Page views per day for the ${TOP_LIMIT} busiest routes of each calendar month; other routes are grouped as "Others".`,
      kind: "delta",
      unit: "pageviews",
      granularity: "day",
      dimensions: ["resource", "route"],
      aggregations: ["sum", "avg", "min", "max"],
    },
    {
      key: "vercel.country_visitors",
      name: "Visitors by country",
      description: `Unique visitors per day for the ${TOP_LIMIT} largest countries of each calendar month (ISO codes); other countries are grouped as "Others".`,
      kind: "delta",
      unit: "visitors",
      granularity: "day",
      dimensions: ["resource", "country"],
      aggregations: ["sum", "avg", "min", "max"],
    },
    {
      key: "vercel.events",
      name: "Custom events",
      description: `Custom events per day for the ${TOP_LIMIT} most frequent event names of each calendar month; other events are grouped as "Others".`,
      kind: "delta",
      unit: "events",
      granularity: "day",
      dimensions: ["resource", "event"],
      aggregations: ["sum", "avg", "min", "max"],
    },
  ],
  minRefreshIntervalSeconds: 900,
  supportsBackfill: true,
  // Pro plans keep 366 days; smaller plans are clamped at sync time.
  backfillDays: 366,
  outboundDomains: ["api.vercel.com"],
  rateLimit: { maxRequests: 400, windowSeconds: 60 },
};

// ─── Response shapes (a changed shape fails parsing, and the tests) ─────────

const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  accountId: z.string().min(1),
  webAnalytics: z
    .object({ enabledAt: z.number().optional() })
    .loose()
    .nullish(),
});
const projectsPageSchema = z.object({
  projects: z.array(projectSchema.loose()),
  pagination: z
    .object({ next: z.union([z.number(), z.string()]).nullish() })
    .loose()
    .optional(),
});
const bucketSchema = z.object({ timestamp: z.iso.datetime() }).loose();
const visitsSchema = z.object({
  data: z.array(
    bucketSchema.extend({ visitors: z.number(), pageviews: z.number() }),
  ),
});
const eventsSchema = z.object({
  data: z.array(
    bucketSchema.extend({ eventName: z.string(), count: z.number() }),
  ),
});

interface VercelProject {
  id: string;
  name: string;
  accountId: string;
  analytics: boolean;
}

// ─── Configuration ──────────────────────────────────────────────────────────

function tokenOf(context: ConnectionContext): string | undefined {
  const token = context.credentials.token;
  return typeof token === "string" && token.trim() !== ""
    ? token.trim()
    : undefined;
}

function teamIdOf(context: ConnectionContext): string | undefined {
  const teamId = context.config.teamId;
  return typeof teamId === "string" && teamId !== "" ? teamId : undefined;
}

function selectionOf(context: ConnectionContext): string[] | undefined {
  const selection = context.config.resourceSelection;
  return Array.isArray(selection) &&
    selection.length > 0 &&
    selection.every((id) => typeof id === "string")
    ? (selection as string[])
    : undefined;
}

/** Requests on behalf of a team need its id; personal accounts do not. */
function ownerQuery(accountId: string): Query {
  return accountId.startsWith("team_") ? { teamId: accountId } : {};
}

async function listProjects(
  get: VercelGet,
  teamId: string | undefined,
): Promise<VercelProject[]> {
  const projects: VercelProject[] = [];
  let from: string | undefined;
  for (let page = 0; page < MAX_PROJECT_PAGES; page += 1) {
    const body = projectsPageSchema.parse(
      await get("/v10/projects", { limit: "100", teamId, from }),
    );
    for (const project of body.projects) {
      projects.push({
        id: project.id,
        name: project.name,
        accountId: project.accountId,
        analytics: typeof project.webAnalytics?.enabledAt === "number",
      });
    }
    const next = body.pagination?.next;
    if (next === null || next === undefined) break;
    from = String(next);
  }
  return projects;
}

// ─── Time windows ───────────────────────────────────────────────────────────

function startOfUtcDay(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function startOfNextUtcMonth(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function startOfUtcMonth(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** "the pro plan only grants access to the latest 366 days of data" */
function planWindowDays(error: VercelApiError): number | null {
  if (error.status !== 400) return null;
  const match = /latest (\d+) (day|month)s?/i.exec(error.message);
  if (!match) return null;
  const count = Number(match[1]);
  return match[2]!.toLowerCase() === "month" ? count * 28 : count;
}

// ─── Connector ──────────────────────────────────────────────────────────────

export type VercelConnectorOptions = ClientOptions;

/**
 * Vercel Web Analytics. Resources are projects; every metric is a daily
 * delta stamped at UTC midnight of Vercel's reporting day (ADR 0008).
 *
 * Each sync page covers at most one calendar month. Vercel ranks the top
 * routes, countries and events over the queried range, so every query spans
 * the whole month (up to today) and only the days inside the requested
 * window are emitted: the ranking, and with it every value, is the same
 * whichever window asks for a day.
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
      if (projects.length === 0) {
        return {
          ok: false,
          message:
            "The token cannot see any projects. Create it with the team (or project) that owns the site as its scope.",
        };
      }
      const selection = selectionOf(context);
      if (selection) {
        const byId = new Map(projects.map((project) => [project.id, project]));
        const missing = selection.filter((id) => !byId.has(id));
        if (missing.length > 0) {
          return {
            ok: false,
            message: `The token no longer has access to ${missing.length === 1 ? "a selected project" : `${missing.length} selected projects`} (${missing.join(", ")}). Use a token that covers them, or change the selection.`,
          };
        }
        const disabled = selection
          .map((id) => byId.get(id)!)
          .filter((project) => !project.analytics);
        if (disabled.length > 0) {
          return {
            ok: false,
            message: `Web Analytics is not enabled for ${disabled.map((project) => project.name).join(", ")}. Enable it in the project's Analytics tab in Vercel.`,
          };
        }
      } else if (!projects.some((project) => project.analytics)) {
        return {
          ok: false,
          message:
            "None of the projects this token can see has Web Analytics enabled. Enable it in the project's Analytics tab in Vercel.",
        };
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
      const get = client(context, runtime);
      const toMs = Date.parse(request.to);
      const startMs = startOfUtcDay(
        request.cursor ? Date.parse(request.cursor) : Date.parse(request.from),
      );
      // Where the next incremental sync starts: recent days keep changing.
      const resumeAt = new Date(
        Math.max(
          startOfUtcDay(toMs) - INCREMENTAL_LOOKBACK_DAYS * DAY_MS,
          Date.parse(request.from),
        ),
      ).toISOString();
      if (startMs >= toMs) {
        return { observations: [], nextCursor: resumeAt, done: true };
      }
      const chunkEnd = Math.min(startOfNextUtcMonth(startMs), toMs);
      const monthStart = startOfUtcMonth(startMs);
      // The month is ranked up to today (never beyond: Vercel rejects the future).
      const todayMs = startOfUtcDay(now());
      const monthLastDay = Math.min(
        startOfNextUtcMonth(startMs) - DAY_MS,
        todayMs,
      );

      const projects = (await listProjects(get, teamIdOf(context))).filter(
        (project) =>
          project.analytics &&
          (!request.resources || request.resources.includes(project.id)),
      );

      const observations: Observation[] = [];
      let planStart: number | null = null;
      const inWindow = (timestamp: string) => {
        const ms = Date.parse(timestamp);
        return ms >= startMs && ms < chunkEnd;
      };

      for (const project of projects) {
        const query = async (
          path: string,
          by: string[],
          extra: Query = {},
        ): Promise<unknown> => {
          const since = Math.max(monthStart, planStart ?? monthStart);
          if (since > monthLastDay) return { data: [] };
          try {
            return await get(path, {
              ...ownerQuery(project.accountId),
              projectId: project.id,
              since: day(since),
              until: day(monthLastDay),
              by,
              ...extra,
            });
          } catch (error) {
            const days =
              error instanceof VercelApiError ? planWindowDays(error) : null;
            if (days === null || planStart !== null) throw error;
            // The plan keeps fewer days than the backfill asks for.
            planStart = todayMs - (days - 1) * DAY_MS;
            return query(path, by, extra);
          }
        };

        const visits = visitsSchema.parse(
          await query("/v1/query/web-analytics/visits/aggregate", ["day"]),
        );
        for (const row of visits.data) {
          if (!inWindow(row.timestamp)) continue;
          const dimensions = { resource: project.id };
          const sourceTimestamp = new Date(row.timestamp).toISOString();
          observations.push(
            {
              metricKey: "vercel.pageviews",
              sourceTimestamp,
              value: row.pageviews,
              dimensions,
            },
            {
              metricKey: "vercel.visitors",
              sourceTimestamp,
              value: row.visitors,
              dimensions,
            },
          );
        }

        for (const [dimension, key, field, metricKey] of [
          ["route", "route", "pageviews", "vercel.route_pageviews"],
          ["country", "country", "visitors", "vercel.country_visitors"],
        ] as const) {
          const body = visitsSchema.parse(
            await query(
              "/v1/query/web-analytics/visits/aggregate",
              ["day", dimension],
              { limit: String(TOP_LIMIT) },
            ),
          );
          for (const row of body.data) {
            const value = row[dimension];
            if (!inWindow(row.timestamp) || typeof value !== "string") continue;
            observations.push({
              metricKey,
              sourceTimestamp: new Date(row.timestamp).toISOString(),
              value: row[field],
              dimensions: { resource: project.id, [key]: value },
            });
          }
        }

        const events = eventsSchema.parse(
          await query(
            "/v1/query/web-analytics/events/aggregate",
            ["day", "eventName"],
            { limit: String(TOP_LIMIT) },
          ),
        );
        for (const row of events.data) {
          if (!inWindow(row.timestamp)) continue;
          observations.push({
            metricKey: "vercel.events",
            sourceTimestamp: new Date(row.timestamp).toISOString(),
            value: row.count,
            dimensions: { resource: project.id, event: row.eventName },
          });
        }
      }

      // Older months than the plan keeps have nothing to read: skip ahead.
      const next =
        planStart !== null && planStart > chunkEnd ? planStart : chunkEnd;
      if (next < toMs) {
        return {
          observations,
          nextCursor: new Date(next).toISOString(),
          done: false,
        };
      }
      return { observations, nextCursor: resumeAt, done: true };
    },
  };
}
