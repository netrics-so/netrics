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
import { createTestDatabase, type TestDatabase } from "./test-db.js";

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

describe("migration 0065 on history in the previous shape", () => {
  let test: TestDatabase, admin: postgres.Sql;

  afterAll(async () => {
    await admin?.end({ timeout: 5 });
  });

  it("drains history written before it, through both entry points", async () => {
    test = await createTestDatabase({ upTo: "0064_compare_measure_binding" });
    admin = postgres(test.adminUrl, { max: 1, onnotice: () => undefined });
    const [ws] =
      await admin`insert into workspaces(name) values ('Before') returning id`;
    const workspaceId = ws!.id as string;
    await admin`insert into connectors(id,version,manifest) values ('prune-fixture','1.0.0','{}')`;
    const { client, db } = connect(test);
    let superseded: string;
    try {
      ({ superseded } = await history(admin, db, workspaceId));
    } finally {
      await client.end({ timeout: 5 });
    }
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
  });

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
