import postgres from "postgres";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
  type TestDatabase,
} from "./test-db.js";

// Migration 0051 (#406, ADR 0021) on data in the previous shape (0050):
// a paired Apple TV and a turned browser kiosk with heartbeats, a revoked
// device, and pairings pending and claimed keep everything they had and
// get a null platform ("not reported"); nothing is rewritten. The checks
// accept only the four platforms and null.

const LAST_BEFORE = "0050_connection_resources_kind_key";

let testDb: TestDatabase;
let adminUrl: string;

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: LAST_BEFORE });
  adminUrl = testDb.adminUrl;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

// The test applies the remaining migrations.
vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

describe("migration 0051 on paired TVs, kiosks and pairings", () => {
  it("keeps every row and adds a null platform", async () => {
    const owner = postgres(adminUrl, { max: 1, onnotice: () => undefined });
    try {
      const [user] = await owner`
        insert into users (email, display_name) values ('a@example.com', 'A')
        returning id`;
      const [workspace] = await owner`
        insert into workspaces (name, time_zone, display_currency)
        values ('W', 'Europe/Berlin', 'EUR') returning id`;
      const workspaceId = workspace!.id as string;
      const [dashboard] = await owner`
        insert into dashboards (workspace_id, name) values (${workspaceId}, 'D')
        returning id`;
      const dashboardId = dashboard!.id as string;
      const screen = { width: 1920, height: 1080, scale: 1, mode: "screen" };
      const [tv] = await owner`
        insert into devices (workspace_id, name, dashboard_id,
          approved_by_user_id, last_seen_at, app_version, uptime_seconds,
          last_heartbeat_at, screen)
        values (${workspaceId}, 'Lobby', ${dashboardId}, ${user!.id as string},
          '2026-10-01T10:00:00Z', 'tvos 1.4 (12)', 3600,
          '2026-10-01T10:00:00Z', ${owner.json(screen)})
        returning id`;
      const [kiosk] = await owner`
        insert into devices (workspace_id, name, dashboard_id,
          approved_by_user_id, last_seen_at, app_version, uptime_seconds,
          last_heartbeat_at, rotation, display_mode)
        values (${workspaceId}, 'Kitchen', ${dashboardId}, ${user!.id as string},
          '2026-10-01T11:00:00Z', 'web 0.9.0', 60,
          '2026-10-01T11:00:00Z', 90, 'scroll')
        returning id`;
      const [old] = await owner`
        insert into devices (workspace_id, name, revoked_at)
        values (${workspaceId}, 'Old', '2026-09-01T00:00:00Z') returning id`;
      await owner`
        insert into device_pairings (code_hash, poll_secret_hash, client_key,
          expires_at)
        values ('pending-code', 'pending-secret', 'client',
          '2026-12-01T00:00:00Z')`;
      await owner`
        insert into device_pairings (code_hash, poll_secret_hash, client_key,
          expires_at, approved_at, workspace_id, device_id, claimed_at)
        values ('claimed-code', 'claimed-secret', 'client',
          '2026-10-01T10:10:00Z', '2026-10-01T10:01:00Z', ${workspaceId},
          ${tv!.id as string}, '2026-10-01T10:01:05Z')`;

      await testDb.migrate();

      const devices = await owner`
        select id, name, dashboard_id, app_version, rotation, display_mode,
               screen, revoked_at is not null as revoked, platform
        from devices order by name`;
      expect(devices.map((row) => ({ ...row }))).toEqual([
        {
          id: kiosk!.id,
          name: "Kitchen",
          dashboard_id: dashboardId,
          app_version: "web 0.9.0",
          rotation: 90,
          display_mode: "scroll",
          screen: null,
          revoked: false,
          platform: null,
        },
        {
          id: tv!.id,
          name: "Lobby",
          dashboard_id: dashboardId,
          app_version: "tvos 1.4 (12)",
          rotation: 0,
          display_mode: "screen",
          screen,
          revoked: false,
          platform: null,
        },
        {
          id: old!.id,
          name: "Old",
          dashboard_id: null,
          app_version: null,
          rotation: 0,
          display_mode: "screen",
          screen: null,
          revoked: true,
          platform: null,
        },
      ]);
      const pairings = await owner`
        select code_hash, device_id, claimed_at is not null as claimed,
               platform
        from device_pairings order by code_hash`;
      expect(pairings.map((row) => ({ ...row }))).toEqual([
        {
          code_hash: "claimed-code",
          device_id: tv!.id,
          claimed: true,
          platform: null,
        },
        {
          code_hash: "pending-code",
          device_id: null,
          claimed: false,
          platform: null,
        },
      ]);

      const id = tv!.id as string;
      for (const platform of ["tvos", "ipados", "ios", "web"]) {
        await owner`update devices set platform = ${platform} where id = ${id}`;
        await owner`
          update device_pairings set platform = ${platform}
          where code_hash = 'pending-code'`;
      }
      await owner`update devices set platform = null where id = ${id}`;
      for (const platform of ["android", "TVOS", ""]) {
        await expect(
          owner`update devices set platform = ${platform} where id = ${id}`,
        ).rejects.toThrow(/devices_platform_valid/);
        await expect(
          owner`
            update device_pairings set platform = ${platform}
            where code_hash = 'pending-code'`,
        ).rejects.toThrow(/device_pairings_platform_valid/);
      }
    } finally {
      await owner.end({ timeout: 5 });
    }
  });
});
