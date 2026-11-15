import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pino from "pino";

import {
  sourceDatasetSchema,
  type Connector,
  type ConnectorManifest,
  type SourceDatasetDefinition,
  type SyncRequest,
} from "@netrics/connector-sdk";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import {
  createDatabase,
  createRawSqlClient,
  createWorkspace,
  queueDatasetBackfill,
  schema,
  withWorkspace,
  type Database,
  type Job,
  type Sql,
} from "@netrics/database";

import { createCredentialKeyring } from "../credentials.js";
import { createJobHandlers } from "../jobs/handlers.js";
import { syncCatalog } from "./catalog.js";
import {
  createTestDatabase,
  type TestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "../test-db.js";

// #617: a connector update that adds a dataset (or changes one's schema
// version) used to leave existing connections with only incremental history
// of it: no path queued a backfill. Now a succeeded incremental run queues
// exactly one, audited, and not again on the next run or after a restart.

vi.setConfig({ testTimeout: 30_000 });

const KEYRING = createCredentialKeyring(randomBytes(32).toString("base64"));
const CONNECTOR = "growing";

function rowsDataset(version: number): SourceDatasetDefinition {
  return sourceDatasetSchema.parse({
    key: "rows",
    name: "Report rows",
    version,
    keyFields: ["id"],
    grain: "one report row",
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
      ...(version > 1
        ? [
            {
              id: "note",
              name: "Note",
              type: "string" as const,
              nullable: true,
              classification: "internal" as const,
            },
          ]
        : []),
    ],
  });
}

/**
 * The connector at a version: 0.1.0 declares no dataset, 0.2.0 adds
 * "rows" (schema 1), 0.3.0 changes it to schema 2.
 */
function growingConnector(release: 1 | 2 | 3): Connector {
  const datasets = release === 1 ? [] : [rowsDataset(release === 2 ? 1 : 2)];
  const manifest: ConnectorManifest = {
    id: CONNECTOR,
    version: `0.${release}.0`,
    sdkVersion: "^0.2.0",
    name: "Growing",
    description: "Test connector that gains a dataset.",
    authStrategies: [{ strategy: "token" }],
    configSchema: {},
    metrics: [
      {
        key: "growing.units",
        name: "Units",
        description: "Units per day.",
        kind: "delta",
        unit: "count",
        granularity: "day",
        dimensions: ["resource"],
        aggregations: ["sum"],
      },
    ],
    ...(datasets.length ? { datasets } : {}),
    minRefreshIntervalSeconds: 300,
    supportsBackfill: true,
    backfillDays: 90,
    outboundDomains: [],
  };
  return {
    manifest,
    async check() {
      return { ok: true };
    },
    async discover() {
      return [];
    },
    async sync(_context, request: SyncRequest) {
      const day = request.to.slice(0, 10);
      // A paged backfill: page 1 (observations only) checkpoints; the
      // final page may fail, like a worker stopped by a deploy.
      if (paged && request.mode === "backfill" && !request.cursor) {
        return {
          observations: [
            {
              metricKey: "growing.units",
              sourceTimestamp: `${request.from.slice(0, 10)}T00:00:00.000Z`,
              value: 1,
              dimensions: { resource: "app" },
            },
          ],
          nextCursor: "page-2",
          done: false,
        };
      }
      if (paged && failFinalPage) {
        throw new Error("worker stopped (test)");
      }
      return {
        observations: [
          {
            metricKey: "growing.units",
            sourceTimestamp: `${day}T00:00:00.000Z`,
            value: 1,
            dimensions: { resource: "app" },
          },
        ],
        datasetPages: datasets.map((dataset) => ({
          datasetKey: dataset.key,
          schemaVersion: dataset.version,
          refreshKey: `${request.mode}-${randomUUID()}`,
          pageKey: "p1",
          previousPageKey: null,
          complete: true,
          records: [
            {
              values: {
                id: `${request.mode}-${day}`,
                ...(dataset.version > 1 ? { note: null } : {}),
              },
            },
          ],
        })),
        done: true,
      };
    },
  };
}

function registryAt(release: 1 | 2 | 3): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(growingConnector(release));
  return registry;
}

/** Backfills read two pages (#617 resume tests). */
let paged = false;
/** The final page of a paged backfill fails. */
let failFinalPage = false;

let testDb: TestDatabase;
let appDb: Database;
let schedulerDb: Database;
let owner: Sql;
let workspaceId: string;

/**
 * One attempt of a job, in process, by a worker whose registry holds the
 * connector at `release`: a fresh registry is a fresh process (a restart).
 */
async function run(
  release: 1 | 2 | 3,
  kind: "connection.sync" | "connection.backfill",
  connectionId: string,
  jobId: string = randomUUID(),
  workspace = workspaceId,
) {
  const handler = createJobHandlers({
    registry: registryAt(release),
    credentialKeyring: KEYRING,
  })[kind]!;
  await handler({
    job: {
      id: jobId,
      kind,
      workspaceId: workspace,
      connectionId,
      attempts: 0,
      payload: { workspace_id: workspace, connection_id: connectionId },
    } as unknown as Job,
    appDb,
    schedulerDb,
    logger: pino({ level: "silent" }),
  });
}

async function seedConnection(workspace = workspaceId): Promise<string> {
  const connectionId = randomUUID();
  await withWorkspace(appDb, { workspaceId: workspace }, async (tx) => {
    await tx.insert(schema.connections).values({
      id: connectionId,
      workspaceId: workspace,
      connectorId: CONNECTOR,
      name: "Store",
      config: {},
    });
    await tx.insert(schema.connectionState).values({
      connectionId,
      workspaceId: workspace,
      pollIntervalSeconds: 300,
    });
  });
  return connectionId;
}

async function backfillJobs(connectionId: string) {
  return owner<{ id: string; status: string }[]>`
    select id, status from jobs
    where connection_id = ${connectionId} and kind = 'connection.backfill'
    order by created_at, id`;
}

async function auditEvents(connectionId: string) {
  return owner<{ actor_user_id: string | null; metadata: unknown }[]>`
    select actor_user_id, metadata from audit_events
    where target = ${connectionId}
      and action = 'connection.backfill_requested'
    order by created_at`;
}

async function state(connectionId: string) {
  const [row] = await owner<
    {
      backfilled_datasets: Record<string, number> | null;
      backfill_requested_datasets: Record<string, number> | null;
    }[]
  >`
    select backfilled_datasets, backfill_requested_datasets
    from connection_state where connection_id = ${connectionId}`;
  return row!;
}

/** Runs the waiting backfill as the worker would and marks it done. */
async function runPendingBackfill(release: 1 | 2 | 3, connectionId: string) {
  const pending = (await backfillJobs(connectionId)).filter(
    (job) => job.status === "pending",
  );
  expect(pending).toHaveLength(1);
  await run(release, "connection.backfill", connectionId, pending[0]!.id);
  await owner`update jobs set status = 'succeeded' where id = ${pending[0]!.id}`;
}

async function storedRows(connectionId: string): Promise<string[]> {
  const rows = await owner<{ id: string }[]>`
    select distinct r.values->>'id' as id from data_records r
    join data_generations g on g.id = r.generation_id
    join data_datasets d on d.id = g.dataset_id
    where d.connection_id = ${connectionId}
    order by 1`;
  return rows.map((row) => row.id);
}

async function newWorkspace(): Promise<string> {
  const [user] = await appDb
    .insert(schema.users)
    .values({ email: `busy-${randomUUID()}@example.com`, displayName: "B" })
    .returning({ id: schema.users.id });
  return createWorkspace(appDb, { name: "Busy", ownerUserId: user!.id });
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  appDb = createDatabase(testDb.appUrl);
  const schedulerUrl = new URL(testDb.adminUrl);
  schedulerUrl.username = "netrics_scheduler";
  schedulerUrl.password = "netrics_scheduler";
  schedulerDb = createDatabase(schedulerUrl.toString());
  owner = createRawSqlClient(testDb.adminUrl, { max: 1 });
  const catalogOwner = createDatabase(testDb.adminUrl, { max: 1 });
  await syncCatalog(catalogOwner, registryAt(2));
  await catalogOwner.$client.end({ timeout: 5 });
  const [user] = await appDb
    .insert(schema.users)
    .values({ email: "growing@example.com", displayName: "Owner" })
    .returning({ id: schema.users.id });
  workspaceId = await createWorkspace(appDb, {
    name: "Growing",
    ownerUserId: user!.id,
  });
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await appDb?.$client.end({ timeout: 5 }).catch(() => undefined);
  await schedulerDb?.$client.end({ timeout: 5 }).catch(() => undefined);
  await owner?.end({ timeout: 5 }).catch(() => undefined);
});

describe("backfill of datasets a connector update adds (#617)", () => {
  it("queues one backfill when an existing connection gains a dataset, not again on the next run or start", async () => {
    const connectionId = await seedConnection();
    // Set up on 0.1.0: its backfill read the window, without datasets.
    await run(1, "connection.backfill", connectionId);
    expect((await state(connectionId)).backfilled_datasets).toEqual({});
    await run(1, "connection.sync", connectionId);
    expect(await backfillJobs(connectionId)).toEqual([]);

    // 0.2.0 is deployed: its first incremental run fills "rows" from the
    // cursor on, and queues one backfill for the history before.
    await run(2, "connection.sync", connectionId);
    const jobs = await backfillJobs(connectionId);
    expect(jobs).toEqual([{ id: expect.any(String), status: "pending" }]);
    const events = await auditEvents(connectionId);
    expect(events).toEqual([
      {
        actor_user_id: null,
        metadata: {
          connectorId: CONNECTOR,
          by: "system",
          reason: "dataset_added",
          datasets: ["rows"],
          jobId: jobs[0]!.id,
        },
      },
    ]);
    expect(await state(connectionId)).toEqual({
      backfilled_datasets: {},
      backfill_requested_datasets: { rows: 1 },
    });

    // The next run, and a restarted worker (a fresh registry): nothing new.
    await run(2, "connection.sync", connectionId);
    await run(2, "connection.sync", connectionId);
    expect(await backfillJobs(connectionId)).toEqual(jobs);
    expect(await auditEvents(connectionId)).toHaveLength(1);

    // The backfill reads the window and records the dataset; the rows the
    // incremental runs stored stay.
    const before = await storedRows(connectionId);
    expect(before.length).toBeGreaterThan(0);
    await runPendingBackfill(2, connectionId);
    expect((await state(connectionId)).backfilled_datasets).toEqual({
      rows: 1,
    });
    const after = await storedRows(connectionId);
    expect(after).toEqual(expect.arrayContaining(before));
    expect(after.some((id) => id.startsWith("backfill-"))).toBe(true);

    await run(2, "connection.sync", connectionId);
    expect(await backfillJobs(connectionId)).toHaveLength(1);
    expect(await auditEvents(connectionId)).toHaveLength(1);
  });

  it("queues one more when a dataset's schema version changes", async () => {
    const connectionId = await seedConnection();
    await run(2, "connection.backfill", connectionId);
    expect((await state(connectionId)).backfilled_datasets).toEqual({
      rows: 1,
    });
    await run(2, "connection.sync", connectionId);
    expect(await backfillJobs(connectionId)).toEqual([]);

    await run(3, "connection.sync", connectionId);
    expect(await backfillJobs(connectionId)).toHaveLength(1);
    expect((await auditEvents(connectionId))[0]!.metadata).toMatchObject({
      reason: "dataset_changed",
      datasets: ["rows"],
    });
    await runPendingBackfill(3, connectionId);
    expect((await state(connectionId)).backfilled_datasets).toEqual({
      rows: 2,
    });
  });

  it("retries a failed automatic backfill once after a day, then leaves it to Reload history", async () => {
    const connectionId = await seedConnection();
    await run(1, "connection.backfill", connectionId);
    await run(2, "connection.sync", connectionId);
    const dead = async () => {
      await owner`
        update jobs set status = 'dead'
        where connection_id = ${connectionId} and kind = 'connection.backfill'
          and status = 'pending'`;
    };
    const aDayLater = async () => {
      await owner`
        update connection_state
        set backfill_requested_at = backfill_requested_at - interval '25 hours'
        where connection_id = ${connectionId}`;
    };
    await dead();
    // The next runs: no hot loop.
    await run(2, "connection.sync", connectionId);
    await run(2, "connection.sync", connectionId);
    expect(await backfillJobs(connectionId)).toHaveLength(1);

    // A day later: one retry, audited as such.
    await aDayLater();
    await run(2, "connection.sync", connectionId);
    await run(2, "connection.sync", connectionId);
    expect(await backfillJobs(connectionId)).toHaveLength(2);
    const events = await auditEvents(connectionId);
    expect(events).toHaveLength(2);
    expect(events[1]!.metadata).toMatchObject({
      reason: "dataset_added",
      datasets: ["rows"],
      retry: true,
    });

    // That one fails too: no more automatic backfills of this set.
    await dead();
    await aDayLater();
    await run(2, "connection.sync", connectionId);
    expect(await backfillJobs(connectionId)).toHaveLength(2);
    expect(await auditEvents(connectionId)).toHaveLength(2);
  });

  describe("a backfill resumed across a deploy", () => {
    afterAll(() => {
      paged = false;
      failFinalPage = false;
    });

    /**
     * Page 1 of a backfill job on `started`, then the final page fails;
     * the same job resumes on `resumed` and succeeds.
     */
    async function resumedBackfill(
      connectionId: string,
      started: 1 | 2,
      resumed: 1 | 2,
    ) {
      paged = true;
      const jobId = randomUUID();
      failFinalPage = true;
      await expect(
        run(started, "connection.backfill", connectionId, jobId),
      ).rejects.toThrow();
      failFinalPage = false;
      await run(resumed, "connection.backfill", connectionId, jobId);
      paged = false;
    }

    it("does not record a dataset the pages before the deploy never read", async () => {
      const connectionId = await seedConnection();
      await resumedBackfill(connectionId, 1, 2);
      // The job started on 0.1.0: "rows" was not read over the window.
      expect((await state(connectionId)).backfilled_datasets).toEqual({});
      // So the next incremental run asks for it.
      await run(2, "connection.sync", connectionId);
      expect(await backfillJobs(connectionId)).toHaveLength(1);
      expect((await auditEvents(connectionId))[0]!.metadata).toMatchObject({
        reason: "dataset_added",
        datasets: ["rows"],
      });
    });

    it("does not record a dataset the worker that finished does not declare", async () => {
      const connectionId = await seedConnection();
      await resumedBackfill(connectionId, 2, 1);
      expect((await state(connectionId)).backfilled_datasets).toEqual({});
    });

    it("records the datasets when every worker declared them", async () => {
      const connectionId = await seedConnection();
      await resumedBackfill(connectionId, 2, 2);
      expect((await state(connectionId)).backfilled_datasets).toEqual({
        rows: 1,
      });
    });

    it("keeps what an earlier backfill recorded for datasets it did not read", async () => {
      const connectionId = await seedConnection();
      await owner`
        update connection_state set backfilled_datasets = ${owner.json({ rows: 1, other: 3 })}
        where connection_id = ${connectionId}`;
      await resumedBackfill(connectionId, 1, 2);
      expect((await state(connectionId)).backfilled_datasets).toEqual({
        rows: 1,
        other: 3,
      });
    });
  });

  it("queues one backfill per workspace for concurrent checks (replicas)", async () => {
    const busy = await newWorkspace();
    const connections = [
      await seedConnection(busy),
      await seedConnection(busy),
      await seedConnection(busy),
    ];
    await owner`
      update connection_state set backfilled_datasets = '{}'::jsonb
      where workspace_id = ${busy}`;
    const outcomes = await Promise.all(
      connections.map((connectionId) =>
        withWorkspace(appDb, { workspaceId: busy }, (tx) =>
          queueDatasetBackfill(tx, {
            workspaceId: busy,
            connectionId,
            connectorId: CONNECTOR,
            declared: { rows: 1 },
          }),
        ),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.queued)).toHaveLength(1);
    const [row] = await owner<{ count: number }[]>`
      select count(*)::int as count from jobs
      where workspace_id = ${busy} and kind = 'connection.backfill'`;
    expect(row!.count).toBe(1);
  });

  it("queues at most one automatic backfill per workspace at a time", async () => {
    const busy = await newWorkspace();
    const first = await seedConnection(busy);
    const second = await seedConnection(busy);
    for (const id of [first, second]) {
      await run(1, "connection.backfill", id, randomUUID(), busy);
    }
    await run(2, "connection.sync", first, randomUUID(), busy);
    await run(2, "connection.sync", second, randomUUID(), busy);
    expect(await backfillJobs(first)).toHaveLength(1);
    expect(await backfillJobs(second)).toEqual([]);

    // Once the first has finished, the second's next run queues its own.
    const [job] = await backfillJobs(first);
    await owner`update jobs set status = 'succeeded' where id = ${job!.id}`;
    await run(2, "connection.sync", second, randomUUID(), busy);
    expect(await backfillJobs(second)).toHaveLength(1);
  });

  describe("connections from before #617 (nothing recorded)", () => {
    async function legacy(): Promise<string> {
      // Earlier tests' backfills would hold the workspace's one slot.
      await owner`
        update jobs set status = 'succeeded'
        where workspace_id = ${workspaceId} and kind = 'connection.backfill'
          and status in ('pending', 'continuing', 'running')`;
      const connectionId = await seedConnection();
      // 0.2.0's incremental runs registered "rows" and stored some days.
      await run(2, "connection.sync", connectionId);
      await owner`delete from audit_events where target = ${connectionId}`;
      await owner`delete from jobs where connection_id = ${connectionId}`;
      await owner`
        update connection_state
        set backfilled_datasets = null, backfill_requested_datasets = null
        where connection_id = ${connectionId}`;
      return connectionId;
    }

    it("backfills a dataset registered after the last backfill", async () => {
      const connectionId = await legacy();
      await owner`
        insert into sync_runs (workspace_id, connection_id, mode, requested_from, requested_to, attempt, status, started_at, finished_at)
        values (${workspaceId}, ${connectionId}, 'backfill', now() - interval '400 days', now() - interval '30 days', 1, 'succeeded', now() - interval '30 days', now() - interval '30 days')`;
      await run(2, "connection.sync", connectionId);
      expect(await backfillJobs(connectionId)).toHaveLength(1);
      expect(await state(connectionId)).toEqual({
        backfilled_datasets: {},
        backfill_requested_datasets: { rows: 1 },
      });
    });

    it("does not count a backfill segment that handed over to a continuation", async () => {
      const connectionId = await legacy();
      await owner`
        insert into sync_runs (workspace_id, connection_id, mode, requested_from, requested_to, attempt, status, started_at, finished_at)
        values (${workspaceId}, ${connectionId}, 'backfill', now() - interval '90 days', now(), 1, 'continued', now(), now() + interval '1 minute')`;
      await run(2, "connection.sync", connectionId);
      expect(await backfillJobs(connectionId)).toHaveLength(1);
    });

    it("records a dataset a later backfill read, and queues nothing", async () => {
      const connectionId = await legacy();
      await owner`
        insert into sync_runs (workspace_id, connection_id, mode, requested_from, requested_to, attempt, status, started_at, finished_at)
        values (${workspaceId}, ${connectionId}, 'backfill', now() - interval '90 days', now() + interval '1 minute', 1, 'succeeded', now(), now() + interval '1 minute')`;
      await run(2, "connection.sync", connectionId);
      expect(await backfillJobs(connectionId)).toEqual([]);
      expect(await auditEvents(connectionId)).toEqual([]);
      expect((await state(connectionId)).backfilled_datasets).toEqual({
        rows: 1,
      });
    });
  });
});
