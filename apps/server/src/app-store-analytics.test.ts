import { randomBytes, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20_000 });

import {
  appStoreAnalyticsStatusResponseSchema,
  connectionDetailResponseSchema,
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
  ADMIN_KEY_REFUSED_MESSAGE,
  ADMIN_ROLE_REQUIRED,
  APP_STORE_CONNECT_KEYS_URL,
  REVIEWS_KEY_CANNOT_REQUEST,
  SALES_KEY_CANNOT_REQUEST,
} from "./signed-keys/app-store-analytics.js";
import { RATE_LIMITED_MESSAGE } from "./signed-keys/providers/app-store-connect.js";
import { SignedKeyProviders } from "./signed-keys/registry.js";
import {
  createFakeAsc,
  FAKE_SEGMENT_HOST,
  type FakeAscAnalytics,
  type FakeAscTeam,
} from "./signed-keys/test-app-store-connect.js";
import { p256KeyPair, pemBody } from "./signed-keys/test-keys.js";
import { syncCatalog } from "./sync/catalog.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

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
        // Discovery is a day ahead of downloads (#771): analytics are
        // complete only through the older of the two, Sept 29.
        {
          processingDate: "2026-09-30",
          content: [
            DISCOVERY_HEADER,
            `2026-09-30\tAlpha Notes\t${NOTES}\tImpression\tNo page\tApp Store search\t\tiPhone\tiOS 26.0\tUS\t810\t710`,
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
// #715: keys owners upload to the analytics form by mistake.
const SECOND_SALES_KEY: FakeAscTeam = {
  ...SALES_KEY,
  keyId: "5ALES2KEY2",
  key: p256KeyPair(),
};
const SUPPORT_KEY: FakeAscTeam = {
  ...SALES_KEY,
  keyId: "CS5UPP0RT1",
  key: p256KeyPair(),
  role: "customer-support",
  reviews: {},
};
const SECOND_SUPPORT_KEY: FakeAscTeam = {
  ...SUPPORT_KEY,
  keyId: "CS5UPP0RT2",
  key: p256KeyPair(),
};
const OTHER_TEAM_SUPPORT: FakeAscTeam = {
  ...OTHER_TEAM_ADMIN,
  keyId: "0THERCS001",
  key: p256KeyPair(),
  role: "customer-support",
  reviews: {},
};
// Apple refuses this one even the listing of analytics report requests.
const LISTING_REFUSED_SUPPORT_KEY: FakeAscTeam = {
  ...SUPPORT_KEY,
  keyId: "CS5UPP0RT3",
  key: p256KeyPair(),
  analyticsListingForbidden: true,
};
// Its reviews answer 429: the offer's checks are rate-limited.
const RATE_LIMITED_SUPPORT_KEY: FakeAscTeam = {
  ...SUPPORT_KEY,
  keyId: "CS5UPP0RT4",
  key: p256KeyPair(),
  reviewsRateLimited: true,
};
const asc = createFakeAsc([
  SALES_KEY,
  ADMIN_KEY,
  OTHER_TEAM_ADMIN,
  SECOND_SALES_KEY,
  SUPPORT_KEY,
  SECOND_SUPPORT_KEY,
  OTHER_TEAM_SUPPORT,
  LISTING_REFUSED_SUPPORT_KEY,
  RATE_LIMITED_SUPPORT_KEY,
]);

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
      createAppStoreConnectConnector({
        ratings: false,
        rawSales: false,
        now: () => NOW,
        log: () => {},
      }),
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
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin?.end({ timeout: 5 }).catch(() => undefined);
});

async function call(
  method: "GET" | "POST" | "PATCH",
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
    // #715: the stored Sales key is named as such; another key without
    // the Admin role (and no review access) is not taken for it.
    const sales = await enable(SALES_KEY);
    expect(sales.statusCode).toBe(400);
    expect(errorResponseSchema.parse(sales.json()).error).toBe(
      SALES_KEY_CANNOT_REQUEST,
    );
    const otherSales = await enable(SECOND_SALES_KEY);
    expect(otherSales.statusCode).toBe(400);
    expect(errorResponseSchema.parse(otherSales.json()).error).toBe(
      ADMIN_ROLE_REQUIRED,
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
    // One "through" date on the page (#771): the status card's day is the
    // data status's, not the newest stored point (Sept 30, discovery only).
    const detail = connectionDetailResponseSchema.parse(
      (await call("GET", `/connections/${connectionId}`)).json(),
    );
    expect(
      detail.freshness
        .find((stream) => stream.key === "analytics")!
        .entries.map((entry) => [entry.resource, entry.dataThrough]),
    ).toEqual([[NOTES, "2026-09-29"]]);
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

// #715: owners setting up the optional reviews key upload it to "Enable
// App Store analytics" by mistake. A key of this team that is not Admin
// and reads reviews (the reviews key's own checks) is offered as the
// reviews key; nothing is requested or stored until the browser sends it
// with the usual reviews key update.
describe("A Customer Support key in the analytics form", () => {
  // The form is offered while an app needs enabling: Apple stopped the
  // request of Alpha Ledger.
  beforeAll(() => {
    analytics.requests[LEDGER]![0]!.stopped = true;
  });
  afterAll(() => {
    analytics.requests[LEDGER]![0]!.stopped = false;
  });

  async function envelope(): Promise<Record<string, unknown>> {
    const [row] = await admin`
      select credentials_encrypted from connections where id = ${connectionId}
    `;
    return JSON.parse(
      decryptCredentials(
        (row!.credentials_encrypted as Buffer).toString("utf8"),
        KEYRING,
        { workspaceId, connectionId },
      ),
    ) as Record<string, unknown>;
  }

  async function auditCount(action: string): Promise<number> {
    const [row] = await admin`
      select count(*)::int as count from audit_events where action = ${action}
    `;
    return row!.count as number;
  }

  const reviewsOf = (team: FakeAscTeam) => ({
    reviews: { keyId: team.keyId, privateKey: team.key.privateKeyPem },
  });

  it("offers it as the reviews key, requesting and storing nothing", async () => {
    const before = analytics.requests[LEDGER]!.length;
    const enabled = await auditCount("connection.analytics_enabled");
    const response = await enable(SUPPORT_KEY);
    expect(response.statusCode).toBe(200);
    expect(
      enableAppStoreAnalyticsResponseSchema.parse(response.json()),
    ).toEqual({
      apps: [],
      keysUrl: APP_STORE_CONNECT_KEYS_URL,
      reviewsKeyOffer: { keyId: SUPPORT_KEY.keyId, replacesKeyId: null },
    });
    // Apple refused its request (403): nothing was requested.
    expect(analytics.requests[LEDGER]).toHaveLength(before);
    // Checked like the reviews key form checks it: reviews, then sales.
    const checked = asc.requests
      .filter((request) => request.keyId === SUPPORT_KEY.keyId)
      .map((request) => request.url.pathname);
    expect(checked).toContain(`/v1/apps/${NOTES}/customerReviews`);
    expect(checked).toContain("/v1/salesReports");
    expect(await envelope()).toEqual(credentialsOf(SALES_KEY));
    expect(await auditCount("connection.analytics_enabled")).toBe(enabled);
    expect(await auditCount("connection.credentials_updated")).toBe(0);
  });

  it("stores the offered key with the reviews key update sent on confirm", async () => {
    const stored = await call("PATCH", `/connections/${connectionId}`, {
      credentials: reviewsOf(SUPPORT_KEY),
    });
    expect(stored.statusCode).toBe(200);
    expect((await envelope()).reviews).toEqual({
      keyId: SUPPORT_KEY.keyId,
      privateKey: SUPPORT_KEY.key.privateKeyPem,
    });
    const [audit] = await admin`
      select metadata from audit_events
      where action = 'connection.credentials_updated'
    `;
    expect(audit!.metadata).toMatchObject({ key: "reviews", change: "added" });
  });

  it("names the reviews key the connection stores, and offers another one as its replacement", async () => {
    const same = await enable(SUPPORT_KEY);
    expect(same.statusCode).toBe(400);
    expect(errorResponseSchema.parse(same.json()).error).toBe(
      REVIEWS_KEY_CANNOT_REQUEST,
    );

    const second = await enable(SECOND_SUPPORT_KEY);
    expect(second.statusCode).toBe(200);
    expect(
      enableAppStoreAnalyticsResponseSchema.parse(second.json())
        .reviewsKeyOffer,
    ).toEqual({
      keyId: SECOND_SUPPORT_KEY.keyId,
      replacesKeyId: SUPPORT_KEY.keyId,
    });
    // Still the first reviews key until the replacement is sent.
    expect((await envelope()).reviews).toMatchObject({
      keyId: SUPPORT_KEY.keyId,
    });
  });

  it("offers no key of another team", async () => {
    const other = await enable(OTHER_TEAM_SUPPORT);
    expect(other.statusCode).toBe(400);
    expect(errorResponseSchema.parse(other.json()).error).toBe(
      `This key belongs to another App Store Connect team. Use an Admin key of the team with issuer ID ${ISSUER}.`,
    );
    // Its key under this team's issuer ID: Apple refuses it outright.
    const forged = await enable(OTHER_TEAM_SUPPORT, {
      ...credentialsOf(OTHER_TEAM_SUPPORT),
      issuerId: ISSUER,
    });
    expect(forged.statusCode).toBe(400);
    expect(errorResponseSchema.parse(forged.json()).error).toBe(
      ADMIN_KEY_REFUSED_MESSAGE,
    );
    expect((await envelope()).reviews).toMatchObject({
      keyId: SUPPORT_KEY.keyId,
    });
  });

  it("still offers the key when Apple refuses it the listing of report requests", async () => {
    const response = await enable(LISTING_REFUSED_SUPPORT_KEY);
    expect(response.statusCode).toBe(200);
    expect(
      enableAppStoreAnalyticsResponseSchema.parse(response.json())
        .reviewsKeyOffer,
    ).toEqual({
      keyId: LISTING_REFUSED_SUPPORT_KEY.keyId,
      replacesKeyId: SUPPORT_KEY.keyId,
    });
    // Refused at the listing: no request was even attempted.
    expect(
      asc.requests.filter(
        (request) =>
          request.keyId === LISTING_REFUSED_SUPPORT_KEY.keyId &&
          request.method === "POST",
      ),
    ).toEqual([]);
  });

  it("answers a rate limit during the offer's checks with try again, not with the Admin role", async () => {
    const response = await enable(RATE_LIMITED_SUPPORT_KEY);
    expect(response.statusCode).toBe(400);
    // The App Store Connect key checks' own rate-limit message.
    expect(errorResponseSchema.parse(response.json()).error).toBe(
      RATE_LIMITED_MESSAGE,
    );
    expect((await envelope()).reviews).toMatchObject({
      keyId: SUPPORT_KEY.keyId,
    });
  });

  it("puts no key material of the offered keys in responses or logs", () => {
    const text = [...bodies, ...logs].join("\n");
    for (const team of [
      SUPPORT_KEY,
      SECOND_SUPPORT_KEY,
      OTHER_TEAM_SUPPORT,
      LISTING_REFUSED_SUPPORT_KEY,
      RATE_LIMITED_SUPPORT_KEY,
    ]) {
      const body = pemBody(team.key.privateKeyPem);
      expect(text).not.toContain(body.slice(0, 24));
      expect(text).not.toContain(body.slice(-24));
    }
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./);
  });
});
