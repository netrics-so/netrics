import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";

export * as schema from "./schema.js";

export type Database = ReturnType<typeof createDatabase>;

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
