// The PostHog sync, as a resumable run (#873).
//
// A run is a sequence of steps, each at most one request to PostHog:
//
//   1. list: one page of the key's organizations, then one page of an
//      organization's projects (the selected ones are kept);
//   2. per project and window of up to a month: the daily trends (one
//      TrendsQuery), then the top events (one HogQL query);
//   3. per configured insight: the insight with its last results.
//
// A sync page runs at most MAX_REQUESTS_PER_PAGE steps within
// PAGE_TIME_BUDGET_MS and checkpoints the position after the last
// successful one in its cursor. A step that fails after others succeeded
// on the same page ends the page there, so the next page repeats that one
// step only; a step that fails first on its page fails the page. The
// cursor is bound to the connection, the host, the project selection, the
// configured insights and a fingerprint of the key: a cursor of another
// scope restarts the run. Snapshots are completed only by the last page of
// a run, and only when every part of them was read.

import { createHash } from "node:crypto";

import {
  DATASET_LIMITS,
  RateLimitedError,
  type ConnectionContext,
  type ConnectorLogger,
  type DatasetPage,
  type DatasetRecord,
  type FreshnessEntry,
  type Observation,
  type SyncRequest,
  type SyncResult,
} from "@netrics/connector-sdk";

import { boundFreshness } from "../freshness.js";

import { PostHogApiError, type PostHogClient } from "./api.js";
import {
  insightResultsDataset,
  insightsDataset,
  topEventsDataset,
  utc,
  type InsightStatus,
} from "./datasets.js";
import {
  MAX_WINDOW_DAYS,
  TOP_EVENTS,
  TOP_EVENTS_ROW_LIMIT,
  TREND_SERIES,
  completedQuery,
  hogqlResultSchema,
  insightsSchema,
  topEventsBody,
  trendsBody,
  trendsResultSchema,
  type Insight,
  type TrendKey,
  type TrendsSeries,
} from "./queries.js";
import {
  apiKeyOf,
  insightsOf,
  isRefused,
  organizationsPage,
  canonicalProjectId,
  projectIdsOf,
  projectsPage,
  resourceIdOf,
} from "./reading.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Days re-read on every incremental sync: PostHog ingests events late
 * (offline clients, batch imports), and today's numbers keep growing.
 */
export const INCREMENTAL_LOOKBACK_DAYS = 2;
/**
 * Requests per sync page. A PostHog query runs for up to ten seconds; five
 * steps and the time budget keep a page well inside the host's minute.
 */
export const MAX_REQUESTS_PER_PAGE = 5;
/** No step starts after this much of a page has passed. */
export const PAGE_TIME_BUDGET_MS = 20_000;
/**
 * Every request and wait of a page is over by this much after it started
 * (#888, #901 item 1): a step begun just inside PAGE_TIME_BUDGET_MS whose
 * request stalls still ends in time for the page to return its checkpoint
 * before the host's 60-second deadline for the call.
 */
export const PAGE_DEADLINE_MS = 45_000;
/**
 * The longest rate-limit hold a checkpoint keeps: the host defers a
 * rate-limited connection by at most a day (`rateLimitedRunAt` in
 * apps/server/src/sync/engine.ts, which the connectors package may not
 * import; apps/server's posthog-sync.test.ts pins the two together). A
 * longer hold would refuse every retry the host makes before it (#888
 * review).
 */
export const MAX_RATE_LIMIT_HOLD_MS = 24 * 60 * 60 * 1000;
/** Rows and bytes per dataset page, well inside ADR 0026's limits. */
const PAGE_ROWS = 500;
const PAGE_BYTES = DATASET_LIMITS.pageBytes / 2;
/**
 * Rows of one insight at most (ten pages). A larger one is reported as
 * "too_large" in the `insights` dataset instead of being cut.
 */
export const MAX_INSIGHT_ROWS = 5_000;
/** Dataset pages of one insight at most (rows are cut by bytes, too). */
export const MAX_INSIGHT_PAGES = 10;
/**
 * Dataset pages a result may already hold before another step starts: an
 * insight adds up to ten, a window of top events one, and the result keeps
 * room for the pages that complete the refreshes.
 */
const MAX_PENDING_PAGES = DATASET_LIMITS.datasets - 14;

/** Freshness streams (ADR 0025). */
export const ANALYTICS_STREAM = "analytics";
export const INSIGHTS_STREAM = "insights";

export const METRICS = {
  events: "posthog.events",
  pageviews: "posthog.pageviews",
  dau: "posthog.dau",
  wau: "posthog.wau",
  mau: "posthog.mau",
} as const satisfies Record<TrendKey, string>;

/** Intervals of an insight whose buckets are calendar days. */
const DATE_INTERVALS = new Set(["day", "week", "month"]);

// ─── Time ───────────────────────────────────────────────────────────────────

function startOfUtcDay(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// ─── Run state (the cursor) ─────────────────────────────────────────────────

/** Where the current project is. Dropped whenever the run moves on. */
interface ProjectProgress {
  /** First day of the window read next (ms, UTC midnight). */
  from: number;
  /** The window's next request. */
  part: "trends" | "top";
}

/**
 * One configured insight's outcome: project, short ID, name, status,
 * interval, rows, computed at, checked at.
 */
type InsightOutcome = [
  string,
  string,
  string | null,
  InsightStatus,
  string | null,
  number,
  string | null,
  string,
];

type Listing =
  | { stage: "orgs"; offset: number }
  | { stage: "projects"; org: number; offset: number };

interface RunState {
  v: 1;
  /** What the run reads: the connection and a hash of its scope. */
  connection: string;
  scope: string;
  /** When the run started: the clock of all its pages ("today"). */
  at: number;
  refresh: string;
  /** First and last day of the run (ms, UTC midnight, inclusive). */
  startMs: number;
  lastDay: number;
  toMs: number;
  /** The listing position; absent once every organization is listed. */
  listing?: Listing;
  orgs: string[];
  /**
   * An organization's projects were refused: a project the run did not
   * list may be one of them, unread rather than left out (#888 item 1).
   */
  orgsSkipped?: boolean;
  /** [project id, name] of the selected projects, in reading order. */
  projects: Array<[string, string]>;
  index: number;
  project?: ProjectProgress;
  /** Projects read completely, and projects PostHog refused. */
  done: string[];
  denied: string[];
  /** The configured insights [project, short ID] and the one read next. */
  insights: Array<[string, string]>;
  insight: number;
  outcomes: InsightOutcome[];
  /** An insight was refused or not computed: its results are missing. */
  insightsPartial?: boolean;
  /** Dataset refresh chains: last page key per dataset, page counter. */
  last: Record<string, string | null>;
  pages: number;
  /**
   * Every step is done and the last rows went out on a page that is not
   * final: the next page completes the refreshes.
   */
  finishing?: boolean;
  /**
   * A step met a rate limit whose reset is past the page's deadline: the
   * page went out with what it read, and the next one hands the limit to
   * the host before it sends anything (ms since the epoch, #901 item 1).
   */
  limitedUntil?: number;
}

const CURSOR_PREFIX = "posthog.v1:";

/**
 * A checkpoint belongs to the host, the project selection, the configured
 * insights and the key it was read with: a changed key, host or selection
 * starts a new run (#873, the lessons of #881). Only a hash is kept,
 * never the key.
 */
function scopeOf(
  context: ConnectionContext,
  host: string,
  request: SyncRequest,
): string {
  const fingerprint = createHash("sha256")
    .update(`posthog-cursor|${context.connectionId}|${apiKeyOf(context) ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  const selection = request.resources
    ? [...new Set(request.resources)].sort().join(",")
    : "*";
  const insights = insightsOf(context)
    .insights.map((insight) => `${insight.project}/${insight.shortId}`)
    .join(",");
  const projects = projectIdsOf(context).ids?.join(",") ?? "*";
  return createHash("sha256")
    .update(JSON.stringify([host, selection, projects, insights, fingerprint]))
    .digest("hex")
    .slice(0, 32);
}

function encodeState(state: RunState): string {
  return (
    CURSOR_PREFIX + Buffer.from(JSON.stringify(state)).toString("base64url")
  );
}

/** A checkpoint of this connection and scope; anything else is null. */
function decodeState(
  cursor: string | undefined,
  connection: string,
  scope: string,
): RunState | null {
  if (!cursor?.startsWith(CURSOR_PREFIX)) return null;
  try {
    const state = JSON.parse(
      Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString(
        "utf8",
      ),
    ) as RunState;
    return state.v === 1 &&
      state.connection === connection &&
      state.scope === scope
      ? state
      : null;
  } catch {
    return null;
  }
}

// ─── Pages ──────────────────────────────────────────────────────────────────

/** Records split into pages within the row and byte bounds. */
export function chunks(records: DatasetRecord[]): DatasetRecord[][] {
  const result: DatasetRecord[][] = [];
  let current: DatasetRecord[] = [];
  let bytes = 0;
  for (const record of records) {
    const size = Buffer.byteLength(JSON.stringify(record));
    if (
      current.length > 0 &&
      (current.length >= PAGE_ROWS || bytes + size > PAGE_BYTES)
    ) {
      result.push(current);
      current = [];
      bytes = 0;
    }
    current.push(record);
    bytes += size;
  }
  if (current.length > 0) result.push(current);
  return result;
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

// ─── Answers ────────────────────────────────────────────────────────────────

/**
 * The daily trends of a window: per series key, value per day. Series are
 * matched by their `action.order` (PostHog keeps the request's order).
 * Days outside the window are ignored; a series without its days, or with
 * days and values that do not line up, is an invalid answer.
 */
export function trendValues(
  json: unknown,
  fromDay: string,
  toDay: string,
): Map<TrendKey, Map<string, number>> {
  const answer = completedQuery(json);
  const series = trendsResultSchema.parse(answer.results);
  if (series.length !== TREND_SERIES.length) {
    throw new PostHogApiError(
      200,
      "invalid",
      `the trends query answered ${series.length} series, not ${TREND_SERIES.length}`,
    );
  }
  const values = new Map<TrendKey, Map<string, number>>();
  series.forEach((entry, index) => {
    const order = entry.action?.order ?? index;
    const definition = TREND_SERIES[order];
    const { days, data } = entry;
    if (
      !definition ||
      values.has(definition.key) ||
      !days ||
      !data ||
      days.length !== data.length
    ) {
      throw new PostHogApiError(
        200,
        "invalid",
        "a trends series has no days or values that line up",
      );
    }
    const byDay = new Map<string, number>();
    days.forEach((day, position) => {
      const value = data[position];
      if (!DAY_PATTERN.test(day)) {
        throw new PostHogApiError(200, "invalid", "a trends day is not a date");
      }
      if (day < fromDay || day > toDay || value === null || value === undefined)
        return;
      byDay.set(day, value);
    });
    values.set(definition.key, byDay);
  });
  return values;
}

/** The top events of a window: [day, event, count] in rank order per day. */
export function topEventRows(json: unknown): Array<[string, string, number]> {
  const answer = hogqlResultSchema.parse(completedQuery(json));
  if (
    answer.hasMore === true ||
    answer.results.length >= TOP_EVENTS_ROW_LIMIT
  ) {
    throw new PostHogApiError(
      200,
      "invalid",
      "the top events answer may be cut off",
    );
  }
  const perDay = new Map<string, number>();
  for (const [day] of answer.results) {
    if (!DAY_PATTERN.test(day)) {
      throw new PostHogApiError(
        200,
        "invalid",
        "a top events day is not a date",
      );
    }
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
    if (perDay.get(day)! > TOP_EVENTS) {
      throw new PostHogApiError(
        200,
        "invalid",
        "the top events answer has more events per day than asked for",
      );
    }
  }
  return answer.results;
}

function breakdown(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((part) => String(part)).join(", ");
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * Rows of a saved trends insight's result, or the status that keeps it
 * out: not a trends insight, an interval netrics does not read, a result
 * of an unknown shape, or one not computed yet.
 */
export function insightRows(
  insight: Insight,
  name: string,
  projectId: string,
  readAt: string,
):
  | { status: "ok"; interval: string; rows: DatasetRecord[] }
  | { status: InsightStatus; interval: string | null; rows: [] } {
  const source = insight.query?.source;
  const interval = source?.interval ?? "day";
  if (
    insight.query?.kind !== "InsightVizNode" ||
    source?.kind !== "TrendsQuery"
  ) {
    return { status: "unsupported", interval: null, rows: [] };
  }
  if (!DATE_INTERVALS.has(interval)) {
    return { status: "unsupported", interval, rows: [] };
  }
  if (
    insight.query_status?.complete === false ||
    insight.result === null ||
    insight.result === undefined
  ) {
    return { status: "not_ready", interval, rows: [] };
  }
  const parsed = trendsResultSchema.safeParse(insight.result);
  if (!parsed.success) return { status: "unsupported", interval, rows: [] };
  const computedAt = utc(insight.last_refresh);
  const rows: DatasetRecord[] = [];
  const row = (
    series: TrendsSeries,
    index: number,
    bucket: string,
    value: number | null,
  ): DatasetRecord => ({
    values: {
      project_id: projectId,
      insight_id: insight.short_id,
      insight_name: name,
      series_index: index,
      series_label: series.label ?? null,
      breakdown_value: breakdown(series.breakdown_value),
      compare_label: series.compare_label ?? null,
      interval,
      bucket,
      day:
        DAY_PATTERN.test(bucket.slice(0, 10)) && bucket !== "total"
          ? bucket.slice(0, 10)
          : null,
      value,
      computed_at: computedAt,
      as_of: readAt,
    },
  });
  for (const [index, series] of parsed.data.entries()) {
    const { days, data } = series;
    if (days && data && days.length > 0) {
      if (days.length !== data.length) {
        return { status: "unsupported", interval, rows: [] };
      }
      days.forEach((day, position) => {
        rows.push(row(series, index, day, data[position] ?? null));
      });
    } else if (
      series.aggregated_value !== undefined &&
      series.aggregated_value !== null
    ) {
      rows.push(row(series, index, "total", series.aggregated_value));
    }
    if (rows.length > MAX_INSIGHT_ROWS) {
      return { status: "too_large", interval, rows: [] };
    }
  }
  // Long labels or breakdown values fill pages by bytes before rows
  // (#884 review): an insight that needs more pages than one result
  // holds is left out whole, never cut.
  if (chunks(rows).length > MAX_INSIGHT_PAGES) {
    return { status: "too_large", interval, rows: [] };
  }
  // A record above ADR 0026's per-record limit (64 KiB of JSON, as the host
  // measures it) would fail the whole page: the insight is left out
  // instead (#884 review 2).
  if (
    rows.some(
      (record) =>
        Buffer.byteLength(JSON.stringify(record)) > DATASET_LIMITS.rowBytes,
    )
  ) {
    return { status: "too_large", interval, rows: [] };
  }
  return { status: "ok", interval, rows };
}

// ─── The run ────────────────────────────────────────────────────────────────

export interface PostHogSyncOptions {
  now: () => number;
  log?: ConnectorLogger;
}

/** Errors no later page gets past: the key or its scopes. */
function isFatal(error: unknown): boolean {
  return (
    error instanceof PostHogApiError &&
    (error.kind === "auth" ||
      error.kind === "scope" ||
      error.kind === "project_scoped")
  );
}

/** The rate limit a checkpoint holds, handed to the host. Fixed text. */
function rateLimited(until: number): RateLimitedError {
  return new RateLimitedError(
    "PostHog's API rate limit or query budget is used up (429). netrics continues after the reset.",
    new Date(until),
  );
}

export async function syncPage(
  client: PostHogClient,
  context: ConnectionContext,
  request: SyncRequest,
  options: PostHogSyncOptions,
): Promise<SyncResult> {
  const { now, log } = options;
  const pageStarted = now();
  const scope = scopeOf(context, client.host, request);

  let state = decodeState(request.cursor, context.connectionId, scope);
  const projectIds = projectIdsOf(context).ids;
  // Projects are compared by their canonical ID (01000 = 1000) and
  // reported under the spelling the connection stores (#888 review).
  const selected = request.resources
    ? new Set(request.resources.map(canonicalProjectId))
    : null;
  const spellings = [...(request.resources ?? []), ...(projectIds ?? [])];
  /** The resource ID of a project, by its canonical ID. */
  const resourceOf = (canonical: string) => resourceIdOf(canonical, spellings);
  if (!state) {
    const at = now();
    const startMs = startOfUtcDay(Date.parse(request.from));
    const toMs = Date.parse(request.to);
    // "Today" is the day the run started, on every page: a run that
    // crosses midnight UTC reads the days as of its start (#881).
    const lastDay = Math.min(startOfUtcDay(toMs - 1), startOfUtcDay(at));
    state = {
      v: 1,
      connection: context.connectionId,
      scope,
      at,
      refresh: createHash("sha256")
        .update(`${context.connectionId}|${scope}|${startMs}|${toMs}|${at}`)
        .digest("hex")
        .slice(0, 32),
      startMs,
      lastDay,
      toMs,
      // A key limited to projects reads the configured IDs, through
      // project endpoints only: no organization listing.
      ...(projectIds === undefined
        ? { listing: { stage: "orgs" as const, offset: 0 } }
        : {}),
      orgs: [],
      projects: (projectIds ?? [])
        .map(canonicalProjectId)
        .filter((id) => !selected || selected.has(id))
        .map((id): [string, string] => [resourceOf(id), resourceOf(id)]),
      index: 0,
      done: [],
      denied: [],
      insights: insightsOf(context).insights.map((insight) => [
        insight.project,
        insight.shortId,
      ]),
      insight: 0,
      outcomes: [],
      last: {},
      pages: 0,
    };
  }
  const run = state;
  // A pending rate limit holds the checkpoint until its reset.
  if (run.limitedUntil !== undefined) {
    if (pageStarted < run.limitedUntil) throw rateLimited(run.limitedUntil);
    delete run.limitedUntil;
  }
  const today = startOfUtcDay(run.at);
  /** The run's project of a canonical ID: its resource ID, or undefined. */
  const runProject = (canonical: string) =>
    run.projects.find(([id]) => canonicalProjectId(id) === canonical)?.[0];

  const out = {
    observations: [] as Observation[],
    topEvents: [] as DatasetRecord[],
    insightRows: [] as DatasetRecord[],
  };

  // ── Steps ──

  async function listStep(listing: Listing) {
    if (listing.stage === "orgs") {
      const page = await organizationsPage(client, listing.offset);
      run.orgs.push(...page.organizations.map((org) => org.id));
      if (page.next !== null) listing.offset = page.next;
      else if (run.orgs.length > 0) {
        run.listing = { stage: "projects", org: 0, offset: 0 };
      } else delete run.listing;
      return;
    }
    const advance = () => {
      if (listing.org + 1 < run.orgs.length) {
        run.listing = { stage: "projects", org: listing.org + 1, offset: 0 };
      } else delete run.listing;
    };
    let page;
    try {
      page = await projectsPage(client, run.orgs[listing.org]!, listing.offset);
    } catch (error) {
      // An organization the key may no longer read (403, 404) since it was
      // listed: the run goes on with the next one instead of repeating
      // this step forever (#884 review 2). Its projects get no freshness.
      if (!isRefused(error)) throw error;
      run.orgsSkipped = true;
      log?.warn("organization refused, skipped", {
        organization: run.orgs[listing.org]!,
        status: (error as PostHogApiError).status,
      });
      advance();
      return;
    }
    for (const project of page.projects) {
      if (selected && !selected.has(project.id)) continue;
      if (runProject(project.id) !== undefined) continue;
      run.projects.push([resourceOf(project.id), project.name]);
    }
    if (page.next !== null) listing.offset = page.next;
    else advance();
  }

  /** Moves to the next project; nothing of this one carries over. */
  function nextProject() {
    run.index += 1;
    delete run.project;
  }

  async function projectStep() {
    const [projectId, projectName] = run.projects[run.index]!;
    /** The project in PostHog's paths: its canonical ID. */
    const path = canonicalProjectId(projectId);
    if (run.startMs > run.lastDay) {
      // A window of nothing but future days: nothing to read.
      run.done.push(projectId);
      nextProject();
      return;
    }
    run.project ??= { from: run.startMs, part: "trends" };
    const progress = run.project;
    const windowEnd = Math.min(
      progress.from + (MAX_WINDOW_DAYS - 1) * DAY_MS,
      run.lastDay,
    );
    const fromDay = isoDay(progress.from);
    const toDay = isoDay(windowEnd);
    try {
      if (progress.part === "trends") {
        const values = trendValues(
          await client.query(path, trendsBody(fromDay, toDay)),
          fromDay,
          toDay,
        );
        for (const { key } of TREND_SERIES) {
          for (const [day, value] of [...values.get(key)!].sort()) {
            out.observations.push({
              metricKey: METRICS[key],
              sourceTimestamp: `${day}T00:00:00.000Z`,
              value,
              dimensions: { resource: projectId },
            });
          }
        }
        progress.part = "top";
        return;
      }
      const rows = topEventRows(
        await client.query(path, topEventsBody(fromDay, toDay)),
      );
      const ranks = new Map<string, number>();
      for (const [day, event, events] of rows) {
        if (day < fromDay || day > toDay) continue;
        const rank = (ranks.get(day) ?? 0) + 1;
        ranks.set(day, rank);
        out.topEvents.push({
          values: {
            project_id: projectId,
            project_name: projectName,
            day,
            rank,
            event,
            events: Math.round(events),
          },
        });
      }
      // The window was read whole: a rank a day no longer has is deleted,
      // so a day read again never keeps an event that fell out of its top
      // (#884 review, ADR 0026 §3 tombstones).
      for (let day = progress.from; day <= windowEnd; day += DAY_MS) {
        const key = isoDay(day);
        for (
          let rank = (ranks.get(key) ?? 0) + 1;
          rank <= TOP_EVENTS;
          rank += 1
        ) {
          out.topEvents.push({
            values: { project_id: projectId, day: key, rank },
            deleted: true,
          });
        }
      }
      if (windowEnd >= run.lastDay) {
        run.done.push(projectId);
        nextProject();
      } else {
        run.project = { from: windowEnd + DAY_MS, part: "trends" };
      }
    } catch (error) {
      // A project deleted or unshared since the listing, or one whose
      // PostHog refuses netrics' query (400, say an older self-hosted
      // version): skipped without freshness, so it shows as stale instead
      // of stopping every other project. What earlier windows read stays.
      if (
        !isRefused(error) &&
        !(error instanceof PostHogApiError && error.kind === "query")
      ) {
        throw error;
      }
      log?.warn("project refused, skipped", {
        project: projectId,
        status: (error as PostHogApiError).status,
      });
      run.denied.push(projectId);
      nextProject();
    }
  }

  function outcome(
    project: string,
    shortId: string,
    name: string | null,
    status: InsightStatus,
    interval: string | null,
    rows: number,
    computedAt: string | null,
  ) {
    run.outcomes.push([
      project,
      shortId,
      name,
      status,
      interval,
      rows,
      computedAt,
      iso(now()),
    ]);
    if (status === "denied" || status === "not_ready") {
      run.insightsPartial = true;
    }
    run.insight += 1;
  }

  async function insightStep() {
    const [canonical, shortId] = run.insights[run.insight]!;
    const read = runProject(canonical);
    const projectId = read ?? resourceOf(canonical);
    if (read === undefined) {
      // Left out by the selection, or not among the projects the key
      // lists: "not_selected". A project of an organization whose projects
      // were refused may be either: its insight is unread, and the stored
      // results stay (#888 item 1, ADR 0026 §7).
      const excluded = selected !== null && !selected.has(canonical);
      outcome(
        projectId,
        shortId,
        null,
        !excluded && run.orgsSkipped ? "denied" : "not_selected",
        null,
        0,
        null,
      );
      return;
    }
    let answer;
    try {
      answer = insightsSchema.parse(
        await client.get(`/api/projects/${canonical}/insights/`, {
          short_id: shortId,
          refresh: "blocking",
          limit: 1,
        }),
      );
    } catch (error) {
      if (!isRefused(error)) throw error;
      outcome(
        projectId,
        shortId,
        null,
        (error as PostHogApiError).kind === "not_found"
          ? "not_found"
          : "denied",
        null,
        0,
        null,
      );
      return;
    }
    const insight = answer.results.find(
      (entry) => entry.short_id === shortId && entry.deleted !== true,
    );
    if (!insight) {
      outcome(projectId, shortId, null, "not_found", null, 0, null);
      return;
    }
    const name = insight.name || insight.derived_name || shortId;
    // Read now: a live value is dated when it was fetched.
    const result = insightRows(insight, name, projectId, iso(now()));
    out.insightRows.push(...result.rows);
    if (result.status !== "ok") {
      log?.info("insight not read", {
        insight: shortId,
        status: result.status,
      });
    }
    outcome(
      projectId,
      shortId,
      name,
      result.status,
      result.interval,
      result.rows.length,
      utc(insight.last_refresh),
    );
  }

  /** The next step, or null when the run has nothing left to read. */
  function nextStep(): (() => Promise<void>) | null {
    if (run.listing) {
      const listing = run.listing;
      return () => listStep(listing);
    }
    if (run.index < run.projects.length) return projectStep;
    if (run.insight < run.insights.length) return insightStep;
    return null;
  }

  const pendingPages = () =>
    chunks(out.topEvents).length + chunks(out.insightRows).length;

  // ── The page ──

  let steps = 0;
  let step = nextStep();
  while (
    step &&
    steps < MAX_REQUESTS_PER_PAGE &&
    (steps === 0 || now() - pageStarted < PAGE_TIME_BUDGET_MS) &&
    pendingPages() <= MAX_PENDING_PAGES
  ) {
    try {
      await step();
    } catch (error) {
      // The first step's failure fails the page (the host retries it, or
      // waits for a rate limit's reset). A later one ends the page with
      // what it read: the next page starts with the failed step.
      if (steps === 0 || isFatal(error)) throw error;
      // A rate limit is the host's to wait for: the checkpoint carries it.
      if (error instanceof RateLimitedError) {
        const retryAt = Date.parse(error.retryAt);
        if (Number.isFinite(retryAt)) {
          run.limitedUntil = Math.min(retryAt, now() + MAX_RATE_LIMIT_HOLD_MS);
        }
      }
      log?.warn("step failed, the next page repeats it", {
        error: error instanceof Error ? error.name : "unknown",
      });
      break;
    }
    steps += 1;
    step = nextStep();
  }

  const datasetPages: DatasetPage[] = [];
  const flush = (key: string, records: DatasetRecord[]) => {
    for (const chunk of chunks(records)) {
      datasetPages.push(datasetPage(run, key, chunk, false));
    }
  };
  flush(topEventsDataset.key, out.topEvents);
  flush(insightResultsDataset.key, out.insightRows);

  // Every step done, rows still to send: they go out on this page, which is
  // not final, and the next page completes the refreshes. The host refuses
  // a final result with an incomplete page (ADR 0026 §7).
  if (!step && !run.finishing) {
    const statuses = chunks(
      run.outcomes.map(
        ([
          project,
          shortId,
          name,
          status,
          interval,
          rows,
          computedAt,
          checkedAt,
        ]) => ({
          values: {
            project_id: project,
            insight_id: shortId,
            insight_name: name,
            status,
            interval,
            rows,
            computed_at: computedAt,
            checked_at: checkedAt,
          },
        }),
      ),
    );
    if (datasetPages.length + statuses.length <= DATASET_LIMITS.datasets - 3) {
      for (const chunk of statuses) {
        datasetPages.push(datasetPage(run, insightsDataset.key, chunk, false));
      }
      run.finishing = true;
    }
  }

  if (step || !run.finishing || datasetPages.length > 0) {
    return {
      observations: out.observations,
      datasetPages,
      nextCursor: encodeState(run),
      done: false,
    };
  }

  // The final page: nothing but the empty pages that complete the
  // refreshes. Insight results are complete only when every insight was
  // read or definitively left out (ADR 0026 §7): otherwise the stored
  // snapshot stays.
  const received = [topEventsDataset.key, insightsDataset.key];
  datasetPages.push(datasetPage(run, topEventsDataset.key, [], true));
  datasetPages.push(datasetPage(run, insightsDataset.key, [], true));
  if (!run.insightsPartial) {
    datasetPages.push(datasetPage(run, insightResultsDataset.key, [], true));
    received.push(insightResultsDataset.key);
  }

  // Today keeps growing: the last complete day is the one before. A run
  // that did not read that day claims nothing.
  const through = run.lastDay === today ? today - DAY_MS : run.lastDay;
  const freshness: FreshnessEntry[] = [];
  if (through >= run.startMs) {
    for (const projectId of run.done) {
      freshness.push({
        stream: ANALYTICS_STREAM,
        resource: projectId,
        dataThrough: isoDay(through),
        expectedFrom: iso(through + 2 * DAY_MS),
        nextExpectedAt: iso(through + 2 * DAY_MS + 60 * 60 * 1000),
      });
    }
  }
  if (!run.insightsPartial) freshness.push({ stream: INSIGHTS_STREAM });
  const bounded = boundFreshness(
    freshness,
    run.projects.map(([id]) => id),
  );

  const resumeAt = iso(
    Math.max(
      startOfUtcDay(run.toMs) - INCREMENTAL_LOOKBACK_DAYS * DAY_MS,
      run.startMs,
    ),
  );
  return {
    observations: out.observations,
    datasetPages,
    receivedDatasets: received,
    ...(bounded.length > 0 ? { freshness: bounded } : {}),
    nextCursor: resumeAt,
    nextFrom: resumeAt,
    done: true,
  };
}
