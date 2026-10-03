import { randomBytes, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

import {
  appStoreReviewsStatusResponseSchema,
  connectionDetailResponseSchema,
  connectionResponseSchema,
  errorResponseSchema,
  workspaceListResponseSchema,
} from "@netrics/contracts";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import type { Connector, ConnectorRuntime } from "@netrics/connector-sdk";
import {
  createAppStoreConnectConnector,
  createDemoConnector,
  REVIEWS_ADMIN_MESSAGE,
  REVIEWS_KEY_MISMATCH_MESSAGE,
  REVIEWS_PAUSED_MESSAGE,
  REVIEWS_ROLE_MESSAGE,
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
import { APP_STORE_CONNECT_KEYS_URL } from "./signed-keys/app-store-analytics.js";
import { REVIEWS_PAUSED_PREFIX } from "./signed-keys/app-store-reviews.js";
import { SignedKeyProviders } from "./signed-keys/registry.js";
import {
  createFakeAsc,
  type FakeAscReview,
  type FakeAscTeam,
} from "./signed-keys/test-app-store-connect.js";
import { p256KeyPair, pemBody } from "./signed-keys/test-keys.js";
import { syncCatalog } from "./sync/catalog.js";
import { createTestDatabase } from "./test-db.js";

// Ratings and reviews with an optional second key (#190, ADR 0014 decision
// 2) through the API: a Customer Support key is checked against Apple
// before it is stored next to the Sales key in the same envelope, its own
// tokens read the reviews, and a refused reviews key pauses only the
// review metrics.

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
const KEYRING = createCredentialKeyring(ENCRYPTION_KEY);
const CONNECTOR_ID = "app-store-connect";
// 13:00 PDT on Oct 1: Sept 30 is the latest published sales day.
const NOW = Date.parse("2026-10-01T20:00:00.000Z");
const NOTES = "1000000001";
const LEDGER = "1000000002";
const ISSUER = "57246542-96fe-1a63-e053-0824d011072a";

const REPORT = [
  [
    "Provider",
    "SKU",
    "Title",
    "Product Type Identifier",
    "Units",
    "Developer Proceeds",
    "Country Code",
    "Currency of Proceeds",
    "Apple Identifier",
    "Parent Identifier",
    "Device",
  ],
  [
    "APPLE",
    "ALPHANOTES",
    "Alpha Notes",
    "1F",
    "7",
    "0",
    "US",
    "USD",
    NOTES,
    "",
    "iPhone",
  ],
]
  .map((row) => row.join("\t"))
  .join("\n");

const reviews: Record<string, FakeAscReview[]> = {
  [NOTES]: [
    {
      rating: 5,
      createdDate: "2026-10-01T09:00:00-07:00",
      territory: "USA",
      title: "Synthetic title",
      body: "Synthetic body text netrics must never store.",
      reviewerNickname: "synthetic-nickname",
    },
    { rating: 2, createdDate: "2026-09-30T22:15:00-07:00", territory: "DEU" },
    { rating: 4, createdDate: "2026-09-29T07:30:00-07:00", territory: "USA" },
  ],
};

const apps = [
  { id: NOTES, name: "Alpha Notes", bundleId: "com.alpha.notes" },
  { id: LEDGER, name: "Alpha Ledger", bundleId: "com.alpha.ledger" },
];
const base = {
  issuerId: ISSUER,
  apps,
  vendorNumbers: ["85012345"],
  reports: { "2026-09-30": REPORT },
  reviews,
};
const SALES_KEY: FakeAscTeam = {
  ...base,
  keyId: "2X9R4HXF34",
  key: p256KeyPair(),
  role: "sales",
};
const NEXT_SALES_KEY: FakeAscTeam = {
  ...base,
  keyId: "5ALE5K3Y02",
  key: p256KeyPair(),
  role: "sales",
};
const SUPPORT_KEY: FakeAscTeam = {
  ...base,
  keyId: "CS5UPP0RT1",
  key: p256KeyPair(),
  role: "customer-support",
};
const NEXT_SUPPORT_KEY: FakeAscTeam = {
  ...base,
  keyId: "CS5UPP0RT2",
  key: p256KeyPair(),
  role: "customer-support",
};
const ADMIN_KEY: FakeAscTeam = {
  ...base,
  keyId: "4DM1NK3Y01",
  key: p256KeyPair(),
  role: "admin",
};
const OTHER_TEAM_SUPPORT: FakeAscTeam = {
  issuerId: "69a6de7f-1c2d-47e3-e053-5b8c7c11a4d1",
  keyId: "0THERTEAM1",
  key: p256KeyPair(),
  apps: [{ id: "2000000001", name: "Beta", bundleId: "org.beta" }],
  vendorNumbers: ["86000001"],
  role: "customer-support",
};
const asc = createFakeAsc([
  SALES_KEY,
  NEXT_SALES_KEY,
  SUPPORT_KEY,
  NEXT_SUPPORT_KEY,
  ADMIN_KEY,
  OTHER_TEAM_SUPPORT,
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

const connectorLogs: string[] = [];

function registry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(createDemoConnector());
  registry.register(
    towardsFake(
      createAppStoreConnectConnector({
        now: () => NOW,
        analytics: false,
        log: (message) => connectorLogs.push(message),
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
      email: "asc-reviews@example.com",
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
    payload: { workspaceName: "Reviews" },
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

function reviewsKeyOf(team: FakeAscTeam) {
  return { keyId: team.keyId, privateKey: team.key.privateKeyPem };
}

const patchReviews = (reviewsKey: unknown) =>
  call("PATCH", `/connections/${connectionId}`, {
    credentials: { reviews: reviewsKey },
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

async function status() {
  const response = await call(
    "GET",
    `/connections/${connectionId}/app-store-reviews`,
  );
  expect(response.statusCode).toBe(200);
  return appStoreReviewsStatusResponseSchema.parse(response.json());
}

async function credentialEvents() {
  const rows = await admin`
    select metadata from audit_events
    where action = 'connection.credentials_updated' and target = ${connectionId}
    order by created_at, id
  `;
  return rows.map((row) => row.metadata as Record<string, unknown>);
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

async function reviewRows() {
  const rows = await admin`
    select d.key as metric_key, o.dimensions, o.value,
      to_char(o.source_timestamp at time zone 'UTC', 'YYYY-MM-DD') as day
    from observations o
    join metric_definitions d on d.id = o.metric_definition_id
    where o.connection_id = ${connectionId}
      and d.key like 'app_store_connect.review%'
    order by d.key, o.source_timestamp
  `;
  return rows.map((row) => ({
    metric: String(row.metric_key),
    dimensions: row.dimensions as Record<string, string>,
    value: Number(row.value),
    day: String(row.day),
  }));
}

/** Dimensions as text, independent of key order (jsonb reorders keys). */
function canonical(dimensions: Record<string, string>): string {
  return JSON.stringify(Object.entries(dimensions).sort());
}

function reviewRequests() {
  return asc.requests.filter((request) =>
    request.url.pathname.endsWith("/customerReviews"),
  );
}

async function connectionState() {
  const [state] = await admin`
    select auth_state, auth_reason, cursor from connection_state
    where connection_id = ${connectionId}
  `;
  return state!;
}

describe("a connection without a reviews key", () => {
  it("syncs as before: no review request, no review metric", async () => {
    expect(await status()).toEqual({
      status: "not_configured",
      keyId: null,
      message: null,
      keysUrl: APP_STORE_CONNECT_KEYS_URL,
    });
    await runSync();
    expect(reviewRequests()).toHaveLength(0);
    expect(await reviewRows()).toEqual([]);
    const state = await connectionState();
    expect(state.auth_state).toBe("ok");
    expect(String(state.cursor)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("adding a reviews key", () => {
  it.each([
    ["a Sales key (no review role)", NEXT_SALES_KEY, REVIEWS_ROLE_MESSAGE],
    ["an Admin key", ADMIN_KEY, REVIEWS_ADMIN_MESSAGE],
    ["another team's key", OTHER_TEAM_SUPPORT, REVIEWS_KEY_MISMATCH_MESSAGE],
  ])("refuses %s before anything is stored", async (_label, team, message) => {
    const before = await envelope();
    const eventsBefore = (await credentialEvents()).length;
    const response = await patchReviews(reviewsKeyOf(team));
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error).toBe(message);
    expect(await envelope()).toEqual(before);
    expect(await credentialEvents()).toHaveLength(eventsBefore);
  });

  it("refuses the connection's own key, a malformed key and unknown fields", async () => {
    const same = await patchReviews(reviewsKeyOf(SALES_KEY));
    expect(errorResponseSchema.parse(same.json()).error).toMatch(
      /must be a separate key/,
    );
    const certificate = await patchReviews({
      keyId: SUPPORT_KEY.keyId,
      privateKey:
        "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
    });
    expect(errorResponseSchema.parse(certificate.json()).error).toMatch(
      /^Private key: This is a certificate/,
    );
    const unknown = await patchReviews({
      ...reviewsKeyOf(SUPPORT_KEY),
      issuerId: ISSUER,
    });
    expect(errorResponseSchema.parse(unknown.json()).error).toMatch(
      /remove the unknown field "issuerId"/,
    );
    const notAnObject = await patchReviews("AuthKey");
    expect(notAnObject.statusCode).toBe(400);
    expect(await envelope()).toEqual(credentialsOf(SALES_KEY));
  });

  it("stores a Customer Support key next to the Sales key, audited without key material", async () => {
    const response = await patchReviews(reviewsKeyOf(SUPPORT_KEY));
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("PRIVATE KEY");
    expect(await envelope()).toEqual({
      ...credentialsOf(SALES_KEY),
      reviews: {
        keyId: SUPPORT_KEY.keyId,
        privateKey: SUPPORT_KEY.key.privateKeyPem,
      },
    });
    expect((await credentialEvents()).at(-1)).toEqual({
      connectorId: CONNECTOR_ID,
      key: "reviews",
      change: "added",
      backfillRequested: true,
    });
    // The main key's view is unchanged.
    const detail = connectionDetailResponseSchema.parse(
      (await call("GET", `/connections/${connectionId}`)).json(),
    );
    expect(detail.connection.signedKey?.fields).toEqual([
      { key: "issuerId", label: "Issuer ID", value: ISSUER },
      { key: "keyId", label: "Key ID", value: SALES_KEY.keyId },
    ]);
    expect(await status()).toEqual({
      status: "active",
      keyId: SUPPORT_KEY.keyId,
      message: null,
      keysUrl: APP_STORE_CONNECT_KEYS_URL,
    });
  });

  it("syncs reviews with the reviews key's own tokens, and never their text", async () => {
    const before = asc.requests.length;
    await runSync();
    const made = asc.requests.slice(before);
    const review = made.filter((request) =>
      request.url.pathname.endsWith("/customerReviews"),
    );
    expect(review.length).toBeGreaterThan(0);
    expect(review.every((request) => request.keyId === SUPPORT_KEY.keyId)).toBe(
      true,
    );
    expect(
      made
        .filter((request) => !request.url.pathname.endsWith("/customerReviews"))
        .every((request) => request.keyId === SALES_KEY.keyId),
    ).toBe(true);

    const rows = await reviewRows();
    const value = (
      metric: string,
      day: string,
      dimensions: Record<string, string> = { resource: NOTES },
    ) =>
      rows.find(
        (row) =>
          row.metric === `app_store_connect.${metric}` &&
          row.day === day &&
          canonical(row.dimensions) === canonical(dimensions),
      )?.value;
    expect(value("reviews", "2026-10-01")).toBe(1);
    expect(value("review_rating_sum", "2026-10-01")).toBe(5);
    // 22:15 PDT on Sept 30 is Sept 30 (Pacific Time), Oct 1 in UTC.
    expect(value("reviews", "2026-09-30")).toBe(1);
    expect(value("review_rating_sum", "2026-09-30")).toBe(2);
    expect(value("reviews", "2026-09-29")).toBe(1);
    expect(
      value("reviews_by_territory", "2026-09-30", {
        resource: NOTES,
        territory: "DE",
      }),
    ).toBe(1);
    expect(
      value("reviews_by_rating", "2026-09-29", {
        resource: NOTES,
        rating: "4",
      }),
    ).toBe(1);
    expect(value("reviews", "2026-10-01", { resource: LEDGER })).toBe(0);

    const dump =
      await admin`select row_to_json(o)::text as row from observations o`;
    const text = dump.map((row) => String(row.row)).join("\n");
    expect(text).not.toContain("Synthetic");
    expect(text).not.toContain("synthetic-nickname");
    expect((await connectionState()).auth_state).toBe("ok");
  });

  it("pauses only the review metrics when the reviews key is revoked; sales keep syncing", async () => {
    SUPPORT_KEY.revoked = true;
    try {
      await admin`delete from observations where connection_id = ${connectionId}`;
      connectorLogs.length = 0;
      await runSync();
      const state = await connectionState();
      expect(state.auth_state).toBe("ok");
      expect(state.auth_reason).toBeNull();
      const [sales] = await admin`
        select o.value from observations o
        join metric_definitions d on d.id = o.metric_definition_id
        where o.connection_id = ${connectionId}
          and d.key = 'app_store_connect.downloads'
          and o.source_timestamp = '2026-09-30T00:00:00Z'
          and o.dimensions ->> 'resource' = ${NOTES}
      `;
      expect(Number(sales!.value)).toBe(7);
      expect(await reviewRows()).toEqual([]);
      expect(
        connectorLogs.some((line) => line.startsWith(REVIEWS_PAUSED_MESSAGE)),
      ).toBe(true);
      const [run] = await admin`
        select status from sync_runs where connection_id = ${connectionId}
        order by started_at desc limit 1
      `;
      expect(run!.status).toBe("succeeded");

      const paused = await status();
      expect(paused.status).toBe("paused");
      expect(paused.keyId).toBe(SUPPORT_KEY.keyId);
      expect(paused.message).toBe(
        `${REVIEWS_PAUSED_PREFIX} ${REVIEWS_KEY_MISMATCH_MESSAGE}`,
      );

      // A paused reviews key never blocks a config change of the connection.
      const config = await call("PATCH", `/connections/${connectionId}`, {
        config: { vendorNumber: "85012345" },
      });
      expect(config.statusCode).toBe(200);
    } finally {
      SUPPORT_KEY.revoked = false;
    }
  });

  it("keeps the reviews key when the Sales key is rotated within the team", async () => {
    const rotated = await call("PATCH", `/connections/${connectionId}`, {
      credentials: credentialsOf(NEXT_SALES_KEY),
    });
    expect(rotated.statusCode).toBe(200);
    expect(await envelope()).toEqual({
      ...credentialsOf(NEXT_SALES_KEY),
      reviews: {
        keyId: SUPPORT_KEY.keyId,
        privateKey: SUPPORT_KEY.key.privateKeyPem,
      },
    });
  });

  it("replaces and removes the reviews key", async () => {
    const replaced = await patchReviews(reviewsKeyOf(NEXT_SUPPORT_KEY));
    expect(replaced.statusCode).toBe(200);
    expect((await envelope()).reviews).toEqual({
      keyId: NEXT_SUPPORT_KEY.keyId,
      privateKey: NEXT_SUPPORT_KEY.key.privateKeyPem,
    });
    expect((await status()).keyId).toBe(NEXT_SUPPORT_KEY.keyId);

    const removed = await patchReviews(null);
    expect(removed.statusCode).toBe(200);
    expect(await envelope()).toEqual(credentialsOf(NEXT_SALES_KEY));
    expect((await status()).status).toBe("not_configured");
    expect((await credentialEvents()).slice(-2)).toEqual([
      {
        connectorId: CONNECTOR_ID,
        key: "reviews",
        change: "replaced",
        backfillRequested: true,
      },
      { connectorId: CONNECTOR_ID, key: "reviews", change: "removed" },
    ]);
  });

  it("puts no reviews key material in the database, the job queue, responses or logs", async () => {
    const needles = [SUPPORT_KEY, NEXT_SUPPORT_KEY, ADMIN_KEY].flatMap(
      (team) => [
        pemBody(team.key.privateKeyPem).slice(0, 24),
        pemBody(team.key.privateKeyPem).slice(-24),
      ],
    );
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
    const text = [...dump, ...bodies, ...logs, ...connectorLogs].join("\n");
    for (const needle of needles) {
      expect(text).not.toContain(needle);
    }
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./);
  });
});
