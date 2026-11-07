import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as authSchema from "./auth-schema.js";
import {
  releaseReserved,
  SessionLockQueue,
  SessionLockTimeoutError,
  withSessionAdvisoryLock,
  type PooledDb,
} from "./reserved.js";
import * as schema from "./schema.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

// #495: pinned first pages hold a session advisory lock on a reserved pool
// connection around their serializable transaction. The pool has a single
// connection here, so the checks after each case run on the very connection
// that held the lock.

let testDb: TestDatabase;
let client: postgres.Sql;
let observer: postgres.Sql;
let db: PooledDb;

beforeAll(async () => {
  testDb = await createTestDatabase();
  client = postgres(testDb.appUrl, { max: 1 });
  observer = postgres(testDb.appUrl, { max: 1 });
  db = drizzle(client, {
    schema: { ...schema, ...authSchema },
  }) as unknown as PooledDb;
});

afterAll(async () => {
  await client?.end({ timeout: 5 });
  await observer?.end({ timeout: 5 });
});

const advisoryLocks = async (sqlClient: postgres.Sql = observer) =>
  (
    await sqlClient`select count(*)::int as n from pg_locks l join pg_database d on d.oid = l.database where d.datname = current_database() and l.locktype = 'advisory' and l.granted`
  )[0]!.n as number;

/** The pooled connection holds no lock and has no transaction open. */
const expectClean = async () => {
  expect(await advisoryLocks()).toBe(0);
  const [own] =
    await client`select pg_backend_pid() as pid, (select count(*)::int from pg_locks where pid = pg_backend_pid() and locktype = 'advisory') as locks`;
  expect(own!.locks).toBe(0);
  // Seen from another session once the pooled one is back in the pool.
  const [activity] =
    await observer`select state from pg_stat_activity where pid = ${own!.pid as number}`;
  expect(activity!.state).toBe("idle");
};

describe("withSessionAdvisoryLock", () => {
  it("holds the lock across transactions and releases it afterwards", async () => {
    const seen = await withSessionAdvisoryLock(
      db,
      "reserved-test",
      async (locked) => {
        await locked.transaction(async (tx) => {
          await tx.execute(sql`select 1`);
        });
        const held = await advisoryLocks();
        await locked.transaction(async (tx) => {
          await tx.execute(sql`select 1`);
        });
        return held;
      },
    );
    expect(seen).toBe(1);
    await expectClean();
  });

  it("releases the lock when a transaction fails with an SQL error", async () => {
    await expect(
      withSessionAdvisoryLock(db, "reserved-test", (locked) =>
        locked.transaction(async (tx) => {
          await tx.execute(sql`select 1 / 0`);
        }),
      ),
    ).rejects.toThrow();
    await expectClean();
  });

  it("releases the lock when the callback throws", async () => {
    await expect(
      withSessionAdvisoryLock(db, "reserved-test", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expectClean();
  });

  it("supports nested transactions as savepoints", async () => {
    const value = await withSessionAdvisoryLock(db, "reserved-test", (locked) =>
      locked.transaction(async (tx) => {
        await tx.execute(sql`select set_config('netrics.test', 'outer', true)`);
        await tx
          .transaction(async (savepoint) => {
            await savepoint.execute(
              sql`select set_config('netrics.test', 'inner', true)`,
            );
            throw new Error("roll back the savepoint");
          })
          .catch(() => undefined);
        await tx.transaction(async (savepoint) => {
          await savepoint.execute(sql`select 1`);
        });
        const [row] = await tx.execute<{ value: string }>(
          sql`select current_setting('netrics.test') as value`,
        );
        return row!.value;
      }),
    );
    expect(value).toBe("outer");
    await expectClean();
  });

  it("makes a waiter's first snapshot see the holder's commit", async () => {
    const pool = postgres(testDb.appUrl, { max: 2 });
    const pooled = drizzle(pool, {
      schema: { ...schema, ...authSchema },
    }) as unknown as PooledDb;
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const holder = withSessionAdvisoryLock(
        pooled,
        "reserved-snapshot",
        (locked) =>
          locked.transaction(async (tx) => {
            await tx.execute(
              sql`select set_config('netrics.unused', 'x', true)`,
            );
            await gate;
            await tx.execute(sql`select pg_notify('reserved_test', 'done')`);
            return Date.now();
          }),
      );
      // Wait until the holder has the lock, then queue a waiter behind it.
      for (let i = 0; i < 500 && (await advisoryLocks()) === 0; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      const waiter = withSessionAdvisoryLock(
        pooled,
        "reserved-snapshot",
        (locked) =>
          locked.transaction(
            async (tx) => {
              const [row] = await tx.execute<{ started: string }>(
                sql`select (extract(epoch from now()) * 1000)::text as started`,
              );
              return Number(row!.started);
            },
            { isolationLevel: "serializable" },
          ),
        // Another server instance: it waits on the database lock itself.
        { queue: new SessionLockQueue() },
      );
      for (
        let i = 0;
        i < 500 &&
        (
          await observer`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`
        )[0]!.n === 0;
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      release();
      const committed = await holder;
      // The waiter's transaction (and so its snapshot) began after the
      // holder had committed and released the lock.
      expect(await waiter).toBeGreaterThanOrEqual(committed);
    } finally {
      await pool.end({ timeout: 5 });
    }
    expect(await advisoryLocks()).toBe(0);
  });
});

describe("releaseReserved", () => {
  it("ends a failed transaction and drops session locks before returning the connection", async () => {
    const reserved = await client.reserve();
    await reserved`select pg_advisory_lock(495)`;
    await reserved.unsafe("begin");
    await reserved.unsafe("select 1 / 0").catch(() => undefined);
    await releaseReserved(reserved);
    await expectClean();
  });

  it("ends an open transaction before returning the connection", async () => {
    const reserved = await client.reserve();
    await reserved.unsafe("begin");
    await reserved`select pg_advisory_lock(495), pg_advisory_xact_lock(496)`;
    await releaseReserved(reserved);
    await expectClean();
  });
});

describe("SessionLockQueue", () => {
  it("runs holders of one name in order and forgets the name afterwards", async () => {
    const queue = new SessionLockQueue();
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map(async (n) => {
        const done = await queue.take("q", Infinity);
        order.push(n);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(-n);
        done();
      }),
    );
    expect(order).toEqual([1, -1, 2, -2, 3, -3]);
    expect(queue.size).toBe(0);
  });

  it("lets a waiter give up without blocking the ones behind it", async () => {
    const queue = new SessionLockQueue();
    const first = await queue.take("q", Infinity);
    const late = queue.take("q", Date.now() + 20);
    const third = queue.take("q", Infinity);
    await expect(late).rejects.toBeInstanceOf(SessionLockTimeoutError);
    expect(queue.size).toBe(1);
    first();
    (await third)();
    expect(queue.size).toBe(0);
  });
});

describe("withSessionAdvisoryLock timeout", () => {
  it("gives up on a held database lock, leaving no lock or lock_timeout behind", async () => {
    const name = "reserved-timeout";
    await observer`select pg_advisory_lock(hashtextextended(${name}, 0))`;
    try {
      const queue = new SessionLockQueue();
      await expect(
        withSessionAdvisoryLock(db, name, async () => "ran", {
          timeoutMs: 100,
          queue,
        }),
      ).rejects.toBeInstanceOf(SessionLockTimeoutError);
      expect(queue.size).toBe(0);
      const [own] =
        await client`select current_setting('lock_timeout') as timeout, (select count(*)::int from pg_locks where pid = pg_backend_pid() and locktype = 'advisory') as locks`;
      expect(own).toEqual({ timeout: "0", locks: 0 });
    } finally {
      await observer`select pg_advisory_unlock(hashtextextended(${name}, 0))`;
    }
    expect(
      await withSessionAdvisoryLock(db, name, async () => "ran", {
        timeoutMs: 1000,
      }),
    ).toBe("ran");
    await expectClean();
  });
});
