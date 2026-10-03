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
  SearchConsoleApiError,
  createSearchConsoleClient,
  type ClientOptions,
  type SearchConsoleClient,
} from "./api.js";

export const WEBMASTERS_READONLY_SCOPE =
  "https://www.googleapis.com/auth/webmasters.readonly";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Search Console keeps 16 months of performance data. */
export const RETENTION_MONTHS = 16;
/**
 * Days re-read by every incremental sync. Final data trails by about 2–3
 * days; a day that was not final at the last sync is read again until it is.
 */
export const INCREMENTAL_LOOKBACK_DAYS = 5;
/** Days per sync page: 16 months fit in about 70 pages. */
const CHUNK_DAYS = 7;
/** The dimensions a breakdown may use besides date. */
export const DIMENSIONS = ["page", "query", "country", "device"] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export const MAX_DIMENSIONS = 2;
/** Rows kept per day for a breakdown, highest clicks first. */
export const MAX_ROWS_PER_DAY = 5_000;
export const DEFAULT_ROWS_PER_DAY = 1_000;
/** Rows asked for per request; a day's breakdown pages with startRow. */
export const PAGE_ROWS = 2_500;
/**
 * Final data only: values never shrink once stored, and the lookback picks
 * up each day when Google finalizes it.
 */
export const DATA_STATE = "final";

/** "none", each dimension, and each pair, in DIMENSIONS order. */
export const DIMENSION_CHOICES: string[] = [
  "none",
  ...DIMENSIONS,
  ...DIMENSIONS.flatMap((first, index) =>
    DIMENSIONS.slice(index + 1).map((second) => `${first},${second}`),
  ),
];

const PREFIX = "google-search-console";
const BREAKDOWN_DIMENSIONS = ["resource", ...DIMENSIONS];

export const searchConsoleManifest: ConnectorManifest = {
  id: PREFIX,
  version: "0.1.0",
  sdkVersion: "^0.2.1",
  name: "Google Search Console",
  description:
    "Clicks, impressions, click-through rate and average position in Google Search, per Search Console property.",
  url: "https://search.google.com/search-console/about",
  docsUrl:
    "https://github.com/netrics-so/netrics/blob/main/docs/connectors/google-search-console.md",
  authStrategies: [
    {
      strategy: "oauth2",
      provider: "google",
      scopes: [WEBMASTERS_READONLY_SCOPE],
    },
  ],
  configSchema: {
    type: "object",
    properties: {
      siteUrl: {
        type: "string",
        title: "Property",
        description:
          'The Search Console property to read: a URL-prefix property ("https://example.com/") or a domain property ("sc-domain:example.com").',
      },
      dimensions: {
        type: "string",
        title: "Breakdown",
        description:
          "Optional breakdown besides the daily totals: none, or one or two of page, query, country and device.",
        enum: DIMENSION_CHOICES,
        default: "none",
      },
      rowLimit: {
        type: "integer",
        title: "Rows per day",
        description: `How many breakdown rows to keep per day, highest clicks first (at most ${MAX_ROWS_PER_DAY.toLocaleString("en-US")}).`,
        minimum: 1,
        maximum: MAX_ROWS_PER_DAY,
        default: DEFAULT_ROWS_PER_DAY,
      },
    },
    additionalProperties: false,
  },
  metrics: [
    {
      key: `${PREFIX}.clicks`,
      name: "Clicks",
      description: "Clicks from Google Search results per day and property.",
      kind: "delta",
      unit: "clicks",
      granularity: "day",
      dimensions: ["resource"],
      aggregations: ["sum", "avg", "min", "max"],
    },
    {
      key: `${PREFIX}.impressions`,
      name: "Impressions",
      description:
        "Times a page of the property appeared in Google Search results, per day.",
      kind: "delta",
      unit: "impressions",
      granularity: "day",
      dimensions: ["resource"],
      aggregations: ["sum", "avg", "min", "max"],
    },
    {
      key: `${PREFIX}.ctr`,
      name: "Click-through rate",
      description:
        "Clicks divided by impressions for one day (0–1); no value on days without impressions. Over several days the rate is total clicks over total impressions, not the average of daily rates.",
      kind: "gauge",
      unit: "ratio",
      granularity: "day",
      dimensions: ["resource"],
      aggregations: ["last", "min", "max"],
    },
    {
      key: `${PREFIX}.position`,
      name: "Average position",
      description:
        "Average topmost position in Google Search results for one day (1 is the top); no value on days without impressions. Over several days it is weighted by impressions: position sum over impressions.",
      kind: "gauge",
      unit: "position",
      granularity: "day",
      dimensions: ["resource"],
      aggregations: ["last", "min", "max"],
      // 1 is the top: a falling average position is an improvement.
      better: "lower",
    },
    {
      key: `${PREFIX}.position_sum`,
      name: "Position sum",
      description:
        "Average position × impressions per day. Divided by impressions over any days, it gives the impression-weighted average position.",
      kind: "delta",
      unit: "position",
      granularity: "day",
      dimensions: ["resource"],
      aggregations: ["sum"],
      // Only meaningful divided by impressions (derived metrics).
      role: "helper",
    },
    {
      key: `${PREFIX}.breakdown_clicks`,
      name: "Clicks by breakdown",
      description:
        "Clicks per day for the configured breakdown (page, query, country or device), top rows by clicks. Anonymized queries and the row limit leave sums below the totals.",
      kind: "delta",
      unit: "clicks",
      granularity: "day",
      dimensions: BREAKDOWN_DIMENSIONS,
      aggregations: ["sum", "avg", "min", "max"],
    },
    {
      key: `${PREFIX}.breakdown_impressions`,
      name: "Impressions by breakdown",
      description:
        "Impressions per day for the configured breakdown, top rows by clicks. Anonymized queries and the row limit leave sums below the totals.",
      kind: "delta",
      unit: "impressions",
      granularity: "day",
      dimensions: BREAKDOWN_DIMENSIONS,
      aggregations: ["sum", "avg", "min", "max"],
    },
    {
      key: `${PREFIX}.breakdown_position_sum`,
      name: "Position sum by breakdown",
      description:
        "Average position × impressions per day for the configured breakdown. Divided by the breakdown's impressions, it gives the impression-weighted average position of any group.",
      kind: "delta",
      unit: "position",
      granularity: "day",
      dimensions: BREAKDOWN_DIMENSIONS,
      aggregations: ["sum"],
      role: "helper",
    },
  ],
  // Final data changes once a day.
  minRefreshIntervalSeconds: 6 * 60 * 60,
  supportsBackfill: true,
  // At least 16 calendar months (at most 489 days); the sync clamps the
  // window to the oldest day Search Console keeps.
  backfillDays: 490,
  outboundDomains: ["searchconsole.googleapis.com"],
  // Google's per-property and per-user limit for Search Analytics queries.
  rateLimit: { maxRequests: 1200, windowSeconds: 60, scope: "property" },
};

// ─── Response shapes (a changed shape fails parsing, and the tests) ─────────

const sitesSchema = z.object({
  siteEntry: z
    .array(
      z
        .object({
          siteUrl: z.string().min(1),
          permissionLevel: z.string().min(1),
        })
        .loose(),
    )
    .optional(),
});

const analyticsSchema = z.object({
  rows: z
    .array(
      z
        .object({
          keys: z.array(z.string()).optional(),
          clicks: z.number(),
          impressions: z.number(),
          ctr: z.number(),
          position: z.number(),
        })
        .loose(),
    )
    .optional(),
});
type AnalyticsRow = NonNullable<z.infer<typeof analyticsSchema>["rows"]>[0];

export interface SearchConsoleProperty {
  siteUrl: string;
  permissionLevel: string;
}

// ─── Configuration ──────────────────────────────────────────────────────────

export interface SearchConsoleConfig {
  siteUrl: string | undefined;
  dimensions: Dimension[];
  rowLimit: number;
}

/**
 * Reads and enforces the connection config: at most two known dimensions
 * besides date, and 1–5,000 rows per day. The API validates the same limits
 * against the configSchema; this guards syncs of configs stored earlier.
 */
export function parseConfig(
  config: Record<string, unknown>,
): { ok: true; config: SearchConsoleConfig } | { ok: false; message: string } {
  const siteUrl =
    typeof config.siteUrl === "string" && config.siteUrl.trim() !== ""
      ? config.siteUrl.trim()
      : undefined;

  const rawDimensions = config.dimensions ?? "none";
  if (typeof rawDimensions !== "string") {
    return { ok: false, message: "The breakdown must be a text value." };
  }
  const dimensions =
    rawDimensions.trim() === "" || rawDimensions.trim() === "none"
      ? []
      : rawDimensions.split(",").map((entry) => entry.trim());
  const unknown = dimensions.filter(
    (entry) => !(DIMENSIONS as readonly string[]).includes(entry),
  );
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `Unknown breakdown dimension ${unknown.map((entry) => `"${entry}"`).join(", ")}. Use page, query, country or device.`,
    };
  }
  if (new Set(dimensions).size !== dimensions.length) {
    return { ok: false, message: "The breakdown names a dimension twice." };
  }
  if (dimensions.length > MAX_DIMENSIONS) {
    return {
      ok: false,
      message: `A breakdown can use at most ${MAX_DIMENSIONS} dimensions besides date (got ${dimensions.length}).`,
    };
  }

  const rowLimit = config.rowLimit ?? DEFAULT_ROWS_PER_DAY;
  if (
    typeof rowLimit !== "number" ||
    !Number.isInteger(rowLimit) ||
    rowLimit < 1 ||
    rowLimit > MAX_ROWS_PER_DAY
  ) {
    return {
      ok: false,
      message: `Rows per day must be a whole number from 1 to ${MAX_ROWS_PER_DAY}.`,
    };
  }

  return {
    ok: true,
    config: {
      siteUrl,
      dimensions: dimensions as Dimension[],
      rowLimit,
    },
  };
}

function accessTokenOf(context: ConnectionContext): string | undefined {
  const token = context.credentials.accessToken;
  return typeof token === "string" && token.trim() !== ""
    ? token.trim()
    : undefined;
}

async function listProperties(
  client: SearchConsoleClient,
): Promise<SearchConsoleProperty[]> {
  const body = sitesSchema.parse(await client.get("/sites"));
  return (body.siteEntry ?? [])
    .filter((entry) => entry.permissionLevel !== "siteUnverifiedUser")
    .map((entry) => ({
      siteUrl: entry.siteUrl,
      permissionLevel: entry.permissionLevel,
    }))
    .sort((a, b) => a.siteUrl.localeCompare(b.siteUrl));
}

function queryPath(siteUrl: string): string {
  return `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
}

// ─── Time windows ───────────────────────────────────────────────────────────

function startOfUtcDay(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** The oldest day Search Console still has: 16 calendar months back. */
export function oldestAvailableDay(todayMs: number): number {
  const today = new Date(todayMs);
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth() - RETENTION_MONTHS;
  // Clamp the day of month (31 March − 16 months is 30 November, not 1 December).
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(today.getUTCDate(), lastDay));
}

/** Chunks end on Mondays, so every window asks the same weeks. */
function chunkEndAfter(ms: number): number {
  const dayIndex = Math.floor(ms / DAY_MS);
  // 1970-01-05 (day 4) was a Monday.
  const sinceMonday = (((dayIndex - 4) % CHUNK_DAYS) + CHUNK_DAYS) % CHUNK_DAYS;
  return (dayIndex - sinceMonday + CHUNK_DAYS) * DAY_MS;
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function stamp(date: string): string {
  return `${date}T00:00:00.000Z`;
}

/**
 * Average position × impressions: 0 without impressions, whatever position
 * Google reports for such a row.
 */
function positionSum(row: AnalyticsRow): number {
  return row.impressions > 0 ? row.position * row.impressions : 0;
}

// ─── Connector ──────────────────────────────────────────────────────────────

export type SearchConsoleConnectorOptions = ClientOptions;

/**
 * Google Search Console (ADR 0012). The host hands the connector
 * `credentials: { accessToken }` and refreshes it; connector code never sees
 * the refresh token and only reaches searchconsole.googleapis.com.
 *
 * One connection reads one property (config `siteUrl`, also the `resource`
 * dimension). Every value is daily and stamped at UTC midnight of Search
 * Console's reporting date (ADR 0008).
 */
export function createSearchConsoleConnector(
  options: SearchConsoleConnectorOptions = {},
): Connector {
  const now = options.now ?? Date.now;

  function client(context: ConnectionContext, runtime: ConnectorRuntime) {
    const token = accessTokenOf(context);
    if (!token) {
      throw new Error("Search Console connection has no Google access token");
    }
    return createSearchConsoleClient(runtime, token, options);
  }

  function readConfig(context: ConnectionContext): SearchConsoleConfig {
    const parsed = parseConfig(context.config);
    if (!parsed.ok) throw new Error(parsed.message);
    return parsed.config;
  }

  async function query(
    api: SearchConsoleClient,
    siteUrl: string,
    body: Record<string, unknown>,
  ): Promise<AnalyticsRow[]> {
    const parsed = analyticsSchema.parse(
      await api.post(queryPath(siteUrl), {
        type: "web",
        dataState: DATA_STATE,
        aggregationType: "auto",
        ...body,
      }),
    );
    return parsed.rows ?? [];
  }

  /** One day's breakdown: the top `rowLimit` rows, paged by startRow. */
  async function breakdown(
    api: SearchConsoleClient,
    siteUrl: string,
    date: string,
    dimensions: Dimension[],
    rowLimit: number,
  ): Promise<AnalyticsRow[]> {
    const rows: AnalyticsRow[] = [];
    while (rows.length < rowLimit) {
      const requested = Math.min(PAGE_ROWS, rowLimit - rows.length);
      const page = await query(api, siteUrl, {
        startDate: date,
        endDate: date,
        dimensions,
        rowLimit: requested,
        startRow: rows.length,
      });
      rows.push(...page.slice(0, requested));
      if (page.length < requested) break;
    }
    return rows;
  }

  return {
    manifest: searchConsoleManifest,

    async check(context, runtime): Promise<CheckResult> {
      if (!accessTokenOf(context)) {
        return {
          ok: false,
          message:
            "This connection has no Google authorization. Reconnect Google.",
        };
      }
      const parsed = parseConfig(context.config);
      if (!parsed.ok) return { ok: false, message: parsed.message };
      const { siteUrl } = parsed.config;
      if (!siteUrl) {
        return {
          ok: false,
          message: "Choose a Search Console property to finish setup.",
        };
      }
      const api = client(context, runtime);
      let properties: SearchConsoleProperty[];
      try {
        properties = await listProperties(api);
      } catch (error) {
        if (
          error instanceof SearchConsoleApiError &&
          error.isPermissionDenied
        ) {
          return {
            ok: false,
            message:
              "Google refused to list Search Console properties for this account. Reconnect Google and allow access to Search Console.",
          };
        }
        throw error;
      }
      if (!properties.some((property) => property.siteUrl === siteUrl)) {
        return {
          ok: false,
          message: `The connected Google account has no verified access to ${siteUrl} in Search Console. Ask an owner of the property to add the account, or choose another property.`,
        };
      }
      // The listing can lag a removed permission; ask the property itself.
      try {
        const today = startOfUtcDay(now());
        await query(api, siteUrl, {
          startDate: day(today - 7 * DAY_MS),
          endDate: day(today),
          rowLimit: 1,
        });
      } catch (error) {
        if (
          error instanceof SearchConsoleApiError &&
          error.isPermissionDenied
        ) {
          return {
            ok: false,
            message: `Search Console refused access to ${siteUrl}. Check that the connected Google account still has access to the property, or choose another one.`,
          };
        }
        throw error;
      }
      return { ok: true };
    },

    async discover(context, runtime): Promise<Resource[]> {
      const properties = await listProperties(client(context, runtime));
      return properties.map((property) => ({
        id: property.siteUrl,
        name: property.siteUrl.startsWith("sc-domain:")
          ? property.siteUrl.slice("sc-domain:".length)
          : property.siteUrl,
        kind: property.siteUrl.startsWith("sc-domain:")
          ? "domain_property"
          : "url_prefix_property",
        metadata: {
          siteUrl: property.siteUrl,
          permissionLevel: property.permissionLevel,
        },
      }));
    },

    async sync(context, request: SyncRequest, runtime): Promise<SyncResult> {
      const config = readConfig(context);
      const siteUrl = config.siteUrl;
      if (!siteUrl) {
        throw new Error("Choose a Search Console property to finish setup.");
      }
      const todayMs = startOfUtcDay(now());
      const oldestMs = oldestAvailableDay(todayMs);
      const toMs = Date.parse(request.to);
      const fromMs = Date.parse(request.from);
      // Days before `to`, never in the future.
      const endMs = Math.min(
        startOfUtcDay(toMs - 1) + DAY_MS,
        todayMs + DAY_MS,
      );
      const startMs = Math.max(
        startOfUtcDay(request.cursor ? Date.parse(request.cursor) : fromMs),
        oldestMs,
      );
      // Where the next incremental sync starts: recent days are not final yet.
      const resumeAt = new Date(
        Math.max(
          startOfUtcDay(toMs) - INCREMENTAL_LOOKBACK_DAYS * DAY_MS,
          fromMs,
        ),
      ).toISOString();
      if (
        startMs >= endMs ||
        (request.resources !== undefined &&
          !request.resources.includes(siteUrl))
      ) {
        return { observations: [], nextCursor: resumeAt, done: true };
      }
      const chunkEnd = Math.min(chunkEndAfter(startMs), endMs);
      const api = client(context, runtime);
      const observations: Observation[] = [];
      const resource = { resource: siteUrl };

      const totals = await query(api, siteUrl, {
        startDate: day(startMs),
        endDate: day(chunkEnd - DAY_MS),
        dimensions: ["date"],
        rowLimit: CHUNK_DAYS,
      });
      // Ordered by date (Google orders rows by clicks).
      totals.sort((a, b) =>
        (a.keys?.[0] ?? "").localeCompare(b.keys?.[0] ?? ""),
      );
      const dates: string[] = [];
      for (const row of totals) {
        const date = row.keys?.[0];
        if (!date) continue;
        const ms = Date.parse(stamp(date));
        if (!(ms >= startMs && ms < chunkEnd)) continue;
        dates.push(date);
        const sourceTimestamp = stamp(date);
        observations.push(
          {
            metricKey: `${PREFIX}.clicks`,
            sourceTimestamp,
            value: row.clicks,
            dimensions: resource,
          },
          {
            metricKey: `${PREFIX}.impressions`,
            sourceTimestamp,
            value: row.impressions,
            dimensions: resource,
          },
          {
            metricKey: `${PREFIX}.position_sum`,
            sourceTimestamp,
            value: positionSum(row),
            dimensions: resource,
          },
        );
        // Without impressions a day has no position and no click-through
        // rate (Google reports 0 for both; position 0 would read as better
        // than rank 1). Sums and impression-weighted averages are unchanged:
        // the day adds 0 clicks, 0 impressions and 0 position sum.
        if (row.impressions > 0) {
          observations.push(
            {
              metricKey: `${PREFIX}.ctr`,
              sourceTimestamp,
              value: row.ctr,
              dimensions: resource,
            },
            {
              metricKey: `${PREFIX}.position`,
              sourceTimestamp,
              value: row.position,
              dimensions: resource,
            },
          );
        }
      }

      // Breakdowns only for days that have (final) data.
      if (config.dimensions.length > 0) {
        for (const date of dates) {
          const rows = await breakdown(
            api,
            siteUrl,
            date,
            config.dimensions,
            config.rowLimit,
          );
          const sourceTimestamp = stamp(date);
          for (const row of rows) {
            const keys = row.keys ?? [];
            if (keys.length !== config.dimensions.length) continue;
            const dimensions: Record<string, string> = { ...resource };
            config.dimensions.forEach((dimension, index) => {
              dimensions[dimension] = keys[index]!;
            });
            observations.push(
              {
                metricKey: `${PREFIX}.breakdown_clicks`,
                sourceTimestamp,
                value: row.clicks,
                dimensions,
              },
              {
                metricKey: `${PREFIX}.breakdown_impressions`,
                sourceTimestamp,
                value: row.impressions,
                dimensions,
              },
              {
                metricKey: `${PREFIX}.breakdown_position_sum`,
                sourceTimestamp,
                value: positionSum(row),
                dimensions,
              },
            );
          }
        }
      }

      if (chunkEnd < endMs) {
        return {
          observations,
          nextCursor: new Date(chunkEnd).toISOString(),
          done: false,
        };
      }
      return { observations, nextCursor: resumeAt, done: true };
    },
  };
}
