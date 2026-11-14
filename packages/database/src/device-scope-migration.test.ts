import postgres from "postgres";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
  type TestDatabase,
} from "./test-db.js";

// Migration 0063 (#500) on data in the previous shape (0062): paired
// screens, an unassigned and a revoked one keep everything they had and get
// no fixed scope, so they show their dashboards as before. The check
// accepts only a scope naming its dashboard and an object of filter values.

const LAST_BEFORE = "0062_policy_deadline_fixed_days";

let testDb: TestDatabase;
let adminUrl: string;

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: LAST_BEFORE });
  adminUrl = testDb.adminUrl;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

// The test applies the remaining migrations.
vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

describe("migration 0063 on paired screens", () => {
  it("keeps every device unscoped and accepts only well-formed scopes", async () => {
    const owner = postgres(adminUrl, { max: 1, onnotice: () => undefined });
    try {
      const [workspace] = await owner`
        insert into workspaces (name) values ('W') returning id`;
      const workspaceId = workspace!.id as string;
      const [dashboard] = await owner`
        insert into dashboards (workspace_id, name) values (${workspaceId}, 'D')
        returning id`;
      const dashboardId = dashboard!.id as string;
      await owner`
        insert into devices (workspace_id, name, dashboard_id, rotation,
          display_mode, platform)
        values (${workspaceId}, 'Lobby', ${dashboardId}, 90, 'scroll', 'tvos'),
               (${workspaceId}, 'Spare', null, 0, 'screen', null)`;
      await owner`
        insert into devices (workspace_id, name, revoked_at)
        values (${workspaceId}, 'Old', '2026-09-01T00:00:00Z')`;

      await testDb.migrate();

      const devices = await owner`
        select name, dashboard_id, rotation, display_mode, platform,
               revoked_at is not null as revoked, scope
        from devices order by name`;
      expect(devices.map((row) => ({ ...row }))).toEqual([
        {
          name: "Lobby",
          dashboard_id: dashboardId,
          rotation: 90,
          display_mode: "scroll",
          platform: "tvos",
          revoked: false,
          scope: null,
        },
        {
          name: "Old",
          dashboard_id: null,
          rotation: 0,
          display_mode: "screen",
          platform: null,
          revoked: true,
          scope: null,
        },
        {
          name: "Spare",
          dashboard_id: null,
          rotation: 0,
          display_mode: "screen",
          platform: null,
          revoked: false,
          scope: null,
        },
      ]);

      const scope = {
        dashboardId,
        values: { country: { kind: "values", values: ["DE"] } },
      };
      await owner`
        update devices set scope = ${owner.json(scope)} where name = 'Lobby'`;
      for (const invalid of [
        [],
        { values: {} },
        { dashboardId, values: [] },
        { dashboardId: 1, values: {} },
      ])
        await expect(
          owner`
            update devices set scope = ${owner.json(invalid as never)}
            where name = 'Lobby'`,
        ).rejects.toThrow(/devices_scope_shape/);
    } finally {
      await owner.end({ timeout: 5 });
    }
  });
});
