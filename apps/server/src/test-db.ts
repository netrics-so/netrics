import { randomBytes } from "node:crypto";

import { afterAll } from "vitest";

import { createRawSqlClient, runMigrations } from "@netrics/database";

// Copy of packages/database/src/test-db.ts (kept local to avoid widening the
// package's export map for test-only code). Hooks must be registered at
// collection time, so cleanup lives at module scope (this file is only ever
// imported by *.test.ts files).
const pendingDrops: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const drop of pendingDrops.splice(0)) {
    await drop();
  }
});

export interface TestDatabase {
  /** Name of the per-test-file database (netrics_test_<random>). */
  name: string;
  /** Connection URL as netrics_app (the RLS-enforced application role). */
  appUrl: string;
  /** Connection URL as the admin/migration role for this database. */
  adminUrl: string;
  drop: () => Promise<void>;
}

/**
 * Creates a fresh, fully migrated database on the local PostgreSQL server.
 * The server URL comes from NETRICS_TEST_ADMIN_URL (default matches
 * `pnpm db:up`). Registers an afterAll hook that drops the database.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const serverUrl =
    process.env.NETRICS_TEST_ADMIN_URL ??
    "postgres://netrics:netrics@localhost:5433/postgres";

  const name = `netrics_test_${randomBytes(6).toString("hex")}`;
  const server = createRawSqlClient(serverUrl, { max: 1, connect_timeout: 5 });
  try {
    await server`select 1`;
  } catch (error) {
    await server.end({ timeout: 0 }).catch(() => undefined);
    throw new Error(
      `Cannot reach the test PostgreSQL server (${serverUrl}). ` +
        "Start it with `pnpm db:up` or point NETRICS_TEST_ADMIN_URL at a " +
        `running server. Cause: ${(error as Error).message}`,
      { cause: error },
    );
  }

  // name is a fixed prefix plus lowercase hex, so interpolation is safe.
  await server.unsafe(`CREATE DATABASE ${name}`);
  await server.end({ timeout: 5 }).catch(() => undefined);

  const admin = new URL(serverUrl);
  admin.pathname = `/${name}`;
  const adminUrl = admin.toString();

  const app = new URL(adminUrl);
  app.username = "netrics_app";
  app.password = "netrics_app";
  const appUrl = app.toString();

  await runMigrations(adminUrl);

  const database: TestDatabase = {
    name,
    appUrl,
    adminUrl,
    drop: async () => {
      const client = createRawSqlClient(serverUrl, {
        max: 1,
        connect_timeout: 5,
      });
      try {
        await client.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await client.end({ timeout: 5 }).catch(() => undefined);
      }
    },
  };
  pendingDrops.push(database.drop);
  return database;
}
