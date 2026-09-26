import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createWorkspace, withWorkspace } from "./context.js";
import * as authSchema from "./auth-schema.js";
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

  it("cannot INSERT or DELETE jobs", async () => {
    await expect(
      schedulerClient`insert into jobs (kind) values ('connection.sync')`,
    ).rejects.toThrow(/permission denied/);
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
