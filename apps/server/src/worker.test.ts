import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDatabase,
  createRawSqlClient,
  createWorkspace,
  enqueueJob,
  schema,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";

import { NonRetryableJobError, type JobHandler } from "./jobs/handlers.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";
import { createWorker, type WorkerHandle } from "./worker.js";

function schedulerUrlOf(testDb: TestDatabase): string {
  const url = new URL(testDb.adminUrl);
  url.username = "netrics_scheduler";
  url.password = "netrics_scheduler";
  return url.toString();
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 10_000,
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
let workspaceA: string;
let workspaceB: string;

async function jobRow(id: string) {
  const rows = await schedulerRaw`
    select status, attempts, last_error from jobs where id = ${id}
  `;
  return rows[0];
}

async function startWorker(
  handlers: Record<string, JobHandler>,
  overrides: Partial<Parameters<typeof createWorker>[0]> = {},
): Promise<WorkerHandle> {
  const worker = createWorker({
    schedulerDb,
    appDb,
    handlers,
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

  const [userA, userB] = await appDb
    .insert(schema.users)
    .values([
      { email: "worker-a@example.com", displayName: "Owner A" },
      { email: "worker-b@example.com", displayName: "Owner B" },
    ])
    .returning({ id: schema.users.id });
  workspaceA = await createWorkspace(appDb, {
    name: "Worker A",
    ownerUserId: userA!.id,
  });
  workspaceB = await createWorkspace(appDb, {
    name: "Worker B",
    ownerUserId: userB!.id,
  });
}, 30_000);

afterAll(async () => {
  await schedulerRaw.end({ timeout: 5 }).catch(() => undefined);
});

describe("worker", () => {
  it("executes a netrics.noop job to completion inside the tenant context", async () => {
    const jobId = await withWorkspace(
      appDb,
      { workspaceId: workspaceA },
      (tx) => enqueueJob(tx, { kind: "netrics.noop", workspaceId: workspaceA }),
    );
    const ran: Array<{ jobId: string; hadTx: boolean }> = [];
    const worker = await startWorker({
      "netrics.noop": async (ctx) => {
        ran.push({ jobId: ctx.job.id, hadTx: ctx.tx !== undefined });
      },
    });
    try {
      await waitFor(async () => (await jobRow(jobId))?.status === "succeeded");
      expect(ran).toEqual([{ jobId, hadTx: true }]);
    } finally {
      await worker.stop();
    }
    // The worker reported liveness.
    const heartbeats = await schedulerRaw`
      select role from worker_heartbeats where worker_id = ${worker.workerId}
    `;
    expect(heartbeats[0]?.role).toBe("worker");
  });

  it("dead-letters unknown job kinds as contract errors", async () => {
    const jobId = await withWorkspace(
      appDb,
      { workspaceId: workspaceA },
      (tx) => enqueueJob(tx, { kind: "bogus.kind", workspaceId: workspaceA }),
    );
    const worker = await startWorker({});
    try {
      await waitFor(async () => (await jobRow(jobId))?.status === "dead");
      const row = await jobRow(jobId);
      expect(row?.last_error).toBe('contract: unknown job kind "bogus.kind"');
      expect(row?.attempts).toBe(1);
    } finally {
      await worker.stop();
    }
  });

  it("dead-letters jobs whose payload identity mismatches the row", async () => {
    // Bypass enqueueJob (which forces identity) to simulate tampering.
    const jobId = await withWorkspace(
      appDb,
      { workspaceId: workspaceA },
      (tx) =>
        tx
          .insert(schema.jobs)
          .values({
            kind: "netrics.noop",
            workspaceId: workspaceA,
            payload: { workspace_id: workspaceB, connection_id: null },
          })
          .returning({ id: schema.jobs.id })
          .then((rows) => rows[0]!.id),
    );
    let ran = false;
    const worker = await startWorker({
      "netrics.noop": async () => {
        ran = true;
      },
    });
    try {
      await waitFor(async () => (await jobRow(jobId))?.status === "dead");
      const row = await jobRow(jobId);
      expect(row?.last_error).toBe(
        "contract: payload workspace_id/connection_id mismatch",
      );
      expect(ran).toBe(false);
    } finally {
      await worker.stop();
    }
  });

  it("retries a throwing handler with backoff, then succeeds", async () => {
    const jobId = await withWorkspace(
      appDb,
      { workspaceId: workspaceA },
      (tx) => enqueueJob(tx, { kind: "test.flaky", workspaceId: workspaceA }),
    );
    let calls = 0;
    const worker = await startWorker({
      "test.flaky": async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("transient: provider down");
        }
      },
    });
    try {
      // First attempt fails retryable: pending with attempts=1, run_at in the
      // future (backoff) and a redacted-safe error message.
      await waitFor(async () => {
        const row = await jobRow(jobId);
        return row?.status === "pending" && row?.attempts === 1;
      });
      expect((await jobRow(jobId))?.last_error).toBe(
        "transient: provider down",
      );

      // Simulate the backoff elapsing; the retry succeeds.
      await schedulerRaw`
        update jobs set run_at = now() where id = ${jobId}
      `;
      await waitFor(async () => (await jobRow(jobId))?.status === "succeeded");
      expect(calls).toBe(2);
    } finally {
      await worker.stop();
    }
  });

  it("dead-letters NonRetryableJobError without consuming retries", async () => {
    const jobId = await withWorkspace(
      appDb,
      { workspaceId: workspaceA },
      (tx) =>
        enqueueJob(tx, { kind: "test.permanent", workspaceId: workspaceA }),
    );
    const worker = await startWorker({
      "test.permanent": async () => {
        throw new NonRetryableJobError("contract: bad manifest");
      },
    });
    try {
      await waitFor(async () => (await jobRow(jobId))?.status === "dead");
      const row = await jobRow(jobId);
      expect(row?.attempts).toBe(1);
      expect(row?.last_error).toBe("contract: bad manifest");
    } finally {
      await worker.stop();
    }
  });

  it("reclaims a crashed worker's stale lock and runs the job exactly once", async () => {
    const jobId = await withWorkspace(
      appDb,
      { workspaceId: workspaceA },
      (tx) => enqueueJob(tx, { kind: "netrics.noop", workspaceId: workspaceA }),
    );
    // Crash simulation: the job sits in running with a lock older than the
    // stale threshold, as if the worker died mid-flight.
    await schedulerRaw`
      update jobs
      set status = 'running', locked_by = 'crashed-worker',
          locked_at = now() - interval '1 hour'
      where id = ${jobId}
    `;
    let calls = 0;
    const worker = await startWorker(
      {
        "netrics.noop": async () => {
          calls += 1;
        },
      },
      { staleAfterSeconds: 1800 },
    );
    try {
      await waitFor(async () => (await jobRow(jobId))?.status === "succeeded");
      expect(calls).toBe(1);
      // The stale lock counted as one failed attempt.
      expect((await jobRow(jobId))?.attempts).toBe(1);
    } finally {
      await worker.stop();
    }
  });

  it("stop() drains in-flight jobs before returning", async () => {
    const jobId = await withWorkspace(
      appDb,
      { workspaceId: workspaceA },
      (tx) => enqueueJob(tx, { kind: "test.slow", workspaceId: workspaceA }),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const worker = await startWorker({
      "test.slow": async () => {
        started = true;
        await gate;
      },
    });
    await waitFor(async () => started);
    const stopPromise = worker.stop();
    release();
    await stopPromise;
    expect((await jobRow(jobId))?.status).toBe("succeeded");
  });
});
