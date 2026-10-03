import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrationsFolder, runMigrations } from "./index.js";

// Migration 0030 (#194) on data in the previous shape: connections,
// observations and tiles stay as they are, and the new resource-name table
// starts empty under RLS.

const LAST_BEFORE = "0029_audit_retention";

const serverUrl =
  process.env.NETRICS_TEST_ADMIN_URL ??
  "postgres://netrics:netrics@localhost:5433/postgres";
const name = `netrics_test_${randomBytes(6).toString("hex")}`;
let adminUrl: string;
let folder: string;

/** A copy of the migrations folder that ends at `lastTag`. */
function migrationsUpTo(lastTag: string): string {
  const copy = mkdtempSync(path.join(tmpdir(), "netrics-migrations-"));
  cpSync(migrationsFolder, copy, { recursive: true });
  const journalPath = path.join(copy, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const last = journal.entries.findIndex((entry) => entry.tag === lastTag);
  expect(last).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, last + 1);
  writeFileSync(journalPath, JSON.stringify(journal));
  return copy;
}

beforeAll(async () => {
  const server = postgres(serverUrl, { max: 1 });
  await server.unsafe(`CREATE DATABASE ${name}`);
  await server.end({ timeout: 5 });
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  adminUrl = url.toString();
  folder = migrationsUpTo(LAST_BEFORE);

  const client = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  try {
    await migrate(drizzle(client), { migrationsFolder: folder });
  } finally {
    await client.end({ timeout: 5 });
  }
}, 60_000);

afterAll(async () => {
  rmSync(folder, { recursive: true, force: true });
  const server = postgres(serverUrl, { max: 1 });
  await server.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await server.end({ timeout: 5 });
});

describe("migration 0030 on existing connections", () => {
  it("keeps connections and tiles and adds an empty table under RLS", async () => {
    const owner = postgres(adminUrl, { max: 1, onnotice: () => undefined });
    try {
      await owner`insert into connectors (id, version, manifest) values
        ('c', '1.0.0', ${owner.json({ id: "c" })})`;
      const [workspace] =
        await owner`insert into workspaces (name) values ('W') returning id`;
      const workspaceId = workspace!.id as string;
      const [connection] = await owner`
        insert into connections (workspace_id, connector_id, name, config)
        values (${workspaceId}, 'c', 'Apps',
                ${owner.json({ resourceSelection: ["app-1"] })})
        returning id`;
      const connectionId = connection!.id as string;
      const [dashboard] = await owner`
        insert into dashboards (workspace_id, name)
        values (${workspaceId}, 'D') returning id`;
      await owner`
        insert into dashboard_tiles (dashboard_id, workspace_id, connection_id,
          metric_key, aggregation, period, position)
        values (${dashboard!.id as string}, ${workspaceId}, ${connectionId},
                'c.downloads', 'sum', 'last_7_days', 0)`;

      await runMigrations(adminUrl);

      const [tile] = await owner`
        select dimensions, title from dashboard_tiles
        where connection_id = ${connectionId}`;
      expect({ ...tile }).toEqual({ dimensions: {}, title: null });
      const [row] = await owner`
        select config from connections where id = ${connectionId}`;
      expect(row!.config).toEqual({ resourceSelection: ["app-1"] });
      const [table] = await owner`
        select relrowsecurity, relforcerowsecurity,
               (select count(*)::int from connection_resources) as rows
        from pg_class where relname = 'connection_resources'`;
      expect({ ...table }).toEqual({
        relrowsecurity: true,
        relforcerowsecurity: true,
        rows: 0,
      });
      await owner`
        insert into connection_resources
          (connection_id, workspace_id, resource_id, name, kind)
        values (${connectionId}, ${workspaceId}, 'app-1', 'Wurfel', 'app')`;
    } finally {
      await owner.end({ timeout: 5 });
    }
  });
});
