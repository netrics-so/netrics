import { and, eq, inArray, max } from "drizzle-orm";

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
 * - The state row is locked, so concurrent callers decide one at a time.
 * - Nothing is queued while a backfill of the connection waits or runs: it
 *   records the current datasets when it succeeds.
 * - The datasets an automatic backfill was queued for are recorded, and the
 *   same set is not queued again: a backfill that keeps failing is not
 *   retried on every sync (the connection page offers "Reload history").
 * - At most one backfill per workspace at a time is queued this way
 *   (`workspace_busy`): connections of a workspace often share one
 *   provider key and its rate limit (ADR 0014), and a connector update
 *   reaches every connection at once. The next incremental run asks again.
 *
 * Audited as connection.backfill_requested without an actor, with the
 * reason `dataset_added` (a dataset the record lacks) or `dataset_changed`
 * (recorded at another schema version).
 */
export async function queueDatasetBackfill(
  tx: Transaction,
  input: {
    workspaceId: string;
    connectionId: string;
    connectorId: string;
    declared: DatasetVersions;
  },
): Promise<DatasetBackfillOutcome> {
  const { workspaceId, connectionId, connectorId, declared } = input;
  const [state] = await tx
    .select({
      backfilled: schema.connectionState.backfilledDatasets,
      requested: schema.connectionState.backfillRequestedDatasets,
    })
    .from(schema.connectionState)
    .where(
      and(
        eq(schema.connectionState.workspaceId, workspaceId),
        eq(schema.connectionState.connectionId, connectionId),
      ),
    )
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
      .where(
        and(
          eq(schema.connectionState.workspaceId, workspaceId),
          eq(schema.connectionState.connectionId, connectionId),
        ),
      );
  }
  const missing = datasetsMissingBackfill(declared, backfilled);
  if (missing.length === 0) {
    return { queued: false, reason: "complete", datasets: [] };
  }
  const requested = state.requested ?? {};
  if (missing.every((key) => requested[key] === declared[key])) {
    return { queued: false, reason: "already_requested", datasets: missing };
  }
  const active = await tx
    .select({ connectionId: schema.jobs.connectionId })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.workspaceId, workspaceId),
        eq(schema.jobs.kind, "connection.backfill"),
        inArray(schema.jobs.status, [...ACTIVE_BACKFILL]),
      ),
    );
  if (active.some((row) => row.connectionId === connectionId)) {
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
    .set({ backfillRequestedDatasets: declared })
    .where(
      and(
        eq(schema.connectionState.workspaceId, workspaceId),
        eq(schema.connectionState.connectionId, connectionId),
      ),
    );
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
