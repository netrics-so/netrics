import { and, eq, inArray, max, sql } from "drizzle-orm";

import type { Transaction } from "./context.js";
import { insertAuditEvent } from "./workspaces.js";
import { requestConnectionBackfill } from "./jobs.js";
import * as schema from "./schema.js";

// Which of a connector's datasets a connection's backfill has read (#617).
// A connector update can add a dataset, or change one's schema version; an
// existing connection then fills it from incremental runs only, so its
// history starts at the deploy. The sync engine records what each succeeded
// backfill read (connection_state.backfilled_datasets) and, after a
// succeeded incremental run, queues one backfill when the connector declares
// a dataset the record lacks. App role, inside the caller's withWorkspace().

/** Dataset key -> schema version. */
export type DatasetVersions = Record<string, number>;

/** The datasets of a manifest as a version map. */
export function datasetVersions(
  datasets: ReadonlyArray<{ key: string; version: number }> | undefined,
): DatasetVersions {
  return Object.fromEntries((datasets ?? []).map((d) => [d.key, d.version]));
}

/** Declared datasets the record does not cover at their declared version. */
export function datasetsMissingBackfill(
  declared: DatasetVersions,
  backfilled: DatasetVersions,
): string[] {
  return Object.keys(declared)
    .filter((key) => backfilled[key] !== declared[key])
    .sort();
}

/** Connection jobs that fill history: a backfill waiting or running. */
const ACTIVE_BACKFILL = ["pending", "running", "continuing"] as const;

/**
 * The state of the connection's backfill: "queued" while one waits (or
 * waits to continue), "running" while a worker holds it, else "idle".
 */
export async function connectionBackfillState(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
): Promise<"idle" | "queued" | "running"> {
  const rows = await tx
    .select({ status: schema.jobs.status })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.workspaceId, workspaceId),
        eq(schema.jobs.connectionId, connectionId),
        eq(schema.jobs.kind, "connection.backfill"),
        inArray(schema.jobs.status, [...ACTIVE_BACKFILL]),
      ),
    );
  if (rows.some((row) => row.status === "running")) return "running";
  return rows.length > 0 ? "queued" : "idle";
}

/**
 * The record for a connection from before #617 (backfilled_datasets null),
 * derived from what is stored. A declared dataset counts as backfilled when
 * a succeeded backfill run finished after its declared schema version was
 * registered for the connection: that run read the whole window into it.
 * A dataset registered at that version only later (by an incremental run),
 * or never at that version while the dataset exists, does not count. A
 * dataset the connection has never stored counts: there is no partial
 * history to show, and the next backfill records it anyway.
 *
 * Sync runs are pruned after 90 days (each connection's latest is kept),
 * so a connection whose last backfill is older counts its stored datasets as
 * not backfilled: one backfill too many rather than a silent gap.
 *
 * Only a whole job writes a "succeeded" backfill run: a segment that hands
 * over to a continuation writes "continued", a failed attempt "failed"
 * (sync engine), so the latest succeeded run is the end of a completed job.
 */
export async function deriveBackfilledDatasets(
  tx: Transaction,
  input: {
    workspaceId: string;
    connectionId: string;
    declared: DatasetVersions;
  },
): Promise<DatasetVersions> {
  const { workspaceId, connectionId, declared } = input;
  const keys = Object.keys(declared);
  if (keys.length === 0) return {};
  const [backfill] = await tx
    .select({ finishedAt: max(schema.syncRuns.finishedAt) })
    .from(schema.syncRuns)
    .where(
      and(
        eq(schema.syncRuns.workspaceId, workspaceId),
        eq(schema.syncRuns.connectionId, connectionId),
        eq(schema.syncRuns.mode, "backfill"),
        eq(schema.syncRuns.status, "succeeded"),
      ),
    );
  const lastBackfill = backfill?.finishedAt ?? null;
  const stored = await tx
    .select({
      key: schema.dataDatasets.key,
      version: schema.dataSchemaVersions.version,
      registeredAt: schema.dataSchemaVersions.createdAt,
    })
    .from(schema.dataDatasets)
    .leftJoin(
      schema.dataSchemaVersions,
      and(
        eq(schema.dataSchemaVersions.workspaceId, workspaceId),
        eq(schema.dataSchemaVersions.datasetId, schema.dataDatasets.id),
      ),
    )
    .where(
      and(
        eq(schema.dataDatasets.workspaceId, workspaceId),
        eq(schema.dataDatasets.connectionId, connectionId),
        eq(schema.dataDatasets.kind, "source"),
        inArray(schema.dataDatasets.key, keys),
      ),
    );
  const covered: DatasetVersions = {};
  for (const key of keys) {
    const version = declared[key]!;
    const rows = stored.filter((row) => row.key === key);
    if (rows.length === 0) {
      covered[key] = version;
      continue;
    }
    const registered = rows.find((row) => row.version === version);
    if (
      registered?.registeredAt &&
      lastBackfill &&
      registered.registeredAt.getTime() <= lastBackfill.getTime()
    ) {
      covered[key] = version;
    }
  }
  return covered;
}

/**
 * Automatic backfills of one set of datasets (#617): the first, and one
 * retry once AUTOMATIC_BACKFILL_RETRY_MS has passed, e.g. after the first
 * failed or ran on a worker that did not declare the datasets yet. After
 * that, only "Reload history" (or the operator) queues another.
 */
export const AUTOMATIC_BACKFILLS_PER_SET = 2;
export const AUTOMATIC_BACKFILL_RETRY_MS = 24 * 60 * 60 * 1000;

/** The entries of `a` that `b` declares at the same version. */
export function intersectDatasetVersions(
  a: DatasetVersions,
  b: DatasetVersions,
): DatasetVersions {
  return Object.fromEntries(
    Object.entries(a).filter(([key, version]) => b[key] === version),
  );
}

/**
 * Serializes the decision to queue a backfill within a workspace (#617):
 * the one-backfill-per-workspace rule holds across API and worker
 * replicas. Transaction-scoped; the caller's transaction must read the
 * jobs after taking it (read committed, the withWorkspace() default).
 * Callers lock their connection_state row first, then this.
 */
export async function lockWorkspaceBackfills(
  tx: Transaction,
  workspaceId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId}::uuid::text, 617))`,
  );
}

/** Connections of the workspace with a backfill waiting or running. */
export async function activeBackfillConnections(
  tx: Transaction,
  workspaceId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ connectionId: schema.jobs.connectionId })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.workspaceId, workspaceId),
        eq(schema.jobs.kind, "connection.backfill"),
        inArray(schema.jobs.status, [...ACTIVE_BACKFILL]),
      ),
    );
  return rows.flatMap((row) => (row.connectionId ? [row.connectionId] : []));
}

export type DatasetBackfillOutcome =
  | { queued: true; jobId: string; datasets: string[] }
  | {
      queued: false;
      reason:
        | "complete"
        | "already_requested"
        | "backfill_active"
        | "workspace_busy"
        | "no_state";
      datasets: string[];
    };

/**
 * After a succeeded incremental run: queues one backfill when the connector
 * declares datasets the connection's backfills have not read (#617).
 *
 * - The state row is locked, then the workspace's backfill lock, so
 *   concurrent callers (also on other replicas) decide one at a time.
 * - Nothing is queued while a backfill of the connection waits or runs: it
 *   records what it read when it succeeds.
 * - At most one backfill per workspace waits or runs because of this
 *   (`workspace_busy`): connections of a workspace often share one
 *   provider key and its rate limit (ADR 0014), and a connector update
 *   reaches every connection at once. The next incremental run asks again.
 *   Provider quotas shared across workspaces are not covered.
 * - The datasets queued for are recorded with the time and a count. The
 *   same set is queued again once, a day later (the first backfill failed,
 *   or ran on a worker without them), then no more: no retry on every
 *   sync. The connection page offers "Reload history".
 *
 * Audited as connection.backfill_requested without an actor, with the
 * reason `dataset_added` (a dataset the record lacks) or `dataset_changed`
 * (recorded at another schema version), and `retry` for the second.
 */
export async function queueDatasetBackfill(
  tx: Transaction,
  input: {
    workspaceId: string;
    connectionId: string;
    connectorId: string;
    declared: DatasetVersions;
    now?: Date;
  },
): Promise<DatasetBackfillOutcome> {
  const { workspaceId, connectionId, connectorId, declared } = input;
  const now = input.now ?? new Date();
  const scope = and(
    eq(schema.connectionState.workspaceId, workspaceId),
    eq(schema.connectionState.connectionId, connectionId),
  );
  const [state] = await tx
    .select({
      backfilled: schema.connectionState.backfilledDatasets,
      requested: schema.connectionState.backfillRequestedDatasets,
      requestedAt: schema.connectionState.backfillRequestedAt,
      requestCount: schema.connectionState.backfillRequestCount,
    })
    .from(schema.connectionState)
    .where(scope)
    .for("update");
  if (!state) return { queued: false, reason: "no_state", datasets: [] };
  let backfilled = state.backfilled;
  if (backfilled === null) {
    backfilled = await deriveBackfilledDatasets(tx, {
      workspaceId,
      connectionId,
      declared,
    });
    await tx
      .update(schema.connectionState)
      .set({ backfilledDatasets: backfilled })
      .where(scope);
  }
  const missing = datasetsMissingBackfill(declared, backfilled);
  if (missing.length === 0) {
    return { queued: false, reason: "complete", datasets: [] };
  }
  const requested = state.requested ?? {};
  const retry = missing.every((key) => requested[key] === declared[key]);
  if (
    retry &&
    (state.requestCount >= AUTOMATIC_BACKFILLS_PER_SET ||
      (state.requestedAt !== null &&
        now.getTime() - state.requestedAt.getTime() <
          AUTOMATIC_BACKFILL_RETRY_MS))
  ) {
    return { queued: false, reason: "already_requested", datasets: missing };
  }
  await lockWorkspaceBackfills(tx, workspaceId);
  const active = await activeBackfillConnections(tx, workspaceId);
  if (active.includes(connectionId)) {
    return { queued: false, reason: "backfill_active", datasets: missing };
  }
  if (active.length > 0) {
    return { queued: false, reason: "workspace_busy", datasets: missing };
  }
  const jobId = await requestConnectionBackfill(tx, {
    workspaceId,
    connectionId,
  });
  await tx
    .update(schema.connectionState)
    .set({
      backfillRequestedDatasets: declared,
      backfillRequestedAt: now,
      backfillRequestCount: retry ? state.requestCount + 1 : 1,
    })
    .where(scope);
  const changed = missing.some((key) => backfilled[key] !== undefined);
  await insertAuditEvent(tx, {
    workspaceId,
    actorUserId: null,
    action: "connection.backfill_requested",
    target: connectionId,
    metadata: {
      connectorId,
      by: "system",
      reason: changed ? "dataset_changed" : "dataset_added",
      datasets: missing,
      jobId,
      ...(retry ? { retry: true } : {}),
    },
  });
  return { queued: true, jobId, datasets: missing };
}

/**
 * Locks the connection's state row for a "Reload history" request (#617)
 * and answers when the last one was made; undefined without a state row.
 */
export async function lockHistoryReload(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
): Promise<{ requestedAt: Date | null } | undefined> {
  const [state] = await tx
    .select({ requestedAt: schema.connectionState.historyReloadRequestedAt })
    .from(schema.connectionState)
    .where(
      and(
        eq(schema.connectionState.workspaceId, workspaceId),
        eq(schema.connectionState.connectionId, connectionId),
      ),
    )
    .for("update");
  return state;
}

/** Records when a member asked to reload the history (#617). */
export async function markHistoryReloadRequested(
  tx: Transaction,
  input: { workspaceId: string; connectionId: string; at: Date },
): Promise<void> {
  await tx
    .update(schema.connectionState)
    .set({ historyReloadRequestedAt: input.at })
    .where(
      and(
        eq(schema.connectionState.workspaceId, input.workspaceId),
        eq(schema.connectionState.connectionId, input.connectionId),
      ),
    );
}
