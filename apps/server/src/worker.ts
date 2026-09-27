import { hostname } from "node:os";

import pino, { type Logger } from "pino";

import {
  claimJobs,
  completeJob,
  createDatabase,
  failJob,
  heartbeat,
  withWorkspace,
  type Database,
  type Job,
} from "@netrics/database";

import { redactSecrets } from "./credentials.js";
import type { Config } from "./env.js";
import {
  createJobHandlers,
  NonRetryableJobError,
  type JobHandler,
} from "./jobs/handlers.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** last_error is persisted verbatim — keep it short and credential-free. */
function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return String(redactSecrets(message)).slice(0, 500);
}

/**
 * Executor-level tampering guard (milestone invariant: every job carries its
 * workspace/connection identity in BOTH the columns and the payload; the two
 * must agree). A mismatch means the payload was forged or corrupted, so the
 * job is dead-lettered as a contract error without ever touching tenant data.
 */
function payloadIdentityMatches(job: Job): boolean {
  const payload = job.payload;
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return false;
  }
  const record = payload as Record<string, unknown>;
  return (
    record.workspace_id === job.workspaceId &&
    record.connection_id === job.connectionId
  );
}

export interface WorkerDeps {
  /** Scheduler-role handle: claim/complete/fail/heartbeat. */
  schedulerDb: Database;
  /** App-role handle: tenant work, only inside withWorkspace. */
  appDb: Database;
  handlers?: Record<string, JobHandler>;
  workerId?: string;
  concurrency?: number;
  /** Idle sleep between claim attempts. */
  pollMs?: number;
  /** Running jobs locked longer than this are reclaimed (worker crash). */
  staleAfterSeconds?: number;
  heartbeatMs?: number;
  /** Grace period for in-flight jobs on stop(). */
  shutdownTimeoutMs?: number;
  logger?: Logger;
}

export interface WorkerHandle {
  workerId: string;
  start(): Promise<void>;
  /** Stops claiming, then waits up to shutdownTimeoutMs for in-flight jobs. */
  stop(): Promise<void>;
}

export function createWorker(deps: WorkerDeps): WorkerHandle {
  const logger = deps.logger ?? pino({ level: "silent" });
  const handlers = deps.handlers ?? createJobHandlers();
  const workerId = deps.workerId ?? `worker:${hostname()}:${process.pid}`;
  const concurrency = deps.concurrency ?? 4;
  const pollMs = deps.pollMs ?? 1000;
  const staleAfterSeconds = deps.staleAfterSeconds ?? 300;
  const heartbeatMs = deps.heartbeatMs ?? 5000;
  const shutdownTimeoutMs = deps.shutdownTimeoutMs ?? 30_000;

  const { schedulerDb, appDb } = deps;
  const inFlight = new Set<Promise<void>>();
  let running = false;
  let loopPromise: Promise<void> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  async function executeJob(job: Job): Promise<void> {
    const jobLogger = logger.child({
      jobId: job.id,
      kind: job.kind,
      workspaceId: job.workspaceId,
    });
    try {
      if (!payloadIdentityMatches(job)) {
        await failJob(
          schedulerDb,
          job.id,
          "contract: payload workspace_id/connection_id mismatch",
          { retryable: false },
        );
        jobLogger.error("job rejected: payload identity mismatch");
        return;
      }
      const handler = handlers[job.kind];
      if (!handler) {
        await failJob(
          schedulerDb,
          job.id,
          `contract: unknown job kind ${JSON.stringify(job.kind)}`,
          { retryable: false },
        );
        jobLogger.error("job rejected: unknown kind");
        return;
      }
      const ctx = { job, appDb, schedulerDb, logger: jobLogger };
      // Tenant work runs as netrics_app inside the job's workspace context;
      // installation-level jobs (workspace_id NULL) run without one.
      if (job.workspaceId) {
        await withWorkspace(appDb, { workspaceId: job.workspaceId }, (tx) =>
          handler({ ...ctx, tx }),
        );
      } else {
        await handler(ctx);
      }
      await completeJob(schedulerDb, job.id);
      jobLogger.info({ attempts: job.attempts }, "job succeeded");
    } catch (error) {
      const retryable = !(error instanceof NonRetryableJobError);
      try {
        const result = await failJob(
          schedulerDb,
          job.id,
          safeErrorMessage(error),
          { retryable },
        );
        jobLogger.warn({ retryable, status: result?.status }, "job failed");
      } catch (failError) {
        jobLogger.error(
          { err: safeErrorMessage(failError) },
          "failed to record job failure",
        );
      }
    }
  }

  async function tick(): Promise<number> {
    const capacity = concurrency - inFlight.size;
    if (capacity <= 0) {
      return -1;
    }
    const jobs = await claimJobs(
      schedulerDb,
      workerId,
      capacity,
      staleAfterSeconds,
    );
    for (const job of jobs) {
      const promise = executeJob(job).finally(() => {
        inFlight.delete(promise);
      });
      inFlight.add(promise);
    }
    return jobs.length;
  }

  async function loop(): Promise<void> {
    while (running) {
      let claimed = 0;
      try {
        claimed = await tick();
      } catch (error) {
        logger.error({ err: safeErrorMessage(error) }, "claim tick failed");
      }
      if (claimed <= 0) {
        await sleep(pollMs);
      }
    }
  }

  async function beat(): Promise<void> {
    await heartbeat(schedulerDb, workerId, "worker", {
      pid: process.pid,
      concurrency,
    });
  }

  return {
    workerId,
    async start() {
      if (running) {
        return;
      }
      running = true;
      await beat();
      heartbeatTimer = setInterval(() => {
        beat().catch((error: unknown) =>
          logger.warn({ err: safeErrorMessage(error) }, "heartbeat failed"),
        );
      }, heartbeatMs);
      loopPromise = loop();
    },
    async stop() {
      running = false;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      await loopPromise;
      const drained = Promise.allSettled([...inFlight]).then(
        () => "drained" as const,
      );
      const timedOut = sleep(shutdownTimeoutMs).then(() => "timeout" as const);
      const outcome = await Promise.race([drained, timedOut]);
      if (outcome === "timeout") {
        logger.warn(
          { inFlight: inFlight.size },
          "shutdown timeout: abandoned jobs will be reclaimed as stale",
        );
      }
    },
  };
}

/** Process entry for NETRICS_ROLE=worker (called from src/index.ts). */
export async function startWorker(config: Config): Promise<void> {
  const logger = pino({
    level: config.logLevel,
    base: { service: "netrics-server", role: config.role },
  });
  // Two pools on purpose: the scheduler role claims/advances jobs; the app
  // role executes tenant work inside withWorkspace() (RLS-enforced). The
  // worker never reads credentials through the scheduler pool.
  const schedulerDb = createDatabase(config.databaseSchedulerUrl);
  const appDb = createDatabase(config.databaseUrl);
  const worker = createWorker({
    schedulerDb,
    appDb,
    concurrency: config.workerConcurrency,
    pollMs: config.workerPollMs,
    logger,
  });
  await worker.start();
  logger.info(
    {
      workerId: worker.workerId,
      concurrency: config.workerConcurrency,
      version: config.version,
      commit: config.commit,
    },
    "worker started",
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void worker.stop().then(() => process.exit(0));
    });
  }
}
