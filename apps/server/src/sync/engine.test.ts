import { randomBytes } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Engine tests wait on a real worker loop claiming jobs.
vi.setConfig({ testTimeout: 20_000 });

import type {
  ConnectionContext,
  Connector,
  ConnectorManifest,
  SyncRequest,
} from "@netrics/connector-sdk";
import { createDefaultRegistry } from "@netrics/connector-runtime";
import {
  createDatabase,
  createRawSqlClient,
  createWorkspace,
  enqueueJob,
  schema,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";

import { encryptCredentials } from "../credentials.js";
import { createJobHandlers } from "../jobs/handlers.js";
import { syncCatalog } from "./catalog.js";
import { createTestDatabase, type TestDatabase } from "../test-db.js";
import { createWorker, type WorkerHandle } from "../worker.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const ENCRYPTION_KEY = randomBytes(32).toString("base64");

function testManifest(id: string, metricKey: string): ConnectorManifest {
  return {
    id,
    version: "0.1.0",
    sdkVersion: "^0.1.0",
    name: id,
    description: `Test connector ${id}.`,
    authStrategies: [{ strategy: "token" }],
    configSchema: {},
    metrics: [
      {
        key: metricKey,
        name: metricKey,
        description: `Test metric ${metricKey}.`,
        kind: "delta",
        unit: "count",
        dimensions: ["resource"],
        aggregations: ["sum"],
      },
    ],
    minRefreshIntervalSeconds: 300,
    supportsBackfill: true,
    outboundDomains: [],
  };
}

function flakyObservation(identity: string) {
  return {
    metricKey: "flaky.hits",
    sourceTimestamp: "2026-09-20T00:00:00.000Z",
    value: 1,
    dimensions: { resource: "r1" },
    sourceIdentity: identity,
  };
}

/** Fails mid-pagination on the first run, then recovers (crash simulation). */
let flakyShouldFail = true;
const flakyConnector: Connector = {
  manifest: testManifest("flaky-pages", "flaky.hits"),
  async check() {
    return { ok: true };
  },
  async discover() {
    return [];
  },
  async sync(_context: ConnectionContext, request: SyncRequest) {
    if (!request.cursor) {
      return {
        observations: [
          flakyObservation("flaky:p1:a"),
          flakyObservation("flaky:p1:b"),
        ],
        nextCursor: "page-2",
        done: false,
      };
    }
    if (flakyShouldFail) {
      throw new Error("provider exploded mid-stream");
    }
    return {
      observations: [
        flakyObservation("flaky:p2:a"),
        flakyObservation("flaky:p2:b"),
      ],
      done: true,
    };
  },
};

/** Emits an observation with a metric key its manifest never declared. */
const brokenConnector: Connector = {
  manifest: testManifest("broken", "broken.ok"),
  async check() {
    return { ok: true };
  },
  async discover() {
    return [];
  },
  async sync() {
    return {
      observations: [
        {
          metricKey: "broken.undeclared",
          sourceTimestamp: "2026-09-20T00:00:00.000Z",
          value: 1,
          dimensions: { resource: "r1" },
          sourceIdentity: "broken:1",
        },
      ],
      done: true,
    };
  },
};

/** Throws an error quoting its own credential value. */
const leakyConnector: Connector = {
  manifest: testManifest("leaky", "leaky.hits"),
  async check() {
    return { ok: true };
  },
  async discover() {
    return [];
  },
  async sync(context: ConnectionContext) {
    throw new Error(`provider rejected token ${context.credentials.token}`);
  },
};

function schedulerUrlOf(testDb: TestDatabase): string {
  const url = new URL(testDb.adminUrl);
  url.username = "netrics_scheduler";
  url.password = "netrics_scheduler";
  return url.toString();
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

let testDb: TestDatabase;
let appDb: Database;
let schedulerDb: Database;
let schedulerRaw: Sql;
let worker: WorkerHandle;
let workspaceA: string;
let workspaceB: string;

async function seedConnection(
  workspaceId: string,
  connectorId: string,
  config: Record<string, unknown> = {},
  credentials?: Record<string, unknown>,
): Promise<string> {
  return withWorkspace(appDb, { workspaceId }, async (tx) => {
    const [connection] = await tx
      .insert(schema.connections)
      .values({
        workspaceId,
        connectorId,
        name: `${connectorId} connection`,
        config,
        credentialsEncrypted: credentials
          ? Buffer.from(
              encryptCredentials(JSON.stringify(credentials), ENCRYPTION_KEY),
              "utf8",
            )
          : null,
      })
      .returning({ id: schema.connections.id });
    await tx.insert(schema.connectionState).values({
      connectionId: connection!.id,
      workspaceId,
      pollIntervalSeconds: 300,
    });
    return connection!.id;
  });
}

async function enqueue(
  workspaceId: string,
  connectionId: string,
  kind: string,
) {
  return withWorkspace(appDb, { workspaceId }, (tx) =>
    enqueueJob(tx, { kind, workspaceId, connectionId }),
  );
}

async function jobRow(id: string) {
  const rows = await schedulerRaw`
    select status, attempts, last_error, run_at from jobs where id = ${id}
  `;
  return rows[0];
}

async function connectionObservationCount(
  workspaceId: string,
  connectionId: string,
): Promise<number> {
  return withWorkspace(appDb, { workspaceId }, async (tx) => {
    const rows = await tx.execute<{ count: string }>(
      sql`select count(*)::text as count from observations where connection_id = ${connectionId}::uuid`,
    );
    return Number(rows[0]!.count);
  });
}

async function syncRunsFor(workspaceId: string, connectionId: string) {
  return withWorkspace(appDb, { workspaceId }, async (tx) => {
    return tx.execute<Record<string, unknown>>(
      sql`select * from sync_runs where connection_id = ${connectionId}::uuid order by started_at, id`,
    );
  });
}

async function stateFor(workspaceId: string, connectionId: string) {
  return withWorkspace(appDb, { workspaceId }, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.connectionState)
      .where(eq(schema.connectionState.connectionId, connectionId))
      .limit(1);
    return rows[0] ?? null;
  });
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  appDb = createDatabase(testDb.appUrl);
  schedulerDb = createDatabase(schedulerUrlOf(testDb));
  schedulerRaw = createRawSqlClient(schedulerUrlOf(testDb), { max: 2 });

  const registry = createDefaultRegistry();
  registry.register(flakyConnector);
  registry.register(brokenConnector);
  registry.register(leakyConnector);

  // Explicit catalog sync (production does this at process startup).
  await syncCatalog(appDb, registry);
  await syncCatalog(appDb, registry); // idempotent

  const [userA, userB] = await appDb
    .insert(schema.users)
    .values([
      { email: "engine-a@example.com", displayName: "Owner A" },
      { email: "engine-b@example.com", displayName: "Owner B" },
    ])
    .returning({ id: schema.users.id });
  workspaceA = await createWorkspace(appDb, {
    name: "Engine A",
    ownerUserId: userA!.id,
  });
  workspaceB = await createWorkspace(appDb, {
    name: "Engine B",
    ownerUserId: userB!.id,
  });

  worker = createWorker({
    schedulerDb,
    appDb,
    handlers: createJobHandlers({ registry, appEncryptionKey: ENCRYPTION_KEY }),
    pollMs: 25,
    heartbeatMs: 50,
  });
  await worker.start();
}, 60_000);

afterAll(async () => {
  await worker.stop().catch(() => undefined);
  await schedulerRaw.end({ timeout: 5 }).catch(() => undefined);
});

describe("catalog sync", () => {
  it("upserts connectors and metric definitions from manifests", async () => {
    const connectors = await appDb.select().from(schema.connectors);
    expect(connectors.map((row) => row.id).sort()).toEqual([
      "broken",
      "demo",
      "flaky-pages",
      "leaky",
    ]);
    const metrics = await appDb.select().from(schema.metricDefinitions);
    const keys = metrics.map((row) => `${row.connectorId}/${row.key}`).sort();
    expect(keys).toContain("demo/demo.visitors");
    expect(keys).toContain("demo/demo.signups");
    expect(keys).toContain("flaky-pages/flaky.hits");
    // Idempotent re-sync: exactly one row per (connector, key).
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("sync engine", () => {
  it("backfills a demo connection: observations, cursor, state, sync_run", async () => {
    const connectionId = await seedConnection(workspaceA, "demo");
    const jobId = await enqueue(
      workspaceA,
      connectionId,
      "connection.backfill",
    );
    await waitFor(async () => (await jobRow(jobId))?.status === "succeeded");

    const runs = await syncRunsFor(workspaceA, connectionId);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.status).toBe("succeeded");
    expect(run.mode).toBe("backfill");
    expect(run.error_class).toBeNull();
    expect(run.cursor_after).toBeTypeOf("string");

    // Expected observations: days in [dayStart(from), dayStart(to)] × 3
    // resources × 2 metrics (demo connector determinism).
    const from = dayStartUtc(new Date(run.requested_from as string).getTime());
    const to = dayStartUtc(new Date(run.requested_to as string).getTime());
    const expectedDays = (to - from) / DAY_MS + 1;
    expect(expectedDays).toBeGreaterThanOrEqual(90);
    const count = await connectionObservationCount(workspaceA, connectionId);
    expect(count).toBe(expectedDays * 3 * 2);
    expect(run.observations_written).toBe(count);

    const state = await stateFor(workspaceA, connectionId);
    expect(state!.cursor).toBe(run.cursor_after);
    expect(state!.authState).toBe("ok");
    expect(state!.consecutiveFailures).toBe(0);
    expect(state!.lastSuccessAt).not.toBeNull();
    expect(state!.nextDueAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("replaying the same backfill job writes zero new observations", async () => {
    const connectionId = await seedConnection(workspaceA, "demo");
    const first = await enqueue(
      workspaceA,
      connectionId,
      "connection.backfill",
    );
    await waitFor(async () => (await jobRow(first))?.status === "succeeded");
    const countAfterFirst = await connectionObservationCount(
      workspaceA,
      connectionId,
    );

    // At-least-once redelivery: the identical payload runs again.
    const second = await enqueue(
      workspaceA,
      connectionId,
      "connection.backfill",
    );
    await waitFor(async () => (await jobRow(second))?.status === "succeeded");

    expect(await connectionObservationCount(workspaceA, connectionId)).toBe(
      countAfterFirst,
    );
    const runs = await syncRunsFor(workspaceA, connectionId);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.status).toBe("succeeded");
    expect(runs[1]!.observations_written).toBe(0);
  });

  it("overlapping backfill + incremental sync stays duplicate-free", async () => {
    const connectionId = await seedConnection(workspaceA, "demo");
    const backfill = await enqueue(
      workspaceA,
      connectionId,
      "connection.backfill",
    );
    await waitFor(async () => (await jobRow(backfill))?.status === "succeeded");
    const countAfterBackfill = await connectionObservationCount(
      workspaceA,
      connectionId,
    );

    const incremental = await enqueue(
      workspaceA,
      connectionId,
      "connection.sync",
    );
    await waitFor(
      async () => (await jobRow(incremental))?.status === "succeeded",
    );

    // The incremental window starts at the cursor (today's day start), so the
    // only candidate observations are already ingested.
    expect(await connectionObservationCount(workspaceA, connectionId)).toBe(
      countAfterBackfill,
    );
    const runs = await syncRunsFor(workspaceA, connectionId);
    const incrementalRun = runs.find((row) => row.mode === "incremental")!;
    expect(incrementalRun.status).toBe("succeeded");
    expect(incrementalRun.observations_written).toBe(0);
    expect(incrementalRun.cursor_before).toBe(
      runs.find((row) => row.mode === "backfill")!.cursor_after,
    );
  });

  it("rolls back everything when the connector dies mid-pagination", async () => {
    flakyShouldFail = true;
    const connectionId = await seedConnection(workspaceA, "flaky-pages");
    const jobId = await enqueue(
      workspaceA,
      connectionId,
      "connection.backfill",
    );
    // Thrown error = retryable: back to pending with backoff, attempts = 1.
    await waitFor(async () => {
      const row = await jobRow(jobId);
      return row?.status === "pending" && row?.attempts === 1;
    });

    // Crash idempotency: page 1's observations must NOT have committed.
    expect(await connectionObservationCount(workspaceA, connectionId)).toBe(0);
    let runs = await syncRunsFor(workspaceA, connectionId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("failed");
    expect(runs[0]!.error_class).toBe("transient");
    expect(runs[0]!.observations_written).toBe(0);
    const state = await stateFor(workspaceA, connectionId);
    expect(state!.cursor).toBeNull();
    expect(state!.authState).toBe("outage");
    expect(state!.consecutiveFailures).toBe(1);

    // The provider recovers; the retry re-runs the whole window idempotently.
    flakyShouldFail = false;
    await schedulerRaw`update jobs set run_at = now() where id = ${jobId}`;
    await waitFor(async () => (await jobRow(jobId))?.status === "succeeded");
    expect(await connectionObservationCount(workspaceA, connectionId)).toBe(4);
    runs = await syncRunsFor(workspaceA, connectionId);
    expect(runs.filter((row) => row.status === "succeeded")).toHaveLength(1);
    expect((await stateFor(workspaceA, connectionId))!.authState).toBe("ok");
  });

  it("bad credentials: terminal auth failure, no retry, scheduler-visible state", async () => {
    const connectionId = await seedConnection(workspaceA, "demo", {
      simulate: "bad-credentials",
    });
    const jobId = await enqueue(workspaceA, connectionId, "connection.sync");
    await waitFor(async () => (await jobRow(jobId))?.status === "failed");

    // Terminal, but NOT dead-lettered and NOT retried.
    const row = await jobRow(jobId);
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(1);

    const runs = await syncRunsFor(workspaceA, connectionId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.error_class).toBe("auth");
    expect(await connectionObservationCount(workspaceA, connectionId)).toBe(0);

    const state = await stateFor(workspaceA, connectionId);
    expect(state!.authState).toBe("auth_failed");
    expect(state!.consecutiveFailures).toBe(1);
  });

  it("provider outage: retryable job with backoff, outage state", async () => {
    const connectionId = await seedConnection(workspaceA, "demo", {
      simulate: "outage",
    });
    const jobId = await enqueue(workspaceA, connectionId, "connection.sync");
    await waitFor(async () => {
      const row = await jobRow(jobId);
      return row?.status === "pending" && row?.attempts === 1;
    });

    const row = await jobRow(jobId);
    expect(new Date(row!.run_at as string).getTime()).toBeGreaterThan(
      Date.now(),
    );
    const runs = await syncRunsFor(workspaceA, connectionId);
    expect(runs[0]!.error_class).toBe("transient");
    const state = await stateFor(workspaceA, connectionId);
    expect(state!.authState).toBe("outage");
    expect(state!.consecutiveFailures).toBe(1);
  });

  it("contract violations dead-letter immediately", async () => {
    const connectionId = await seedConnection(workspaceA, "broken");
    const jobId = await enqueue(
      workspaceA,
      connectionId,
      "connection.backfill",
    );
    await waitFor(async () => (await jobRow(jobId))?.status === "dead");

    const row = await jobRow(jobId);
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toMatch(/undeclared metric key/);
    const runs = await syncRunsFor(workspaceA, connectionId);
    expect(runs[0]!.error_class).toBe("contract");
    expect(await connectionObservationCount(workspaceA, connectionId)).toBe(0);
  });

  it("never persists credential values in job or sync_run errors", async () => {
    const token = "sk-test-leaky-token-123";
    const connectionId = await seedConnection(
      workspaceA,
      "leaky",
      {},
      { token },
    );
    const jobId = await enqueue(workspaceA, connectionId, "connection.sync");
    await waitFor(async () => {
      const row = await jobRow(jobId);
      return row?.status === "pending" && row?.attempts === 1;
    });

    expect((await jobRow(jobId))?.last_error).not.toContain(token);
    const runs = await syncRunsFor(workspaceA, connectionId);
    expect(String(runs[0]!.error_message)).not.toContain(token);
    expect(String(runs[0]!.error_message)).toContain("[redacted]");
  });

  it("rejects jobs for connections of another workspace", async () => {
    const connectionId = await seedConnection(workspaceA, "demo");
    // Tampered enqueue: workspace B's context, workspace A's connection.
    const jobId = await enqueue(workspaceB, connectionId, "connection.sync");
    await waitFor(async () => (await jobRow(jobId))?.status === "dead");
    expect((await jobRow(jobId))?.last_error).toMatch(/contract:/);
    expect(await syncRunsFor(workspaceB, connectionId)).toHaveLength(0);
  });
});

function dayStartUtc(timestampMs: number): number {
  const date = new Date(timestampMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
