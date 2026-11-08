import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDatabase,
  createRawSqlClient,
  type Database,
} from "@netrics/database";

import { buildApp } from "./app.js";
import type { AuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

// A request whose PostgreSQL session is terminated mid-statement (failover,
// restart, pg_terminate_backend) answers 503 with Retry-After, not a crash
// or a 500 (#538, after #511).

const noSession: AuthService = {
  handle: async (_request, reply) => {
    await reply.code(404).send();
  },
  getSessionIdentity: async () => null,
};

let testDb: TestDatabase;
let raw: ReturnType<typeof createRawSqlClient>;
let db: Database;
let app: FastifyInstance;

beforeAll(async () => {
  testDb = await createTestDatabase();
  raw = createRawSqlClient(testDb.adminUrl, {
    max: 1,
    onnotice: () => undefined,
  });
  db = createDatabase(testDb.appUrl, { max: 2 });
  app = await buildApp(
    loadConfig({
      LOG_LEVEL: "silent",
      BETTER_AUTH_URL: "http://localhost:3001",
      WEB_ORIGIN: "http://localhost:3000",
    }),
    { authService: noSession, checkDb: async () => true },
  );
  app.get("/test/slow", async () => {
    await db.execute(sql`select pg_sleep(30) /* lost-connection-test */`);
    return { ok: true };
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.$client.end({ timeout: 5 });
  await raw?.end({ timeout: 5 });
});

describe("a database session lost under a request (#538)", () => {
  it("answers 503 with Retry-After and a generic body, and the next request works", async () => {
    const pending = app.inject({ url: "/test/slow" });
    // Wait until the statement runs, then end its session.
    let pid: number | undefined;
    for (let i = 0; i < 500 && pid === undefined; i++) {
      const [row] = await raw<Array<{ pid: number }>>`
        select pid from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()
          and state = 'active' and query like 'select pg_sleep(30)%'`;
      pid = row?.pid;
      if (pid === undefined) await new Promise((r) => setTimeout(r, 10));
    }
    expect(pid).toBeDefined();
    // Only a backend of this file's own database, never another run's.
    const [terminated] = await raw<Array<{ ok: boolean }>>`
      select pg_terminate_backend(pid) as ok from pg_stat_activity
      where pid = ${pid!} and datname = current_database()`;
    expect(terminated?.ok).toBe(true);

    const response = await pending;
    expect(response.statusCode, response.body).toBe(503);
    expect(response.headers["retry-after"]).toBe("5");
    expect(response.json()).toEqual({ error: "database_unavailable" });
    expect(response.body).not.toMatch(/terminat|57P01|pg_sleep/);

    // The pool replaces the connection: the database still answers.
    const [row] = (await db.execute(sql`select 1 as one`)) as unknown as Array<{
      one: number;
    }>;
    expect(row!.one).toBe(1);
  }, 60_000);
});
