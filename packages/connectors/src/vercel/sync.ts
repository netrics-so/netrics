// The Vercel sync, as a resumable run (#871).
//
// A run is a sequence of steps, each one request to Vercel:
//
//   1. list: one page of the projects (the selected ones are kept);
//   2. per project:
//      a. latest: its newest production build;
//      b. live: the project's production target, the deployment serving
//         production (with a: the `production_deployments` snapshot row);
//      c. deploys: one page of its deployments created in the window (the
//         `deployments` dataset and the daily counts);
//      d. analytics, only with Web Analytics enabled: per calendar month
//         the visits, top routes, top countries and top events;
//   3. billing: per team and day of this month, its charges (summed into
//      the `billing_charges` snapshot).
//
// A sync page runs steps while its request budget (MAX_REQUESTS_PER_PAGE)
// and time budget last, and checkpoints the position after the last
// successful one in its cursor. A step changes the run only after its
// answer was read: a step that fails after others succeeded on the same
// page ends the page there, with what it read, so the next page repeats
// only that step; a failing first step fails the page (a rate limit stays a
// RateLimitedError, so the host waits for its reset). The cursor is bound
// to the connection, the configured team, the project selection and a
// fingerprint of the token: a cursor of another scope restarts the run.
// Every dataset is published once per run: its last page, on the final
// result, is empty and completes it (ADR 0026 §7).
//
// The final result's cursor carries the deployments the run read in the
// days the next run reads again: a deployment the next run no longer
// finds there was deleted at Vercel, and gets a tombstone.

import { createHash } from "node:crypto";

import {
  DATASET_LIMITS,
  FRESHNESS_LIMITS,
  type ConnectionContext,
  type ConnectorLogger,
  type DatasetPage,
  type DatasetRecord,
  type FreshnessEntry,
  type Observation,
  type SyncRequest,
  type SyncResult,
} from "@netrics/connector-sdk";
import { z } from "zod";

import { boundFreshness } from "../freshness.js";
import { readPageCursor } from "../page-cursor.js";

import {
  VercelApiError,
  VercelInvalidResponseError,
  parseAnswer,
  type Query,
  type VercelGet,
} from "./api.js";
import {
  billingChargesDataset,
  chargeProject,
  chargeSchema,
  decimal,
  deploymentRecord,
  deploymentsDataset,
  deploymentsPageSchema,
  isFailed,
  latestOf,
  productionDeploymentsDataset,
  productionRecord,
  projectTargetsSchema,
  targetDeployment,
  stateOf,
  targetOf,
  type LatestDeployment,
} from "./datasets.js";
import { ownerQuery, projectsPage, teamIdOf, tokenOf } from "./reading.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Days re-read on every incremental sync: Vercel keeps counting today's
 * visitors, and a deployment changes state after it is created (queued →
 * building → ready or error).
 */
export const INCREMENTAL_LOOKBACK_DAYS = 2;
/** How far back deployments are read, whatever the window asks for. */
export const DEPLOYMENTS_BACKFILL_DAYS = 90;
/**
 * Requests per sync page. Vercel answers within a second or two; twenty
 * keep a page well inside the host's call budget, and a failure loses at
 * most the one step that failed.
 */
export const MAX_REQUESTS_PER_PAGE = 20;
/** No step starts after this much of a page has passed. */
export const PAGE_TIME_BUDGET_MS = 20_000;
/** Deployments per listing request (Vercel's maximum is 100). */
export const DEPLOYMENTS_PER_REQUEST = 100;
/** Top routes, countries and events kept per calendar month; the rest is "Others". */
export const TOP_LIMIT = 10;
/** Charge rows a run keeps at most; a larger export leaves the snapshot as stored. */
export const MAX_BILLING_ROWS = 5_000;
/**
 * Deployments per project the final cursor remembers for the next run's
 * tombstones. A project with more in the re-read days gets none.
 */
export const MAX_REMEMBERED_DEPLOYMENTS = 2_000;
/** Newest READY production deployments read to find the newest promoted one. */
export const READY_DEPLOYMENTS_PER_REQUEST = 20;
/** Rows and bytes per dataset page, well inside ADR 0026's limits. */
const PAGE_ROWS = 500;
const PAGE_BYTES = DATASET_LIMITS.pageBytes / 2;
/**
 * The most dataset pages one step can add to a result: a deployments page
 * (up to 100 rows) with its project's tombstones (up to
 * MAX_REMEMBERED_DEPLOYMENTS), one more where they continue a page begun
 * before, and a production row. A step starts only while that much room is
 * left (review round 2 of #889).
 */
const PAGES_PER_STEP =
  Math.ceil(
    (DEPLOYMENTS_PER_REQUEST + MAX_REMEMBERED_DEPLOYMENTS) / PAGE_ROWS,
  ) + 2;

/** Freshness streams (ADR 0025). */
export const ANALYTICS_STREAM = "web_analytics";
export const DEPLOYS_STREAM = "deploys";
export const BILLING_STREAM = "billing";

export const METRICS = {
  pageviews: "vercel.pageviews",
  visitors: "vercel.visitors",
  routePageviews: "vercel.route_pageviews",
  countryVisitors: "vercel.country_visitors",
  events: "vercel.events",
  deployments: "vercel.deployments",
  failedDeployments: "vercel.failed_deployments",
  cost: "vercel.cost",
} as const;

/** Minor units per unit of a currency (Vercel bills in USD: cents). */
function minorUnits(currency: string): number {
  return ["JPY", "KRW", "VND", "CLP", "ISK"].includes(currency) ? 1 : 100;
}

/**
 * The host refused an answer for its size (the runtime's response limit):
 * its EgressDeniedError, which connectors cannot import, named and worded
 * so. Only the name and that wording are relied on.
 */
function isResponseTooLarge(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "EgressDeniedError" &&
    /response exceeds/.test(error.message)
  );
}

/** Targets every day has a count for, zero included. */
const COUNTED_TARGETS = ["production", "preview"];

/**
 * Billing answers that mean "this token or plan may not read charges":
 * the charges are left out. Anything else (a rate limit, an outage, a
 * network failure) is retried like every other step (review of #889).
 */
const BILLING_REFUSALS = new Set([400, 402, 403, 404]);

// ─── Time ───────────────────────────────────────────────────────────────────

function startOfUtcDay(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function startOfUtcMonth(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function startOfNextUtcMonth(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** "the pro plan only grants access to the latest 366 days of data" */
function planWindowDays(error: VercelApiError): number | null {
  if (error.status !== 400 || !error.providerMessage) return null;
  const match = /latest (\d+) (day|month)s?/i.exec(error.providerMessage);
  if (!match) return null;
  const count = Number(match[1]);
  return match[2]!.toLowerCase() === "month" ? count * 28 : count;
}

// ─── Run state (the cursor) ─────────────────────────────────────────────────

// Keys Vercel supplies (project, account and team IDs, environment slugs)
// are never object keys here: a slug like `constructor` or `__proto__`
// would read or replace Object's prototype (review round 2 of #889). They
// live in Maps while a page runs and as [key, value] lists in the cursor.

/** Deployment counts of one day: [target, all, failed]. */
type DayCounts = Array<[string, number, number]>;

/** [deployment id, created (ms)]. */
type Seen = [string, number];

/** What a run read in the days the next run reads again, for one project. */
interface Memory {
  /** The deployments; null: too many to remember. */
  seen: Seen[] | null;
  targets: string[];
}

/** Per project: [project id, memory]. */
type Remembered = Array<[string, Memory]>;

/** Where the current project is. Dropped whenever the run moves on. */
interface ProjectProgress {
  stage: "latest" | "ready" | "live" | "deploys" | "analytics";
  /** Production: the newest build, once read (null: none). */
  latest?: LatestDeployment | null;
  /** Production: the newest promoted READY build, once read (null: none). */
  ready?: LatestDeployment | null;
  /**
   * Deployments: the creation instant the last page ended at, and the
   * deployments of that instant already read. The next page asks up to and
   * including it, so one sharing it is not lost (review round 2 of #889).
   */
  boundary?: { ms: number; ids: string[] };
  /** Deployments: days from this one on are counted and sent. */
  below?: number;
  /** Deployments: counts of the days below `below` read so far. */
  open?: Record<string, DayCounts>;
  /**
   * Deployments the previous run read in this run's window that this run
   * has not found yet: tombstones when the project is done.
   */
  missing?: Seen[];
  /** Analytics: the month read (its start), and its next part (0–3). */
  month?: number;
  part?: number;
}

/** [id, name, account id, Web Analytics enabled (1) or not (0)]. */
type ProjectEntry = [string, string, string, 0 | 1];

/** One charge row being summed: its values, and the running sums. */
interface ChargeSum {
  values: Record<string, unknown>;
  billed: number;
  effective: number;
  quantity: number | null;
}

interface RunState {
  v: 1;
  kind: "run";
  /** What the run reads: the connection and a hash of its scope. */
  connection: string;
  scope: string;
  /** When the run started: the clock ("today") of all its pages. */
  at: number;
  refresh: string;
  /** The window: analytics from startMs, deployments from depStartMs. */
  startMs: number;
  depStartMs: number;
  toMs: number;
  /** Where the next run starts reading again (nextFrom). */
  resumeMs: number;
  /** The listing position; absent once every project is listed. */
  listing?: { from: string | null };
  projects: ProjectEntry[];
  index: number;
  project?: ProjectProgress;
  /**
   * [account id, first day its plan keeps analytics for], once learned;
   * moved forward when Vercel reports a later one (its window rolls daily).
   */
  plan: Array<[string, number]>;
  /** Projects Vercel no longer knew during the run. */
  gone: string[];
  /** Projects whose deployments, or analytics, were read completely. */
  deploysDone: string[];
  analyticsDone: string[];
  /** What the previous run remembered, and what this one remembers. */
  prior: Remembered;
  remember: Remembered;
  /** Billing: the teams, the team and day read next, the running sums. */
  teams?: string[];
  billing?: { team: number; day: number };
  charges: Record<string, ChargeSum>;
  /** A team's charges could not be read: the stored snapshot stays. */
  billingPartial?: boolean;
  /** Every team and day was read; the rows are in `queue`. */
  billingDone?: boolean;
  /** Charge rows not yet sent. */
  queue: DatasetRecord[];
  /** Dataset refresh chains: last page key per refresh, page counter. */
  last: Record<string, string | null>;
  pages: number;
  /**
   * Every step is done and the last rows went out on a page that is not
   * final: the next page completes the datasets.
   */
  finishing?: boolean;
}

/** The final result's cursor: what the next run needs from this one. */
interface DoneState {
  v: 1;
  kind: "done";
  connection: string;
  scope: string;
  remember: Remembered;
}

const CURSOR_PREFIX = "vercel.v1:";

/**
 * A checkpoint belongs to the configured team, the project selection and
 * the token it was read with: a changed token, team or selection starts a
 * new run (the lessons of #881). Only a hash is kept, never the token.
 */
function scopeOf(context: ConnectionContext, request: SyncRequest): string {
  const fingerprint = createHash("sha256")
    .update(`vercel-cursor|${context.connectionId}|${tokenOf(context) ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  const selection = request.resources
    ? [...new Set(request.resources)].sort().join(",")
    : "*";
  return createHash("sha256")
    .update(JSON.stringify([teamIdOf(context) ?? "", selection, fingerprint]))
    .digest("hex")
    .slice(0, 32);
}

function encodeState(state: RunState | DoneState): string {
  return (
    CURSOR_PREFIX + Buffer.from(JSON.stringify(state)).toString("base64url")
  );
}

/** A cursor of this connection and scope; anything else is null. */
function decodeState(
  cursor: string | undefined,
  connection: string,
  scope: string,
): RunState | DoneState | null {
  if (!cursor?.startsWith(CURSOR_PREFIX)) return null;
  try {
    const state = JSON.parse(
      Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString(
        "utf8",
      ),
    ) as RunState | DoneState;
    return state.v === 1 &&
      (state.kind === "run" || state.kind === "done") &&
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
export function chunks(records: readonly DatasetRecord[]): DatasetRecord[][] {
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
  const refreshKey = `${state.refresh}:${datasetKey}`;
  state.pages += 1;
  const pageKey = `p${String(state.pages).padStart(6, "0")}`;
  const page: DatasetPage = {
    datasetKey,
    schemaVersion: 1,
    refreshKey,
    pageKey,
    previousPageKey: state.last[refreshKey] ?? null,
    records,
    complete,
  };
  state.last[refreshKey] = pageKey;
  return page;
}

// ─── Answers ────────────────────────────────────────────────────────────────

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

/** The analytics queries of one month, in reading order. */
const ANALYTICS_PARTS = [
  { path: "/v1/query/web-analytics/visits/aggregate", by: ["day"] },
  {
    path: "/v1/query/web-analytics/visits/aggregate",
    by: ["day", "route"],
    top: true,
  },
  {
    path: "/v1/query/web-analytics/visits/aggregate",
    by: ["day", "country"],
    top: true,
  },
  {
    path: "/v1/query/web-analytics/events/aggregate",
    by: ["day", "eventName"],
    top: true,
  },
] as const;

/** The charges of a FOCUS JSONL export. Any invalid line is an invalid answer. */
function parseCharges(text: unknown) {
  if (typeof text !== "string") {
    throw new VercelInvalidResponseError("the billing charges");
  }
  const charges = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      throw new VercelInvalidResponseError("the billing charges");
    }
    charges.push(parseAnswer(chargeSchema, json, "the billing charges"));
  }
  return charges;
}

// ─── The run ────────────────────────────────────────────────────────────────

export interface VercelSyncOptions {
  /** The run's clock ("today"), and the page's time budget. */
  now: () => number;
  log?: ConnectorLogger | undefined;
}

/** What one page collects before it is returned. */
interface PageOutput {
  observations: Observation[];
  deployments: DatasetRecord[];
  production: DatasetRecord[];
}

function isFatal(error: unknown): boolean {
  return (
    error instanceof VercelApiError && (error.isAuth || error.status === 403)
  );
}

function isMissing(error: unknown): boolean {
  return error instanceof VercelApiError && error.status === 404;
}

/** An empty window, or an explicit empty selection: nothing is read. */
export function emptyRun(request: SyncRequest): SyncResult | null {
  const fromMs = Date.parse(request.from);
  const toMs = Date.parse(request.to);
  const startMs = startOfUtcDay(fromMs);
  if (startMs < toMs && request.resources?.length !== 0) return null;
  const resumeAt = iso(
    Math.max(startOfUtcDay(toMs) - INCREMENTAL_LOOKBACK_DAYS * DAY_MS, startMs),
  );
  return {
    observations: [],
    nextCursor: resumeAt,
    nextFrom: resumeAt,
    done: true,
  };
}

export async function syncPage(
  get: VercelGet,
  context: ConnectionContext,
  request: SyncRequest,
  options: VercelSyncOptions,
): Promise<SyncResult> {
  const { now, log } = options;
  const pageStarted = now();
  const scope = scopeOf(context, request);
  let budget = MAX_REQUESTS_PER_PAGE;
  const ask: VercelGet = (path, query: Query = {}, format) => {
    budget -= 1;
    return get(path, query, format);
  };

  const decoded = decodeState(request.cursor, context.connectionId, scope);
  let state = decoded?.kind === "run" ? decoded : null;
  if (!state) {
    // A checkpoint from before #871 (an instant, or "<instant>|<run
    // start>", #765) still says where reading started: the run starts
    // there when that is earlier than the window (#758).
    const legacy = request.cursor?.startsWith(CURSOR_PREFIX)
      ? {}
      : readPageCursor(request.cursor);
    const fromMs = Date.parse(request.from);
    const toMs = Date.parse(request.to);
    const atMs = legacy.at ? Date.parse(legacy.at) : Number.NaN;
    const startMs = startOfUtcDay(
      Math.min(
        fromMs,
        Number.isFinite(atMs) && atMs < toMs ? atMs : fromMs,
        legacy.runStartMs ?? fromMs,
      ),
    );
    const at = now();
    state = {
      v: 1,
      kind: "run",
      connection: context.connectionId,
      scope,
      at,
      refresh: createHash("sha256")
        .update(`${context.connectionId}|${scope}|${startMs}|${toMs}|${at}`)
        .digest("hex")
        .slice(0, 32),
      startMs,
      depStartMs: Math.max(
        startMs,
        startOfUtcDay(toMs) - DEPLOYMENTS_BACKFILL_DAYS * DAY_MS,
      ),
      toMs,
      resumeMs: Math.max(
        startOfUtcDay(toMs) - INCREMENTAL_LOOKBACK_DAYS * DAY_MS,
        startMs,
      ),
      listing: { from: null },
      projects: [],
      index: 0,
      plan: [],
      gone: [],
      deploysDone: [],
      analyticsDone: [],
      // The previous run's final cursor, of this scope: its deployments of
      // the days read again.
      prior:
        decoded?.kind === "done" && Array.isArray(decoded.remember)
          ? decoded.remember
          : [],
      remember: [],
      charges: {},
      queue: [],
      last: {},
      pages: 0,
    };
  }
  const run = state;
  const out: PageOutput = {
    observations: [],
    deployments: [],
    production: [],
  };
  const selection = request.resources ? new Set(request.resources) : null;

  // The run's clock is the time it started, on every page: a run that
  // crosses midnight UTC reads and reports the days as of its start.
  const today = startOfUtcDay(run.at);

  // Provider-keyed state as Maps while the page runs.
  const prior = new Map(run.prior);
  const remember = new Map(run.remember);
  const plan = new Map(run.plan);
  const saveMaps = () => {
    run.remember = [...remember];
    run.plan = [...plan];
  };

  // ── Steps ──

  async function listStep(listing: { from: string | null }) {
    const page = await projectsPage(ask, teamIdOf(context), listing.from);
    const known = new Set(run.projects.map(([id]) => id));
    for (const project of page.projects) {
      if (known.has(project.id)) continue;
      if (selection && !selection.has(project.id)) continue;
      known.add(project.id);
      run.projects.push([
        project.id,
        project.name,
        project.accountId,
        project.analytics ? 1 : 0,
      ]);
    }
    if (page.next !== null) {
      listing.from = page.next;
      return;
    }
    delete run.listing;
    run.teams = [
      ...new Set(
        run.projects
          .map(([, , accountId]) => accountId)
          .filter((accountId) => accountId.startsWith("team_")),
      ),
    ];
  }

  /** Moves to the next project; nothing of this one carries over. */
  function nextProject() {
    run.index += 1;
    delete run.project;
  }

  function gone(projectId: string) {
    log?.warn("project not found, skipped", { project: projectId });
    if (!run.gone.includes(projectId)) run.gone.push(projectId);
    remember.delete(projectId);
    nextProject();
  }

  /** The newest production deployments of a project, or null when it is gone. */
  async function productionList([id, , accountId]: ProjectEntry, query: Query) {
    try {
      return parseAnswer(
        deploymentsPageSchema,
        await ask("/v7/deployments", {
          ...ownerQuery(accountId),
          projectId: id,
          target: "production",
          ...query,
        }),
        "the production deployments",
      ).deployments.filter(
        (deployment) => targetOf(deployment) === "production",
      );
    } catch (error) {
      if (!isMissing(error)) throw error;
      gone(id);
      return null;
    }
  }

  async function latestStep(project: ProjectEntry, progress: ProjectProgress) {
    const deployments = await productionList(project, { limit: "1" });
    if (deployments === null) return;
    const newest = deployments.sort((a, b) => b.created - a.created)[0];
    progress.latest = newest ? latestOf(newest) : null;
    progress.stage = "ready";
  }

  /**
   * The newest READY production build that was promoted (a STAGED one never
   * served traffic): production pointing at an older one was rolled back
   * (owner decision, 2026-11-24).
   */
  async function readyStep(project: ProjectEntry, progress: ProjectProgress) {
    const deployments = await productionList(project, {
      state: "READY",
      limit: String(READY_DEPLOYMENTS_PER_REQUEST),
    });
    if (deployments === null) return;
    const newest = deployments
      .filter(
        (deployment) =>
          stateOf(deployment) === "READY" &&
          deployment.readySubstate !== "STAGED",
      )
      .sort((a, b) => b.created - a.created)[0];
    progress.ready = newest ? latestOf(newest) : null;
    progress.stage = "live";
  }

  async function liveStep(
    [id, name, accountId, analytics]: ProjectEntry,
    progress: ProjectProgress,
  ) {
    let answer;
    try {
      answer = parseAnswer(
        projectTargetsSchema,
        await ask(
          `/v9/projects/${encodeURIComponent(id)}`,
          ownerQuery(accountId),
        ),
        "the project",
      );
    } catch (error) {
      if (!isMissing(error)) throw error;
      gone(id);
      return;
    }
    out.production.push(
      productionRecord(
        { id, name, analytics: analytics === 1 },
        progress.latest ?? null,
        progress.ready ?? null,
        targetDeployment(answer.targets, "production"),
        iso(run.at),
      ),
    );
    run.project = { stage: "deploys" };
  }

  function countObservations(
    projectId: string,
    day: number,
    counts: DayCounts,
  ) {
    // Targets the previous run saw in these days are counted again, zero
    // when their deployments are gone (review of #889).
    const byTarget = new Map(
      counts.map(([target, all, failed]) => [target, [all, failed]] as const),
    );
    const targets = [
      ...new Set([
        ...COUNTED_TARGETS,
        ...(prior.get(projectId)?.targets ?? []),
        ...byTarget.keys(),
      ]),
    ].sort();
    for (const target of targets) {
      const [all, failed] = byTarget.get(target) ?? [0, 0];
      const dimensions = { resource: projectId, target };
      out.observations.push(
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

  async function deploysStep(
    [id, name, accountId, analytics]: ProjectEntry,
    progress: ProjectProgress,
  ) {
    // The first page asks below the window's end. A later one asks up to and
    // including the instant the page before ended at (`until` + 1), and
    // skips what it already read there (review round 2 of #889).
    const boundary = progress.boundary;
    const until = boundary ? boundary.ms + 1 : run.toMs;
    let answer;
    try {
      answer = parseAnswer(
        deploymentsPageSchema,
        await ask("/v7/deployments", {
          ...ownerQuery(accountId),
          projectId: id,
          limit: String(DEPLOYMENTS_PER_REQUEST),
          since: String(run.depStartMs - 1),
          until: String(until),
        }),
        "the deployments",
      );
    } catch (error) {
      if (!isMissing(error)) throw error;
      gone(id);
      return;
    }
    const next = answer.pagination.next;
    // More pages without a cursor that moves back in time: the same page
    // would be read forever.
    if (next !== null && (answer.deployments.length === 0 || next >= until)) {
      throw new VercelInvalidResponseError("the deployments");
    }
    const rows: DatasetRecord[] = [];
    const open = new Map<string, Map<string, [number, number]>>(
      Object.entries(progress.open ?? {}).map(([day, counts]) => [
        day,
        new Map(counts.map(([target, all, failed]) => [target, [all, failed]])),
      ]),
    );
    const found = new Set<string>();
    const remembered: Seen[] = [];
    const targets = new Set<string>();
    const already = new Set(boundary?.ids ?? []);
    let older = false;
    for (const deployment of answer.deployments) {
      // Newer than the page before ended at, or read there already.
      if (deployment.created >= until) continue;
      if (
        boundary &&
        deployment.created === boundary.ms &&
        already.has(deployment.uid)
      ) {
        continue;
      }
      if (deployment.created < run.depStartMs) {
        older = true;
        continue;
      }
      if (deployment.projectId !== undefined && deployment.projectId !== id) {
        throw new VercelInvalidResponseError("the deployments");
      }
      if (found.has(deployment.uid)) continue;
      rows.push(deploymentRecord(deployment, { id, name }));
      found.add(deployment.uid);
      const day = String(startOfUtcDay(deployment.created));
      const counts = open.get(day) ?? new Map<string, [number, number]>();
      const target = targetOf(deployment);
      const [all, failed] = counts.get(target) ?? [0, 0];
      counts.set(target, [
        all + 1,
        failed + (isFailed(stateOf(deployment)) ? 1 : 0),
      ]);
      open.set(day, counts);
      if (deployment.created >= run.resumeMs) {
        remembered.push([deployment.uid, deployment.created]);
        targets.add(target);
      }
    }
    // A page that ends where the one before did and reads nothing new would
    // be asked again forever.
    if (
      next !== null &&
      boundary &&
      next === boundary.ms &&
      rows.length === 0
    ) {
      throw new VercelInvalidResponseError("the deployments");
    }
    const finished = older || next === null || next < run.depStartMs;
    const dayCounts = (day: number): DayCounts =>
      [...(open.get(String(day)) ?? new Map())].map(
        ([target, [all, failed]]) => [target, all, failed],
      );

    // Newest first: every day after the one `next` falls on is complete.
    // Each complete day gets its counts, zero included, so a re-read day
    // whose deployments are gone is counted again too.
    const below = progress.below ?? startOfUtcDay(run.toMs - 1) + DAY_MS;
    const lowest = finished
      ? startOfUtcDay(run.depStartMs)
      : Math.max(startOfUtcDay(next!) + DAY_MS, startOfUtcDay(run.depStartMs));
    for (let day = below - DAY_MS; day >= lowest; day -= DAY_MS) {
      countObservations(id, day, dayCounts(day));
      open.delete(String(day));
    }

    // What the next run needs to tombstone deletions in its window.
    const memory: Memory = remember.get(id) ?? { seen: [], targets: [] };
    memory.targets = [...new Set([...memory.targets, ...targets])].sort();
    if (memory.seen !== null) {
      memory.seen.push(...remembered);
      if (memory.seen.length > MAX_REMEMBERED_DEPLOYMENTS) memory.seen = null;
    }
    remember.set(id, memory);

    // What the previous run read in this window and this one has not found.
    const priorSeen = prior.get(id)?.seen ?? null;
    const missing = (
      progress.missing ??
      (priorSeen ?? []).filter(
        ([, created]) => created >= run.depStartMs && created < run.toMs,
      )
    ).filter(([uid]) => !found.has(uid));

    out.deployments.push(...rows);
    if (finished) {
      // Read completely: what is still missing was deleted at Vercel.
      for (const [uid] of missing) {
        out.deployments.push({
          values: { deployment_id: uid },
          deleted: true,
        });
      }
      run.deploysDone.push(id);
      if (analytics === 1) {
        run.project = { stage: "analytics" };
      } else {
        nextProject();
      }
      return;
    }
    // The deployments read at the instant this page ends at.
    const atNext = answer.deployments
      .filter((deployment) => deployment.created === next)
      .map((deployment) => deployment.uid);
    progress.boundary = {
      ms: next!,
      ids: [
        ...new Set([
          ...(boundary && boundary.ms === next ? boundary.ids : []),
          ...atNext,
        ]),
      ],
    };
    progress.below = Math.min(below, lowest);
    progress.open = Object.fromEntries(
      [...open.keys()].map((day) => [day, dayCounts(Number(day))]),
    );
    progress.missing = missing;
  }

  /** The last day analytics are read for: never beyond today. */
  const analyticsEnd = Math.min(startOfUtcDay(run.toMs - 1), today);

  /** The first day of `month` the account's plan keeps, or null. */
  function analyticsSince(accountId: string, month: number): number | null {
    const since = Math.max(month, plan.get(accountId) ?? month);
    const last = Math.min(startOfNextUtcMonth(month) - DAY_MS, today);
    return since <= last ? since : null;
  }

  /**
   * The next month with days to read, from `month` on, or null when the
   * project's analytics are done.
   */
  function nextMonth(accountId: string, month: number): number | null {
    for (let m = month; m <= analyticsEnd; m = startOfNextUtcMonth(m)) {
      if (analyticsSince(accountId, m) !== null) return m;
    }
    return null;
  }

  async function analyticsStep(
    [id, , accountId]: ProjectEntry,
    progress: ProjectProgress,
  ) {
    const month = progress.month!;
    const part = ANALYTICS_PARTS[progress.part ?? 0]!;
    const monthLastDay = Math.min(startOfNextUtcMonth(month) - DAY_MS, today);
    const query = async (): Promise<unknown> => {
      const since = analyticsSince(accountId, month);
      if (since === null) return null;
      return ask(part.path, {
        ...ownerQuery(accountId),
        projectId: id,
        since: isoDay(since),
        until: isoDay(monthLastDay),
        by: [...part.by],
        ...("top" in part ? { limit: String(TOP_LIMIT) } : {}),
      });
    };
    let body: unknown;
    try {
      try {
        body = await query();
      } catch (error) {
        const days =
          error instanceof VercelApiError ? planWindowDays(error) : null;
        if (days === null) throw error;
        // The plan keeps fewer days than the backfill asks for. Vercel's
        // window rolls with the current UTC day, so the first day it keeps
        // is counted from now, not from the run's start: a run that goes on
        // after midnight moves it forward (review round 2 of #889). The
        // run's last day stays as it started.
        const cutoff = startOfUtcDay(now()) - (days - 1) * DAY_MS;
        const known = plan.get(accountId);
        if (known !== undefined && cutoff <= known) throw error;
        plan.set(accountId, cutoff);
        body = await query();
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      // Web Analytics turned off, or the project gone, since the listing:
      // its analytics are not read this run, and not reported as fresh.
      log?.warn("analytics not found, skipped", { project: id });
      nextProject();
      return;
    }

    const inWindow = (timestamp: string) => {
      const ms = Date.parse(timestamp);
      return ms >= run.startMs && ms < run.toMs;
    };
    if (body !== null) {
      const sourceTimestamp = (timestamp: string) =>
        new Date(timestamp).toISOString();
      if (part.by.length === 1) {
        const visits = parseAnswer(visitsSchema, body, "the visits");
        for (const row of visits.data) {
          if (!inWindow(row.timestamp)) continue;
          const dimensions = { resource: id };
          out.observations.push(
            {
              metricKey: METRICS.pageviews,
              sourceTimestamp: sourceTimestamp(row.timestamp),
              value: row.pageviews,
              dimensions,
            },
            {
              metricKey: METRICS.visitors,
              sourceTimestamp: sourceTimestamp(row.timestamp),
              value: row.visitors,
              dimensions,
            },
          );
        }
      } else if (part.by[1] === "eventName") {
        const events = parseAnswer(eventsSchema, body, "the events");
        for (const row of events.data) {
          if (!inWindow(row.timestamp)) continue;
          out.observations.push({
            metricKey: METRICS.events,
            sourceTimestamp: sourceTimestamp(row.timestamp),
            value: row.count,
            dimensions: { resource: id, event: row.eventName },
          });
        }
      } else {
        const dimension = part.by[1];
        const [field, metricKey] =
          dimension === "route"
            ? (["pageviews", METRICS.routePageviews] as const)
            : (["visitors", METRICS.countryVisitors] as const);
        const visits = parseAnswer(visitsSchema, body, "the visits");
        for (const row of visits.data) {
          const value = row[dimension];
          if (!inWindow(row.timestamp) || typeof value !== "string") continue;
          out.observations.push({
            metricKey,
            sourceTimestamp: sourceTimestamp(row.timestamp),
            value: row[field],
            dimensions: { resource: id, [dimension]: value },
          });
        }
      }
    }

    const nextPart = (progress.part ?? 0) + 1;
    if (body !== null && nextPart < ANALYTICS_PARTS.length) {
      progress.part = nextPart;
      return;
    }
    const following = nextMonth(accountId, startOfNextUtcMonth(month));
    if (following !== null) {
      progress.month = following;
      progress.part = 0;
      return;
    }
    run.analyticsDone.push(id);
    nextProject();
  }

  /** The first day of this month's charges, and the last one (today). */
  const billingFirstDay = startOfUtcMonth(run.at);

  /** Moves billing to the next day, or the next team. */
  function nextBillingDay(position: { team: number; day: number }) {
    if (position.day + DAY_MS <= today) {
      run.billing = { team: position.team, day: position.day + DAY_MS };
    } else {
      run.billing = { team: position.team + 1, day: billingFirstDay };
    }
  }

  async function billingStep(position: { team: number; day: number }) {
    const team = run.teams![position.team]!;
    let charges;
    try {
      // One day per request (review of #889): an answer stays small,
      // however much a team is charged in a month.
      charges = parseCharges(
        await ask(
          "/v1/billing/charges",
          {
            teamId: team,
            from: iso(position.day),
            to: iso(position.day + DAY_MS),
          },
          "text",
        ),
      );
    } catch (error) {
      const refused =
        error instanceof VercelApiError &&
        !error.isAuth &&
        BILLING_REFUSALS.has(error.status);
      if (!refused && !isResponseTooLarge(error)) throw error;
      // Not readable with this token (its role) or plan, or one day's
      // export larger than the host lets an answer be: no charges this
      // run, and the stored snapshot stays; every other dataset publishes.
      log?.warn("billing charges not read", {
        reason: refused ? "refused" : "too_large",
      });
      run.billingPartial = true;
      run.charges = {};
      run.billing = { team: run.teams!.length, day: billingFirstDay };
      return;
    }
    const selected = new Set(run.projects.map(([id]) => id));
    const sums: Record<string, ChargeSum> = {};
    /** The day's effective cost per resource and currency, in minor units. */
    const daily = new Map<
      string,
      { resource: string; currency: string; cost: number }
    >();
    for (const charge of charges) {
      // A charge belongs to the day it starts on: one that spans several
      // days is counted once, with the first day read.
      const start = Date.parse(charge.ChargePeriodStart);
      if (
        !Number.isFinite(start) ||
        start < position.day ||
        start >= position.day + DAY_MS
      ) {
        continue;
      }
      const project = chargeProject(charge);
      // A team's charges of projects outside the selection are not kept.
      if (project.id !== "" && selection && !selected.has(project.id)) continue;
      const key = JSON.stringify([
        team,
        project.id,
        charge.SkuId,
        charge.ChargeCategory,
      ]);
      const sum = sums[key] ??
        run.charges[key] ?? {
          values: {
            team_id: team,
            team_name: charge.SubAccountName?.slice(0, 500) ?? null,
            project_id: project.id,
            project_name: project.name,
            sku_id: charge.SkuId.slice(0, 200),
            service_name: charge.ServiceName.slice(0, 500),
            service_category: charge.ServiceCategory?.slice(0, 200) ?? null,
            charge_category: charge.ChargeCategory,
            consumed_unit: charge.ConsumedUnit ?? null,
            currency: charge.BillingCurrency,
          },
          billed: 0,
          effective: 0,
          quantity: null,
        };
      if (sum.values.currency !== charge.BillingCurrency) {
        throw new VercelInvalidResponseError("the billing charges");
      }
      // Spend (owner decision, 2026-11-24): effective cost, net of
      // discounts; a project's under its ID, team-wide charges under the
      // team's.
      const resource = project.id === "" ? team : project.id;
      const dailyKey = JSON.stringify([resource, charge.BillingCurrency]);
      const day = daily.get(dailyKey) ?? {
        resource,
        currency: charge.BillingCurrency,
        cost: 0,
      };
      day.cost += charge.EffectiveCost;
      daily.set(dailyKey, day);
      sums[key] = {
        values: sum.values,
        billed: sum.billed + charge.BilledCost,
        effective: sum.effective + charge.EffectiveCost,
        quantity:
          typeof charge.ConsumedQuantity === "number"
            ? (sum.quantity ?? 0) + charge.ConsumedQuantity
            : sum.quantity,
      };
    }
    Object.assign(run.charges, sums);
    if (Object.keys(run.charges).length > MAX_BILLING_ROWS) {
      log?.warn("billing charges exceed the row limit, not kept", {
        rows: Object.keys(run.charges).length,
      });
      run.billingPartial = true;
      run.charges = {};
      run.billing = { team: run.teams!.length, day: billingFirstDay };
      return;
    }
    for (const { resource, currency, cost } of daily.values()) {
      out.observations.push({
        metricKey: METRICS.cost,
        sourceTimestamp: iso(position.day),
        value: Math.round(cost * minorUnits(currency)),
        dimensions: { resource, team, currency },
      });
    }
    nextBillingDay(position);
  }

  /** Every team and day read: the sums become the snapshot's rows. */
  function stageCharges() {
    run.billingDone = true;
    if (run.billingPartial) return;
    const month = isoDay(billingFirstDay);
    for (const sum of Object.values(run.charges)) {
      run.queue.push({
        values: {
          ...sum.values,
          month,
          as_of: iso(run.at),
          billed_cost: decimal(sum.billed),
          effective_cost: decimal(sum.effective),
          consumed_quantity:
            sum.quantity === null ? null : Number(sum.quantity.toFixed(6)),
        },
      });
    }
    run.charges = {};
  }

  /** The next step, or null when the run has nothing left to read. */
  function nextStep(): (() => Promise<void>) | null {
    if (run.listing) {
      const listing = run.listing;
      return () => listStep(listing);
    }
    while (run.index < run.projects.length) {
      const project = run.projects[run.index]!;
      run.project ??= { stage: "latest" };
      const progress = run.project;
      if (progress.stage === "latest") {
        return () => latestStep(project, progress);
      }
      if (progress.stage === "ready") {
        return () => readyStep(project, progress);
      }
      if (progress.stage === "live") {
        return () => liveStep(project, progress);
      }
      if (progress.stage === "deploys") {
        return () => deploysStep(project, progress);
      }
      if (progress.month === undefined) {
        // Analytics: the first month with days to read, if any.
        const first = nextMonth(project[2], startOfUtcMonth(run.startMs));
        if (first === null) {
          run.analyticsDone.push(project[0]);
          nextProject();
          continue;
        }
        progress.month = first;
        progress.part = 0;
      }
      return () => analyticsStep(project, progress);
    }
    const teams = run.teams ?? [];
    run.billing ??= { team: 0, day: billingFirstDay };
    if (run.billing.team < teams.length) {
      const position = run.billing;
      return () => billingStep(position);
    }
    if (!run.billingDone && teams.length > 0) stageCharges();
    return null;
  }

  function pendingPages(): number {
    return chunks(out.production).length + chunks(out.deployments).length;
  }

  // ── The page ──

  let steps = 0;
  let step = nextStep();
  while (
    step &&
    budget >= 2 &&
    (steps === 0 || now() - pageStarted < PAGE_TIME_BUDGET_MS) &&
    run.queue.length === 0 &&
    pendingPages() + PAGES_PER_STEP <= DATASET_LIMITS.datasets
  ) {
    try {
      await step();
    } catch (error) {
      // The first step's failure fails the page (the host retries it, or
      // waits for a rate limit's reset). A later one ends the page with
      // what it read: the next page starts with the failed step.
      if (steps === 0 || isFatal(error)) throw error;
      log?.warn("step failed, the next page repeats it", {
        error: error instanceof Error ? error.name : "unknown",
      });
      break;
    }
    steps += 1;
    step = nextStep();
  }

  const datasetPages: DatasetPage[] = [];
  for (const records of chunks(out.deployments)) {
    datasetPages.push(datasetPage(run, deploymentsDataset.key, records, false));
  }
  for (const records of chunks(out.production)) {
    datasetPages.push(
      datasetPage(run, productionDeploymentsDataset.key, records, false),
    );
  }
  // Charge rows drain across results: as many pages as this one has room for.
  while (
    run.queue.length > 0 &&
    datasetPages.length < DATASET_LIMITS.datasets
  ) {
    const [records] = chunks(run.queue);
    run.queue = run.queue.slice(records!.length);
    datasetPages.push(
      datasetPage(run, billingChargesDataset.key, records!, false),
    );
  }

  if (!step && run.queue.length === 0) run.finishing = true;
  saveMaps();

  if (step || !run.finishing || datasetPages.length > 0) {
    return {
      observations: out.observations,
      datasetPages,
      nextCursor: encodeState(run),
      done: false,
    };
  }

  // ── The final page: only the empty pages that complete the datasets ──

  const teams = run.teams ?? [];
  const billingComplete = teams.length > 0 && !run.billingPartial;
  // Deployments are upserted: what was read is published, whatever was
  // not read stays as stored.
  datasetPages.push(datasetPage(run, deploymentsDataset.key, [], true));
  datasetPages.push(
    datasetPage(run, productionDeploymentsDataset.key, [], true),
  );
  const received: string[] = [productionDeploymentsDataset.key];
  if (billingComplete) {
    datasetPages.push(datasetPage(run, billingChargesDataset.key, [], true));
    received.push(billingChargesDataset.key);
  }
  // Every selected project's deployments were read: the dataset counts as
  // checked even where no project had a deployment (#666).
  const listed = run.projects.map(([id]) => id);
  const everySelected = (done: readonly string[]) =>
    (request.resources ?? listed).every((id) => done.includes(id));
  if (everySelected(run.deploysDone)) received.push(deploymentsDataset.key);

  const freshness: FreshnessEntry[] = [];
  // Deployments: for the connection when every selected project was read,
  // and per project read completely. Every per-project entry the
  // connection entry already covers is left out when the entries would
  // exceed the bound, so Web Analytics, which has no connection entry,
  // keeps its per-project entries (review round 2 of #889, ADR 0025 §3).
  const deploysComplete = everySelected(run.deploysDone);
  if (deploysComplete) freshness.push({ stream: DEPLOYS_STREAM });
  const deployEntries = run.deploysDone.map((id) => ({
    stream: DEPLOYS_STREAM,
    resource: id,
  }));
  const analyticsEntries = run.analyticsDone.map((id) => ({
    stream: ANALYTICS_STREAM,
    resource: id,
  }));
  const spare =
    FRESHNESS_LIMITS.entries - freshness.length - analyticsEntries.length - 1;
  if (!deploysComplete || deployEntries.length <= spare) {
    freshness.push(...deployEntries);
  }
  // Web Analytics: per project only. A project without it gets no entry,
  // and no connection entry covers it: it never claims data (#871).
  freshness.push(...analyticsEntries);
  if (billingComplete) freshness.push({ stream: BILLING_STREAM });
  const bounded = boundFreshness(freshness, listed);

  // The next run starts at resumeMs: it needs the deployments this one
  // read from there on, for the projects read completely.
  const carried: Remembered = run.deploysDone.flatMap((id) => {
    const memory = remember.get(id);
    return memory ? [[id, memory] as [string, Memory]] : [];
  });
  const resumeAt = iso(run.resumeMs);
  return {
    observations: out.observations,
    datasetPages,
    receivedDatasets: received,
    ...(bounded.length > 0 ? { freshness: bounded } : {}),
    nextCursor: encodeState({
      v: 1,
      kind: "done",
      connection: run.connection,
      scope: run.scope,
      remember: carried,
    }),
    nextFrom: resumeAt,
    done: true,
  };
}
