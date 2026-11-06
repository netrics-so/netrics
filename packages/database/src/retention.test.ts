import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as authSchema from "./auth-schema.js";
import { pruneHistory, type RetentionPolicy } from "./jobs.js";
import * as schema from "./schema.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

function roleUrl(base: string, role: string): string {
  const url = new URL(base);
  url.username = role;
  url.password = role;
  return url.toString();
}

const POLICY: RetentionPolicy = {
  succeededJobsDays: 7,
  failedJobsDays: 30,
  syncRunsDays: 90,
  batch: 1000,
};

let testDb: TestDatabase;
let admin: postgres.Sql;
let schedulerClient: postgres.Sql;
let appClient: postgres.Sql;
let schedulerDb: PostgresJsDatabase<typeof schema & typeof authSchema>;
let workspaceId: string;
let connectionId: string;

async function job(status: string, ageDays: number): Promise<string> {
  const [row] = await admin`
    insert into jobs (kind, status, created_at, run_at)
    values ('maintenance.test', ${status},
            now() - make_interval(days => ${ageDays}),
            now() - make_interval(days => ${ageDays}))
    returning id`;
  return row!.id as string;
}

async function syncRun(
  status: string,
  startedDaysAgo: number,
  finished: boolean,
): Promise<string> {
  const [row] = await admin`
    insert into sync_runs (workspace_id, connection_id, mode, requested_from,
      requested_to, attempt, status, started_at, finished_at)
    values (${workspaceId}, ${connectionId}, 'incremental', now(), now(), 1,
            ${status},
            now() - make_interval(days => ${startedDaysAgo}),
            ${finished ? admin`now() - make_interval(days => ${startedDaysAgo})` : null})
    returning id`;
  return row!.id as string;
}

async function remaining(table: "jobs" | "sync_runs"): Promise<string[]> {
  const rows = await admin`select id from ${admin(table)}`;
  return rows.map((row) => row.id as string);
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = postgres(testDb.adminUrl, { max: 1 });
  schedulerClient = postgres(roleUrl(testDb.adminUrl, "netrics_scheduler"), {
    max: 1,
  });
  appClient = postgres(testDb.appUrl, { max: 1 });
  schedulerDb = drizzle(schedulerClient, {
    schema: { ...schema, ...authSchema },
  });

  const [workspace] =
    await admin`insert into workspaces (name) values ('W') returning id`;
  workspaceId = workspace!.id as string;
  await admin`
    insert into connectors (id, version, manifest)
    values ('demo', '1.0.0', '{"id":"demo"}'::jsonb)
    on conflict do nothing`;
  const [connection] = await admin`
    insert into connections (workspace_id, connector_id, name)
    values (${workspaceId}, 'demo', 'C') returning id`;
  connectionId = connection!.id as string;
}, 30_000);

afterAll(async () => {
  await admin.end({ timeout: 5 }).catch(() => undefined);
  await schedulerClient.end({ timeout: 5 }).catch(() => undefined);
  await appClient.end({ timeout: 5 }).catch(() => undefined);
});

beforeEach(async () => {
  await admin`delete from jobs`;
  await admin`delete from sync_runs`;
});

describe("pruneHistory", () => {
  it("deletes finished jobs past retention and keeps everything else", async () => {
    const oldSucceeded = await job("succeeded", 8);
    const recentSucceeded = await job("succeeded", 6);
    const oldFailed = await job("failed", 31);
    const oldDead = await job("dead", 31);
    const recentDead = await job("dead", 20);
    // Unfinished work is never pruned, however old.
    const oldPending = await job("pending", 400);
    const oldRunning = await job("running", 400);

    const result = await pruneHistory(schedulerDb, POLICY);

    expect(result.jobsDeleted).toBe(3);
    const left = await remaining("jobs");
    expect(left.sort()).toEqual(
      [recentSucceeded, recentDead, oldPending, oldRunning].sort(),
    );
    for (const id of [oldSucceeded, oldFailed, oldDead]) {
      expect(left).not.toContain(id);
    }
  });

  it("keeps each connection's latest sync run, however old", async () => {
    const oldest = await syncRun("failed", 200, true);
    const old = await syncRun("succeeded", 150, true);
    const latest = await syncRun("succeeded", 120, true);

    const result = await pruneHistory(schedulerDb, POLICY);

    expect(result.syncRunsDeleted).toBe(2);
    expect(await remaining("sync_runs")).toEqual([latest]);
    expect(await remaining("sync_runs")).not.toContain(oldest);
    expect(await remaining("sync_runs")).not.toContain(old);
  });

  it("keeps recent and running sync runs", async () => {
    const running = await syncRun("running", 200, false);
    const recent = await syncRun("succeeded", 10, true);

    expect((await pruneHistory(schedulerDb, POLICY)).syncRunsDeleted).toBe(0);
    expect((await remaining("sync_runs")).sort()).toEqual(
      [running, recent].sort(),
    );
  });

  it("deletes at most one batch per call", async () => {
    for (let i = 0; i < 5; i++) {
      await job("succeeded", 30);
    }
    const policy = { ...POLICY, batch: 2 };
    expect((await pruneHistory(schedulerDb, policy)).jobsDeleted).toBe(2);
    expect((await pruneHistory(schedulerDb, policy)).jobsDeleted).toBe(2);
    expect((await pruneHistory(schedulerDb, policy)).jobsDeleted).toBe(1);
    expect(await remaining("jobs")).toEqual([]);
  });

  it("is callable by the scheduler role only", async () => {
    await expect(
      appClient`select * from prune_history('1 day', '1 day', '1 day', 1)`,
    ).rejects.toThrow(/permission denied/);
  });
});

describe("jobs.connection_id", () => {
  it("rejects a job for a connection that does not exist", async () => {
    await expect(
      admin`insert into jobs (kind, connection_id)
            values ('connection.sync', gen_random_uuid())`,
    ).rejects.toThrow(/jobs_connection_id_connections_id_fk/);
  });

  it("keeps a deleted connection's jobs as detached history", async () => {
    const [connection] = await admin`
      insert into connections (workspace_id, connector_id, name)
      values (${workspaceId}, 'demo', 'Doomed') returning id`;
    const [job] = await admin`
      insert into jobs (kind, workspace_id, connection_id, status)
      values ('connection.sync', ${workspaceId}, ${connection!.id}, 'failed')
      returning id`;
    await admin`delete from connections where id = ${connection!.id}`;
    const [left] = await admin`
      select connection_id, status from jobs where id = ${job!.id}`;
    expect(left).toMatchObject({ connection_id: null, status: "failed" });
  });
});

describe("claim_jobs running-per-connection check", () => {
  it("uses the partial index on running jobs", async () => {
    // A realistic queue: mostly finished history, a few running jobs.
    await admin`
      insert into jobs (kind, workspace_id, connection_id, status)
      select 'connection.sync', ${workspaceId}, ${connectionId},
             case when g % 500 = 0 then 'running' else 'succeeded' end
      from generate_series(1, 5000) g`;
    await admin`analyze jobs`;
    // The statement claim_jobs runs for each candidate (migration 0011).
    const plan = await admin.unsafe(
      `explain select 1 from jobs r
       where r.status = 'running'
         and r.kind like 'connection.%'
         and r.connection_id = $1`,
      [connectionId],
    );
    const text = plan.map((row) => row["QUERY PLAN"] as string).join("\n");
    expect(text).toContain("jobs_running_connection");
  });
});
