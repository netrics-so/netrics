import { arch, cpus, platform, release, totalmem } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminSetDataPolicy,
  createDatabase,
  createRawSqlClient,
  createWorkspace,
  ingestDatasetPage,
  pruneDatasetHistory,
  schema,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";
import {
  sourceDatasetSchema,
  type SourceDatasetDefinition,
} from "@netrics/contracts";
import type { SemanticModelDefinition } from "@netrics/domain";
import { queryDashboardMeasure } from "../dashboards/data.js";
import { createTestDatabase } from "../test-db.js";
import { createDataService, type DataActor } from "./service.js";

// Retained-history scale acceptance (#501). Opt-in like scale-validation:
// a reproducible measurement, not a timing gate. Sizes come from the
// environment so the same file serves a quick trial and the recorded run;
// scripts/scale/run.mjs repeats it and summarizes the spread.
const enabled = process.env.NETRICS_SCALE_HISTORY === "1";
const size = (name: string, fallback: number) =>
  Number(process.env[name] ?? fallback);
const CONNECTIONS = size("NETRICS_SCALE_CONNECTIONS", 20);
const DATASETS = size("NETRICS_SCALE_DATASETS_PER_CONNECTION", 5);
const ROWS = size("NETRICS_SCALE_ROWS_PER_DATASET", 20_000);
const SAMPLES = size("NETRICS_SCALE_SAMPLES", 10);
const TARGETS = (process.env.NETRICS_SCALE_QUERY_ROWS ?? "10000,50000,100000")
  .split(",")
  .map(Number);
// The scheduler's defaults: 10,000 rows per call, 10-second drain budget.
const PRUNE_BATCH = 10_000;
const PRUNE_BUDGET_MS = size("NETRICS_SCALE_PRUNE_BUDGET_MS", 10_000);

const T0 = new Date("2026-11-05T12:00:00Z");
const MINUTE = 60_000,
  DAY = 86_400_000;
const COUNTRIES = ["US", "DE", "GB", "FR", "JP", "BR", "IN", "CA", "AU", "ES"];
const CHANNELS = ["store", "web", "partner"];

const result: Record<string, unknown> = {};
const ms = (start: number) => Math.round((performance.now() - start) * 10) / 10;
function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
  return {
    n: sorted.length,
    p50: rank(0.5),
    p95: rank(0.95),
    min: sorted[0]!,
    max: sorted.at(-1)!,
  };
}

/** Report-like width: ten typed fields, about 230 bytes of JSON per row. */
const definition = (key: string): SourceDatasetDefinition =>
  sourceDatasetSchema.parse({
    key,
    name: "Synthetic report " + key,
    version: 1,
    mode: "upsert",
    grain: "one synthetic report line",
    keyFields: ["id"],
    retentionDays: null,
    fields: [
      ["id", "string"],
      ["date", "date"],
      ["app", "string"],
      ["country", "string"],
      ["product", "string"],
      ["channel", "string"],
      ["units", "integer"],
      ["currency", "string"],
    ]
      .map(([id, type]) => ({
        id,
        name: id!,
        type,
        nullable: false,
        classification: "internal",
      }))
      .concat([
        {
          id: "amount",
          name: "amount",
          type: "decimal",
          nullable: false,
          classification: "internal",
          unit: "currency",
          currencyField: "currency",
          scale: 2,
        } as never,
        {
          id: "order_ref",
          name: "order_ref",
          type: "string",
          nullable: true,
          classification: "internal",
        },
      ]),
  });
const day = (index: number) =>
  new Date(Date.UTC(2025, 10, 1) + (index % 365) * DAY)
    .toISOString()
    .slice(0, 10);
const record = (index: number, amount?: string) => ({
  values: {
    id: "line-" + index,
    date: day(index),
    app: "com.example.app" + (index % 200),
    country: COUNTRIES[index % COUNTRIES.length],
    product: "sku-" + (index % 50),
    channel: CHANNELS[index % CHANNELS.length],
    units: 1 + (index % 5),
    currency: "EUR",
    amount: amount ?? ((index % 1000) / 100).toFixed(2),
    order_ref: "GPA.3300-" + String(index).padStart(10, "0"),
  },
});

let db: Database, scheduler: Database, admin: Sql;
let actor: DataActor, smallActor: DataActor;
let service: ReturnType<typeof createDataService>;
let clock = T0;

async function connection(workspaceId: string, name: string) {
  const [row] = await withWorkspace(db, { workspaceId }, (tx) =>
    tx
      .insert(schema.connections)
      .values({ workspaceId, connectorId: "scale-fixture", name })
      .returning(),
  );
  return row!.id;
}
/** One refresh in 1,000-record pages, one transaction per page like a sync turn. */
async function ingest(
  workspaceId: string,
  connectionId: string,
  key: string,
  refreshKey: string,
  count: number,
  make: (index: number) => ReturnType<typeof record> = record,
) {
  let generationId: string | null = null,
    datasetId = "";
  for (let offset = 0, page = 0; offset < count; offset += 1000, page++) {
    const out = await withWorkspace(db, { workspaceId }, (tx) =>
      ingestDatasetPage(tx, {
        workspaceId,
        connectionId,
        definition: definition(key),
        page: {
          datasetKey: key,
          schemaVersion: 1,
          refreshKey,
          pageKey: "p" + page,
          previousPageKey: page ? "p" + (page - 1) : null,
          complete: offset + 1000 >= count,
          records: Array.from(
            { length: Math.min(1000, count - offset) },
            (_, i) => make(offset + i),
          ),
        },
        now: clock,
      }),
    );
    generationId = out.generationId;
    datasetId = out.datasetId;
  }
  return { generationId, datasetId };
}
async function storage(label: string) {
  const relations = [
    "data_records",
    "data_pages",
    "data_generations",
    "data_refreshes",
    "data_prepared_generations",
    "data_model_query_snapshots",
  ];
  const rows = await admin`
    select c.relname as relation,
      pg_relation_size(c.oid)::bigint as heap,
      pg_indexes_size(c.oid)::bigint as indexes,
      (pg_total_relation_size(c.oid) - pg_relation_size(c.oid) - pg_indexes_size(c.oid))::bigint as toast,
      pg_total_relation_size(c.oid)::bigint as total,
      coalesce(s.n_live_tup, 0)::bigint as live, coalesce(s.n_dead_tup, 0)::bigint as dead
    from pg_class c left join pg_stat_user_tables s on s.relid = c.oid
    where c.relname in ${admin(relations)} and c.relkind = 'r'`;
  const [counts] = await admin`
    select (select count(*) from data_records)::bigint as records,
      (select count(*) from data_records where expires_at is null or expires_at > ${clock})::bigint as current_records,
      (select count(*) from data_generations)::bigint as generations,
      (select count(*) from data_pages)::bigint as pages,
      (select coalesce(sum(jsonb_array_length(payload->'records')), 0) from data_pages)::bigint as page_records,
      (select count(*) from data_datasets)::bigint as datasets,
      pg_database_size(current_database())::bigint as database`;
  const snapshot = {
    counts: Object.fromEntries(
      Object.entries(counts!).map(([k, v]) => [k, Number(v)]),
    ),
    relations: Object.fromEntries(
      rows.map((row) => [
        row.relation as string,
        Object.fromEntries(
          Object.entries(row)
            .filter(([k]) => k !== "relation")
            .map(([k, v]) => [k, Number(v)]),
        ),
      ]),
    ),
  };
  result.storage ??= {} as Record<string, unknown>;
  (result.storage as Record<string, unknown>)[label] = snapshot;
  return snapshot;
}
/** The scheduler's drainDatasetHistory loop, tick by tick, until no backlog. */
async function drain(label: string, now: Date) {
  const ticks: Array<{ ms: number; deleted: number; calls: number }> = [];
  const calls: number[] = [];
  const started = performance.now();
  for (let tick = 0; tick < 1000; tick++) {
    const deadline = Date.now() + PRUNE_BUDGET_MS;
    const tickStart = performance.now();
    let deleted = 0,
      count = 0,
      backlog = false;
    for (;;) {
      const call = performance.now();
      const n = await pruneDatasetHistory(scheduler, now, PRUNE_BATCH);
      calls.push(ms(call));
      deleted += n;
      count++;
      if (n < PRUNE_BATCH) break;
      if (Date.now() >= deadline) {
        backlog = true;
        break;
      }
    }
    ticks.push({ ms: ms(tickStart), deleted, calls: count });
    if (!backlog) break;
  }
  const deleted = ticks.reduce((sum, tick) => sum + tick.deleted, 0);
  const total = ms(started);
  result.drain ??= {} as Record<string, unknown>;
  (result.drain as Record<string, unknown>)[label] = {
    ticks: ticks.length,
    deletedRows: deleted,
    totalMs: total,
    rowsPerSecond: Math.round(deleted / (total / 1000)),
    callMs: stats(calls),
    tickMs: stats(ticks.map((tick) => tick.ms)),
  };
}

interface Target {
  rows: number;
  datasetId: string;
  modelId: string;
}
const targets: Target[] = [];
async function publishModel(datasetId: string, name: string) {
  const model: SemanticModelDefinition = {
    version: 1,
    datasets: [datasetId],
    relationships: [],
    dimensions: [
      {
        id: "date",
        name: "Date",
        datasetId,
        fieldId: "date",
        timeAlignment: "reporting_date",
      },
      { id: "app", name: "App", datasetId, fieldId: "app" },
      { id: "country", name: "Country", datasetId, fieldId: "country" },
    ],
    measures: [
      {
        id: "amount",
        name: "Amount",
        kind: "aggregate",
        datasetId,
        aggregate: {
          id: "amount",
          name: "Amount",
          op: "sum",
          fieldId: "amount",
        },
      },
      {
        id: "units",
        name: "Units",
        kind: "aggregate",
        datasetId,
        aggregate: { id: "units", name: "Units", op: "sum", fieldId: "units" },
      },
    ],
  };
  const saved = await service.saveModel(actor, { name, definition: model });
  await service.publishModel(actor, saved.model.id, saved.model.version);
  return saved.model.id;
}
const QUERIES = {
  model_total: (t: Target) =>
    service.query(actor, t.modelId, {
      measureIds: ["amount", "units"],
      groupBy: [],
    }),
  model_by_day: (t: Target) =>
    service.query(actor, t.modelId, {
      measureIds: ["amount", "units"],
      groupBy: ["date"],
      limit: 1000,
    }),
  model_by_app_country: (t: Target) =>
    service.query(actor, t.modelId, {
      measureIds: ["amount"],
      groupBy: ["app", "country"],
      limit: 1000,
    }),
  dashboard_value: (t: Target) =>
    withWorkspace(
      db,
      { workspaceId: actor.workspaceId, userId: actor.callerId },
      (tx) =>
        queryDashboardMeasure(
          tx,
          actor.workspaceId,
          {
            id: "value",
            binding: {
              modelId: t.modelId,
              measureIds: ["amount"],
              groupBy: [],
              exclusions: [],
            },
            options: { view: "value", limit: 1 },
          },
          [],
          {},
          clock,
        ),
    ),
  dashboard_line_by_day: (t: Target) =>
    withWorkspace(
      db,
      { workspaceId: actor.workspaceId, userId: actor.callerId },
      (tx) =>
        queryDashboardMeasure(
          tx,
          actor.workspaceId,
          {
            id: "line",
            binding: {
              modelId: t.modelId,
              measureIds: ["amount"],
              groupBy: ["date"],
              exclusions: [],
            },
            options: { view: "line", limit: 1000 },
          },
          [],
          {},
          clock,
        ),
    ),
};
async function latency(label: string) {
  const out: Record<string, unknown> = {};
  for (const target of targets) {
    const perQuery: Record<string, unknown> = {};
    for (const [name, run] of Object.entries(QUERIES)) {
      const samples: number[] = [];
      let first = 0,
        rssPeak = 0;
      for (let i = 0; i <= SAMPLES; i++) {
        const start = performance.now();
        const value = await run(target);
        const elapsed = ms(start);
        rssPeak = Math.max(rssPeak, process.memoryUsage.rss());
        if (i === 0) {
          first = elapsed;
          // Every query returns rows; a failed dashboard widget carries an error.
          expect("error" in value ? value.error : null).toBeNull();
        } else samples.push(elapsed);
      }
      perQuery[name] = {
        firstMs: first,
        ...stats(samples),
        rssMiB: Math.round(rssPeak / 1048576),
      };
    }
    out[String(target.rows)] = perQuery;
  }
  result.latency ??= {} as Record<string, unknown>;
  (result.latency as Record<string, unknown>)[label] = out;
}

beforeAll(async () => {
  if (!enabled) return;
  const test = await createTestDatabase();
  db = createDatabase(test.appUrl, { max: 4 });
  admin = createRawSqlClient(test.adminUrl, { max: 1, onnotice: () => {} });
  const schedulerUrl = new URL(test.adminUrl);
  schedulerUrl.username = "netrics_scheduler";
  schedulerUrl.password = "netrics_scheduler";
  scheduler = createDatabase(schedulerUrl.toString(), { max: 1 });
  const [user] = await db
    .insert(schema.users)
    .values({ email: "history-scale@example.test", displayName: "Scale" })
    .returning();
  actor = {
    workspaceId: await createWorkspace(db, {
      name: "Large history",
      ownerUserId: user!.id,
    }),
    callerId: user!.id,
  };
  smallActor = {
    workspaceId: await createWorkspace(db, {
      name: "Small neighbour",
      ownerUserId: user!.id,
    }),
    callerId: user!.id,
  };
  await admin`insert into connectors(id,version,manifest) values ('scale-fixture','1.0.0','{}')`;
  service = createDataService(db, () => clock);
}, 120_000);
afterAll(async () => {
  if (!enabled) return;
  const [server] =
    await admin`select current_setting('server_version') as version, current_setting('shared_buffers') as shared_buffers, current_setting('work_mem') as work_mem`;
  console.log(
    "NETRICS_SCALE_HISTORY_RESULT " +
      JSON.stringify({
        environment: {
          node: process.version,
          platform: platform(),
          release: release(),
          arch: arch(),
          cpu: cpus()[0]?.model,
          cpus: cpus().length,
          memoryGiB: Math.round(totalmem() / 1073741824),
          postgres: server!.version,
          sharedBuffers: server!.shared_buffers,
          workMem: server!.work_mem,
        },
        sizes: {
          connections: CONNECTIONS,
          datasetsPerConnection: DATASETS,
          rowsPerDataset: ROWS,
          queryTargets: TARGETS,
          samples: SAMPLES,
          pruneBatch: PRUNE_BATCH,
          pruneBudgetMs: PRUNE_BUDGET_MS,
        },
        ...result,
      }),
  );
  await db?.$client.end({ timeout: 5 });
  await scheduler?.$client.end({ timeout: 5 });
  await admin?.end({ timeout: 5 });
});

describe.runIf(enabled)("retained history at scale (#501)", () => {
  it("measures query latency, policy rewrites, prune drains and storage growth", async () => {
    // Query targets: one connection, one dataset per size.
    const targetConnection = await connection(actor.workspaceId, "Targets");
    for (const rows of TARGETS) {
      const start = performance.now();
      const { datasetId, generationId } = await ingest(
        actor.workspaceId,
        targetConnection,
        "target_" + rows,
        "initial",
        rows,
      );
      expect(generationId).not.toBeNull();
      targets.push({
        rows,
        datasetId,
        modelId: await publishModel(datasetId, "Target " + rows),
      });
      result.targetIngestMs ??= {} as Record<string, number>;
      (result.targetIngestMs as Record<string, number>)[rows] = ms(start);
    }
    await latency("small_history");
    await storage("targets_only");

    // Background history: many connections and datasets, each with an
    // initial refresh and a one-record correction (a second full generation).
    const ingestStart = performance.now();
    const corrections: number[] = [],
      initials: number[] = [];
    for (let c = 0; c < CONNECTIONS; c++) {
      const id = await connection(actor.workspaceId, "Background " + c);
      for (let d = 0; d < DATASETS; d++) {
        const key = "facts_" + d;
        let start = performance.now();
        await ingest(actor.workspaceId, id, key, "initial", ROWS);
        initials.push(ms(start));
        start = performance.now();
        await ingest(actor.workspaceId, id, key, "correction", 1, () =>
          record(0, "99.99"),
        );
        corrections.push(ms(start));
      }
    }
    const background = CONNECTIONS * DATASETS * ROWS;
    const backgroundMs = ms(ingestStart);
    result.backgroundIngest = {
      datasets: CONNECTIONS * DATASETS,
      initialRecords: background,
      generatedRecords: 2 * background,
      totalMs: backgroundMs,
      generatedRecordsPerSecond: Math.round(
        (2 * background) / (backgroundMs / 1000),
      ),
      initialRefreshMs: stats(initials),
      oneRecordCorrectionMs: stats(corrections),
    };
    // A small neighbour workspace: its own policy change scans shared tables.
    const neighbour = await connection(smallActor.workspaceId, "Neighbour");
    await ingest(smallActor.workspaceId, neighbour, "facts", "initial", 1000);
    await admin`analyze`;
    await storage("large_history");
    await latency("large_history");

    // Policy changes that set a retention ceiling rewrite stored deadlines
    // under the workspace ingestion lock (admin_set_data_policy, 0062).
    const policy: Record<string, unknown> = {};
    let start = performance.now();
    await adminSetDataPolicy(db, actor.workspaceId, {
      maxRetentionDays: 3650,
    });
    policy.largeFirstCeilingMs = ms(start);
    start = performance.now();
    await adminSetDataPolicy(db, actor.workspaceId, {
      maxRetentionDays: 3650,
      queryRows: 100_000,
    });
    policy.largeUnrelatedChangeWithCeilingMs = ms(start);
    start = performance.now();
    await adminSetDataPolicy(db, actor.workspaceId, { queryRows: 100_000 });
    policy.largeChangeWithoutCeilingMs = ms(start);
    start = performance.now();
    await adminSetDataPolicy(db, smallActor.workspaceId, {
      maxRetentionDays: 3650,
    });
    policy.smallNeighbourCeilingMs = ms(start);
    // How the function's record update finds one workspace's rows.
    policy.recordsUpdatePlan = (
      await admin.unsafe(
        `explain update data_records set expires_at = expires_at where workspace_id = '${smallActor.workspaceId}'`,
      )
    )
      .map((row) => String(row["QUERY PLAN"]).trim())
      .find(
        (line) => line.includes("on data_records") && !/^Update/.test(line),
      );
    result.policy = policy;
    await storage("after_policy_rewrites");

    // Drain 1: superseded generations and released raw pages, 15 minutes on.
    clock = new Date(T0.getTime() + 16 * MINUTE);
    await drain("superseded_generations", clock);
    await storage("after_superseded_drain");
    start = performance.now();
    await admin`vacuum (analyze) data_records, data_pages, data_generations, data_refreshes`;
    result.vacuumMs = ms(start);
    await storage("after_vacuum");
    await latency("after_drain");

    // Drain 2: a retention ceiling of one day expires the whole history.
    clock = new Date(T0.getTime() + 20 * MINUTE);
    start = performance.now();
    await adminSetDataPolicy(db, actor.workspaceId, { maxRetentionDays: 1 });
    policy.largeShorteningMs = ms(start);
    clock = new Date(T0.getTime() + 2 * DAY);
    await drain("expired_history", clock);
    await storage("after_expiry_drain");
    const [left] =
      await admin`select count(*)::int as n from data_records where workspace_id = ${actor.workspaceId}`;
    expect(left!.n).toBe(0);
  }, 3_600_000);
});
