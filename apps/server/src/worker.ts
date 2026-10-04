import { hostname } from "node:os";

import pino, { type Logger } from "pino";

import { logSerializers } from "./log-serializers.js";

import { createDefaultRegistry } from "./connectors.js";
import {
  claimJobs,
  completeJob,
  createDatabase,
  failJob,
  heartbeat,
  renewJobLease,
  type Database,
  type Job,
} from "@netrics/database";

import { createCredentialKeyring, redactSecrets } from "./credentials.js";
import type { Config } from "./env.js";
import { createOAuthProviders } from "./oauth/config.js";
import { createOAuthTokenService } from "./oauth/tokens.js";
import {
  createJobHandlers,
  NonRetryableJobError,
  TerminalJobError,
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

  /**
   * Keeps the job's lease fresh while its handler runs, so a long job is not
   * reclaimed as stale (staleAfterSeconds covers crashed workers only).
   * Returns a function that stops renewing.
   */
  function renewLeaseWhileRunning(job: Job, jobLogger: Logger): () => void {
    const intervalMs = Math.max(250, (staleAfterSeconds * 1000) / 3);
    const timer = setInterval(() => {
      renewJobLease(schedulerDb, job.id, workerId)
        .then((held) => {
          if (!held) {
            jobLogger.warn("job lease lost while running");
            clearInterval(timer);
          }
        })
        .catch((error: unknown) =>
          jobLogger.warn(
            { err: safeErrorMessage(error) },
            "lease renewal failed",
          ),
        );
    }, intervalMs);
    return () => clearInterval(timer);
  }

  async function executeJob(job: Job): Promise<void> {
    const jobLogger = logger.child({
      jobId: job.id,
      kind: job.kind,
      workspaceId: job.workspaceId,
    });
    let stopRenewing: () => void = () => {};
    try {
      if (!payloadIdentityMatches(job)) {
        await failJob(
          schedulerDb,
          job.id,
          workerId,
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
          workerId,
          `contract: unknown job kind ${JSON.stringify(job.kind)}`,
          { retryable: false },
        );
        jobLogger.error("job rejected: unknown kind");
        return;
      }
      const ctx = { job, appDb, schedulerDb, logger: jobLogger };
      stopRenewing = renewLeaseWhileRunning(job, jobLogger);
      // No transaction wraps the handler: it opens short workspace-scoped
      // transactions itself, so a long job never pins a pooled connection
      // idle-in-transaction (and handlers can call providers outside any).
      await handler(ctx);
      stopRenewing();
      if (await completeJob(schedulerDb, job.id, workerId)) {
        jobLogger.info({ attempts: job.attempts }, "job succeeded");
      } else {
        // The lease was reclaimed while the handler ran; the job now belongs
        // to another worker. Handlers are idempotent, so the extra run is
        // harmless, but this worker must not overwrite the job's state.
        jobLogger.warn("job finished after its lease was lost; not completed");
      }
    } catch (error) {
      // NonRetryable → dead-letter; Terminal → 'failed' (no retries, no
      // dead-letter, e.g. rejected credentials); anything else retries.
      const terminal = error instanceof TerminalJobError;
      const retryable = !terminal && !(error instanceof NonRetryableJobError);
      try {
        stopRenewing();
        const result = await failJob(
          schedulerDb,
          job.id,
          workerId,
          safeErrorMessage(error),
          { retryable, deadLetter: !terminal },
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
    serializers: logSerializers,
    level: config.logLevel,
    base: { service: "netrics-server", role: config.role },
  });
  // Two pools on purpose: the scheduler role claims/advances jobs; the app
  // role executes tenant work inside withWorkspace() (RLS-enforced). The
  // worker never reads credentials through the scheduler pool.
  // Pools sized from concurrency: every in-flight job may hold one app
  // connection (short tenant transactions) and renew its lease on the
  // scheduler pool, next to claims and heartbeats.
  const schedulerDb = createDatabase(config.databaseSchedulerUrl, {
    max: config.workerConcurrency + 2,
  });
  const appDb = createDatabase(config.databaseUrl, {
    max: config.workerConcurrency + 2,
  });
  const registry = createDefaultRegistry();
  const credentialKeyring = createCredentialKeyring(
    config.appEncryptionKey,
    config.appEncryptionKeysPrevious,
  );
  const worker = createWorker({
    schedulerDb,
    appDb,
    handlers: createJobHandlers({
      registry,
      credentialKeyring,
      imageQuota: config.imageQuota,
      oauthTokens: createOAuthTokenService({
        db: appDb,
        credentialKeyring,
        providers: createOAuthProviders(config),
        logger,
      }),
    }),
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
