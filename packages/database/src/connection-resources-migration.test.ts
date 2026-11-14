import postgres from "postgres";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
  type TestDatabase,
} from "./test-db.js";

// Migration 0030 (#194) on data in the previous shape: connections,
// observations and tiles stay as they are, and the new resource-name table
// starts empty under RLS.

const LAST_BEFORE = "0029_audit_retention";

let testDb: TestDatabase;
let adminUrl: string;

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: LAST_BEFORE });
  adminUrl = testDb.adminUrl;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

// The test applies the remaining migrations.
vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

describe("migration 0030 on existing connections", () => {
  it("keeps connections and tiles and adds an empty table under RLS", async () => {
    const owner = postgres(adminUrl, { max: 1, onnotice: () => undefined });
    try {
      await owner`insert into connectors (id, version, manifest) values
        ('c', '1.0.0', ${owner.json({ id: "c" })})`;
      const [workspace] =
        await owner`insert into workspaces (name) values ('W') returning id`;
      const workspaceId = workspace!.id as string;
      const [connection] = await owner`
        insert into connections (workspace_id, connector_id, name, config)
        values (${workspaceId}, 'c', 'Apps',
                ${owner.json({ resourceSelection: ["app-1"] })})
        returning id`;
      const connectionId = connection!.id as string;
      const [dashboard] = await owner`
        insert into dashboards (workspace_id, name)
        values (${workspaceId}, 'D') returning id`;
      await owner`
        insert into dashboard_tiles (dashboard_id, workspace_id, connection_id,
          metric_key, aggregation, period, position)
        values (${dashboard!.id as string}, ${workspaceId}, ${connectionId},
                'c.downloads', 'sum', 'last_7_days', 0)`;

      await testDb.migrate();

      const [tile] = await owner`
        select dimensions, title from dashboard_tiles
        where connection_id = ${connectionId}`;
      expect({ ...tile }).toEqual({ dimensions: {}, title: null });
      const [row] = await owner`
        select config from connections where id = ${connectionId}`;
      expect(row!.config).toEqual({ resourceSelection: ["app-1"] });
      const [table] = await owner`
        select relrowsecurity, relforcerowsecurity,
               (select count(*)::int from connection_resources) as rows
        from pg_class where relname = 'connection_resources'`;
      expect({ ...table }).toEqual({
        relrowsecurity: true,
        relforcerowsecurity: true,
        rows: 0,
      });
      await owner`
        insert into connection_resources
          (connection_id, workspace_id, resource_id, name, kind)
        values (${connectionId}, ${workspaceId}, 'app-1', 'Wurfel', 'app')`;
    } finally {
      await owner.end({ timeout: 5 });
    }
  });
});
