import { randomBytes, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
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
import type {
  Connector,
  ConnectorManifest,
  FreshnessEntry,
} from "@netrics/connector-sdk";
import { createDemoConnector, demoManifest } from "@netrics/connectors";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "../app.js";
import { createAuthService } from "../auth/index.js";
import { createCredentialKeyring } from "../credentials.js";
import { loadConfig } from "../env.js";
import { createJobHandlers, NonRetryableJobError } from "../jobs/handlers.js";
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
let reply: { freshness?: FreshnessEntry[] } | Error = {};

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
    async sync() {
      if (reply instanceof Error) throw reply;
      return { observations: [], ...reply, done: true };
    },
  };
}

function registry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(createDemoConnector());
  registry.register(fixture());
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
});

async function sync(connectionId: string) {
  const handlers = createJobHandlers({
    registry: registry(),
    credentialKeyring: KEYRING,
    now: () => new Date(clockMs),
  });
  return handlers["connection.sync"]!({
    job: {
      id: randomUUID(),
      kind: "connection.sync",
      workspaceId,
      connectionId,
      payload: {},
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
