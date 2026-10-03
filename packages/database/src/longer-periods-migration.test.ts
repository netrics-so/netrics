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

// Migration 0032 on data in the previous shape: tiles of every existing
// period stay as they are, the longer periods become valid, and anything
// else is still refused.

const LAST_BEFORE = "0031_display_currency";

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

describe("migration 0032 on existing tiles", () => {
  it("keeps every tile and admits last_90_days and last_12_months", async () => {
    const owner = postgres(adminUrl, { max: 1, onnotice: () => undefined });
    try {
      await owner`insert into connectors (id, version, manifest) values
        ('c', '1.0.0', ${owner.json({ id: "c" })})`;
      await owner`
        insert into metric_definitions (connector_id, key, name, description,
          kind, unit, granularity, dimensions, aggregations)
        values ('c', 'c.downloads', 'Downloads', '', 'delta', 'count',
          'day', '[]', '["sum"]')`;
      const [workspace] = await owner`
        insert into workspaces (name, time_zone) values ('W', 'Europe/Berlin')
        returning id`;
      const workspaceId = workspace!.id as string;
      const [connection] = await owner`
        insert into connections (workspace_id, connector_id, name)
        values (${workspaceId}, 'c', 'Store') returning id`;
      const connectionId = connection!.id as string;
      const [dashboard] = await owner`
        insert into dashboards (workspace_id, name)
        values (${workspaceId}, 'D') returning id`;
      const dashboardId = dashboard!.id as string;
      const tile = (period: string, position: number) => owner`
        insert into dashboard_tiles (dashboard_id, workspace_id, connection_id,
          metric_key, aggregation, period, position)
        values (${dashboardId}, ${workspaceId}, ${connectionId},
                'c.downloads', 'sum', ${period}, ${position})`;
      const before = ["today", "last_7_days", "last_30_days", "this_month"];
      for (const [position, period] of before.entries()) {
        await tile(period, position);
      }
      // The previous shape refuses the longer periods.
      await expect(tile("last_90_days", 9)).rejects.toThrow(
        /dashboard_tiles_period_valid/,
      );

      await runMigrations(adminUrl);

      const rows = await owner`
        select period from dashboard_tiles
        where dashboard_id = ${dashboardId} order by position`;
      expect(rows.map((row) => row.period)).toEqual(before);
      await tile("last_90_days", 4);
      await tile("last_12_months", 5);
      await expect(tile("last_year", 6)).rejects.toThrow(
        /dashboard_tiles_period_valid/,
      );
    } finally {
      await owner.end({ timeout: 5 });
    }
  });
});
