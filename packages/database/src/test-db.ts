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
import { DEV_ROLE_PASSWORDS } from "./roles.js";

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
  const serverUrl =
    process.env.NETRICS_TEST_ADMIN_URL ??
    "postgres://netrics:netrics@localhost:5433/postgres";

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

  const migrateAll = () =>
    runMigrations(adminUrl, { rolePasswords: DEV_ROLE_PASSWORDS });
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
