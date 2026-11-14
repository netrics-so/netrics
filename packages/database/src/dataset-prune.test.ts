import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  sourceDatasetSchema,
  type SourceDatasetDefinition,
} from "@netrics/contracts";

import * as auth from "./auth-schema.js";
import { withWorkspace, type Db } from "./context.js";
import { ingestDatasetPage } from "./datasets.js";
import * as schema from "./schema.js";
import {
  createTestDatabase,
  TEST_DATABASE_DROP_TIMEOUT_MS,
  type TestDatabase,
} from "./test-db.js";

// Dataset history pruning against policy and connection-retention changes
// (#517). Both update data_records first and data_generations afterwards;
// prune released generations first and then waited for their records, so
// the two deadlocked and PostgreSQL aborted one of them.

const DATASET: SourceDatasetDefinition = sourceDatasetSchema.parse({
  key: "orders",
  name: "Orders",
  version: 1,
  keyFields: ["id"],
  grain: "one row",
  mode: "upsert",
  retentionDays: null,
  fields: [
    {
      id: "id",
      name: "ID",
      type: "string",
      nullable: false,
      classification: "internal",
    },
  ],
});

/** Advisory key the gate trigger waits on while the test holds it. */
const GATE = 517_001;

function roleUrl(adminUrl: string, role: string): string {
  const url = new URL(adminUrl);
  url.username = role;
  url.password = role;
  return url.toString();
}

function connect(test: TestDatabase) {
  const client = postgres(test.appUrl, { max: 2 });
  return { client, db: drizzle(client, { schema: { ...schema, ...auth } }) };
}

/**
 * A connection with two complete refreshes of DATASET: generation 1 is
 * superseded and becomes releasable once generation 2 is 15 minutes old.
 * Returns the superseded generation.
 */
async function history(
  admin: postgres.Sql,
  db: Db,
  workspaceId: string,
): Promise<{ connectionId: string; superseded: string }> {
  const [row] = await admin`
    insert into connections(workspace_id,connector_id,name)
    values (${workspaceId},'prune-fixture','C') returning id`;
  const connectionId = row!.id as string;
  for (const refreshKey of ["r1", "r2"]) {
    await withWorkspace(db, { workspaceId }, (tx) =>
      ingestDatasetPage(tx, {
        workspaceId,
        connectionId,
        definition: DATASET,
        page: {
          datasetKey: DATASET.key,
          schemaVersion: DATASET.version,
          refreshKey,
          pageKey: "p1",
          previousPageKey: null,
          complete: true,
          records: ["a", "b", "c"].map((id) => ({ values: { id } })),
        },
        now: new Date(),
      }),
    );
  }
  const [old] = await admin`
    select g.id from data_generations g join data_datasets d on d.id = g.dataset_id
    where d.connection_id = ${connectionId} and g.sequence = 1`;
  return { connectionId, superseded: old!.id as string };
}

function outcome(result: { ok: true } | { ok: false; error: unknown }) {
  if (result.ok) return "ok";
  const error = result.error as { code?: string; message?: string };
  return error.code ?? error.message ?? String(result.error);
}

async function remaining(admin: postgres.Sql, generationId: string) {
  const [row] = await admin`
    select (select count(*)::int from data_records where generation_id = ${generationId}) as records,
           (select count(*)::int from data_generations where id = ${generationId}) as generations`;
  return row as { records: number; generations: number };
}

describe("pruning dataset history concurrently with retention changes (#517)", () => {
  let test: TestDatabase;
  let admin: postgres.Sql, gate: postgres.Sql, holder: postgres.Sql;
  let pruner: postgres.Sql, app: postgres.Sql, db: Db;
  let workspaceId: string;

  beforeAll(async () => {
    test = await createTestDatabase();
    admin = postgres(test.adminUrl, { max: 1, onnotice: () => undefined });
    gate = postgres(test.adminUrl, { max: 1 });
    holder = postgres(test.adminUrl, { max: 1 });
    pruner = postgres(roleUrl(test.adminUrl, "netrics_scheduler"), { max: 1 });
    ({ client: app, db } = connect(test));
    const [ws] =
      await admin`insert into workspaces(name) values ('Prune') returning id`;
    workspaceId = ws!.id as string;
    await admin`insert into connectors(id,version,manifest) values ('prune-fixture','1.0.0','{}')`;
    // Parks the gated transaction just before it updates data_generations,
    // that is after it has updated (and locked) the workspace's records.
    await admin.unsafe(`
      create function prune_test_gate() returns trigger language plpgsql as $$
      begin
        if current_setting('prune_test.gate', true) = 'on' then
          perform pg_advisory_xact_lock_shared(${GATE});
        end if;
        return null;
      end $$;
      create trigger prune_test_gate before update on data_generations
      for each statement execute function prune_test_gate();`);
  }, 60_000);

  afterAll(async () => {
    for (const client of [app, pruner, holder, gate, admin])
      await client?.end({ timeout: 5 });
  });

  /**
   * Holds `change` open at its data_generations update (record locks held),
   * runs one prune call, then lets the change finish. Before #517 the prune
   * call waited for the records and the change then waited for the
   * generation prune had released: PostgreSQL aborted one of them (40P01).
   */
  async function pruneDuring(
    change: (tx: postgres.TransactionSql) => Promise<unknown>,
    at: Date,
  ) {
    await gate`select pg_advisory_lock(${GATE})`;
    let changed: Promise<{ ok: true } | { ok: false; error: unknown }>;
    try {
      changed = holder
        .begin(async (tx) => {
          await tx`select set_config('prune_test.gate', 'on', true)`;
          return change(tx);
        })
        .then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      await until(async () => {
        const [row] = await admin`
          select count(*)::int as n from pg_locks l
          join pg_database d on d.oid = l.database
          where d.datname = current_database() and l.locktype = 'advisory'
            and l.objid = ${GATE} and not l.granted`;
        return row!.n === 1;
      });
      const [{ pid }] = (await pruner`select pg_backend_pid() as pid`) as [
        { pid: number },
      ];
      let settled = false;
      const pruned = pruner`
        select deleted, more from prune_dataset_history_batch(${at.toISOString()}::timestamptz, 10000)`
        .then(
          ([row]) => ({ ok: true as const, row: row! }),
          (error: unknown) => ({ ok: false as const, error }),
        )
        .finally(() => (settled = true));
      // Prune either finishes while the change is parked, or waits for a
      // row lock the change holds (the old behaviour).
      await until(async () => {
        if (settled) return true;
        const [row] = await admin`
          select wait_event_type from pg_stat_activity where pid = ${pid}`;
        return row?.wait_event_type === "Lock";
      });
      await gate`select pg_advisory_unlock(${GATE})`;
      return { pruned: await pruned, changed: await changed };
    } finally {
      await gate`select pg_advisory_unlock_all()`;
    }
  }

  async function until(check: () => Promise<boolean>) {
    for (let i = 0; i < 1000; i++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("prune interleaving did not settle");
  }

  async function drained(at: Date, generationId: string) {
    const later = await pruner`
      select deleted, more from prune_dataset_history_batch(${at.toISOString()}::timestamptz, 10000)`;
    expect(later[0]!.deleted).toBeGreaterThan(0);
    expect(await remaining(admin, generationId)).toEqual({
      records: 0,
      generations: 0,
    });
    // Nothing left: the drain may stop.
    const idle = await pruner`
      select deleted, more from prune_dataset_history_batch(${at.toISOString()}::timestamptz, 10000)`;
    expect(idle[0]).toEqual({ deleted: 0, more: false });
  }

  it("skips records a policy change holds and drains them on a later call", async () => {
    const { superseded } = await history(admin, db, workspaceId);
    const at = new Date(Date.now() + 3_600_000);
    const { pruned, changed } = await pruneDuring(
      (tx) =>
        tx`select admin_set_data_policy(${workspaceId}::uuid, '{"maxRetentionDays":3650}'::jsonb)`,
      at,
    );
    // An error shows its SQLSTATE (40P01: deadlock detected).
    expect(outcome(pruned)).toBe("ok");
    expect(outcome(changed)).toBe("ok");
    const [policy] = await admin`
      select overrides from data_workspace_policies where workspace_id = ${workspaceId}`;
    expect(policy!.overrides).toEqual({ maxRetentionDays: 3650 });
    // The superseded generation was released, its locked records skipped;
    // the call says more is left, so the drain does not stop on it.
    if (!pruned.ok) return;
    expect(pruned.row.more).toBe(true);
    expect(await remaining(admin, superseded)).toEqual({
      records: 3,
      generations: 1,
    });
    await drained(at, superseded);
  });

  it("skips records a connection-retention change holds and drains them on a later call", async () => {
    const { connectionId, superseded } = await history(admin, db, workspaceId);
    const at = new Date(Date.now() + 3_600_000);
    const { pruned, changed } = await pruneDuring(async (tx) => {
      await tx`select set_config('app.workspace_id', ${workspaceId}, true)`;
      return tx`select apply_connection_retention(${workspaceId}::uuid, ${connectionId}::uuid, '{"orders":365}'::jsonb, now())`;
    }, at);
    // An error shows its SQLSTATE (40P01: deadlock detected).
    expect(outcome(pruned)).toBe("ok");
    expect(outcome(changed)).toBe("ok");
    if (!pruned.ok) return;
    expect(pruned.row.more).toBe(true);
    expect(await remaining(admin, superseded)).toEqual({
      records: 3,
      generations: 1,
    });
    await drained(at, superseded);
  });
});

/**
 * Two generations of DATASET with three records each, written in SQL: the
 * ingestion code of this commit writes columns later migrations add (0069).
 * Returns the superseded generation.
 */
async function historyInSql(admin: postgres.Sql, workspaceId: string) {
  const [connection] = await admin`
    insert into connections(workspace_id,connector_id,name)
    values (${workspaceId},'prune-fixture','C') returning id`;
  const [dataset] = await admin`
    insert into data_datasets(workspace_id,connection_id,key,name)
    values (${workspaceId},${connection!.id as string},${DATASET.key},${DATASET.name})
    returning id`;
  const datasetId = dataset!.id as string;
  await admin`
    insert into data_schema_versions(dataset_id,workspace_id,version,definition)
    values (${datasetId},${workspaceId},1,${admin.json(DATASET)})`;
  const ids: string[] = [];
  for (const sequence of [1, 2]) {
    const [generation] = await admin`
      insert into data_generations(dataset_id,workspace_id,schema_version,refresh_key,source_started_at,sequence,row_count)
      values (${datasetId},${workspaceId},1,${"r" + sequence},now(),${sequence},3) returning id`;
    ids.push(generation!.id as string);
    await admin`
      insert into data_records(generation_id,workspace_id,record_key,collected_at,values)
      select ${generation!.id as string},${workspaceId},k,now(),jsonb_build_object('id',k)
      from unnest(array['a','b','c']) k`;
  }
  return ids[0]!;
}

describe("migrations 0065 and 0069 on history in the previous shape", () => {
  let test: TestDatabase, admin: postgres.Sql;

  afterAll(async () => {
    await admin?.end({ timeout: 5 });
  });

  it("drains history written before them, through both entry points", async () => {
    test = await createTestDatabase({ upTo: "0064_compare_measure_binding" });
    admin = postgres(test.adminUrl, { max: 1, onnotice: () => undefined });
    const [ws] =
      await admin`insert into workspaces(name) values ('Before') returning id`;
    const workspaceId = ws!.id as string;
    await admin`insert into connectors(id,version,manifest) values ('prune-fixture','1.0.0','{}')`;
    const superseded = await historyInSql(admin, workspaceId);
    await test.migrate();
    const pruner = postgres(roleUrl(test.adminUrl, "netrics_scheduler"), {
      max: 1,
    });
    try {
      const at = new Date(Date.now() + 3_600_000);
      // The previous entry point still answers with the rows it pruned.
      const [first] =
        await pruner`select prune_dataset_history(${at.toISOString()}::timestamptz, 10000) as deleted`;
      expect(first!.deleted).toBeGreaterThan(0);
      for (;;) {
        const [row] = await pruner`
          select deleted, more from prune_dataset_history_batch(${at.toISOString()}::timestamptz, 10000)`;
        if (!row!.more) break;
      }
      expect(await remaining(admin, superseded)).toEqual({
        records: 0,
        generations: 0,
      });
    } finally {
      await pruner.end({ timeout: 5 });
    }
  }, 60_000);
});

describe("prune on a large record table (#524)", () => {
  let test: TestDatabase, admin: postgres.Sql, generationId: string;

  beforeAll(async () => {
    test = await createTestDatabase();
    admin = postgres(test.adminUrl, { max: 1, onnotice: () => undefined });
    const [ws] =
      await admin`insert into workspaces(name) values ('Large') returning id`;
    const workspaceId = ws!.id as string;
    await admin`insert into connectors(id,version,manifest) values ('prune-fixture','1.0.0','{}')`;
    const { client, db } = connect(test);
    try {
      await history(admin, db, workspaceId);
    } finally {
      await client.end({ timeout: 5 });
    }
    const [current] =
      await admin`select id from data_generations where sequence = 2`;
    generationId = current!.id as string;
    // Live records without a deadline, as kept without a retention ceiling.
    await addRecords("live", 200_000, false);
  }, 60_000);

  afterAll(async () => {
    await admin?.end({ timeout: 5 });
    await test?.drop();
  }, TEST_DATABASE_DROP_TIMEOUT_MS);

  /** Adds records to the current generation and refreshes statistics. */
  async function addRecords(prefix: string, count: number, expired: boolean) {
    await admin`
      insert into data_records(generation_id,workspace_id,record_key,collected_at,values,expires_at)
      select g.id, g.workspace_id, ${prefix} || i, now(), '{"id":"x"}'::jsonb,
             case when ${expired} then now() - interval '1 day' end
      from data_generations g, generate_series(1, ${count}::int) i
      where g.id = ${generationId}`;
    await admin`analyze data_records`;
  }

  /**
   * Calls prune `calls` times in one scheduler session and transaction, and
   * returns the results and the sequential scans of data_records they made.
   */
  async function prune(calls: number, batch: number) {
    const pruner = postgres(roleUrl(test.adminUrl, "netrics_scheduler"), {
      max: 1,
    });
    try {
      return await pruner.begin(async (sql) => {
        const seqScans = async () => {
          const [row] = await sql`
            select seq_scan::int as n from pg_stat_xact_user_tables
            where relname = 'data_records'`;
          return (row?.n as number | undefined) ?? 0;
        };
        const before = await seqScans();
        const results: Array<{ deleted: number; more: boolean }> = [];
        for (let call = 0; call < calls; call++) {
          const [row] = await sql`
            select deleted, more from prune_dataset_history_batch(now(), ${batch})`;
          results.push(row as { deleted: number; more: boolean });
        }
        return { results, seqScans: (await seqScans()) - before };
      });
    } finally {
      await pruner.end({ timeout: 5 });
    }
  }

  // After five calls in a session, PL/pgSQL may switch a statement to a
  // cached generic plan, planned without knowing p_now. For
  // `expires_at <= p_now` that plan assumes a third of the table matches, and
  // the check for remaining expired records scanned all of data_records.
  it("checks for expired records through the expiry index after five calls", async () => {
    const { results, seqScans } = await prune(8, 10_000);
    expect(results).toEqual(
      Array.from({ length: 8 }, () => ({ deleted: 0, more: false })),
    );
    expect(seqScans).toBe(0);
  }, 60_000);

  // When most records have expired, a plan made for the real p_now expects
  // every row to match, and a sequential scan that stops after one batch
  // looks cheapest. Each call then reads again past the records earlier calls
  // deleted and vacuum has not removed yet, so a drain slows down as it goes.
  it("deletes expired records through the expiry index when most have expired", async () => {
    // A retention ceiling expires the live records, as a policy change does.
    await admin`update data_records set expires_at = now() - interval '1 day' where record_key like 'live%'`;
    await admin`analyze data_records`;
    // A batch is a small share of the table, as in production (10,000 of
    // millions), so each batch is deleted through the primary key.
    const { results, seqScans } = await prune(12, 250);
    expect(results).toEqual(
      Array.from({ length: 12 }, () => ({ deleted: 250, more: true })),
    );
    expect(seqScans).toBe(0);
  }, 60_000);
});

describe("prune with many expired current generations (#531)", () => {
  // Generations whose dataset has no newer refresh. They stay until one
  // replaces them, so each prune call meets them again, and once drained,
  // every lookup of their records reads the index entries of all deleted
  // ones until vacuum removes them.
  const GENERATIONS = 40;
  const RECORDS = 250;
  let test: TestDatabase, admin: postgres.Sql, workspaceId: string;

  /** A connection whose dataset has one generation with one record. */
  async function currentGeneration(): Promise<string> {
    const { client, db } = connect(test);
    try {
      const [row] = await admin`
        insert into connections(workspace_id,connector_id,name)
        values (${workspaceId},'prune-fixture','C') returning id`;
      const connectionId = row!.id as string;
      await withWorkspace(db, { workspaceId }, (tx) =>
        ingestDatasetPage(tx, {
          workspaceId,
          connectionId,
          definition: DATASET,
          page: {
            datasetKey: DATASET.key,
            schemaVersion: DATASET.version,
            refreshKey: "r1",
            pageKey: "p1",
            previousPageKey: null,
            complete: true,
            records: [{ values: { id: "a" } }],
          },
          now: new Date(),
        }),
      );
      const [generation] = await admin`
        select g.id from data_generations g join data_datasets d on d.id = g.dataset_id
        where d.connection_id = ${connectionId}`;
      return generation!.id as string;
    } finally {
      await client.end({ timeout: 5 });
    }
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    admin = postgres(test.adminUrl, { max: 1, onnotice: () => undefined });
    const [ws] =
      await admin`insert into workspaces(name) values ('Current') returning id`;
    workspaceId = ws!.id as string;
    await admin`insert into connectors(id,version,manifest) values ('prune-fixture','1.0.0','{}')`;
    // The test counts the index blocks one session reads. Autovacuum of
    // these tables, due after the drain deletes every record, changes their
    // pg_class row; the prune function's cached plans are then planned again,
    // and the planner reads the primary key's metapage: one block without a
    // scan, not a lookup (#556). The test runs its own ANALYZE instead.
    await admin`alter table data_records set (autovacuum_enabled = false)`;
    await admin`alter table data_generations set (autovacuum_enabled = false)`;
    for (let i = 0; i < GENERATIONS; i++) await currentGeneration();
    // Every dataset's only generation and its records expired, as after a
    // retention ceiling.
    await admin`
      insert into data_records(generation_id,workspace_id,record_key,collected_at,values)
      select g.id, g.workspace_id, 'k' || lpad(i::text, 6, '0'), now(), '{"id":"x"}'::jsonb
      from data_generations g, generate_series(1, ${RECORDS}::int) i`;
    await admin`update data_records set expires_at = now() - interval '1 day'`;
    await admin`update data_generations set expires_at = now() - interval '1 day'`;
    await admin`analyze data_records`;
    await admin`analyze data_generations`;
  }, 120_000);

  afterAll(async () => {
    await admin?.end({ timeout: 5 });
    await test?.drop();
  }, TEST_DATABASE_DROP_TIMEOUT_MS);

  type Call = { deleted: number; more: boolean; scans: number; blocks: number };

  /**
   * One prune call in its own transaction, as the scheduler makes them, with
   * the scans of the data_records primary key it made and the index blocks
   * it read. Fails instead of waiting long for a lock.
   */
  async function call(pruner: postgres.Sql, batch: number): Promise<Call> {
    return pruner.begin(async (sql) => {
      await sql`set local lock_timeout = '5s'`;
      const stats = async () => {
        const [row] = await sql`
          select pg_stat_get_xact_numscans(i.oid)::int as scans,
                 pg_stat_get_xact_blocks_fetched(i.oid)::int as blocks
          from pg_class i where i.relname = 'data_records_generation_id_record_key_pk'`;
        return row as { scans: number; blocks: number };
      };
      const before = await stats();
      const [row] = await sql`
        select deleted, more from prune_dataset_history_batch(now(), ${batch})`;
      const after = await stats();
      return {
        deleted: row!.deleted as number,
        more: row!.more as boolean,
        scans: after.scans - before.scans,
        blocks: after.blocks - before.blocks,
      };
    });
  }

  function scheduler() {
    return postgres(roleUrl(test.adminUrl, "netrics_scheduler"), { max: 1 });
  }

  it("stops looking up records of generations it has emptied", async () => {
    const pruner = scheduler();
    try {
      const drain: Call[] = [];
      for (let i = 0; i < 100; i++) {
        const result = await call(pruner, 1000);
        drain.push(result);
        if (!result.more) break;
      }
      const deleted = drain.reduce((sum, c) => sum + c.deleted, 0);
      expect(deleted).toBe(GENERATIONS * (RECORDS + 1));
      expect(drain.at(-1)!.more).toBe(false);
      const [left] = await admin`
        select (select count(*)::int from data_records) as records,
               (select count(*)::int from data_generations) as generations`;
      // Current generations stay, so readers see them as expired.
      expect(left).toEqual({ records: 0, generations: GENERATIONS });
      // Before vacuum, with the deleted records' index entries in place.
      // Before #531 every call looked up each expired generation's records
      // at least once (40 scans and 150-170 index blocks per call here; 300
      // scans and 66,000 blocks with 100 generations of 20,000 records).
      const idle = [await call(pruner, 1000), await call(pruner, 1000)];
      expect(idle).toEqual([
        { deleted: 0, more: false, scans: 0, blocks: 0 },
        { deleted: 0, more: false, scans: 0, blocks: 0 },
      ]);
    } finally {
      await pruner.end({ timeout: 5 });
    }
  }, 120_000);

  it("marks an emptied generation without waiting for its row", async () => {
    const generationId = await currentGeneration();
    await admin`
      update data_generations set expires_at = now() - interval '1 day'
      where id = ${generationId}`;
    const holder = postgres(test.adminUrl, { max: 1 });
    const pruner = scheduler();
    try {
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      const holding = holder.begin(async (tx) => {
        await tx`select 1 from data_generations where id = ${generationId} for update`;
        locked();
        await released;
      });
      await isLocked;
      // Prune deletes its record but finds the generation row held: it
      // skips the mark and asks to be called again.
      let first: Call;
      try {
        first = await call(pruner, 1000);
      } finally {
        release();
        await holding;
      }
      expect(first).toMatchObject({ deleted: 1, more: true });
      const [held] = await admin`
        select records_pruned from data_generations where id = ${generationId}`;
      expect(held!.records_pruned).toBe(false);
      expect(await call(pruner, 1000)).toMatchObject({
        deleted: 0,
        more: false,
      });
      const [marked] = await admin`
        select records_pruned from data_generations where id = ${generationId}`;
      expect(marked!.records_pruned).toBe(true);
    } finally {
      await pruner.end({ timeout: 5 });
      await holder.end({ timeout: 5 });
    }
  }, 60_000);
});
