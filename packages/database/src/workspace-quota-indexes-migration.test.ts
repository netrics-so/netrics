import { readFileSync } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { withWorkspace } from "./context.js";
import {
  connectorStagingWorkspaceBytes,
  datasetWorkspaceBytes,
} from "./data-usage.js";
import { createDatabase, migrationsFolder, type Database } from "./index.js";
import {
  createTestDatabase,
  type TestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// Workspace-leading indexes for the quota and usage queries (#604), on data
// in the previous shape: every row survives, and the queries read (and, in a
// serializable transaction, predicate-lock) only their workspace's index
// pages instead of every workspace's. Found by its name, not its number.

const TAG_SUFFIX = "_workspace_quota_indexes";
const INDEXES = {
  data_connector_stages_workspace_idx: "(workspace_id, expires_at)",
  data_datasets_workspace_idx: "(workspace_id)",
  data_generations_workspace_idx: "(workspace_id, dataset_id, sequence)",
  data_prepared_generations_workspace_idx: "(workspace_id)",
  data_refreshes_workspace_idx: "(workspace_id, dataset_id)",
};
const TABLES = [
  "data_datasets",
  "data_refreshes",
  "data_pages",
  "data_generations",
  "data_records",
  "data_prepared_generations",
  "data_connector_stages",
];

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
let db: Database;
let workspaceId: string;
const counts = async () =>
  Object.fromEntries(
    await Promise.all(
      TABLES.map(async (table) => {
        const [row] = await owner.unsafe(
          `select count(*)::int as n from ${table}`,
        );
        return [table, row!.n as number] as const;
      }),
    ),
  );
let before: Record<string, number>;

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: lastBefore() });
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => undefined });
  await owner`insert into connectors(id, version, manifest)
    values ('quota-test', '1', '{}') on conflict do nothing`;
  // Three workspaces, each with a connection, two manual datasets with two
  // complete refreshes (a page each) and two generations (two records each),
  // a published preparation with two cached outputs, and two live stages.
  await owner.unsafe(`
    insert into workspaces(name) select 'w'||g from generate_series(1,3) g;
    insert into connections(workspace_id,connector_id,name,setup_pending)
      select id,'quota-test','c',false from workspaces;
    insert into data_datasets(workspace_id,kind,key,name)
      select w.id,'manual','k'||d,'d' from workspaces w, generate_series(1,2) d;
    insert into data_schema_versions(dataset_id,workspace_id,version,definition)
      select id,workspace_id,1,'{}' from data_datasets;
    insert into data_refreshes(dataset_id,workspace_id,schema_version,refresh_key,source_collected_at,page_count,row_count,complete)
      select d.id,d.workspace_id,1,'r'||s,now(),1,2,true from data_datasets d, generate_series(1,2) s;
    insert into data_pages(refresh_id,workspace_id,page_key,sequence,digest,payload)
      select id,workspace_id,'p',1,'x','{"rows":[1,2]}' from data_refreshes;
    insert into data_generations(dataset_id,workspace_id,schema_version,refresh_key,source_started_at,sequence,row_count,created_at)
      select d.id,d.workspace_id,1,'r'||s,now(),s,2,now() - interval '1 hour' from data_datasets d, generate_series(1,2) s;
    insert into data_records(generation_id,workspace_id,record_key,collected_at,values)
      select g.id,g.workspace_id,'r'||k,now(),'{"a":1}' from data_generations g, generate_series(1,2) k;
    insert into data_preparations(workspace_id,name,graph)
      select id,'p','{}' from workspaces;
    insert into data_preparation_versions(preparation_id,workspace_id,version,graph,output_schemas,dependencies)
      select id,workspace_id,1,'{}','{}','[]' from data_preparations;
    insert into data_prepared_generations(workspace_id,preparation_id,version,input_key,generations,outputs,byte_size,expires_at)
      select workspace_id,preparation_id,1,'i'||i,'{}','{}',100,now()+interval '1 day' from data_preparation_versions, generate_series(1,2) i;
    insert into data_connector_stages(workspace_id,connection_id,connector_id,key,dataset_key,schema_version,metadata,digest,byte_size,source_collected_at,expires_at,committed_at)
      select c.workspace_id,c.id,c.connector_id,'s'||s,'rows',1,'{}','x',1000,now(),now()+interval '1 day',now()
      from connections c, generate_series(1,2) s;
  `);
  const [workspace] = await owner<
    { id: string }[]
  >`select id from workspaces order by id limit 1 offset 1`;
  workspaceId = workspace!.id;
  before = await counts();
  db = createDatabase(testDb.appUrl, { max: 1 });
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

// The first test applies the remaining migrations.
vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

afterAll(async () => {
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
  await owner?.end({ timeout: 5 }).catch(() => undefined);
  await testDb?.drop();
});

/**
 * The relations (and index pages) a serializable transaction of the
 * workspace predicate-locks while it runs `read`. Sequential scans are off:
 * the test tables are a few pages, where the planner would scan (and lock)
 * the whole table, as it does not on production-sized tables.
 */
async function lockedBy(read: Parameters<typeof withWorkspace>[2]) {
  return withWorkspace(
    db,
    { workspaceId },
    async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      await read(tx);
      // This transaction's locks only: SIRead locks of a committed one on
      // the same session stay while any overlapping serializable
      // transaction of the server runs (another suite's included).
      const locks = await tx.execute<{ locktype: string; rel: string }>(
        sql`select l.locktype, c.relname as rel from pg_locks l
          join pg_class c on c.oid = l.relation
          where l.mode = 'SIReadLock' and l.virtualtransaction = (
            select virtualtransaction from pg_locks
            where pid = pg_backend_pid() and locktype = 'virtualxid')`,
      );
      return [...locks].map((lock) => `${lock.locktype} ${lock.rel}`);
    },
    { isolationLevel: "serializable" },
  );
}

describe("the workspace quota index migration", () => {
  it("adds the indexes and keeps every row", async () => {
    await testDb.migrate();
    expect(await counts()).toEqual(before);
    const rows = await owner<{ name: string; definition: string }[]>`
      select indexname as name, indexdef as definition from pg_indexes
      where indexname in ${owner(Object.keys(INDEXES))}`;
    expect(
      Object.fromEntries(
        rows.map((row) => [
          row.name,
          row.definition.slice(row.definition.lastIndexOf("(")),
        ]),
      ),
    ).toEqual(INDEXES);
  });

  it("reads only the workspace's generations and refreshes for its usage", async () => {
    let bytes = 0;
    const locks = await lockedBy(async (tx) => {
      bytes = await datasetWorkspaceBytes(tx, workspaceId);
    });
    // Two datasets: the latest refresh's page and generation's two records.
    expect(bytes).toBeGreaterThan(0);
    expect(locks).toContain("page data_generations_workspace_idx");
    expect(locks).toContain("page data_refreshes_workspace_idx");
    // Before: every leaf page of the (id, workspace_id) tenant keys.
    expect(locks).not.toContain("page data_generations_tenant_key");
    expect(locks).not.toContain("page data_refreshes_tenant_key");
    expect(locks).not.toContain("relation data_generations");
    expect(locks).not.toContain("relation data_refreshes");
  });

  it("reads only the workspace's entries for the cache, staging and source quotas", async () => {
    const locks = await lockedBy(async (tx) => {
      await connectorStagingWorkspaceBytes(tx, workspaceId, new Date());
      await tx.execute(
        sql`select coalesce(sum(byte_size),0) from data_prepared_generations where workspace_id = ${workspaceId}`,
      );
      await tx.execute(
        sql`select count(*) from data_datasets where workspace_id = ${workspaceId}`,
      );
    });
    expect(locks).toEqual(
      expect.arrayContaining([
        "page data_connector_stages_workspace_idx",
        "page data_prepared_generations_workspace_idx",
        "page data_datasets_workspace_idx",
      ]),
    );
    // Before: a full scan of each table (other indexes or the heap).
    // (The workspace's own row through its primary key is the fence every
    // tenant transaction takes, #839; nothing serializable writes it.)
    for (const lock of locks)
      expect(lock).toMatch(
        /^(tuple .*|page workspaces_pkey|page data_(connector_stages|prepared_generations|datasets)_workspace_idx)$/,
      );
  });
});
