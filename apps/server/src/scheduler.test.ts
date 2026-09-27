import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDatabase,
  createRawSqlClient,
  createWorkspace,
  schema,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";

import { createScheduler, runSchedulerTick } from "./scheduler.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

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
let workspaceId: string;
let connDue: string;
let connAuthFailed: string;
let connFuture: string;

const PAST = new Date("2026-09-26T10:00:00Z");
const FUTURE = new Date("2999-01-01T00:00:00Z");

beforeAll(async () => {
  testDb = await createTestDatabase();
  appDb = createDatabase(testDb.appUrl);
  schedulerDb = createDatabase(schedulerUrlOf(testDb));
  schedulerRaw = createRawSqlClient(schedulerUrlOf(testDb), { max: 2 });

  const [user] = await appDb
    .insert(schema.users)
    .values({ email: "scheduler@example.com", displayName: "Owner" })
    .returning({ id: schema.users.id });
  workspaceId = await createWorkspace(appDb, {
    name: "Scheduler WS",
    ownerUserId: user!.id,
  });
  // The demo connector's catalog row exists already (test-db runs the
  // catalog sync like `migrate`).

  [connDue, connAuthFailed, connFuture] = await withWorkspace(
    appDb,
    { workspaceId },
    (tx) =>
      tx
        .insert(schema.connections)
        .values([
          { workspaceId, connectorId: "demo", name: "due" },
          { workspaceId, connectorId: "demo", name: "auth failed" },
          { workspaceId, connectorId: "demo", name: "future" },
        ])
        .returning({ id: schema.connections.id })
        .then((rows) => rows.map((row) => row.id)),
  );
  await withWorkspace(appDb, { workspaceId }, (tx) =>
    tx.insert(schema.connectionState).values([
      // poll interval denormalized from the manifest (120s).
      {
        connectionId: connDue!,
        workspaceId,
        nextDueAt: PAST,
        pollIntervalSeconds: 120,
      },
      {
        connectionId: connAuthFailed!,
        workspaceId,
        nextDueAt: PAST,
        authState: "auth_failed",
      },
      { connectionId: connFuture!, workspaceId, nextDueAt: FUTURE },
    ]),
  );
}, 30_000);

afterAll(async () => {
  await schedulerRaw.end({ timeout: 5 }).catch(() => undefined);
});

describe("runSchedulerTick", () => {
  it("enqueues due syncs, advances next_due_at, skips auth_failed", async () => {
    const now = new Date("2026-09-26T12:34:56.789Z");
    const result = await runSchedulerTick(schedulerDb, now);
    expect(result).toEqual({
      ran: true,
      scanned: 2,
      enqueued: 1,
      skippedAuthFailed: 1,
    });

    const jobs = await schedulerRaw`
      select kind, workspace_id, connection_id, status, payload, idempotency_key
      from jobs
    `;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      kind: "connection.sync",
      workspace_id: workspaceId,
      connection_id: connDue,
      status: "pending",
      // One job per due slot: keyed by the next_due_at being planned.
      idempotency_key: `sync:${connDue}:${PAST.toISOString()}`,
    });
    expect(jobs[0]!.payload).toEqual({
      workspace_id: workspaceId,
      connection_id: connDue,
    });

    // next_due_at advanced by the connection's poll interval; auth_failed and
    // future rows untouched.
    const states = await schedulerRaw`
      select connection_id, next_due_at from connection_state order by connection_id
    `;
    const byId = new Map(
      states.map((row) => [row.connection_id as string, row]),
    );
    // Raw timestamptz strings lose sub-second fidelity through Date.parse;
    // compare with 1s slack.
    expect(
      Math.abs(
        Date.parse(byId.get(connDue)!.next_due_at as string) -
          (now.getTime() + 120_000),
      ),
    ).toBeLessThan(1000);
    expect(Date.parse(byId.get(connAuthFailed)!.next_due_at as string)).toBe(
      PAST.getTime(),
    );
    expect(Date.parse(byId.get(connFuture)!.next_due_at as string)).toBe(
      FUTURE.getTime(),
    );
  });

  it("does not duplicate on a second tick, even when next_due_at is reset", async () => {
    const now = new Date("2026-09-26T12:34:56.789Z");
    // connDue was advanced past `now`; only the auth_failed row is still due.
    const second = await runSchedulerTick(schedulerDb, now);
    expect(second).toEqual({
      ran: true,
      scanned: 1,
      enqueued: 0,
      skippedAuthFailed: 1,
    });

    // Crash-window replay: the same due slot is planned again and dedupes.
    await schedulerRaw`
      update connection_state set next_due_at = ${PAST.toISOString()}::timestamptz
      where connection_id = ${connDue}
    `;
    const third = await runSchedulerTick(schedulerDb, now);
    expect(third).toEqual({
      ran: true,
      scanned: 2,
      enqueued: 0,
      skippedAuthFailed: 1,
    });

    const jobs = await schedulerRaw`select id from jobs`;
    expect(jobs).toHaveLength(1);
  });
});

describe("poll interval", () => {
  it("plans one sync per interval, never more than one waiting", async () => {
    // Fresh 5-minute connection, due at the start of the hour.
    const start = new Date("2026-09-27T08:00:00Z");
    const [conn] = await withWorkspace(appDb, { workspaceId }, (tx) =>
      tx
        .insert(schema.connections)
        .values({ workspaceId, connectorId: "demo", name: "every 5 min" })
        .returning({ id: schema.connections.id }),
    );
    await withWorkspace(appDb, { workspaceId }, (tx) =>
      tx.insert(schema.connectionState).values({
        connectionId: conn!.id,
        workspaceId,
        nextDueAt: start,
        pollIntervalSeconds: 300,
      }),
    );
    const syncsFor = () => schedulerRaw`
      select status from jobs where connection_id = ${conn!.id}
    `;

    // Workers keep up: each planned sync completes before the next tick.
    for (let minute = 0; minute < 60; minute += 5) {
      await runSchedulerTick(
        schedulerDb,
        new Date(start.getTime() + minute * 60_000),
      );
      await schedulerRaw`
        update jobs set status = 'succeeded'
        where connection_id = ${conn!.id} and status = 'pending'
      `;
    }
    expect(await syncsFor()).toHaveLength(12);

    // Workers are down for an hour: syncs coalesce into a single waiting job.
    const later = start.getTime() + 60 * 60_000;
    for (let minute = 0; minute < 60; minute += 5) {
      await runSchedulerTick(schedulerDb, new Date(later + minute * 60_000));
    }
    const statuses = (await syncsFor()).map((row) => row.status);
    expect(statuses.filter((status) => status === "pending")).toHaveLength(1);
    expect(statuses).toHaveLength(13);
  });
});

describe("scheduler mutual exclusion", () => {
  it("skips a tick while another instance holds the tick lock", async () => {
    const other = createRawSqlClient(schedulerUrlOf(testDb), { max: 1 });
    try {
      await other.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext('netrics.scheduler'))`;
        const blocked = await runSchedulerTick(schedulerDb);
        expect(blocked).toEqual({
          ran: false,
          scanned: 0,
          enqueued: 0,
          skippedAuthFailed: 0,
        });
      });
      // The lock ends with the other transaction; no process has to die.
      expect((await runSchedulerTick(schedulerDb)).ran).toBe(true);
    } finally {
      await other.end({ timeout: 5 }).catch(() => undefined);
    }
  });
});

describe("createScheduler loop", () => {
  it("heartbeats and ticks until stopped", async () => {
    const scheduler = createScheduler({
      schedulerDb,
      pollMs: 50,
      schedulerId: "scheduler-test",
    });
    scheduler.start();
    try {
      await waitFor(async () => {
        const rows = await schedulerRaw`
          select role from worker_heartbeats where worker_id = 'scheduler-test'
        `;
        return rows.length === 1 && rows[0]!.role === "scheduler";
      });
    } finally {
      await scheduler.stop();
    }
  });
});
