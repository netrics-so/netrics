import { randomBytes, randomUUID } from "node:crypto";

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
import type { ConnectorRegistry } from "@netrics/connector-runtime";
import pino from "pino";

import { createDefaultRegistry } from "../connectors.js";
import {
  createDatabase,
  createRawSqlClient,
  createWorkspace,
  enqueueJob,
  schema,
  withWorkspace,
  type Database,
  type Job,
  type Sql,
} from "@netrics/database";

import { createCredentialKeyring, encryptCredentials } from "../credentials.js";
import { createJobHandlers } from "../jobs/handlers.js";
import { syncCatalog } from "./catalog.js";
import { createTestDatabase, type TestDatabase } from "../test-db.js";
import { createWorker, type WorkerHandle } from "../worker.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const ENCRYPTION_KEY = randomBytes(32).toString("base64");
const KEYRING = createCredentialKeyring(ENCRYPTION_KEY);

function testManifest(id: string, metricKey: string): ConnectorManifest {
  return {
    id,
    version: "0.1.0",
    sdkVersion: "^0.2.0",
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
        granularity: "day",
        dimensions: ["resource"],
        aggregations: ["sum"],
      },
    ],
    minRefreshIntervalSeconds: 300,
    supportsBackfill: true,
    backfillDays: 90,
    outboundDomains: [],
  };
}

/** One series per identity: observations are keyed by metric+dimensions+time. */
function flakyObservation(identity: string) {
  return {
    metricKey: "flaky.hits",
    sourceTimestamp: "2026-09-20T00:00:00.000Z",
    value: 1,
    dimensions: { resource: identity },
  };
}

/** Fails mid-pagination on the first run, then recovers (crash simulation). */
let flakyShouldFail = true;
/** Requests for page 1 (no cursor). */
let flakyFirstPageCalls = 0;
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
      flakyFirstPageCalls += 1;
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

/**
 * Records, from inside each provider call, how many netrics_app sessions sit
 * idle in a transaction. The engine must not hold one open across connector
 * I/O (#34).
 */
const idleInTransactionDuringSync: number[] = [];
let activityProbe: Sql | null = null;
const probeConnector: Connector = {
  manifest: testManifest("probe", "probe.hits"),
  async check() {
    return { ok: true };
  },
  async discover() {
    return [];
  },
  async sync(_context: ConnectionContext, request: SyncRequest) {
    const [row] = await activityProbe!<{ count: number }[]>`
      select count(*)::int as count from pg_stat_activity
      where usename = 'netrics_app' and state like 'idle in transaction%'
        and datname = current_database()
    `;
    idleInTransactionDuringSync.push(row!.count);
    return request.cursor
      ? { observations: [], done: true }
      : { observations: [], nextCursor: "page-2", done: false };
  },
};

/** Reports one daily value that the "provider" may later correct. */
let revisingValue = 10;
const revisingConnector: Connector = {
  manifest: testManifest("revising", "revising.orders"),
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
          metricKey: "revising.orders",
          sourceTimestamp: "2026-09-26T00:00:00.000Z",
          value: revisingValue,
          dimensions: { resource: "shop" },
        },
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

/**
 * A paged provider shaped like Search Console (#145): one page per week of
 * the window, the cursor is the first day of the next page, and every page
 * holds `resources` observations per day. `onPage` runs before a page is
 * produced and may probe the database, throw, or never return.
 */
interface PagerControl {
  resources: number;
  requests: SyncRequest[];
  onPage?: (request: SyncRequest) => Promise<void> | void;
}

function pagerConnector(
  id: string,
  backfillDays: number,
  control: () => PagerControl,
): Connector {
  return {
    manifest: { ...testManifest(id, `${id}.hits`), backfillDays },
    async check() {
      return { ok: true };
    },
    async discover() {
      return [];
    },
    async sync(_context: ConnectionContext, request: SyncRequest) {
      const pager = control();
      pager.requests.push(request);
      const toMs = Date.parse(request.to);
      const startMs = dayStartUtc(Date.parse(request.cursor ?? request.from));
      const endMs = Math.min(startMs + 7 * DAY_MS, toMs);
      await pager.onPage?.(request);
      const observations = [];
      for (let day = startMs; day < endMs; day += DAY_MS) {
        for (let resource = 0; resource < pager.resources; resource += 1) {
          observations.push({
            metricKey: `${id}.hits`,
            sourceTimestamp: new Date(day).toISOString(),
            value: (day / DAY_MS + resource) % 97,
            dimensions: { resource: `r${resource}` },
          });
        }
      }
      return {
        observations,
        nextCursor: new Date(endMs).toISOString(),
        done: endMs >= toMs,
      };
    },
  };
}

let largePager: PagerControl = { resources: 0, requests: [] };
const largePagerConnector = pagerConnector(
  "pager-large",
  490,
  () => largePager,
);
let resumePager: PagerControl = { resources: 0, requests: [] };
let freshPager: PagerControl = { resources: 0, requests: [] };
const freshPagerConnector = pagerConnector("pager-fresh", 70, () => freshPager);
const resumePagerConnector = pagerConnector(
  "pager-resume",
  70,
  () => resumePager,
);

/** Never finishes: every page advances an opaque cursor. */
let endlessPages = 0;
const endlessConnector: Connector = {
  manifest: testManifest("endless", "endless.hits"),
  async check() {
    return { ok: true };
  },
  async discover() {
    return [];
  },
  async sync() {
    endlessPages += 1;
    return {
      observations: [
        {
          metricKey: "endless.hits",
          sourceTimestamp: "2026-09-20T00:00:00.000Z",
          value: 1,
          dimensions: { resource: `page-${endlessPages}` },
        },
      ],
      nextCursor: `page-${String(endlessPages + 1).padStart(4, "0")}`,
      done: false,
    };
  },
};

/** One page wider than a single INSERT may bind (65,535 parameters). */
const WIDE_PAGE_ROWS = 12_000;
const widePageConnector: Connector = {
  manifest: testManifest("wide-page", "wide.hits"),
  async check() {
    return { ok: true };
  },
  async discover() {
    return [];
  },
  async sync() {
    return {
      observations: Array.from({ length: WIDE_PAGE_ROWS }, (_, index) => ({
        metricKey: "wide.hits",
        sourceTimestamp: "2026-09-20T00:00:00.000Z",
        value: index,
        dimensions: { resource: `r${index}` },
      })),
      done: true,
    };
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
let registry: ConnectorRegistry;
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
  const connectionId = randomUUID();
  return withWorkspace(appDb, { workspaceId }, async (tx) => {
    const [connection] = await tx
      .insert(schema.connections)
      .values({
        id: connectionId,
        workspaceId,
        connectorId,
        name: `${connectorId} connection`,
        config,
        credentialsEncrypted: credentials
          ? Buffer.from(
              encryptCredentials(JSON.stringify(credentials), KEYRING, {
                workspaceId,
                connectionId,
              }),
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

  registry = createDefaultRegistry();
  registry.register(flakyConnector);
  registry.register(largePagerConnector);
  registry.register(resumePagerConnector);
  registry.register(freshPagerConnector);
  registry.register(endlessConnector);
  registry.register(widePageConnector);
  registry.register(brokenConnector);
  registry.register(leakyConnector);
  registry.register(probeConnector);
  registry.register(revisingConnector);
  activityProbe = createRawSqlClient(testDb.adminUrl, { max: 1 });

  // Explicit catalog sync (production does this at process startup).
  // Test-only connectors join the catalog as `migrate` would install them.
  const ownerDb = createDatabase(testDb.adminUrl, { max: 1 });
  await syncCatalog(ownerDb, registry);
  await syncCatalog(ownerDb, registry); // idempotent
  await ownerDb.$client.end({ timeout: 5 });

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
    handlers: createJobHandlers({ registry, credentialKeyring: KEYRING }),
    pollMs: 25,
    heartbeatMs: 50,
  });
  await worker.start();
}, 60_000);

afterAll(async () => {
  await worker.stop().catch(() => undefined);
  await schedulerRaw.end({ timeout: 5 }).catch(() => undefined);
  await activityProbe?.end({ timeout: 5 }).catch(() => undefined);
});

describe("catalog sync", () => {
  it("upserts connectors and metric definitions from manifests", async () => {
    const connectors = await appDb.select().from(schema.connectors);
    expect(connectors.map((row) => row.id).sort()).toEqual([
      "app-store-connect",
      "broken",
      "demo",
      "endless",
      "flaky-pages",
      "google-search-console",
      "leaky",
      "pager-fresh",
      "pager-large",
      "pager-resume",
      "probe",
      "revising",
      "vercel",
      "wide-page",
    ]);
    const metrics = await appDb.select().from(schema.metricDefinitions);
    const keys = metrics.map((row) => `${row.connectorId}/${row.key}`).sort();
    expect(keys).toContain("demo/demo.visitors");
    expect(keys).toContain("demo/demo.signups");
    expect(keys).toContain("flaky-pages/flaky.hits");
    expect(keys).toContain("vercel/vercel.pageviews");
    expect(keys).toContain(
      "google-search-console/google-search-console.clicks",
    );
    expect(keys).toContain("app-store-connect/app_store_connect.downloads");
    // Idempotent re-sync: exactly one row per (connector, key).
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("sync engine", () => {
  it("stores provider revisions of past values; identical replays write nothing", async () => {
    const connectionId = await seedConnection(workspaceA, "revising");
    const run = async () => {
      const jobId = await enqueue(
        workspaceA,
        connectionId,
        "connection.backfill",
      );
      await waitFor(async () => (await jobRow(jobId))?.status === "succeeded");
    };
    const storedValues = () =>
      withWorkspace(appDb, { workspaceId: workspaceA }, async (tx) =>
        (
          await tx
            .select({ value: schema.observations.value })
            .from(schema.observations)
            .where(eq(schema.observations.connectionId, connectionId))
        ).map((row) => row.value),
      );

    revisingValue = 10;
    await run();
    expect(await storedValues()).toEqual([10]);

    // The provider corrects the day (late orders arrived).
    revisingValue = 14;
    await run();
    expect(await storedValues()).toEqual([14]);

    // Replaying the same data is a no-op.
    await run();
    const runs = await syncRunsFor(workspaceA, connectionId);
    expect(runs.map((r) => r.observations_written)).toEqual([1, 1, 0]);
  });

  it("calls the provider with no database transaction held open", async () => {
    const connectionId = await seedConnection(workspaceA, "probe");
    const jobId = await enqueue(
      workspaceA,
      connectionId,
      "connection.backfill",
    );
    await waitFor(async () => (await jobRow(jobId))?.status === "succeeded");
    // Two pages were fetched; during neither was a transaction held open.
    expect(idleInTransactionDuringSync).toEqual([0, 0]);
  });

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
    // The cursor stops at the UTC day containing `to`, never ahead of it.
    expect(run.cursor_after).toBe(
      new Date(
        dayStartUtc(new Date(run.requested_to as string).getTime()),
      ).toISOString(),
    );

    // Expected observations: days in [dayStart(from), dayStart(to + 14h)]
    // (the demo reports up to the latest date anywhere, UTC+14) × 3
    // resources × 2 metrics (demo connector determinism).
    const requestedTo = new Date(run.requested_to as string).getTime();
    const from = dayStartUtc(new Date(run.requested_from as string).getTime());
    const to = dayStartUtc(requestedTo + 14 * 60 * 60 * 1000);
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

  it("keeps the pages committed before a mid-pagination failure and resumes after them", async () => {
    flakyShouldFail = true;
    flakyFirstPageCalls = 0;
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

    // Page 1 committed with its cursor as the checkpoint (#145); page 2's
    // failure is recorded with what the run did write.
    expect(await connectionObservationCount(workspaceA, connectionId)).toBe(2);
    let runs = await syncRunsFor(workspaceA, connectionId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("failed");
    expect(runs[0]!.error_class).toBe("transient");
    expect(runs[0]!.observations_written).toBe(2);
    expect(runs[0]!.cursor_before).toBeNull();
    expect(runs[0]!.cursor_after).toBe("page-2");
    const state = await stateFor(workspaceA, connectionId);
    expect(state!.cursor).toBe("page-2");
    expect(state!.lastSuccessAt).toBeNull();
    expect(state!.authState).toBe("outage");
    expect(state!.consecutiveFailures).toBe(1);

    // The provider recovers; the retry starts at the checkpoint and never
    // fetches page 1 again.
    flakyShouldFail = false;
    await schedulerRaw`update jobs set run_at = now() where id = ${jobId}`;
    await waitFor(async () => (await jobRow(jobId))?.status === "succeeded");
    expect(flakyFirstPageCalls).toBe(1);
    expect(await connectionObservationCount(workspaceA, connectionId)).toBe(4);
    runs = await syncRunsFor(workspaceA, connectionId);
    const succeeded = runs.filter((row) => row.status === "succeeded");
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]!.cursor_before).toBe("page-2");
    expect(succeeded[0]!.observations_written).toBe(2);
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

/**
 * Runs one attempt of a sync job in-process, the way the worker would after
 * claiming it, so a test can abandon an attempt mid-run (a crashed worker).
 * Attempts of the same job share its id; without one, it is a new job.
 */
function runAttempt(
  kind: "connection.sync" | "connection.backfill",
  workspaceId: string,
  connectionId: string,
  attempts: number,
  jobId: string = randomUUID(),
): Promise<void> {
  const handler = createJobHandlers({ registry, credentialKeyring: KEYRING })[
    kind
  ]!;
  const job = {
    id: jobId,
    kind,
    workspaceId,
    connectionId,
    attempts,
    payload: { workspace_id: workspaceId, connection_id: connectionId },
  } as unknown as Job;
  return handler({
    job,
    appDb,
    schedulerDb,
    logger: pino({ level: "silent" }),
  });
}

/** What the database holds for a connection, read past RLS by the owner. */
async function committed(connectionId: string) {
  const [row] = await activityProbe!<
    { observations: number; days: number; cursor: string | null }[]
  >`
    select
      (select count(*)::int from observations
        where connection_id = ${connectionId}) as observations,
      (select count(distinct source_timestamp)::int from observations
        where connection_id = ${connectionId}) as days,
      (select cursor from connection_state
        where connection_id = ${connectionId}) as cursor
  `;
  return row!;
}

describe("page-wise ingest (#145)", () => {
  it("commits a large backfill page by page, checkpointing the cursor", async () => {
    const connectionId = await seedConnection(workspaceA, "pager-large");
    const resources = 50;
    const perPage = 7 * resources;
    // Before producing each page, the provider looks at what the engine has
    // committed: every earlier page, and the cursor it is asked to resume.
    const seen: {
      cursor: string | undefined;
      observations: number;
      stateCursor: string | null;
    }[] = [];
    largePager = {
      resources,
      requests: [],
      onPage: async (request) => {
        const now = await committed(connectionId);
        seen.push({
          cursor: request.cursor,
          observations: now.observations,
          stateCursor: now.cursor,
        });
      },
    };
    const jobId = await enqueue(
      workspaceA,
      connectionId,
      "connection.backfill",
    );
    await waitFor(async () => (await jobRow(jobId))?.status === "succeeded");

    // 490 days of weekly pages.
    expect(seen.length).toBeGreaterThanOrEqual(70);
    seen.forEach((page, index) => {
      // Page n is fetched only after pages 1..n-1 committed, and the
      // persisted cursor is the one page n continues from.
      expect(page.observations).toBe(index * perPage);
      expect(page.stateCursor).toBe(index === 0 ? null : page.cursor);
    });

    const [run] = await syncRunsFor(workspaceA, connectionId);
    expect(run!.status).toBe("succeeded");
    const from = dayStartUtc(Date.parse(String(largePager.requests[0]!.from)));
    const to = dayStartUtc(new Date(run!.requested_to as string).getTime());
    const days = (to - from) / DAY_MS + 1;
    const final = await committed(connectionId);
    expect(final.days).toBe(days);
    expect(final.observations).toBe(days * resources);
    expect(run!.observations_written).toBe(final.observations);
    expect(final.cursor).toBe(run!.cursor_after);
  });

  it("resumes a crashed run at the last committed page, without gaps or duplicates", async () => {
    const connectionId = await seedConnection(workspaceA, "pager-resume");
    const resources = 3;
    const perPage = 7 * resources;

    // Attempt 1: the worker dies while fetching page 4 (the call never
    // returns; nothing records a failure).
    let releaseZombie: (error: Error) => void = () => {};
    let reachedPage4: () => void = () => {};
    const atPage4 = new Promise<void>((resolve) => {
      reachedPage4 = resolve;
    });
    resumePager = {
      resources,
      requests: [],
      onPage: () => {
        if (resumePager.requests.length === 4) {
          reachedPage4();
          return new Promise<void>((_, reject) => {
            releaseZombie = reject;
          });
        }
      },
    };
    const jobId = randomUUID();
    const zombie = runAttempt(
      "connection.backfill",
      workspaceA,
      connectionId,
      0,
      jobId,
    );
    await atPage4;
    const crashed = await committed(connectionId);
    expect(crashed.observations).toBe(3 * perPage);
    const checkpoint = resumePager.requests[3]!.cursor!;
    expect(crashed.cursor).toBe(checkpoint);
    expect(await syncRunsFor(workspaceA, connectionId)).toHaveLength(0);
    const firstFrom = resumePager.requests[0]!.from;

    // Attempt 2 (the reclaimed job) continues from the checkpoint.
    resumePager = { resources, requests: [] };
    await runAttempt("connection.backfill", workspaceA, connectionId, 1, jobId);
    expect(resumePager.requests[0]!.cursor).toBe(checkpoint);
    expect(
      resumePager.requests.every(
        (request) => !request.cursor || request.cursor >= checkpoint,
      ),
    ).toBe(true);

    const runs = await syncRunsFor(workspaceA, connectionId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("succeeded");
    expect(runs[0]!.cursor_before).toBe(checkpoint);
    const from = dayStartUtc(Date.parse(firstFrom));
    const to = dayStartUtc(new Date(runs[0]!.requested_to as string).getTime());
    const days = (to - from) / DAY_MS + 1;
    const final = await committed(connectionId);
    // No gaps: every day of the window; no duplicates: the resumed run wrote
    // only the pages the crashed one had not.
    expect(final.days).toBe(days);
    expect(final.observations).toBe(days * resources);
    expect(runs[0]!.observations_written).toBe(
      final.observations - crashed.observations,
    );
    expect(final.cursor).toBe(runs[0]!.cursor_after);

    // The abandoned attempt finally fails: its failure is recorded, and it
    // does not move the cursor the successful run left.
    releaseZombie(new Error("worker gone"));
    await expect(zombie).rejects.toThrow("worker gone");
    expect((await committed(connectionId)).cursor).toBe(final.cursor);
    const after = await syncRunsFor(workspaceA, connectionId);
    expect(after.map((row) => row.status).sort()).toEqual([
      "failed",
      "succeeded",
    ]);
    expect(
      after.find((row) => row.status === "failed")!.observations_written,
    ).toBe(3 * perPage);
  });

  it("a connector paging without end fails as contract, keeping the pages it committed", async () => {
    endlessPages = 0;
    const connectionId = await seedConnection(workspaceA, "endless");
    await expect(
      runAttempt("connection.backfill", workspaceA, connectionId, 0),
    ).rejects.toThrow(/paged more than 100 times/);

    const state = await committed(connectionId);
    expect(endlessPages).toBe(100);
    expect(state.observations).toBe(100);
    expect(state.cursor).toBe("page-0101");
    const runs = await syncRunsFor(workspaceA, connectionId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("failed");
    expect(runs[0]!.error_class).toBe("contract");
    expect(runs[0]!.observations_written).toBe(100);
    expect(runs[0]!.cursor_after).toBe("page-0101");
    const row = await stateFor(workspaceA, connectionId);
    expect(row!.lastSuccessAt).toBeNull();
    expect(row!.consecutiveFailures).toBe(1);
  });

  it("ingests a page wider than one INSERT can bind", async () => {
    const connectionId = await seedConnection(workspaceA, "wide-page");
    await runAttempt("connection.backfill", workspaceA, connectionId, 0);
    expect((await committed(connectionId)).observations).toBe(WIDE_PAGE_ROWS);
    const runs = await syncRunsFor(workspaceA, connectionId);
    expect(runs[0]!.observations_written).toBe(WIDE_PAGE_ROWS);
  });
});

describe("fresh and resumed backfills (#153)", () => {
  it("a new backfill after a successful sync reads the whole window; its retry resumes from its checkpoint", async () => {
    const connectionId = await seedConnection(workspaceA, "pager-fresh");
    const resources = 2;
    freshPager = { resources, requests: [] };
    await runAttempt("connection.backfill", workspaceA, connectionId, 0);
    const windowDays = freshPager.requests.length;
    expect(windowDays).toBeGreaterThanOrEqual(10);

    // An incremental sync succeeds: the cursor now sits near "now".
    freshPager = { resources, requests: [] };
    await runAttempt("connection.sync", workspaceA, connectionId, 0);
    const incrementalCursor = (await committed(connectionId)).cursor!;
    expect(Date.parse(incrementalCursor)).toBeGreaterThan(
      Date.now() - 2 * DAY_MS,
    );

    // A new backfill (e.g. after a config change) starts at the window
    // start, not at the stored cursor; its worker dies on page 4.
    const jobId = randomUUID();
    let releaseZombie: (error: Error) => void = () => {};
    let reachedPage4: () => void = () => {};
    const atPage4 = new Promise<void>((resolve) => {
      reachedPage4 = resolve;
    });
    freshPager = {
      resources,
      requests: [],
      onPage: () => {
        if (freshPager.requests.length === 4) {
          reachedPage4();
          return new Promise<void>((_, reject) => {
            releaseZombie = reject;
          });
        }
      },
    };
    const zombie = runAttempt(
      "connection.backfill",
      workspaceA,
      connectionId,
      0,
      jobId,
    );
    await atPage4;
    const first = freshPager.requests[0]!;
    expect(first.cursor).toBeUndefined();
    expect(Date.parse(first.from)).toBeLessThan(Date.now() - 69 * DAY_MS);
    const checkpoint = freshPager.requests[3]!.cursor!;
    expect((await committed(connectionId)).cursor).toBe(checkpoint);

    // The reclaimed attempt of the same job resumes from the checkpoint and
    // fetches none of the pages that committed.
    freshPager = { resources, requests: [] };
    await runAttempt("connection.backfill", workspaceA, connectionId, 1, jobId);
    expect(freshPager.requests[0]!.cursor).toBe(checkpoint);
    expect(
      freshPager.requests.every(
        (request) =>
          request.cursor !== undefined && request.cursor >= checkpoint,
      ),
    ).toBe(true);
    expect(freshPager.requests.length).toBe(windowDays - 3);
    releaseZombie(new Error("worker gone"));
    await expect(zombie).rejects.toThrow("worker gone");

    const runs = await syncRunsFor(workspaceA, connectionId);
    const resumed = runs.find(
      (row) => row.mode === "backfill" && row.attempt === 2,
    )!;
    expect(resumed.status).toBe("succeeded");
    expect(resumed.cursor_before).toBe(checkpoint);
    // One row per day and resource: re-read days were idempotent upserts.
    const final = await committed(connectionId);
    expect(final.observations).toBe(final.days * resources);

    // Yet another backfill is a new job again: whole window.
    freshPager = { resources, requests: [] };
    await runAttempt("connection.backfill", workspaceA, connectionId, 0);
    expect(freshPager.requests[0]!.cursor).toBeUndefined();
    expect(freshPager.requests.length).toBe(windowDays);
    const last = (await syncRunsFor(workspaceA, connectionId)).at(-1)!;
    expect(last.cursor_before).toBeNull();
  });

  it("an incremental sync continues from a backfill's checkpoint", async () => {
    const connectionId = await seedConnection(workspaceA, "pager-fresh");
    freshPager = {
      resources: 1,
      requests: [],
      onPage: () => {
        if (freshPager.requests.length === 3) {
          throw new Error("provider exploded mid-stream");
        }
      },
    };
    await expect(
      runAttempt("connection.backfill", workspaceA, connectionId, 0),
    ).rejects.toThrow("provider exploded");
    const checkpoint = (await committed(connectionId)).cursor!;
    expect(checkpoint).toBe(freshPager.requests[2]!.cursor);

    // E.g. the job died for good and the connection was reauthorized: the
    // next scheduled sync finishes the window from the checkpoint.
    freshPager = { resources: 1, requests: [] };
    await runAttempt("connection.sync", workspaceA, connectionId, 0);
    expect(freshPager.requests[0]!.cursor).toBe(checkpoint);
    expect(freshPager.requests[0]!.from).toBe(checkpoint);
    const runs = await syncRunsFor(workspaceA, connectionId);
    expect(runs.at(-1)).toMatchObject({
      mode: "incremental",
      status: "succeeded",
      cursor_before: checkpoint,
    });
  });
});

function dayStartUtc(timestampMs: number): number {
  const date = new Date(timestampMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
