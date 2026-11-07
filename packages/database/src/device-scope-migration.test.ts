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

// Migration 0063 (#500) on data in the previous shape (0062): paired
// screens, an unassigned and a revoked one keep everything they had and get
// no fixed scope, so they show their dashboards as before. The check
// accepts only a scope naming its dashboard and an object of filter values.

const LAST_BEFORE = "0062_policy_deadline_fixed_days";

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

      await runMigrations(adminUrl);

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
