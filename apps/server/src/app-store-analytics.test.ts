import { randomBytes, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20_000 });

import {
  appStoreAnalyticsStatusResponseSchema,
  connectionResponseSchema,
  enableAppStoreAnalyticsResponseSchema,
  errorResponseSchema,
  workspaceListResponseSchema,
} from "@netrics/contracts";
import { ConnectorRegistry, hostAllowed } from "@netrics/connector-runtime";
import type { Connector, ConnectorRuntime } from "@netrics/connector-sdk";
import {
  ANALYTICS_SEGMENT_HOSTS,
  appStoreConnectManifest,
  createAppStoreConnectConnector,
  createDemoConnector,
} from "@netrics/connectors";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { createCredentialKeyring, decryptCredentials } from "./credentials.js";
import { loadConfig } from "./env.js";
import { createJobHandlers } from "./jobs/handlers.js";
import { capturingLogger } from "./oauth/test-provider.js";
import {
  ADMIN_ROLE_MESSAGE,
  APP_STORE_CONNECT_KEYS_URL,
} from "./signed-keys/app-store-analytics.js";
import { SignedKeyProviders } from "./signed-keys/registry.js";
import {
  createFakeAsc,
  FAKE_SEGMENT_HOST,
  type FakeAscAnalytics,
  type FakeAscTeam,
} from "./signed-keys/test-app-store-connect.js";
import { p256KeyPair, pemBody } from "./signed-keys/test-keys.js";
import { syncCatalog } from "./sync/catalog.js";
import { createTestDatabase } from "./test-db.js";

// "Enable App Store analytics" (#174, ADR 0014) through the API: a
// temporary Admin key creates the missing ONGOING report requests in
// memory and is never stored, enqueued or logged; the connection's Sales
// key reads the status and syncs the reports.

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
const KEYRING = createCredentialKeyring(ENCRYPTION_KEY);
const CONNECTOR_ID = "app-store-connect";
// 13:00 PDT on Oct 1: analytics instances processed from Sept 24 are read.
const NOW = Date.parse("2026-10-01T20:00:00.000Z");
const NOTES = "1000000001";
const LEDGER = "1000000002";

const DISCOVERY_HEADER =
  "Date\tApp Name\tApp Apple Identifier\tEvent\tPage Type\tSource Type\tEngagement Type\tDevice\tPlatform Version\tTerritory\tCounts\tUnique Counts";
const DOWNLOADS_HEADER =
  "Date\tApp Name\tApp Apple Identifier\tDownload Type\tApp Version\tDevice\tPlatform Version\tSource Type\tPage Type\tPre-Order\tTerritory\tCounts";

const analytics: FakeAscAnalytics = {
  // Alpha Notes was requested before (by hand or another tool).
  requests: { [NOTES]: [{ id: "req-notes" }] },
  instances: {
    [NOTES]: {
      discovery: [
        {
          processingDate: "2026-09-29",
          content: [
            DISCOVERY_HEADER,
            `2026-09-29\tAlpha Notes\t${NOTES}\tImpression\tNo page\tApp Store search\t\tiPhone\tiOS 26.0\tUS\t800\t700`,
            `2026-09-29\tAlpha Notes\t${NOTES}\tPage view\tProduct page\tApp Store search\t\tiPhone\tiOS 26.0\tUS\t90\t80`,
          ].join("\n"),
        },
      ],
      downloads: [
        {
          processingDate: "2026-09-29",
          content: [
            DOWNLOADS_HEADER,
            `2026-09-29\tAlpha Notes\t${NOTES}\tFirst-time download\t1.0\tiPhone\tiOS 26.0\tApp Store search\tProduct page\tNo\tUS\t12`,
          ].join("\n"),
        },
      ],
    },
  },
};

const apps = [
  { id: NOTES, name: "Alpha Notes", bundleId: "com.alpha.notes" },
  { id: LEDGER, name: "Alpha Ledger", bundleId: "com.alpha.ledger" },
];
const ISSUER = "57246542-96fe-1a63-e053-0824d011072a";
const SALES_KEY: FakeAscTeam = {
  issuerId: ISSUER,
  keyId: "2X9R4HXF34",
  key: p256KeyPair(),
  apps,
  vendorNumbers: ["85012345"],
  role: "sales",
  analytics,
};
const ADMIN_KEY: FakeAscTeam = {
  ...SALES_KEY,
  keyId: "4DM1NK3Y01",
  key: p256KeyPair(),
  role: "admin",
};
const OTHER_TEAM_ADMIN: FakeAscTeam = {
  issuerId: "69a6de7f-1c2d-47e3-e053-5b8c7c11a4d1",
  keyId: "0THERTEAM1",
  key: p256KeyPair(),
  apps: [{ id: "2000000001", name: "Beta", bundleId: "org.beta" }],
  vendorNumbers: ["86000001"],
  role: "admin",
  analytics: { requests: {} },
};
const asc = createFakeAsc([SALES_KEY, ADMIN_KEY, OTHER_TEAM_ADMIN]);

function towardsFake(connector: Connector): Connector {
  const rewrite = (runtime: ConnectorRuntime): ConnectorRuntime => ({
    signal: runtime.signal,
    fetch: (url, init) => asc.fetch(url, init),
  });
  return {
    manifest: connector.manifest,
    check: (context, runtime) => connector.check(context, rewrite(runtime)),
    discover: (context, runtime) =>
      connector.discover(context, rewrite(runtime)),
    sync: (context, request, runtime) =>
      connector.sync(context, request, rewrite(runtime)),
  };
}

function registry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(createDemoConnector());
  registry.register(
    towardsFake(
      createAppStoreConnectConnector({ now: () => NOW, log: () => {} }),
    ),
  );
  return registry;
}

const signedKeys = new SignedKeyProviders({
  http: () => (url, init) => asc.fetch(url, init),
});

let app: FastifyInstance;
let db: Database;
let admin: Sql;
let cookie: string;
let workspaceId: string;
let connectionId: string;
const logs: string[] = [];
const bodies: string[] = [];

beforeAll(async () => {
  const testDb = await createTestDatabase();
  const owner = createDatabase(testDb.adminUrl, { max: 1 });
  await syncCatalog(owner, registry());
  await owner.$client.end({ timeout: 5 });
  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "debug",
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
    signedKeys,
    checkDb: async () => true,
    logger: capturingLogger(logs),
  });
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });

  const signUp = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: {
      name: "Owner",
      email: "asc-analytics@example.com",
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
    payload: { workspaceName: "Analytics" },
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

  const created = await call("POST", "/connections", {
    connectorId: CONNECTOR_ID,
    name: "Alpha",
    config: { vendorNumber: "85012345" },
    credentials: credentialsOf(SALES_KEY),
    resources: [NOTES, LEDGER],
  });
  expect(created.statusCode).toBe(200);
  connectionId = connectionResponseSchema.parse(created.json()).connection.id;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin?.end({ timeout: 5 }).catch(() => undefined);
});

async function call(
  method: "GET" | "POST",
  path: string,
  payload?: Record<string, unknown>,
) {
  const response = await app.inject({
    method,
    url: `/v1/workspaces/${workspaceId}${path}`,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });
  bodies.push(response.body);
  return response;
}

function credentialsOf(team: FakeAscTeam) {
  return {
    issuerId: team.issuerId,
    keyId: team.keyId,
    privateKey: team.key.privateKeyPem,
  };
}

const enable = (team: FakeAscTeam, credentials = credentialsOf(team)) =>
  call("POST", `/connections/${connectionId}/app-store-analytics`, {
    credentials,
  });

async function status() {
  const response = await call(
    "GET",
    `/connections/${connectionId}/app-store-analytics`,
  );
  expect(response.statusCode).toBe(200);
  return appStoreAnalyticsStatusResponseSchema.parse(response.json());
}

function posts(): number {
  return asc.requests.filter(
    (request) =>
      request.method === "POST" &&
      request.url.pathname === "/v1/analyticsReportRequests",
  ).length;
}

async function runSync() {
  const handlers = createJobHandlers({
    registry: registry(),
    credentialKeyring: KEYRING,
    signedKeys,
    now: () => new Date(NOW),
  });
  await handlers["connection.sync"]!({
    job: {
      id: randomUUID(),
      kind: "connection.sync",
      workspaceId,
      connectionId,
      payload: {},
      runAt: new Date(),
      attempts: 0,
      maxAttempts: 8,
      status: "running",
      lockedBy: "test",
      lockedAt: new Date(),
      lastError: null,
      idempotencyKey: null,
      createdAt: new Date(),
    },
    appDb: db,
    schedulerDb: db,
    logger: capturingLogger(logs),
  });
}

describe("App Store analytics", () => {
  it("shows per app whether analytics are requested, with the stored Sales key", async () => {
    expect(await status()).toEqual({
      apps: [
        {
          appId: NOTES,
          name: "Alpha Notes",
          status: "requested",
          latestDay: null,
          message: null,
        },
        {
          appId: LEDGER,
          name: "Alpha Ledger",
          status: "not_enabled",
          latestDay: null,
          message: null,
        },
      ],
      keysUrl: APP_STORE_CONNECT_KEYS_URL,
    });
  });

  it("refuses a key without the Admin role, another team's key and a malformed key, creating nothing", async () => {
    const sales = await enable(SALES_KEY);
    expect(sales.statusCode).toBe(400);
    expect(errorResponseSchema.parse(sales.json()).error).toBe(
      ADMIN_ROLE_MESSAGE,
    );

    const other = await enable(OTHER_TEAM_ADMIN);
    expect(other.statusCode).toBe(400);
    expect(errorResponseSchema.parse(other.json()).error).toBe(
      `This key belongs to another App Store Connect team. Use an Admin key of the team with issuer ID ${ISSUER}.`,
    );

    const malformed = await enable(ADMIN_KEY, {
      ...credentialsOf(ADMIN_KEY),
      privateKey:
        "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
    });
    expect(malformed.statusCode).toBe(400);
    expect(errorResponseSchema.parse(malformed.json()).error).toMatch(
      /^Private key: This is a certificate/,
    );
    expect(analytics.requests[LEDGER]).toBeUndefined();
    const [audit] = await admin`
      select count(*)::int as count from audit_events
      where action = 'connection.analytics_enabled'
    `;
    expect(audit!.count).toBe(0);
  });

  it("creates only the missing request with a temporary Admin key, and again creates nothing", async () => {
    const before = posts();
    const first = await enable(ADMIN_KEY);
    expect(first.statusCode).toBe(200);
    expect(enableAppStoreAnalyticsResponseSchema.parse(first.json())).toEqual({
      apps: [
        {
          appId: NOTES,
          name: "Alpha Notes",
          outcome: "existing",
          message: null,
        },
        {
          appId: LEDGER,
          name: "Alpha Ledger",
          outcome: "created",
          message: null,
        },
      ],
      keysUrl: APP_STORE_CONNECT_KEYS_URL,
    });
    expect(posts()).toBe(before + 1);
    expect(analytics.requests[LEDGER]).toHaveLength(1);

    const again = await enable(ADMIN_KEY);
    expect(
      enableAppStoreAnalyticsResponseSchema
        .parse(again.json())
        .apps.map((entry) => entry.outcome),
    ).toEqual(["existing", "existing"]);
    expect(posts()).toBe(before + 1);

    const events = await admin`
      select actor_user_id is not null as has_actor, target, metadata
      from audit_events
      where action = 'connection.analytics_enabled'
      order by created_at
    `;
    expect(events.map((event) => event.metadata)).toEqual([
      {
        connectorId: CONNECTOR_ID,
        created: [LEDGER],
        existing: [NOTES],
        failed: [],
      },
      {
        connectorId: CONNECTOR_ID,
        created: [],
        existing: [NOTES, LEDGER],
        failed: [],
      },
    ]);
    expect(events.every((event) => event.target === connectionId)).toBe(true);
  });

  it("never stores the Admin key: the envelope still holds the Sales key", async () => {
    const [row] = await admin`
      select credentials_encrypted from connections where id = ${connectionId}
    `;
    expect(
      JSON.parse(
        decryptCredentials(
          (row!.credentials_encrypted as Buffer).toString("utf8"),
          KEYRING,
          { workspaceId, connectionId },
        ),
      ),
    ).toEqual(credentialsOf(SALES_KEY));
  });

  it("syncs impressions, product page views and downloads by source with the Sales key", async () => {
    await runSync();
    const rows = await admin`
      select d.key as metric_key, o.dimensions, o.value
      from observations o
      join metric_definitions d on d.id = o.metric_definition_id
      where o.connection_id = ${connectionId}
        and o.source_timestamp = '2026-09-29T00:00:00Z'
        and d.key in (
          'app_store_connect.impressions',
          'app_store_connect.product_page_views',
          'app_store_connect.store_downloads'
        )
      order by d.key
    `;
    expect(
      rows.map((row) => [row.metric_key, row.dimensions, row.value]),
    ).toEqual([
      ["app_store_connect.impressions", { resource: NOTES }, 800],
      ["app_store_connect.product_page_views", { resource: NOTES }, 90],
      [
        "app_store_connect.store_downloads",
        { resource: NOTES, source: "App Store search" },
        12,
      ],
    ]);
    // Segments were fetched from the pinned bucket host, without a token.
    const downloads = asc.requests.filter(
      (request) => request.url.hostname === FAKE_SEGMENT_HOST,
    );
    expect(downloads.length).toBeGreaterThan(0);
    expect(
      downloads.every((request) => request.authorization === undefined),
    ).toBe(true);
    const [state] = await admin`
      select auth_state, cursor from connection_state
      where connection_id = ${connectionId}
    `;
    expect(state!.auth_state).toBe("ok");
    // The run ends with the sales cursor, not an analytics one.
    expect(String(state!.cursor)).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const after = await status();
    expect(
      after.apps.map((entry) => [entry.appId, entry.status, entry.latestDay]),
    ).toEqual([
      [NOTES, "available", "2026-09-29"],
      [LEDGER, "requested", null],
    ]);
  });

  it("shows a stopped request as paused", async () => {
    analytics.requests[LEDGER]![0]!.stopped = true;
    try {
      expect((await status()).apps[1]).toMatchObject({
        appId: LEDGER,
        status: "stopped",
      });
    } finally {
      analytics.requests[LEDGER]![0]!.stopped = false;
    }
  });

  it("puts no Admin key material in the database, the job queue, responses or logs", async () => {
    const needles = [
      pemBody(ADMIN_KEY.key.privateKeyPem).slice(0, 24),
      pemBody(ADMIN_KEY.key.privateKeyPem).slice(-24),
    ];
    const tables = await admin`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
    `;
    const dump: string[] = [];
    for (const { table_name: table } of tables) {
      const rows = await admin.unsafe(
        `select row_to_json(t)::text as row from "${String(table)}" t`,
      );
      dump.push(...rows.map((row) => String(row.row)));
    }
    const jobs = await admin`select payload::text as payload from jobs`;
    expect(jobs.length).toBeGreaterThan(0);
    const text = [...dump, ...bodies, ...logs].join("\n");
    for (const needle of needles) {
      expect(text).not.toContain(needle);
    }
    expect(text).not.toContain("PRIVATE KEY");
    // No signed token (any ES256 JWT) anywhere either.
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./);
    // The audit events name apps, never the temporary key.
    expect(text).not.toContain(ADMIN_KEY.keyId);
  });

  it("pins the segment host exactly in the egress allowlist", () => {
    const allowed = appStoreConnectManifest.outboundDomains;
    expect(ANALYTICS_SEGMENT_HOSTS).toEqual([FAKE_SEGMENT_HOST]);
    expect(hostAllowed(FAKE_SEGMENT_HOST, allowed)).toBe(true);
    for (const host of [
      "asp-qa-us-west-2.s3.us-west-2.amazonaws.com",
      "other.s3.us-west-2.amazonaws.com",
      "s3.us-west-2.amazonaws.com",
      "evil.asp-us-west-2.s3.us-west-2.amazonaws.com",
      "amazonaws.com",
    ]) {
      expect(hostAllowed(host, allowed)).toBe(false);
    }
  });
});
