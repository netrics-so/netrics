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

// The owner's only workspace is not deleted (#855), on data in the
// previous shape: a workspace deleted by the function as it was, still
// waiting for its purge, stays deleted and does not count as a workspace of
// its former owner; live workspaces are untouched; the replaced function
// keeps its grants. Found by its name, not its number, so a renumbering on
// merge does not touch this test.

const TAG_SUFFIX = "_workspace_delete_last";

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

async function user(email: string): Promise<string> {
  const [row] = await owner`
    insert into users (email, display_name)
    values (${email}, ${email}) returning id`;
  return row!.id as string;
}

async function workspace(name: string, userId: string): Promise<string> {
  const [row] = await owner`
    select create_workspace(${name}, ${userId}::uuid, 'UTC') as id`;
  return row!.id as string;
}

/** delete_workspace() as `userId`, in a transaction of its own. */
function remove(workspaceId: string, userId: string, name: string) {
  return owner.begin(async (tx) => {
    await tx`select set_config('app.workspace_id', ${workspaceId}, true),
      set_config('app.user_id', ${userId}, true)`;
    const [row] = await tx<{ outcome: string }[]>`
      select delete_workspace(${name}) as outcome`;
    return row!.outcome;
  });
}

const deletedAt = async (workspaceId: string) => {
  const [row] = await owner`
    select deleted_at from workspaces where id = ${workspaceId}`;
  return row!.deleted_at as Date | null;
};

let single: { userId: string; only: string };
let pair: { userId: string; gone: string; left: string };
let both: { userId: string; a: string; b: string };

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: lastBefore() });
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => undefined });
  const singleUser = await user("single@example.com");
  single = { userId: singleUser, only: await workspace("Only", singleUser) };
  const pairUser = await user("pair@example.com");
  pair = {
    userId: pairUser,
    gone: await workspace("Gone", pairUser),
    left: await workspace("Left", pairUser),
  };
  const bothUser = await user("both@example.com");
  both = {
    userId: bothUser,
    a: await workspace("A", bothUser),
    b: await workspace("B", bothUser),
  };
  // Deleted by the function as it was; its purge has not run.
  expect(await remove(pair.gone, pair.userId, "Gone")).toBe("deleted");
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

// The test applies the remaining migrations.
vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

afterAll(async () => {
  await owner?.end({ timeout: 5 }).catch(() => undefined);
  await testDb?.drop();
});

describe("the last-workspace migration", () => {
  it("changes no data and replaces the function for the same callers", async () => {
    const before = await owner`
      select id, name, deleted_at from workspaces order by id`;
    const members = await owner`
      select workspace_id, user_id, role from memberships order by id`;
    await testDb.migrate();
    expect(
      await owner`select id, name, deleted_at from workspaces order by id`,
    ).toEqual(before);
    expect(
      await owner`
        select workspace_id, user_id, role from memberships order by id`,
    ).toEqual(members);
    const [grants] = await owner`
      select has_function_privilege('netrics_app', 'delete_workspace(text)', 'execute') as app,
             has_function_privilege('netrics_scheduler', 'delete_workspace(text)', 'execute') as scheduler,
             has_function_privilege('public', 'delete_workspace(text)', 'execute') as everyone,
             (select prosecdef from pg_proc where proname = 'delete_workspace') as definer`;
    expect(grants).toEqual({
      app: true,
      scheduler: false,
      everyone: false,
      definer: true,
    });
  });

  it("refuses an only workspace, also one whose sibling was deleted before the migration", async () => {
    await expect(
      remove(single.only, single.userId, "Only"),
    ).rejects.toMatchObject({ code: "WS002" });
    expect(await deletedAt(single.only)).toBeNull();
    // The sibling is still there, deleted and unpurged, and does not count.
    expect(await deletedAt(pair.gone)).not.toBeNull();
    await expect(remove(pair.left, pair.userId, "Left")).rejects.toMatchObject({
      code: "WS002",
    });
    expect(await deletedAt(pair.left)).toBeNull();
  });

  it("deletes one of two, then refuses the one left", async () => {
    expect(await remove(both.a, both.userId, "Wrong")).toBe("name_mismatch");
    expect(await remove(both.a, both.userId, "A")).toBe("deleted");
    expect(await deletedAt(both.a)).not.toBeNull();
    await expect(remove(both.b, both.userId, "B")).rejects.toMatchObject({
      code: "WS002",
    });
    // The deletion still queued its purge and its audit event.
    const [queued] = await owner`
      select count(*)::int as count from jobs
      where kind = 'workspace.purge'
        and payload ->> 'purge_workspace_id' = ${both.a}`;
    expect(queued!.count).toBe(1);
    const [event] = await owner`
      select metadata from audit_events
      where action = 'workspace.deleted' and target = ${both.a}`;
    expect(event!.metadata).toMatchObject({ name: "A", members: 1 });
  });
});
