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

// Migration 0031 (#191) on data in the previous shape: workspaces and tiles
// keep showing amounts per currency (no display currency), observations
// stay as they are, and the new rate table starts empty, readable but not
// writable by netrics_app and writable by netrics_scheduler.

const LAST_BEFORE = "0030_connection_resources";

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

describe("migration 0031 on existing workspaces and tiles", () => {
  it("keeps everything per currency and adds an empty, read-only rate table", async () => {
    const owner = postgres(adminUrl, { max: 1, onnotice: () => undefined });
    try {
      await owner`insert into connectors (id, version, manifest) values
        ('c', '1.0.0', ${owner.json({ id: "c" })})`;
      const [definition] = await owner`
        insert into metric_definitions (connector_id, key, name, description,
          kind, unit, granularity, dimensions, aggregations)
        values ('c', 'c.proceeds', 'Proceeds', '', 'delta', 'currency_minor',
          'day', '["currency"]', '["sum"]') returning id`;
      const [workspace] = await owner`
        insert into workspaces (name, time_zone) values ('W', 'Europe/Berlin')
        returning id`;
      const workspaceId = workspace!.id as string;
      const [connection] = await owner`
        insert into connections (workspace_id, connector_id, name)
        values (${workspaceId}, 'c', 'Store') returning id`;
      const connectionId = connection!.id as string;
      await owner`
        insert into observations (workspace_id, connection_id,
          metric_definition_id, dimensions, source_timestamp, value)
        values (${workspaceId}, ${connectionId}, ${definition!.id as string},
          ${owner.json({ currency: "CLP" })}, '2026-10-01T00:00:00Z', 1500)`;
      const [dashboard] = await owner`
        insert into dashboards (workspace_id, name)
        values (${workspaceId}, 'D') returning id`;
      await owner`
        insert into dashboard_tiles (dashboard_id, workspace_id, connection_id,
          metric_key, aggregation, period, dimensions, position)
        values (${dashboard!.id as string}, ${workspaceId}, ${connectionId},
                'c.proceeds', 'sum', 'last_7_days',
                ${owner.json({ currency: "CLP" })}, 0)`;

      await runMigrations(adminUrl);

      const [after] = await owner`
        select w.time_zone, w.display_currency as workspace_currency,
               t.dimensions, t.display_currency as tile_currency,
               (select value from observations
                 where connection_id = ${connectionId}) as value
        from workspaces w
        join dashboard_tiles t on t.workspace_id = w.id
        where w.id = ${workspaceId}`;
      expect({ ...after }).toEqual({
        time_zone: "Europe/Berlin",
        workspace_currency: null,
        dimensions: { currency: "CLP" },
        tile_currency: null,
        value: 1500,
      });
      const [table] = await owner`
        select relrowsecurity,
               (select count(*)::int from exchange_rates) as rows,
               has_table_privilege('netrics_app', 'exchange_rates', 'SELECT') as app_select,
               has_table_privilege('netrics_app', 'exchange_rates', 'INSERT') as app_insert,
               has_table_privilege('netrics_app', 'exchange_rates', 'UPDATE') as app_update,
               has_table_privilege('netrics_app', 'exchange_rates', 'DELETE') as app_delete,
               has_table_privilege('netrics_scheduler', 'exchange_rates', 'INSERT') as scheduler_insert,
               has_table_privilege('netrics_scheduler', 'exchange_rates', 'UPDATE') as scheduler_update,
               has_table_privilege('netrics_scheduler', 'exchange_rates', 'DELETE') as scheduler_delete
        from pg_class where relname = 'exchange_rates'`;
      expect({ ...table }).toEqual({
        relrowsecurity: false,
        rows: 0,
        app_select: true,
        app_insert: false,
        app_update: false,
        app_delete: false,
        scheduler_insert: true,
        scheduler_update: true,
        scheduler_delete: false,
      });
      await expect(
        owner`insert into exchange_rates (rate_date, currency, units_per_eur)
              values ('2026-10-02', 'USD', '0')`,
      ).rejects.toThrow(/exchange_rates_rate_positive/);
    } finally {
      await owner.end({ timeout: 5 });
    }
  });
});
