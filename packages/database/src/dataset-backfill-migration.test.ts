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

// The backfilled-datasets record (#617) on data in the previous shape: every
// connection_state row keeps its values and starts with nothing recorded,
// which the sync engine derives once. Found by its name, not its number.

const TAG_SUFFIX = "_dataset_backfill_marker";

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

let testDb: TestDatabase;
let owner: postgres.Sql;
let connectionId: string;

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
  const [connection] = await owner`
    insert into connections (workspace_id, connector_id, name)
    values (${workspaceId}, 'demo', 'Store') returning id`;
  connectionId = connection!.id as string;
  await owner`
    insert into connection_state (connection_id, workspace_id, cursor, last_success_at)
    values (${connectionId}, ${workspaceId}, 'cursor-1', '2026-11-01T00:00:00Z')`;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

afterAll(async () => {
  await owner?.end({ timeout: 5 }).catch(() => undefined);
  await testDb?.drop();
});

describe("the dataset backfill marker migration", () => {
  it("keeps each connection's state and records nothing yet", async () => {
    await testDb.migrate();
    const [row] = await owner`
      select cursor, last_success_at, backfilled_datasets,
        backfill_requested_datasets, history_reload_requested_at
      from connection_state where connection_id = ${connectionId}`;
    expect(row).toEqual({
      cursor: "cursor-1",
      last_success_at: new Date("2026-11-01T00:00:00Z"),
      backfilled_datasets: null,
      backfill_requested_datasets: null,
      history_reload_requested_at: null,
    });
  });
});
