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

// The builder's test lease (#828) on data in the previous shape: existing
// connection state, a builder draft's included, keeps its values and reads
// as "no test running". Found by its name, not its number.

const TAG_SUFFIX = "_custom_api_test_lease";

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
const connections: string[] = [];

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: lastBefore() });
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => undefined });
  const [workspace] = await owner`
    insert into workspaces (name) values ('W') returning id`;
  workspaceId = workspace!.id as string;
  await owner`
    insert into connectors (id, version, manifest)
    values ('demo', '0.1.0', '{}'::jsonb), ('custom-api', '0.1.0', '{}'::jsonb)
    on conflict (id) do nothing`;
  const [bundled] = await owner`
    insert into connections (workspace_id, connector_id, name)
    values (${workspaceId}, 'demo', 'Site') returning id`;
  const [draft] = await owner`
    insert into connections (workspace_id, connector_id, name, status)
    values (${workspaceId}, 'custom-api', 'Custom API draft', 'draft')
    returning id`;
  for (const row of [bundled, draft]) {
    connections.push(row!.id as string);
    await owner`
      insert into connection_state
        (connection_id, workspace_id, auth_state, consecutive_failures)
      values (${row!.id as string}, ${workspaceId}, 'outage', 3)`;
  }
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

afterAll(async () => {
  await owner?.end({ timeout: 5 }).catch(() => undefined);
  await testDb?.drop();
});

describe("the custom API test lease migration", () => {
  it("keeps existing state with no test running", async () => {
    await testDb.migrate();
    const states = await owner`
      select connection_id, auth_state, consecutive_failures,
        custom_api_test_until
      from connection_state where workspace_id = ${workspaceId}
      order by connection_id`;
    expect(states).toEqual(
      [...connections].sort().map((id) => ({
        connection_id: id,
        auth_state: "outage",
        consecutive_failures: 3,
        custom_api_test_until: null,
      })),
    );
  });
});
