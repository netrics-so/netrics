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

// The periods-to-date migration (#331, ADR 0019 §3) on data in the previous
// shape: widgets and tiles of every existing period stay as they are, this
// week, quarter and year become valid, and anything else is still refused.
// The migration is found by name, so the test does not depend on its number.

const MIGRATION = /^\d{4}_periods_to_date$/;

const serverUrl =
  process.env.NETRICS_TEST_ADMIN_URL ??
  "postgres://netrics:netrics@localhost:5433/postgres";
const name = `netrics_test_${randomBytes(6).toString("hex")}`;
let adminUrl: string;
let folder: string;

/** A copy of the migrations folder that ends just before the migration. */
function migrationsBefore(tag: RegExp): string {
  const copy = mkdtempSync(path.join(tmpdir(), "netrics-migrations-"));
  cpSync(migrationsFolder, copy, { recursive: true });
  const journalPath = path.join(copy, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const index = journal.entries.findIndex((entry) => tag.test(entry.tag));
  expect(index).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, index);
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
  folder = migrationsBefore(MIGRATION);

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

describe("periods-to-date migration on existing widgets and tiles", () => {
  it("keeps every widget and tile and admits this week, quarter and year", async () => {
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
      const [slide] = await owner`
        insert into dashboard_slides (dashboard_id, workspace_id, position)
        values (${dashboardId}, ${workspaceId}, 0) returning id`;
      const slideId = slide!.id as string;

      const widget = (period: string, y: number) => owner`
        insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
          type, x, y, w, h, connection_id, metric_key, aggregation, period)
        values (${slideId}, ${dashboardId}, ${workspaceId}, 'metric', 0, ${y},
                1, 1, ${connectionId}, 'c.downloads', 'sum', ${period})`;
      const tile = (period: string, position: number) => owner`
        insert into dashboard_tiles (dashboard_id, workspace_id, connection_id,
          metric_key, aggregation, period, position)
        values (${dashboardId}, ${workspaceId}, ${connectionId},
                'c.downloads', 'sum', ${period}, ${position})`;

      const before = [
        "today",
        "last_7_days",
        "last_30_days",
        "this_month",
        "last_90_days",
        "last_12_months",
      ];
      for (const [index, period] of before.entries()) {
        await widget(period, index);
        await tile(period, index);
      }
      await owner`
        insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
          type, x, y, w, h, text)
        values (${slideId}, ${dashboardId}, ${workspaceId}, 'text', 1, 0, 1, 1,
                'Hello')`;
      // The previous shape refuses the new periods.
      await expect(widget("this_week", 9)).rejects.toThrow(
        /dashboard_widgets_period_valid/,
      );
      await expect(tile("this_year", 9)).rejects.toThrow(
        /dashboard_tiles_period_valid/,
      );

      await runMigrations(adminUrl);

      const widgets = await owner`
        select type, period from dashboard_widgets
        where dashboard_id = ${dashboardId} order by x, y`;
      expect(widgets.map((row) => [row.type, row.period])).toEqual([
        ...before.map((period) => ["metric", period]),
        ["text", null],
      ]);
      const tiles = await owner`
        select period from dashboard_tiles
        where dashboard_id = ${dashboardId} order by position`;
      expect(tiles.map((row) => row.period)).toEqual(before);

      for (const [index, period] of [
        "this_week",
        "this_quarter",
        "this_year",
      ].entries()) {
        await widget(period, 6 + index);
        await tile(period, 6 + index);
      }
      await expect(widget("last_year", 12)).rejects.toThrow(
        /dashboard_widgets_period_valid/,
      );
      await expect(tile("this_decade", 12)).rejects.toThrow(
        /dashboard_tiles_period_valid/,
      );
    } finally {
      await owner.end({ timeout: 5 });
    }
  });
});
