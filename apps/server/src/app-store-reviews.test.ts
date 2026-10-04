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
// review metrics. Since #334 (ADR 0019 §11) the same pages bring the
// newest reviews' text, stored in app_reviews only while the key is there.

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
      id: "rv-1",
      rating: 5,
      createdDate: "2026-10-01T09:00:00-07:00",
      territory: "USA",
      title: "Synthetic title",
      body: "Synthetic body text that only the widget may show.",
      reviewerNickname: "synthetic-nickname",
    },
    {
      id: "rv-2",
      rating: 2,
      createdDate: "2026-09-30T22:15:00-07:00",
      territory: "DEU",
      body: "Synthetic second body.",
      reviewerNickname: "synthetic-second",
    },
    {
      id: "rv-3",
      rating: 4,
      createdDate: "2026-09-29T07:30:00-07:00",
      territory: "USA",
    },
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
// The same apps and vendor number under another issuer: a Sales key of
// another team, which drops the reviews key on rotation.
const OTHER_TEAM_SALES: FakeAscTeam = {
  ...base,
  issuerId: "1b2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6",
  keyId: "0THERSALE1",
  key: p256KeyPair(),
  role: "sales",
};
const asc = createFakeAsc([
  OTHER_TEAM_SALES,
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
    sync: async (context, request, runtime) => {
      const result = await connector.sync(context, request, rewrite(runtime));
      if (request.cursor?.startsWith("reviews:")) {
        await afterReviewsPage?.();
      }
      return result;
    },
  };
}

/** Runs after a reviews page was read, before the host stores it. */
let afterReviewsPage: (() => Promise<void>) | undefined;

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

async function storedReviews() {
  const rows = await admin`
    select provider_review_id, resource_id, rating, title, body, author,
      territory, hidden_at, workspace_id
    from app_reviews where connection_id = ${connectionId}
    order by created_at desc
  `;
  return rows.map((row) => ({ ...row }));
}

/** Review text and nicknames of the fixtures, which must stay out of sight. */
const REVIEW_TEXT = [
  "Synthetic title",
  "Synthetic body",
  "Synthetic second",
  "Synthetic edited",
  "synthetic-nickname",
  "synthetic-second",
];

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

  it("syncs reviews with the reviews key's own tokens, their text only in app_reviews", async () => {
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

    // The newest reviews with their text (ADR 0019 §11).
    expect(await storedReviews()).toEqual([
      {
        provider_review_id: "rv-1",
        resource_id: NOTES,
        rating: 5,
        title: "Synthetic title",
        body: "Synthetic body text that only the widget may show.",
        author: "synthetic-nickname",
        territory: "US",
        hidden_at: null,
        workspace_id: workspaceId,
      },
      {
        provider_review_id: "rv-2",
        resource_id: NOTES,
        rating: 2,
        title: null,
        body: "Synthetic second body.",
        author: "synthetic-second",
        territory: "DE",
        hidden_at: null,
        workspace_id: workspaceId,
      },
      {
        provider_review_id: "rv-3",
        resource_id: NOTES,
        rating: 4,
        title: null,
        body: null,
        author: null,
        territory: "US",
        hidden_at: null,
        workspace_id: workspaceId,
      },
    ]);
  });

  it("follows an edited and a deleted review on the next sync", async () => {
    const original = [...reviews[NOTES]!];
    reviews[NOTES]!.splice(0, 2, {
      ...original[0]!,
      rating: 3,
      body: "Synthetic edited body.",
    });
    try {
      await runSync();
      const stored = await storedReviews();
      expect(stored.map((row) => row.provider_review_id)).toEqual([
        "rv-1",
        "rv-3",
      ]);
      expect(stored[0]).toMatchObject({
        rating: 3,
        body: "Synthetic edited body.",
      });
    } finally {
      reviews[NOTES]!.splice(0, reviews[NOTES]!.length, ...original);
    }
    await runSync();
    expect(
      (await storedReviews()).map((row) => row.provider_review_id),
    ).toEqual(["rv-1", "rv-2", "rv-3"]);
  });

  it("hides a review for every widget, audited without its text", async () => {
    const hide = (path: string) => call("POST", `/connections/${path}/hide`);
    expect((await hide(`${connectionId}/reviews/rv-2`)).statusCode).toBe(204);
    // Hiding twice keeps the first time.
    const [first] = await storedReviews().then((rows) =>
      rows.filter((row) => row.provider_review_id === "rv-2"),
    );
    expect(first!.hidden_at).toBeInstanceOf(Date);
    expect((await hide(`${connectionId}/reviews/rv-2`)).statusCode).toBe(204);
    const [again] = await storedReviews().then((rows) =>
      rows.filter((row) => row.provider_review_id === "rv-2"),
    );
    expect(again!.hidden_at).toEqual(first!.hidden_at);
    // A sync that returns the review again keeps it hidden.
    await runSync();
    const [synced] = await storedReviews().then((rows) =>
      rows.filter((row) => row.provider_review_id === "rv-2"),
    );
    expect(synced!.hidden_at).toEqual(first!.hidden_at);

    const unknown = await hide(`${connectionId}/reviews/rv-404`);
    expect(unknown.statusCode).toBe(404);
    expect(errorResponseSchema.parse(unknown.json()).error).toBe(
      "review_not_found",
    );
    expect((await hide("not-a-uuid/reviews/rv-2")).statusCode).toBe(404);

    const [event] = await admin`
      select target, metadata from audit_events
      where action = 'review.hidden' order by created_at limit 1
    `;
    expect(event!.target).toBe(connectionId);
    expect(event!.metadata).toEqual({ resource: NOTES, reviewId: "rv-2" });

    // Another workspace of the same user cannot hide this connection's
    // reviews: the connection is not found there.
    const other = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { cookie },
      payload: { name: "Other" },
    });
    expect(other.statusCode).toBe(200);
    const otherId = (other.json() as { workspace: { id: string } }).workspace
      .id;
    const cross = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${otherId}/connections/${connectionId}/reviews/rv-1/hide`,
      headers: { cookie },
    });
    expect(cross.statusCode).toBe(404);
    const [rv1] = await storedReviews();
    expect(rv1!.hidden_at).toBeNull();
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
      // A paused key is still configured: the stored text stays.
      expect(await storedReviews()).toHaveLength(3);

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
    expect(await storedReviews()).toHaveLength(3);
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

    expect(await storedReviews()).toHaveLength(3);

    const removed = await patchReviews(null);
    expect(removed.statusCode).toBe(200);
    expect(await envelope()).toEqual(credentialsOf(NEXT_SALES_KEY));
    expect((await status()).status).toBe("not_configured");
    // Removing the key deletes the stored review text in the same commit.
    expect(await storedReviews()).toEqual([]);
    expect((await credentialEvents()).slice(-2)).toEqual([
      {
        connectorId: CONNECTOR_ID,
        key: "reviews",
        change: "replaced",
        backfillRequested: true,
      },
      {
        connectorId: CONNECTOR_ID,
        key: "reviews",
        change: "removed",
        reviewTextDeleted: 3,
      },
    ]);
    // Without the key, a sync stores no text.
    await runSync();
    expect(await storedReviews()).toEqual([]);
  });

  it("stores no text read with a reviews key removed during the sync", async () => {
    expect((await patchReviews(reviewsKeyOf(SUPPORT_KEY))).statusCode).toBe(
      200,
    );
    afterReviewsPage = async () => {
      afterReviewsPage = undefined;
      expect((await patchReviews(null)).statusCode).toBe(200);
    };
    try {
      await runSync();
    } finally {
      afterReviewsPage = undefined;
    }
    expect((await envelope()).reviews).toBeUndefined();
    expect(await storedReviews()).toEqual([]);
  });

  it("deletes the review text when a main key of another team drops the reviews key", async () => {
    expect((await patchReviews(reviewsKeyOf(SUPPORT_KEY))).statusCode).toBe(
      200,
    );
    await runSync();
    expect(await storedReviews()).toHaveLength(3);
    const rotated = await call("PATCH", `/connections/${connectionId}`, {
      credentials: credentialsOf(OTHER_TEAM_SALES),
    });
    expect(rotated.statusCode).toBe(200);
    expect((await envelope()).reviews).toBeUndefined();
    expect(await storedReviews()).toEqual([]);
    expect((await credentialEvents()).at(-1)).toEqual({
      connectorId: CONNECTOR_ID,
      reviewTextDeleted: 3,
    });
  });

  it("puts no review text in any other table, response or log line", async () => {
    const tables = await admin`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
        and table_name <> 'app_reviews'
    `;
    const dump: string[] = [];
    for (const { table_name: table } of tables) {
      const rows = await admin.unsafe(
        `select row_to_json(t)::text as row from "${String(table)}" t`,
      );
      dump.push(...rows.map((row) => String(row.row)));
    }
    const text = [...dump, ...bodies, ...logs, ...connectorLogs].join("\n");
    for (const needle of REVIEW_TEXT) {
      expect(text).not.toContain(needle);
    }
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
