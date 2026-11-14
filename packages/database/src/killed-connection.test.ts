import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import * as authSchema from "./auth-schema.js";
import { withWorkspace } from "./context.js";
import { createDatabase } from "./index.js";
import { withSessionAdvisoryLock, type PooledDb } from "./reserved.js";
import * as schema from "./schema.js";
import {
  createTestDatabase,
  type TestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// #511: a PostgreSQL session that ends while the server uses it (the backend
// is terminated, the database restarts or fails over, the network drops) must
// fail only the work that ran on it. postgres.js 3.4.9 crashed the process
// instead: an uncaught TypeError from writing to the closed socket. A patch
// fixed it until postgres.js 4, which handles it upstream (#537); these tests
// guard the behaviour across driver upgrades.
//
// Every backend killed here belongs to this file's own database, and is picked
// by its pid, so concurrent test runs on the same server are never touched.

let testDb: TestDatabase;
let admin: postgres.Sql;

/** Errors that reached the process instead of the caller. */
const escaped: unknown[] = [];
const onEscape = (error: unknown) => escaped.push(error);

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = postgres(testDb.adminUrl, { max: 1, onnotice: () => undefined });
  process.on("uncaughtException", onEscape);
  process.on("unhandledRejection", onEscape);
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  process.off("uncaughtException", onEscape);
  process.off("unhandledRejection", onEscape);
  await admin?.end({ timeout: 5 });
});

afterEach(async () => {
  // A crash in postgres.js surfaces on a later turn of the event loop.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(escaped.map(String)).toEqual([]);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Terminates one backend of this file's database. */
async function terminate(pid: number): Promise<void> {
  const [row] = await admin`
    select pg_terminate_backend(pid) as done
    from pg_stat_activity
    where pid = ${pid} and datname = ${testDb.name}`;
  expect(row?.done).toBe(true);
}

/** Waits until a backend of this file's database runs pg_sleep. */
async function waitUntilSleeping(pid: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [row] = await admin`
      select 1 from pg_stat_activity
      where pid = ${pid} and datname = ${testDb.name}
        and state = 'active' and wait_event = 'PgSleep'`;
    if (row) return;
    await sleep(10);
  }
  throw new Error("backend never started sleeping");
}

const backendPid = async (run: {
  execute: (q: ReturnType<typeof sql>) => Promise<unknown>;
}): Promise<number> => {
  const rows = (await run.execute(
    sql`select pg_backend_pid() as pid`,
  )) as unknown as Array<{ pid: number }>;
  return rows[0]!.pid;
};

/** Codes postgres.js and PostgreSQL report for a session that ended. */
const LOST_CONNECTION = ["CONNECTION_CLOSED", "57P01"];

/** The postgres.js code of an error, also when drizzle wrapped it. */
const code = (error: unknown): unknown => {
  const e = error as { code?: unknown; cause?: unknown } | null;
  return e?.code ?? (e?.cause ? code(e.cause) : undefined);
};

/** Every connection of the pool answers, in transactions and outside. */
async function expectPoolWorks(db: PooledDb, max: number): Promise<void> {
  const workspaceId = randomUUID();
  const results = await Promise.all(
    Array.from({ length: max * 2 }, () =>
      withWorkspace(db, { workspaceId }, async (tx) => {
        const rows = await tx.execute<{ ws: string }>(
          sql`select current_setting('app.workspace_id') as ws, pg_sleep(0.05)`,
        );
        return rows[0]!.ws;
      }),
    ),
  );
  expect(results).toEqual(Array.from({ length: max * 2 }, () => workspaceId));
  const [row] = await db.$client`select 1 as one`;
  expect(row?.one).toBe(1);
}

describe("a PostgreSQL session killed while it is in use (#511)", () => {
  it("fails a transaction killed mid-statement, and the pool recovers", async () => {
    const db = createDatabase(testDb.appUrl, { max: 2 }) as PooledDb;
    try {
      let pid = 0;
      const failure = await withWorkspace(
        db,
        { workspaceId: randomUUID() },
        async (tx) => {
          pid = await backendPid(tx);
          // drizzle sends a query once it is awaited; then() sends it now.
          // Both outcomes are handled at once: the kill can reject it before
          // terminate() returns, and an unhandled rejection fails the suite.
          const slow = tx.execute(sql`select pg_sleep(30)`).then(
            () => ({ error: undefined }),
            (error: unknown) => ({ error }),
          );
          await waitUntilSleeping(pid);
          await terminate(pid);
          const { error } = await slow;
          if (error) throw error;
        },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(LOST_CONNECTION).toContain(code(failure));
      await expectPoolWorks(db, 2);
    } finally {
      await db.$client.end({ timeout: 5 });
    }
  });

  it("rejects the statements a transaction sends after its session ended", async () => {
    // One connection, and a query waiting for it: when the session ends, the
    // pool reopens the connection for that query. The rest of the
    // transaction's callback must not run on the new session, where it would
    // run outside the transaction and without its workspace context.
    const db = createDatabase(testDb.appUrl, { max: 1 }) as PooledDb;
    try {
      let later: unknown = "not run";
      let waiting: Promise<unknown> = Promise.resolve();
      const failure = await withWorkspace(
        db,
        { workspaceId: randomUUID() },
        async (tx) => {
          const pid = await backendPid(tx);
          // postgres.js queries are lazy: execute() queues this one now, so
          // the pool reopens the connection for it once the session ends.
          waiting = db.$client`select 'waiting' as w`.execute().then(
            (rows) => rows,
            (error: unknown) => code(error),
          );
          await terminate(pid);
          // The connection now serves a new session. Only the transaction's
          // own guard can keep the next statement off it.
          expect(await waiting).toEqual([{ w: "waiting" }]);
          later = await tx
            .execute(
              sql`select current_setting('app.workspace_id', true) as ws`,
            )
            .then(
              (rows) => rows,
              (error: unknown) => code(error),
            );
        },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(LOST_CONNECTION).toContain(code(failure));
      await sleep(200);
      expect(LOST_CONNECTION).toContain(later);
      await expectPoolWorks(db, 1);
    } finally {
      await db.$client.end({ timeout: 5 });
    }
  });

  it("fails work on a reserved connection killed under it, and the pool recovers", async () => {
    const client = postgres(testDb.appUrl, { max: 1 });
    const db = drizzle(client, {
      schema: { ...schema, ...authSchema },
    }) as unknown as PooledDb;
    try {
      const failure = await withSessionAdvisoryLock(
        db,
        "killed-connection-test",
        async (locked) => {
          const pid = await backendPid(locked);
          await terminate(pid);
          await sleep(200);
          await locked.transaction(async (tx) => {
            await tx.execute(sql`select 1`);
          });
        },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(LOST_CONNECTION).toContain(code(failure));
      await expectPoolWorks(db, 1);
      // The lock went with the killed session.
      const [locks] = await client`
        select count(*)::int as n
        from pg_locks l join pg_database d on d.oid = l.database
        where d.datname = current_database()
          and l.locktype = 'advisory' and l.granted`;
      expect(locks?.n).toBe(0);
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  // A child node process takes about 3 s, alone or in a full `pnpm test` run,
  // too close to vitest's 5 s default when the machine is busy (#553). The
  // test gets the child's own limit plus room to start it and read its output.
  const CHILD_TIMEOUT_MS = 20_000;
  it(
    "keeps a process without error handlers running",
    async () => {
      // The plain client in a process of its own, with no uncaughtException
      // handler: on postgres.js 3.4.9 it exits with the TypeError.
      const script = `
      import postgres from "postgres";
      const sql = postgres(process.env.APP_URL, { max: 1 });
      const admin = postgres(process.env.ADMIN_URL, { max: 1 });
      const failure = await sql.begin(async (tx) => {
        const [{ pid }] = await tx\`select pg_backend_pid() as pid\`;
        const slow = tx\`select pg_sleep(30)\`;
        for (let i = 0; i < 200; i++) {
          const [row] = await admin\`select 1 from pg_stat_activity where pid = \${pid} and state = 'active' and wait_event = 'PgSleep'\`;
          if (row) break;
          await new Promise((r) => setTimeout(r, 10));
        }
        await admin\`select pg_terminate_backend(pid) from pg_stat_activity where pid = \${pid} and datname = current_database()\`;
        await slow;
      }).then(() => "committed", (error) => error.code);
      await new Promise((r) => setTimeout(r, 300));
      const [{ one }] = await sql\`select 1 as one\`;
      await sql.end({ timeout: 5 });
      await admin.end({ timeout: 5 });
      console.log(JSON.stringify({ failure, one }));
    `;
      const cwd = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ["--input-type=module", "-e", script],
        {
          cwd,
          env: {
            ...process.env,
            APP_URL: testDb.appUrl,
            ADMIN_URL: testDb.adminUrl,
          },
          timeout: CHILD_TIMEOUT_MS,
        },
      );
      const result = JSON.parse(stdout.trim()) as {
        failure: string;
        one: number;
      };
      expect(LOST_CONNECTION).toContain(result.failure);
      expect(result.one).toBe(1);
    },
    CHILD_TIMEOUT_MS + 10_000,
  );
});
