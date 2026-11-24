// The HTTP check sync, as a run of two pages (#874).
//
//   1. The checks page requests every check once (at most MAX_CHECKS, at
//      most CONCURRENCY at a time) and returns their `http-check.up` and
//      `http-check.response_ms` observations and the `checks` snapshot rows
//      on an incomplete dataset page, with a run cursor.
//   2. The final page carries nothing but the empty page that completes
//      the snapshot (the host refuses a final result with an incomplete
//      page, ADR 0026 §7), the received dataset and the freshness of every
//      check the run requested.
//
// The run cursor is bound to the connection and a fingerprint of the
// configuration (the check list) and of the credentials (none today; the
// fingerprint never holds a secret). A run cursor of another connection,
// configuration or credential, or one older than RUN_MAX_AGE_MS (a run
// whose second page never came), starts a new run: an old run's results
// never complete a snapshot or claim freshness now.
//
// A finished run leaves a done cursor (`http-check.done1:`): per check its
// state, since when, and a fingerprint of what it checks, so the next run
// knows when a state changed. It is bound to the connection; a check whose
// fingerprint changed starts without a previous state.

import { createHash } from "node:crypto";

import type {
  ConnectionContext,
  ConnectorLogger,
  ConnectorRuntime,
  DatasetPage,
  DatasetRecord,
  FreshnessEntry,
  Observation,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";

import { boundFreshness } from "../freshness.js";

import { checkFingerprint, type HttpCheck } from "./checks.js";
import { checkRecord, checksDataset } from "./datasets.js";
import { probe, type ProbeResult } from "./probe.js";

/** Freshness stream (ADR 0025): continuous, per check. */
export const CHECKS_STREAM = "checks";

export const METRICS = {
  /** 1 when the check was up, 0 when it was down, per run. */
  up: "http-check.up",
  /** Milliseconds until the answer, per run that got one. */
  responseMs: "http-check.response_ms",
} as const;

/** Checks requested at the same time. */
export const CONCURRENCY = 10;
/**
 * A run cursor older than this starts a new run: two sync intervals. The
 * second page normally follows the first at once.
 */
export const RUN_MAX_AGE_MS = 2 * 60 * 1000;

const RUN_PREFIX = "http-check.run1:";
const DONE_PREFIX = "http-check.done1:";

/** A check's state as the next run needs it. */
interface CheckState {
  /** checkFingerprint: what the state was measured for. */
  fp: string;
  up: boolean;
  /** When the state began, or null when no run saw it begin. */
  since: string | null;
}

interface RunState {
  v: 1;
  connection: string;
  scope: string;
  /** When the run requested its checks (ms since the epoch). */
  at: number;
  refresh: string;
  /** The check ids the run requested, in order. */
  checks: string[];
  /** The states the next run compares against. */
  states: Record<string, CheckState>;
}

interface DoneState {
  v: 1;
  connection: string;
  states: Record<string, CheckState>;
}

function encode(prefix: string, state: unknown): string {
  return prefix + Buffer.from(JSON.stringify(state)).toString("base64url");
}

function decode<T>(cursor: string | undefined, prefix: string): T | null {
  if (!cursor?.startsWith(prefix)) return null;
  try {
    return JSON.parse(
      Buffer.from(cursor.slice(prefix.length), "base64url").toString("utf8"),
    ) as T;
  } catch {
    return null;
  }
}

function validStates(value: unknown): value is Record<string, CheckState> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (state: unknown) =>
        state !== null &&
        typeof state === "object" &&
        typeof (state as CheckState).fp === "string" &&
        typeof (state as CheckState).up === "boolean" &&
        ((state as CheckState).since === null ||
          typeof (state as CheckState).since === "string"),
    )
  );
}

/**
 * A salted, shortened hash of the connection, its checks and a credential
 * fingerprint: another configuration or credential starts a new run.
 */
export function scopeOf(
  connectionId: string,
  checks: readonly HttpCheck[],
  credentialFingerprint: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "http-check-cursor",
        connectionId,
        checks.map((check) => [check.id, check.name, checkFingerprint(check)]),
        credentialFingerprint,
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}

/** A non-secret fingerprint of the credentials: never the values. */
export function credentialFingerprint(
  credentials: Record<string, unknown>,
): string {
  const keys = Object.keys(credentials).sort();
  if (keys.length === 0) return "none";
  return createHash("sha256")
    .update(
      `http-check-credentials|${JSON.stringify(keys.map((key) => [key, credentials[key]]))}`,
    )
    .digest("hex")
    .slice(0, 16);
}

/** Runs `work` over `items`, at most `limit` at a time, results in order. */
async function pooled<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await work(items[index]!);
      }
    },
  );
  await Promise.all(lanes);
  return results;
}

export interface HttpCheckSyncOptions {
  now: () => number;
  /** A monotonic clock for response times (ms). */
  clock: () => number;
  log?: ConnectorLogger;
}

export async function syncPage(
  checks: readonly HttpCheck[],
  context: ConnectionContext,
  request: SyncRequest,
  runtime: ConnectorRuntime,
  options: HttpCheckSyncOptions,
): Promise<SyncResult> {
  const { now, clock, log } = options;
  const scope = scopeOf(
    context.connectionId,
    checks,
    credentialFingerprint(context.credentials),
  );

  const run = decode<RunState>(request.cursor, RUN_PREFIX);
  if (
    run &&
    run.v === 1 &&
    run.connection === context.connectionId &&
    run.scope === scope &&
    Array.isArray(run.checks) &&
    validStates(run.states) &&
    typeof run.at === "number" &&
    now() - run.at <= RUN_MAX_AGE_MS &&
    now() >= run.at
  ) {
    return finish(run);
  }

  // A new run. The previous states: the last finished run's, else those an
  // abandoned run of this connection had already carried forward.
  const done = decode<DoneState>(request.cursor, DONE_PREFIX);
  const previous: Record<string, CheckState> =
    done &&
    done.v === 1 &&
    done.connection === context.connectionId &&
    validStates(done.states)
      ? done.states
      : run &&
          run.v === 1 &&
          run.connection === context.connectionId &&
          validStates(run.states)
        ? run.states
        : {};

  const at = now();
  const checkedAt = new Date(at).toISOString();
  const results: ProbeResult[] = await pooled(checks, CONCURRENCY, (check) =>
    probe(check, runtime, clock),
  );

  const observations: Observation[] = [];
  const records: DatasetRecord[] = [];
  const states: Record<string, CheckState> = {};
  checks.forEach((check, index) => {
    const result = results[index]!;
    const fp = checkFingerprint(check);
    const before = Object.hasOwn(previous, check.id)
      ? previous[check.id]
      : undefined;
    const known = before !== undefined && before.fp === fp;
    // Since when the state holds: kept while it holds, now when it
    // changed, unknown when no earlier run of this check saw it begin.
    const since = known
      ? before.up === result.up
        ? before.since
        : checkedAt
      : null;
    states[check.id] = { fp, up: result.up, since };
    records.push(checkRecord(check, result, checkedAt, since));
    const dimensions = { resource: check.id };
    observations.push({
      metricKey: METRICS.up,
      sourceTimestamp: checkedAt,
      value: result.up ? 1 : 0,
      dimensions,
    });
    if (result.responseMs !== null) {
      observations.push({
        metricKey: METRICS.responseMs,
        sourceTimestamp: checkedAt,
        value: result.responseMs,
        dimensions: { ...dimensions },
      });
    }
  });
  const down = results.filter((result) => !result.up).length;
  log?.info("checks requested", { checks: checks.length, down });

  const state: RunState = {
    v: 1,
    connection: context.connectionId,
    scope,
    at,
    refresh: createHash("sha256")
      .update(`${context.connectionId}|${scope}|${at}`)
      .digest("hex")
      .slice(0, 32),
    checks: checks.map((check) => check.id),
    states,
  };
  // At most MAX_CHECKS rows of at most a few KiB: one page, far inside
  // ADR 0026's 1,000 rows and 1 MiB.
  const page: DatasetPage = {
    datasetKey: checksDataset.key,
    schemaVersion: checksDataset.version,
    refreshKey: `${state.refresh}:${checksDataset.key}`,
    pageKey: "p000001",
    previousPageKey: null,
    records,
    complete: false,
  };
  return {
    observations,
    datasetPages: [page],
    nextCursor: encode(RUN_PREFIX, state),
    done: false,
  };

  function finish(state: RunState): SyncResult {
    const freshness: FreshnessEntry[] = state.checks.map((id) => ({
      stream: CHECKS_STREAM,
      resource: id,
    }));
    const bounded = boundFreshness(freshness, state.checks);
    return {
      observations: [],
      datasetPages: [
        {
          datasetKey: checksDataset.key,
          schemaVersion: checksDataset.version,
          refreshKey: `${state.refresh}:${checksDataset.key}`,
          pageKey: "p000002",
          previousPageKey: "p000001",
          records: [],
          complete: true,
        },
      ],
      receivedDatasets: [checksDataset.key],
      ...(bounded.length > 0 ? { freshness: bounded } : {}),
      nextCursor: encode(DONE_PREFIX, {
        v: 1,
        connection: state.connection,
        states: state.states,
      } satisfies DoneState),
      done: true,
    };
  }
}
