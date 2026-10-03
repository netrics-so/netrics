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
import { DEV_ROLE_PASSWORDS } from "./roles.js";

// Migration 0034 (#216) on data in the previous shape: every existing
// dashboard shows netrics Dark (today's palette) without an accent, its
// tiles stay, and the new table is under RLS for netrics_app.

const LAST_BEFORE = "0033_dashboard_studio";

const serverUrl =
  process.env.NETRICS_TEST_ADMIN_URL ??
  "postgres://netrics:netrics@localhost:5433/postgres";
const name = `netrics_test_${randomBytes(6).toString("hex")}`;
let adminUrl: string;
let appUrl: string;
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
  const app = new URL(adminUrl);
  app.username = "netrics_app";
  app.password = "netrics_app";
  appUrl = app.toString();
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

describe("migration 0034 on existing dashboards", () => {
  it("gives every dashboard netrics Dark and isolates themes", async () => {
    const owner = postgres(adminUrl, { max: 1, onnotice: () => undefined });
    try {
      await owner`insert into connectors (id, version, manifest) values
        ('c', '1.0.0', ${owner.json({ id: "c" })})`;
      await owner`
        insert into metric_definitions (connector_id, key, name, description,
          kind, unit, granularity, dimensions, aggregations)
        values ('c', 'c.downloads', 'Downloads', '', 'delta', 'count',
          'day', '[]', '["sum"]')`;
      const workspaces: string[] = [];
      for (const workspaceName of ["A", "B"]) {
        const [row] = await owner`
          insert into workspaces (name, time_zone)
          values (${workspaceName}, 'Europe/Berlin') returning id`;
        workspaces.push(row!.id as string);
      }
      const [a, b] = workspaces as [string, string];
      const [connection] = await owner`
        insert into connections (workspace_id, connector_id, name)
        values (${a}, 'c', 'Store') returning id`;
      const dashboardIds: string[] = [];
      for (const dashboardName of ["Empty", "Tiles"]) {
        const [row] = await owner`
          insert into dashboards (workspace_id, name, version)
          values (${a}, ${dashboardName}, 3) returning id`;
        dashboardIds.push(row!.id as string);
      }
      await owner`
        insert into dashboard_tiles (dashboard_id, workspace_id,
          connection_id, metric_key, aggregation, period, position)
        values (${dashboardIds[1]!}, ${a}, ${connection!.id as string},
          'c.downloads', 'sum', 'last_7_days', 0)`;

      await runMigrations(adminUrl, { rolePasswords: DEV_ROLE_PASSWORDS });

      const rows = await owner`
        select name, version, theme_builtin, theme_id, accent_color
        from dashboards order by name`;
      expect(rows).toEqual([
        {
          name: "Empty",
          version: 3,
          theme_builtin: "netrics_dark",
          theme_id: null,
          accent_color: null,
        },
        {
          name: "Tiles",
          version: 3,
          theme_builtin: "netrics_dark",
          theme_id: null,
          accent_color: null,
        },
      ]);
      const [{ tiles }] = (await owner`
        select count(*)::int as tiles from dashboard_tiles`) as unknown as [
        { tiles: number },
      ];
      expect(tiles).toBe(1);

      // Exactly one theme reference, and accents only as #rrggbb.
      await expect(
        owner`update dashboards set theme_builtin = null
          where id = ${dashboardIds[0]!}`,
      ).rejects.toThrow(/dashboards_one_theme/);
      await expect(
        owner`update dashboards set accent_color = 'red'
          where id = ${dashboardIds[0]!}`,
      ).rejects.toThrow(/dashboards_accent_color_format/);

      // RLS: netrics_app sees and writes only its workspace's themes.
      await owner`
        insert into workspace_themes (workspace_id, name, base, tokens)
        values (${b}, 'B theme', 'netrics_dark', '{}')`;
      const app = postgres(appUrl, { max: 1, onnotice: () => undefined });
      try {
        await app.begin(async (tx) => {
          await tx`select set_config('app.workspace_id', ${a}, true)`;
          await tx`
            insert into workspace_themes (workspace_id, name, base, tokens)
            values (${a}, 'A theme', 'light', '{}')`;
          const visible = await tx`select name from workspace_themes`;
          expect(visible.map((row) => row.name)).toEqual(["A theme"]);
          await expect(
            tx.savepoint(
              (sp) => sp`
              insert into workspace_themes (workspace_id, name, base, tokens)
              values (${b}, 'Smuggled', 'light', '{}')`,
            ),
          ).rejects.toThrow(/row-level security/);
        });
        expect(await app`select id from workspace_themes`).toHaveLength(0);
      } finally {
        await app.end({ timeout: 5 });
      }
    } finally {
      await owner.end({ timeout: 5 });
    }
  });
});
