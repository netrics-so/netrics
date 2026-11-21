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

// Reason codes on sync runs (#795) on data in the previous shape: a failed
// run recorded with its English message only keeps the message and gets no
// code, and new runs may carry a code that is a fixed word, never text.
// Found by its name, not its number.

const TAG_SUFFIX = "_sync_run_error_code";

const REFUSED =
  "Apple Ads refused the access token: the key was removed, or the API user lost access. Set up a new Apple Ads key.";

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
    values (${workspaceId}, 'demo', 'Ads') returning id`;
  connectionId = connection!.id as string;
  await owner`
    insert into sync_runs
      (workspace_id, connection_id, mode, requested_from, requested_to,
       attempt, status, started_at, error_class, error_message)
    values
      (${workspaceId}, ${connectionId}, 'incremental', now() - interval '1 day',
        now(), 1, 'failed', now() - interval '1 hour', 'auth', ${REFUSED}),
      (${workspaceId}, ${connectionId}, 'incremental', now() - interval '2 day',
        now(), 1, 'succeeded', now() - interval '2 hour', null, null)`;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

afterAll(async () => {
  await owner?.end({ timeout: 5 }).catch(() => undefined);
  await testDb?.drop();
});

function insertRun(code: string | null) {
  return owner`
    insert into sync_runs
      (workspace_id, connection_id, mode, requested_from, requested_to,
       attempt, status, started_at, error_class, error_message, error_code)
    values (${workspaceId}, ${connectionId}, 'incremental',
      now() - interval '1 hour', now(), 1, 'failed', now(), 'auth',
      ${REFUSED}, ${code})`;
}

describe("the sync run error code migration", () => {
  it("keeps existing runs with their message and no code", async () => {
    await testDb.migrate();
    const runs = await owner`
      select status, error_class, error_message, error_code
      from sync_runs where connection_id = ${connectionId}
      order by started_at desc`;
    expect(runs).toEqual([
      {
        status: "failed",
        error_class: "auth",
        error_message: REFUSED,
        error_code: null,
      },
      {
        status: "succeeded",
        error_class: null,
        error_message: null,
        error_code: null,
      },
    ]);
  });

  it("accepts a reason code and refuses text in its place", async () => {
    await insertRun("apple_ads.unauthorized");
    await insertRun(null);
    for (const text of [
      "Apple Ads refused the key",
      "INVALID_CLIENT",
      "apple_ads.",
      "",
      `a${"_a".repeat(32)}`,
    ]) {
      await expect(insertRun(text)).rejects.toThrow(
        /sync_runs_error_code_valid/,
      );
    }
  });
});
