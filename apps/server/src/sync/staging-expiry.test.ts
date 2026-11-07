import { gzipSync } from "node:zlib";
import { randomBytes, randomUUID } from "node:crypto";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Real worker, lock and retry coordination use a bounded 10-second observation window.
vi.setConfig({ testTimeout: 20_000 });
import { ConnectorRegistry } from "@netrics/connector-runtime";
import {
  sourceDatasetSchema,
  type Connector,
  type DatasetPage,
} from "@netrics/connector-sdk";
import {
  createDatabase,
  createRawSqlClient,
  enqueueJob,
  withWorkspace,
  pruneDatasetHistory,
  type Database,
  type Sql,
} from "@netrics/database";
import { createTestDatabase } from "../test-db.js";
import { createCredentialKeyring } from "../credentials.js";
import { createSyncJobHandlers } from "./engine.js";
import { NonRetryableJobError } from "../jobs/handlers.js";
import { createWorker, type WorkerHandle } from "../worker.js";

const DAY = 86_400_000;
const START = Date.parse("2026-11-06T12:00:00.000Z");
const definition = sourceDatasetSchema.parse({
  key: "personal",
  name: "Retained personal records",
  version: 1,
  mode: "snapshot",
  grain: "one record",
  keyFields: ["id"],
  retentionDays: 1,
  fields: [
    {
      id: "id",
      name: "ID",
      type: "string",
      nullable: false,
      classification: "personal",
      retentionDays: 1,
    },
  ],
});
const pages: DatasetPage[] = [0, 1].map((index) => ({
  datasetKey: definition.key,
  schemaVersion: 1,
  refreshKey: "staging",
  pageKey: String(index),
  previousPageKey: null,
  complete: index === 1,
  records: [{ values: { id: `row-${index}` } }],
}));
type Scenario = "advance" | "prune" | "wait" | "integrity" | "tamper";
interface Case {
  scenario: Scenario;
  spent: boolean;
  positions: number[];
  release?: () => void;
  held?: Promise<void>;
}
let owner: Sql,
  appDb: Database,
  schedulerDb: Database,
  worker: WorkerHandle,
  workspaceId: string;
let millis = START;
const cases = new Map<string, Case>();
const failures = new Map<string, unknown>();
const fixture: Connector = {
  manifest: {
    id: "stage-expiry-fixture",
    version: "1.0.0",
    sdkVersion: "^0.2.10",
    name: "Staging expiry fixture",
    description: "Offline staging expiry regression",
    authStrategies: [{ strategy: "token" }],
    configSchema: {},
    metrics: [],
    datasets: [definition],
    minRefreshIntervalSeconds: 60,
    supportsBackfill: true,
    backfillDays: 2,
    outboundDomains: [],
  },
  async check() {
    return { ok: true };
  },
  async discover() {
    return [];
  },
  async sync(context, request, runtime) {
    const state = request.cursor?.startsWith("stage:")
      ? (JSON.parse(request.cursor.slice(6)) as {
          stage: string;
          index: number;
          refresh: string;
        })
      : null;
    if (state?.index === 2) return { observations: [], done: true };
    const test = cases.get(context.connectionId)!;
    const store = runtime.datasetStaging!;
    let stage = await store.get("provider-generation-1");
    if (!stage)
      stage = await store.put({
        key: "provider-generation-1",
        metadata: {},
        pages,
      });
    const index = state?.stage === stage.id ? state.index : 0;
    const refresh = state?.stage === stage.id ? state.refresh : randomUUID();
    if (index === 1 && !test.spent && test.scenario === "advance") {
      test.spent = true;
      millis += DAY + 1; // Same runtime: header read before expiry, page read after it.
    }
    if (index === 1 && !test.spent && test.scenario === "integrity") {
      test.spent = true;
      await owner`update data_connector_stage_pages set payload_gzip=${gzipSync("{}")} where stage_id=${stage.id} and page_key='1'`;
    }
    const staged = await store.getPage(stage.id, String(index));
    test.positions.push(index);
    if (index === 1 && !test.spent && test.scenario === "prune") {
      test.spent = true;
      millis += DAY + 1;
      await pruneDatasetHistory(schedulerDb, new Date(millis));
    }
    if (index === 1 && !test.spent && test.scenario === "wait") {
      test.spent = true;
      let acquired!: () => void;
      const ready = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const released = new Promise<void>((resolve) => {
        test.release = resolve;
      });
      test.held = owner
        .begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtextextended(${workspaceId},440))`;
          acquired();
          await released;
        })
        .then(() => undefined);
      await ready;
    }
    const output = {
      ...staged,
      refreshKey: refresh,
      previousPageKey: index ? "0" : null,
      stagingId: stage.id,
      stagingPageKey: String(index),
    };
    if (index === 1 && !test.spent && test.scenario === "tamper") {
      test.spent = true;
      output.records = [{ values: { id: "altered" } }];
    }
    return {
      observations: [],
      datasetPages: [output],
      nextCursor:
        "stage:" +
        JSON.stringify({ stage: stage.id, index: index + 1, refresh }),
      done: false,
    };
  },
};

beforeAll(async () => {
  const test = await createTestDatabase();
  owner = createRawSqlClient(test.adminUrl, { max: 3, onnotice: () => {} });
  appDb = createDatabase(test.appUrl);
  const url = new URL(test.adminUrl);
  url.username = "netrics_scheduler";
  url.password = "netrics_scheduler";
  schedulerDb = createDatabase(url.toString());
  await owner`insert into connectors(id,version,manifest) values (${fixture.manifest.id},'1.0.0',${JSON.stringify(fixture.manifest)}::jsonb)`;
  const [w] =
    await owner`insert into workspaces(name) values ('Staging expiry regression') returning id`;
  workspaceId = w!.id as string;
  const registry = new ConnectorRegistry();
  registry.register(fixture);
  const handlers = createSyncJobHandlers({
    registry,
    credentialKeyring: createCredentialKeyring(
      randomBytes(32).toString("base64"),
    ),
    now: () => new Date(millis),
  });
  worker = createWorker({
    appDb,
    schedulerDb,
    pollMs: 10,
    heartbeatMs: 50,
    logger: pino({ level: "silent" }),
    handlers: {
      "connection.sync": async (context) => {
        try {
          await handlers["connection.sync"]!(context);
        } catch (error) {
          failures.set(context.job.connectionId!, error);
          throw error;
        }
      },
    },
  });
  await worker.start();
}, 60000);
afterAll(async () => {
  for (const value of cases.values()) value.release?.();
  await worker?.stop();
  await appDb?.$client.end({ timeout: 5 });
  await schedulerDb?.$client.end({ timeout: 5 });
  await owner?.end({ timeout: 5 });
});
async function until<T>(check: () => Promise<T | null | false>): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error("Staging regression did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function start(scenario: Scenario) {
  millis = START;
  const [connection] =
    await owner`insert into connections(workspace_id,connector_id,name) values (${workspaceId},${fixture.manifest.id},${scenario}) returning id`;
  const id = connection!.id as string;
  const test: Case = { scenario, spent: false, positions: [] };
  cases.set(id, test);
  const job = await withWorkspace(appDb, { workspaceId }, (tx) =>
    enqueueJob(tx, {
      kind: "connection.sync",
      workspaceId,
      connectionId: id,
      maxAttempts: 3,
      payload: {
        continuation: {
          syncWindow: {
            mode: "incremental",
            from: new Date(START - DAY).toISOString(),
            to: new Date(START).toISOString(),
          },
        },
      },
    }),
  );
  return { id, job, test };
}
async function settled(job: string) {
  return until(async () => {
    const [row] =
      await owner`select status,attempts,last_error from jobs where id=${job}`;
    return row &&
      row.status !== "running" &&
      (Number(row.attempts) > 0 || row.status === "succeeded")
      ? row
      : false;
  });
}

describe("staging deadlines through the worker and ingestion boundary", () => {
  it.each(["advance", "prune", "wait"] as const)(
    "retries %s availability loss from the committed checkpoint and rebuilds without duplicate rows",
    async (scenario) => {
      const { id, job, test } = await start(scenario);
      if (scenario === "wait") {
        await until(async () => {
          const [row] =
            await owner`select count(*)::integer as n from pg_stat_activity where datname=current_database() and usename='netrics_app' and wait_event='advisory' and query like '%pg_advisory_xact_lock%'`;
          return Number(row?.n) > 0;
        });
        millis += DAY + 1;
        test.release!();
        await test.held;
      }
      const failed = await settled(job);
      expect(failed).toMatchObject({
        status: "continuing",
        attempts: 1,
        last_error: "dataset_stage_unavailable",
      });
      expect(failures.get(id)).toBeInstanceOf(Error);
      expect(failures.get(id)).not.toBeInstanceOf(NonRetryableJobError);
      const [checkpoint] =
        await owner`select cursor from connection_state where connection_id=${id}`;
      expect(JSON.parse((checkpoint!.cursor as string).slice(6)).index).toBe(1);
      const [before] =
        await owner`select count(*)::integer as n from data_generations g join data_datasets d on d.id=g.dataset_id where d.connection_id=${id}`;
      expect(before!.n).toBe(0);
      const [run] =
        await owner`select error_class,started_at,requested_to from sync_runs where connection_id=${id} and status='failed'`;
      expect(run).toMatchObject({
        error_class: "transient",
        started_at: new Date(START),
        requested_to: new Date(START),
      });
      await owner`update jobs set run_at=now() where id=${job}`;
      const retried = await until(async () => {
        const [row] =
          await owner`select status,attempts from jobs where id=${job}`;
        return row &&
          (row.status === "succeeded" ||
            row.status === "dead" ||
            row.status === "failed" ||
            (Number(row.attempts) > 1 && row.status !== "running"))
          ? row
          : false;
      });
      expect(retried).toMatchObject({ status: "succeeded", attempts: 1 });
      const rows =
        await owner`select r.values,r.collected_at,r.expires_at from data_records r join data_generations g on g.id=r.generation_id join data_datasets d on d.id=g.dataset_id where d.connection_id=${id} order by r.record_key`;
      expect(rows.map((row) => row.values)).toEqual([
        { id: "row-0" },
        { id: "row-1" },
      ]);
      expect(
        rows.every(
          (row) =>
            (row.collected_at as Date).getTime() === millis &&
            (row.expires_at as Date).getTime() === millis + DAY,
        ),
      ).toBe(true);
      expect(test.positions.filter((index) => index === 0)).toHaveLength(2);
    },
  );

  it.each(["integrity", "tamper"] as const)(
    "dead-letters %s failures instead of retrying existing corrupt or altered data",
    async (scenario) => {
      const { id, job } = await start(scenario);
      expect(await settled(job)).toMatchObject({
        status: "dead",
        attempts: 1,
        last_error:
          scenario === "integrity"
            ? "dataset_stage_integrity"
            : "dataset_stage_reference_invalid",
      });
      expect(failures.get(id)).toBeInstanceOf(NonRetryableJobError);
      const [checkpoint] =
        await owner`select cursor from connection_state where connection_id=${id}`;
      expect(JSON.parse((checkpoint!.cursor as string).slice(6)).index).toBe(1);
      const [run] =
        await owner`select error_class from sync_runs where connection_id=${id} and status='failed'`;
      expect(run!.error_class).toBe("contract");
    },
  );
});
