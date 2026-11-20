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

// Where a connection's read history starts (#378) on data in the previous
// shape: a connection whose latest backfill succeeded gets that backfill's
// window start; one whose latest backfill failed (a key refused halfway),
// or that has none, gets none. Found by its name, not its number.

const TAG_SUFFIX = "_history_from";

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
const c: Record<string, string> = {};

async function connection(name: string): Promise<string> {
  const [row] = await owner`
    insert into connections (workspace_id, connector_id, name)
    values (${workspaceId}, 'demo', ${name}) returning id`;
  const id = row!.id as string;
  await owner`
    insert into connection_state (connection_id, workspace_id)
    values (${id}, ${workspaceId})`;
  return id;
}

async function run(
  connectionId: string,
  mode: "backfill" | "incremental",
  status: "succeeded" | "failed",
  from: string,
  startedAt: string,
) {
  await owner`
    insert into sync_runs
      (workspace_id, connection_id, mode, requested_from, requested_to,
       attempt, status, started_at)
    values (${workspaceId}, ${connectionId}, ${mode}, ${from}, ${startedAt},
      1, ${status}, ${startedAt})`;
}

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
  c.read = await connection("Read");
  await run(
    c.read,
    "backfill",
    "succeeded",
    "2025-11-01T00:00:00Z",
    "2026-11-01T00:00:00Z",
  );
  // Later incrementals do not move the history start.
  await run(
    c.read,
    "incremental",
    "succeeded",
    "2026-11-10T00:00:00Z",
    "2026-11-12T00:00:00Z",
  );
  c.refused = await connection("Refused");
  await run(
    c.refused,
    "backfill",
    "succeeded",
    "2025-10-01T00:00:00Z",
    "2026-10-01T00:00:00Z",
  );
  await run(
    c.refused,
    "backfill",
    "failed",
    "2025-11-01T00:00:00Z",
    "2026-11-01T00:00:00Z",
  );
  await run(
    c.refused,
    "incremental",
    "succeeded",
    "2026-11-10T00:00:00Z",
    "2026-11-12T00:00:00Z",
  );
  c.none = await connection("None");
  await run(
    c.none,
    "incremental",
    "succeeded",
    "2026-11-10T00:00:00Z",
    "2026-11-12T00:00:00Z",
  );
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

afterAll(async () => {
  await owner?.end({ timeout: 5 }).catch(() => undefined);
  await testDb?.drop();
});

describe("the history-from migration", () => {
  it("takes the window of a connection's latest backfill when it succeeded", async () => {
    await testDb.migrate();
    const rows = await owner`
      select connection_id, history_from from connection_state`;
    const of = (id: string) =>
      rows.find((row) => row.connection_id === id)!.history_from as Date | null;
    expect(of(c.read!)?.toISOString()).toBe("2025-11-01T00:00:00.000Z");
    expect(of(c.refused!)).toBeNull();
    expect(of(c.none!)).toBeNull();
  });
});
