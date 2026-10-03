import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  connectionDetailResponseSchema,
  connectionListResponseSchema,
  connectionResponseSchema,
  connectorListResponseSchema,
  errorResponseSchema,
  workspaceListResponseSchema,
} from "@netrics/contracts";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import type { ConnectorManifest } from "@netrics/connector-sdk";
import { createDemoConnector, demoManifest } from "@netrics/connectors";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";
import { syncCatalog } from "./sync/catalog.js";
import { createTestDatabase } from "./test-db.js";

// ADR 0012 in the API: OAuth connectors in the catalog, refusal of
// connections whose provider is not configured, and the OAuth fields of a
// connection.

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

const CLIENT_SECRET = "GOCSPX-api-test-secret";

/** The demo connector under another id and auth strategies. */
function variant(
  id: string,
  authStrategies: ConnectorManifest["authStrategies"],
) {
  return {
    ...createDemoConnector(),
    manifest: { ...demoManifest, id, sdkVersion: "^0.2.2", authStrategies },
  };
}

// ADR 0014: signed-key connectors (SDK 0.2.2). This server has the
// app-store-connect provider (#170) but none named "acme-ads", so it must not
// take a key for that one (it would have to hand it to the connector).
const appStoreKey = {
  strategy: "signed-key" as const,
  provider: "app-store-connect",
};
const unknownKey = { strategy: "signed-key" as const, provider: "acme-ads" };

const googleOAuth = {
  strategy: "oauth2" as const,
  provider: "google",
  scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
};

function registry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(createDemoConnector());
  registry.register(variant("google-only", [googleOAuth]));
  registry.register(
    variant("google-or-token", [googleOAuth, { strategy: "token" }]),
  );
  registry.register(
    variant("unknown-provider", [{ ...googleOAuth, provider: "acme" }]),
  );
  registry.register(variant("signed-key-only", [appStoreKey]));
  registry.register(variant("unknown-signed-key", [unknownKey]));
  registry.register(
    variant("unknown-signed-key-or-token", [unknownKey, { strategy: "token" }]),
  );
  return registry;
}

interface World {
  app: FastifyInstance;
  db: Database;
  close: () => Promise<void>;
}

async function createApp(
  databaseUrl: string,
  env: Record<string, string>,
): Promise<World> {
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    LOG_LEVEL: "silent",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
    ...env,
  });
  const db = createDatabase(databaseUrl);
  const authService = createAuthService(config, db, {
    logger: pino({ level: "silent" }),
  });
  const app = await buildApp(config, {
    db,
    authService,
    registry: registry(),
    checkDb: async () => true,
  });
  return {
    app,
    db,
    close: async () => {
      await app.close();
      await db.$client.end({ timeout: 5 }).catch(() => undefined);
    },
  };
}

function inject(
  app: FastifyInstance,
  method: "GET" | "POST",
  url: string,
  cookie: string,
  payload?: Record<string, unknown>,
): Promise<InjectResponse> {
  return app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });
}

let unconfigured: World;
let configured: World;
let admin: Sql;
let cookie: string;
let workspaceId: string;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  // The fixture connectors join the catalog, as `migrate` would write it.
  const owner = createDatabase(testDb.adminUrl, { max: 1 });
  await syncCatalog(owner, registry());
  await owner.$client.end({ timeout: 5 });
  unconfigured = await createApp(testDb.appUrl, {});
  configured = await createApp(testDb.appUrl, {
    NETRICS_OAUTH_GOOGLE_CLIENT_ID: "client.apps.googleusercontent.com",
    NETRICS_OAUTH_GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
  });
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });

  const signUp = await unconfigured.app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: {
      name: "Owner",
      email: "oauth-owner@example.com",
      password: "password-12345",
    },
  });
  expect(signUp.statusCode).toBe(200);
  const header = signUp.headers["set-cookie"];
  cookie = (Array.isArray(header) ? header : [header])
    .find((value) => value?.startsWith("better-auth.session_token="))!
    .split(";")[0]!;
  expect(
    (
      await inject(unconfigured.app, "POST", "/v1/bootstrap", cookie, {
        workspaceName: "OAuth",
      })
    ).statusCode,
  ).toBe(200);
  workspaceId = workspaceListResponseSchema.parse(
    (await inject(unconfigured.app, "GET", "/v1/workspaces", cookie)).json(),
  ).workspaces[0]!.id;
}, 60_000);

afterAll(async () => {
  await unconfigured?.close();
  await configured?.close();
  await admin?.end({ timeout: 5 }).catch(() => undefined);
});

async function catalog(world: World) {
  const response = await inject(world.app, "GET", "/v1/connectors", cookie);
  expect(response.statusCode).toBe(200);
  const { connectors } = connectorListResponseSchema.parse(response.json());
  return new Map(connectors.map((entry) => [entry.id, entry]));
}

describe("connector catalog", () => {
  it("lists an OAuth connector as unavailable while its provider is unconfigured", async () => {
    const entries = await catalog(unconfigured);
    expect(entries.get("google-only")).toMatchObject({
      available: false,
      unavailable: {
        reason: "oauth_provider_not_configured",
        provider: "google",
      },
      authStrategies: [googleOAuth],
    });
    expect(entries.get("unknown-provider")).toMatchObject({
      available: false,
      unavailable: { reason: "oauth_provider_unsupported", provider: "acme" },
    });
    expect(entries.get("unknown-signed-key")).toMatchObject({
      available: false,
      unavailable: {
        reason: "signed_key_provider_unsupported",
        provider: "acme-ads",
      },
      authStrategies: [unknownKey],
    });
    expect(entries.get("unknown-signed-key-or-token")).toMatchObject({
      available: true,
      unavailable: null,
      authStrategies: [unknownKey, { strategy: "token" }],
    });
    // A provider this server has needs no configuration (ADR 0014).
    expect(entries.get("signed-key-only")).toMatchObject({
      available: true,
      unavailable: null,
      authStrategies: [
        expect.objectContaining({
          ...appStoreKey,
          providerName: "App Store Connect",
        }),
      ],
    });
    // A token alternative keeps a connector usable; others are unaffected.
    expect(entries.get("google-or-token")).toMatchObject({
      available: true,
      unavailable: null,
    });
    expect(entries.get("demo")).toMatchObject({
      available: true,
      unavailable: null,
    });
  });

  it("lists it as available once the provider is configured", async () => {
    const entries = await catalog(configured);
    expect(entries.get("google-only")).toMatchObject({
      available: true,
      unavailable: null,
    });
    const body = JSON.stringify([...entries.values()]);
    expect(body).not.toContain(CLIENT_SECRET);
  });
});

describe("creating connections", () => {
  const create = (world: World, connectorId: string) =>
    inject(
      world.app,
      "POST",
      `/v1/workspaces/${workspaceId}/connections`,
      cookie,
      { connectorId, name: "Search Console", credentials: { token: "x" } },
    );
  const preview = (world: World, connectorId: string) =>
    inject(
      world.app,
      "POST",
      `/v1/workspaces/${workspaceId}/connections/preview`,
      cookie,
      { connectorId, credentials: { token: "x" } },
    );

  async function connectionCount(): Promise<number> {
    const [row] = await admin`select count(*)::int as count from connections`;
    return row!.count as number;
  }

  it("refuses a connector whose provider is not configured", async () => {
    const before = await connectionCount();
    for (const [world, connectorId] of [
      [unconfigured, "google-only"],
      [unconfigured, "unknown-provider"],
      [unconfigured, "unknown-signed-key"],
      [configured, "unknown-signed-key"],
    ] as const) {
      for (const response of [
        await create(world, connectorId),
        await preview(world, connectorId),
      ]) {
        expect(response.statusCode).toBe(400);
        expect(errorResponseSchema.parse(response.json())).toEqual({
          error: "connector_unavailable",
        });
      }
    }
    expect(await connectionCount()).toBe(before);
  });

  it("sends OAuth-only connectors through the authorization flow", async () => {
    const before = await connectionCount();
    for (const response of [
      await create(configured, "google-only"),
      await preview(configured, "google-only"),
    ]) {
      expect(response.statusCode).toBe(400);
      expect(errorResponseSchema.parse(response.json())).toEqual({
        error: "oauth_authorization_required",
      });
    }
    expect(await connectionCount()).toBe(before);
  });

  it("still creates connections with a token alternative", async () => {
    const response = await create(unconfigured, "google-or-token");
    expect(response.statusCode).toBe(200);
    const { connection } = connectionResponseSchema.parse(response.json());
    expect(connection.oauth).toBeNull();
    expect(connection.state.authReason).toBeNull();
  });
});

describe("OAuth fields of a connection", () => {
  it("shows the linked account and reauthorization reason, never tokens", async () => {
    const created = connectionResponseSchema.parse(
      (
        await inject(
          unconfigured.app,
          "POST",
          `/v1/workspaces/${workspaceId}/connections`,
          cookie,
          { connectorId: "demo", name: "Linked", config: {} },
        )
      ).json(),
    ).connection;
    const accessToken = Buffer.from("sealed-access-token-bytes");
    await admin`
      insert into connection_oauth
        (connection_id, workspace_id, provider, account_sub, account_email,
         granted_scopes, access_token_encrypted, access_token_expires_at)
      values (${created.id}, ${workspaceId}, 'google', 'sub-123',
              'owner@example.com', ${["openid", "email"]}, ${accessToken},
              now() + interval '1 hour')`;
    await admin`
      update connection_state
      set auth_state = 'needs_reauthorization', auth_reason = 'invalid_grant'
      where connection_id = ${created.id}`;

    const detail = await inject(
      unconfigured.app,
      "GET",
      `/v1/workspaces/${workspaceId}/connections/${created.id}`,
      cookie,
    );
    expect(detail.statusCode).toBe(200);
    const { connection } = connectionDetailResponseSchema.parse(detail.json());
    expect(connection.oauth).toEqual({
      provider: "google",
      accountEmail: "owner@example.com",
      grantedScopes: ["openid", "email"],
    });
    expect(connection.state).toMatchObject({
      health: "needs_reauthorization",
      authState: "needs_reauthorization",
      authReason: "invalid_grant",
    });
    expect(detail.body).not.toContain("sub-123");
    expect(detail.body).not.toContain("sealed-access-token");
    expect(detail.body).not.toContain(accessToken.toString("base64"));

    const list = connectionListResponseSchema.parse(
      (
        await inject(
          unconfigured.app,
          "GET",
          `/v1/workspaces/${workspaceId}/connections`,
          cookie,
        )
      ).json(),
    );
    expect(
      list.connections.find((entry) => entry.id === created.id)?.oauth,
    ).toEqual(connection.oauth);
  });
});
