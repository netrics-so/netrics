import { arch, cpus, platform, release, totalmem } from "node:os";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminSetDataPolicy,
  createDatabase,
  createRawSqlClient,
  createWorkspace,
  ingestDatasetPage,
  pruneDatasetHistory,
  schema,
  setConnectionRetention,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";
import {
  sourceDatasetSchema,
  type SourceDatasetDefinition,
} from "@netrics/contracts";
import {
  DEFAULT_DATA_POLICY,
  type SemanticModelDefinition,
} from "@netrics/domain";
import { createTestDatabase } from "../test-db.js";
import {
  createDataService,
  type DataActor,
  type DataModelQueryResult,
} from "./service.js";

// Concurrent ingestion, retention/policy changes and pinned first-page
// admission under load (#501). Opt-in measurement, not a timing gate; sizes
// come from the environment and scripts/scale/run.mjs repeats the run.
const enabled = process.env.NETRICS_SCALE_CONCURRENCY === "1";
const size = (name: string, fallback: number) =>
  Number(process.env[name] ?? fallback);
const WORKERS = size("NETRICS_SCALE_WORKERS", 8);
const REFRESHES = size("NETRICS_SCALE_REFRESHES", 3);
const PAGES = size("NETRICS_SCALE_PAGES", 10);
const HISTORY_DATASETS = size("NETRICS_SCALE_HISTORY_DATASETS", 10);
const HISTORY_ROWS = size("NETRICS_SCALE_HISTORY_ROWS", 20_000);
const PINNED_ROWS = (process.env.NETRICS_SCALE_PINNED_ROWS ?? "10000,50000")
  .split(",")
  .map(Number);
const PINNED_BURSTS = (process.env.NETRICS_SCALE_PINNED_BURSTS ?? "1,10,25,50")
  .split(",")
  .map(Number);

const T0 = new Date("2026-11-05T12:00:00Z");
const MINUTE = 60_000;
const result: Record<string, unknown> = {};
/** A service error code, else the SQLSTATE anywhere in the cause chain. */
function errorCode(error: unknown): string {
  for (let current = error; current instanceof Error;) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = current.cause;
  }
  return (error as Error).message;
}
const ms = (start: number) => Math.round((performance.now() - start) * 10) / 10;
function stats(samples: number[]) {
  if (samples.length === 0) return { n: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
  return {
    n: sorted.length,
    p50: rank(0.5),
    p95: rank(0.95),
    max: sorted.at(-1)!,
  };
}

const definition = (key: string): SourceDatasetDefinition =>
  sourceDatasetSchema.parse({
    key,
    name: "Synthetic " + key,
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
      ["units", "integer"],
      ["currency", "string"],
      ["order_ref", "string"],
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
      ]),
  });
const record = (index: number, round = 0) => ({
  values: {
    id: "line-" + index,
    date: new Date(Date.UTC(2025, 10, 1) + (index % 365) * 86_400_000)
      .toISOString()
      .slice(0, 10),
    app: "com.example.app" + (index % 200),
    country: ["US", "DE", "GB", "FR", "JP"][index % 5],
    units: 1 + ((index + round) % 5),
    currency: "EUR",
    order_ref: "GPA.3300-" + String(index).padStart(10, "0"),
    amount: (((index + round) % 1000) / 100).toFixed(2),
  },
});

let db: Database, scheduler: Database, admin: Sql, sampler: Sql;
let userId: string;
const clock = T0;

async function workspace(name: string) {
  return createWorkspace(db, { name, ownerUserId: userId });
}
async function connection(workspaceId: string, name: string) {
  const [row] = await withWorkspace(db, { workspaceId }, (tx) =>
    tx
      .insert(schema.connections)
      .values({ workspaceId, connectorId: "scale-fixture", name })
      .returning(),
  );
  return row!.id;
}
interface PageSample {
  lockWaitMs: number;
  totalMs: number;
  completing: boolean;
}
/**
 * One sync turn per page, as the engine does: a workspace transaction that
 * ingests the page. The ingestion lock (440) is taken first and timed; the
 * same lock inside ingestDatasetPage is then re-entrant.
 */
async function ingestPage(
  workspaceId: string,
  connectionId: string,
  key: string,
  refreshKey: string,
  page: number,
  pages: number,
  round: number,
): Promise<PageSample> {
  const start = performance.now();
  let lockWaitMs = 0;
  await withWorkspace(db, { workspaceId }, async (tx) => {
    // Ingestion sets its statement timeout before it waits for the lock, so
    // a wait beyond queryTimeoutMs fails the page; keep that for the probe.
    await tx.execute(
      sql`select set_config('statement_timeout', ${String(DEFAULT_DATA_POLICY.queryTimeoutMs)}, true)`,
    );
    const lock = performance.now();
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId}::uuid::text, 440))`,
    );
    lockWaitMs = ms(lock);
    await ingestDatasetPage(tx, {
      workspaceId,
      connectionId,
      definition: definition(key),
      page: {
        datasetKey: key,
        schemaVersion: 1,
        refreshKey,
        pageKey: "p" + page,
        previousPageKey: page ? "p" + (page - 1) : null,
        complete: page === pages - 1,
        records: Array.from({ length: 1000 }, (_, i) =>
          record(page * 1000 + i, round),
        ),
      },
      now: clock,
    });
  });
  return { lockWaitMs, totalMs: ms(start), completing: page === pages - 1 };
}
async function sync(
  workspaceId: string,
  connectionId: string,
  key: string,
  refreshes: number,
  pages: number,
  tag: string,
) {
  const samples: PageSample[] = [];
  for (let r = 0; r < refreshes; r++)
    for (let p = 0; p < pages; p++)
      samples.push(
        await ingestPage(
          workspaceId,
          connectionId,
          key,
          tag + "-" + r,
          p,
          pages,
          r,
        ),
      );
  return samples;
}

/** pg_stat_activity every 20 ms: who waits on which lock while work runs. */
function startSampler() {
  let running = true,
    samples = 0,
    advisoryWaiters = 0,
    otherLockWaiters = 0,
    maxAdvisory = 0,
    maxOther = 0;
  const done = (async () => {
    while (running) {
      const [row] = await sampler`
        select count(*) filter (where wait_event_type = 'Lock' and wait_event = 'advisory')::int as advisory,
          count(*) filter (where wait_event_type = 'Lock' and wait_event <> 'advisory')::int as other
        from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()`;
      samples++;
      advisoryWaiters += row!.advisory as number;
      otherLockWaiters += row!.other as number;
      maxAdvisory = Math.max(maxAdvisory, row!.advisory as number);
      maxOther = Math.max(maxOther, row!.other as number);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();
  return async () => {
    running = false;
    await done;
    return {
      samples,
      meanAdvisoryWaiters:
        Math.round((advisoryWaiters / Math.max(1, samples)) * 100) / 100,
      maxAdvisoryWaiters: maxAdvisory,
      meanOtherLockWaiters:
        Math.round((otherLockWaiters / Math.max(1, samples)) * 100) / 100,
      maxOtherLockWaiters: maxOther,
    };
  };
}
async function databaseCounters() {
  const [row] =
    await admin`select deadlocks::int, xact_rollback::int as rollbacks from pg_stat_database where datname = current_database()`;
  return row as unknown as { deadlocks: number; rollbacks: number };
}
/** Runs workers plus background loops; loops stop when the workers finish. */
async function scenario(
  name: string,
  workers: Array<() => Promise<PageSample[]>>,
  loops: Record<string, () => Promise<unknown>> = {},
  extra: () => Record<string, unknown> = () => ({}),
) {
  const stop = startSampler();
  const before = await databaseCounters();
  let finished = false;
  const loopStats: Record<string, { ms: number[]; errors: string[] }> = {};
  const loopRuns = Object.entries(loops).map(async ([loop, run]) => {
    const entry = (loopStats[loop] = {
      ms: [] as number[],
      errors: [] as string[],
    });
    while (!finished) {
      const start = performance.now();
      try {
        await run();
        entry.ms.push(ms(start));
      } catch (error) {
        entry.errors.push(errorCode(error));
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
  const start = performance.now();
  const errors: string[] = [];
  const samples = (
    await Promise.all(
      workers.map((work) =>
        work().catch((error: unknown) => {
          errors.push(errorCode(error));
          return [] as PageSample[];
        }),
      ),
    )
  ).flat();
  const wallMs = ms(start);
  finished = true;
  await Promise.all(loopRuns);
  const after = await databaseCounters();
  const records = samples.length * 1000;
  result.scenarios ??= {} as Record<string, unknown>;
  (result.scenarios as Record<string, unknown>)[name] = {
    workers: workers.length,
    pages: samples.length,
    wallMs,
    recordsPerSecond: Math.round(records / (wallMs / 1000)),
    pageMs: stats(samples.filter((s) => !s.completing).map((s) => s.totalMs)),
    completingPageMs: stats(
      samples.filter((s) => s.completing).map((s) => s.totalMs),
    ),
    lockWaitMs: stats(samples.map((s) => s.lockWaitMs)),
    lockWaitShare:
      Math.round(
        (samples.reduce((sum, s) => sum + s.lockWaitMs, 0) /
          Math.max(
            1,
            samples.reduce((sum, s) => sum + s.totalMs, 0),
          )) *
          1000,
      ) / 1000,
    errors,
    deadlocks: after.deadlocks - before.deadlocks,
    rollbacks: after.rollbacks - before.rollbacks,
    activity: await stop(),
    loops: Object.fromEntries(
      Object.entries(loopStats).map(([loop, entry]) => [
        loop,
        { ...stats(entry.ms), errors: entry.errors },
      ]),
    ),
    ...extra(),
  };
  return errors;
}

async function publishModel(
  service: ReturnType<typeof createDataService>,
  actor: DataActor,
  datasetId: string,
  name: string,
) {
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
    ],
  };
  const saved = await service.saveModel(actor, { name, definition: model });
  await service.publishModel(actor, saved.model.id, saved.model.version);
  return saved.model.id;
}
async function loadDataset(
  workspaceId: string,
  connectionId: string,
  key: string,
  rows: number,
) {
  let datasetId = "";
  const pages = Math.ceil(rows / 1000);
  for (let p = 0; p < pages; p++)
    await withWorkspace(db, { workspaceId }, async (tx) => {
      datasetId = (
        await ingestDatasetPage(tx, {
          workspaceId,
          connectionId,
          definition: definition(key),
          page: {
            datasetKey: key,
            schemaVersion: 1,
            refreshKey: "seed",
            pageKey: "p" + p,
            previousPageKey: p ? "p" + (p - 1) : null,
            complete: p === pages - 1,
            records: Array.from(
              { length: Math.min(1000, rows - p * 1000) },
              (_, i) => record(p * 1000 + i),
            ),
          },
          now: clock,
        })
      ).datasetId;
    });
  return datasetId;
}

beforeAll(async () => {
  if (!enabled) return;
  const test = await createTestDatabase();
  db = createDatabase(test.appUrl, { max: 24 });
  admin = createRawSqlClient(test.adminUrl, { max: 1, onnotice: () => {} });
  sampler = createRawSqlClient(test.adminUrl, { max: 1 });
  const schedulerUrl = new URL(test.adminUrl);
  schedulerUrl.username = "netrics_scheduler";
  schedulerUrl.password = "netrics_scheduler";
  scheduler = createDatabase(schedulerUrl.toString(), { max: 1 });
  const [user] = await db
    .insert(schema.users)
    .values({ email: "concurrency-scale@example.test", displayName: "Scale" })
    .returning();
  userId = user!.id;
  await admin`insert into connectors(id,version,manifest) values ('scale-fixture','1.0.0','{}')`;
}, 120_000);
afterAll(async () => {
  if (!enabled) return;
  const [server] =
    await admin`select current_setting('server_version') as version, current_setting('shared_buffers') as shared_buffers, current_setting('max_connections') as max_connections`;
  console.log(
    "NETRICS_SCALE_CONCURRENCY_RESULT " +
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
          maxConnections: server!.max_connections,
          appPool: 24,
        },
        sizes: {
          workers: WORKERS,
          refreshes: REFRESHES,
          pagesPerRefresh: PAGES,
          recordsPerPage: 1000,
          historyDatasets: HISTORY_DATASETS,
          historyRows: HISTORY_ROWS,
          pinnedRows: PINNED_ROWS,
          pinnedBursts: PINNED_BURSTS,
        },
        ...result,
      }),
  );
  await db?.$client.end({ timeout: 5 });
  await scheduler?.$client.end({ timeout: 5 });
  await sampler?.end({ timeout: 5 });
  await admin?.end({ timeout: 5 });
});

describe.runIf(enabled)("concurrent ingestion at scale (#501)", () => {
  it("syncs in separate workspaces and in one workspace, with and without policy churn", async () => {
    // Separate workspaces: ingestion locks never meet.
    const separate = await Promise.all(
      Array.from({ length: WORKERS }, async (_, i) => {
        const ws = await workspace("Separate " + i);
        return { ws, conn: await connection(ws, "Sync") };
      }),
    );
    expect(
      await scenario(
        "separate_workspaces",
        separate.map(
          ({ ws, conn }) =>
            () =>
              sync(ws, conn, "facts", REFRESHES, PAGES, "a"),
        ),
      ),
    ).toEqual([]);

    // One workspace, one connection per worker, plus retained history.
    const shared = await workspace("Shared");
    const actor: DataActor = { workspaceId: shared, callerId: userId };
    const conns = await Promise.all(
      Array.from({ length: WORKERS }, (_, i) =>
        connection(shared, "Sync " + i),
      ),
    );
    const historyConn = await connection(shared, "History");
    for (let d = 0; d < HISTORY_DATASETS; d++)
      await loadDataset(shared, historyConn, "history_" + d, HISTORY_ROWS);
    const service = createDataService(db, () => clock);
    const queryModel = await publishModel(
      service,
      actor,
      await loadDataset(shared, historyConn, "query_target", 10_000),
      "Query target",
    );
    expect(
      await scenario(
        "one_workspace",
        conns.map(
          (conn) => () => sync(shared, conn, "facts", REFRESHES, PAGES, "b"),
        ),
      ),
    ).toEqual([]);

    // The same plus everything that contends with it: policy ceilings that
    // rewrite deadlines, connection retention, the scheduler's prune and
    // dashboard-style model queries in serializable transactions. Each
    // transaction attempt of the query service is counted to expose retries.
    let attempts = 0,
      queries = 0;
    const counted = createDataService(
      {
        transaction: ((fn: never, options: never) => {
          attempts++;
          return db.transaction(fn, options);
        }) as Database["transaction"],
      },
      () => clock,
    );
    let flip = false;
    const [records] =
      await admin`select count(*)::int as n from data_records where workspace_id = ${shared}`;
    expect(
      await scenario(
        "one_workspace_with_policy_churn",
        conns.map(
          (conn) => () => sync(shared, conn, "facts", REFRESHES, PAGES, "c"),
        ),
        {
          admin_set_data_policy: () => {
            flip = !flip;
            return adminSetDataPolicy(db, shared, {
              maxRetentionDays: flip ? 3650 : 3651,
            });
          },
          connection_retention: () =>
            withWorkspace(db, { workspaceId: shared }, (tx) =>
              setConnectionRetention(tx, {
                workspaceId: shared,
                connectionId: conns[0]!,
                choice: { facts: flip ? 3000 : 3001 },
                chosenBy: null,
                effective: { facts: flip ? 3000 : 3001 },
              }),
            ),
          prune: () =>
            pruneDatasetHistory(
              scheduler,
              new Date(clock.getTime() + 16 * MINUTE),
              10_000,
            ),
          model_query: async () => {
            queries++;
            await counted.query(actor, queryModel, {
              measureIds: ["amount"],
              groupBy: ["date"],
              limit: 100,
            });
          },
        },
        () => ({
          workspaceRecordsAtStart: records!.n,
          queryAttempts: attempts,
          queries,
          serializationRetries: attempts - queries,
        }),
      ),
    ).toEqual([]);
  }, 3_600_000);

  it("admits bursts of pinned first pages per model under the bounded wait", async () => {
    const ws = await workspace("Pinned");
    const actor: DataActor = { workspaceId: ws, callerId: userId };
    const conn = await connection(ws, "Pinned");
    // Capacity is not what is measured here: no session caps.
    await adminSetDataPolicy(db, ws, {
      querySnapshotCount: null,
      queryPageSessionsPerCaller: null,
    });
    const service = createDataService(db, () => clock);
    const bursts: Record<string, unknown> = {};
    const query = { measureIds: ["amount"], groupBy: ["date"], limit: 100 };
    const max = Math.max(...PINNED_BURSTS);
    for (const [index, rows] of PINNED_ROWS.entries()) {
      const datasetId = await loadDataset(ws, conn, "pinned_" + rows, rows);
      const models: string[] = [];
      for (let i = 0; i < max; i++)
        models.push(
          await publishModel(service, actor, datasetId, `Pinned ${rows} ${i}`),
        );
      // The smallest size also runs one model per workspace, to tell
      // conflicts between releases from conflicts between workspaces.
      const foreign: Array<[DataActor, string]> = [];
      if (index === 0)
        for (let i = 0; i < max; i++) {
          const other = await workspace("Pinned foreign " + i);
          const otherActor = { workspaceId: other, callerId: userId };
          await adminSetDataPolicy(db, other, {
            querySnapshotCount: null,
            queryPageSessionsPerCaller: null,
          });
          const otherDataset = await loadDataset(
            other,
            await connection(other, "Pinned"),
            "pinned",
            rows,
          );
          foreign.push([
            otherActor,
            await publishModel(service, otherActor, otherDataset, "Pinned"),
          ]);
        }
      // Warm once (plan cache, JIT) before measuring.
      await service.query(actor, models[0]!, query);
      const modes = {
        pinned_one_model: () => [actor, models[0]!, true],
        pinned_separate_models: (i: number) => [actor, models[i]!, true],
        ...(foreign.length
          ? {
              pinned_separate_workspaces: (i: number) => [...foreign[i]!, true],
            }
          : {}),
        unpinned_one_model: () => [actor, models[0]!, false],
      } as Record<string, (i: number) => [DataActor, string, boolean]>;
      for (const burst of PINNED_BURSTS) {
        for (const [mode, target] of Object.entries(modes)) {
          const latencies: number[] = [];
          let admitted = 0,
            refused = 0;
          const errors: string[] = [];
          const start = performance.now();
          await Promise.all(
            Array.from({ length: burst }, async (_, i) => {
              const [who, model, pinPages] = target(i);
              const begin = performance.now();
              try {
                const value: DataModelQueryResult = await service.query(
                  who,
                  model,
                  { ...query, pinPages },
                );
                latencies.push(ms(begin));
                if (value.nextPageToken) admitted++;
                if (value.warnings.includes("immutable_pagination_unavailable"))
                  refused++;
              } catch (error) {
                errors.push(errorCode(error));
              }
            }),
          );
          bursts[`${rows}/${burst}/${mode}`] = {
            wallMs: ms(start),
            ...stats(latencies),
            admitted,
            refused,
            errors,
          };
        }
      }
    }
    result.pinned = bursts;
  }, 3_600_000);
});
