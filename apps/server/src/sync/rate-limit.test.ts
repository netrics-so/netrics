import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  RateLimitedError,
  type ConnectionContext,
  type Connector,
  type ConnectorManifest,
  type SyncRequest,
} from "@netrics/connector-sdk";
import type { ConnectorRegistry } from "@netrics/connector-runtime";

import { createDefaultRegistry } from "../connectors.js";
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

import { createCredentialKeyring } from "../credentials.js";
import { createJobHandlers } from "../jobs/handlers.js";
import { syncCatalog } from "./catalog.js";
import {
  createTestDatabase,
  type TestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "../test-db.js";
import { createWorker, type WorkerHandle } from "../worker.js";

// #781: a provider rate limit with a known reset defers every job of the
// connection to the reset (plus jitter) instead of retrying every few
// minutes, is no failure and no outage, and the backfill resumes from its
// checkpoint afterwards.

vi.setConfig({ testTimeout: 30_000 });

const KEYRING = createCredentialKeyring(Buffer.alloc(32, 7).toString("base64"));
/** The longest jitter the engine adds to a provider's reset. */
const MAX_JITTER_MS = 60_000;

const manifest: ConnectorManifest = {
  id: "limited",
  version: "0.1.0",
  sdkVersion: "^0.2.16",
  name: "Limited",
  description: "Test connector that runs into a provider rate limit.",
  authStrategies: [{ strategy: "none" }],
  configSchema: {},
  metrics: [
    {
      key: "limited.hits",
      name: "Hits",
      description: "Hits per day.",
      kind: "delta",
      unit: "count",
      granularity: "day",
      dimensions: ["resource"],
      aggregations: ["sum"],
    },
  ],
  minRefreshIntervalSeconds: 300,
  supportsBackfill: true,
  backfillDays: 30,
  outboundDomains: [],
};

/** While set, every request after the first backfill page meets the limit. */
let limitedUntil: Date | null = null;
/** The cursors the connector was asked for, per mode. */
const requests: Array<{ mode: string; cursor: string | null }> = [];

const limitedConnector: Connector = {
  manifest,
  async check() {
    return { ok: true };
  },
  async discover() {
    return [];
  },
  async sync(_context: ConnectionContext, request: SyncRequest) {
    requests.push({ mode: request.mode, cursor: request.cursor ?? null });
    const first = request.mode === "backfill" && !request.cursor;
    if (limitedUntil && !first) {
      throw new RateLimitedError(
        "The provider's rate limit is used up (429).",
        limitedUntil,
      );
    }
    const observation = (day: string) => ({
      metricKey: "limited.hits",
      sourceTimestamp: `${day}T00:00:00.000Z`,
      value: 1,
      dimensions: { resource: `${request.mode}-${day}` },
    });
    if (first) {
      return {
        observations: [observation("2026-10-01")],
        nextCursor: "page-2",
        done: false,
      };
    }
    return { observations: [observation("2026-10-02")], done: true };
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
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

let testDb: TestDatabase;
let registry: ConnectorRegistry;
let appDb: Database;
let schedulerDb: Database;
let owner: Sql;
let worker: WorkerHandle;
let workspaceId: string;

async function seedConnection(
  state: { authState?: string; consecutiveFailures?: number } = {},
): Promise<string> {
  return withWorkspace(appDb, { workspaceId }, async (tx) => {
    const [connection] = await tx
      .insert(schema.connections)
      .values({
        workspaceId,
        connectorId: "limited",
        name: "Limited site",
        config: {},
      })
      .returning({ id: schema.connections.id });
    await tx.insert(schema.connectionState).values({
      connectionId: connection!.id,
      workspaceId,
      pollIntervalSeconds: 300,
      authState: state.authState ?? "ok",
      consecutiveFailures: state.consecutiveFailures ?? 0,
    });
    return connection!.id;
  });
}

function enqueue(
  connectionId: string,
  kind: "connection.sync" | "connection.backfill",
  runAt?: Date,
) {
  return withWorkspace(appDb, { workspaceId }, (tx) =>
    enqueueJob(tx, {
      kind,
      workspaceId,
      connectionId,
      ...(runAt ? { runAt } : {}),
    }),
  );
}

async function job(id: string) {
  const [row] = await owner<
    { status: string; attempts: number; run_at: Date; payload: unknown }[]
  >`select status, attempts, run_at, payload from jobs where id = ${id}`;
  return row!;
}

async function stateOf(connectionId: string) {
  const [row] = await withWorkspace(appDb, { workspaceId }, (tx) =>
    tx
      .select()
      .from(schema.connectionState)
      .where(eq(schema.connectionState.connectionId, connectionId)),
  );
  return row!;
}

async function runsOf(connectionId: string) {
  return owner<
    {
      mode: string;
      status: string;
      error_class: string | null;
      cursor_before: string | null;
      cursor_after: string | null;
    }[]
  >`select mode, status, error_class, cursor_before, cursor_after
    from sync_runs where connection_id = ${connectionId}
    order by started_at, finished_at`;
}

/** The reset has passed: what the clock would do, for the jobs and state. */
async function resetPassed(connectionId: string) {
  limitedUntil = null;
  await owner`update connection_state set rate_limited_until = now() - interval '1 second'
    where connection_id = ${connectionId}`;
  await owner`update jobs set run_at = now()
    where connection_id = ${connectionId} and status in ('pending', 'continuing')`;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  appDb = createDatabase(testDb.appUrl);
  schedulerDb = createDatabase(schedulerUrlOf(testDb));
  owner = createRawSqlClient(testDb.adminUrl, { max: 2 });
  registry = createDefaultRegistry();
  registry.register(limitedConnector);
  const ownerDb = createDatabase(testDb.adminUrl, { max: 1 });
  await syncCatalog(ownerDb, registry);
  await ownerDb.$client.end({ timeout: 5 });
  const [user] = await appDb
    .insert(schema.users)
    .values({ email: "limits@example.com", displayName: "Owner" })
    .returning({ id: schema.users.id });
  workspaceId = await createWorkspace(appDb, {
    name: "Limits",
    ownerUserId: user!.id,
  });
  worker = createWorker({
    schedulerDb,
    appDb,
    handlers: createJobHandlers({ registry, credentialKeyring: KEYRING }),
    pollMs: 25,
    heartbeatMs: 50,
  });
  await worker.start();
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await worker?.stop().catch(() => undefined);
  await owner?.end({ timeout: 5 }).catch(() => undefined);
});

describe("a provider rate limit with a known reset (#781)", () => {
  it("defers the backfill and the incremental sync to the reset, without a failure or an outage", async () => {
    requests.length = 0;
    // As in production: earlier 429s left an outage and ten failures.
    const connectionId = await seedConnection({
      authState: "outage",
      consecutiveFailures: 10,
    });
    const retryAt = new Date(Date.now() + 60 * 60 * 1000);
    limitedUntil = retryAt;
    const backfill = await enqueue(connectionId, "connection.backfill");
    // The incremental sync waits behind the backfill.
    const incremental = await enqueue(
      connectionId,
      "connection.sync",
      new Date(Date.now() + 2_000),
    );

    await waitFor(async () => (await job(backfill)).status === "continuing");

    const deferred = await job(backfill);
    expect(deferred.attempts).toBe(0);
    expect(deferred.run_at.getTime()).toBeGreaterThanOrEqual(retryAt.getTime());
    expect(deferred.run_at.getTime()).toBeLessThanOrEqual(
      retryAt.getTime() + MAX_JITTER_MS,
    );
    const waiting = await job(incremental);
    expect(waiting.status).toBe("pending");
    expect(waiting.attempts).toBe(0);
    expect(waiting.run_at.getTime()).toBeGreaterThanOrEqual(retryAt.getTime());

    const state = await stateOf(connectionId);
    expect(state.consecutiveFailures).toBe(10);
    // A provider that answers 429 is up: no outage.
    expect(state.authState).toBe("ok");
    expect(state.rateLimitedUntil?.getTime()).toBe(deferred.run_at.getTime());
    expect(state.nextDueAt!.getTime()).toBeGreaterThanOrEqual(
      retryAt.getTime(),
    );
    // The first page committed its checkpoint before the limit.
    expect(state.cursor).toBe("page-2");
    expect(await runsOf(connectionId)).toEqual([
      {
        mode: "backfill",
        status: "failed",
        error_class: "rate_limited",
        cursor_before: null,
        cursor_after: "page-2",
      },
    ]);
    // Neither job asked the provider again.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(requests).toEqual([
      { mode: "backfill", cursor: null },
      { mode: "backfill", cursor: "page-2" },
    ]);
  });

  it("resumes the backfill from its checkpoint after the reset, and recovers", async () => {
    requests.length = 0;
    const connectionId = await seedConnection({
      authState: "outage",
      consecutiveFailures: 10,
    });
    limitedUntil = new Date(Date.now() + 60 * 60 * 1000);
    const backfill = await enqueue(connectionId, "connection.backfill");
    await waitFor(async () => (await job(backfill)).status === "continuing");
    const incremental = await enqueue(connectionId, "connection.sync");

    await resetPassed(connectionId);
    await waitFor(async () => (await job(backfill)).status === "succeeded");
    await waitFor(async () => (await job(incremental)).status === "succeeded");

    // The backfill went on at page 2; it did not read page 1 again.
    expect(requests.filter((request) => request.mode === "backfill")).toEqual([
      { mode: "backfill", cursor: null },
      { mode: "backfill", cursor: "page-2" },
      { mode: "backfill", cursor: "page-2" },
    ]);
    const runs = await runsOf(connectionId);
    expect(runs.slice(0, 2)).toEqual([
      expect.objectContaining({
        mode: "backfill",
        error_class: "rate_limited",
      }),
      expect.objectContaining({
        mode: "backfill",
        status: "succeeded",
        cursor_before: "page-2",
      }),
    ]);
    const state = await stateOf(connectionId);
    expect(state).toMatchObject({
      authState: "ok",
      consecutiveFailures: 0,
      rateLimitedUntil: null,
    });
  });

  it("defers a job that starts while the limit holds, without asking the provider", async () => {
    requests.length = 0;
    const connectionId = await seedConnection();
    const until = new Date(Date.now() + 30 * 60 * 1000);
    await owner`update connection_state set rate_limited_until = ${until}
      where connection_id = ${connectionId}`;
    const sync = await enqueue(connectionId, "connection.sync");

    await waitFor(async () => {
      const row = await job(sync);
      return row.status === "pending" && row.run_at.getTime() > Date.now();
    });
    expect((await job(sync)).run_at.getTime()).toBe(until.getTime());
    expect((await job(sync)).attempts).toBe(0);
    expect(requests).toEqual([]);
    expect(await runsOf(connectionId)).toEqual([]);
  });

  it("bounds a reset far in the future to a day", async () => {
    const connectionId = await seedConnection();
    limitedUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const backfill = await enqueue(connectionId, "connection.backfill");
    await waitFor(async () => (await job(backfill)).status === "continuing");
    const runAt = (await job(backfill)).run_at.getTime();
    expect(runAt).toBeLessThanOrEqual(
      Date.now() + 24 * 60 * 60 * 1000 + MAX_JITTER_MS,
    );
    expect(runAt).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    limitedUntil = null;
    await owner`update jobs set status = 'failed' where id = ${backfill}`;
  });

  it("leaves the jobs of other connections alone", async () => {
    const limited = await seedConnection();
    const other = await seedConnection();
    const otherJob = await enqueue(
      other,
      "connection.sync",
      new Date(Date.now() + 5 * 60 * 1000),
    );
    const before = (await job(otherJob)).run_at.getTime();
    limitedUntil = new Date(Date.now() + 60 * 60 * 1000);
    const backfill = await enqueue(limited, "connection.backfill");
    await waitFor(async () => (await job(backfill)).status === "continuing");
    expect((await job(otherJob)).run_at.getTime()).toBe(before);
    limitedUntil = null;
    await owner`update jobs set status = 'failed' where id in (${backfill}, ${otherJob})`;
  });
});
