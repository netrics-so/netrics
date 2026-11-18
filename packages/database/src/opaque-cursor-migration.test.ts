import { readFileSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { migrationsFolder } from "./index.js";
import {
  createTestDatabase,
  type TestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// The next window start (#758) on data in the previous shape: the old engine
// started an incremental window at a cursor Date.parse read as a date. Such
// rows keep that start in next_from; every cursor stays as it was. Found by
// its name, not its number.

const TAG_SUFFIX = "_opaque_cursor";

function lastBefore(): string {
  const journal = JSON.parse(
    readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };
  const at = journal.entries.findIndex((entry) =>
    entry.tag.endsWith(TAG_SUFFIX),
  );
  expect(at).toBeGreaterThan(0);
  return journal.entries[at - 1]!.tag;
}

/** Stored cursor → the next window start the migration derives. */
const CASES: Array<[string | null, string | null]> = [
  // The host's window end and the connectors' resume stamps (toISOString).
  ["2026-11-10T00:00:00.000Z", "2026-11-10T00:00:00.000Z"],
  ["2026-11-14T09:31:07.123Z", "2026-11-14T09:31:07.123Z"],
  ["2026-11-14T09:31:07Z", "2026-11-14T09:31:07.000Z"],
  ["2026-11-14T10:31:07+01:00", "2026-11-14T09:31:07.000Z"],
  ["2026-11-14", "2026-11-14T00:00:00.000Z"],
  // Opaque cursors, even those Date.parse accepts, have no window start.
  ["x 2024", null],
  ["page-2", null],
  ["analytics:0:2026-11-10T00:00:00.000Z", null],
  ["google-play-done:3:2026-11-10T00:00:00.000Z", null],
  ["2026-11-10T00:00:00.000Z|2026-11-08", null],
  // The shape of an instant but none: left alone, the migration goes on.
  ["2026-02-31T00:00:00.000Z", null],
  [null, null],
];

let testDb: TestDatabase;
let owner: postgres.Sql;
const connectionIds: string[] = [];

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: lastBefore() });
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => undefined });
  const [workspace] = await owner`
    insert into workspaces (name) values ('W') returning id`;
  const workspaceId = workspace!.id as string;
  await owner`
    insert into connectors (id, version, manifest)
    values ('demo', '0.1.0', '{}'::jsonb)
    on conflict (id) do nothing`;
  for (const [cursor] of CASES) {
    const [connection] = await owner`
      insert into connections (workspace_id, connector_id, name)
      values (${workspaceId}, 'demo', 'Store') returning id`;
    const connectionId = connection!.id as string;
    connectionIds.push(connectionId);
    await owner`
      insert into connection_state (connection_id, workspace_id, cursor, last_success_at)
      values (${connectionId}, ${workspaceId}, ${cursor}, '2026-11-15T00:00:00Z')`;
  }
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

afterAll(async () => {
  await owner?.end({ timeout: 5 }).catch(() => undefined);
  await testDb?.drop();
});

describe("the opaque cursor migration", () => {
  it("moves the window start of date cursors to next_from and keeps every cursor", async () => {
    await testDb.migrate();
    const rows = await owner`
      select connection_id, cursor, next_from, last_success_at
      from connection_state`;
    const byId = new Map(rows.map((row) => [row.connection_id, row]));
    CASES.forEach(([cursor, nextFrom], index) => {
      const row = byId.get(connectionIds[index]!)!;
      expect({ cursor: row.cursor, nextFrom: row.next_from }).toEqual({
        cursor,
        nextFrom: nextFrom === null ? null : new Date(nextFrom),
      });
      expect(row.last_success_at).toEqual(new Date("2026-11-15T00:00:00Z"));
    });
  });
});
