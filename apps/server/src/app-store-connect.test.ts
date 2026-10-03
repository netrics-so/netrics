import { randomBytes, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20_000 });

import {
  connectionListResponseSchema,
  connectionResourcesResponseSchema,
  connectionResponseSchema,
  errorResponseSchema,
  workspaceListResponseSchema,
} from "@netrics/contracts";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import type { Connector, ConnectorRuntime } from "@netrics/connector-sdk";
import {
  createAppStoreConnectConnector,
  createDemoConnector,
  vendorNumberMessage,
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
import { SignedKeyProviders } from "./signed-keys/registry.js";
import {
  createFakeAsc,
  type FakeAscTeam,
} from "./signed-keys/test-app-store-connect.js";
import { p256KeyPair, pemBody } from "./signed-keys/test-keys.js";
import { syncCatalog } from "./sync/catalog.js";
import { createTestDatabase } from "./test-db.js";

// The App Store Connect connector in the API (#171): one connection holds
// one team key and one vendor number, and connections of different teams
// coexist in one workspace, each discovering its own team's apps with
// tokens signed by its own key. The real connector and the real provider
// probes run against an in-memory App Store Connect that verifies the
// signatures.

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
const KEYRING = createCredentialKeyring(ENCRYPTION_KEY);
const CONNECTOR_ID = "app-store-connect";

// 13:00 PDT on Oct 1: Sept 30 is the latest published reporting day.
const NOW = Date.parse("2026-10-01T20:00:00.000Z");

const REPORT_HEADER = [
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
];

/** A daily sales report of Alpha Notes: downloads and two currencies. */
function alphaReport(downloads: number): string {
  return [
    REPORT_HEADER,
    [
      "APPLE",
      "ALPHANOTES",
      "Alpha Notes",
      "1F",
      String(downloads),
      "0",
      "US",
      "USD",
      "1000000001",
      "",
      "iPhone",
    ],
    [
      "APPLE",
      "ALPHANOTES.PRO",
      "pro",
      "IA1",
      "2",
      "0.70",
      "US",
      "USD",
      "1100000001",
      "ALPHANOTES",
      "iPhone",
    ],
    [
      "APPLE",
      "ALPHANOTES.PRO",
      "pro",
      "IA1",
      "1",
      "84",
      "JP",
      "JPY",
      "1100000001",
      "ALPHANOTES",
      "iPad",
    ],
    // Alpha Ledger is not selected.
    [
      "APPLE",
      "ALPHALEDGER",
      "Alpha Ledger",
      "1F",
      "7",
      "0",
      "US",
      "USD",
      "1000000002",
      "",
      "iPhone",
    ],
  ]
    .map((row) => row.join("\t"))
    .join("\n");
}

const TEAM_A: FakeAscTeam = {
  issuerId: "57246542-96fe-1a63-e053-0824d011072a",
  keyId: "2X9R4HXF34",
  key: p256KeyPair(),
  apps: [
    { id: "1000000001", name: "Alpha Notes", bundleId: "com.alpha.notes" },
    { id: "1000000002", name: "Alpha Ledger", bundleId: "com.alpha.ledger" },
  ],
  vendorNumbers: ["85012345"],
  reports: { "2026-09-30": alphaReport(10) },
};
const TEAM_B: FakeAscTeam = {
  issuerId: "69a6de7f-1c2d-47e3-e053-5b8c7c11a4d1",
  keyId: "9KQ7ZP2M4L",
  key: p256KeyPair(),
  apps: [{ id: "2000000001", name: "Beta Atlas", bundleId: "org.beta.atlas" }],
  vendorNumbers: ["86000001"],
};

// Team A's next key (#175 rotation): same team, a new key ID and key.
const TEAM_A_ROTATED: FakeAscTeam = {
  ...TEAM_A,
  keyId: "7MZ3QW8N2D",
  key: p256KeyPair(),
};

const teams = [TEAM_A, TEAM_B];
const asc = createFakeAsc(teams);

/** The real connector, its runtime.fetch pointed at the fake API. */
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
      email: "asc-owner@example.com",
      password: "password-12345",
    },
  });
  expect(signUp.statusCode).toBe(200);
  const header = signUp.headers["set-cookie"];
  cookie = (Array.isArray(header) ? header : [header])
    .find((value) => value?.startsWith("better-auth.session_token="))!
    .split(";")[0]!;
  await app.inject({
    method: "POST",
    url: "/v1/bootstrap",
    headers: { cookie },
    payload: { workspaceName: "App Store" },
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

async function connectionCount(): Promise<number> {
  const [row] = await admin`select count(*)::int as count from connections`;
  return row!.count as number;
}

async function runSync(connectionId: string) {
  const handlers = createJobHandlers({
    registry: registry(),
    credentialKeyring: KEYRING,
    signedKeys,
    now: () => new Date(NOW),
  });
  return handlers["connection.sync"]!({
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

describe("App Store Connect connections", () => {
  const ids: Record<"a" | "b", string> = { a: "", b: "" };

  it("refuses a vendor number of another team before anything is stored", async () => {
    const before = await connectionCount();
    const response = await call("POST", "/connections", {
      connectorId: CONNECTOR_ID,
      name: "Alpha",
      config: { vendorNumber: TEAM_B.vendorNumbers[0] },
      credentials: credentialsOf(TEAM_A),
    });
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error).toBe(
      vendorNumberMessage(TEAM_B.vendorNumbers[0]!),
    );
    expect(await connectionCount()).toBe(before);
  });

  it("holds connections of two teams in one workspace, each with its own key and vendor number", async () => {
    for (const [slot, team] of [
      ["a", TEAM_A],
      ["b", TEAM_B],
    ] as const) {
      const response = await call("POST", "/connections", {
        connectorId: CONNECTOR_ID,
        name: `Team ${slot.toUpperCase()}`,
        config: { vendorNumber: team.vendorNumbers[0] },
        credentials: credentialsOf(team),
        resources: [team.apps[0]!.id],
      });
      expect(response.statusCode).toBe(200);
      ids[slot] = connectionResponseSchema.parse(response.json()).connection.id;
    }
    expect(ids.a).not.toBe(ids.b);

    const list = connectionListResponseSchema
      .parse((await call("GET", "/connections")).json())
      .connections.filter(
        (connection) => connection.connectorId === CONNECTOR_ID,
      );
    expect(list.map((connection) => connection.id).sort()).toEqual(
      [ids.a, ids.b].sort(),
    );
    // Each envelope holds its own team's key, bound to its connection.
    for (const [slot, team] of [
      ["a", TEAM_A],
      ["b", TEAM_B],
    ] as const) {
      const [row] = await admin`
        select credentials_encrypted, config from connections
        where id = ${ids[slot]}
      `;
      const stored = JSON.parse(
        decryptCredentials(
          (row!.credentials_encrypted as Buffer).toString("utf8"),
          KEYRING,
          { workspaceId, connectionId: ids[slot] },
        ),
      ) as Record<string, string>;
      expect(stored).toEqual(credentialsOf(team));
      expect(row!.config).toEqual({
        vendorNumber: team.vendorNumbers[0],
        resourceSelection: [team.apps[0]!.id],
      });
    }
  });

  it("discovers each team's apps with tokens signed by that team's key", async () => {
    const seen = asc.requests.length;
    const discovered = async (id: string) =>
      connectionResourcesResponseSchema
        .parse((await call("GET", `/connections/${id}/resources`)).json())
        .resources.map((resource) => resource.id);
    expect(await discovered(ids.a)).toEqual(["1000000002", "1000000001"]);
    expect(await discovered(ids.b)).toEqual(["2000000001"]);
    const issuers = asc.requests.slice(seen).map((request) => request.issuerId);
    expect(issuers).toEqual([TEAM_A.issuerId, TEAM_B.issuerId]);
  });

  it("syncs each team's sales through the engine; a replay adds nothing and a revision updates", async () => {
    for (const id of [ids.a, ids.b]) {
      await runSync(id);
      const [state] = await admin`
        select auth_state, consecutive_failures from connection_state
        where connection_id = ${id}
      `;
      expect(state).toMatchObject({
        auth_state: "ok",
        consecutive_failures: 0,
      });
    }
    const sept30 = async () =>
      (
        await admin`
          select d.key as metric_key, o.dimensions, o.value
          from observations o
          join metric_definitions d on d.id = o.metric_definition_id
          where o.connection_id = ${ids.a}
            and o.source_timestamp = '2026-09-30T00:00:00Z'
          order by d.key, o.dimensions::text
        `
      ).map((row) => ({
        metric: row.metric_key as string,
        dimensions: row.dimensions as Record<string, string>,
        value: row.value as number,
      }));
    const first = await sept30();
    const value = (metric: string, extra: Record<string, string> = {}) =>
      first.find(
        (row) =>
          row.metric === `app_store_connect.${metric}` &&
          JSON.stringify(Object.entries(row.dimensions).sort()) ===
            JSON.stringify(
              Object.entries({ resource: "1000000001", ...extra }).sort(),
            ),
      )?.value;
    expect(value("downloads")).toBe(10);
    expect(value("iap_units")).toBe(3);
    // Proceeds of two currencies stay separate series.
    expect(value("proceeds", { currency: "USD" })).toBe(140);
    expect(value("proceeds", { currency: "JPY" })).toBe(84);
    expect(first.every((row) => row.dimensions.resource === "1000000001")).toBe(
      true,
    );

    // The next sync re-reads Sept 30: nothing is added.
    await runSync(ids.a);
    expect(await sept30()).toEqual(first);

    // Apple revises the day: the stored values change in place.
    TEAM_A.reports!["2026-09-30"] = alphaReport(12);
    await runSync(ids.a);
    const revised = await sept30();
    expect(revised).toHaveLength(first.length);
    expect(
      revised.find(
        (row) =>
          row.metric === "app_store_connect.downloads" &&
          row.dimensions.resource === "1000000001",
      )?.value,
    ).toBe(12);
  });

  it("shows the stored key's issuer ID and key ID, never the private key", async () => {
    const response = await call("GET", `/connections/${ids.a}`);
    expect(response.statusCode).toBe(200);
    expect(
      connectionResponseSchema.parse(response.json()).connection.signedKey,
    ).toEqual({
      provider: "app-store-connect",
      fields: [
        { key: "issuerId", label: "Issuer ID", value: TEAM_A.issuerId },
        { key: "keyId", label: "Key ID", value: TEAM_A.keyId },
      ],
    });
    expect(response.body).not.toContain("privateKey");
    expect(response.body).not.toContain("PRIVATE KEY");
  });

  it("keeps the stored key when a replacement fails, and shows the new key ID after rotating", async () => {
    const keyIdOf = async () =>
      connectionResponseSchema
        .parse((await call("GET", `/connections/${ids.a}`)).json())
        .connection.signedKey?.fields.find((field) => field.key === "keyId")
        ?.value;

    // A key Apple does not know: refused, the old envelope stays.
    const unknown = await call("PATCH", `/connections/${ids.a}`, {
      credentials: credentialsOf({ ...TEAM_A_ROTATED, keyId: "0000000000" }),
    });
    expect(unknown.statusCode).toBe(400);
    expect(errorResponseSchema.parse(unknown.json()).error).toMatch(
      /do not belong together, or the key was revoked/,
    );
    expect(await keyIdOf()).toBe(TEAM_A.keyId);

    // The team's new key: validated, stored, and shown by its key ID.
    teams.push(TEAM_A_ROTATED);
    const rotated = await call("PATCH", `/connections/${ids.a}`, {
      credentials: credentialsOf(TEAM_A_ROTATED),
    });
    expect(rotated.statusCode).toBe(200);
    expect(
      connectionResponseSchema
        .parse(rotated.json())
        .connection.signedKey?.fields.map((field) => field.value),
    ).toEqual([TEAM_A_ROTATED.issuerId, TEAM_A_ROTATED.keyId]);
    expect(await keyIdOf()).toBe(TEAM_A_ROTATED.keyId);
    expect(rotated.body).not.toContain("PRIVATE KEY");
  });

  it("puts no key material or token in responses or logs", () => {
    const text = [...bodies, ...logs].join("\n");
    for (const team of [TEAM_A, TEAM_B, TEAM_A_ROTATED]) {
      expect(text).not.toContain(pemBody(team.key.privateKeyPem).slice(0, 24));
    }
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./);
  });
});
