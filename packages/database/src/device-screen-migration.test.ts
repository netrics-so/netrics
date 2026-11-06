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

// Migration 0038 (#276, ADR 0017 section 7) on data in the previous shape
// (0037: dashboards with a primary format): paired devices with heartbeats,
// showing a portrait dashboard, keep everything they had and become
// unrotated screen-view devices without a reported screen; the checks
// accept only the four rotations, the two modes and a JSON object.

const LAST_BEFORE = "0037_format_layouts";

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

describe("migration 0038 on paired devices with heartbeats", () => {
  it("keeps the devices and adds unrotated screen-view settings", async () => {
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
        insert into dashboards (workspace_id, name, primary_format)
        values (${workspaceId}, 'Portrait', '9x16') returning id`;
      const dashboardId = dashboard!.id as string;
      const [beating] = await owner`
        insert into devices (workspace_id, name, dashboard_id,
          approved_by_user_id, last_seen_at, app_version, uptime_seconds,
          last_error, last_heartbeat_at)
        values (${workspaceId}, 'Lobby', ${dashboardId}, ${user!.id as string},
          '2026-10-01T10:00:00Z', 'tvos 1.4 (12)', 3600, 'timeout',
          '2026-10-01T10:00:00Z')
        returning id`;
      const [silent] = await owner`
        insert into devices (workspace_id, name, revoked_at)
        values (${workspaceId}, 'Old', '2026-09-01T00:00:00Z') returning id`;

      await runMigrations(adminUrl);

      const rows = await owner`
        select id, name, dashboard_id, app_version, uptime_seconds, last_error,
               last_heartbeat_at is not null as beat, revoked_at is not null
                 as revoked,
               rotation, display_mode, screen
        from devices order by name`;
      expect(rows.map((row) => ({ ...row }))).toEqual([
        {
          id: beating!.id,
          name: "Lobby",
          dashboard_id: dashboardId,
          app_version: "tvos 1.4 (12)",
          uptime_seconds: 3600,
          last_error: "timeout",
          beat: true,
          revoked: false,
          rotation: 0,
          display_mode: "screen",
          screen: null,
        },
        {
          id: silent!.id,
          name: "Old",
          dashboard_id: null,
          app_version: null,
          uptime_seconds: null,
          last_error: null,
          beat: false,
          revoked: true,
          rotation: 0,
          display_mode: "screen",
          screen: null,
        },
      ]);

      const [kept] = await owner`
        select primary_format from dashboards where id = ${dashboardId}`;
      expect(kept!.primary_format).toBe("9x16");

      const id = beating!.id as string;
      for (const rotation of [90, 180, 270, 0]) {
        await owner`update devices set rotation = ${rotation} where id = ${id}`;
      }
      await owner`update devices set display_mode = 'scroll' where id = ${id}`;
      await owner`
        update devices set screen = ${owner.json({
          width: 1920,
          height: 1080,
          scale: 1,
          mode: "screen",
        })} where id = ${id}`;
      for (const rotation of [45, -90, 360]) {
        await expect(
          owner`update devices set rotation = ${rotation} where id = ${id}`,
        ).rejects.toThrow(/devices_rotation_valid/);
      }
      await expect(
        owner`update devices set display_mode = 'glance' where id = ${id}`,
      ).rejects.toThrow(/devices_display_mode_valid/);
      await expect(
        owner`update devices set screen = '[1920, 1080]'::jsonb where id = ${id}`,
      ).rejects.toThrow(/devices_screen_object/);
    } finally {
      await owner.end({ timeout: 5 });
    }
  });
});
