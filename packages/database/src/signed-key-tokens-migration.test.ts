import { readFileSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrationsFolder } from "./index.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

// The signed-key token store migration (#369, ADR 0020 §2) on data in the
// previous shape: existing connections and their credential envelopes stay
// as they are and get no token row; afterwards tokens are stored under RLS,
// tied to a connection of their own workspace, and deleted with it. Found by
// name, not number, so a renumbering on merge does not touch this test.

const TAG_SUFFIX = "_signed_key_tokens";

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
let workspaceId: string;
let otherWorkspaceId: string;
let connectionId: string;

const connections = () => owner`
  select id, workspace_id, name, credentials_encrypted from connections
  order by name`;

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: lastBefore() });
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => undefined });
  app = postgres(testDb.appUrl, { max: 1, onnotice: () => undefined });
  await owner`insert into connectors (id, version, manifest)
              values ('app-store-connect', '1.0.0', '{"id":"app-store-connect"}'::jsonb)`;
  const [workspace, other] = await owner`
    insert into workspaces (name) values ('W'), ('Other') returning id`;
  workspaceId = workspace!.id as string;
  otherWorkspaceId = other!.id as string;
  const [connection] = await owner`
    insert into connections (workspace_id, connector_id, name, credentials_encrypted)
    values (${workspaceId}, 'app-store-connect', 'A', ${Buffer.from("envelope-a")})
    returning id`;
  connectionId = connection!.id as string;
  await owner`
    insert into connections (workspace_id, connector_id, name, credentials_encrypted)
    values (${otherWorkspaceId}, 'app-store-connect', 'B', ${Buffer.from("envelope-b")})`;
}, 60_000);

afterAll(async () => {
  await app.end({ timeout: 5 }).catch(() => undefined);
  await owner.end({ timeout: 5 }).catch(() => undefined);
});

describe("the signed-key token store migration", () => {
  it("keeps every connection and adds the token table under RLS, empty", async () => {
    const before = await connections();
    expect(before).toHaveLength(2);

    await testDb.migrate();

    expect(await connections()).toEqual(before);
    expect(
      await owner`select count(*)::int as count from connection_signed_key_tokens`,
    ).toEqual([{ count: 0 }]);
    const [table] = await owner`
      select relrowsecurity, relforcerowsecurity from pg_class
      where relname = 'connection_signed_key_tokens'`;
    expect(table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await owner`
      select policyname from pg_policies
      where tablename = 'connection_signed_key_tokens' order by policyname`;
    expect(policies.map((row) => row.policyname)).toEqual([
      "connection_signed_key_tokens_delete",
      "connection_signed_key_tokens_insert",
      "connection_signed_key_tokens_select",
      "connection_signed_key_tokens_update",
    ]);
  });

  it("ties a token to a connection of its own workspace and deletes it with the connection", async () => {
    await expect(
      owner`insert into connection_signed_key_tokens (connection_id, workspace_id)
            values (${connectionId}, ${otherWorkspaceId})`,
    ).rejects.toThrow(/connection_signed_key_tokens_connection_fk/);
    await expect(
      owner`insert into connection_signed_key_tokens
              (connection_id, workspace_id, access_token_encrypted)
            values (${connectionId}, ${workspaceId}, ${Buffer.from("x")})`,
    ).rejects.toThrow(/connection_signed_key_tokens_expiry/);
    await owner`insert into connection_signed_key_tokens (connection_id, workspace_id)
                values (${connectionId}, ${workspaceId})`;

    // netrics_app sees it only in its own workspace.
    const seen = (scope: string) =>
      app.begin(async (tx) => {
        await tx`select set_config('app.workspace_id', ${scope}, true)`;
        return tx`select connection_id from connection_signed_key_tokens`;
      });
    expect(await seen(workspaceId)).toHaveLength(1);
    expect(await seen(otherWorkspaceId)).toHaveLength(0);

    await owner`delete from connections where id = ${connectionId}`;
    expect(
      await owner`select count(*)::int as count from connection_signed_key_tokens`,
    ).toEqual([{ count: 0 }]);
  });
});
