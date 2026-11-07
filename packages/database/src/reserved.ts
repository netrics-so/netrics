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
      try {
        const result = await fn(scope());
        await unsafe("commit");
        return result;
      } catch (error) {
        await unsafe("rollback").catch(() => undefined);
        throw error;
      }
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

/**
 * Runs `fn` while this session holds the session-level advisory lock
 * `name`, taken on a reserved connection before `fn` starts any
 * transaction. A serializable transaction that `fn` opens on `lockedDb`
 * takes its snapshot only after the lock is granted, so it sees every
 * transaction committed by an earlier holder. The lock is released on that
 * connection before it returns to the pool, also when `fn` throws.
 */
export async function withSessionAdvisoryLock<T>(
  db: PooledDb,
  name: string,
  fn: (lockedDb: PooledDb) => Promise<T>,
): Promise<T> {
  const reserved = await db.$client.reserve();
  try {
    await reserved`select pg_advisory_lock(hashtextextended(${name}, 0))`;
    return await fn(reservedDatabase(db, reserved));
  } finally {
    await releaseReserved(reserved);
  }
}
