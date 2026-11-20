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

// Draft connections (#806) on data in the previous shape: bundled and pinned
// custom-api connections become 'active' and keep their schedule and pin.
// Found by its name, not its number.

const TAG_SUFFIX = "_draft_connections";

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
let versionId: string;
let before: Array<Record<string, unknown>>;

async function schedule() {
  return owner`
    select c.name, c.connector_id, c.custom_api_definition_version_id,
      c.custom_api_environment_id, s.next_due_at
    from connections c join connection_state s on s.connection_id = c.id
    order by c.name`;
}

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: lastBefore() });
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => undefined });
  const [workspace] =
    await owner`insert into workspaces (name) values ('W') returning id`;
  workspaceId = workspace!.id as string;
  await owner`
    insert into connectors (id, version, manifest)
    values ('demo', '0.1.0', '{}'::jsonb) on conflict (id) do nothing`;
  const [definition] = await owner`
    insert into custom_api_definitions (workspace_id, name, current_version)
    values (${workspaceId}, 'Shop', 1) returning id`;
  const [version] = await owner`
    insert into custom_api_definition_versions
      (workspace_id, definition_id, version, schema_version, document,
       document_sha256, dataset_versions)
    values (${workspaceId}, ${definition!.id}, 1, 1,
      ${owner.json({ schemaVersion: 1 })}, ${"a".repeat(64)},
      ${owner.json({})})
    returning id`;
  versionId = version!.id as string;
  const rows: Array<[string, string, boolean, string | null]> = [
    ["A site", "demo", false, "2031-01-01T00:00:00.000Z"],
    ["B pending", "demo", true, null],
    ["C shop", "custom-api", false, "2031-01-02T00:00:00.000Z"],
  ];
  for (const [name, connectorId, setupPending, nextDueAt] of rows) {
    const pinned = connectorId === "custom-api";
    const [connection] = await owner`
      insert into connections (workspace_id, connector_id, name, setup_pending,
        custom_api_definition_version_id, custom_api_environment_id)
      values (${workspaceId}, ${connectorId}, ${name}, ${setupPending},
        ${pinned ? versionId : null}, ${pinned ? "production" : null})
      returning id`;
    await owner`
      insert into connection_state (connection_id, workspace_id, next_due_at)
      values (${connection!.id}, ${workspaceId}, ${nextDueAt}::timestamptz)`;
  }
  before = await schedule();
  await testDb.migrate();
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

afterAll(async () => {
  await owner?.end({ timeout: 5 }).catch(() => undefined);
  await testDb?.drop();
});

describe("the draft connections migration", () => {
  it("marks existing connections active and keeps their schedule and pin", async () => {
    expect(await owner`select status from connections order by name`).toEqual([
      { status: "active" },
      { status: "active" },
      { status: "active" },
    ]);
    expect(await schedule()).toEqual(before);
  });

  it("creates the test rate table with row level security", async () => {
    const [table] = await owner`
      select relrowsecurity, relforcerowsecurity from pg_class
      where relname = 'custom_api_test_rate'`;
    expect(table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("accepts a custom-api draft without a pin", async () => {
    await expect(
      owner`
        insert into connections (workspace_id, connector_id, name, status)
        values (${workspaceId}, 'custom-api', 'Draft', 'draft')`,
    ).resolves.toBeDefined();
  });
});
