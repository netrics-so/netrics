import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestDatabase,
  type TestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// Retention changes write only the deadlines they move, and reach a
// workspace's records without reading other workspaces' records (#518).
// Until 0065 every admin_set_data_policy call with a ceiling rewrote every
// record of the workspace through a sequential scan of data_records.

const DAY = 86_400_000;

interface Row {
  key: string;
  collectedAt: string;
  expiresAt: string | null;
}

/**
 * A workspace with `generations` source datasets of one generation each,
 * written directly: the policy functions only read stored deadlines.
 */
async function workspace(
  sql: postgres.Sql,
  name: string,
  generations: number,
  rows: (generation: number) => Row[] | number,
): Promise<{ workspaceId: string; connectionId: string; ids: string[] }> {
  const [ws] =
    await sql`insert into workspaces(name) values (${name}) returning id`;
  const workspaceId = ws!.id as string;
  const [conn] = await sql`
    insert into connections(workspace_id,connector_id,name)
    values (${workspaceId},'rewrite-fixture',${name}) returning id`;
  const connectionId = conn!.id as string;
  const ids: string[] = [];
  for (let g = 0; g < generations; g++) {
    const [dataset] = await sql`
      insert into data_datasets(workspace_id,connection_id,key,name)
      values (${workspaceId},${connectionId},${"d" + g},${"d" + g}) returning id`;
    await sql`
      insert into data_schema_versions(dataset_id,workspace_id,version,definition)
      values (${dataset!.id},${workspaceId},1,'{}')`;
    const [generation] = await sql`
      insert into data_generations(dataset_id,workspace_id,schema_version,refresh_key,source_started_at,sequence,row_count)
      values (${dataset!.id},${workspaceId},1,'r1',now(),1,0) returning id`;
    const generationId = generation!.id as string;
    ids.push(generationId);
    const spec = rows(g);
    if (typeof spec === "number") {
      // Many plain records: collected over the last year, kept until deleted.
      await sql`
        insert into data_records(generation_id,workspace_id,record_key,collected_at,values)
        select ${generationId},${workspaceId},'k'||i,now() - (i % 365) * interval '1 day',
          jsonb_build_object('id',i,'pad',repeat('x',100))
        from generate_series(1,${spec}) i`;
    } else {
      for (const row of spec)
        await sql`
          insert into data_records(generation_id,workspace_id,record_key,collected_at,values,expires_at)
          values (${generationId},${workspaceId},${row.key},${row.collectedAt}::timestamptz,'{}',${row.expiresAt}::timestamptz)`;
    }
  }
  return { workspaceId, connectionId, ids };
}

type Counters = { seq_scan: number; idx_scan: number; n_tup_upd: number };
const TABLES = ["data_records", "data_generations", "data_refreshes"];

/** This backend's counters not yet flushed (pg_stat_xact_user_tables). */
async function counters(tx: postgres.TransactionSql) {
  const rows = await tx`
    select relname, seq_scan::int, coalesce(idx_scan,0)::int as idx_scan, n_tup_upd::int
    from pg_stat_xact_user_tables where relname in ${tx(TABLES)}`;
  return new Map(
    rows.map((row) => [row.relname as string, row as unknown as Counters]),
  );
}

/**
 * Runs `work` in one transaction and returns what it did to each table.
 * The xact view also holds earlier transactions' counts until the backend
 * flushes them, which never happens inside a transaction, so the
 * difference is this call's own.
 */
function measured(
  sql: postgres.Sql,
  work: (tx: postgres.TransactionSql) => Promise<unknown>,
) {
  return sql.begin(async (tx) => {
    const before = await counters(tx);
    await work(tx);
    const after = await counters(tx);
    const delta = (table: string): Counters => {
      const zero = { seq_scan: 0, idx_scan: 0, n_tup_upd: 0 };
      const a = after.get(table) ?? zero,
        b = before.get(table) ?? zero;
      return {
        seq_scan: a.seq_scan - b.seq_scan,
        idx_scan: a.idx_scan - b.idx_scan,
        n_tup_upd: a.n_tup_upd - b.n_tup_upd,
      };
    };
    return {
      records: delta("data_records"),
      generations: delta("data_generations"),
      refreshes: delta("data_refreshes"),
    };
  });
}

/** One policy call in its own transaction, with what it did. */
function setPolicy(
  sql: postgres.Sql,
  workspaceId: string,
  overrides: Record<string, unknown>,
) {
  return measured(
    sql,
    (tx) =>
      tx`select admin_set_data_policy(${workspaceId}::uuid, ${tx.json(overrides as postgres.JSONValue)})`,
  );
}

async function deadlines(sql: postgres.Sql, workspaceId: string) {
  const rows = await sql`
    select record_key, expires_at, xmin::text as xmin from data_records
    where workspace_id = ${workspaceId} order by record_key`;
  return new Map(
    rows.map((row) => [
      row.record_key as string,
      {
        expiresAt: row.expires_at as Date | null,
        xmin: row.xmin as string,
      },
    ]),
  );
}

describe("retention changes write only the deadlines they move (#518)", () => {
  let test: TestDatabase, admin: postgres.Sql;

  beforeAll(async () => {
    test = await createTestDatabase();
    admin = postgres(test.adminUrl, { max: 1, onnotice: () => undefined });
    await admin`insert into connectors(id,version,manifest) values ('rewrite-fixture','1.0.0','{}')`;
  }, TEST_DATABASE_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await admin?.end({ timeout: 5 });
  });

  it("writes no record when a call shortens nothing", async () => {
    const { workspaceId } = await workspace(admin, "Unchanged", 2, () => 50);
    const first = await setPolicy(admin, workspaceId, {
      maxRetentionDays: 30,
    });
    // Records kept until deleted all get a deadline.
    expect(first.records.n_tup_upd).toBe(100);
    const before = await deadlines(admin, workspaceId);

    for (const overrides of [
      { maxRetentionDays: 30 },
      { maxRetentionDays: 30, queryRows: 5 },
      { maxRetentionDays: 31 },
      { maxRetentionDays: 3650 },
    ]) {
      const call = await setPolicy(admin, workspaceId, overrides);
      expect({ overrides, updated: call.records.n_tup_upd }).toEqual({
        overrides,
        updated: 0,
      });
      expect(call.generations.n_tup_upd).toBe(0);
      expect(call.refreshes.n_tup_upd).toBe(0);
    }
    // Not one record version is new.
    expect(await deadlines(admin, workspaceId)).toEqual(before);
  });

  it("writes exactly the records whose deadline moves, to min(old, ceiling)", async () => {
    const collected = "2026-10-24T12:00:00Z";
    const at = (iso: string, days: number) =>
      new Date(new Date(iso).getTime() + days * DAY).toISOString();
    const rows: Row[] = [
      // Kept until deleted: takes the ceiling.
      { key: "a-null", collectedAt: collected, expiresAt: null },
      // Already shorter than the ceiling: stays.
      { key: "b-shorter", collectedAt: collected, expiresAt: at(collected, 5) },
      // Exactly the ceiling: stays.
      { key: "c-equal", collectedAt: collected, expiresAt: at(collected, 10) },
      // Longer by one microsecond: moves.
      {
        key: "d-longer",
        collectedAt: collected,
        expiresAt: "2026-11-03T12:00:00.000001Z",
      },
      // Longer by a year: moves.
      { key: "e-year", collectedAt: collected, expiresAt: at(collected, 365) },
      // Already expired: may still only become shorter.
      {
        key: "f-expired",
        collectedAt: "2020-01-01T00:00:00Z",
        expiresAt: "2020-02-01T00:00:00Z",
      },
      // The ceiling would end beyond 9999-12-31: no deadline, nothing moves.
      {
        key: "g-beyond",
        collectedAt: "9999-12-25T00:00:00Z",
        expiresAt: null,
      },
      {
        key: "h-beyond-set",
        collectedAt: "9999-12-25T00:00:00Z",
        expiresAt: "9999-12-30T00:00:00Z",
      },
    ];
    const { workspaceId } = await workspace(admin, "Shorten", 1, () => rows);
    const before = await deadlines(admin, workspaceId);
    // Berlin leaves summer time on 2026-10-25: days stay 24 hours (#498).
    const berlin = postgres(test.adminUrl, {
      max: 1,
      onnotice: () => undefined,
      connection: { TimeZone: "Europe/Berlin" },
    });
    let call: Awaited<ReturnType<typeof setPolicy>>;
    try {
      call = await setPolicy(berlin, workspaceId, { maxRetentionDays: 10 });
    } finally {
      await berlin.end({ timeout: 5 });
    }
    const after = await deadlines(admin, workspaceId);

    const ceiling = (row: Row) => {
      const millis = new Date(row.collectedAt).getTime() + 10 * DAY;
      return millis <= 253402300799000 ? millis : null;
    };
    // Deadlines in microseconds, as PostgreSQL stores them: a JS Date has
    // milliseconds only, and d-longer is one microsecond past the ceiling.
    const micros = (iso: string) => {
      const fraction = (/\.(\d+)Z$/.exec(iso)?.[1] ?? "").padEnd(6, "0");
      return (
        BigInt(Math.floor(new Date(iso).getTime() / 1000)) * 1_000_000n +
        BigInt(fraction.slice(0, 6))
      );
    };
    let moved = 0;
    for (const row of rows) {
      const old = row.expiresAt === null ? null : new Date(row.expiresAt);
      const limit = ceiling(row);
      const expected =
        limit === null
          ? old
          : old === null || old.getTime() > limit
            ? new Date(limit)
            : old;
      const now = after.get(row.key)!;
      expect({ key: row.key, expiresAt: now.expiresAt }).toEqual({
        key: row.key,
        expiresAt: expected,
      });
      const changed = now.xmin !== before.get(row.key)!.xmin;
      const limitMicros = limit === null ? null : BigInt(limit) * 1000n;
      expect({ key: row.key, changed }).toEqual({
        key: row.key,
        changed:
          limitMicros !== null &&
          (row.expiresAt === null || micros(row.expiresAt) > limitMicros),
      });
      if (changed) moved++;
    }
    // a-null, d-longer (a microsecond is enough), e-year and f-expired.
    // postgres.js 3 dropped the microsecond when it sent the fixture's
    // deadline, so d-longer was stored equal to the ceiling and stayed.
    expect(moved).toBe(4);
    expect(call.records.n_tup_upd).toBe(4);
  });

  it("reaches a small workspace's records without reading other workspaces' records", async () => {
    // A neighbour with many generations and records, analyzed, so the
    // planner knows one generation holds a small share of data_records.
    await workspace(admin, "Large neighbour", 40, () => 1_000);
    const { workspaceId, connectionId } = await workspace(
      admin,
      "Small",
      1,
      () => 20,
    );
    await admin`analyze data_records`;
    await admin`analyze data_generations`;

    for (const days of [30, 25]) {
      const call = await setPolicy(admin, workspaceId, {
        maxRetentionDays: days,
      });
      expect(call.records.n_tup_upd).toBe(20);
      // Found through the primary key (generation_id, record_key).
      expect(call.records.seq_scan).toBe(0);
      expect(call.records.idx_scan).toBeGreaterThan(0);
    }

    // Connection retention reaches the records the same way.
    const { records: retention } = await measured(admin, async (tx) => {
      await tx`select set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`select apply_connection_retention(${workspaceId}::uuid, ${connectionId}::uuid, '{"d0":10}'::jsonb, now())`;
    });
    expect(retention.n_tup_upd).toBe(20);
    expect(retention.seq_scan).toBe(0);
  });

  it("writes no record when a connection-retention call changes nothing", async () => {
    const { workspaceId, connectionId, ids } = await workspace(
      admin,
      "Connection",
      2,
      () => 25,
    );
    // d1 gets a newer, empty generation: its first one is superseded.
    await admin`
      insert into data_generations(dataset_id,workspace_id,schema_version,refresh_key,source_started_at,sequence,row_count)
      select dataset_id,workspace_id,1,'r2',now(),2,0 from data_generations where id = ${ids[1]!}`;
    const apply = (days: Record<string, number | null>) =>
      measured(admin, async (tx) => {
        await tx`select set_config('app.workspace_id', ${workspaceId}, true)`;
        await tx`select apply_connection_retention(${workspaceId}::uuid, ${connectionId}::uuid, ${tx.json(days)}, now())`;
      });
    const first = await apply({ d0: 90, d1: 90 });
    expect(first.records.n_tup_upd).toBe(50);
    const before = await deadlines(admin, workspaceId);
    const again = await apply({ d0: 90, d1: 90 });
    expect(again.records.n_tup_upd).toBe(0);
    expect(again.generations.n_tup_upd).toBe(0);
    expect(again.refreshes.n_tup_upd).toBe(0);
    expect(await deadlines(admin, workspaceId)).toEqual(before);
    // A longer period moves the current generation's records only; the
    // superseded generation's records can only become shorter.
    const longer = await apply({ d0: 120, d1: 120 });
    expect(longer.records.n_tup_upd).toBe(25);
  });
});

describe("migration 0066 on deadlines in the previous shape", () => {
  let test: TestDatabase, admin: postgres.Sql;

  afterAll(async () => {
    await admin?.end({ timeout: 5 });
  });

  it("keeps deadlines set before it and writes none on an unchanged ceiling", async () => {
    test = await createTestDatabase({ upTo: "0065_prune_skip_locked" });
    admin = postgres(test.adminUrl, { max: 1, onnotice: () => undefined });
    await admin`insert into connectors(id,version,manifest) values ('rewrite-fixture','1.0.0','{}')`;
    const { workspaceId } = await workspace(admin, "Before", 2, () => 30);
    // The previous function: rewrites every record on every call.
    const previous = await setPolicy(admin, workspaceId, {
      maxRetentionDays: 30,
    });
    expect(previous.records.n_tup_upd).toBe(60);
    const again = await setPolicy(admin, workspaceId, {
      maxRetentionDays: 30,
    });
    expect(again.records.n_tup_upd).toBe(60);
    const before = await deadlines(admin, workspaceId);

    await test.migrate();

    const unchanged = await setPolicy(admin, workspaceId, {
      maxRetentionDays: 30,
    });
    expect(unchanged.records.n_tup_upd).toBe(0);
    expect(await deadlines(admin, workspaceId)).toEqual(before);
    const shorter = await setPolicy(admin, workspaceId, {
      maxRetentionDays: 7,
    });
    expect(shorter.records.n_tup_upd).toBe(60);
    const [wrong] = await admin`
      select count(*)::int as n from data_records
      where workspace_id = ${workspaceId}
        and expires_at <> collected_at + interval '7 days'`;
    expect(wrong!.n).toBe(0);
  }, 60_000);
});
