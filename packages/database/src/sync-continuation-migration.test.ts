import postgres from "postgres";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { createDatabase, withWorkspace } from "./index.js";
import {
  createTestDatabase,
  type TestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

let test: TestDatabase,
  owner: postgres.Sql,
  workspaceId: string,
  otherWorkspaceId: string,
  connectionId: string;
beforeAll(async () => {
  test = await createTestDatabase({ upTo: "0054_dashboard_measures" });
  owner = postgres(test.adminUrl, { max: 1 });
  const [workspace, other] =
    await owner`insert into workspaces(name) values ('Existing'),('Other') returning id`;
  workspaceId = workspace!.id as string;
  otherWorkspaceId = other!.id as string;
  await owner`insert into connectors(id,version,manifest) values ('migration-sync','1.0.0','{}')`;
  const [connection] =
    await owner`insert into connections(workspace_id,connector_id,name) values (${workspaceId},'migration-sync','Existing') returning id`;
  connectionId = connection!.id as string;
  await owner`insert into jobs(kind,workspace_id,connection_id,payload,status) values ('connection.sync',${workspaceId},${connectionId},${JSON.stringify({ workspace_id: workspaceId, connection_id: connectionId })}::jsonb,'pending')`;
  for (const status of ["succeeded", "failed"])
    await owner`insert into sync_runs(workspace_id,connection_id,mode,requested_from,requested_to,attempt,status,started_at,finished_at,observations_written) values (${workspaceId},${connectionId},'backfill','2026-10-01','2026-11-01',1,${status},'2026-11-05','2026-11-05',12)`;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

// The test applies the remaining migrations.
vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });
afterAll(async () => {
  await owner?.end({ timeout: 5 });
});

it("preserves completed history while adding tenant-scoped continuation records", async () => {
  const before = await owner`select * from sync_runs order by id`;
  const jobsBefore = await owner`select * from jobs order by id`;
  await test.migrate();
  expect(await owner`select * from sync_runs order by id`).toEqual(before);
  expect(await owner`select * from jobs order by id`).toEqual(jobsBefore);
  const db = createDatabase(test.appUrl);
  try {
    await withWorkspace(db, { workspaceId }, (tx) =>
      tx.execute(
        sql`insert into sync_runs(workspace_id,connection_id,mode,requested_from,requested_to,attempt,status,started_at,finished_at,cursor_after,observations_written) values (${workspaceId},${connectionId},'backfill','2026-10-01','2026-11-01',1,'continued','2026-11-05','2026-11-05','checkpoint',100)`,
      ),
    );
    const visible = await withWorkspace(db, { workspaceId }, (tx) =>
      tx.execute(
        sql`select status from sync_runs where workspace_id=${workspaceId}`,
      ),
    );
    expect(visible.map((row) => row.status).sort()).toEqual([
      "continued",
      "failed",
      "succeeded",
    ]);
    const hidden = await withWorkspace(
      db,
      { workspaceId: otherWorkspaceId },
      (tx) =>
        tx.execute(
          sql`select id from sync_runs where workspace_id=${workspaceId}`,
        ),
    );
    expect(hidden).toHaveLength(0);
  } finally {
    await db.$client.end({ timeout: 5 });
  }
});
