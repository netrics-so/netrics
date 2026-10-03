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

// Migration 0029 (#166) on metric definitions in the previous shape: every
// existing definition becomes a "primary" metric; only the two roles are
// allowed. (0028 belongs to another change and is not needed here.)

const LAST_BEFORE = "0027_gsc_zero_impressions";

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

describe("migration 0029 on stored metric definitions", () => {
  it("makes existing definitions primary and allows only the two roles", async () => {
    const owner = postgres(adminUrl, { max: 1, onnotice: () => undefined });
    try {
      await owner`insert into connectors (id, version, manifest) values
        ('c', '1.0.0', ${owner.json({ id: "c" })})`;
      for (const key of ["c.clicks", "c.position_sum"]) {
        await owner`
          insert into metric_definitions
            (connector_id, key, name, description, kind, unit, granularity,
             dimensions, aggregations, better)
          values ('c', ${key}, ${key}, ${key}, 'delta', 'x', 'day',
                  ${owner.json(["resource"])}, ${owner.json(["sum"])}, 'lower')`;
      }

      await runMigrations(adminUrl);

      const rows = await owner`
        select key, better, role from metric_definitions order by key`;
      expect(rows.map((row) => ({ ...row }))).toEqual([
        { key: "c.clicks", better: "lower", role: "primary" },
        { key: "c.position_sum", better: "lower", role: "primary" },
      ]);
      await owner`
        update metric_definitions set role = 'helper'
        where key = 'c.position_sum'`;
      await expect(
        owner`update metric_definitions set role = 'hidden' where key = 'c.clicks'`,
      ).rejects.toThrow(/metric_definitions_role_valid/);
    } finally {
      await owner.end({ timeout: 5 });
    }
  });
});
