import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createWorkspace, withWorkspace } from "./context.js";
import * as authSchema from "./auth-schema.js";
import {
  claimJobs,
  completeJob,
  enqueueJob,
  enqueueSyncJob,
  failJob,
  heartbeat,
} from "./jobs.js";
import * as schema from "./schema.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

function errorChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
}

// drizzle wraps driver errors ("Failed query: ..."); the PostgreSQL message
// lives in the cause chain.
async function expectDbError(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(errorChain(error)).toMatch(pattern);
    return;
  }
  expect.unreachable("expected the query to fail");
}

function roleUrl(base: string, role: string): string {
  const url = new URL(base);
  url.username = role;
  url.password = role;
  return url.toString();
}

let testDb: TestDatabase;
let appClient: postgres.Sql;
let schedulerClient: postgres.Sql;
let db: PostgresJsDatabase<typeof schema & typeof authSchema>;
let schedulerDb: PostgresJsDatabase<typeof schema & typeof authSchema>;

let workspaceA: string;
let workspaceB: string;
let connectionA: string;
let jobA: string;
let jobB: string;
let jobInstallation: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  appClient = postgres(testDb.appUrl);
  schedulerClient = postgres(roleUrl(testDb.adminUrl, "netrics_scheduler"), {
    max: 1,
  });
  db = drizzle(appClient, { schema: { ...schema, ...authSchema } });
  schedulerDb = drizzle(schedulerClient, {
    schema: { ...schema, ...authSchema },
  });

  const [userA, userB] = await db
    .insert(schema.users)
    .values([
      { email: "jobs-a@example.com", displayName: "Owner A" },
      { email: "jobs-b@example.com", displayName: "Owner B" },
    ])
    .returning({ id: schema.users.id });

  workspaceA = await createWorkspace(db, {
    name: "Workspace A",
    ownerUserId: userA!.id,
  });
  workspaceB = await createWorkspace(db, {
    name: "Workspace B",
    ownerUserId: userB!.id,
  });

  await db.insert(schema.connectors).values({
    id: "demo",
    version: "1.0.0",
    manifest: { id: "demo" },
  });
  connectionA = await withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
    tx
      .insert(schema.connections)
      .values({ workspaceId: workspaceA, connectorId: "demo", name: "A conn" })
      .returning({ id: schema.connections.id })
      .then((rows) => rows[0]!.id),
  );
  await withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
    tx.insert(schema.connectionState).values({
      connectionId: connectionA,
      workspaceId: workspaceA,
      nextDueAt: new Date("2026-01-02T00:00:00Z"),
      cursor: "opaque-cursor",
    }),
  );

  jobA = await withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
    tx
      .insert(schema.jobs)
      .values({
        kind: "connection.sync",
        workspaceId: workspaceA,
        connectionId: connectionA,
      })
      .returning({ id: schema.jobs.id })
      .then((rows) => rows[0]!.id),
  );
  jobB = await withWorkspace(db, { workspaceId: workspaceB }, (tx) =>
    tx
      .insert(schema.jobs)
      .values({ kind: "connection.sync", workspaceId: workspaceB })
      .returning({ id: schema.jobs.id })
      .then((rows) => rows[0]!.id),
  );
  // Installation-internal job (workspace_id NULL) inserted as the owner role.
  const admin = postgres(testDb.adminUrl, { max: 1 });
  try {
    const rows = await admin`
      insert into jobs (kind) values ('maintenance.retention') returning id
    `;
    jobInstallation = rows[0]!.id as string;
  } finally {
    await admin.end({ timeout: 5 }).catch(() => undefined);
  }
}, 30_000);

afterAll(async () => {
  await appClient.end({ timeout: 5 }).catch(() => undefined);
  await schedulerClient.end({ timeout: 5 }).catch(() => undefined);
});

describe("jobs RLS — netrics_app (tenant class)", () => {
  it("sees only the current workspace's jobs", async () => {
    await withWorkspace(db, { workspaceId: workspaceA }, async (tx) => {
      const jobs = await tx.select().from(schema.jobs);
      expect(jobs.map((job) => job.id)).toEqual([jobA]);
    });
    await withWorkspace(db, { workspaceId: workspaceB }, async (tx) => {
      const jobs = await tx.select().from(schema.jobs);
      expect(jobs.map((job) => job.id)).toEqual([jobB]);
    });
    // No context: nothing — installation-internal jobs stay invisible.
    expect(await db.select().from(schema.jobs)).toHaveLength(0);
  });

  it("rejects enqueueing a job into a foreign workspace", async () => {
    await expectDbError(
      withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
        tx
          .insert(schema.jobs)
          .values({ kind: "connection.sync", workspaceId: workspaceB }),
      ),
      /row-level security/,
    );
  });

  it("may update (retry) its own workspace's jobs but not others'", async () => {
    await withWorkspace(db, { workspaceId: workspaceA }, async (tx) => {
      const updated = await tx
        .update(schema.jobs)
        .set({ status: "pending", attempts: 0 })
        .returning({ id: schema.jobs.id });
      expect(updated.map((job) => job.id)).toEqual([jobA]);
    });

    // workspace B's context cannot even see job A to update it.
    await withWorkspace(db, { workspaceId: workspaceB }, async (tx) => {
      const updated = await tx
        .update(schema.jobs)
        .set({ status: "pending" })
        .returning({ id: schema.jobs.id });
      expect(updated.map((job) => job.id)).toEqual([jobB]);
    });
  });

  it("cannot delete jobs (jobs are archival)", async () => {
    await expectDbError(
      withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
        tx.delete(schema.jobs),
      ),
      /permission denied/,
    );
  });

  it("enforces the idempotency key", async () => {
    await withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
      tx.insert(schema.jobs).values({
        kind: "connection.sync",
        workspaceId: workspaceA,
        idempotencyKey: "sync:once",
      }),
    );
    // A duplicate key aborts its own transaction with a unique violation.
    await expectDbError(
      withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
        tx.insert(schema.jobs).values({
          kind: "connection.sync",
          workspaceId: workspaceA,
          idempotencyKey: "sync:once",
        }),
      ),
      /jobs_idempotency_key_unique/,
    );
  });
});

describe("jobs RLS — netrics_scheduler (claiming class)", () => {
  it("sees all jobs regardless of workspace, including installation jobs", async () => {
    const rows = await schedulerClient`select id from jobs`;
    const ids = rows.map((row) => row.id);
    // Other tests enqueue extra jobs; the point is nothing is hidden by RLS.
    expect(ids).toEqual(expect.arrayContaining([jobA, jobB, jobInstallation]));
  });

  it("can claim a job (UPDATE status/locked_by) in any workspace", async () => {
    const claimed = await schedulerClient`
      update jobs
      set status = 'running', locked_by = 'worker-1', locked_at = now(),
          attempts = attempts + 1
      where id = ${jobA}
      returning id, status, locked_by, attempts
    `;
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.status).toBe("running");
    expect(claimed[0]!.locked_by).toBe("worker-1");
    expect(claimed[0]!.attempts).toBe(1);

    const advanced = await schedulerClient`
      update jobs set status = 'succeeded' where id = ${jobB} returning id
    `;
    expect(advanced).toHaveLength(1);
  });

  it("can INSERT via the scheduler policy (0006) but never DELETE", async () => {
    // Migration 0006 granted the scheduler INSERT (with a current_user policy)
    // so it can enqueue due syncs itself; idempotent recurring enqueues go
    // through the enqueue_sync_job() function instead.
    const inserted = await schedulerClient`
      insert into jobs (kind) values ('maintenance.retention') returning id
    `;
    expect(inserted).toHaveLength(1);
    await expect(schedulerClient`delete from jobs`).rejects.toThrow(
      /permission denied/,
    );
  });

  it("claims are not blocked by tenant context (no app.workspace_id set)", async () => {
    // The scheduler never sets app.workspace_id; the tenant policies evaluate
    // to NULL and the scheduler policy admits the row.
    const due = await schedulerClient`
      select id from jobs where status = 'pending'
    `;
    expect(due.length).toBeGreaterThanOrEqual(1);
  });
});

describe("scheduler credential isolation", () => {
  it("reads only the scheduling columns of connection_state", async () => {
    const rows = await schedulerClient`
      select connection_id, workspace_id, next_due_at from connection_state
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.connection_id).toBe(connectionA);
    expect(rows[0]!.workspace_id).toBe(workspaceA);

    // Anything beyond the column grant is denied, and whole-table SELECT *
    // (which expands to ungranted columns) fails too.
    await expect(
      schedulerClient`select cursor from connection_state`,
    ).rejects.toThrow(/permission denied/);
    await expect(
      schedulerClient`select * from connection_state`,
    ).rejects.toThrow(/permission denied/);
  });

  it("cannot read connections at all — credentials stay unreachable", async () => {
    await expect(schedulerClient`select * from connections`).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      schedulerClient`select credentials_encrypted from connections`,
    ).rejects.toThrow(/permission denied/);
    await expect(
      schedulerClient`select id, name from connections`,
    ).rejects.toThrow(/permission denied/);
  });
});

// ---------------------------------------------------------------------------
// Queue mechanics (migration 0006 + src/jobs.ts wrappers)
// ---------------------------------------------------------------------------

function seedJob(input: {
  workspaceId: string;
  kind?: string;
  connectionId?: string | null;
  maxAttempts?: number;
}): Promise<string> {
  return withWorkspace(db, { workspaceId: input.workspaceId }, (tx) =>
    enqueueJob(tx, {
      kind: input.kind ?? "test.job",
      workspaceId: input.workspaceId,
      connectionId: input.connectionId ?? null,
      ...(input.maxAttempts !== undefined
        ? { maxAttempts: input.maxAttempts }
        : {}),
    }),
  );
}

describe("claim_jobs", () => {
  beforeAll(async () => {
    // Clean slate: earlier RLS tests leave pending jobs behind.
    await schedulerClient`update jobs set status = 'succeeded' where status = 'pending'`;
  });

  it("returns nothing when no jobs are due", async () => {
    expect(await claimJobs(schedulerDb, "w-empty", 10, 3600)).toEqual([]);
  });

  it("gives concurrent claimers disjoint job sets", async () => {
    const seeded: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      seeded.push(
        await seedJob({ workspaceId: workspaceA, kind: "test.concurrent" }),
      );
    }

    const client1 = postgres(roleUrl(testDb.adminUrl, "netrics_scheduler"), {
      max: 2,
    });
    const client2 = postgres(roleUrl(testDb.adminUrl, "netrics_scheduler"), {
      max: 2,
    });
    try {
      const drain = async (
        client: postgres.Sql,
        workerId: string,
      ): Promise<string[]> => {
        const dbx = drizzle(client, {
          schema: { ...schema, ...authSchema },
        });
        const ids: string[] = [];
        for (;;) {
          const claimed = await claimJobs(dbx, workerId, 3, 3600);
          if (claimed.length === 0) {
            return ids;
          }
          ids.push(...claimed.map((job) => job.id));
        }
      };
      const [ids1, ids2] = await Promise.all([
        drain(client1, "worker-1"),
        drain(client2, "worker-2"),
      ]);
      const overlap = ids1.filter((id) => ids2.includes(id));
      expect(overlap).toEqual([]);
      expect([...ids1, ...ids2].sort()).toEqual(seeded.sort());
    } finally {
      await client1.end({ timeout: 5 }).catch(() => undefined);
      await client2.end({ timeout: 5 }).catch(() => undefined);
      await schedulerClient`
        update jobs set status = 'succeeded'
        where kind = 'test.concurrent' and status = 'running'
      `;
    }
  });

  it("serializes connection.* jobs per connection", async () => {
    const [connectionC, connectionD] = await withWorkspace(
      db,
      { workspaceId: workspaceA },
      (tx) =>
        tx
          .insert(schema.connections)
          .values([
            { workspaceId: workspaceA, connectorId: "demo", name: "C" },
            { workspaceId: workspaceA, connectorId: "demo", name: "D" },
          ])
          .returning({ id: schema.connections.id })
          .then((rows) => rows.map((row) => row.id)),
    );
    const jobC1 = await seedJob({
      workspaceId: workspaceA,
      kind: "connection.sync",
      connectionId: connectionC,
    });
    const jobC2 = await seedJob({
      workspaceId: workspaceA,
      kind: "connection.sync",
      connectionId: connectionC,
    });
    const jobD = await seedJob({
      workspaceId: workspaceA,
      kind: "connection.sync",
      connectionId: connectionD,
    });
    // Non-connection.* kinds are not connection-serialized even with a
    // connection_id set.
    const jobMisc = await seedJob({
      workspaceId: workspaceA,
      kind: "maintenance.retention",
      connectionId: connectionC,
    });

    const first = await claimJobs(schedulerDb, "w-serial", 10, 3600);
    const firstIds = first.map((job) => job.id);
    const claimedC = [jobC1, jobC2].filter((id) => firstIds.includes(id));
    expect(claimedC).toHaveLength(1);
    expect(firstIds).toContain(jobD);
    expect(firstIds).toContain(jobMisc);

    // While the sibling is still running, the second connection-C job is
    // skipped by every later claim.
    expect(await claimJobs(schedulerDb, "w-serial", 10, 3600)).toEqual([]);

    // Completing the running job unblocks the pending one.
    await completeJob(schedulerDb, claimedC[0]!);
    const second = await claimJobs(schedulerDb, "w-serial", 10, 3600);
    const remainingC = [jobC1, jobC2].find((id) => id !== claimedC[0]);
    expect(second.map((job) => job.id)).toEqual([remainingC]);
    await completeJob(schedulerDb, remainingC!);
  });

  it("requeues stale running jobs and dead-letters exhausted ones", async () => {
    const staleId = await seedJob({ workspaceId: workspaceA });
    const exhaustedId = await seedJob({
      workspaceId: workspaceA,
      maxAttempts: 2,
    });
    await schedulerClient`
      update jobs
      set status = 'running', locked_by = 'crashed-worker',
          locked_at = now() - interval '1 hour'
      where id = ${staleId}
    `;
    await schedulerClient`
      update jobs
      set status = 'running', locked_by = 'crashed-worker',
          locked_at = now() - interval '1 hour', attempts = 2
      where id = ${exhaustedId}
    `;

    const claimed = await claimJobs(schedulerDb, "w-stale", 10, 1800);
    // The requeued job becomes claimable; the exhausted one went dead.
    expect(claimed.map((job) => job.id)).toEqual([staleId]);

    const rows = await schedulerClient`
      select id, status, attempts, locked_by, last_error
      from jobs where id in (${staleId}, ${exhaustedId})
      order by id
    `;
    const byId = new Map(rows.map((row) => [row.id as string, row]));
    const stale = byId.get(staleId)!;
    expect(stale.status).toBe("running"); // requeued, then claimed above
    expect(stale.attempts).toBe(1); // requeue counted the crashed attempt
    expect(stale.locked_by).toBe("w-stale");
    expect(stale.last_error).toBe("stale lock requeued");
    const exhausted = byId.get(exhaustedId)!;
    expect(exhausted.status).toBe("dead");
    expect(exhausted.attempts).toBe(3);
    expect(exhausted.locked_by).toBeNull();

    await completeJob(schedulerDb, staleId);
  });
});

describe("completeJob / failJob", () => {
  it("completes a running job exactly once", async () => {
    const id = await seedJob({ workspaceId: workspaceA });
    await claimJobs(schedulerDb, "w-complete", 5, 3600);
    expect(await completeJob(schedulerDb, id)).toBe(true);
    // No longer running: a second completion is a no-op.
    expect(await completeJob(schedulerDb, id)).toBe(false);
    const rows = await schedulerClient`
      select status, locked_by, locked_at from jobs where id = ${id}
    `;
    expect(rows[0]).toMatchObject({
      status: "succeeded",
      locked_by: null,
      locked_at: null,
    });
  });

  it("retries with exponential backoff (monotonic run_at)", async () => {
    const id = await seedJob({ workspaceId: workspaceA });
    await claimJobs(schedulerDb, "w-backoff", 5, 3600);

    const first = await failJob(schedulerDb, id, "transient: boom", {
      retryable: true,
    });
    expect(first).toMatchObject({ status: "pending", attempts: 1 });
    // 2^1 * 15s = 30s (allow generous clock slack).
    const delay1 = first!.runAt.getTime() - Date.now();
    expect(delay1).toBeGreaterThan(20_000);
    expect(delay1).toBeLessThan(40_000);

    await schedulerClient`
      update jobs set status = 'running' where id = ${id}
    `;
    const second = await failJob(schedulerDb, id, "transient: boom again", {
      retryable: true,
    });
    expect(second).toMatchObject({ status: "pending", attempts: 2 });
    // 2^2 * 15s = 60s — strictly further out than the first retry.
    expect(second!.runAt.getTime()).toBeGreaterThan(first!.runAt.getTime());
    const delay2 = second!.runAt.getTime() - Date.now();
    expect(delay2).toBeGreaterThan(50_000);

    await schedulerClient`
      update jobs set status = 'succeeded' where id = ${id}
    `;
  });

  it("sends retryable failures to dead once max_attempts is reached", async () => {
    const id = await seedJob({ workspaceId: workspaceA, maxAttempts: 2 });
    await claimJobs(schedulerDb, "w-dead", 5, 3600);
    const first = await failJob(schedulerDb, id, "transient: one", {
      retryable: true,
    });
    expect(first).toMatchObject({ status: "pending", attempts: 1 });
    await schedulerClient`
      update jobs set status = 'running' where id = ${id}
    `;
    const second = await failJob(schedulerDb, id, "transient: two", {
      retryable: true,
    });
    expect(second).toMatchObject({ status: "dead", attempts: 2 });
  });

  it("sends non-retryable failures straight to dead", async () => {
    const id = await seedJob({ workspaceId: workspaceA });
    await claimJobs(schedulerDb, "w-dead", 5, 3600);
    const result = await failJob(schedulerDb, id, "contract: bad payload", {
      retryable: false,
    });
    expect(result).toMatchObject({ status: "dead", attempts: 1 });
    const rows = await schedulerClient`
      select last_error from jobs where id = ${id}
    `;
    expect(rows[0]!.last_error).toBe("contract: bad payload");
  });
});

describe("enqueue_sync_job (scheduler role)", () => {
  it("enqueues with identity payload and dedupes on the idempotency key", async () => {
    const key = `sync:${connectionA}:2026-01-02T00:00:00Z`;
    const input = {
      connectionId: connectionA,
      workspaceId: workspaceA,
      kind: "connection.sync",
      runAt: new Date(),
      idempotencyKey: key,
    };
    const id1 = await enqueueSyncJob(schedulerDb, input);
    expect(id1).toBeTruthy();
    expect(await enqueueSyncJob(schedulerDb, input)).toBeNull();

    const rows = await schedulerClient`
      select kind, workspace_id, connection_id, payload, idempotency_key
      from jobs where id = ${id1}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "connection.sync",
      workspace_id: workspaceA,
      connection_id: connectionA,
      idempotency_key: key,
    });
    expect(rows[0]!.payload).toEqual({
      workspace_id: workspaceA,
      connection_id: connectionA,
    });

    // A different key enqueues a new job.
    const id3 = await enqueueSyncJob(schedulerDb, {
      ...input,
      idempotencyKey: `${key}:next`,
    });
    expect(id3).toBeTruthy();
    expect(id3).not.toBe(id1);

    await schedulerClient`
      update jobs set status = 'succeeded' where id in (${id1}, ${id3})
    `;
  });
});

describe("enqueueJob (app role, transactional)", () => {
  it("forces workspace/connection identity into the payload", async () => {
    const id = await withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
      enqueueJob(tx, {
        kind: "test.envelope",
        workspaceId: workspaceA,
        connectionId: connectionA,
        payload: {
          note: "caller data",
          workspace_id: "spoofed",
          connection_id: "spoofed",
        },
      }),
    );
    await withWorkspace(db, { workspaceId: workspaceA }, async (tx) => {
      const rows = await tx
        .select({ payload: schema.jobs.payload })
        .from(schema.jobs)
        .where(eq(schema.jobs.id, id));
      expect(rows[0]!.payload).toEqual({
        note: "caller data",
        workspace_id: workspaceA,
        connection_id: connectionA,
      });
    });
    await withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
      tx
        .update(schema.jobs)
        .set({ status: "succeeded" })
        .where(eq(schema.jobs.id, id)),
    );
  });
});

describe("worker_heartbeats", () => {
  it("upserts on worker_id, keeping the original started_at", async () => {
    await heartbeat(schedulerDb, "worker-hb-1", "worker", { pid: 1 });
    const first = await schedulerClient`
      select started_at, last_heartbeat_at, metadata
      from worker_heartbeats where worker_id = 'worker-hb-1'
    `;
    expect(first).toHaveLength(1);
    expect(first[0]!.metadata).toEqual({ pid: 1 });

    await new Promise((resolve) => setTimeout(resolve, 20));
    await heartbeat(schedulerDb, "worker-hb-1", "worker");
    const second = await schedulerClient`
      select started_at, last_heartbeat_at, metadata
      from worker_heartbeats where worker_id = 'worker-hb-1'
    `;
    expect(second[0]!.started_at).toEqual(first[0]!.started_at);
    // Raw client: timestamptz comes back as an ISO string.
    expect(
      Date.parse(second[0]!.last_heartbeat_at as string),
    ).toBeGreaterThanOrEqual(Date.parse(first[0]!.last_heartbeat_at as string));
    expect(second[0]!.metadata).toEqual({});
  });

  it("grants netrics_app read-only access", async () => {
    const rows = await db.select().from(schema.workerHeartbeats);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    await expectDbError(
      db
        .insert(schema.workerHeartbeats)
        .values({ workerId: "app-forged", role: "worker" }),
      /permission denied/,
    );
  });
});

describe("scheduler connection_state grants (migration 0006)", () => {
  it("reads poll interval and auth state, advances next_due_at only", async () => {
    const rows = await schedulerClient`
      select connection_id, poll_interval_seconds, auth_state
      from connection_state
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      connection_id: connectionA,
      poll_interval_seconds: 300,
      auth_state: "ok",
    });

    await schedulerClient`
      update connection_state set next_due_at = now()
      where connection_id = ${connectionA}
    `;

    // Column-level grant covers next_due_at only.
    await expect(
      schedulerClient`
        update connection_state set cursor = 'forged'
        where connection_id = ${connectionA}
      `,
    ).rejects.toThrow(/permission denied/);
    await expect(schedulerClient`delete from connection_state`).rejects.toThrow(
      /permission denied/,
    );
  });
});
