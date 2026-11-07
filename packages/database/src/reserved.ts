import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";

import * as authSchema from "./auth-schema.js";
import type { Db } from "./context.js";
import * as schema from "./schema.js";

export type ReservedSql = Awaited<ReturnType<postgres.Sql["reserve"]>>;

/** A pooled database handle (createDatabase). */
export type PooledDb = Db & { $client: postgres.Sql };

/** Whether `db` is a pooled handle that can reserve a connection (not a transaction). */
export function isPooledDatabase(db: unknown): db is PooledDb {
  const client = (db as { $client?: { reserve?: unknown } } | null)?.$client;
  return typeof client?.reserve === "function";
}

/**
 * A drizzle handle over one reserved connection. postgres.js gives a
 * reserved connection no begin() or savepoint(), so they are opened here
 * with BEGIN/COMMIT and SAVEPOINT/RELEASE on that connection. Everything
 * the handle runs, including withWorkspace transactions and their nested
 * transactions, stays in the session of the reserved connection.
 */
export function reservedDatabase(
  parent: PooledDb,
  reserved: ReservedSql,
): PooledDb {
  const options = parent.$client.options;
  const unsafe = reserved.unsafe.bind(reserved);
  let savepoints = 0;
  const scope = (): unknown => ({
    options,
    unsafe,
    savepoint: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const name = "netrics_sp_" + ++savepoints;
      await unsafe("savepoint " + name);
      try {
        const result = await fn(scope());
        await unsafe("release savepoint " + name);
        return result;
      } catch (error) {
        await unsafe("rollback to savepoint " + name).catch(() => undefined);
        throw error;
      }
    },
  });
  const shim = {
    options,
    unsafe,
    savepoint: () => {
      throw new Error("reservedDatabase: savepoint outside a transaction");
    },
    begin: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      await unsafe("begin");
      let result: T;
      try {
        result = await fn(scope());
      } catch (error) {
        await unsafe("rollback").catch(() => undefined);
        throw error;
      }
      // A COMMIT that fails (a serialization failure, a deferred constraint)
      // has already ended the transaction; a ROLLBACK after it would run
      // outside one and draw WARNING 25P01 (#516). A connection that broke
      // during COMMIT is cleaned up by releaseReserved.
      await unsafe("commit");
      return result;
    },
  };
  return drizzle(shim as unknown as postgres.Sql, {
    schema: { ...schema, ...authSchema },
  });
}

/**
 * Returns a reserved connection to the pool after ending any open or failed
 * transaction and dropping its session advisory locks, so a pooled
 * connection never keeps a lock. These statements fail only when the
 * connection itself is gone, and then the server has released its locks.
 */
export async function releaseReserved(reserved: ReservedSql): Promise<void> {
  try {
    // SAVEPOINT succeeds only inside an open transaction block; outside one
    // it fails with 25P01, inside a failed one with 25P02.
    const open = await reserved.unsafe("savepoint netrics_release_probe").then(
      () => true,
      (error: unknown) => {
        if (sqlstate(error) === "25P01") return false;
        if (sqlstate(error) === "25P02") return true;
        throw error;
      },
    );
    if (open) await reserved.unsafe("rollback");
    await reserved.unsafe("reset lock_timeout");
    await reserved.unsafe("select pg_advisory_unlock_all()");
  } catch {
    // Cleanup fails when the connection is gone; the server has then ended
    // the session and released its locks. Terminating the backend from the
    // client is not an option: postgres.js 3.4 crashes the process when its
    // own connection is killed (an uncaught write on a closed socket).
  } finally {
    reserved.release();
  }
}

function sqlstate(error: unknown): string | undefined {
  return (error as { code?: unknown } | null)?.code as string | undefined;
}

/** The wait for a session advisory lock exceeded its time limit. */
export class SessionLockTimeoutError extends Error {
  constructor(name: string) {
    super("session lock wait timed out: " + name);
    this.name = "SessionLockTimeoutError";
  }
}

interface Turns {
  tail: Promise<void>;
  size: number;
}

/**
 * Waiters for session locks within one process, per lock name: a keyed
 * promise chain. Waiting here holds no pool connection, so a process holds
 * at most one connection per lock name. An entry is deleted as soon as its
 * last waiter is done.
 */
export class SessionLockQueue {
  readonly #names = new Map<string, Turns>();

  /** Lock names with holders or waiters in this queue. */
  get size(): number {
    return this.#names.size;
  }

  /**
   * Waits for the turn on `name`; the returned function passes it on. A
   * waiter that gives up at `deadline` passes its turn on as soon as its
   * predecessor does.
   */
  async take(name: string, deadline: number): Promise<() => void> {
    const turns = this.#names.get(name) ?? {
      tail: Promise.resolve(),
      size: 0,
    };
    this.#names.set(name, turns);
    const previous = turns.tail;
    let pass!: () => void;
    const mine = new Promise<void>((resolve) => (pass = resolve));
    turns.tail = previous.then(() => mine);
    turns.size++;
    let passed = false;
    const done = () => {
      if (passed) return;
      passed = true;
      pass();
      if (--turns.size === 0 && this.#names.get(name) === turns)
        this.#names.delete(name);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut =
      deadline === Infinity
        ? await previous.then(() => false)
        : await Promise.race([
            previous.then(() => false),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(
                () => resolve(true),
                Math.max(0, deadline - Date.now()),
              );
            }),
          ]);
    clearTimeout(timer);
    if (timedOut) {
      void previous.then(done);
      throw new SessionLockTimeoutError(name);
    }
    return done;
  }
}

/** The queue of this process, used unless a caller passes its own. */
export const processSessionLocks = new SessionLockQueue();

/**
 * Reserves a pool connection, waiting for a free one no later than
 * `deadline`. A reservation that arrives after the deadline is handed
 * straight back to the pool.
 */
async function reserveBefore(
  db: PooledDb,
  name: string,
  deadline: number,
): Promise<ReservedSql> {
  const reservation = db.$client.reserve();
  if (deadline === Infinity) return reservation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reserved = await Promise.race([
    reservation,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(
        () => resolve(undefined),
        Math.max(0, deadline - Date.now()),
      );
    }),
  ]);
  clearTimeout(timer);
  if (reserved) return reserved;
  void reservation.then(
    (late) => late.release(),
    () => undefined,
  );
  throw new SessionLockTimeoutError(name);
}

/**
 * Runs `fn` while this session holds the session-level advisory lock
 * `name`, taken on a reserved connection before `fn` starts any
 * transaction. A serializable transaction that `fn` opens on `lockedDb`
 * takes its snapshot only after the lock is granted, so it sees every
 * transaction committed by an earlier holder.
 *
 * Waiters queue in memory first (`queue`, by default the process-wide
 * one), so a burst on one name holds one pool connection, not one per
 * waiter. With `timeoutMs`, waiting
 * in that queue and for the database lock together may take that long;
 * then SessionLockTimeoutError is thrown and nothing is held. The lock is
 * released on the connection before it returns to the pool, also when `fn`
 * throws.
 */
export async function withSessionAdvisoryLock<T>(
  db: PooledDb,
  name: string,
  fn: (lockedDb: PooledDb) => Promise<T>,
  options: { timeoutMs?: number; queue?: SessionLockQueue } = {},
): Promise<T> {
  const deadline =
    options.timeoutMs === undefined
      ? Infinity
      : Date.now() + Math.max(1, options.timeoutMs);
  const done = await (options.queue ?? processSessionLocks).take(
    name,
    deadline,
  );
  try {
    const reserved = await reserveBefore(db, name, deadline);
    try {
      if (deadline !== Infinity) {
        const remaining = Math.ceil(deadline - Date.now());
        if (remaining <= 0) throw new SessionLockTimeoutError(name);
        await reserved.unsafe(`set lock_timeout = ${remaining}`);
      }
      await reserved`select pg_advisory_lock(hashtextextended(${name}, 0))`.catch(
        (error: unknown) => {
          if (sqlstate(error) === "55P03")
            throw new SessionLockTimeoutError(name);
          throw error;
        },
      );
      await reserved.unsafe("reset lock_timeout");
      return await fn(reservedDatabase(db, reserved));
    } finally {
      await releaseReserved(reserved);
    }
  } finally {
    done();
  }
}
