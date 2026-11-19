import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createWorkspace, withWorkspace } from "./context.js";
import {
  deleteConnection,
  findBackfillingConnectionIds,
} from "./connections.js";
import * as authSchema from "./auth-schema.js";
import {
  claimJobs,
  completeJob,
  deferJob,
  deferJobUntil,
  enqueueJob,
  enqueueSyncJob,
  requestConnectionBackfill,
  failJob,
  heartbeat,
  renewJobLease,
} from "./jobs.js";
import * as schema from "./schema.js";
import {
  createTestDatabase,
  type TestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

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

  // Catalog rows are owner-written (read-only for netrics_app, #36).
  const owner = postgres(testDb.adminUrl, { max: 1 });
  await owner`
    insert into connectors (id, version, manifest)
    values ('demo', '1.0.0', '{"id":"demo"}'::jsonb)
  `;
  await owner.end({ timeout: 5 });
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
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

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
    // A backfill: at most one sync may wait per connection.
    const jobC2 = await seedJob({
      workspaceId: workspaceA,
      kind: "connection.backfill",
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
    await completeJob(schedulerDb, claimedC[0]!, "w-serial");
    const second = await claimJobs(schedulerDb, "w-serial", 10, 3600);
    const remainingC = [jobC1, jobC2].find((id) => id !== claimedC[0]);
    expect(second.map((job) => job.id)).toEqual([remainingC]);
    await completeJob(schedulerDb, remainingC!, "w-serial");
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

    // The stale job is requeued with backoff (not immediately claimable, so a
    // job that crashes its worker cannot crash-loop); the exhausted one dies.
    expect(await claimJobs(schedulerDb, "w-stale", 10, 1800)).toEqual([]);

    const rows = await schedulerClient`
      select id, status, attempts, locked_by, last_error,
             run_at > now() + interval '20 seconds' as backed_off
      from jobs where id in (${staleId}, ${exhaustedId})
      order by id
    `;
    const byId = new Map(rows.map((row) => [row.id as string, row]));
    const stale = byId.get(staleId)!;
    expect(stale.status).toBe("pending");
    expect(stale.attempts).toBe(1); // requeue counted the crashed attempt
    expect(stale.locked_by).toBeNull();
    expect(stale.backed_off).toBe(true);
    expect(stale.last_error).toBe("stale lock requeued");
    const exhausted = byId.get(exhaustedId)!;
    expect(exhausted.status).toBe("dead");
    expect(exhausted.attempts).toBe(3);
    expect(exhausted.locked_by).toBeNull();

    await schedulerClient`update jobs set status = 'succeeded' where id = ${staleId}`;
  });

  it("keeps claiming when a stale job's requeue meets a waiting duplicate (#781)", async () => {
    // A crashed sync whose connection got a "Sync now" meanwhile: requeued
    // as pending it would be a second waiting sync (jobs_one_pending_sync).
    const [connection] = await withWorkspace(
      db,
      { workspaceId: workspaceA },
      (tx) =>
        tx
          .insert(schema.connections)
          .values({
            workspaceId: workspaceA,
            connectorId: "demo",
            name: "Stale duplicate",
          })
          .returning({ id: schema.connections.id }),
    );
    const connectionId = connection!.id;
    const stale = await seedJob({
      workspaceId: workspaceA,
      connectionId,
      kind: "connection.sync",
    });
    await schedulerClient`
      update jobs set status = 'running', locked_by = 'crashed-worker',
        locked_at = now() - interval '1 hour'
      where id = ${stale}`;
    const waiting = await seedJob({
      workspaceId: workspaceA,
      connectionId,
      kind: "connection.sync",
    });
    const other = await seedJob({ workspaceId: workspaceB });

    const claimed = (await claimJobs(schedulerDb, "w-dup", 10, 1800)).map(
      (job) => job.id,
    );
    // The queue goes on: another workspace's job is claimed.
    expect(claimed).toContain(other);
    const rows = await schedulerClient`
      select id, status, last_error, run_at > now() + interval '20 seconds' as later
      from jobs where id in (${stale}, ${waiting})`;
    const byId = new Map(rows.map((row) => [row.id as string, row]));
    expect(byId.get(stale)).toMatchObject({ status: "failed" });
    expect(String(byId.get(stale)!.last_error)).toContain("superseded");
    // The waiting sync stays, no sooner than the requeue would have run.
    expect(byId.get(waiting)).toMatchObject({ status: "pending", later: true });
    await schedulerClient`
      update jobs set status = 'succeeded' where id in (${waiting}, ${other})`;
  });

  function connectWithOAuth(
    workspaceId: string,
    names: string[],
    provider: string | null,
  ): Promise<string[]> {
    return withWorkspace(db, { workspaceId }, async (tx) => {
      const rows = await tx
        .insert(schema.connections)
        .values(
          names.map((name) => ({ workspaceId, connectorId: "demo", name })),
        )
        .returning({ id: schema.connections.id });
      if (provider) {
        await tx.insert(schema.connectionOAuth).values(
          rows.map((row, index) => ({
            connectionId: row.id,
            workspaceId,
            provider,
            accountSub: `sub-${names[index]}`,
            grantedScopes: [],
          })),
        );
      }
      return rows.map((row) => row.id);
    });
  }

  it("caps backfills per OAuth app across workspaces (#635)", async () => {
    // Three OAuth connections of one app in two workspaces, one of another
    // provider, and one with its own key.
    const [g1] = await connectWithOAuth(workspaceA, ["cap-g1"], "google");
    const [g2, g3] = await connectWithOAuth(
      workspaceB,
      ["cap-g2", "cap-g3"],
      "google",
    );
    const [other] = await connectWithOAuth(
      workspaceA,
      ["cap-other"],
      "microsoft",
    );
    const [keyed] = await connectWithOAuth(workspaceA, ["cap-key"], null);
    const backfill = (workspaceId: string, connectionId: string | undefined) =>
      seedJob({ workspaceId, kind: "connection.backfill", connectionId });
    const jobG1 = await backfill(workspaceA, g1);
    const jobG2 = await backfill(workspaceB, g2);
    const jobG3 = await backfill(workspaceB, g3);
    const jobOther = await backfill(workspaceA, other);
    const jobKeyed = await backfill(workspaceA, keyed);
    const google = [jobG1, jobG2, jobG3];
    try {
      const first = (await claimJobs(schedulerDb, "w-cap", 10, 3600, 1)).map(
        (job) => job.id,
      );
      const started = google.filter((id) => first.includes(id));
      expect(started).toHaveLength(1);
      expect(first).toEqual(expect.arrayContaining([jobOther, jobKeyed]));

      // A backfill that hands over to a continuation keeps the app's slot
      // (it is due again and goes first).
      expect(await deferJob(schedulerDb, started[0]!, "w-cap")).toBe(true);
      await schedulerClient`update jobs set run_at = now() - interval '1 second' where id = ${started[0]!}`;
      const waiting = google.filter((id) => id !== started[0]);
      const resumed = (await claimJobs(schedulerDb, "w-cap", 10, 3600, 1)).map(
        (job) => job.id,
      );
      expect(resumed).toContain(started[0]);
      expect(resumed.filter((id) => waiting.includes(id))).toEqual([]);

      // Waiting for a provider's rate-limit reset (#781), it holds no slot:
      // another workspace's backfill of the same app starts meanwhile.
      expect(
        await deferJobUntil(
          schedulerDb,
          started[0]!,
          "w-cap",
          new Date(Date.now() + 60 * 60 * 1000),
          { continuation: { syncWindow: { mode: "backfill" } } },
        ),
      ).toBe(true);
      const meanwhile = (await claimJobs(schedulerDb, "w-cap", 10, 3600, 1))
        .map((job) => job.id)
        .filter((id) => waiting.includes(id));
      expect(meanwhile).toHaveLength(1);
      // Once the reset is due it waits for a free slot again.
      await schedulerClient`update jobs set run_at = now() - interval '1 second' where id = ${started[0]!}`;
      expect(
        (await claimJobs(schedulerDb, "w-cap", 10, 3600, 1)).map(
          (job) => job.id,
        ),
      ).not.toContain(started[0]);
      await schedulerClient`update jobs set status = 'succeeded' where id = ${meanwhile[0]!}`;

      // No cap (0): the others are claimed as before.
      const uncapped = (await claimJobs(schedulerDb, "w-cap", 10, 3600, 0))
        .map((job) => job.id)
        .filter((id) => waiting.includes(id));
      expect(uncapped).toEqual(waiting.filter((id) => id !== meanwhile[0]));
    } finally {
      await schedulerClient`
        update jobs set status = 'succeeded'
        where id in (${jobG1}, ${jobG2}, ${jobG3}, ${jobOther}, ${jobKeyed})
      `;
    }
  });

  it("lets the oldest continuing backfills go first under the cap (#635)", async () => {
    const connections = await connectWithOAuth(
      workspaceA,
      ["cont-1", "cont-2", "cont-3"],
      "google",
    );
    const jobs: string[] = [];
    for (const [index, connectionId] of connections.entries()) {
      const id = await seedJob({
        workspaceId: workspaceA,
        kind: "connection.backfill",
        connectionId,
      });
      // Three backfills already continuing, e.g. after the cap was lowered.
      await schedulerClient`
        update jobs set status = 'continuing',
          created_at = now() - make_interval(mins => ${10 - index})
        where id = ${id}
      `;
      jobs.push(id);
    }
    try {
      const claimed = (await claimJobs(schedulerDb, "w-cont", 10, 3600, 2))
        .map((job) => job.id)
        .filter((id) => jobs.includes(id));
      expect(claimed.sort()).toEqual([jobs[0], jobs[1]].sort());
    } finally {
      await schedulerClient`
        update jobs set status = 'succeeded'
        where id in (${jobs[0]!}, ${jobs[1]!}, ${jobs[2]!})
      `;
    }
  });
});

const WORKER = "w-jobs";

describe("completeJob / failJob", () => {
  it("supersedes waiting backfill continuations and cancels them when their connection is deleted", async () => {
    const [connection] = await withWorkspace(
      db,
      { workspaceId: workspaceA },
      (tx) =>
        tx
          .insert(schema.connections)
          .values({
            workspaceId: workspaceA,
            connectorId: "demo",
            name: "Cancelled continuation",
          })
          .returning({ id: schema.connections.id }),
    );
    const id = connection!.id;
    const oldJob = await seedJob({
      workspaceId: workspaceA,
      connectionId: id,
      kind: "connection.backfill",
    });
    await schedulerClient`update jobs set status='continuing' where id=${oldJob}`;
    const fresh = await withWorkspace(
      db,
      { workspaceId: workspaceA },
      async (tx) => {
        expect(
          (await findBackfillingConnectionIds(tx, workspaceA)).has(id),
        ).toBe(true);
        return requestConnectionBackfill(tx, {
          workspaceId: workspaceA,
          connectionId: id,
        });
      },
    );
    expect(fresh).not.toBe(oldJob);
    const [superseded] =
      await schedulerClient`select status from jobs where id=${oldJob}`;
    expect(superseded!.status).toBe("failed");
    await schedulerClient`update jobs set status='continuing' where id=${fresh}`;
    await withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
      deleteConnection(tx, workspaceA, id),
    );
    const [cancelled] =
      await schedulerClient`select status, connection_id, last_error from jobs where id=${fresh}`;
    expect(cancelled).toMatchObject({
      status: "failed",
      connection_id: null,
      last_error: "connection deleted",
    });
    expect(
      (await claimJobs(schedulerDb, "w-deleted", 100, 3600)).some(
        (job) => job.id === fresh,
      ),
    ).toBe(false);
  });
  it("keeps a pending sync behind an active continuation without violating pending-job uniqueness", async () => {
    const [connection] = await withWorkspace(
      db,
      { workspaceId: workspaceA },
      (tx) =>
        tx
          .insert(schema.connections)
          .values({
            workspaceId: workspaceA,
            connectorId: "demo",
            name: "Continuation",
          })
          .returning({ id: schema.connections.id }),
    );
    const first = await seedJob({
      workspaceId: workspaceA,
      connectionId: connection!.id,
      kind: "connection.sync",
    });
    await claimJobs(schedulerDb, "w-initial", 100, 3600);
    const waiting = await seedJob({
      workspaceId: workspaceA,
      connectionId: connection!.id,
      kind: "connection.sync",
    });
    expect(await deferJob(schedulerDb, first, "w-initial")).toBe(true);
    await schedulerClient`update jobs set run_at=now() + interval '10 minutes' where id=${first}`;
    expect(
      (await claimJobs(schedulerDb, "w-too-early", 100, 3600)).some(
        (job) => job.connectionId === connection!.id,
      ),
    ).toBe(false);
    await schedulerClient`update jobs set run_at=now() - interval '1 second' where id=${first}`;
    const next = await claimJobs(schedulerDb, "w-continue", 100, 3600);
    expect(
      next
        .filter((job) => job.connectionId === connection!.id)
        .map((job) => job.id),
    ).toEqual([first]);
    expect(
      await failJob(schedulerDb, first, "w-continue", "transient", {
        retryable: true,
      }),
    ).toMatchObject({ status: "continuing", attempts: 1 });
    await schedulerClient`update jobs set run_at=now() - interval '1 second' where id=${first}`;
    expect(
      (await claimJobs(schedulerDb, "w-retry", 100, 3600)).some(
        (job) => job.id === first,
      ),
    ).toBe(true);
    expect(await completeJob(schedulerDb, first, "w-retry")).toBe(true);
    expect(
      (await claimJobs(schedulerDb, "w-waiting", 100, 3600)).some(
        (job) => job.id === waiting,
      ),
    ).toBe(true);
    expect(await completeJob(schedulerDb, waiting, "w-waiting")).toBe(true);
  });
  it("defers a checkpoint only under its current lease without consuming attempts or changing identity", async () => {
    const id = await seedJob({ workspaceId: workspaceA });
    await claimJobs(schedulerDb, "w-defer", 5, 3600);
    expect(
      await deferJob(schedulerDb, id, "other-worker", { cursor: "wrong" }),
    ).toBe(false);
    const beforeDefer = Date.now();
    expect(
      await deferJob(schedulerDb, id, "w-defer", { cursor: "safe-checkpoint" }),
    ).toBe(true);
    expect(await completeJob(schedulerDb, id, "w-defer")).toBe(false);
    expect(await deferJob(schedulerDb, id, "w-defer")).toBe(false);
    const [row] =
      await schedulerClient`select status, attempts, locked_by, locked_at, last_error, run_at, payload from jobs where id=${id}`;
    expect(row).toMatchObject({
      status: "continuing",
      attempts: 0,
      locked_by: null,
      locked_at: null,
      last_error: null,
      payload: {
        workspace_id: workspaceA,
        connection_id: null,
        continuation: { cursor: "safe-checkpoint" },
      },
    });
    expect(new Date(row!.run_at as string).getTime()).toBeGreaterThan(
      beforeDefer,
    );
    await schedulerClient`update jobs set run_at=now() - interval '1 second' where id=${id}`;
    const reclaimed = await claimJobs(schedulerDb, "w-next", 100, 3600);
    expect(reclaimed.some((job) => job.id === id && job.attempts === 0)).toBe(
      true,
    );
    expect(await deferJob(schedulerDb, id, "w-defer")).toBe(false);
    expect(await completeJob(schedulerDb, id, "w-next")).toBe(true);
  });
  it("defers a running sync beside a waiting one without breaking the queue (#781)", async () => {
    const [connection] = await withWorkspace(
      db,
      { workspaceId: workspaceA },
      (tx) =>
        tx
          .insert(schema.connections)
          .values({
            workspaceId: workspaceA,
            connectorId: "demo",
            name: "Deferred duplicate",
          })
          .returning({ id: schema.connections.id }),
    );
    const connectionId = connection!.id;
    const running = await seedJob({
      workspaceId: workspaceA,
      connectionId,
      kind: "connection.sync",
    });
    await claimJobs(schedulerDb, "w-defer-dup", 100, 3600);
    // "Sync now" while it runs: a second sync waits.
    const waiting = await seedJob({
      workspaceId: workspaceA,
      connectionId,
      kind: "connection.sync",
    });
    const reset = new Date(Date.now() + 30 * 60 * 1000);
    expect(
      await deferJobUntil(schedulerDb, running, "w-defer-dup", reset, {
        note: "rate limited",
      }),
    ).toBe(true);
    const rows = await schedulerClient`
      select id, status, attempts, run_at, locked_by from jobs
      where id in (${running}, ${waiting})`;
    const byId = new Map(rows.map((row) => [row.id as string, row]));
    expect(byId.get(running)).toMatchObject({
      status: "failed",
      attempts: 0,
      locked_by: null,
    });
    expect(byId.get(waiting)!.status).toBe("pending");
    expect(new Date(byId.get(waiting)!.run_at as string).getTime()).toBe(
      reset.getTime(),
    );

    // A retryable failure beside a waiting sync: the same, and the queue
    // stays claimable.
    await schedulerClient`update jobs set run_at = now() where id = ${waiting}`;
    expect(
      (await claimJobs(schedulerDb, "w-fail-dup", 100, 3600)).map(
        (job) => job.id,
      ),
    ).toContain(waiting);
    const another = await seedJob({
      workspaceId: workspaceA,
      connectionId,
      kind: "connection.sync",
    });
    expect(
      await failJob(schedulerDb, waiting, "w-fail-dup", "transient", {
        retryable: true,
      }),
    ).toMatchObject({ status: "failed", attempts: 1 });
    const [kept] =
      await schedulerClient`select status from jobs where id = ${another}`;
    expect(kept!.status).toBe("pending");
    await schedulerClient`update jobs set status = 'succeeded' where id = ${another}`;
  });

  it("completes a running job exactly once", async () => {
    const id = await seedJob({ workspaceId: workspaceA });
    await claimJobs(schedulerDb, "w-complete", 5, 3600);
    // Only the lease holder may complete it.
    expect(await completeJob(schedulerDb, id, "someone-else")).toBe(false);
    expect(await completeJob(schedulerDb, id, "w-complete")).toBe(true);
    // No longer running: a second completion is a no-op.
    expect(await completeJob(schedulerDb, id, "w-complete")).toBe(false);
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
    await claimJobs(schedulerDb, WORKER, 5, 3600);

    const first = await failJob(schedulerDb, id, WORKER, "transient: boom", {
      retryable: true,
    });
    expect(first).toMatchObject({ status: "pending", attempts: 1 });
    // 2^1 * 15s = 30s (allow generous clock slack).
    const delay1 = first!.runAt.getTime() - Date.now();
    expect(delay1).toBeGreaterThan(20_000);
    expect(delay1).toBeLessThan(40_000);

    await schedulerClient`
      update jobs set status = 'running', locked_by = ${WORKER} where id = ${id}
    `;
    const second = await failJob(
      schedulerDb,
      id,
      WORKER,
      "transient: boom again",
      {
        retryable: true,
      },
    );
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
    await claimJobs(schedulerDb, WORKER, 5, 3600);
    const first = await failJob(schedulerDb, id, WORKER, "transient: one", {
      retryable: true,
    });
    expect(first).toMatchObject({ status: "pending", attempts: 1 });
    await schedulerClient`
      update jobs set status = 'running', locked_by = ${WORKER} where id = ${id}
    `;
    const second = await failJob(schedulerDb, id, WORKER, "transient: two", {
      retryable: true,
    });
    expect(second).toMatchObject({ status: "dead", attempts: 2 });
  });

  it("sends non-retryable failures straight to dead", async () => {
    const id = await seedJob({ workspaceId: workspaceA });
    await claimJobs(schedulerDb, WORKER, 5, 3600);
    const result = await failJob(
      schedulerDb,
      id,
      WORKER,
      "contract: bad payload",
      {
        retryable: false,
      },
    );
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

    // While a sync waits, a new due slot coalesces into it (NULL)…
    expect(
      await enqueueSyncJob(schedulerDb, {
        ...input,
        idempotencyKey: `${key}:next`,
      }),
    ).toBeNull();

    // …and once it has run, the next slot enqueues a new job.
    await schedulerClient`update jobs set status = 'succeeded' where id = ${id1}`;
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

describe("enqueue_sync_job workspace check", () => {
  it("refuses to pair a connection with a foreign workspace", async () => {
    await expectDbError(
      enqueueSyncJob(schedulerDb, {
        connectionId: connectionA,
        workspaceId: workspaceB,
        kind: "connection.sync",
        runAt: new Date(),
        idempotencyKey: `sync:${connectionA}:mismatch`,
      }),
      /connection_workspace_mismatch/,
    );
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

describe("leases", () => {
  it("renewal keeps a long job from being reclaimed; loss fences the old owner", async () => {
    const id = await seedJob({ workspaceId: workspaceA });
    const [job] = await claimJobs(schedulerDb, "w-lease", 5, 3600);
    expect(job!.id).toBe(id);

    // The job has run "long": its lease is 10 minutes old.
    await schedulerClient`
      update jobs set locked_at = now() - interval '10 minutes' where id = ${id}
    `;
    // Renewing makes it current again, so a 5-minute stale scan leaves it.
    expect(await renewJobLease(schedulerDb, id, "w-lease")).toBe(true);
    expect(await claimJobs(schedulerDb, "w-other", 5, 300)).toEqual([]);

    // Without renewal the lease goes stale and the job is taken over.
    await schedulerClient`
      update jobs set locked_at = now() - interval '10 minutes', run_at = now()
      where id = ${id}
    `;
    await claimJobs(schedulerDb, "w-other", 5, 300); // requeues (backoff)
    await schedulerClient`update jobs set run_at = now() where id = ${id}`;
    const [takenOver] = await claimJobs(schedulerDb, "w-other", 5, 300);
    expect(takenOver!.id).toBe(id);

    // The original worker can neither renew, complete nor fail it now.
    expect(await renewJobLease(schedulerDb, id, "w-lease")).toBe(false);
    expect(await completeJob(schedulerDb, id, "w-lease")).toBe(false);
    expect(
      await failJob(schedulerDb, id, "w-lease", "late", { retryable: true }),
    ).toBeNull();
    expect(await completeJob(schedulerDb, id, "w-other")).toBe(true);
  });
});

describe("concurrent claims", () => {
  it("never start two jobs of one connection, even when racing", async () => {
    const [connection] = await withWorkspace(
      db,
      { workspaceId: workspaceA },
      (tx) =>
        tx
          .insert(schema.connections)
          .values({
            workspaceId: workspaceA,
            connectorId: "demo",
            name: "race",
          })
          .returning({ id: schema.connections.id }),
    );
    const connectionId = connection!.id;
    await seedJob({
      workspaceId: workspaceA,
      kind: "connection.sync",
      connectionId,
    });
    await seedJob({
      workspaceId: workspaceA,
      kind: "connection.backfill",
      connectionId,
    });
    const claimers = Array.from({ length: 8 }, (_, i) =>
      claimJobs(schedulerDb, `w-race-${i}`, 5, 3600),
    );
    const claimed = (await Promise.all(claimers)).flat();
    expect(
      claimed.filter((job) => job.connectionId === connectionId),
    ).toHaveLength(1);
    await schedulerClient`
      update jobs set status = 'succeeded' where connection_id = ${connectionId}
    `;
  });
});
