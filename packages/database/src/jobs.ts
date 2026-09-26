import { and, eq, isNotNull, lte, sql } from "drizzle-orm";

import type { Db, Transaction } from "./context.js";
import * as schema from "./schema.js";

// Typed wrappers around the durable job queue (ADR 0006). Two calling
// classes, separated by database role rather than by API:
//
//  - App role (netrics_app): enqueueJob inside tenant transactions — the
//    domain write and the job commit atomically, and RLS scopes the row to
//    the caller's workspace.
//  - Scheduler role (netrics_scheduler): claimJobs / completeJob / failJob /
//    heartbeat / enqueueSyncJob. Claiming deliberately bypasses tenant
//    context (claim_jobs is SECURITY DEFINER under the migration role): the
//    scheduler claims across all workspaces by design and never sets
//    app.workspace_id. The scheduler role has no grant on connections, so it
//    can never read credential material while doing so.

export type Job = typeof schema.jobs.$inferSelect;

export interface EnqueueJobInput {
  kind: string;
  workspaceId: string;
  connectionId?: string | null;
  payload?: Record<string, unknown>;
  runAt?: Date;
  maxAttempts?: number;
  idempotencyKey?: string;
}

/**
 * Transactional enqueue on the app role: call inside withWorkspace() so the
 * domain write and the job commit in one transaction. The job's workspace and
 * connection identity are forced into the payload (milestone invariant: every
 * job carries both explicitly) — caller-supplied payload keys cannot override
 * them; the worker executor rejects rows whose payload disagrees with the
 * columns. Returns the new job id.
 */
export async function enqueueJob(
  tx: Transaction,
  job: EnqueueJobInput,
): Promise<string> {
  const rows = await tx
    .insert(schema.jobs)
    .values({
      kind: job.kind,
      workspaceId: job.workspaceId,
      connectionId: job.connectionId ?? null,
      payload: {
        ...(job.payload ?? {}),
        workspace_id: job.workspaceId,
        connection_id: job.connectionId ?? null,
      },
      ...(job.runAt ? { runAt: job.runAt } : {}),
      ...(job.maxAttempts !== undefined
        ? { maxAttempts: job.maxAttempts }
        : {}),
      ...(job.idempotencyKey ? { idempotencyKey: job.idempotencyKey } : {}),
    })
    .returning({ id: schema.jobs.id });
  const row = rows[0];
  if (!row) {
    throw new Error("enqueueJob returned no row");
  }
  return row.id;
}

function asDate(value: unknown): Date {
  // Raw function results bypass drizzle's column mapping; postgres.js returns
  // timestamptz as an ISO string.
  return value instanceof Date ? value : new Date(value as string);
}

function mapJobRow(row: Record<string, unknown>): Job {
  return {
    id: row.id as string,
    kind: row.kind as string,
    workspaceId: (row.workspace_id as string | null) ?? null,
    connectionId: (row.connection_id as string | null) ?? null,
    payload: row.payload,
    runAt: asDate(row.run_at),
    attempts: row.attempts as number,
    maxAttempts: row.max_attempts as number,
    status: row.status as string,
    lockedBy: (row.locked_by as string | null) ?? null,
    lockedAt: row.locked_at == null ? null : asDate(row.locked_at),
    lastError: (row.last_error as string | null) ?? null,
    idempotencyKey: (row.idempotency_key as string | null) ?? null,
    createdAt: asDate(row.created_at),
  };
}

/**
 * Atomically requeues stale running jobs (locked longer than
 * staleAfterSeconds — the worker crashed) and claims up to `limit` due jobs
 * for `workerId` via the claim_jobs() SQL function (migration 0006).
 * Per-connection serialization: at most one claimed/running connection.* job
 * per connection. Runs as the scheduler role and bypasses tenant context BY
 * DESIGN (the function is SECURITY DEFINER); never call this on an app-role
 * handle.
 */
export async function claimJobs(
  schedulerDb: Db,
  workerId: string,
  limit: number,
  staleAfterSeconds: number,
): Promise<Job[]> {
  const rows = await schedulerDb.execute(
    sql`select * from claim_jobs(
      ${workerId},
      ${limit},
      make_interval(secs => ${staleAfterSeconds})
    )`,
  );
  return rows.map((row) => mapJobRow(row));
}

/**
 * Marks a claimed job succeeded (scheduler role). Returns false when the job
 * was not running (e.g. already completed by another path) — callers should
 * treat that as worth logging, not as an error.
 */
export async function completeJob(
  schedulerDb: Db,
  jobId: string,
): Promise<boolean> {
  const rows = await schedulerDb.execute(
    sql`update jobs
        set status = 'succeeded', locked_by = null, locked_at = null
        where id = ${jobId}::uuid and status = 'running'
        returning id`,
  );
  return rows.length === 1;
}

export interface FailJobResult {
  status: string;
  attempts: number;
  runAt: Date;
}

/**
 * Fails a claimed job (scheduler role). Retryable failures increment attempts
 * and reschedule with exponential backoff (2^attempts * 15s, capped at 15
 * minutes); once attempts reach max_attempts — or immediately for
 * non-retryable failures — the job moves to dead for dead-letter visibility.
 * `error` lands in last_error verbatim: callers MUST pass an already-redacted
 * message (see redactSecrets in apps/server). Returns null when the job was
 * not running.
 */
export async function failJob(
  schedulerDb: Db,
  jobId: string,
  error: string,
  options: { retryable: boolean },
): Promise<FailJobResult | null> {
  const rows = await schedulerDb.execute(
    sql`update jobs
        set attempts = attempts + 1,
            status = case
              when ${options.retryable} and attempts + 1 < max_attempts
                then 'pending'
              else 'dead'
            end,
            run_at = case
              when ${options.retryable} and attempts + 1 < max_attempts
                then now() + least(
                  power(2, attempts + 1) * interval '15 seconds',
                  interval '15 minutes'
                )
              else run_at
            end,
            last_error = ${error},
            locked_by = null,
            locked_at = null
        where id = ${jobId}::uuid and status = 'running'
        returning status, attempts, run_at`,
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    status: row.status as string,
    attempts: row.attempts as number,
    runAt: asDate(row.run_at),
  };
}

/**
 * Idempotent enqueue for the scheduler (enqueue_sync_job SQL function,
 * migration 0006): ON CONFLICT on the idempotency key suppresses duplicates.
 * Returns the new job id, or null when a job with the key already exists.
 */
export async function enqueueSyncJob(
  schedulerDb: Db,
  job: {
    connectionId: string;
    workspaceId: string;
    kind: string;
    runAt: Date;
    idempotencyKey: string;
  },
): Promise<string | null> {
  const rows = await schedulerDb.execute(
    sql`select enqueue_sync_job(
      ${job.connectionId}::uuid,
      ${job.workspaceId}::uuid,
      ${job.kind},
      ${job.runAt.toISOString()}::timestamptz,
      ${job.idempotencyKey}
    ) as id`,
  );
  return (rows[0]?.id as string | null) ?? null;
}

export type DueConnection = Pick<
  typeof schema.connectionState.$inferSelect,
  | "connectionId"
  | "workspaceId"
  | "nextDueAt"
  | "pollIntervalSeconds"
  | "authState"
>;

/**
 * Connections due for a sync (scheduler role). Deliberately selects only the
 * columns covered by the scheduler's column-level grant — the scheduler role
 * has no access to connections or the credential-bearing columns.
 */
export async function listDueConnections(
  schedulerDb: Db,
  now: Date,
): Promise<DueConnection[]> {
  return schedulerDb
    .select({
      connectionId: schema.connectionState.connectionId,
      workspaceId: schema.connectionState.workspaceId,
      nextDueAt: schema.connectionState.nextDueAt,
      pollIntervalSeconds: schema.connectionState.pollIntervalSeconds,
      authState: schema.connectionState.authState,
    })
    .from(schema.connectionState)
    .where(
      and(
        isNotNull(schema.connectionState.nextDueAt),
        lte(schema.connectionState.nextDueAt, now),
      ),
    );
}

/**
 * Advances a connection's next_due_at (scheduler role; the only column it may
 * update on connection_state).
 */
export async function setConnectionNextDue(
  schedulerDb: Db,
  connectionId: string,
  nextDueAt: Date,
): Promise<void> {
  await schedulerDb
    .update(schema.connectionState)
    .set({ nextDueAt })
    .where(eq(schema.connectionState.connectionId, connectionId));
}

/**
 * Upserts this process's liveness row (scheduler role; used by both worker
 * and scheduler processes). started_at is kept from the first heartbeat of
 * the worker_id; metadata replaces the previous value.
 */
export async function heartbeat(
  schedulerDb: Db,
  workerId: string,
  role: "worker" | "scheduler",
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await schedulerDb
    .insert(schema.workerHeartbeats)
    .values({ workerId, role, metadata })
    .onConflictDoUpdate({
      target: schema.workerHeartbeats.workerId,
      set: { role, lastHeartbeatAt: new Date(), metadata },
    });
}
