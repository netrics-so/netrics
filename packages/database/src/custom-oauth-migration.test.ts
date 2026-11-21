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

// Custom OAuth (#805) on oauth_authorizations rows in the previous shape:
// connect and reauthorize rows stay, 'authorize' joins and needs a
// connection. Found by its name, not its number.

const TAG_SUFFIX = "_custom_oauth";

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
let userId: string;
let connectionId: string;
let before: Array<Record<string, unknown>>;

function authorization(
  purpose: string,
  connection: string | null,
  state: string,
) {
  return owner`
    insert into oauth_authorizations (workspace_id, user_id, provider,
      connector_id, connection_id, purpose, return_path, state_hash, nonce,
      code_verifier_encrypted, expires_at)
    values (${workspaceId}, ${userId}, 'google', 'demo', ${connection},
      ${purpose}, '/', ${state}, 'n', '\\x00'::bytea,
      now() + interval '10 minutes')`;
}

const rows = () => owner`
  select purpose, connection_id, state_hash from oauth_authorizations
  order by state_hash`;

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: lastBefore() });
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => undefined });
  const [workspace] =
    await owner`insert into workspaces (name) values ('W') returning id`;
  workspaceId = workspace!.id as string;
  const [user] = await owner`
    insert into users (email, display_name) values ('u@example.com', 'U')
    returning id`;
  userId = user!.id as string;
  await owner`
    insert into connectors (id, version, manifest)
    values ('demo', '0.1.0', '{}'::jsonb) on conflict (id) do nothing`;
  const [connection] = await owner`
    insert into connections (workspace_id, connector_id, name)
    values (${workspaceId}, 'demo', 'C') returning id`;
  connectionId = connection!.id as string;
  await authorization("connect", null, "a");
  await authorization("reauthorize", connectionId, "b");
  before = await rows();
  await testDb.migrate();
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

afterAll(async () => {
  await owner?.end({ timeout: 5 }).catch(() => undefined);
  await testDb?.drop();
});

describe("the custom OAuth migration", () => {
  it("keeps connect and reauthorize rows and accepts authorize with a connection", async () => {
    expect(await rows()).toEqual(before);
    await expect(
      authorization("authorize", connectionId, "c"),
    ).resolves.toBeDefined();
  });

  it("refuses authorize without a connection", async () => {
    await expect(authorization("authorize", null, "d")).rejects.toThrow(
      /oauth_authorizations_purpose_connection/,
    );
    await expect(authorization("other", connectionId, "e")).rejects.toThrow(
      /oauth_authorizations_purpose_(valid|connection)/,
    );
  });
});
