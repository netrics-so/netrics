import postgres from "postgres";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
  type TestDatabase,
} from "./test-db.js";

// Migration 0034 (#216) on data in the previous shape: every existing
// dashboard shows netrics Dark (today's palette) without an accent, its
// tiles stay, and the new table is under RLS for netrics_app.

const LAST_BEFORE = "0033_dashboard_studio";

let testDb: TestDatabase;
let adminUrl: string;
let appUrl: string;

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: LAST_BEFORE });
  adminUrl = testDb.adminUrl;
  appUrl = testDb.appUrl;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

// The test applies the remaining migrations.
vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

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

      await testDb.migrate();

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
