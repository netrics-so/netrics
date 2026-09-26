import type { Database, Job, Transaction } from "@netrics/database";
import type { Logger } from "pino";

export interface JobHandlerContext {
  /** The claimed job (status running, locked to this worker). */
  job: Job;
  /** App-role handle — only ever used inside a tenant context. */
  appDb: Database;
  /** Scheduler-role handle (claim/complete/fail/heartbeat). */
  schedulerDb: Database;
  logger: Logger;
  /**
   * RLS-scoped tenant transaction for the job's workspace; present iff the
   * job carries a workspace_id. Handlers doing tenant work must use this
   * handle so RLS applies.
   */
  tx?: Transaction;
}

/**
 * A job handler. Handlers must be idempotent: the queue is at-least-once
 * (ADR 0006), so a crashed attempt may be replayed from the top. Throw to
 * fail the job; throw NonRetryableJobError to dead-letter immediately.
 */
export type JobHandler = (ctx: JobHandlerContext) => Promise<void>;

/**
 * Throw from a handler for permanent (contract/auth-class) failures: the job
 * goes straight to dead without consuming retries.
 */
export class NonRetryableJobError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NonRetryableJobError";
  }
}

/** Test/health handler: claims and completes without touching tenant data. */
const noopHandler: JobHandler = async () => {};

/**
 * Built-in job handlers by job kind. Milestone 03 slice 4 registers the real
 * "connection.sync" handler here; unknown kinds are dead-lettered as contract
 * errors by the worker.
 */
export function createJobHandlers(): Record<string, JobHandler> {
  return {
    "netrics.noop": noopHandler,
  };
}
