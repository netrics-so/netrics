import { hostname } from "node:os";

import pino, { type Logger } from "pino";

import { sql } from "drizzle-orm";

import {
  createDatabase,
  DEFAULT_RETENTION,
  enqueueSyncJob,
  heartbeat,
  listDueConnections,
  pruneHistory,
  pruneOAuthAuthorizations,
  pruneSecurityRecords,
  SECURITY_RETENTION,
  setConnectionNextDue,
  type Database,
  type RetentionPolicy,
  type SecurityRetentionPolicy,
} from "@netrics/database";

import type { Config } from "./env.js";
import { ecbHttp, type RatesHttp } from "./exchange-rates/ecb.js";
import {
  createExchangeRateJob,
  type ExchangeRateJob,
} from "./exchange-rates/job.js";

/**
 * Advisory lock taken for the duration of each planning tick. It is
 * transaction-scoped, so it cannot outlive or silently lose its connection
 * (a session lock on a pooled connection disappears when the pool recycles
 * it). A second scheduler instance simply skips ticks while one is running;
 * planning itself is idempotent.
 */
export const SCHEDULER_LOCK_NAME = "netrics.scheduler";

export interface SchedulerTickResult {
  /** False when another scheduler instance was mid-tick; nothing was done. */
  ran: boolean;
  /** Due connection_state rows seen. */
  scanned: number;
  /** Newly enqueued connection.sync jobs (dedup suppressed the rest). */
  enqueued: number;
  /** Due rows skipped because the connection's auth failed. */
  skippedAuthFailed: number;
  /** Due rows skipped because an OAuth grant needs reauthorization. */
  skippedNeedsReauthorization: number;
}

/**
 * One planning tick: enqueue a connection.sync job for every due connection
 * and advance its next_due_at by poll_interval_seconds.
 *
 * Deduplication, both enforced in the database:
 * - The idempotency key is `sync:<connection>:<next_due_at>`, i.e. one job
 *   per due slot. A crash between enqueue and next_due_at advancement
 *   re-plans the same slot and dedupes to a no-op.
 * - At most one sync waits per connection (jobs_one_pending_sync), so an
 *   outage of the workers never builds a backlog of identical syncs.
 * next_due_at advances even when the enqueue dedupes. auth_failed and
 * needs_reauthorization connections are skipped entirely: credential repair
 * and reauthorization (ADR 0012) flow through the API.
 *
 * Runs as netrics_scheduler and reads ONLY connection_state (the scheduler
 * role has no grant on connections; poll_interval_seconds is denormalized
 * onto connection_state at connection-creation time).
 */
export async function runSchedulerTick(
  schedulerDb: Database,
  now: Date = new Date(),
): Promise<SchedulerTickResult> {
  return schedulerDb.transaction(async (tx) => {
    const [lock] = await tx.execute<{ acquired: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext(${SCHEDULER_LOCK_NAME})) as acquired`,
    );
    if (!lock?.acquired) {
      return {
        ran: false,
        scanned: 0,
        enqueued: 0,
        skippedAuthFailed: 0,
        skippedNeedsReauthorization: 0,
      };
    }
    const due = await listDueConnections(tx, now);
    let enqueued = 0;
    let skippedAuthFailed = 0;
    let skippedNeedsReauthorization = 0;
    for (const connection of due) {
      if (connection.authState === "auth_failed") {
        skippedAuthFailed += 1;
        continue;
      }
      if (connection.authState === "needs_reauthorization") {
        skippedNeedsReauthorization += 1;
        continue;
      }
      const id = await enqueueSyncJob(tx, {
        connectionId: connection.connectionId,
        workspaceId: connection.workspaceId,
        kind: "connection.sync",
        runAt: now,
        idempotencyKey: `sync:${connection.connectionId}:${connection.nextDueAt!.toISOString()}`,
      });
      if (id !== null) {
        enqueued += 1;
      }
      await setConnectionNextDue(
        tx,
        connection.connectionId,
        new Date(now.getTime() + connection.pollIntervalSeconds * 1000),
      );
    }
    return {
      ran: true,
      scanned: due.length,
      enqueued,
      skippedAuthFailed,
      skippedNeedsReauthorization,
    };
  });
}

export interface SchedulerDeps {
  schedulerDb: Database;
  pollMs?: number;
  /** How often to prune finished jobs and sync runs (default: hourly). */
  maintenanceEveryMs?: number;
  retention?: RetentionPolicy;
  /** Retention of audit events, sessions and rate-limit rows (IPs). */
  securityRetention?: SecurityRetentionPolicy;
  /** Clock for security-record retention (tests pin it). */
  now?: () => Date;
  schedulerId?: string;
  logger?: Logger;
  /**
   * The ECB rate job (#191); absent with NETRICS_EXCHANGE_RATES=off, and
   * then the scheduler makes no request to the ECB.
   */
  exchangeRates?: ExchangeRateJob;
}

export interface SchedulerHandle {
  schedulerId: string;
  start(): void;
  stop(): Promise<void>;
}

export function createScheduler(deps: SchedulerDeps): SchedulerHandle {
  const logger = deps.logger ?? pino({ level: "silent" });
  const pollMs = deps.pollMs ?? 5000;
  const schedulerId =
    deps.schedulerId ?? `scheduler:${hostname()}:${process.pid}`;
  const { schedulerDb } = deps;

  const maintenanceEveryMs = deps.maintenanceEveryMs ?? 60 * 60 * 1000;
  const now = deps.now ?? (() => new Date());

  let running = false;
  let loopPromise: Promise<void> | null = null;
  let lastMaintenance = 0;

  // History retention (DEFAULT_RETENTION in @netrics/database). Deletes are
  // bounded per call and idempotent, so a second scheduler doing the same is
  // harmless.
  async function maintain(): Promise<void> {
    if (Date.now() - lastMaintenance < maintenanceEveryMs) {
      return;
    }
    lastMaintenance = Date.now();
    const result = await pruneHistory(schedulerDb, deps.retention);
    if (result.jobsDeleted > 0 || result.syncRunsDeleted > 0) {
      logger.info(result, "pruned finished history");
    }
    // OAuth authorizations live 10 minutes and work once (ADR 0012).
    const oauthAuthorizationsDeleted = await pruneOAuthAuthorizations(
      schedulerDb,
      (deps.retention ?? DEFAULT_RETENTION).batch,
    );
    if (oauthAuthorizationsDeleted > 0) {
      logger.info(
        { oauthAuthorizationsDeleted },
        "pruned finished oauth authorizations",
      );
    }
    // Audit events after 12 months; expired sessions, rate-limit counters and
    // pairings soon after (privacy policy; SECURITY_RETENTION).
    const security = await pruneSecurityRecords(
      schedulerDb,
      now(),
      deps.securityRetention ?? SECURITY_RETENTION,
    );
    if (Object.values(security).some((count) => count > 0)) {
      logger.info(security, "pruned security records");
    }
  }

  async function loop(): Promise<void> {
    while (running) {
      try {
        await heartbeat(schedulerDb, schedulerId, "scheduler");
        const result = await runSchedulerTick(schedulerDb);
        if (result.enqueued > 0) {
          logger.info(result, "scheduler tick");
        }
        await maintain();
        // Starts a fetch in the background when one is due.
        deps.exchangeRates?.tick();
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
    start() {
      if (running) {
        return;
      }
      running = true;
      loopPromise = loop();
    },
    async stop() {
      running = false;
      await loopPromise;
      await deps.exchangeRates?.idle();
    },
  };
}

/**
 * The rate job for this configuration: none with
 * NETRICS_EXCHANGE_RATES=off, so the scheduler never contacts the ECB.
 */
export function exchangeRateJobFor(
  config: Pick<Config, "exchangeRates">,
  schedulerDb: Database,
  logger: Logger,
  http: RatesHttp = ecbHttp,
): { exchangeRates?: ExchangeRateJob } {
  return config.exchangeRates
    ? {
        exchangeRates: createExchangeRateJob({ db: schedulerDb, http, logger }),
      }
    : {};
}

/** Process entry for NETRICS_ROLE=scheduler (called from src/index.ts). */
export async function startScheduler(config: Config): Promise<void> {
  const logger = pino({
    level: config.logLevel,
    base: { service: "netrics-server", role: config.role },
  });
  const schedulerDb = createDatabase(config.databaseSchedulerUrl);
  const scheduler = createScheduler({
    schedulerDb,
    pollMs: config.schedulerPollMs,
    logger,
    ...exchangeRateJobFor(config, schedulerDb, logger),
  });
  scheduler.start();
  logger.info(
    {
      schedulerId: scheduler.schedulerId,
      pollMs: config.schedulerPollMs,
      exchangeRates: config.exchangeRates ? "ecb" : "off",
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
