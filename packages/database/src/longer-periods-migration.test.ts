import postgres from "postgres";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
  type TestDatabase,
} from "./test-db.js";

// Migration 0032 on data in the previous shape: tiles of every existing
// period stay as they are, the longer periods become valid, and anything
// else is still refused.

const LAST_BEFORE = "0031_display_currency";

let testDb: TestDatabase;
let adminUrl: string;

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: LAST_BEFORE });
  adminUrl = testDb.adminUrl;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

// The test applies the remaining migrations.
vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

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

      await testDb.migrate();

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
