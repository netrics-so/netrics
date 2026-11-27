import { randomBytes, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import pino from "pino";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  connectionDetailResponseSchema,
  connectionResponseSchema,
  workspaceListResponseSchema,
} from "@netrics/contracts";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import {
  sourceDatasetSchema,
  type Connector,
  type ConnectorManifest,
  type FreshnessEntry,
  type SyncResult,
} from "@netrics/connector-sdk";
import {
  createDemoConnector,
  demoManifest,
  HTTP_CHECK_CONNECTOR_ID,
} from "@netrics/connectors";
import { DEFAULT_DATA_POLICY, type DataPolicy } from "@netrics/domain";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  MAX_STATEMENT_TIMEOUT_MS,
  setIngestTimeout,
  type Sql,
} from "@netrics/database";

import { buildApp } from "../app.js";
import { createAuthService } from "../auth/index.js";
import { createCredentialKeyring } from "../credentials.js";
import { loadConfig } from "../env.js";
import {
  ContinueJobError,
  createJobHandlers,
  NonRetryableJobError,
} from "../jobs/handlers.js";
import { capturingLogger } from "../oauth/test-provider.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "../test-db.js";
import { syncCatalog } from "./catalog.js";

vi.setConfig({ testTimeout: 30_000 });

// Data freshness in the sync engine (ADR 0025 §4–5, #702): a fixture
// connector with a periodic and a continuous stream reports what each test
// sets, on a pinned clock. Rows commit with a succeeded run only, never
// move back, and set the connection's next sync.

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
const KEYRING = createCredentialKeyring(ENCRYPTION_KEY);
const HOUR = 60 * 60 * 1000;
const SIX_HOURS_S = 6 * 60 * 60;
/** 2026-11-16 09:00 UTC. */
const START = Date.parse("2026-11-16T09:00:00.000Z");
let clockMs = START;
const iso = (ms: number) => new Date(ms).toISOString();

/** What the fixture's next sync returns, or throws. */
let reply:
  | {
      freshness?: FreshnessEntry[];
      skipped?: true;
      nextCursor?: string;
      /** A first page (done: false) before this reply, on the cursor "page-2". */
      afterPage?: true;
    }
  | Error = {};
/** Runs inside the connector call, e.g. a change saved meanwhile. */
let during: (() => Promise<void>) | null = null;

const fixtureManifest: ConnectorManifest = {
  ...demoManifest,
  id: "freshness-fixture",
  sdkVersion: "^0.2.13",
  translations: { de: { freshnessStreams: { sales: "Verkäufe" } } },
  minRefreshIntervalSeconds: SIX_HOURS_S,
  freshnessStreams: [
    {
      key: "sales",
      name: "Sales",
      kind: "periodic",
      timeZone: "America/Los_Angeles",
      metrics: ["demo.visitors"],
    },
    {
      key: "reviews",
      name: "Reviews",
      kind: "continuous",
      metrics: ["demo.signups"],
    },
  ],
};

function fixture(): Connector {
  const demo = createDemoConnector();
  return {
    manifest: fixtureManifest,
    check: (context, runtime) => demo.check(context, runtime),
    discover: (context, runtime) => demo.discover(context, runtime),
    async sync(_context, request) {
      if (reply instanceof Error) throw reply;
      const { afterPage, ...final } = reply;
      if (afterPage && request.cursor !== "page-2")
        return { observations: [], nextCursor: "page-2", done: false };
      // A skipped run returns the cursor it was given (SDK 0.2.23).
      const cursor =
        final.skipped && request.cursor ? { nextCursor: request.cursor } : {};
      return { observations: [], ...cursor, ...final, done: true };
    },
  };
}

/**
 * A snapshot of the checks in its configuration over two pages, as the
 * HTTP check connector runs (#874): the rows, then the completing page
 * with the freshness of every check (#898).
 */
const checksSnapshot = sourceDatasetSchema.parse({
  key: "checks",
  name: "Checks",
  version: 1,
  mode: "snapshot",
  keyFields: ["check_id"],
  grain: "one check",
  fields: [
    {
      id: "check_id",
      name: "Check",
      type: "string",
      nullable: false,
      classification: "internal",
    },
  ],
});

function snapshotFixture(id: string): Connector {
  const demo = createDemoConnector();
  return {
    manifest: {
      ...fixtureManifest,
      id,
      translations: {},
      datasets: [checksSnapshot],
      freshnessStreams: [
        {
          key: "checks",
          name: "Checks",
          kind: "continuous",
          datasets: ["checks"],
        },
      ],
    },
    check: (context, runtime) => demo.check(context, runtime),
    discover: (context, runtime) => demo.discover(context, runtime),
    async sync(context, request): Promise<SyncResult> {
      const checks = (context.config.checks ?? []) as string[];
      const refreshKey = `run-${request.from}`;
      if (!request.cursor?.startsWith("run:")) {
        return {
          observations: [],
          datasetPages: [
            {
              datasetKey: "checks",
              schemaVersion: 1,
              refreshKey,
              pageKey: "p1",
              previousPageKey: null,
              records: checks.map((check) => ({
                values: { check_id: check },
              })),
              complete: false,
            },
          ],
          nextCursor: `run:${checks.join(",")}`,
          done: false,
        };
      }
      await during?.();
      const ran = request.cursor.slice(4).split(",");
      return {
        observations: [],
        datasetPages: [
          {
            datasetKey: "checks",
            schemaVersion: 1,
            refreshKey,
            pageKey: "p2",
            previousPageKey: "p1",
            records: [],
            complete: true,
          },
        ],
        receivedDatasets: ["checks"],
        freshness: ran.map((resource) => ({ stream: "checks", resource })),
        nextCursor: "done",
        done: true,
      };
    },
  };
}

function registry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(createDemoConnector());
  registry.register(fixture());
  // As the HTTP check connector (its resources are its configuration,
  // #898), and as any other connector.
  registry.register(snapshotFixture(HTTP_CHECK_CONNECTOR_ID));
  registry.register(snapshotFixture("snapshot-fixture"));
  return registry;
}

let app: FastifyInstance;
let db: Database;
let admin: Sql;
let cookie: string;
let workspaceId: string;

async function createConnection(connectorId: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspaceId}/connections`,
    headers: { cookie },
    payload: {
      connectorId,
      name: `${connectorId} ${randomUUID()}`,
      config: {},
    },
  });
  expect(response.statusCode).toBe(200);
  return connectionResponseSchema.parse(response.json()).connection.id;
}

beforeAll(async () => {
  const testDb = await createTestDatabase();
  const owner = createDatabase(testDb.adminUrl, { max: 1 });
  await syncCatalog(owner, registry());
  await owner.$client.end({ timeout: 5 });
  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
    APP_ENCRYPTION_KEY: ENCRYPTION_KEY,
  });
  db = createDatabase(testDb.appUrl);
  app = await buildApp(config, {
    db,
    authService: createAuthService(config, db, {
      logger: pino({ level: "silent" }),
    }),
    registry: registry(),
    checkDb: async () => true,
    logger: capturingLogger([]),
  });
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });
  const signUp = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: {
      name: "Owner",
      email: "freshness@example.com",
      password: "password-12345",
    },
  });
  const header = signUp.headers["set-cookie"];
  cookie = (Array.isArray(header) ? header : [header])
    .find((value) => value?.startsWith("better-auth.session_token="))!
    .split(";")[0]!;
  await app.inject({
    method: "POST",
    url: "/v1/bootstrap",
    headers: { cookie },
    payload: { workspaceName: "Freshness" },
  });
  workspaceId = workspaceListResponseSchema.parse(
    (
      await app.inject({
        method: "GET",
        url: "/v1/workspaces",
        headers: { cookie },
      })
    ).json(),
  ).workspaces[0]!.id;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin?.end({ timeout: 5 }).catch(() => undefined);
});

beforeEach(() => {
  clockMs = START;
  reply = {};
  during = null;
});

async function sync(
  connectionId: string,
  {
    payload = {},
    ...options
  }: { dataPolicy?: DataPolicy; payload?: Record<string, unknown> } = {},
) {
  const handlers = createJobHandlers({
    registry: registry(),
    credentialKeyring: KEYRING,
    now: () => new Date(clockMs),
    ...options,
  });
  return handlers["connection.sync"]!({
    job: {
      id: randomUUID(),
      kind: "connection.sync",
      workspaceId,
      connectionId,
      payload,
      runAt: new Date(clockMs),
      attempts: 0,
      maxAttempts: 8,
      status: "running" as const,
      lockedBy: "test",
      lockedAt: new Date(clockMs),
      lastError: null,
      idempotencyKey: null,
      createdAt: new Date(clockMs),
    },
    appDb: db,
    schedulerDb: db,
    logger: capturingLogger([]),
  });
}

async function rows(connectionId: string) {
  return admin`
    select stream, resource, to_char(data_through, 'YYYY-MM-DD') as data_through,
           time_zone, expected_from, next_expected_at, checked_at, advanced_at
    from connection_freshness where connection_id = ${connectionId}
    order by stream, resource`;
}

async function nextDueAt(connectionId: string): Promise<string> {
  const [state] = await admin`
    select next_due_at from connection_state where connection_id = ${connectionId}`;
  return (state!.next_due_at as Date).toISOString();
}

async function lastRun(connectionId: string) {
  const [run] = await admin`
    select status, error_class from sync_runs where connection_id = ${connectionId}
    order by started_at desc, finished_at desc limit 1`;
  return run;
}

const sales = (
  dataThrough: string,
  nextExpectedAt?: number,
  extra: Partial<FreshnessEntry> = {},
): FreshnessEntry => ({
  stream: "sales",
  dataThrough,
  ...(nextExpectedAt === undefined
    ? {}
    : { nextExpectedAt: iso(nextExpectedAt) }),
  ...extra,
});

describe("a succeeded run", () => {
  it("stores the freshness entries and schedules the next sync from them", async () => {
    const id = await createConnection("freshness-fixture");
    reply = {
      freshness: [
        sales("2026-11-14", START + 2 * HOUR, {
          expectedFrom: iso(START + HOUR),
        }),
        sales("2026-11-13", START + 2 * HOUR, { resource: "site-1" }),
        { stream: "reviews" },
      ],
    };
    await sync(id);
    expect(await lastRun(id)).toMatchObject({ status: "succeeded" });
    expect(await rows(id)).toEqual([
      {
        stream: "reviews",
        resource: "",
        data_through: null,
        time_zone: null,
        expected_from: null,
        next_expected_at: null,
        checked_at: new Date(START),
        advanced_at: null,
      },
      {
        stream: "sales",
        resource: "",
        data_through: "2026-11-14",
        time_zone: "America/Los_Angeles",
        expected_from: new Date(START + HOUR),
        next_expected_at: new Date(START + 2 * HOUR),
        checked_at: new Date(START),
        advanced_at: new Date(START),
      },
      expect.objectContaining({
        resource: "site-1",
        data_through: "2026-11-13",
      }),
    ]);
    // expectedFrom 10:00 + 10 min grace, not the 6 h interval.
    expect(await nextDueAt(id)).toBe(iso(START + HOUR + 10 * 60_000));
  });

  it("schedules exactly now + interval for a connector without streams", async () => {
    const id = await createConnection("demo");
    await sync(id);
    expect(await lastRun(id)).toMatchObject({ status: "succeeded" });
    expect(await rows(id)).toEqual([]);
    // The demo connector's 300 s interval, unchanged.
    expect(await nextDueAt(id)).toBe(iso(START + 300_000));
  });

  it("schedules now + interval when the streams report no expected time", async () => {
    const id = await createConnection("freshness-fixture");
    reply = { freshness: [sales("2026-11-14"), { stream: "reviews" }] };
    await sync(id);
    expect(await nextDueAt(id)).toBe(iso(START + SIX_HOURS_S * 1000));
  });

  it("keeps checking every 30 min while the provider is late, then returns to the interval", async () => {
    const id = await createConnection("freshness-fixture");
    // Expected at 08:00; at 09:00 the period is still missing.
    reply = { freshness: [sales("2026-11-14", START - HOUR)] };
    await sync(id);
    expect(await nextDueAt(id)).toBe(iso(START + 30 * 60_000));
    // A full interval late: back to the interval.
    clockMs = START + 5 * HOUR;
    await sync(id);
    expect(await nextDueAt(id)).toBe(iso(clockMs + SIX_HOURS_S * 1000));
  });

  it("never moves dataThrough back", async () => {
    const id = await createConnection("freshness-fixture");
    reply = { freshness: [sales("2026-11-14", START + 12 * HOUR)] };
    await sync(id);
    clockMs = START + HOUR;
    reply = { freshness: [sales("2026-11-12", START + 2 * HOUR)] };
    await sync(id);
    expect(await rows(id)).toEqual([
      expect.objectContaining({
        data_through: "2026-11-14",
        next_expected_at: new Date(START + 12 * HOUR),
        checked_at: new Date(START + HOUR),
        advanced_at: new Date(START),
      }),
    ]);
    // Scheduled from the stored row, not the withdrawn one.
    expect(await nextDueAt(id)).toBe(iso(START + HOUR + SIX_HOURS_S * 1000));
  });

  it("leaves the rows a partial run did not report", async () => {
    const id = await createConnection("freshness-fixture");
    reply = {
      freshness: [
        sales("2026-11-14"),
        sales("2026-11-14", undefined, { resource: "site-1" }),
        { stream: "reviews" },
      ],
    };
    await sync(id);
    clockMs = START + HOUR;
    reply = { freshness: [sales("2026-11-15")] };
    await sync(id);
    const stored = await rows(id);
    expect(
      stored.map((row) => [
        row.stream,
        row.resource,
        row.data_through,
        row.checked_at,
      ]),
    ).toEqual([
      ["reviews", "", null, new Date(START)],
      ["sales", "", "2026-11-15", new Date(START + HOUR)],
      ["sales", "site-1", "2026-11-14", new Date(START)],
    ]);
  });

  it("retires a continuous stream's resource rows its connection entry supersedes (#894)", async () => {
    const id = await createConnection("freshness-fixture");
    reply = {
      freshness: [
        sales("2026-11-14", undefined, { resource: "site-1" }),
        { stream: "reviews" },
        { stream: "reviews", resource: "site-1" },
        { stream: "reviews", resource: "site-2" },
      ],
    };
    await sync(id);
    clockMs = START + HOUR;
    // The connection entry, and one resource still reported.
    reply = {
      freshness: [
        { stream: "reviews" },
        { stream: "reviews", resource: "site-2" },
      ],
    };
    await sync(id);
    const stored = await rows(id);
    expect(
      stored.map((row) => [row.stream, row.resource, row.checked_at]),
    ).toEqual([
      ["reviews", "", new Date(START + HOUR)],
      ["reviews", "site-2", new Date(START + HOUR)],
      // A periodic row stays (a partial run).
      ["sales", "site-1", new Date(START)],
    ]);
  });

  it("schedules from selected resources only", async () => {
    const id = await createConnection("freshness-fixture");
    await admin`
      update connections set config = config || '{"resourceSelection":["site-1"]}'::jsonb
      where id = ${id}`;
    reply = {
      freshness: [
        sales("2026-11-14", START + 2 * HOUR, { resource: "site-1" }),
        sales("2026-11-14", START + HOUR, { resource: "site-2" }),
      ],
    };
    await sync(id);
    expect(await nextDueAt(id)).toBe(iso(START + 2 * HOUR + 10 * 60_000));
  });
});

describe("a skipped run (SDK 0.2.23, #898)", () => {
  it("keeps a next due time that is still ahead", async () => {
    const id = await createConnection("freshness-fixture");
    // A skipped run continues from a cursor (SDK 0.2.23).
    reply = { freshness: [{ stream: "reviews" }], nextCursor: "round-1" };
    await sync(id);
    expect(await nextDueAt(id)).toBe(iso(START + SIX_HOURS_S * 1000));
    // "Sync now" an hour later, inside the connector's floor.
    clockMs = START + HOUR;
    reply = { skipped: true };
    await sync(id);
    expect(await lastRun(id)).toMatchObject({ status: "succeeded" });
    expect(await nextDueAt(id)).toBe(iso(START + SIX_HOURS_S * 1000));
    expect(await rows(id)).toEqual([
      expect.objectContaining({
        stream: "reviews",
        checked_at: new Date(START),
      }),
    ]);
  });

  it("schedules from now when the due time has passed", async () => {
    const id = await createConnection("freshness-fixture");
    // A skipped run continues from a cursor (SDK 0.2.23).
    reply = { freshness: [{ stream: "reviews" }], nextCursor: "round-1" };
    await sync(id);
    clockMs = START + 7 * HOUR;
    reply = { skipped: true };
    await sync(id);
    expect(await nextDueAt(id)).toBe(iso(clockMs + SIX_HOURS_S * 1000));
  });
  it("is refused after a committed page of the same run (#921)", async () => {
    const id = await createConnection("freshness-fixture");
    reply = { freshness: [{ stream: "reviews" }], nextCursor: "round-1" };
    await sync(id);
    const [before] = await admin`
      select next_from from connection_state where connection_id = ${id}`;
    // Page 1 commits (done: false), then a skipped result that is valid on
    // its own: it would move nextFrom over a window nothing read.
    clockMs = START + 7 * HOUR;
    reply = { afterPage: true, skipped: true };
    await expect(sync(id)).rejects.toBeInstanceOf(NonRetryableJobError);
    expect(await lastRun(id)).toMatchObject({
      status: "failed",
      error_class: "contract",
    });
    const [after] = await admin`
      select next_from from connection_state where connection_id = ${id}`;
    expect(after!.next_from).toEqual(before!.next_from);
  });

  it("is refused when it continues a window across the page budget (#921)", async () => {
    const id = await createConnection("freshness-fixture");
    reply = { freshness: [{ stream: "reviews" }], nextCursor: "round-1" };
    await sync(id);
    const [before] = await admin`
      select next_from from connection_state where connection_id = ${id}`;
    // Page 1 commits and the page budget ends the job; its continuation
    // resumes the saved window, where a skip would read nothing of it.
    clockMs = START + 7 * HOUR;
    reply = { afterPage: true, skipped: true };
    const budget = {
      dataPolicy: { ...DEFAULT_DATA_POLICY, syncPagesPerRun: 1 },
    };
    const continued = await sync(id, budget).then(
      () => null,
      (error: unknown) => error,
    );
    expect(continued).toBeInstanceOf(ContinueJobError);
    const { continuation } = continued as ContinueJobError;
    await expect(
      sync(id, { ...budget, payload: { continuation } }),
    ).rejects.toBeInstanceOf(NonRetryableJobError);
    expect(await lastRun(id)).toMatchObject({
      status: "failed",
      error_class: "contract",
    });
    const [after] = await admin`
      select next_from from connection_state where connection_id = ${id}`;
    expect(after!.next_from).toEqual(before!.next_from);
  });
});

describe("a run whose configuration changed meanwhile (#898)", () => {
  const generations = async (connectionId: string) => {
    const [row] = await admin`
      select count(*)::int as count from data_generations g
      join data_datasets d on d.id = g.dataset_id
      where d.connection_id = ${connectionId}`;
    return row!.count as number;
  };
  const config = (id: string, checks: string[]) => admin`
    update connections set config = ${admin.json({ checks })}
    where id = ${id}`;

  it("publishes its snapshot and freshness while the configuration stays", async () => {
    const id = await createConnection(HTTP_CHECK_CONNECTOR_ID);
    await config(id, ["site", "api"]);
    await sync(id);
    expect(await lastRun(id)).toMatchObject({ status: "succeeded" });
    expect(await generations(id)).toBe(1);
    expect((await rows(id)).map((row) => row.resource)).toEqual([
      "api",
      "site",
    ]);
  });

  /**
   * Holds a lock from another transaction while the run's last connector
   * call runs (page 1 has committed), until released.
   */
  const holdDuringRun = (lock: (tx: Sql) => Promise<unknown>) => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let holder: Promise<unknown> = Promise.resolve();
    const state = { held: false };
    during = async () => {
      let held!: () => void;
      const holding = new Promise<void>((resolve) => (held = resolve));
      holder = admin.begin(async (tx) => {
        await lock(tx as unknown as Sql);
        state.held = true;
        held();
        await released;
      });
      await holding;
    };
    return {
      state,
      release: async () => {
        release();
        await holder;
      },
    };
  };
  /** The run ended in a statement timeout while the holder held its lock. */
  const expectTimedOut = (
    outcome: unknown,
    holder: { held: boolean },
  ): Error => {
    expect(holder.held).toBe(true);
    expect(outcome).toMatchObject({ failed: expect.any(Error) });
    const failed = (outcome as { failed: Error & { cause?: unknown } }).failed;
    const code =
      (failed as { code?: unknown }).code ??
      (failed.cause as { code?: unknown } | undefined)?.code;
    expect(code).toBe("57014");
    return failed;
  };
  const shortTimeout: DataPolicy = {
    ...DEFAULT_DATA_POLICY,
    queryTimeoutMs: 500,
  };
  const race = (run: Promise<unknown>) =>
    Promise.race([
      run.then(
        () => "ran",
        (error: unknown) => ({ failed: error }),
      ),
      new Promise((resolve) => setTimeout(() => resolve("waited"), 8_000)),
    ]);

  it("ends a wait for a held workspace ingestion lock in a timeout (#921)", async () => {
    const id = await createConnection(HTTP_CHECK_CONNECTOR_ID);
    await config(id, ["site"]);
    const holder = holdDuringRun(
      (tx) =>
        tx`select pg_advisory_xact_lock(hashtextextended(${workspaceId}::uuid::text, 440))`,
    );
    let outcome: unknown;
    try {
      outcome = await race(sync(id, { dataPolicy: shortTimeout }));
    } finally {
      await holder.release();
    }
    expectTimedOut(outcome, holder.state);
    expect(await lastRun(id)).toMatchObject({
      status: "failed",
      error_class: "transient",
    });
    expect(await generations(id)).toBe(0);
  });

  it("persists no configuration value when reading the saved one fails (#921)", async () => {
    const id = await createConnection(HTTP_CHECK_CONNECTOR_ID);
    const value = `https://checks.example/cb?token=CONFIG-VALUE-${randomUUID()}`;
    await config(id, [value]);
    // A change being saved holds the connection row: reading the saved
    // configuration under its share lock times out.
    const holder = holdDuringRun(
      (tx) => tx`select id from connections where id = ${id} for no key update`,
    );
    let outcome: unknown;
    try {
      outcome = await race(sync(id, { dataPolicy: shortTimeout }));
    } finally {
      await holder.release();
    }
    const failed = expectTimedOut(outcome, holder.state);
    // The worker stores the thrown message as jobs.last_error.
    expect(failed.message).not.toContain("CONFIG-VALUE");
    const [run] = await admin`
      select status, error_message from sync_runs where connection_id = ${id}
      order by started_at desc, finished_at desc limit 1`;
    expect(run).toMatchObject({ status: "failed" });
    expect(String(run!.error_message)).not.toContain("CONFIG-VALUE");
    expect(await generations(id)).toBe(0);
  });

  it("returns the timeout when recording the failure waits on the same row (#921)", async () => {
    const id = await createConnection(HTTP_CHECK_CONNECTOR_ID);
    await config(id, ["site"]);
    // FOR UPDATE also blocks the KEY SHARE that the failed run's sync_runs
    // insert needs: recording the failure is bounded too, and the worker
    // gets the original error, not an indefinite wait.
    const holder = holdDuringRun(
      (tx) => tx`select id from connections where id = ${id} for update`,
    );
    let outcome: unknown;
    try {
      outcome = await race(sync(id, { dataPolicy: shortTimeout }));
    } finally {
      await holder.release();
    }
    expectTimedOut(outcome, holder.state);
    expect(await generations(id)).toBe(0);
  });

  it("publishes neither when a change was saved during the run", async () => {
    const id = await createConnection(HTTP_CHECK_CONNECTOR_ID);
    await config(id, ["site", "api"]);
    // A PATCH removing "api": the list saved, its freshness retired.
    during = async () => {
      await config(id, ["site"]);
      await admin`
        delete from connection_freshness
        where connection_id = ${id} and resource = 'api'`;
    };
    await sync(id);
    expect(await lastRun(id)).toMatchObject({ status: "succeeded" });
    expect(await rows(id)).toEqual([]);
    expect(await generations(id)).toBe(0);
    // The next run, of the saved list, publishes both.
    during = null;
    clockMs = START + HOUR;
    await admin`update connection_state set cursor = null where connection_id = ${id}`;
    await sync(id);
    expect(await generations(id)).toBe(1);
    expect((await rows(id)).map((row) => row.resource)).toEqual(["site"]);
  });

  it("takes no workspace ingestion lock for a run of another connector", async () => {
    const id = await createConnection("freshness-fixture");
    reply = { freshness: [{ stream: "reviews" }] };
    // Another transaction holds the workspace ingestion lock (440), as a
    // retention change does: the run neither waits for it nor fails.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${workspaceId}::uuid::text, 440))`;
      held();
      await released;
    });
    await holding;
    try {
      const outcome = await Promise.race([
        sync(id).then(() => "ran"),
        new Promise((resolve) => setTimeout(() => resolve("waited"), 5_000)),
      ]);
      expect(outcome).toBe("ran");
    } finally {
      release();
      await holder;
    }
    expect(await rows(id)).toEqual([
      expect.objectContaining({ stream: "reviews" }),
    ]);
  });

  it("publishes both for a connector whose resources are not its configuration", async () => {
    const id = await createConnection("snapshot-fixture");
    await config(id, ["site", "api"]);
    during = () => config(id, ["site"]).then(() => undefined);
    await sync(id);
    expect(await generations(id)).toBe(1);
    expect((await rows(id)).map((row) => row.resource)).toEqual([
      "api",
      "site",
    ]);
  });
});

describe("a failed run", () => {
  it("writes no freshness and keeps the rows of the last success", async () => {
    const id = await createConnection("freshness-fixture");
    reply = { freshness: [sales("2026-11-14", START + 2 * HOUR)] };
    await sync(id);
    const before = await rows(id);
    const due = await nextDueAt(id);
    clockMs = START + HOUR;
    reply = new Error("provider unavailable");
    await expect(sync(id)).rejects.toThrow("provider unavailable");
    expect(await lastRun(id)).toMatchObject({
      status: "failed",
      error_class: "transient",
    });
    expect(await rows(id)).toEqual(before);
    expect(await nextDueAt(id)).toBe(due);
  });

  it("refuses an undeclared stream as a contract violation and stores nothing", async () => {
    const id = await createConnection("freshness-fixture");
    reply = {
      freshness: [sales("2026-11-14"), { stream: "traffic" }],
    };
    await expect(sync(id)).rejects.toBeInstanceOf(NonRetryableJobError);
    expect(await lastRun(id)).toMatchObject({
      status: "failed",
      error_class: "contract",
    });
    expect(await rows(id)).toEqual([]);
  });
});

describe("the connection detail", () => {
  it("lists the connector's streams with the stored rows", async () => {
    const id = await createConnection("freshness-fixture");
    reply = {
      freshness: [
        sales("2026-11-14", START - HOUR),
        sales("2026-11-13", undefined, { resource: "site-2" }),
        { stream: "reviews" },
      ],
    };
    await sync(id);
    const detail = async () =>
      connectionDetailResponseSchema.parse(
        (
          await app.inject({
            method: "GET",
            url: `/v1/workspaces/${workspaceId}/connections/${id}`,
            headers: { cookie },
          })
        ).json(),
      ).freshness;
    expect(await detail()).toEqual([
      {
        key: "sales",
        name: "Sales",
        kind: "periodic",
        period: "day",
        entries: [
          {
            resource: null,
            dataThrough: "2026-11-14",
            nextExpectedAt: iso(START - HOUR),
            checkedAt: iso(START),
            advancedAt: iso(START),
            late: true,
            overdue: false,
          },
          {
            resource: "site-2",
            dataThrough: "2026-11-13",
            nextExpectedAt: null,
            checkedAt: iso(START),
            advancedAt: iso(START),
            late: false,
            overdue: false,
          },
        ],
      },
      {
        key: "reviews",
        name: "Reviews",
        kind: "continuous",
        period: "day",
        entries: [
          {
            resource: null,
            dataThrough: null,
            nextExpectedAt: null,
            checkedAt: iso(START),
            advancedAt: null,
            late: false,
            overdue: false,
          },
        ],
      },
    ]);
    // A resource outside the selection is left out.
    await admin`
      update connections set config = config || '{"resourceSelection":["site-1"]}'::jsonb
      where id = ${id}`;
    expect((await detail())[0]!.entries.map((entry) => entry.resource)).toEqual(
      [null],
    );
  });

  it("is empty for a connector without streams", async () => {
    const id = await createConnection("demo");
    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceId}/connections/${id}`,
      headers: { cookie },
    });
    expect(
      connectionDetailResponseSchema.parse(response.json()).freshness,
    ).toEqual([]);
  });
});

describe("setIngestTimeout", () => {
  const applied = (
    roleTimeout: string,
    queryTimeoutMs: number | null,
    keepStricter: boolean,
  ) =>
    db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('statement_timeout', ${roleTimeout}, true)`,
      );
      await setIngestTimeout(tx, { queryTimeoutMs }, { keepStricter });
      const [row] = await tx.execute<{ timeout: string }>(
        sql`select current_setting('statement_timeout') as timeout`,
      );
      return row?.timeout;
    });

  it("keeps a tighter nonzero limit on lock-wait paths", async () => {
    expect(await applied("2s", 15_000, true)).toBe("2s");
    expect(await applied("2s", null, true)).toBe("2s");
    expect(await applied("0", 15_000, true)).toBe("15s");
    expect(await applied("1min", 15_000, true)).toBe("15s");
  });

  it("keeps ingestion on the policy bound", async () => {
    expect(await applied("2s", 15_000, false)).toBe("15s");
  });

  it("clamps the bound to PostgreSQL's range", async () => {
    for (const keepStricter of [false, true]) {
      const timeout = await applied("0", Number.MAX_SAFE_INTEGER, keepStricter);
      expect(timeout).toBe(
        (await applied("0", MAX_STATEMENT_TIMEOUT_MS, false)) ?? "unset",
      );
    }
  });
});
