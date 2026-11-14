import postgres from "postgres";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
  type TestDatabase,
} from "./test-db.js";

// Migration 0071 (#572) on data in the previous shape (0070): projects get
// archived_at (null: nothing is archived), preparations and models get a
// project_id (null: unassigned). Existing project references stay as they
// were, and deleting a project still clears every reference to it.

const LAST_BEFORE = "0070_prune_revoked_devices";

let testDb: TestDatabase;
let adminUrl: string;

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: LAST_BEFORE });
  adminUrl = testDb.adminUrl;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

// The test applies the remaining migrations.
vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

describe("migration 0071 on projects, preparations and models", () => {
  it("archives nothing, assigns nothing and keeps existing references", async () => {
    const owner = postgres(adminUrl, { max: 1, onnotice: () => undefined });
    try {
      const [user] = await owner`
        insert into users (email, display_name) values ('a@example.com', 'A')
        returning id`;
      const userId = user!.id as string;
      const [workspace] = await owner`
        insert into workspaces (name) values ('W') returning id`;
      const workspaceId = workspace!.id as string;
      const [project] = await owner`
        insert into projects (workspace_id, name) values (${workspaceId}, 'P')
        returning id`;
      const projectId = project!.id as string;
      await owner`
        insert into connectors (id, version, manifest)
        values ('project-archive-migration', '1.0.0', '{}')`;
      await owner`
        insert into connections (workspace_id, project_id, connector_id, name)
        values (${workspaceId}, ${projectId}, 'project-archive-migration', 'C')`;
      await owner`
        insert into dashboards (workspace_id, project_id, name)
        values (${workspaceId}, ${projectId}, 'D')`;
      await owner`
        insert into memberships (workspace_id, user_id, role, active_project_id)
        values (${workspaceId}, ${userId}, 'owner', ${projectId})`;
      await owner`
        insert into data_preparations (workspace_id, name, graph)
        values (${workspaceId}, 'Prep', ${owner.json({ nodes: [], edges: [] })})`;
      await owner`
        insert into data_models (workspace_id, name, definition)
        values (${workspaceId}, 'Model', ${owner.json({ sources: [], measures: [] })})`;

      await testDb.migrate();

      const [migratedProject] = await owner`
        select archived_at from projects where id = ${projectId}`;
      const [preparation] =
        await owner`select project_id from data_preparations`;
      const [model] = await owner`select project_id from data_models`;
      const [membership] = await owner`
        select active_project_id from memberships where user_id = ${userId}`;
      const [connection] = await owner`select project_id from connections`;
      const [dashboard] = await owner`select project_id from dashboards`;
      expect(migratedProject!.archived_at).toBeNull();
      expect(preparation!.project_id).toBeNull();
      expect(model!.project_id).toBeNull();
      expect(membership!.active_project_id).toBe(projectId); // untouched
      expect(connection!.project_id).toBe(projectId);
      expect(dashboard!.project_id).toBe(projectId);

      // Deleting the project still nulls every reference, including the new ones.
      await owner`update data_models set project_id = ${projectId}`;
      await owner`update data_preparations set project_id = ${projectId}`;
      await owner`delete from projects where id = ${projectId}`;
      expect(
        (await owner`select project_id from data_models`)[0]!.project_id,
      ).toBeNull();
      expect(
        (await owner`select project_id from data_preparations`)[0]!.project_id,
      ).toBeNull();
      expect(
        (await owner`select active_project_id from memberships`)[0]!
          .active_project_id,
      ).toBeNull();
    } finally {
      await owner.end({ timeout: 5 });
    }
  });
});
