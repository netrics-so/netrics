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

// Migration 0036 (#250, ADR 0016) on data in the previous shape: existing
// users and workspaces keep no language (null follows the instance default),
// nothing else changes, and only language-shaped values are accepted.

const LAST_BEFORE = "0035_workspace_images";

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

describe("migration 0036 on existing users and workspaces", () => {
  it("leaves every language unset and accepts only language subtags", async () => {
    const owner = postgres(adminUrl, { max: 1, onnotice: () => undefined });
    try {
      const [user] = await owner`
        insert into users (email, display_name) values ('a@example.com', 'A')
        returning id`;
      const userId = user!.id as string;
      const [workspace] = await owner`
        insert into workspaces (name, time_zone, display_currency)
        values ('W', 'Europe/Berlin', 'EUR') returning id`;
      const workspaceId = workspace!.id as string;

      await runMigrations(adminUrl);

      const [after] = await owner`
        select u.email, u.display_name, u.locale,
               w.name, w.time_zone, w.display_currency, w.screen_locale
        from users u, workspaces w
        where u.id = ${userId} and w.id = ${workspaceId}`;
      expect({ ...after }).toEqual({
        email: "a@example.com",
        display_name: "A",
        locale: null,
        name: "W",
        time_zone: "Europe/Berlin",
        display_currency: "EUR",
        screen_locale: null,
      });

      await owner`update users set locale = 'de' where id = ${userId}`;
      await owner`update workspaces set screen_locale = 'de' where id = ${workspaceId}`;
      await expect(
        owner`update users set locale = 'de-DE' where id = ${userId}`,
      ).rejects.toThrow(/users_locale_format/);
      await expect(
        owner`update workspaces set screen_locale = 'DE' where id = ${workspaceId}`,
      ).rejects.toThrow(/workspaces_screen_locale_format/);
    } finally {
      await owner.end({ timeout: 5 });
    }
  });
});
