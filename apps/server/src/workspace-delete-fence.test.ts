import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { workspaceResponseSchema } from "@netrics/contracts";
import {
  acceptInvitation,
  adminSetDataPolicy,
  createDatabase,
  createInvitation,
  deleteWorkspace,
  createRawSqlClient,
  enqueueSyncJob,
  isDeletionOutOfTime,
  isWorkspaceDeleted,
  listDueConnections,
  setConnectionNextDue,
  withWorkspace,
  WorkspaceDeletedError,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";
import { TEST_DATABASE_SETUP_TIMEOUT_MS } from "./test-db.js";
import { createItemsFixture, type ItemsFixture } from "./test-items.js";
import { hashToken } from "./tokens.js";
import { createWorker } from "./worker.js";
import {
  createWorkspaceDeletionGate,
  type WorkspaceDeletionGate,
} from "./workspaces/deletion-gate.js";

// #839: nothing that acts for a workspace crosses its deletion. Work that
// resolved its access or read its input before the deletion committed and
// writes afterwards either commits first (the deletion waits for it and
// removes what it wrote) or finds the workspace deleted. The interleavings
// are forced with open transactions on separate connections; a step that
// must wait is observed waiting (pg_locks), never slept for.

let fixture: ItemsFixture;
let admin: Sql;
let appRaw: Sql;
let schedulerDb: Database;
let ownerId: string;

function schedulerUrlOf(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.username = "netrics_scheduler";
  url.password = "netrics_scheduler";
  return url.toString();
}

/** A promise settled from outside. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/** Sessions of this database waiting for an advisory lock (the fence). */
async function fenceWaiters(): Promise<number> {
  const [row] = await admin<{ waiting: number }[]>`
    select count(*)::int as waiting from pg_locks l
    join pg_database d on d.oid = l.database
    where d.datname = current_database()
      and l.locktype = 'advisory' and not l.granted`;
  return row!.waiting;
}

/** Resolves once `count` sessions wait for the fence. */
async function untilFenceWaiters(count: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while ((await fenceWaiters()) < count) {
    if (Date.now() > deadline) throw new Error("nothing waits for the fence");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function newWorkspace(name: string): Promise<string> {
  const created = await fixture.app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { cookie: fixture.owner },
    payload: { name },
  });
  expect(created.statusCode, created.body).toBe(200);
  return workspaceResponseSchema.parse(created.json()).workspace.id;
}

const requestDelete = (workspaceId: string, name: string) =>
  fixture.app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspaceId}/delete`,
    headers: { cookie: fixture.owner },
    payload: { name },
  });

/** delete_workspace() in an open transaction, committed by `commit()`. */
async function deleteInOpenTransaction(workspaceId: string, name: string) {
  const deleted = gate();
  const commit = gate();
  const done = appRaw.begin(async (tx) => {
    await tx`select set_config('app.workspace_id', ${workspaceId}, true),
      set_config('app.user_id', ${ownerId}, true)`;
    const [row] = await tx<{ outcome: string }[]>`
      select delete_workspace(${name}) as outcome`;
    expect(row!.outcome).toBe("deleted");
    deleted.open();
    await commit.opened;
  });
  await deleted.opened;
  return {
    commit: async () => {
      commit.open();
      await done;
    },
  };
}

const count = async (table: string, workspaceId: string) => {
  const [row] = await admin<{ count: number }[]>`
    select count(*)::int as count from ${admin(table)}
    where workspace_id = ${workspaceId}`;
  return row!.count;
};

const invitation = (workspaceId: string, tokenHash = randomUUID()) => ({
  workspaceId,
  email: `${randomUUID()}@example.com`,
  role: "viewer",
  tokenHash,
  delivery: "manual" as const,
  invitedByUserId: ownerId,
  expiresAt: new Date(Date.now() + 3_600_000),
});

/** A workspace with the demo connection, due for a sync. */
async function workspaceWithDueConnection(name: string) {
  const workspaceId = await newWorkspace(name);
  const demo = await fixture.call("POST", `/v1/workspaces/${workspaceId}/demo`);
  expect(demo.statusCode, demo.body).toBe(200);
  // Its first backfill is not this test's subject.
  await admin`
    update jobs set status = 'succeeded' where workspace_id = ${workspaceId}`;
  const [state] = await admin<{ connection_id: string }[]>`
    update connection_state set next_due_at = now() - interval '1 minute'
    where workspace_id = ${workspaceId} returning connection_id`;
  return { workspaceId, connectionId: state!.connection_id };
}

const liveJobs = async (workspaceId: string) => {
  const [row] = await admin<{ live: number }[]>`
    select count(*)::int as live from jobs
    where workspace_id = ${workspaceId}
      and status in ('pending', 'running', 'continuing')`;
  return row!.live;
};

const nextDue = async (connectionId: string) => {
  const [row] = await admin<{ next_due_at: Date | null }[]>`
    select next_due_at from connection_state
    where connection_id = ${connectionId}`;
  return row!.next_due_at;
};

beforeAll(async () => {
  fixture = await createItemsFixture("wsfence");
  admin = fixture.admin;
  appRaw = createRawSqlClient(fixture.testDb.appUrl, { max: 4 });
  schedulerDb = createDatabase(schedulerUrlOf(fixture.testDb.adminUrl));
  const [owner] = await admin<{ id: string }[]>`
    select id from users where email = 'wsfence-owner@example.com'`;
  ownerId = owner!.id;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await appRaw?.end({ timeout: 5 }).catch(() => undefined);
  await schedulerDb?.$client.end({ timeout: 5 }).catch(() => undefined);
  await fixture?.close();
});

describe("an invitation across the deletion (review finding 1)", () => {
  it("a request that is writing when the deletion starts commits first, and the deletion removes its invitation", async () => {
    const workspaceId = await newWorkspace("Writer first");
    const inside = gate();
    const go = gate();
    const writer = withWorkspace(
      fixture.db,
      { workspaceId, userId: ownerId },
      async (tx) => {
        inside.open();
        await go.opened;
        return createInvitation(tx, invitation(workspaceId));
      },
    );
    await inside.opened;
    const deletion = requestDelete(workspaceId, "Writer first");
    // The deletion waits for the open tenant transaction.
    await untilFenceWaiters(1);
    expect(await count("memberships", workspaceId)).toBe(1);
    go.open();
    await writer;
    expect((await deletion).statusCode).toBe(204);
    expect(await count("invitations", workspaceId)).toBe(0);
    expect(await count("memberships", workspaceId)).toBe(0);
  });

  it("a request that resolved its access before the deletion cannot create an invitation after it", async () => {
    const workspaceId = await newWorkspace("Deletion first");
    // Access resolved: the owner is a member.
    expect(await count("memberships", workspaceId)).toBe(1);
    expect(
      (await requestDelete(workspaceId, "Deletion first")).statusCode,
    ).toBe(204);
    let ran = false;
    const late = withWorkspace(
      fixture.db,
      { workspaceId, userId: ownerId },
      (tx) => {
        ran = true;
        return createInvitation(tx, invitation(workspaceId));
      },
    );
    await expect(late).rejects.toBeInstanceOf(WorkspaceDeletedError);
    expect(ran).toBe(false);
    expect(await count("invitations", workspaceId)).toBe(0);
  });

  it("an invitation request arriving while the deletion commits is answered 404 and creates nothing", async () => {
    const workspaceId = await newWorkspace("During");
    const deletion = await deleteInOpenTransaction(workspaceId, "During");
    // The deletion has not committed: its membership delete is invisible
    // to others, so only the fence keeps the request from going ahead.
    const request = fixture.app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/invitations`,
      headers: { cookie: fixture.owner },
      payload: { email: "during@example.com", role: "viewer" },
    });
    await untilFenceWaiters(1);
    await deletion.commit();
    const response = await request;
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toEqual({ error: "workspace_not_found" });
    expect(await count("invitations", workspaceId)).toBe(0);
  });

  it("an acceptance in flight commits first and loses its membership; one after the deletion finds no invitation", async () => {
    const workspaceId = await newWorkspace("Accept");
    const invitee = `${randomUUID()}@example.com`;
    await fixture.signUp(invitee);
    const [user] = await admin<{ id: string }[]>`
      select id from users where email = ${invitee}`;
    const invited = await fixture.app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/invitations`,
      headers: { cookie: fixture.owner },
      payload: { email: invitee, role: "admin" },
    });
    expect(invited.statusCode, invited.body).toBe(200);
    const token = new URL(invited.json().inviteUrl as string).pathname
      .split("/")
      .pop()!;

    const accepted = gate();
    const go = gate();
    const accepting = fixture.db.transaction(async (tx) => {
      await acceptInvitation(tx, hashToken(token), user!.id);
      accepted.open();
      await go.opened;
    });
    await accepted.opened;
    const deletion = requestDelete(workspaceId, "Accept");
    await untilFenceWaiters(1);
    go.open();
    await accepting;
    expect((await deletion).statusCode).toBe(204);
    expect(await count("memberships", workspaceId)).toBe(0);

    await expect(
      acceptInvitation(fixture.db, hashToken(token), user!.id),
    ).rejects.toMatchObject({ reason: "invitation_not_found" });
    expect(await count("memberships", workspaceId)).toBe(0);
  });
});

describe("the scheduler's tick across the deletion (review finding 2)", () => {
  it("a tick that read a due connection before the deletion neither queues a sync nor schedules the next one after it", async () => {
    const { workspaceId, connectionId } =
      await workspaceWithDueConnection("Tick late");
    const now = new Date();
    await schedulerDb.transaction(async (tx) => {
      const due = (await listDueConnections(tx, now)).filter(
        (connection) => connection.workspaceId === workspaceId,
      );
      expect(due.map((connection) => connection.connectionId)).toEqual([
        connectionId,
      ]);
      // The deletion commits while the tick holds what it read.
      expect((await requestDelete(workspaceId, "Tick late")).statusCode).toBe(
        204,
      );
      const jobId = await enqueueSyncJob(tx, {
        connectionId,
        workspaceId,
        kind: "connection.sync",
        runAt: now,
        idempotencyKey: `sync:${connectionId}:${due[0]!.nextDueAt!.toISOString()}`,
      });
      expect(jobId).toBeNull();
      await setConnectionNextDue(
        tx,
        connectionId,
        new Date(now.getTime() + 300_000),
      );
    });
    expect(await liveJobs(workspaceId)).toBe(0);
    expect(await nextDue(connectionId)).toBeNull();
  });

  it("a tick that queued the sync before the deletion commits first, and the deletion ends the sync and the schedule", async () => {
    const { workspaceId, connectionId } =
      await workspaceWithDueConnection("Tick first");
    const now = new Date();
    const queued = gate();
    const go = gate();
    const tick = schedulerDb.transaction(async (tx) => {
      const jobId = await enqueueSyncJob(tx, {
        connectionId,
        workspaceId,
        kind: "connection.sync",
        runAt: now,
        idempotencyKey: `sync:${connectionId}:first`,
      });
      expect(jobId).not.toBeNull();
      await setConnectionNextDue(
        tx,
        connectionId,
        new Date(now.getTime() + 300_000),
      );
      queued.open();
      await go.opened;
    });
    await queued.opened;
    const deletion = requestDelete(workspaceId, "Tick first");
    await untilFenceWaiters(1);
    go.open();
    await tick;
    expect((await deletion).statusCode).toBe(204);
    expect(await liveJobs(workspaceId)).toBe(0);
    expect(await nextDue(connectionId)).toBeNull();
  });
});

describe("transactions of other isolation levels", () => {
  it("a repeatable-read transaction whose snapshot predates the deletion does not run", async () => {
    const workspaceId = await newWorkspace("Snapshot");
    const deletion = await deleteInOpenTransaction(workspaceId, "Snapshot");
    let ran = false;
    const late = withWorkspace(
      fixture.db,
      { workspaceId },
      async () => {
        ran = true;
      },
      { isolationLevel: "repeatable read" },
    );
    // Its first statement took the snapshot and waits for the fence.
    await untilFenceWaiters(1);
    await deletion.commit();
    // The fence answered from the old snapshot; the row lock did not.
    await expect(late).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "40001" }),
    });
    expect(ran).toBe(false);
  });

  it("concurrent tenant transactions do not wait for each other", async () => {
    const workspaceId = await newWorkspace("Shared");
    const first = gate();
    const go = gate();
    const holder = withWorkspace(fixture.db, { workspaceId }, async () => {
      first.open();
      await go.opened;
    });
    await first.opened;
    for (const isolationLevel of [
      "read committed",
      "repeatable read",
      "serializable",
    ] as const) {
      await withWorkspace(
        fixture.db,
        { workspaceId },
        (tx) => tx.execute(sql`select 1`),
        { isolationLevel },
      );
    }
    expect(await fenceWaiters()).toBe(0);
    go.open();
    await holder;
  });

  it("two deletions of one workspace do not deadlock: one deletes, the other finds nothing", async () => {
    const workspaceId = await newWorkspace("Twice");
    const responses = await Promise.all([
      requestDelete(workspaceId, "Twice"),
      requestDelete(workspaceId, "Twice"),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      204, 404,
    ]);
  });

  it("a deletion that cannot get the fence gives up without deleting (409)", async () => {
    const workspaceId = await newWorkspace("Busy");
    const inside = gate();
    const go = gate();
    const holder = withWorkspace(fixture.db, { workspaceId }, async () => {
      inside.open();
      await go.opened;
    });
    await inside.opened;
    // The deletion's own wait, shortened for the test.
    const outcome = appRaw.begin(async (tx) => {
      await tx`select set_config('app.workspace_id', ${workspaceId}, true),
        set_config('app.user_id', ${ownerId}, true)`;
      await tx`select set_config('lock_timeout', '50ms', true)`;
      await tx`select pg_advisory_xact_lock(
        hashtext('netrics.workspace_fence'), hashtext(${workspaceId}))`;
    });
    await expect(outcome).rejects.toMatchObject({ code: "55P03" });
    go.open();
    await holder;
    expect(await count("memberships", workspaceId)).toBe(1);
  });
});

// #855: an owner's only workspace is not deleted. Each deletion holds only
// its own workspace's fence, so two deletions by one user, of that user's
// last two workspaces (or by two co-owners of the same two), are ordered by
// one lock for all deletions, taken before the fence: exactly one deletes,
// the other is refused, and neither waits for something the other needs.
describe("deletions that depend on each other's workspace (#855)", () => {
  /** A new user with exactly two workspaces. */
  async function userWithTwo(label: string) {
    const email = `wsfence-${label}@example.com`;
    const cookie = await fixture.signUp(email);
    const [user] = await admin<{ id: string }[]>`
      select id from users where email = ${email}`;
    const create = async (name: string) => {
      const created = await fixture.app.inject({
        method: "POST",
        url: "/v1/workspaces",
        headers: { cookie },
        payload: { name },
      });
      expect(created.statusCode, created.body).toBe(200);
      return workspaceResponseSchema.parse(created.json()).workspace.id;
    };
    return {
      cookie,
      userId: user!.id,
      a: await create(`${label} A`),
      b: await create(`${label} B`),
    };
  }

  /**
   * delete_workspace() as `userId` in an open transaction: `outcome`
   * settles when the function answers, the transaction ends with `finish`.
   */
  function openDeletion(userId: string, workspaceId: string, name: string) {
    const answered = gate();
    const end = gate();
    let outcome: string | undefined;
    let rollBack = false;
    const done = appRaw
      .begin(async (tx) => {
        await tx`select set_config('app.workspace_id', ${workspaceId}, true),
          set_config('app.user_id', ${userId}, true)`;
        try {
          const [row] = await tx<{ outcome: string }[]>`
            select delete_workspace(${name}) as outcome`;
          outcome = row!.outcome;
        } finally {
          answered.open();
        }
        await end.opened;
        if (rollBack) throw new Error("rolled back by the test");
      })
      .then(
        () => ({ outcome, error: null as unknown }),
        (error: unknown) => ({ outcome, error }),
      );
    return {
      answered: answered.opened,
      finish: async (how: "commit" | "rollback" = "commit") => {
        rollBack = how === "rollback";
        end.open();
        return done;
      },
      done,
    };
  }

  const live = async (userId: string) => {
    const rows = await admin<{ id: string }[]>`
      select w.id from memberships m join workspaces w on w.id = m.workspace_id
      where m.user_id = ${userId} and w.deleted_at is null`;
    return rows.map((row) => row.id);
  };

  it("the second waits for the first to commit and is then refused; it does not hold its workspace's fence while it waits", async () => {
    const user = await userWithTwo("pair");
    const first = openDeletion(user.userId, user.a, "pair A");
    await first.answered;
    // Uncommitted: for everyone else both workspaces are still live.
    expect((await live(user.userId)).sort()).toEqual([user.a, user.b].sort());

    const second = openDeletion(user.userId, user.b, "pair B");
    // It waits for the deletion lock ...
    await untilFenceWaiters(1);
    // ... and not on, or with, the fence of its own workspace: work for
    // that workspace goes on meanwhile.
    await withWorkspace(fixture.db, { workspaceId: user.b }, (tx) =>
      tx.execute(sql`select 1`),
    );
    expect(await fenceWaiters()).toBe(1);

    expect((await first.finish()).error).toBeNull();
    await second.answered;
    const refused = await second.finish();
    expect(refused.outcome).toBeUndefined();
    expect(refused.error).toMatchObject({ code: "WS002" });
    expect(await live(user.userId)).toEqual([user.b]);
    expect(await fenceWaiters()).toBe(0);
  });

  it("the second deletes when the first rolls back", async () => {
    const user = await userWithTwo("undo");
    const first = openDeletion(user.userId, user.a, "undo A");
    await first.answered;
    const second = openDeletion(user.userId, user.b, "undo B");
    await untilFenceWaiters(1);
    expect((await first.finish("rollback")).error).not.toBeNull();
    await second.answered;
    expect(await second.finish()).toEqual({ outcome: "deleted", error: null });
    expect(await live(user.userId)).toEqual([user.a]);
  });

  it("a deletion that waits for work in its workspace does not let the other one through", async () => {
    // The first holds the deletion lock while it waits for its fence; the
    // second queues behind it and is refused once the first has deleted.
    const user = await userWithTwo("held");
    const inside = gate();
    const go = gate();
    const work = withWorkspace(
      fixture.db,
      { workspaceId: user.a },
      async () => {
        inside.open();
        await go.opened;
      },
    );
    await inside.opened;
    const first = openDeletion(user.userId, user.a, "held A");
    await untilFenceWaiters(1);
    const second = openDeletion(user.userId, user.b, "held B");
    await untilFenceWaiters(2);
    go.open();
    await work;
    await first.answered;
    expect(await first.finish()).toEqual({ outcome: "deleted", error: null });
    expect((await second.finish()).error).toMatchObject({ code: "WS002" });
    expect(await live(user.userId)).toEqual([user.b]);
  });

  /** Two users who own the same two workspaces and nothing else. */
  async function coOwners(label: string) {
    const one = await userWithTwo(`${label}-one`);
    const email = `wsfence-${label}-two@example.com`;
    const cookie = await fixture.signUp(email);
    const [user] = await admin<{ id: string }[]>`
      select id from users where email = ${email}`;
    await admin`
      insert into memberships (workspace_id, user_id, role)
      values (${one.a}, ${user!.id}, 'owner'), (${one.b}, ${user!.id}, 'owner')`;
    return { one, two: { cookie, userId: user!.id }, a: one.a, b: one.b };
  }

  it("two co-owners of the same two workspaces each delete a different one: the second waits and is refused", async () => {
    // Without an order between them each would count the other's
    // workspace as live, both would delete, and both would be left with
    // none: a result neither order of the two deletions allows.
    const pair = await coOwners("co");
    const first = openDeletion(pair.one.userId, pair.a, "co-one A");
    await first.answered;
    const second = openDeletion(pair.two.userId, pair.b, "co-one B");
    await untilFenceWaiters(1);
    // It waits holding nothing: its workspace is not stalled.
    await withWorkspace(fixture.db, { workspaceId: pair.b }, (tx) =>
      tx.execute(sql`select 1`),
    );
    expect(await fenceWaiters()).toBe(1);
    expect(await first.finish()).toEqual({ outcome: "deleted", error: null });
    await second.answered;
    const refused = await second.finish();
    expect(refused.outcome).toBeUndefined();
    expect(refused.error).toMatchObject({ code: "WS002" });
    expect(await live(pair.one.userId)).toEqual([pair.b]);
    expect(await live(pair.two.userId)).toEqual([pair.b]);
    expect(await fenceWaiters()).toBe(0);
  });

  it("two co-owners through the API: one 204, the other workspace_last", async () => {
    const pair = await coOwners("co-api");
    const request = (cookie: string, workspaceId: string, name: string) =>
      fixture.app.inject({
        method: "POST",
        url: `/v1/workspaces/${workspaceId}/delete`,
        headers: { cookie },
        payload: { name },
      });
    const responses = await Promise.all([
      request(pair.one.cookie, pair.a, "co-api-one A"),
      request(pair.two.cookie, pair.b, "co-api-one B"),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      204, 409,
    ]);
    const refused = responses.find((response) => response.statusCode === 409)!;
    expect(refused.json()).toEqual({ error: "workspace_last" });
    const left = await live(pair.one.userId);
    expect(left).toHaveLength(1);
    expect(await live(pair.two.userId)).toEqual(left);
  });

  it("deletions by users who share nothing queue too, and both delete", async () => {
    // One order for every deletion of the installation: the second waits
    // for the first to end, then finds its own other workspace live.
    const one = await userWithTwo("apart-one");
    const two = await userWithTwo("apart-two");
    const first = openDeletion(one.userId, one.a, "apart-one A");
    await first.answered;
    const second = openDeletion(two.userId, two.a, "apart-two A");
    await untilFenceWaiters(1);
    expect(await first.finish()).toEqual({ outcome: "deleted", error: null });
    await second.answered;
    expect(await second.finish()).toEqual({ outcome: "deleted", error: null });
    expect(await live(one.userId)).toEqual([one.b]);
    expect(await live(two.userId)).toEqual([two.b]);
  });

  it("through the API: exactly one of the two requests deletes", async () => {
    const user = await userWithTwo("api");
    const request = (workspaceId: string, name: string) =>
      fixture.app.inject({
        method: "POST",
        url: `/v1/workspaces/${workspaceId}/delete`,
        headers: { cookie: user.cookie },
        payload: { name },
      });
    const responses = await Promise.all([
      request(user.a, "api A"),
      request(user.b, "api B"),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      204, 409,
    ]);
    const refused = responses.find((response) => response.statusCode === 409)!;
    expect(refused.json()).toEqual({ error: "workspace_last" });
    expect(await live(user.userId)).toHaveLength(1);
  });
});

// #855: deletions take turns (one lock for the installation), and one that
// waits holds its database connection. The API therefore queues deletion
// requests in its own process BEFORE it takes a connection: however many
// arrive, at most one connection of the pool waits for a deletion.
describe("deletion requests queue without a database connection (#855)", () => {
  const REQUESTS = 6;

  /** An API of its own on the fixture's database, with a small pool. */
  async function apiWith(deletions: WorkspaceDeletionGate, max = 2) {
    const db = createDatabase(fixture.testDb.appUrl, { max });
    const config = loadConfig({
      DATABASE_URL: fixture.testDb.appUrl,
      LOG_LEVEL: "silent",
      BETTER_AUTH_URL: "http://localhost:3001",
      WEB_ORIGIN: "http://localhost:3000",
    });
    const app = await buildApp(config, {
      db,
      authService: createAuthService(config, db, {
        logger: pino({ level: "silent" }),
      }),
      checkDb: async () => true,
      workspaceDeletionGate: deletions,
    });
    return {
      app,
      db,
      close: async () => {
        await app.close();
        await db.$client.end({ timeout: 5 });
      },
    };
  }

  /** A new user with `count` workspaces named "<label> 0", "<label> 1", ... */
  async function userWith(label: string, count: number) {
    const email = `wsfence-${label}@example.com`;
    const cookie = await fixture.signUp(email);
    const [user] = await admin<{ id: string }[]>`
      select id from users where email = ${email}`;
    const workspaces: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const created = await fixture.app.inject({
        method: "POST",
        url: "/v1/workspaces",
        headers: { cookie },
        payload: { name: `${label} ${index}` },
      });
      expect(created.statusCode, created.body).toBe(200);
      workspaces.push(
        workspaceResponseSchema.parse(created.json()).workspace.id,
      );
    }
    return { cookie, userId: user!.id, workspaces };
  }

  /** The application role's sessions that are doing or holding something. */
  async function busySessions(): Promise<number> {
    const [row] = await admin<{ busy: number }[]>`
      select count(*)::int as busy from pg_stat_activity
      where datname = current_database() and usename = 'netrics_app'
        and state <> 'idle'`;
    return row!.busy;
  }

  async function untilQueued(deletions: WorkspaceDeletionGate, count: number) {
    const deadline = Date.now() + 15_000;
    while (deletions.waiting < count) {
      if (Date.now() > deadline) throw new Error("requests did not queue");
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  const liveOf = async (userId: string) => {
    const [row] = await admin<{ live: number }[]>`
      select count(*)::int as live from memberships m
      join workspaces w on w.id = m.workspace_id
      where m.user_id = ${userId} and w.deleted_at is null`;
    return row!.live;
  };

  it("with the gate held, waiting requests hold no connection, other requests are answered, and the waiters give up after the budget", async () => {
    const deletions = createWorkspaceDeletionGate({ budgetMs: 400 });
    const api = await apiWith(deletions);
    try {
      const user = await userWith("gate", REQUESTS + 1);
      const remove = (index: number) =>
        api.app.inject({
          method: "POST",
          url: `/v1/workspaces/${user.workspaces[index]}/delete`,
          headers: { cookie: user.cookie },
          payload: { name: `gate ${index}` },
        });
      const hold = gate();
      const holder = deletions.run(() => hold.opened);
      const waiting = Array.from({ length: REQUESTS }, (_, index) =>
        remove(index),
      );
      await untilQueued(deletions, REQUESTS);
      // More requests wait than the pool has connections, and none of them
      // holds one: nothing of the application runs or waits in the database.
      expect(await busySessions()).toBe(0);
      expect(await fenceWaiters()).toBe(0);
      for (let index = 0; index < 4; index += 1) {
        const read = await api.app.inject({
          method: "GET",
          url: "/v1/workspaces",
          headers: { cookie: user.cookie },
        });
        expect(read.statusCode, read.body).toBe(200);
      }
      const responses = await Promise.all(waiting);
      for (const response of responses) {
        expect(response.statusCode, response.body).toBe(409);
        expect(response.json()).toEqual({ error: "workspace_busy" });
      }
      expect(deletions.waiting).toBe(0);
      expect(await liveOf(user.userId)).toBe(REQUESTS + 1);
      // Free again: the next request deletes.
      hold.open();
      await holder;
      expect((await remove(0)).statusCode).toBe(204);
      expect(deletions.held).toBe(false);
    } finally {
      await api.close();
    }
  });

  it("while one deletion waits for work in its workspace, the others wait outside the database and then all delete", async () => {
    const deletions = createWorkspaceDeletionGate();
    const api = await apiWith(deletions);
    try {
      const user = await userWith("burst", REQUESTS + 2);
      const remove = (index: number) =>
        api.app.inject({
          method: "POST",
          url: `/v1/workspaces/${user.workspaces[index]}/delete`,
          headers: { cookie: user.cookie },
          payload: { name: `burst ${index}` },
        });
      // Work in the first workspace, on a connection of another pool.
      const inside = gate();
      const go = gate();
      const work = withWorkspace(
        fixture.db,
        { workspaceId: user.workspaces[0]! },
        async () => {
          inside.open();
          await go.opened;
        },
      );
      await inside.opened;
      const first = remove(0);
      await untilFenceWaiters(1);
      const others = Array.from({ length: REQUESTS }, (_, index) =>
        remove(index + 1),
      );
      await untilQueued(deletions, REQUESTS);
      // One session waits in the database (the first deletion, for its
      // fence); the six behind it wait in the process.
      expect(await fenceWaiters()).toBe(1);
      // The pool of two still serves requests that are no deletion.
      for (let index = 0; index < 4; index += 1) {
        const read = await api.app.inject({
          method: "GET",
          url: `/v1/workspaces/${user.workspaces[REQUESTS + 1]}`,
          headers: { cookie: user.cookie },
        });
        expect(read.statusCode, read.body).toBe(200);
      }
      expect(await fenceWaiters()).toBe(1);
      go.open();
      await work;
      for (const response of [await first, ...(await Promise.all(others))]) {
        expect(response.statusCode, response.body).toBe(204);
      }
      expect(await liveOf(user.userId)).toBe(1);
      expect(deletions.held).toBe(false);
    } finally {
      await api.close();
    }
  });

  it("the gate is free again after a deletion that was refused", async () => {
    const deletions = createWorkspaceDeletionGate();
    const api = await apiWith(deletions);
    try {
      const user = await userWith("refused", 2);
      const remove = (index: number, name: string) =>
        api.app.inject({
          method: "POST",
          url: `/v1/workspaces/${user.workspaces[index]}/delete`,
          headers: { cookie: user.cookie },
          payload: { name },
        });
      expect((await remove(0, "wrong")).statusCode).toBe(400);
      expect(deletions.held).toBe(false);
      expect((await remove(0, "refused 0")).statusCode).toBe(204);
      // The database's refusal is an error inside the gate.
      const last = await remove(1, "refused 1");
      expect(last.statusCode).toBe(409);
      expect(last.json()).toEqual({ error: "workspace_last" });
      expect(deletions.held).toBe(false);
      expect(deletions.waiting).toBe(0);
    } finally {
      await api.close();
    }
  });

  // One deadline, fixed when the request reaches the gate: whatever a
  // deletion request then waits for, it is answered by the deadline (plus
  // the time to answer), with 204 or workspace_busy, and a request that was
  // answered workspace_busy deletes nothing, then or later.
  describe("one deadline for everything a deletion request waits for", () => {
    const BUDGET_MS = 600;
    const TOLERANCE_MS = 500;
    let holders: Sql;

    beforeAll(() => {
      // Sessions that hold locks open (the admin client has one connection).
      holders = createRawSqlClient(fixture.testDb.adminUrl, {
        max: 2,
        onnotice: () => undefined,
      });
    });
    afterAll(async () => {
      await holders?.end({ timeout: 5 }).catch(() => undefined);
    });

    /** Holds what `take` locks in an open transaction until released. */
    async function holdOpen(
      take: (tx: Sql) => Promise<unknown>,
    ): Promise<() => Promise<void>> {
      const taken = gate();
      const let_go = gate();
      const done = holders.begin(async (tx) => {
        await take(tx as unknown as Sql);
        taken.open();
        await let_go.opened;
      });
      await taken.opened;
      return async () => {
        let_go.open();
        await done;
      };
    }

    type Api = Awaited<ReturnType<typeof apiWith>>;
    interface Contention {
      /** Before the request is sent; answers how to end the contention. */
      before?: (
        workspaceId: string,
        api: Api,
        deletions: WorkspaceDeletionGate,
      ) => Promise<() => Promise<void>>;
      /** With the request waiting at the gate (held for this by the test). */
      atGate?: (api: Api) => Promise<() => Promise<void>>;
    }

    const kinds: Array<[string, Contention]> = [
      [
        "the gate (another deletion of this process)",
        {
          before: async (_workspaceId, _api, deletions) => {
            const hold = gate();
            const holder = deletions.run(() => hold.opened);
            return async () => {
              hold.open();
              await holder;
            };
          },
        },
      ],
      [
        "the pool (its only connection is in use)",
        {
          atGate: async (api) => {
            const inside = gate();
            const hold = gate();
            const user = api.db.transaction(async (tx) => {
              await tx.execute(sql`select 1`);
              inside.open();
              await hold.opened;
            });
            await inside.opened;
            return async () => {
              hold.open();
              await user;
            };
          },
        },
      ],
      [
        "the installation's deletion lock (a deletion of another process)",
        {
          before: () =>
            holdOpen(
              (tx) => tx`select pg_advisory_xact_lock(
                hashtext('netrics.workspace_delete'), 0)`,
            ),
        },
      ],
      [
        "the fence (work in the workspace)",
        {
          before: async (workspaceId) => {
            const inside = gate();
            const hold = gate();
            const work = withWorkspace(
              fixture.db,
              { workspaceId },
              async () => {
                inside.open();
                await hold.opened;
              },
            );
            await inside.opened;
            return async () => {
              hold.open();
              await work;
            };
          },
        },
      ],
      [
        "a row lock (a worker holds a job of the workspace)",
        {
          before: async (workspaceId) => {
            await admin`
              insert into jobs (kind, workspace_id, payload)
              values ('netrics.noop', ${workspaceId},
                ${admin.json({ workspace_id: workspaceId, connection_id: null })})`;
            return holdOpen(
              (tx) => tx`select id from jobs
                where workspace_id = ${workspaceId} for update`,
            );
          },
        },
      ],
    ];

    it.each(kinds)("held up by %s", async (label, contention) => {
      const deletions = createWorkspaceDeletionGate({ budgetMs: BUDGET_MS });
      const api = await apiWith(deletions, 1);
      try {
        const slug = `deadline-${kinds.findIndex(([name]) => name === label)}`;
        const user = await userWith(slug, 2);
        const workspaceId = user.workspaces[0]!;
        const remove = () =>
          api.app.inject({
            method: "POST",
            url: `/v1/workspaces/${workspaceId}/delete`,
            headers: { cookie: user.cookie },
            payload: { name: `${slug} 0` },
          });
        const state = async () => {
          const [row] = await admin<{ deleted: boolean; events: number }[]>`
            select w.deleted_at is not null as deleted,
              (select count(*)::int from audit_events
               where action = 'workspace.deleted' and target = w.id::text) as events
            from workspaces w where w.id = ${workspaceId}`;
          return row;
        };
        const untilFree = async () => {
          const deadline = Date.now() + 15_000;
          while (deletions.held || deletions.waiting > 0) {
            if (Date.now() > deadline) throw new Error("the gate stayed held");
            await new Promise((resolve) => setImmediate(resolve));
          }
        };

        let release = contention.before
          ? await contention.before(workspaceId, api, deletions)
          : async () => {};
        let started: number;
        let pending: ReturnType<typeof remove>;
        if (contention.atGate) {
          // The contention begins after the request passed its access
          // check: it is held at the gate meanwhile.
          const hold = gate();
          const holder = deletions.run(() => hold.opened);
          started = performance.now();
          pending = remove();
          await untilQueued(deletions, 1);
          release = await contention.atGate(api);
          hold.open();
          await holder;
        } else {
          started = performance.now();
          pending = remove();
        }

        // Answered by the deadline, and told that nothing was deleted.
        const response = await pending;
        const took = performance.now() - started;
        expect(response.statusCode, response.body).toBe(409);
        expect(response.json()).toEqual({ error: "workspace_busy" });
        expect(took).toBeLessThan(BUDGET_MS + TOLERANCE_MS);
        expect(await state()).toEqual({ deleted: false, events: 0 });

        // The contention ends after the deadline: still nothing is deleted,
        // by whatever of the request was left waiting.
        await release();
        await untilFree();
        expect(await fenceWaiters()).toBe(0);
        expect(await state()).toEqual({ deleted: false, events: 0 });

        // Without contention the same request deletes, within the budget.
        const again = performance.now();
        const deleted = await remove();
        expect(deleted.statusCode, deleted.body).toBe(204);
        expect(performance.now() - again).toBeLessThan(
          BUDGET_MS + TOLERANCE_MS,
        );
        expect(await state()).toEqual({ deleted: true, events: 1 });
      } finally {
        await api.close();
      }
    });
  });

  it("a row lock held past the deadline ends the deletion and frees the deletion lock for others", async () => {
    const workspaceId = await newWorkspace("Row held");
    const other = await newWorkspace("Row free");
    await admin`
      insert into jobs (kind, workspace_id, payload)
      values ('netrics.noop', ${workspaceId},
        ${admin.json({ workspace_id: workspaceId, connection_id: null })})`;
    const held = gate();
    const go = gate();
    const worker = appRaw.begin(async (tx) => {
      await tx`select set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`select id from jobs where workspace_id = ${workspaceId}
        for update`;
      held.open();
      await go.opened;
    });
    await held.opened;
    const remove = (id: string, name: string, waitMs: number) =>
      withWorkspace(
        fixture.db,
        { workspaceId: id, userId: ownerId },
        (tx) => deleteWorkspace(tx, name, { waitMs }),
        { fence: "none", isolationLevel: "read committed" },
      );
    const started = performance.now();
    const failure = await remove(workspaceId, "Row held", 100).then(
      () => null,
      (error: unknown) => error,
    );
    expect(isDeletionOutOfTime(failure), String(failure)).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_000);
    // Rolled back whole: not marked, members and the job as they were.
    const [row] = await admin`
      select deleted_at from workspaces where id = ${workspaceId}`;
    expect(row!.deleted_at).toBeNull();
    expect(await count("memberships", workspaceId)).toBe(1);
    expect(await liveJobs(workspaceId)).toBe(1);
    // The deletion lock went with it: another workspace's deletion runs
    // while the row is still held.
    expect(await remove(other, "Row free", 5_000)).toBe("deleted");
    go.open();
    await worker;
    expect(await remove(workspaceId, "Row held", 5_000)).toBe("deleted");
  });

  it("gives the caller's lock_timeout back when it returns", async () => {
    const workspaceId = await newWorkspace("Timeouts");
    const outcome = await appRaw.begin(async (tx) => {
      await tx`select set_config('app.workspace_id', ${workspaceId}, true),
        set_config('app.user_id', ${ownerId}, true),
        set_config('lock_timeout', '1234ms', true)`;
      const [wrong] = await tx<{ outcome: string }[]>`
        select delete_workspace('not its name') as outcome`;
      const [after] = await tx<{ value: string }[]>`
        select current_setting('lock_timeout') as value`;
      return { wrong: wrong!.outcome, lockTimeout: after!.value };
    });
    expect(outcome).toEqual({ wrong: "name_mismatch", lockTimeout: "1234ms" });
  });

  it("the database waits only as long as its caller has left", async () => {
    const workspaceId = await newWorkspace("Left over");
    const inside = gate();
    const go = gate();
    const work = withWorkspace(fixture.db, { workspaceId }, async () => {
      inside.open();
      await go.opened;
    });
    await inside.opened;
    const started = Date.now();
    // The lock wait (55P03) or the call as a whole (57014), whichever
    // timer of the same deadline fires first.
    const failure = await withWorkspace(
      fixture.db,
      { workspaceId, userId: ownerId },
      (tx) => deleteWorkspace(tx, "Left over", { waitMs: 50 }),
      { fence: "none", isolationLevel: "read committed" },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(isDeletionOutOfTime(failure), String(failure)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    go.open();
    await work;
    expect(await count("memberships", workspaceId)).toBe(1);
  });
});

describe("a workspace that is gone altogether (purged)", () => {
  it.each([
    ["read committed", {}],
    ["repeatable read", { isolationLevel: "repeatable read" }],
    ["serializable", { isolationLevel: "serializable" }],
    ["read only", { accessMode: "read only" }],
  ] as const)(
    "withWorkspace (%s) refuses it like a deleted one",
    async (_name, options) => {
      let ran = false;
      await expect(
        withWorkspace(
          fixture.db,
          { workspaceId: randomUUID() },
          async () => {
            ran = true;
          },
          options,
        ),
      ).rejects.toBeInstanceOf(WorkspaceDeletedError);
      expect(ran).toBe(false);
    },
  );

  it("the purge's own fence and the unfenced transaction still run", async () => {
    for (const fence of ["any", "none"] as const) {
      const rows = await withWorkspace(
        fixture.db,
        { workspaceId: randomUUID() },
        (tx) => tx.execute(sql`select 1 as one`),
        { fence },
      );
      expect(rows[0]!.one).toBe(1);
    }
  });

  it("a job for it ends without a retry and without a dead letter", async () => {
    const [job] = await admin<{ id: string }[]>`
      insert into jobs (kind, payload)
      values ('test.gone', '{"workspace_id": null, "connection_id": null}')
      returning id`;
    const worker = createWorker({
      schedulerDb,
      appDb: fixture.db,
      pollMs: 10,
      heartbeatMs: 50,
      handlers: {
        "test.gone": ({ appDb }) =>
          withWorkspace(appDb, { workspaceId: randomUUID() }, async () => {}),
      },
    });
    await worker.start();
    try {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const [row] = await admin<{ status: string; attempts: number }[]>`
          select status, attempts from jobs where id = ${job!.id}`;
        if (row!.status !== "pending" && row!.status !== "running") {
          expect(row).toEqual({ status: "failed", attempts: 1 });
          break;
        }
        if (Date.now() > deadline) throw new Error("job did not end");
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      await worker.stop();
    }
  });
});

describe("every entry point refuses a deleted workspace", () => {
  let workspaceId: string;
  let connectionId: string;
  let deviceId: string;
  let accessToken: string;
  let inviteHash: string;

  const refused = async (work: Promise<unknown>) => {
    const error = await work.then(
      () => null,
      (failure: unknown) => failure,
    );
    expect(error, "was not refused").not.toBeNull();
    expect(isWorkspaceDeleted(error), String(error)).toBe(true);
  };

  beforeAll(async () => {
    ({ workspaceId, connectionId } =
      await workspaceWithDueConnection("Entry points"));
    // A screen (pairScreen pairs in the fixture's own workspace, so this
    // one is approved by hand), an invitation, then the deletion.
    const started = await fixture.app.inject({
      method: "POST",
      url: "/v1/device/pairings",
      remoteAddress: "203.0.113.200",
    });
    const pairing = started.json() as {
      code: string;
      pairingId: string;
      pollSecret: string;
    };
    const approved = await fixture.call(
      "POST",
      `/v1/workspaces/${workspaceId}/devices/approve`,
      { code: pairing.code, name: "Screen", dashboardId: null },
    );
    expect(approved.statusCode, approved.body).toBe(200);
    deviceId = (approved.json() as { device: { id: string } }).device.id;
    const polled = await fixture.app.inject({
      method: "POST",
      url: "/v1/device/pairings/poll",
      payload: { pairingId: pairing.pairingId, pollSecret: pairing.pollSecret },
    });
    accessToken = (polled.json() as { credentials: { accessToken: string } })
      .credentials.accessToken;
    const invited = await fixture.app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/invitations`,
      headers: { cookie: fixture.owner },
      payload: { email: "entry-points@example.com", role: "viewer" },
    });
    inviteHash = hashToken(
      new URL(invited.json().inviteUrl as string).pathname.split("/").pop()!,
    );
    expect((await requestDelete(workspaceId, "Entry points")).statusCode).toBe(
      204,
    );
    // Still there, waiting for its purge (no worker runs in this file).
    const [row] = await admin`
      select deleted_at from workspaces where id = ${workspaceId}`;
    expect(row!.deleted_at).not.toBeNull();
  }, TEST_DATABASE_SETUP_TIMEOUT_MS);

  it.each([
    ["read committed", {}],
    ["repeatable read", { isolationLevel: "repeatable read" }],
    ["serializable", { isolationLevel: "serializable" }],
    ["read only", { accessMode: "read only" }],
  ] as const)(
    "withWorkspace (%s): every tenant transaction of the API and the worker",
    async (_name, options) => {
      let ran = false;
      await expect(
        withWorkspace(
          fixture.db,
          { workspaceId },
          async () => {
            ran = true;
          },
          options,
        ),
      ).rejects.toBeInstanceOf(WorkspaceDeletedError);
      expect(ran).toBe(false);
    },
  );

  it("withWorkspace with the purge's fence still runs, so the purge can work", async () => {
    const rows = await withWorkspace(
      fixture.db,
      { workspaceId },
      (tx) => tx.execute(sql`select count(*)::int as n from connections`),
      { fence: "any" },
    );
    expect(rows[0]!.n).toBe(1);
  });

  it.each([
    ["GET", "", undefined],
    ["GET", "/members", undefined],
    ["GET", "/connections", undefined],
    ["GET", "/dashboards", undefined],
    ["GET", "/devices", undefined],
    ["GET", "/audit-events", undefined],
    ["POST", "/invitations", { email: "late@example.com", role: "viewer" }],
    ["POST", "/projects", { name: "Late" }],
    ["POST", "/demo", undefined],
    ["POST", "/delete", { name: "Entry points" }],
  ] as const)(
    "the API (%s %s): access resolves to an unknown workspace",
    async (method, path, payload) => {
      const response = await fixture.app.inject({
        method,
        url: `/v1/workspaces/${workspaceId}${path}`,
        headers: { cookie: fixture.owner },
        ...(payload ? { payload } : {}),
      });
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toEqual({ error: "workspace_not_found" });
    },
  );

  it.each([
    "memberships",
    "invitations",
    "connections",
    "devices",
    "device_pairings",
    "principal_tokens",
    "oauth_authorizations",
    "jobs",
  ])("a new row in %s, whoever inserts it", async (table) => {
    // As the owner role, past RLS and grants: the trigger is the last line.
    await refused(
      admin`insert into ${admin(table)} (workspace_id) values (${workspaceId})`,
    );
  });

  it("a pairing approved into it", async () => {
    const [pairing] = await admin<{ id: string }[]>`
      select id from device_pairings where workspace_id is null limit 1`;
    const id =
      pairing?.id ??
      (
        (await fixture.app.inject({
          method: "POST",
          url: "/v1/device/pairings",
          remoteAddress: "203.0.113.201",
        })) as unknown as { json: () => { pairingId: string } }
      ).json().pairingId;
    await refused(
      admin`update device_pairings set workspace_id = ${workspaceId}
        where id = ${id}`,
    );
  });

  it("accept_invitation: the invitation is gone", async () => {
    await expect(
      acceptInvitation(fixture.db, inviteHash, ownerId),
    ).rejects.toMatchObject({ reason: "invitation_not_found" });
    expect(await count("memberships", workspaceId)).toBe(0);
  });

  it("enqueue_sync_job and next_due_at (the scheduler's tick): no job, no schedule", async () => {
    expect(
      await enqueueSyncJob(schedulerDb, {
        connectionId,
        workspaceId,
        kind: "connection.sync",
        runAt: new Date(),
        idempotencyKey: `sync:${connectionId}:refused`,
      }),
    ).toBeNull();
    await setConnectionNextDue(schedulerDb, connectionId, new Date());
    // Even the owner role cannot make it due again.
    await admin`
      update connection_state set next_due_at = now()
      where connection_id = ${connectionId}`;
    expect(await nextDue(connectionId)).toBeNull();
    expect(await liveJobs(workspaceId)).toBe(0);
    expect(
      (await listDueConnections(schedulerDb, new Date())).filter(
        (due) => due.workspaceId === workspaceId,
      ),
    ).toEqual([]);
  });

  it("device tokens: none issued, none rotated, none resolved", async () => {
    await refused(
      fixture.db.execute(sql`select issue_device_tokens(
        ${deviceId}::uuid, ${workspaceId}::uuid, 'Screen',
        ${randomUUID()}, now() + interval '1 hour',
        ${randomUUID()}, now() + interval '1 day')`),
    );
    // Even with the screen and its tokens made live again behind the
    // deletion's back.
    await admin`
      update devices set revoked_at = null where id = ${deviceId}`;
    await admin`
      update principal_tokens set revoked_at = null
      where workspace_id = ${workspaceId}`;
    await refused(
      fixture.db.execute(sql`select issue_device_tokens(
        ${deviceId}::uuid, ${workspaceId}::uuid, 'Screen',
        ${randomUUID()}, now() + interval '1 hour',
        ${randomUUID()}, now() + interval '1 day')`),
    );
    const [refresh] = await admin<{ token_hash: string }[]>`
      select token_hash from principal_tokens
      where workspace_id = ${workspaceId}
        and 'device:refresh' = any(scopes)`;
    const rotated = await fixture.db.execute<{ status: string }>(
      sql`select status from rotate_device_refresh_token(
        ${refresh!.token_hash}, ${randomUUID()}, now() + interval '1 hour',
        ${randomUUID()}, now() + interval '1 day', interval '1 minute')`,
    );
    expect(rotated[0]!.status).toBe("invalid");
    const resolved = await fixture.db.execute(
      sql`select * from resolve_principal_token(${hashToken(accessToken)})`,
    );
    expect(resolved).toHaveLength(0);
    const screen = await fixture.app.inject({
      method: "GET",
      url: "/v1/device/dashboard",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(screen.statusCode).toBe(401);
    const [tokens] = await admin<{ count: number }[]>`
      select count(*)::int as count from principal_tokens
      where workspace_id = ${workspaceId}`;
    expect(tokens!.count).toBe(2);
  });

  it("admin_set_data_policy (the installation API): no policy is stored", async () => {
    expect(
      await adminSetDataPolicy(fixture.db, workspaceId, {
        maxRetentionDays: 30,
      }),
    ).toBeNull();
    expect(await count("data_workspace_policies", workspaceId)).toBe(0);
  });

  it("the admin list leaves it out, and it still counts as a workspace for first-run setup", async () => {
    const listed = await admin<{ id: string }[]>`
      select id from admin_list_workspaces()`;
    expect(listed.map((row) => row.id)).not.toContain(workspaceId);
    await expect(
      admin`select bootstrap_workspace('Again', ${ownerId}::uuid)`,
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("the scheduler's purge sweep is the one thing that still queues work for it", async () => {
    const live = () => admin<{ status: string }[]>`
      select status from jobs where kind = 'workspace.purge'
        and payload ->> 'purge_workspace_id' = ${workspaceId}
        and status in ('pending', 'running', 'continuing')`;
    expect(await live()).toHaveLength(1);
    expect(
      await schedulerDb.execute(sql`select enqueue_workspace_purges(100)`),
    ).toHaveLength(1);
    expect(await live()).toHaveLength(1);
  });
});
