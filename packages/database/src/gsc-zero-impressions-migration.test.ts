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

// Migration 0027 (#165) on observations in the previous shape: Search Console
// position and ctr rows of days without impressions go, everything else stays.

const LAST_BEFORE = "0026_fresh_backfill";
const MIGRATION = "0027_gsc_zero_impressions";
const GSC = "google-search-console";

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

type Row = [connection: string, metric: string, day: string, value: number];

describe("migration 0027 on stored Search Console observations", () => {
  it("removes position and ctr of days without impressions, and nothing else", async () => {
    const owner = postgres(adminUrl, { max: 1, onnotice: () => undefined });
    try {
      // Data in the 0026 shape (as the owner; RLS does not apply).
      const [workspace] = await owner`
        insert into workspaces (name) values ('W') returning id`;
      await owner`insert into connectors (id, version, manifest) values
        (${GSC}, '0.1.0', ${owner.json({ id: GSC })}),
        ('other', '1.0.0', ${owner.json({ id: "other" })})`;
      const definitions = new Map<string, string>();
      for (const [connector, key, kind] of [
        [GSC, "clicks", "delta"],
        [GSC, "impressions", "delta"],
        [GSC, "ctr", "gauge"],
        [GSC, "position", "gauge"],
        [GSC, "position_sum", "delta"],
        ["other", "position", "gauge"],
        ["other", "impressions", "delta"],
      ] as const) {
        const [row] = await owner`
          insert into metric_definitions
            (connector_id, key, name, description, kind, unit, granularity,
             dimensions, aggregations)
          values (${connector}, ${`${connector}.${key}`}, ${key}, ${key},
                  ${kind}, 'x', 'day', ${owner.json(["resource"])},
                  ${owner.json(["last"])})
          returning id`;
        definitions.set(`${connector}.${key}`, row!.id as string);
      }
      const connections = new Map<string, string>();
      for (const [label, connector] of [
        ["a", GSC],
        ["b", GSC],
        ["o", "other"],
      ] as const) {
        const [row] = await owner`
          insert into connections (workspace_id, connector_id, name)
          values (${workspace!.id}, ${connector}, ${label}) returning id`;
        connections.set(label, row!.id as string);
      }

      const seeded: Row[] = [
        // a, 09-01: a normal day.
        ["a", "impressions", "2026-09-01", 100],
        ["a", "clicks", "2026-09-01", 2],
        ["a", "position", "2026-09-01", 5.5],
        ["a", "ctr", "2026-09-01", 0.02],
        ["a", "position_sum", "2026-09-01", 550],
        // a, 09-02: no impressions; position and ctr go.
        ["a", "impressions", "2026-09-02", 0],
        ["a", "clicks", "2026-09-02", 0],
        ["a", "position", "2026-09-02", 0],
        ["a", "ctr", "2026-09-02", 0],
        ["a", "position_sum", "2026-09-02", 0],
        // a, 09-03: impressions without clicks; ctr 0 is real.
        ["a", "impressions", "2026-09-03", 40],
        ["a", "clicks", "2026-09-03", 0],
        ["a", "position", "2026-09-03", 9],
        ["a", "ctr", "2026-09-03", 0],
        ["a", "position_sum", "2026-09-03", 360],
        // a, 09-04: zeros without an impressions row go too.
        ["a", "position", "2026-09-04", 0],
        ["a", "ctr", "2026-09-04", 0],
        // a, 09-05: a real value without an impressions row stays.
        ["a", "position", "2026-09-05", 7],
        // b, 09-01: another connection's empty day on a day a has data.
        ["b", "impressions", "2026-09-01", 0],
        ["b", "position", "2026-09-01", 0],
        ["b", "ctr", "2026-09-01", 0],
        // b, 09-02: data on a day a has none.
        ["b", "impressions", "2026-09-02", 30],
        ["b", "position", "2026-09-02", 3],
        ["b", "ctr", "2026-09-02", 0.1],
        // Another connector's zero position stays.
        ["o", "impressions", "2026-09-02", 0],
        ["o", "position", "2026-09-02", 0],
      ];
      for (const [label, metric, day, value] of seeded) {
        const connector = label === "o" ? "other" : GSC;
        const resource = label === "b" ? "sc-domain:b.example" : "https://a/";
        await owner`
          insert into observations
            (workspace_id, connection_id, metric_definition_id, dimensions,
             source_timestamp, value)
          values (${workspace!.id}, ${connections.get(label)!},
                  ${definitions.get(`${connector}.${metric}`)!},
                  ${owner.json({ resource })}, ${`${day}T00:00:00Z`}, ${value})`;
      }

      const labels = new Map(
        [...connections].map(([label, id]) => [id, label]),
      );
      const stored = async (): Promise<Row[]> =>
        (
          await owner`
            select o.connection_id, m.key, o.source_timestamp, o.value
            from observations o
            join metric_definitions m on m.id = o.metric_definition_id`
        )
          .map((row): Row => [
            labels.get(row.connection_id as string)!,
            (row.key as string).slice((row.key as string).indexOf(".") + 1),
            (row.source_timestamp as Date).toISOString().slice(0, 10),
            row.value as number,
          ])
          .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
      const sorted = (rows: Row[]) =>
        [...rows].sort((x, y) =>
          JSON.stringify(x).localeCompare(JSON.stringify(y)),
        );
      expect(await stored()).toEqual(sorted(seeded));

      await runMigrations(adminUrl);

      const removed: Row[] = [
        ["a", "position", "2026-09-02", 0],
        ["a", "ctr", "2026-09-02", 0],
        ["a", "position", "2026-09-04", 0],
        ["a", "ctr", "2026-09-04", 0],
        ["b", "position", "2026-09-01", 0],
        ["b", "ctr", "2026-09-01", 0],
      ];
      const expected = sorted(
        seeded.filter(
          (row) =>
            !removed.some(
              (gone) => JSON.stringify(gone) === JSON.stringify(row),
            ),
        ),
      );
      expect(await stored()).toEqual(expected);
      expect(expected).toHaveLength(seeded.length - removed.length);

      // Idempotent: running the statement again changes nothing.
      const statement = readFileSync(
        path.join(migrationsFolder, `${MIGRATION}.sql`),
        "utf8",
      );
      await owner.unsafe(statement);
      expect(await stored()).toEqual(expected);
    } finally {
      await owner.end({ timeout: 5 });
    }
  });
});
