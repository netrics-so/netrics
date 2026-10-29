import { readFileSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrationsFolder } from "./index.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

// The pending generated keys migration (#371, ADR 0020 §3) on data in the
// previous shape: connections and their envelopes are untouched; afterwards
// a pending key is visible to netrics_app only in its own workspace and for
// its own user, rows cannot be updated, and only the scheduler's prune
// function deletes expired rows across workspaces. Found by name, not
// number, so a renumbering on merge does not touch this test.

const TAG_SUFFIX = "_signed_key_pending_keys";

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
let app: postgres.Sql;
let scheduler: postgres.Sql;
let workspaceId: string;
let otherWorkspaceId: string;
let userId: string;
let otherUserId: string;

const connections = () => owner`
  select id, workspace_id, name, credentials_encrypted from connections
  order by name`;

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: lastBefore() });
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => undefined });
  app = postgres(testDb.appUrl, { max: 1, onnotice: () => undefined });
  const schedulerUrl = new URL(testDb.appUrl);
  schedulerUrl.username = "netrics_scheduler";
  schedulerUrl.password = "netrics_scheduler";
  scheduler = postgres(schedulerUrl.toString(), {
    max: 1,
    onnotice: () => undefined,
  });
  await owner`insert into connectors (id, version, manifest)
              values ('app-store-connect', '1.0.0', '{"id":"app-store-connect"}'::jsonb)`;
  const [workspace, other] = await owner`
    insert into workspaces (name) values ('W'), ('Other') returning id`;
  workspaceId = workspace!.id as string;
  otherWorkspaceId = other!.id as string;
  const [user, otherUser] = await owner`
    insert into users (email, display_name)
    values ('a@example.com', 'A'), ('b@example.com', 'B') returning id`;
  userId = user!.id as string;
  otherUserId = otherUser!.id as string;
  await owner`
    insert into connections (workspace_id, connector_id, name, credentials_encrypted)
    values (${workspaceId}, 'app-store-connect', 'A', ${Buffer.from("envelope-a")})`;
}, 60_000);

afterAll(async () => {
  await scheduler.end({ timeout: 5 }).catch(() => undefined);
  await app.end({ timeout: 5 }).catch(() => undefined);
  await owner.end({ timeout: 5 }).catch(() => undefined);
});

/** Runs `fn` as netrics_app with a workspace and user context. */
function asApp<T>(
  scope: { workspaceId: string; userId: string },
  fn: (tx: postgres.TransactionSql) => Promise<T>,
) {
  return app.begin(async (tx) => {
    await tx`select set_config('app.workspace_id', ${scope.workspaceId}, true)`;
    await tx`select set_config('app.user_id', ${scope.userId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

describe("the pending generated keys migration", () => {
  it("keeps every connection and adds the pending key table under RLS, empty", async () => {
    const before = await connections();
    await testDb.migrate();
    expect(await connections()).toEqual(before);
    expect(
      await owner`select count(*)::int as count from signed_key_pending_keys`,
    ).toEqual([{ count: 0 }]);
    const [table] = await owner`
      select relrowsecurity, relforcerowsecurity from pg_class
      where relname = 'signed_key_pending_keys'`;
    expect(table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await owner`
      select policyname from pg_policies
      where tablename = 'signed_key_pending_keys' order by policyname`;
    expect(policies.map((row) => row.policyname)).toEqual([
      "signed_key_pending_keys_delete",
      "signed_key_pending_keys_insert",
      "signed_key_pending_keys_select",
    ]);
  });

  it("shows a pending key only in its workspace and to its user, and never updates it", async () => {
    const mine = { workspaceId, userId };
    const [row] = await asApp(
      mine,
      (tx) => tx`
        insert into signed_key_pending_keys
          (workspace_id, user_id, provider, private_key_encrypted, expires_at)
        values (${workspaceId}, ${userId}, 'test', ${Buffer.from("sealed")},
                now() + interval '1 day')
        returning id`,
    );
    const id = row!.id as string;
    // Inserting for another user or workspace is refused by RLS.
    await expect(
      asApp(
        mine,
        (tx) => tx`
          insert into signed_key_pending_keys
            (workspace_id, user_id, provider, private_key_encrypted, expires_at)
          values (${workspaceId}, ${otherUserId}, 'test', ${Buffer.from("x")}, now())`,
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asApp(
        mine,
        (tx) => tx`
          insert into signed_key_pending_keys
            (workspace_id, user_id, provider, private_key_encrypted, expires_at)
          values (${otherWorkspaceId}, ${userId}, 'test', ${Buffer.from("x")}, now())`,
      ),
    ).rejects.toThrow(/row-level security/);

    const seen = (scope: { workspaceId: string; userId: string }) =>
      asApp(scope, (tx) => tx`select id from signed_key_pending_keys`);
    expect(await seen(mine)).toHaveLength(1);
    expect(await seen({ workspaceId, userId: otherUserId })).toHaveLength(0);
    expect(await seen({ workspaceId: otherWorkspaceId, userId })).toHaveLength(
      0,
    );
    // Another user's delete finds nothing.
    expect(
      await asApp(
        { workspaceId, userId: otherUserId },
        (tx) =>
          tx`delete from signed_key_pending_keys where id = ${id} returning id`,
      ),
    ).toHaveLength(0);
    await expect(
      asApp(
        mine,
        (tx) =>
          tx`update signed_key_pending_keys set provider = 'x' where id = ${id}`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("lets the scheduler delete only expired rows, across workspaces", async () => {
    await owner`
      insert into signed_key_pending_keys
        (workspace_id, user_id, provider, private_key_encrypted, expires_at)
      values (${otherWorkspaceId}, ${otherUserId}, 'test', ${Buffer.from("old")},
              now() - interval '1 minute')`;
    await expect(
      scheduler`select id from signed_key_pending_keys`,
    ).rejects.toThrow(/permission denied/);
    const [pruned] =
      await scheduler`select prune_signed_key_pending_keys(100) as deleted`;
    expect(pruned).toEqual({ deleted: 1 });
    expect(
      await owner`select count(*)::int as count from signed_key_pending_keys`,
    ).toEqual([{ count: 1 }]);
    await expect(
      app`select prune_signed_key_pending_keys(100)`,
    ).rejects.toThrow(/permission denied/);
  });

  it("deletes a user's pending keys with the workspace", async () => {
    await owner`delete from workspaces where id = ${workspaceId}`;
    expect(
      await owner`select count(*)::int as count from signed_key_pending_keys`,
    ).toEqual([{ count: 0 }]);
  });
});
