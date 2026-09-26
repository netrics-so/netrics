import type { Database, Job, Transaction } from "@netrics/database";
import type { ConnectorRegistry } from "@netrics/connector-runtime";
import type { Logger } from "pino";

import { createSyncJobHandlers } from "../sync/engine.js";

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
 * fail the job retryably; throw NonRetryableJobError to dead-letter
 * immediately; throw TerminalJobError to end the job as 'failed' without
 * retries or dead-lettering.
 */
export type JobHandler = (ctx: JobHandlerContext) => Promise<void>;

/**
 * Throw from a handler for permanent (contract-class) failures: the job goes
 * straight to dead without consuming retries.
 */
export class NonRetryableJobError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NonRetryableJobError";
  }
}

/**
 * Throw from a handler for terminal domain failures that must neither retry
 * nor pollute the dead-letter queue (e.g. rejected credentials: only a user
 * action can repair them, and sync_runs/connection_state already carry the
 * actionable detail). The job ends in status 'failed'.
 */
export class TerminalJobError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TerminalJobError";
  }
}

/** Test/health handler: claims and completes without touching tenant data. */
const noopHandler: JobHandler = async () => {};

export interface JobHandlerDeps {
  /** The reviewed connector bundle of this deployment. */
  registry: ConnectorRegistry;
  /** Instance master key for decrypting connection credentials. */
  appEncryptionKey: string;
}

/**
 * Built-in job handlers by job kind. Without deps only the noop handler is
 * registered (unit tests); with deps the connection sync engine handles
 * "connection.sync" (incremental) and "connection.backfill". Unknown kinds
 * are dead-lettered as contract errors by the worker.
 */
export function createJobHandlers(
  deps?: JobHandlerDeps,
): Record<string, JobHandler> {
  const handlers: Record<string, JobHandler> = {
    "netrics.noop": noopHandler,
  };
  if (deps) {
    Object.assign(handlers, createSyncJobHandlers(deps));
  }
  return handlers;
}
