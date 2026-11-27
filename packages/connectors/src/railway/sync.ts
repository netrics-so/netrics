// The Railway sync, as a resumable run (#870, review #881).
//
// A run is a sequence of steps, each exactly one request to Railway:
//
//   1. start: the workspaces (`me` or the configured `workspace`);
//   2. list: one page of a workspace's projects;
//   3. per project: one page of its lasting environments (with their first
//      service instances), one page of an environment's further instances,
//      or one page of its deployments;
//   4. cost: the month-to-date usage of one workspace at the end of one day;
//   5. estimate: Railway's estimate for one workspace.
//
// A sync page runs at most MAX_REQUESTS_PER_PAGE steps and checkpoints the
// position after the last one in its cursor, so a retry continues at the
// step that failed, never earlier. A step that fails after others of the
// same page succeeded ends the page early with their progress; a rate
// limit is kept in the cursor, and the next page waits for its reset
// without a request (#883). The cursor is bound to the connection
// and the workspace scope: a cursor of another scope restarts the run.
// Snapshots are completed only by the last page of a run, and only when
// every part of them was read.

import { createHash } from "node:crypto";

import {
  DATASET_LIMITS,
  RateLimitedError,
  type ConnectionContext,
  type DatasetPage,
  type DatasetRecord,
  type FreshnessEntry,
  type Observation,
  type SyncRequest,
  type SyncResult,
} from "@netrics/connector-sdk";

import { boundFreshness } from "../freshness.js";
import { pendingHold, rateLimitHold } from "../rate-limit-hold.js";

import { RailwayApiError, type RailwayQuery } from "./api.js";
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
  ENVIRONMENT_INSTANCES_QUERY,
  ESTIMATED_USAGE_QUERY,
  PROJECT_STATE_QUERY,
  USAGE_QUERY,
  deploymentsSchema,
  environmentInstancesSchema,
  estimatedUsageSchema,
  nextAfter,
  projectStateSchema,
  usageSchema,
  type RailwayServiceInstance,
} from "./queries.js";
import {
  listWorkspaces,
  projectsPage,
  tokenOf,
  workspaceIdOf,
} from "./reading.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Days re-read on every incremental sync: deployments change status after
 * they are created (building → success, later removed or crashed), and
 * today's usage keeps growing.
 */
export const INCREMENTAL_LOOKBACK_DAYS = 2;
/**
 * Requests per sync page. Each takes well under a second; ten keep a page
 * far inside the host's call budget and spread a backfill over pages, so a
 * rate limit or failure loses at most one step.
 */
export const MAX_REQUESTS_PER_PAGE = 10;
const ENVIRONMENTS_PER_REQUEST = 10;
const INSTANCES_PER_REQUEST = 50;
const DEPLOYMENTS_PER_REQUEST = 50;
/** Rows and bytes per dataset page, well inside ADR 0026's limits. */
const PAGE_ROWS = 500;
const PAGE_BYTES = DATASET_LIMITS.pageBytes / 2;

/** Freshness streams (ADR 0025). */
export const DEPLOYS_STREAM = "deploys";
export const COST_STREAM = "cost";
export const ESTIMATE_STREAM = "cost_estimate";

export const METRICS = {
  deployments: "railway.deployments",
  failedDeployments: "railway.failed_deployments",
  cost: "railway.cost",
  estimatedCost: "railway.estimated_cost",
} as const;

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

/** Where the current project is. Dropped whenever the run moves on. */
interface ProjectProgress {
  stage: "states" | "deploys";
  /** Next environments page: absent before the first, null when done. */
  envNext?: string | null;
  /** Environments whose further service instances are still to read. */
  instances: Array<{ env: string; name: string; after: string }>;
  /** Names seen so far, for the deployment rows. */
  services: Record<string, string>;
  environments: Record<string, string>;
  /** Deployments: the page after which reading continues. */
  after?: string;
  /** The oldest day read so far, which a further page may still extend. */
  open?: { day: number; counts: DayCounts };
}

interface RunState {
  v: 3;
  /**
   * What the run reads: the connection, and its scope (workspace ID and a
   * fingerprint of the token, never the token).
   */
  connection: string;
  scope: string;
  /** When the run started: the clock of all its pages. */
  at: number;
  refresh: string;
  startMs: number;
  toMs: number;
  workspaces: string[];
  /** The listing position; absent once every workspace is listed. */
  listing?: { ws: number; after: string | null };
  /** [project id, workspace id, name], in reading order. */
  projects: Array<[string, string, string]>;
  index: number;
  project?: ProjectProgress;
  /** Usage: the workspace and day read next, and the day before's cents. */
  cost?: { ws: number; day: number; prev?: Record<string, number> };
  costDone?: boolean;
  /** Days of usage read, workspaces refused, today's usage per project. */
  costDays: number;
  costDenied: string[];
  todayRead: string[];
  today: Record<string, Usage>;
  /** Estimate: the workspace read next; done; refused. */
  estimate?: { ws: number };
  estimateDone?: boolean;
  estimateDenied?: boolean;
  estimates: Record<string, Usage>;
  /** Dataset refresh chains: last page key per dataset, page counter. */
  last: Record<string, string | null>;
  pages: number;
  /**
   * A project disappeared during the run: no deploy freshness, and the
   * state snapshot is left incomplete, so the stored one stays.
   */
  deploysPartial?: boolean;
  /**
   * Every step is done and the rows of the last ones went out on a page
   * that is not final: the next page completes the refreshes. Set with
   * `usageStaged` when the usage snapshot's rows went out.
   */
  finishing?: boolean;
  usageStaged?: boolean;
  /**
   * Rows of the usage snapshot already sent while it is sent over several
   * pages (more than DATASET_LIMITS.datasets chunks, #883).
   */
  usageOffset?: number;
  /** A rate limit hit after progress: the reset (ms) the next page waits for. */
  retryAt?: number;
}

const CURSOR_PREFIX = "railway.v3:";

export const RATE_LIMIT_DEFERRED_MESSAGE =
  "Railway's API rate limit is used up. netrics continues after the reset.";

/**
 * A checkpoint belongs to the workspace ID and the token it was read
 * with: another account's token must not continue it (#881). Only a
 * salted, shortened hash of the token is kept.
 */
function scopeOf(context: ConnectionContext): string {
  const fingerprint = createHash("sha256")
    .update(`railway-cursor|${context.connectionId}|${tokenOf(context) ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  return `${workspaceIdOf(context) ?? ""}|${fingerprint}`;
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
    return state.v === 3 &&
      state.connection === connection &&
      state.scope === scope
      ? state
      : null;
  } catch {
    return null;
  }
}

function refreshKey(
  connection: string,
  scope: string,
  start: number,
  to: number,
) {
  return createHash("sha256")
    .update(`${connection}|${scope}|${start}|${to}`)
    .digest("hex")
    .slice(0, 32);
}

// ─── Pages ──────────────────────────────────────────────────────────────────

/** Records split into pages within the row and byte bounds. */
function chunks(
  records: DatasetRecord[],
  pageRows = PAGE_ROWS,
): DatasetRecord[][] {
  const result: DatasetRecord[][] = [];
  let current: DatasetRecord[] = [];
  let bytes = 0;
  for (const record of records) {
    const size = Buffer.byteLength(JSON.stringify(record));
    if (
      current.length > 0 &&
      (current.length >= pageRows || bytes + size > PAGE_BYTES)
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

// ─── The run ────────────────────────────────────────────────────────────────

export interface RailwaySyncOptions {
  now: () => number;
  /** Rows per dataset page; smaller in tests, to reach the page limits. */
  pageRows?: number;
}

/** What one page collects before it is returned. */
interface PageOutput {
  observations: Observation[];
  states: DatasetRecord[];
  deployments: DatasetRecord[];
}

function isMissing(error: unknown): boolean {
  return error instanceof RailwayApiError && error.kind === "not_found";
}

function isRefused(error: unknown): boolean {
  return (
    error instanceof RailwayApiError &&
    (error.kind === "auth" || error.kind === "not_found")
  );
}

export async function syncPage(
  query: RailwayQuery,
  context: ConnectionContext,
  request: SyncRequest,
  options: RailwaySyncOptions,
): Promise<SyncResult> {
  const { now } = options;
  const pageRows = options.pageRows ?? PAGE_ROWS;
  const scope = scopeOf(context);
  let budget = MAX_REQUESTS_PER_PAGE;
  const ask: RailwayQuery = (document, variables) => {
    budget -= 1;
    return query(document, variables);
  };

  let state = decodeState(request.cursor, context.connectionId, scope);
  // A page that ended on a rate limit: nothing is sent before the reset.
  // A hold stored before the cap no longer holds (#914 review).
  if (state?.retryAt !== undefined) {
    const until = pendingHold(state.retryAt, now());
    if (until !== undefined) {
      throw new RateLimitedError(RATE_LIMIT_DEFERRED_MESSAGE, new Date(until));
    }
    delete state.retryAt;
  }
  // Whether this page has anything to checkpoint yet.
  let progressed = false;
  if (!state) {
    const workspaces = await listWorkspaces(ask, workspaceIdOf(context));
    const startMs = startOfUtcDay(Date.parse(request.from));
    const toMs = Date.parse(request.to);
    state = {
      v: 3,
      connection: context.connectionId,
      scope,
      at: now(),
      refresh: refreshKey(context.connectionId, scope, startMs, toMs),
      startMs,
      toMs,
      workspaces: workspaces.map((workspace) => workspace.id),
      // A token without workspaces has nothing to list (#881).
      ...(workspaces.length > 0 ? { listing: { ws: 0, after: null } } : {}),
      projects: [],
      index: 0,
      costDays: 0,
      costDenied: [],
      todayRead: [],
      today: {},
      estimates: {},
      last: {},
      pages: 0,
    };
    progressed = true;
  }
  const run = state;
  const out: PageOutput = { observations: [], states: [], deployments: [] };

  // The run's clock is the time it started, on every page: a run that
  // crosses midnight UTC reads and reports the days as of its start, so it
  // never calls a day complete that it read only partly (#881).
  const nowMs = run.at;
  const today = startOfUtcDay(nowMs);
  const lastCostDay = Math.min(startOfUtcDay(run.toMs - 1), today);
  const firstCostDay = Math.max(run.startMs, startOfPreviousUtcMonth(nowMs));

  // ── Steps ──

  async function listStep(listing: { ws: number; after: string | null }) {
    const workspaceId = run.workspaces[listing.ws]!;
    const page = await projectsPage(ask, workspaceId, listing.after);
    for (const project of page.projects) {
      run.projects.push([project.id, workspaceId, project.name]);
    }
    if (page.next !== null) {
      listing.after = page.next;
    } else if (listing.ws + 1 < run.workspaces.length) {
      run.listing = { ws: listing.ws + 1, after: null };
    } else {
      delete run.listing;
    }
  }

  /** Moves to the next project; nothing of this one carries over. */
  function nextProject() {
    run.index += 1;
    delete run.project;
  }

  function stateRows(
    projectId: string,
    projectName: string,
    environment: { id: string; name: string },
    instances: RailwayServiceInstance[],
    progress: ProjectProgress,
  ) {
    const checkedAt = iso(nowMs);
    for (const instance of instances) {
      const serviceName = instance.serviceName ?? instance.serviceId;
      progress.services[instance.serviceId] = serviceName;
      const latest = instance.latestDeployment ?? null;
      const active = (instance.activeDeployments ?? []).map(
        (deployment) => deployment.status,
      );
      out.states.push({
        values: {
          project_id: projectId,
          project_name: projectName,
          service_id: instance.serviceId,
          service_name: serviceName,
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

  async function statesStep(
    projectId: string,
    projectName: string,
    progress: ProjectProgress,
  ) {
    const pendingEnv = progress.instances[0];
    if (pendingEnv) {
      const answer = environmentInstancesSchema.parse(
        await ask(ENVIRONMENT_INSTANCES_QUERY, {
          environmentId: pendingEnv.env,
          projectId,
          first: INSTANCES_PER_REQUEST,
          after: pendingEnv.after,
        }),
      ).environment.serviceInstances;
      stateRows(
        projectId,
        projectName,
        { id: pendingEnv.env, name: pendingEnv.name },
        answer.edges.map((edge) => edge.node),
        progress,
      );
      const next = nextAfter(answer.pageInfo);
      if (next !== null) pendingEnv.after = next;
      else progress.instances.shift();
      return;
    }
    const answer = projectStateSchema.parse(
      await ask(PROJECT_STATE_QUERY, {
        projectId,
        envFirst: ENVIRONMENTS_PER_REQUEST,
        envAfter: progress.envNext ?? null,
        instFirst: INSTANCES_PER_REQUEST,
        ephemeral: false,
      }),
    ).project;
    const envNext = nextAfter(answer.environments.pageInfo);
    for (const { node: environment } of answer.environments.edges) {
      // Railway filters PR environments out; a stray one is not a state.
      if (environment.isEphemeral) continue;
      progress.environments[environment.id] = environment.name;
      const instances = environment.serviceInstances;
      stateRows(
        projectId,
        answer.name,
        environment,
        instances.edges.map((edge) => edge.node),
        progress,
      );
      const after = nextAfter(instances.pageInfo);
      if (after !== null) {
        progress.instances.push({
          env: environment.id,
          name: environment.name,
          after,
        });
      }
    }
    progress.envNext = envNext;
  }

  async function deploymentsStep(projectId: string, progress: ProjectProgress) {
    let answer;
    try {
      answer = deploymentsSchema.parse(
        await ask(DEPLOYMENTS_QUERY, {
          projectId,
          first: DEPLOYMENTS_PER_REQUEST,
          after: progress.after ?? null,
        }),
      ).deployments;
    } catch (error) {
      // Railway answers "Not Authorized" for a project that is gone: ask
      // the project itself, and skip it only if it is gone. A probe that
      // fails otherwise (a rate limit, an outage) says nothing about the
      // token: its own error goes up, a rate limit as one (#883).
      if (error instanceof RailwayApiError && error.kind === "auth") {
        try {
          await ask(PROJECT_STATE_QUERY, {
            projectId,
            envFirst: 1,
            envAfter: null,
            instFirst: 1,
            ephemeral: false,
          });
        } catch (probe) {
          if (!(probe instanceof RailwayApiError && probe.kind === "auth")) {
            throw probe;
          }
        }
      }
      throw error;
    }
    const next = nextAfter(answer.pageInfo);
    const services = new Map(Object.entries(progress.services));
    const environments = new Map(Object.entries(progress.environments));
    const days = new Map<number, DayCounts>();
    if (progress.open) days.set(progress.open.day, progress.open.counts);
    let older = false;
    for (const { node } of answer.edges) {
      const created = Date.parse(node.createdAt);
      if (created < run.startMs) {
        older = true;
        continue;
      }
      if (created >= run.toMs) continue;
      out.deployments.push(deploymentRecord(node, { services, environments }));
      const day = startOfUtcDay(created);
      const key = `${node.serviceId ?? ""}|${node.environmentId}`;
      const counts = days.get(day) ?? {};
      const [all, failed] = counts[key] ?? [0, 0];
      counts[key] = [all + 1, failed + (isFailed(node.status) ? 1 : 0)];
      days.set(day, counts);
    }
    const finished = older || next === null;

    // Newest first: every day but the oldest read is complete. The oldest
    // is counted on with the next page unless the project is done.
    delete progress.open;
    if (!finished && days.size > 0) {
      const oldest = Math.min(...days.keys());
      progress.open = { day: oldest, counts: days.get(oldest)! };
      days.delete(oldest);
    }
    for (const [day, counts] of [...days].sort(([a], [b]) => a - b)) {
      for (const key of Object.keys(counts).sort()) {
        const [serviceId, environmentId] = key.split("|") as [string, string];
        const [all, failed] = counts[key]!;
        const dimensions = {
          resource: projectId,
          service: serviceId === "" ? "unknown" : serviceId,
          environment: environmentId,
        };
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
    if (finished || next === null) nextProject();
    else progress.after = next;
  }

  async function projectStep() {
    const [projectId, , projectName] = run.projects[run.index]!;
    run.project ??= {
      stage: "states",
      instances: [],
      services: {},
      environments: {},
    };
    const progress = run.project;
    // Rows of this step go out only if the step succeeds.
    const mark = {
      states: out.states.length,
      deployments: out.deployments.length,
      observations: out.observations.length,
    };
    try {
      if (progress.stage === "states") {
        await statesStep(projectId, projectName, progress);
        if (progress.envNext === null && progress.instances.length === 0) {
          progress.stage = "deploys";
        }
      } else {
        await deploymentsStep(projectId, progress);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      // Deleted (or unshared) since the listing: its rows are dropped from
      // the snapshot, and the run reports no deploy freshness.
      out.states.length = mark.states;
      out.deployments.length = mark.deployments;
      out.observations.length = mark.observations;
      run.deploysPartial = true;
      nextProject();
    }
  }

  function projectsOf(workspaceId: string): string[] {
    return run.projects
      .filter(([, workspace]) => workspace === workspaceId)
      .map(([project]) => project);
  }

  async function monthToDate(
    workspaceId: string,
    endMs: number,
  ): Promise<Map<string, Usage>> {
    const answer = usageSchema.parse(
      await ask(USAGE_QUERY, {
        workspaceId,
        measurements: [...COST_MEASUREMENTS],
        startDate: iso(startOfUtcMonth(endMs - 1)),
        endDate: iso(endMs),
      }),
    );
    const byProject = new Map<string, Usage>();
    for (const row of answer.usage) {
      addUsage(byProject, row.tags.projectId, row.measurement, row.value);
    }
    return byProject;
  }

  function nextCostWorkspace(cost: NonNullable<RunState["cost"]>) {
    if (cost.ws + 1 < run.workspaces.length) {
      run.cost = { ws: cost.ws + 1, day: firstCostDay };
    } else {
      run.costDone = true;
      delete run.cost;
    }
  }

  /**
   * The listed projects, then those only the usage names: projects deleted
   * before the listing, whose usage Railway still bills (#883). Their cost
   * is history; they are no part of the live snapshots.
   */
  function costProjects(listed: string[], usage: Map<string, Usage>) {
    return [...new Set([...listed, ...usage.keys()])];
  }

  async function costStep(cost: NonNullable<RunState["cost"]>) {
    const workspaceId = run.workspaces[cost.ws]!;
    const listed = projectsOf(workspaceId);
    const monthStart = cost.day === startOfUtcMonth(cost.day);
    try {
      if (!monthStart && cost.prev === undefined) {
        // The day before the first day read, within its month: the base
        // of the first day's difference.
        const before = await monthToDate(workspaceId, cost.day);
        cost.prev = Object.fromEntries(
          costProjects(listed, before).map((id) => [
            id,
            cents(usageCostUsd(before.get(id) ?? {})),
          ]),
        );
        return;
      }
      const usage = await monthToDate(
        workspaceId,
        Math.min(cost.day + DAY_MS, nowMs),
      );
      const base = monthStart ? {} : (cost.prev ?? {});
      const current: Record<string, number> = {};
      for (const projectId of costProjects(listed, usage)) {
        current[projectId] = cents(usageCostUsd(usage.get(projectId) ?? {}));
        out.observations.push({
          metricKey: METRICS.cost,
          sourceTimestamp: iso(cost.day),
          value: current[projectId] - (base[projectId] ?? 0),
          dimensions: { resource: projectId },
        });
      }
      if (cost.day === today) {
        for (const projectId of listed) {
          run.today[projectId] = usage.get(projectId) ?? {};
        }
        run.todayRead.push(workspaceId);
      }
      run.costDays += 1;
      cost.prev = current;
      cost.day += DAY_MS;
      if (cost.day > lastCostDay) nextCostWorkspace(cost);
    } catch (error) {
      // A token that may list projects but not read usage: no cost for
      // this workspace, and no complete cost for the run.
      if (!isRefused(error)) throw error;
      run.costDenied.push(workspaceId);
      nextCostWorkspace(cost);
    }
  }

  async function estimateStep(estimate: { ws: number }) {
    const workspaceId = run.workspaces[estimate.ws]!;
    const advance = () => {
      if (estimate.ws + 1 < run.workspaces.length) estimate.ws += 1;
      else {
        run.estimateDone = true;
        delete run.estimate;
      }
    };
    if (run.costDenied.includes(workspaceId)) {
      advance();
      return;
    }
    try {
      const answer = estimatedUsageSchema.parse(
        await ask(ESTIMATED_USAGE_QUERY, {
          workspaceId,
          measurements: [...COST_MEASUREMENTS],
        }),
      );
      // A forecast of the moment it was read: dated by that day, not the
      // run's. Read on a later day than the run's usage, it may belong to
      // another billing period, and the usage snapshot goes without it
      // (#883).
      const readDay = startOfUtcDay(now());
      const byProject = new Map<string, Usage>();
      for (const row of answer.estimatedUsage) {
        addUsage(byProject, row.projectId, row.measurement, row.estimatedValue);
      }
      for (const projectId of projectsOf(workspaceId)) {
        const usage = byProject.get(projectId);
        if (!usage) continue;
        if (readDay === today) run.estimates[projectId] = usage;
        out.observations.push({
          metricKey: METRICS.estimatedCost,
          sourceTimestamp: iso(readDay),
          value: cents(usageCostUsd(usage)),
          dimensions: { resource: projectId },
        });
      }
    } catch (error) {
      if (!isRefused(error)) throw error;
      run.estimateDenied = true;
    }
    advance();
  }

  /** The next step, or null when the run has nothing left to read. */
  function nextStep(): (() => Promise<void>) | null {
    if (run.listing) {
      const listing = run.listing;
      return () => listStep(listing);
    }
    if (run.index < run.projects.length) return projectStep;
    if (!run.costDone) {
      if (firstCostDay > lastCostDay || run.workspaces.length === 0) {
        run.costDone = true;
      } else {
        run.cost ??= { ws: 0, day: firstCostDay };
        const cost = run.cost;
        return () => costStep(cost);
      }
    }
    if (!run.estimateDone) {
      if (lastCostDay !== today || run.workspaces.length === 0) {
        run.estimateDone = true;
      } else {
        run.estimate ??= { ws: 0 };
        const estimate = run.estimate;
        return () => estimateStep(estimate);
      }
    }
    return null;
  }

  /** The usage snapshot: every project, today's usage and estimate. */
  function usageRecords(): DatasetRecord[] {
    return run.projects.map(([projectId, , name]) => {
      const usage = run.today[projectId] ?? {};
      const estimate = run.estimates[projectId];
      return {
        values: {
          project_id: projectId,
          project_name: name,
          month: isoDay(startOfUtcMonth(nowMs)),
          as_of: iso(nowMs),
          cpu_vcpu_minutes: quantity(usage.CPU_USAGE),
          memory_gb_minutes: quantity(usage.MEMORY_USAGE_GB),
          egress_gb: quantity(usage.NETWORK_TX_GB),
          disk_gb_minutes: quantity(usage.DISK_USAGE_GB),
          cost_usd: usdDecimal(usageCostUsd(usage)),
          estimated_cost_usd:
            estimate !== undefined ? usdDecimal(usageCostUsd(estimate)) : null,
          currency: "USD",
        },
      };
    });
  }

  // ── The page ──

  // A step sends one request, a deployments step whose project may be gone
  // two (see deploymentsStep): a step starts only while two are left.
  let step = nextStep();
  while (step && budget >= 2) {
    const checkpoint = JSON.stringify(run);
    const marks = [
      out.states.length,
      out.deployments.length,
      out.observations.length,
    ] as const;
    try {
      await step();
    } catch (error) {
      // Nothing done yet: the host retries this page's checkpoint.
      if (!progressed) throw error;
      // Otherwise the steps done so far go out, and the next page starts
      // at the one that failed (#883).
      const saved = JSON.parse(checkpoint) as RunState;
      for (const key of Object.keys(run)) {
        delete (run as unknown as Record<string, unknown>)[key];
      }
      Object.assign(run, saved);
      out.states.length = marks[0];
      out.deployments.length = marks[1];
      out.observations.length = marks[2];
      // At most as long as the host defers a run (#914).
      if (error instanceof RateLimitedError) {
        const hold = rateLimitHold(error.retryAt, now());
        if (hold !== undefined) run.retryAt = hold;
      }
      break;
    }
    progressed = true;
    step = nextStep();
  }

  const datasetPages: DatasetPage[] = [];
  const flush = (key: string, records: DatasetRecord[]) => {
    for (const chunk of chunks(records, pageRows)) {
      datasetPages.push(datasetPage(run, key, chunk, false));
    }
  };
  flush(serviceStatesDataset.key, out.states);
  flush(deploymentsDataset.key, out.deployments);

  const usageComplete =
    run.costDenied.length === 0 &&
    lastCostDay === today &&
    run.workspaces.every((workspace) => run.todayRead.includes(workspace));

  // Every step done, rows still to send: they go out on this page, which is
  // not final, and the next page completes the refreshes. The host refuses
  // a final result with an incomplete page (ADR 0026 §7), so the final
  // result carries nothing but the empty pages that complete them.
  if (!step && !run.finishing) {
    // The usage snapshot is replaced only when today's usage of every
    // workspace was read (ADR 0026): otherwise the stored one stays. Its
    // rows fill the room this page has left, the rest follows on the next
    // pages from the stored offset (#883).
    if (usageComplete) {
      const records = usageRecords();
      let offset = run.usageOffset ?? 0;
      for (const chunk of chunks(records.slice(offset), pageRows)) {
        if (datasetPages.length >= DATASET_LIMITS.datasets) break;
        datasetPages.push(
          datasetPage(run, projectUsageDataset.key, chunk, false),
        );
        offset += chunk.length;
      }
      if (offset >= records.length) {
        delete run.usageOffset;
        run.usageStaged = true;
        run.finishing = true;
      } else {
        run.usageOffset = offset;
      }
    } else {
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

  // The final page. A project that disappeared during the run leaves the
  // state refresh incomplete: its rows already went out, and only the
  // stored snapshot is known to be whole (ADR 0026 §7).
  const received = [deploymentsDataset.key];
  datasetPages.push(datasetPage(run, deploymentsDataset.key, [], true));
  if (!run.deploysPartial) {
    datasetPages.push(datasetPage(run, serviceStatesDataset.key, [], true));
    received.push(serviceStatesDataset.key);
  }
  if (run.usageStaged) {
    datasetPages.push(datasetPage(run, projectUsageDataset.key, [], true));
    received.push(projectUsageDataset.key);
  }

  const freshness: FreshnessEntry[] = [];
  if (!run.deploysPartial) freshness.push({ stream: DEPLOYS_STREAM });
  if (run.costDays > 0 && run.costDenied.length === 0) {
    // Today's usage is still growing: the last complete day is the one
    // before; the next one is complete at midnight UTC.
    const through = lastCostDay === today ? today - DAY_MS : lastCostDay;
    freshness.push({
      stream: COST_STREAM,
      dataThrough: isoDay(through),
      expectedFrom: iso(through + 2 * DAY_MS),
      nextExpectedAt: iso(through + 2 * DAY_MS + 60 * 60 * 1000),
    });
  }
  if (
    lastCostDay === today &&
    run.workspaces.length > 0 &&
    run.costDenied.length === 0 &&
    !run.estimateDenied
  ) {
    freshness.push({ stream: ESTIMATE_STREAM });
  }
  const bounded = boundFreshness(freshness);

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
