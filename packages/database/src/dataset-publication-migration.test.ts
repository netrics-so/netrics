import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabase, withWorkspace, schema } from "./index.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

let test: TestDatabase,
  owner: postgres.Sql,
  workspaceId: string,
  otherId: string,
  connectionId: string;
beforeAll(async () => {
  test = await createTestDatabase({ upTo: "0055_sync_continuations" });
  owner = postgres(test.adminUrl, { max: 1 });
  const [a, b] =
    await owner`insert into workspaces(name) values ('Historical data'),('Other') returning id`;
  workspaceId = a!.id as string;
  otherId = b!.id as string;
  await owner`insert into connectors(id,version,manifest) values ('publication-migration','1.0.0','{}')`;
  const [c] =
    await owner`insert into connections(workspace_id,connector_id,name) values (${workspaceId},'publication-migration','Existing') returning id`;
  connectionId = c!.id as string;
  await owner`insert into data_datasets(workspace_id,connection_id,key,name) values (${workspaceId},${connectionId},'pruned','Previously pruned source')`;
}, 60000);
afterAll(async () => {
  await owner?.end({ timeout: 5 });
});
it("preserves old sources conservatively and gives newly registered sources a tenant-scoped first-import state", async () => {
  const before = await owner`select * from data_datasets order by id`;
  await test.migrate();
  const after = await owner`select * from data_datasets order by id`;
  expect(after.map(({ has_published_data: _state, ...row }) => row)).toEqual(
    before,
  );
  expect(after[0]!.has_published_data).toBe(true);
  const db = createDatabase(test.appUrl);
  try {
    const [created] = await withWorkspace(db, { workspaceId }, (tx) =>
      tx
        .insert(schema.dataDatasets)
        .values({
          workspaceId,
          connectionId,
          key: "first-import",
          name: "First import",
        })
        .returning(),
    );
    expect(created!.hasPublishedData).toBe(false);
    const hidden = await withWorkspace(db, { workspaceId: otherId }, (tx) =>
      tx.select().from(schema.dataDatasets),
    );
    expect(hidden).toHaveLength(0);
  } finally {
    await db.$client.end({ timeout: 5 });
  }
});
