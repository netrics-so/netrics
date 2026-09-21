import path from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import * as schema from "./schema.js";

export * as schema from "./schema.js";

export type Database = ReturnType<typeof createDatabase>;

// SQL migrations ship inside this package so standalone production images can
// migrate without drizzle-kit (a dev dependency).
export const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "drizzle",
);

export async function runMigrations(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
}

export function createDatabase(databaseUrl: string) {
  const client = postgres(databaseUrl);
  return drizzle(client, { schema });
}

export async function checkDatabaseConnection(
  databaseUrl: string,
  timeoutMs = 2000,
): Promise<boolean> {
  const client = postgres(databaseUrl, {
    max: 1,
    connect_timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
    idle_timeout: 1,
  });
  try {
    await client`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await client.end({ timeout: 0 }).catch(() => undefined);
  }
}
