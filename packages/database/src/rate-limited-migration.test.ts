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

// Rate limits with a known reset (#781) on data in the previous shape: a
// connection the old engine marked as an outage after repeated 429s keeps
// its state (it recovers with its next successful run), and runs may now
// be recorded as rate_limited. Found by its name, not its number.

const TAG_SUFFIX = "_rate_limited_until";

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
let workspaceId: string;
let connectionId: string;

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: lastBefore() });
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => undefined });
  const [workspace] = await owner`
    insert into workspaces (name) values ('W') returning id`;
  workspaceId = workspace!.id as string;
  await owner`
    insert into connectors (id, version, manifest)
    values ('demo', '0.1.0', '{}'::jsonb)
    on conflict (id) do nothing`;
  const [connection] = await owner`
    insert into connections (workspace_id, connector_id, name)
    values (${workspaceId}, 'demo', 'Site') returning id`;
  connectionId = connection!.id as string;
  await owner`
    insert into connection_state
      (connection_id, workspace_id, auth_state, consecutive_failures)
    values (${connectionId}, ${workspaceId}, 'outage', 10)`;
  await owner`
    insert into sync_runs
      (workspace_id, connection_id, mode, requested_from, requested_to,
       attempt, status, started_at, error_class, error_message)
    values (${workspaceId}, ${connectionId}, 'backfill', now() - interval '1 day',
      now(), 1, 'failed', now(), 'transient', 'rate limit (429)')`;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

afterAll(async () => {
  await owner?.end({ timeout: 5 }).catch(() => undefined);
  await testDb?.drop();
});

describe("the rate-limited migration", () => {
  it("keeps existing state and runs, and accepts rate_limited runs", async () => {
    await testDb.migrate();
    const [state] = await owner`
      select auth_state, consecutive_failures, rate_limited_until
      from connection_state where connection_id = ${connectionId}`;
    expect(state).toEqual({
      auth_state: "outage",
      consecutive_failures: 10,
      rate_limited_until: null,
    });
    const runs = await owner`
      select error_class from sync_runs where connection_id = ${connectionId}`;
    expect(runs.map((run) => run.error_class)).toEqual(["transient"]);
    await owner`
      insert into sync_runs
        (workspace_id, connection_id, mode, requested_from, requested_to,
         attempt, status, started_at, error_class)
      values (${workspaceId}, ${connectionId}, 'incremental', now() - interval '1 hour',
        now(), 1, 'failed', now(), 'rate_limited')`;
    await expect(
      owner`
        insert into sync_runs
          (workspace_id, connection_id, mode, requested_from, requested_to,
           attempt, status, started_at, error_class)
        values (${workspaceId}, ${connectionId}, 'incremental', now() - interval '1 hour',
          now(), 1, 'failed', now(), 'throttled')`,
    ).rejects.toThrow(/sync_runs_error_class_valid/);
  });
});
