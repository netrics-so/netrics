import { hostname } from "node:os";

import pino, { type Logger } from "pino";

import {
  createDatabase,
  createRawSqlClient,
  enqueueSyncJob,
  heartbeat,
  listDueConnections,
  setConnectionNextDue,
  type Database,
  type Sql,
} from "@netrics/database";

import type { Config } from "./env.js";

/**
 * Session-level advisory lock key for single-active-instance: exactly one
 * scheduler process holds it; contenders exit and let the platform restart
 * them (they become ready the moment the holder dies and the lock releases).
 */
export const SCHEDULER_LOCK_NAME = "netrics.scheduler";

export async function tryAcquireSchedulerLock(lockSql: Sql): Promise<boolean> {
  const rows = await lockSql`
    select pg_try_advisory_lock(hashtext(${SCHEDULER_LOCK_NAME})) as acquired
  `;
  return rows[0]?.acquired === true;
}

export interface SchedulerTickResult {
  /** Due connection_state rows seen. */
  scanned: number;
  /** Newly enqueued connection.sync jobs (dedup suppressed the rest). */
  enqueued: number;
  /** Due rows skipped because the connection's auth failed. */
  skippedAuthFailed: number;
}

/**
 * One planning tick: enqueue a connection.sync job for every due connection
 * and advance its next_due_at by poll_interval_seconds. Pure-ish and
 * loop-free so tests can call it directly.
 *
 * Idempotency: the key is `sync:<connection>:<hour bucket>`, so a crash
 * between enqueue and next_due_at advancement re-enqueues at most a deduped
 * no-op within the same hour. next_due_at advances even when the enqueue
 * dedupes (the job already exists; rescanning the row every tick would be
 * pointless). auth_failed connections are skipped entirely — credential
 * repair flows through the API, and the worker side owns re-enabling syncs.
 *
 * Runs as netrics_scheduler and reads ONLY connection_state (the scheduler
 * role has no grant on connections, so connector manifest lookups are
 * impossible by design; poll_interval_seconds is denormalized onto
 * connection_state at connection-creation time).
 */
export async function runSchedulerTick(
  schedulerDb: Database,
  now: Date = new Date(),
): Promise<SchedulerTickResult> {
  const due = await listDueConnections(schedulerDb, now);
  const hourBucket = new Date(now);
  hourBucket.setUTCMinutes(0, 0, 0);
  let enqueued = 0;
  let skippedAuthFailed = 0;
  for (const connection of due) {
    if (connection.authState === "auth_failed") {
      skippedAuthFailed += 1;
      continue;
    }
    const id = await enqueueSyncJob(schedulerDb, {
      connectionId: connection.connectionId,
      workspaceId: connection.workspaceId,
      kind: "connection.sync",
      runAt: now,
      idempotencyKey: `sync:${connection.connectionId}:${hourBucket.toISOString()}`,
    });
    if (id !== null) {
      enqueued += 1;
    }
    await setConnectionNextDue(
      schedulerDb,
      connection.connectionId,
      new Date(now.getTime() + connection.pollIntervalSeconds * 1000),
    );
  }
  return { scanned: due.length, enqueued, skippedAuthFailed };
}

export interface SchedulerDeps {
  schedulerDb: Database;
  /** Dedicated held connection for the advisory lock (max: 1). */
  lockSql: Sql;
  pollMs?: number;
  schedulerId?: string;
  logger?: Logger;
}

export interface SchedulerHandle {
  schedulerId: string;
  /** Returns false when another scheduler already holds the advisory lock. */
  start(): Promise<boolean>;
  stop(): Promise<void>;
}

export function createScheduler(deps: SchedulerDeps): SchedulerHandle {
  const logger = deps.logger ?? pino({ level: "silent" });
  const pollMs = deps.pollMs ?? 5000;
  const schedulerId =
    deps.schedulerId ?? `scheduler:${hostname()}:${process.pid}`;
  const { schedulerDb, lockSql } = deps;

  let running = false;
  let loopPromise: Promise<void> | null = null;

  async function loop(): Promise<void> {
    while (running) {
      try {
        await heartbeat(schedulerDb, schedulerId, "scheduler");
        const result = await runSchedulerTick(schedulerDb);
        if (result.enqueued > 0) {
          logger.info(result, "scheduler tick");
        }
      } catch (error) {
        logger.error(
          { err: error instanceof Error ? error.message : String(error) },
          "scheduler tick failed",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  return {
    schedulerId,
    async start() {
      if (running) {
        return true;
      }
      if (!(await tryAcquireSchedulerLock(lockSql))) {
        return false;
      }
      running = true;
      loopPromise = loop();
      return true;
    },
    async stop() {
      running = false;
      await loopPromise;
      // Closing the lock connection releases the session-level advisory lock.
      await lockSql.end({ timeout: 5 }).catch(() => undefined);
    },
  };
}

/** Process entry for NETRICS_ROLE=scheduler (called from src/index.ts). */
export async function startScheduler(config: Config): Promise<void> {
  const logger = pino({
    level: config.logLevel,
    base: { service: "netrics-server", role: config.role },
  });
  const schedulerDb = createDatabase(config.databaseSchedulerUrl);
  const lockSql = createRawSqlClient(config.databaseSchedulerUrl, { max: 1 });
  const scheduler = createScheduler({
    schedulerDb,
    lockSql,
    pollMs: config.schedulerPollMs,
    logger,
  });
  if (!(await scheduler.start())) {
    logger.error("another scheduler instance holds the advisory lock; exiting");
    process.exit(1);
  }
  logger.info(
    {
      schedulerId: scheduler.schedulerId,
      pollMs: config.schedulerPollMs,
      version: config.version,
      commit: config.commit,
    },
    "scheduler started",
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void scheduler.stop().then(() => process.exit(0));
    });
  }
}
