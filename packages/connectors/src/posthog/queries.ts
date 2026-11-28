// The requests the PostHog connector sends, and the shapes of their
// answers (checked against PostHog's OpenAPI schema, 2026-11). A changed
// shape fails parsing (and the contract tests) instead of storing something
// else.

import { z } from "zod";

import { PostHogApiError } from "./api.js";

/** Rows per listing page; PostHog's own default is 100. */
export const LIST_LIMIT = 100;
/** Event names per day in the top events. */
export const TOP_EVENTS = 10;
/**
 * The LIMIT of the top-events query. A window holds at most
 * MAX_WINDOW_DAYS × TOP_EVENTS rows, far below it; an answer that reaches
 * it may have been cut and is refused.
 */
export const TOP_EVENTS_ROW_LIMIT = 1_000;
/** Days per analytics query: a month keeps a query short. */
export const MAX_WINDOW_DAYS = 31;

// ─── Listings ───────────────────────────────────────────────────────────────

/** A DRF page: `{ count, next, previous, results }`. */
function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    count: z.number().int().nonnegative().optional(),
    next: z.string().nullable().optional(),
    results: z.array(item),
  });
}

export const organizationsSchema = pageSchema(
  z.object({ id: z.string().min(1), name: z.string() }),
);

export const projectsSchema = pageSchema(
  z.object({
    id: z.number().int(),
    name: z.string(),
  }),
);

const seriesSchema = z
  .object({
    // A single-number formula insight answers `data: null` with its
    // `aggregated_value` (PostHog's trends_query_runner, #888 item 4).
    data: z.array(z.number().nullable()).nullable().optional(),
    days: z.array(z.string()).optional(),
    label: z.string().nullable().optional(),
    count: z.number().nullable().optional(),
    aggregated_value: z.number().nullable().optional(),
    breakdown_value: z.unknown().optional(),
    compare_label: z.string().nullable().optional(),
    action: z
      .object({ order: z.number().int().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export type TrendsSeries = z.infer<typeof seriesSchema>;

const insightSchema = z
  .object({
    id: z.number().int(),
    short_id: z.string().min(1),
    name: z.string().nullable().optional(),
    derived_name: z.string().nullable().optional(),
    deleted: z.boolean().optional(),
    last_refresh: z.string().nullable().optional(),
    query: z
      .object({
        kind: z.string(),
        source: z
          .object({
            kind: z.string(),
            interval: z.string().nullable().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    result: z.unknown().optional(),
    query_status: z
      .object({ complete: z.boolean().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export type Insight = z.infer<typeof insightSchema>;

export const insightsSchema = pageSchema(insightSchema);

/**
 * A page of the insight list for the picker (#891), with `basic=true`:
 * only what names an insight and says its kind (the query may be left out).
 */
export const insightListSchema = pageSchema(
  insightSchema.pick({
    short_id: true,
    name: true,
    derived_name: true,
    deleted: true,
    query: true,
  }),
);

export const trendsResultSchema = z.array(seriesSchema);

// ─── Pagination ─────────────────────────────────────────────────────────────

/**
 * Where a DRF listing continues: the offset of its `next` URL, or null
 * when it is done. PostHog's `next` is an absolute URL whose scheme and
 * host a self-hosted proxy may get wrong, so only its offset is used, and
 * the request stays on the connection's host. A page that says there is
 * more without a usable next offset is invalid, and so is one that would
 * not move forward.
 */
export function nextOffset(
  page: { count?: number; next?: string | null; results: unknown[] },
  offset: number,
): number | null {
  const seen = offset + page.results.length;
  if (page.next === null || page.next === undefined || page.next === "") {
    if (page.count !== undefined && page.count > seen) {
      throw new PostHogApiError(
        200,
        "invalid",
        `the listing has ${page.count} entries but no next page after ${seen}`,
      );
    }
    return null;
  }
  let next: number;
  try {
    const value = new URL(
      page.next,
      "https://posthog.invalid",
    ).searchParams.get("offset");
    next = value !== null && /^\d+$/.test(value) ? Number(value) : NaN;
  } catch {
    next = NaN;
  }
  if (
    !Number.isSafeInteger(next) ||
    next <= offset ||
    page.results.length === 0
  ) {
    throw new PostHogApiError(
      200,
      "invalid",
      "the listing names a next page that does not continue it",
    );
  }
  return next;
}

// ─── Analytics queries ──────────────────────────────────────────────────────

/** The series of the daily trends query, in this order. */
export const TREND_SERIES = [
  { key: "events", event: null, math: "total" },
  { key: "pageviews", event: "$pageview", math: "total" },
  { key: "dau", event: null, math: "dau" },
  { key: "wau", event: null, math: "weekly_active" },
  { key: "mau", event: null, math: "monthly_active" },
] as const;
export type TrendKey = (typeof TREND_SERIES)[number]["key"];

/**
 * Days are UTC calendar days, whatever the project's time zone: the
 * `convertToProjectTimezone: false` modifier (#873, see the docs).
 */
const UTC_MODIFIERS = { convertToProjectTimezone: false };

/**
 * One TrendsQuery for every daily number of a window: all events, `$pageview`
 * events, and unique users per day, per 7 and per 30 days (PostHog's `dau`,
 * `weekly_active` and `monthly_active`). Both dates are inclusive.
 */
export function trendsBody(fromDay: string, toDay: string) {
  return {
    query: {
      kind: "TrendsQuery",
      series: TREND_SERIES.map((series) => ({
        kind: "EventsNode",
        event: series.event,
        math: series.math,
      })),
      interval: "day",
      dateRange: { date_from: fromDay, date_to: toDay },
      filterTestAccounts: false,
      modifiers: UTC_MODIFIERS,
    },
    refresh: "blocking",
    name: "netrics daily trends",
  };
}

/**
 * The TOP_EVENTS event names per UTC day of a window [fromDay, toDay], by
 * count. The dates are formatted by netrics (YYYY-MM-DD); nothing else is
 * placed in the text.
 */
export function topEventsBody(fromDay: string, toDay: string) {
  if (![fromDay, toDay].every((day) => /^\d{4}-\d{2}-\d{2}$/.test(day))) {
    throw new Error("top events query needs YYYY-MM-DD days");
  }
  return {
    query: {
      kind: "HogQLQuery",
      query: [
        "SELECT toDate(timestamp) AS day, event, count() AS events",
        "FROM events",
        `WHERE timestamp >= toDateTime('${fromDay} 00:00:00')`,
        `AND timestamp < toDateTime('${toDay} 00:00:00') + INTERVAL 1 DAY`,
        "GROUP BY day, event",
        "ORDER BY day ASC, events DESC, event ASC",
        `LIMIT ${TOP_EVENTS} BY day`,
        `LIMIT ${TOP_EVENTS_ROW_LIMIT}`,
      ].join(" "),
      modifiers: UTC_MODIFIERS,
    },
    refresh: "blocking",
    name: "netrics top events",
  };
}

/** The checked HogQL answer: rows of [day, event, count]. */
export const hogqlResultSchema = z
  .object({
    results: z.array(z.tuple([z.string(), z.string(), z.number()])),
    columns: z.array(z.string()).optional(),
    hasMore: z.boolean().nullable().optional(),
  })
  .passthrough();

/** The answer of a query, refused while it is still running. */
export function completedQuery(json: unknown): Record<string, unknown> {
  const answer =
    json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  const status = answer.query_status as { complete?: unknown } | undefined;
  if (status && status.complete === false) {
    throw new PostHogApiError(
      200,
      "invalid",
      "the query is still running (no results yet)",
    );
  }
  return answer;
}

/** The cheapest query: one constant, to check `query:read`. */
export const PROBE_BODY = {
  query: { kind: "HogQLQuery", query: "SELECT 1" },
  refresh: "blocking",
  name: "netrics connection check",
};
