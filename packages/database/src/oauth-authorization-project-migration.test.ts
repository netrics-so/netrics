import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
  type TestDatabase,
} from "./test-db.js";

// Migration 0073 (#589) on data in the previous shape (0072): an OAuth
// authorization in flight gets no project and is still consumed once, as
// netrics_app, through the recreated consume_oauth_authorization(); the new
// column is returned, a project is refused on a reauthorization, and
// deleting a project clears it.

const LAST_BEFORE = "0072_store_template_versions";

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: LAST_BEFORE });
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

// The test applies the remaining migrations.
vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

describe("migration 0073 on OAuth authorizations", () => {
  it("keeps authorizations in flight working, without a project", async () => {
    const owner = postgres(testDb.adminUrl, {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      const [user] = await owner`
        insert into users (email, display_name) values ('a@example.com', 'A')
        returning id`;
      const userId = user!.id as string;
      const [workspace] = await owner`
        insert into workspaces (name) values ('W') returning id`;
      const workspaceId = workspace!.id as string;
      await owner`
        insert into connectors (id, version, manifest)
        values ('oauth-project-migration', '1.0.0', '{}')`;
      const insert = (stateHash: string) => owner`
        insert into oauth_authorizations (workspace_id, user_id, provider,
          connector_id, purpose, return_path, state_hash, nonce,
          code_verifier_encrypted, expires_at)
        values (${workspaceId}, ${userId}, 'google', 'oauth-project-migration',
          'connect', '/workspaces/w/connections/new', ${stateHash}, 'n',
          '\\x00'::bytea, now() + interval '10 minutes')
        returning id`;
      const [inFlight] = await insert("state-before");

      await testDb.migrate();

      const app = postgres(testDb.appUrl, {
        max: 1,
        onnotice: () => undefined,
      });
      try {
        const consumed = await app`
          select * from consume_oauth_authorization('state-before')`;
        expect(consumed).toHaveLength(1);
        expect(consumed[0]!.id).toBe(inFlight!.id);
        expect(consumed[0]!.project_id).toBeNull();
        expect(
          await app`select * from consume_oauth_authorization('state-before')`,
        ).toHaveLength(0);
      } finally {
        await app.end({ timeout: 5 });
      }
      const [definer] = await owner`
        select prosecdef from pg_proc
        where proname = 'consume_oauth_authorization'`;
      expect(definer!.prosecdef).toBe(true);

      // A project is stored for a new connection and cleared on delete.
      const [project] = await owner`
        insert into projects (workspace_id, name) values (${workspaceId}, 'P')
        returning id`;
      const projectId = project!.id as string;
      const [withProject] = await insert("state-after");
      await owner`
        update oauth_authorizations set project_id = ${projectId}
        where id = ${withProject!.id}`;
      await expect(
        owner`
          update oauth_authorizations
          set purpose = 'reauthorize', connection_id = ${randomUUID()}
          where id = ${withProject!.id}`,
      ).rejects.toThrow(/oauth_authorizations_project_connect/);
      await owner`delete from projects where id = ${projectId}`;
      const [cleared] = await owner`
        select project_id from oauth_authorizations
        where id = ${withProject!.id}`;
      expect(cleared!.project_id).toBeNull();
    } finally {
      await owner.end({ timeout: 5 });
    }
  });
});
