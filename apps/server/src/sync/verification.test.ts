import { randomBytes } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Verification tests wait on real worker loops claiming and executing jobs.
vi.setConfig({ testTimeout: 30_000 });

import { createDefaultRegistry } from "@netrics/connector-runtime";
import {
  claimJobs,
  createDatabase,
  createRawSqlClient,
  createWorkspace,
  enqueueJob,
  schema,
  withWorkspace,
  type Database,
  type Job,
  type Sql,
} from "@netrics/database";

import { createCredentialKeyring } from "../credentials.js";
import { createJobHandlers, type JobHandler } from "../jobs/handlers.js";
import { runSchedulerTick } from "../scheduler.js";
import { createTestDatabase, type TestDatabase } from "../test-db.js";
import { createWorker, type WorkerHandle } from "../worker.js";
import { syncCatalog } from "./catalog.js";

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
const registry = createDefaultRegistry();

function schedulerUrlOf(testDb: TestDatabase): string {
  const url = new URL(testDb.adminUrl);
  url.username = "netrics_scheduler";
  url.password = "netrics_scheduler";
  return url.toString();
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

let testDb: TestDatabase;
let appDb: Database;
let schedulerDb: Database;
let schedulerRaw: Sql;
/** Migration role: bypasses RLS, used to forge tampered job rows. */
let adminRaw: Sql;
let workspaceA: string;
let workspaceB: string;

async function seedConnection(
  workspaceId: string,
  connectorId: string,
  config: Record<string, unknown> = {},
): Promise<string> {
  return withWorkspace(appDb, { workspaceId }, async (tx) => {
    const [connection] = await tx
      .insert(schema.connections)
      .values({
        workspaceId,
        connectorId,
        name: `${connectorId} connection`,
        config,
      })
      .returning({ id: schema.connections.id });
    await tx.insert(schema.connectionState).values({
      connectionId: connection!.id,
      workspaceId,
      pollIntervalSeconds: 300,
    });
    return connection!.id;
  });
}

async function enqueue(
  workspaceId: string,
  connectionId: string,
  kind: string,
) {
  return withWorkspace(appDb, { workspaceId }, (tx) =>
    enqueueJob(tx, { kind, workspaceId, connectionId }),
  );
}

async function jobRow(id: string) {
  const rows = await schedulerRaw`
    select status, attempts, last_error, run_at from jobs where id = ${id}
  `;
  return rows[0];
}

async function connectionObservationCount(
  workspaceId: string,
  connectionId: string,
): Promise<number> {
  return withWorkspace(appDb, { workspaceId }, async (tx) => {
    const rows = await tx.execute<{ count: string }>(
      sql`select count(*)::text as count from observations where connection_id = ${connectionId}::uuid`,
    );
    return Number(rows[0]!.count);
  });
}

async function syncRunsFor(workspaceId: string, connectionId: string) {
  return withWorkspace(appDb, { workspaceId }, (tx) =>
    tx.execute<Record<string, unknown>>(
      sql`select * from sync_runs where connection_id = ${connectionId}::uuid order by started_at, id`,
    ),
  );
}

async function stateFor(workspaceId: string, connectionId: string) {
  return withWorkspace(appDb, { workspaceId }, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.connectionState)
      .where(eq(schema.connectionState.connectionId, connectionId))
      .limit(1);
    return rows[0] ?? null;
  });
}

async function startWorker(
  overrides: Partial<Parameters<typeof createWorker>[0]> = {},
): Promise<WorkerHandle> {
  const worker = createWorker({
    schedulerDb,
    appDb,
    handlers: createJobHandlers({
      registry,
      credentialKeyring: createCredentialKeyring(ENCRYPTION_KEY),
    }),
    pollMs: 25,
    heartbeatMs: 50,
    ...overrides,
  });
  await worker.start();
  return worker;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  appDb = createDatabase(testDb.appUrl);
  schedulerDb = createDatabase(schedulerUrlOf(testDb));
  schedulerRaw = createRawSqlClient(schedulerUrlOf(testDb), { max: 2 });
  adminRaw = createRawSqlClient(testDb.adminUrl, { max: 2 });

  await syncCatalog(appDb, registry);

  const [userA, userB] = await appDb
    .insert(schema.users)
    .values([
      { email: "verification-a@example.com", displayName: "Owner A" },
      { email: "verification-b@example.com", displayName: "Owner B" },
    ])
    .returning({ id: schema.users.id });
  workspaceA = await createWorkspace(appDb, {
    name: "Verification A",
    ownerUserId: userA!.id,
  });
  workspaceB = await createWorkspace(appDb, {
    name: "Verification B",
    ownerUserId: userB!.id,
  });
}, 60_000);

afterAll(async () => {
  await schedulerRaw.end({ timeout: 5 }).catch(() => undefined);
  await adminRaw.end({ timeout: 5 }).catch(() => undefined);
});

describe("concurrent scheduling", () => {
  it("two workers racing one connection serialize runs; final state equals a single run", async () => {
    // Control: the same connection kind run exactly once.
    const controlId = await seedConnection(workspaceA, "demo");
    // Raced: three sync jobs for one connection, two workers. At most one sync
    // may wait per connection (jobs_one_pending_sync), so each next sync is
    // queued while its predecessor is claimed: the realistic race.
    const racedId = await seedConnection(workspaceA, "demo");

    // Instrument per-connection in-flight handler invocations across both
    // workers: the claim layer must serialize connection.* jobs.
    const active = new Map<string, number>();
    const maxActive = new Map<string, number>();
    const base = createJobHandlers({
      registry,
      credentialKeyring: createCredentialKeyring(ENCRYPTION_KEY),
    });
    const instrumented: Record<string, JobHandler> = {};
    for (const [kind, handler] of Object.entries(base)) {
      instrumented[kind] = async (ctx) => {
        const key = ctx.job.connectionId ?? "<none>";
        const current = (active.get(key) ?? 0) + 1;
        active.set(key, current);
        maxActive.set(key, Math.max(maxActive.get(key) ?? 0, current));
        try {
          await handler(ctx);
        } finally {
          active.set(key, current - 1);
        }
      };
    }

    const workerA = await startWorker({
      handlers: instrumented,
      workerId: "race-a",
    });
    let workerB: WorkerHandle | null = null;
    try {
      const controlJob = await enqueue(
        workspaceA,
        controlId,
        "connection.sync",
      );
      const racedJobs: string[] = [];
      const notPending = async (id: string) =>
        (await jobRow(id))?.status !== "pending";
      racedJobs.push(await enqueue(workspaceA, racedId, "connection.sync"));
      await waitFor(() => notPending(racedJobs[0]!));
      // Worker B joins once A has claimed the first job; from here on both
      // workers compete for every raced job.
      workerB = await startWorker({
        handlers: instrumented,
        workerId: "race-b",
      });
      for (let index = 1; index < 3; index += 1) {
        racedJobs.push(await enqueue(workspaceA, racedId, "connection.sync"));
        await waitFor(() => notPending(racedJobs[index]!));
      }

      await waitFor(async () => {
        const statuses = await Promise.all(
          [controlJob, ...racedJobs].map(jobRow),
        );
        return statuses.every((row) => row?.status === "succeeded");
      });
    } finally {
      await workerA.stop();
      await workerB?.stop();
    }

    // Serialization held end-to-end: never two in-flight runs per connection.
    expect(maxActive.get(racedId)).toBe(1);
    expect(maxActive.get(controlId)).toBe(1);

    // Final state is exactly as if the sync had run once.
    const controlCount = await connectionObservationCount(
      workspaceA,
      controlId,
    );
    expect(controlCount).toBeGreaterThan(0);
    expect(await connectionObservationCount(workspaceA, racedId)).toBe(
      controlCount,
    );

    // The sync_run cursor chain is consistent and ends at the state cursor.
    const runs = await syncRunsFor(workspaceA, racedId);
    expect(runs).toHaveLength(3);
    expect(runs.every((run) => run.status === "succeeded")).toBe(true);
    expect(runs[0]!.cursor_before).toBeNull();
    for (let index = 1; index < runs.length; index += 1) {
      expect(runs[index]!.cursor_before).toBe(runs[index - 1]!.cursor_after);
      expect(runs[index]!.observations_written).toBe(0);
    }
    const state = await stateFor(workspaceA, racedId);
    expect(state!.cursor).toBe(runs[runs.length - 1]!.cursor_after);
  });
});

describe("crash-retry idempotency at the job level", () => {
  it("a stale-locked job requeues, re-runs cleanly, and redelivery writes nothing", async () => {
    // Clean reference: identical connection, single uninterrupted backfill.
    const cleanId = await seedConnection(workspaceA, "demo");
    const crashedId = await seedConnection(workspaceA, "demo");
    const crashedJob = await enqueue(
      workspaceA,
      crashedId,
      "connection.backfill",
    );

    // Crash simulation: a doomed worker claims the job and dies; the lock
    // ages past the stale threshold with nothing committed.
    const claimed = await claimJobs(schedulerDb, "doomed-worker", 5, 3600);
    expect(claimed.map((job) => job.id)).toEqual([crashedJob]);
    await schedulerRaw`
      update jobs set locked_at = now() - interval '1 hour'
      where id = ${crashedJob}
    `;

    const cleanJob = await enqueue(workspaceA, cleanId, "connection.backfill");
    const worker = await startWorker({ staleAfterSeconds: 60 });
    try {
      await waitFor(async () => {
        const statuses = await Promise.all([crashedJob, cleanJob].map(jobRow));
        return statuses.every((row) => row?.status === "succeeded");
      });
    } finally {
      await worker.stop();
    }

    // The stale requeue counted the crashed attempt, then ran to completion.
    const crashed = await jobRow(crashedJob);
    expect(crashed?.attempts).toBe(1);
    expect(crashed?.last_error).toBe("stale lock requeued");

    // Identical to a single clean run: nothing partial committed before the
    // crash, and the re-run wrote the full window exactly once.
    const cleanCount = await connectionObservationCount(workspaceA, cleanId);
    expect(cleanCount).toBeGreaterThan(0);
    expect(await connectionObservationCount(workspaceA, crashedId)).toBe(
      cleanCount,
    );
    const runs = await syncRunsFor(workspaceA, crashedId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("succeeded");
    expect(runs[0]!.observations_written).toBe(cleanCount);

    // At-least-once redelivery of the succeeded job writes zero duplicates.
    const job = (
      await schedulerRaw`
        select payload from jobs where id = ${crashedJob}
      `
    )[0]!;
    const handlers = createJobHandlers({
      registry,
      credentialKeyring: createCredentialKeyring(ENCRYPTION_KEY),
    });
    await handlers["connection.backfill"]!({
      job: {
        id: crashedJob,
        kind: "connection.backfill",
        workspaceId: workspaceA,
        connectionId: crashedId,
        payload: job.payload,
        runAt: new Date(),
        attempts: 1,
        maxAttempts: 8,
        status: "running",
        lockedBy: "redelivery",
        lockedAt: new Date(),
        lastError: null,
        idempotencyKey: null,
        createdAt: new Date(),
      },
      appDb,
      schedulerDb,
      logger: pino({ level: "silent" }),
    });
    expect(await connectionObservationCount(workspaceA, crashedId)).toBe(
      cleanCount,
    );
    const afterRedelivery = await syncRunsFor(workspaceA, crashedId);
    expect(afterRedelivery).toHaveLength(2);
    expect(afterRedelivery[1]!.observations_written).toBe(0);
  });
});

describe("bad credentials vs outage — two different actionable states", () => {
  it("bad credentials: terminal failure, no retry, scheduler skips the connection", async () => {
    const connectionId = await seedConnection(workspaceA, "demo", {
      simulate: "bad-credentials",
    });
    const jobId = await enqueue(workspaceA, connectionId, "connection.sync");
    const worker = await startWorker();
    try {
      await waitFor(async () => (await jobRow(jobId))?.status === "failed");
    } finally {
      await worker.stop();
    }

    // Terminal, actionable, NOT retried and NOT dead-lettered.
    const row = await jobRow(jobId);
    expect(row?.attempts).toBe(1);
    const runs = await syncRunsFor(workspaceA, connectionId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.error_class).toBe("auth");
    expect(String(runs[0]!.error_message)).toMatch(/credentials/i);
    const state = await stateFor(workspaceA, connectionId);
    expect(state!.authState).toBe("auth_failed");

    // The scheduler skips auth_failed connections even when they are due.
    await schedulerRaw`
      update connection_state set next_due_at = now() - interval '1 minute'
      where connection_id = ${connectionId}
    `;
    const jobsBefore = await schedulerRaw`
      select count(*)::int as count from jobs
      where connection_id = ${connectionId}::uuid
    `;
    const tick = await runSchedulerTick(schedulerDb);
    expect(tick.skippedAuthFailed).toBe(1);
    const jobsAfter = await schedulerRaw`
      select count(*)::int as count from jobs
      where connection_id = ${connectionId}::uuid
    `;
    expect(jobsAfter[0]!.count).toBe(jobsBefore[0]!.count);
  });

  it("outage: retried with backoff in outage state, flips back to ok after recovery", async () => {
    const connectionId = await seedConnection(workspaceA, "demo", {
      simulate: "outage",
    });
    const jobId = await enqueue(workspaceA, connectionId, "connection.sync");
    const worker = await startWorker();
    try {
      await waitFor(async () => {
        const row = await jobRow(jobId);
        return row?.status === "pending" && row?.attempts === 1;
      });

      // Retryable: back to pending with run_at pushed out by the backoff.
      const row = await jobRow(jobId);
      expect(new Date(row!.run_at as string).getTime()).toBeGreaterThan(
        Date.now(),
      );
      const failedRuns = await syncRunsFor(workspaceA, connectionId);
      expect(failedRuns[0]!.error_class).toBe("transient");
      let state = await stateFor(workspaceA, connectionId);
      expect(state!.authState).toBe("outage");
      expect(state!.consecutiveFailures).toBe(1);

      // The provider recovers (the operator removes the simulated outage,
      // as the PATCH config flow would); the retried job succeeds.
      await withWorkspace(appDb, { workspaceId: workspaceA }, (tx) =>
        tx
          .update(schema.connections)
          .set({ config: {} })
          .where(eq(schema.connections.id, connectionId)),
      );
      await schedulerRaw`update jobs set run_at = now() where id = ${jobId}`;
      await waitFor(async () => (await jobRow(jobId))?.status === "succeeded");

      state = await stateFor(workspaceA, connectionId);
      expect(state!.authState).toBe("ok");
      expect(state!.consecutiveFailures).toBe(0);
      expect(
        await connectionObservationCount(workspaceA, connectionId),
      ).toBeGreaterThan(0);
    } finally {
      await worker.stop();
    }
  });
});

describe("cross-workspace job payload tampering", () => {
  it("every forged variant is dead-lettered before tenant work, with zero observations", async () => {
    const connectionA = await seedConnection(workspaceA, "demo");
    const connectionB = await seedConnection(workspaceB, "demo");

    // Forged via the migration role (bypasses RLS and enqueueJob's identity
    // forcing), simulating a tampered queue.
    async function forge(
      workspaceId: string,
      connectionId: string,
      payload: Record<string, string>,
      kind = "connection.sync",
    ): Promise<string> {
      const rows = await adminRaw`
        insert into jobs (kind, workspace_id, connection_id, payload)
        values (
          ${kind},
          ${workspaceId}::uuid,
          ${connectionId}::uuid,
          ${adminRaw.json(payload)}
        )
        returning id
      `;
      return rows[0]!.id as string;
    }

    // 1. Payload workspace_id disagrees with the job row.
    const forgedWorkspace = await forge(workspaceA, connectionA, {
      workspace_id: workspaceB,
      connection_id: connectionA,
    });
    // 2. Payload connection_id points at another workspace's connection.
    //    (A backfill: at most one sync may wait per connection.)
    const forgedPayloadConnection = await forge(
      workspaceA,
      connectionA,
      { workspace_id: workspaceA, connection_id: connectionB },
      "connection.backfill",
    );
    // 3. Row and payload agree, but the connection belongs to workspace B:
    //    passes the executor identity check and must die on RLS instead.
    const forgedRowConnection = await forge(workspaceA, connectionB, {
      workspace_id: workspaceA,
      connection_id: connectionB,
    });

    const forged = [
      forgedWorkspace,
      forgedPayloadConnection,
      forgedRowConnection,
    ];
    const worker = await startWorker();
    try {
      await waitFor(async () => {
        const statuses = await Promise.all(forged.map(jobRow));
        return statuses.every((row) => row?.status === "dead");
      });
    } finally {
      await worker.stop();
    }

    // 1+2 die at the executor's identity check; 3 dies in the engine when
    // RLS hides the foreign connection ("not found").
    expect((await jobRow(forgedWorkspace))?.last_error).toBe(
      "contract: payload workspace_id/connection_id mismatch",
    );
    expect((await jobRow(forgedPayloadConnection))?.last_error).toBe(
      "contract: payload workspace_id/connection_id mismatch",
    );
    expect((await jobRow(forgedRowConnection))?.last_error).toBe(
      "contract: connection not found in the job's workspace",
    );
    for (const id of forged) {
      expect((await jobRow(id))?.attempts).toBe(1);
    }

    // Zero tenant work happened anywhere: no observations and no sync runs
    // on either connection.
    expect(await connectionObservationCount(workspaceA, connectionA)).toBe(0);
    expect(await connectionObservationCount(workspaceB, connectionB)).toBe(0);
    expect(await syncRunsFor(workspaceA, connectionA)).toHaveLength(0);
    expect(await syncRunsFor(workspaceB, connectionB)).toHaveLength(0);
  });

  it("the app role cannot read another workspace's connection inside withWorkspace", async () => {
    const connectionA = await seedConnection(workspaceA, "demo");
    const connectionB = await seedConnection(workspaceB, "demo");

    // Workspace A's tenant context sees its own connection; workspace B's
    // connection id resolves to nothing (what the engine sees for a forged
    // cross-workspace job).
    const visible = await withWorkspace(
      appDb,
      { workspaceId: workspaceA },
      async (tx) => {
        const rows = await tx
          .select({ id: schema.connections.id })
          .from(schema.connections);
        return rows.map((row) => row.id);
      },
    );
    expect(visible).toContain(connectionA);
    expect(visible).not.toContain(connectionB);
  });
});

describe("replay-every-job stability", () => {
  it("re-invoking every succeeded job's payload leaves observation counts unchanged", async () => {
    const connectionId = await seedConnection(workspaceA, "demo", { seed: 7 });
    const backfill = await enqueue(
      workspaceA,
      connectionId,
      "connection.backfill",
    );
    const worker = await startWorker();
    const incrementals: string[] = [];
    try {
      await waitFor(
        async () => (await jobRow(backfill))?.status === "succeeded",
      );
      // Sequential incremental runs (at most one sync waits per connection).
      for (let index = 0; index < 3; index += 1) {
        const id = await enqueue(workspaceA, connectionId, "connection.sync");
        incrementals.push(id);
        await waitFor(async () => (await jobRow(id))?.status === "succeeded");
      }
      await waitFor(async () => {
        const statuses = await Promise.all(incrementals.map(jobRow));
        return statuses.every((row) => row?.status === "succeeded");
      });
    } finally {
      await worker.stop();
    }

    const countBefore = await connectionObservationCount(
      workspaceA,
      connectionId,
    );
    expect(countBefore).toBeGreaterThan(0);
    const runsBefore = await syncRunsFor(workspaceA, connectionId);

    // Every succeeded job for the connection, replayed as a fresh handler
    // invocation with its original payload (the exit-gate replay).
    const succeeded = await schedulerRaw`
      select id, kind, payload, run_at, created_at from jobs
      where connection_id = ${connectionId}::uuid and status = 'succeeded'
      order by created_at
    `;
    expect(succeeded).toHaveLength(4);
    for (const row of succeeded) {
      const handlers = createJobHandlers({
        registry,
        credentialKeyring: createCredentialKeyring(ENCRYPTION_KEY),
      });
      const job: Job = {
        id: row.id as string,
        kind: row.kind as string,
        workspaceId: workspaceA,
        connectionId,
        payload: row.payload,
        runAt: new Date(row.run_at as string),
        attempts: 0,
        maxAttempts: 8,
        status: "running",
        lockedBy: "replay",
        lockedAt: new Date(),
        lastError: null,
        idempotencyKey: null,
        createdAt: new Date(row.created_at as string),
      };
      await handlers[row.kind as string]!({
        job,
        appDb,
        schedulerDb,
        logger: pino({ level: "silent" }),
      });
    }

    // Total count unchanged; every replayed run reported 0 newly written.
    expect(await connectionObservationCount(workspaceA, connectionId)).toBe(
      countBefore,
    );
    const runsAfter = await syncRunsFor(workspaceA, connectionId);
    expect(runsAfter).toHaveLength(runsBefore.length + succeeded.length);
    for (const run of runsAfter.slice(runsBefore.length)) {
      expect(run.status).toBe("succeeded");
      expect(run.observations_written).toBe(0);
    }
  });
});
