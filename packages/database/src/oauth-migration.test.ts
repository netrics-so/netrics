import { randomBytes } from "node:crypto";

import postgres from "postgres";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
  type TestDatabase,
} from "./test-db.js";

// Migration 0022 (ADR 0012) on a database in the previous shape: existing
// connections, credentials and connection states must survive unchanged.

const LAST_BEFORE_OAUTH = "0021_device_heartbeat";

let testDb: TestDatabase;
let adminUrl: string;

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: LAST_BEFORE_OAUTH });
  adminUrl = testDb.adminUrl;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

// The test applies the remaining migrations.
vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

describe("migration 0022 on existing connections", () => {
  it("keeps connections, credentials and states, and adds the OAuth records", async () => {
    const owner = postgres(adminUrl, { max: 1 });
    try {
      const [shape] = await owner`
        select to_regclass('connection_oauth') as oauth_table`;
      expect(shape!.oauth_table).toBeNull();

      // Data in the 0021 shape (as the owner; RLS does not apply).
      const [user] = await owner`
        insert into users (email, display_name) values ('m@example.com', 'M')
        returning id`;
      const [workspace] = await owner`
        insert into workspaces (name) values ('W') returning id`;
      await owner`insert into connectors (id, version, manifest)
        values ('vercel', '1.0.0', '{"id":"vercel"}')`;
      const envelope = randomBytes(64);
      const connections = await owner`
        insert into connections (workspace_id, connector_id, name, config, credentials_encrypted)
        values
          (${workspace!.id}, 'vercel', 'ok', '{"projectId":"p"}', ${envelope}),
          (${workspace!.id}, 'vercel', 'failing', '{}', ${envelope}),
          (${workspace!.id}, 'vercel', 'down', '{}', null)
        returning id, name`;
      for (const [index, authState] of [
        "ok",
        "auth_failed",
        "outage",
      ].entries()) {
        await owner`
          insert into connection_state
            (connection_id, workspace_id, next_due_at, auth_state, consecutive_failures)
          values (${connections[index]!.id}, ${workspace!.id}, now(), ${authState}, ${index})`;
      }
      const before = await owner`
        select c.id, c.name, c.config, c.credentials_encrypted,
               s.auth_state, s.next_due_at, s.consecutive_failures
        from connections c join connection_state s on s.connection_id = c.id
        order by c.name`;

      await testDb.migrate();

      const after = await owner`
        select c.id, c.name, c.config, c.credentials_encrypted,
               s.auth_state, s.next_due_at, s.consecutive_failures
        from connections c join connection_state s on s.connection_id = c.id
        order by c.name`;
      expect(after).toEqual(before);
      expect(
        await owner`select auth_reason from connection_state where auth_reason is not null`,
      ).toHaveLength(0);
      expect(await owner`select * from connection_oauth`).toHaveLength(0);
      expect(await owner`select * from oauth_authorizations`).toHaveLength(0);

      // The new state and records work on the migrated rows.
      await owner`
        update connection_state
        set auth_state = 'needs_reauthorization', auth_reason = 'invalid_grant'
        where connection_id = ${connections[0]!.id}`;
      await owner`
        insert into connection_oauth
          (connection_id, workspace_id, provider, account_sub, granted_scopes)
        values (${connections[0]!.id}, ${workspace!.id}, 'google', 'sub', '{openid}')`;
      await owner`
        insert into oauth_authorizations
          (workspace_id, user_id, provider, connector_id, purpose, return_path,
           state_hash, nonce, code_verifier_encrypted, expires_at)
        values (${workspace!.id}, ${user!.id}, 'google', 'vercel', 'connect', '/',
                'hash', 'nonce', '\\x00', now() + interval '10 minutes')`;
    } finally {
      await owner.end({ timeout: 5 });
    }
  });
});
