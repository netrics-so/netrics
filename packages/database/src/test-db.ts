import { randomBytes } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll } from "vitest";

import { migrationsFolder, runMigrations } from "./index.js";
import { DEV_ROLE_PASSWORDS, provisionRolePasswords } from "./roles.js";

// Test-only helper, also exported as @netrics/database/testing (kept out of
// the production image by package.json "files"). Hooks must be registered at
// collection time, so cleanup lives at module scope (this file is only ever
// imported by *.test.ts files).
const pendingDrops: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const drop of pendingDrops.splice(0)) {
    await drop();
  }
});

function testServerUrl(): string {
  return (
    process.env.NETRICS_TEST_ADMIN_URL ??
    "postgres://netrics:netrics@localhost:5433/postgres"
  );
}

/**
 * Advisory lock key that serialises role changes across test processes.
 * Advisory locks are scoped to one database, so every holder takes it on the
 * server URL's database (NETRICS_TEST_ADMIN_URL), never on a test database.
 */
const ROLE_CATALOG_LOCK = 351_000_001;

/**
 * Runs `work` on a single server connection that holds the role catalog lock.
 * Roles are cluster-global: every test database used to run
 * `ALTER ROLE netrics_app ... PASSWORD` on the same pg_authid row at once,
 * and PostgreSQL rejects concurrent updates of one catalog row with
 * "tuple concurrently updated" (XX000) instead of waiting (issue #351).
 * The lock is session-level; ending the connection releases it on any path.
 */
export async function withRoleCatalogLock<T>(
  work: (sql: postgres.Sql) => Promise<T>,
  serverUrl: string = testServerUrl(),
): Promise<T> {
  // max: 1 keeps the lock and `work` on the same backend session.
  const server = postgres(serverUrl, {
    max: 1,
    connect_timeout: 5,
    onnotice: () => undefined,
  });
  try {
    await server`select pg_advisory_lock(${ROLE_CATALOG_LOCK})`;
    try {
      return await work(server);
    } finally {
      await server`select pg_advisory_unlock(${ROLE_CATALOG_LOCK})`;
    }
  } finally {
    await server.end({ timeout: 5 }).catch(() => undefined);
  }
}

/**
 * Gives the application roles LOGIN and the development passwords, one test
 * process at a time. The roles must exist (migration 0001 creates them).
 */
export async function provisionTestRoles(): Promise<void> {
  await withRoleCatalogLock(async (sql) => {
    await provisionRolePasswords(sql, DEV_ROLE_PASSWORDS);
  });
}

export interface TestDatabase {
  /** Name of the per-test-file database (netrics_test_<random>). */
  name: string;
  /** Connection URL as netrics_app (the RLS-enforced application role). */
  appUrl: string;
  /** Connection URL as the admin/migration role for this database. */
  adminUrl: string;
  drop: () => Promise<void>;
  /**
   * Applies every remaining migration and the development role passwords,
   * for a database created with `upTo` (data in a previous shape).
   */
  migrate: () => Promise<void>;
}

export interface TestDatabaseOptions {
  /** Runs after migrations as the owner role, e.g. to write the catalog. */
  seed?: (adminUrl: string) => Promise<void>;
  /**
   * Stops after this migration (its tag, e.g. "0032_longer_periods"), so a
   * test can write data in the previous shape and then call `migrate()`.
   */
  upTo?: string;
}

/** Applies the migrations up to and including `lastTag`. */
async function migrateUpTo(adminUrl: string, lastTag: string): Promise<void> {
  const copy = mkdtempSync(path.join(tmpdir(), "netrics-migrations-"));
  try {
    cpSync(migrationsFolder, copy, { recursive: true });
    const journalPath = path.join(copy, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    const last = journal.entries.findIndex((entry) => entry.tag === lastTag);
    if (last < 0) {
      throw new Error(`unknown migration ${lastTag}`);
    }
    journal.entries = journal.entries.slice(0, last + 1);
    writeFileSync(journalPath, JSON.stringify(journal));
    const client = postgres(adminUrl, { max: 1, onnotice: () => undefined });
    try {
      await migrate(drizzle(client), { migrationsFolder: copy });
    } finally {
      await client.end({ timeout: 5 }).catch(() => undefined);
    }
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

/**
 * Creates a fresh, fully migrated database on the local PostgreSQL server.
 * The server URL comes from NETRICS_TEST_ADMIN_URL (default matches
 * `pnpm db:up`). Registers an afterAll hook that drops the database.
 */
export async function createTestDatabase(
  options: TestDatabaseOptions = {},
): Promise<TestDatabase> {
  const serverUrl = testServerUrl();

  const name = `netrics_test_${randomBytes(6).toString("hex")}`;
  const server = postgres(serverUrl, { max: 1, connect_timeout: 5 });
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

  // Migrations touch only this database; the role passwords are set
  // separately under the cluster-wide lock (see withRoleCatalogLock).
  const migrateAll = async () => {
    await runMigrations(adminUrl);
    await provisionTestRoles();
  };
  if (options.upTo === undefined) {
    await migrateAll();
  } else {
    await migrateUpTo(adminUrl, options.upTo);
  }
  await options.seed?.(adminUrl);

  const database: TestDatabase = {
    name,
    appUrl,
    adminUrl,
    migrate: migrateAll,
    drop: async () => {
      const client = postgres(serverUrl, { max: 1, connect_timeout: 5 });
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
