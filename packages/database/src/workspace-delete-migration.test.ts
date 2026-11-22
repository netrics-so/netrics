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

// Deleting a workspace (#839) on data in the previous shape: existing
// workspaces are not deleted, keep their last owner, stay in the admin
// list, and existing jobs fit the new index. Found by its name, not its
// number, so a renumbering on merge does not touch this test.

const TAG_SUFFIX = "_workspace_delete";

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

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: lastBefore() });
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => undefined });
  const [user] = await owner`
    insert into users (email, display_name)
    values ('before@example.com', 'Before') returning id`;
  const [workspace] = await owner`
    select create_workspace('Before', ${user!.id as string}::uuid, 'UTC') as id`;
  workspaceId = workspace!.id as string;
  // Jobs of every status, two of them without a workspace.
  await owner`
    insert into jobs (kind, workspace_id, payload, status)
    values ('netrics.noop', ${workspaceId}, '{}', 'pending'),
           ('netrics.noop', ${workspaceId}, '{}', 'succeeded'),
           ('netrics.noop', null, '{}', 'pending'),
           ('netrics.noop', null, '{}', 'running')`;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

// The test applies the remaining migrations.
vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

afterAll(async () => {
  await owner?.end({ timeout: 5 }).catch(() => undefined);
  await testDb?.drop();
});

describe("the workspace delete migration", () => {
  it("leaves existing workspaces, owners and jobs as they were", async () => {
    await testDb.migrate();
    const [workspace] = await owner`
      select name, deleted_at from workspaces where id = ${workspaceId}`;
    expect(workspace).toEqual({ name: "Before", deleted_at: null });
    const [jobs] = await owner`select count(*)::int as count from jobs`;
    expect(jobs!.count).toBe(4);
    const listed =
      await owner`select id, member_count from admin_list_workspaces()`;
    expect(listed).toEqual([{ id: workspaceId, member_count: "1" }]);
    // The last owner still cannot be removed.
    await expect(
      owner`delete from memberships where workspace_id = ${workspaceId}`,
    ).rejects.toThrow(/last owner/);
    // Nothing waits to be purged.
    const [queued] = await owner`select enqueue_workspace_purges(10) as queued`;
    expect(queued!.queued).toBe(0);
  });
});
