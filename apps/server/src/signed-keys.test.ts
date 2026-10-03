import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20_000 });

import {
  connectionResponseSchema,
  connectionPreviewResponseSchema,
  connectionResourcesResponseSchema,
  connectorListResponseSchema,
  errorResponseSchema,
  workspaceListResponseSchema,
} from "@netrics/contracts";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import type {
  ConnectionContext,
  Connector,
  ConnectorManifest,
} from "@netrics/connector-sdk";
import { createDemoConnector } from "@netrics/connectors";
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
import { createJobHandlers, TerminalJobError } from "./jobs/handlers.js";
import { capturingLogger } from "./oauth/test-provider.js";
import {
  appStoreConnectProvider,
  type SignedKeyProviderDefinition,
} from "./signed-keys/providers/index.js";
import { SignedKeyProviders } from "./signed-keys/registry.js";
import {
  decodeJwt,
  p256KeyPair,
  pemBody,
  TEST_ISSUER_ID,
  TEST_KEY_ID,
  type TestKeyPair,
} from "./signed-keys/test-keys.js";
import { syncCatalog } from "./sync/catalog.js";
import { createTestDatabase } from "./test-db.js";

// ADR 0014 in the API and the sync engine (#170): signed-key connectors are
// available because this server has the provider; keys are validated (fields,
// P-256 PKCS#8, probes) before anything is stored; the envelope holds
// { issuerId, keyId, privateKey }; connectors receive only { accessToken };
// rotation replaces the key only after validation; a refused key puts the
// connection in auth_failed; no key material reaches logs, errors, audit
// events or responses.

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
const KEYRING = createCredentialKeyring(ENCRYPTION_KEY);
const CONNECTOR_ID = "asc-fixture";

/** What the fixture connector does on its next calls. */
let behaviour: "ok" | "revoked" = "ok";
/** What the probe answers. */
let probeAnswer: "ok" | "wrong-vendor" = "ok";
/** Credentials every connector call received, in order. */
const received: Array<Record<string, unknown>> = [];

function record(context: ConnectionContext) {
  received.push({ ...context.credentials });
  if (behaviour === "revoked") {
    const error = new Error(
      `App Store Connect answered 401 for ${String(context.credentials.accessToken)}`,
    );
    error.name = "AccessTokenRejectedError";
    throw error;
  }
}

const manifest: ConnectorManifest = {
  id: CONNECTOR_ID,
  version: "0.1.0",
  sdkVersion: "^0.2.2",
  name: "App Store Connect fixture",
  description: "Signed-key fixture connector.",
  authStrategies: [{ strategy: "signed-key", provider: "app-store-connect" }],
  configSchema: {
    type: "object",
    properties: { vendorNumber: { type: "string" } },
    additionalProperties: false,
  },
  metrics: [
    {
      key: `${CONNECTOR_ID}.downloads`,
      name: "Downloads",
      description: "Fixture downloads.",
      kind: "delta",
      unit: "downloads",
      granularity: "day",
      dimensions: [],
      aggregations: ["sum"],
    },
  ],
  minRefreshIntervalSeconds: 300,
  supportsBackfill: true,
  backfillDays: 3,
  outboundDomains: ["api.appstoreconnect.apple.com"],
};

const connector: Connector = {
  manifest,
  async check(context) {
    record(context);
    return { ok: true };
  },
  async discover(context) {
    record(context);
    return [{ id: "1234567890", name: "Fixture App", kind: "app" }];
  },
  async sync(context, request) {
    record(context);
    return {
      observations: [
        {
          metricKey: `${CONNECTOR_ID}.downloads`,
          sourceTimestamp: new Date(
            Date.parse(request.to) - (Date.parse(request.to) % 86_400_000),
          ).toISOString(),
          value: 7,
          dimensions: {},
        },
      ],
      done: true,
    };
  },
};

function registry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(createDemoConnector());
  registry.register(connector);
  registry.register({
    ...connector,
    manifest: {
      ...manifest,
      id: "unknown-signer",
      authStrategies: [{ strategy: "signed-key", provider: "acme-ads" }],
    },
  });
  return registry;
}

/** App Store Connect with a probe standing in for #171's API probes. */
const provider: SignedKeyProviderDefinition = {
  ...appStoreConnectProvider,
  probes: [
    {
      name: "sales-report",
      async run(context) {
        // A probe's message may quote what it got; the host redacts it.
        const token = context.accessToken();
        return probeAnswer === "ok"
          ? { ok: true }
          : {
              ok: false,
              message: `Vendor number ${String(context.config.vendorNumber)} is not one of this team's vendor numbers (token ${token}).`,
            };
      },
    },
  ],
};
const signedKeys = new SignedKeyProviders({
  definitions: new Map([[provider.id, provider]]),
});

let app: FastifyInstance;
let db: Database;
let admin: Sql;
let cookie: string;
let workspaceId: string;
const logs: string[] = [];
/** Every response body, to search for key material at the end. */
const bodies: string[] = [];
/** Every key that was sent, valid or not. */
const sentKeys: string[] = [];

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
  const logger = capturingLogger(logs);
  app = await buildApp(config, {
    db,
    authService: createAuthService(config, db, {
      logger: pino({ level: "silent" }),
    }),
    registry: registry(),
    signedKeys,
    checkDb: async () => true,
    logger,
  });
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });

  const signUp = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: {
      name: "Owner",
      email: "signed-key-owner@example.com",
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
    payload: { workspaceName: "Signed keys" },
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
): Promise<InjectResponse> {
  const credentials = payload?.credentials as
    { privateKey?: unknown } | undefined;
  if (typeof credentials?.privateKey === "string") {
    sentKeys.push(credentials.privateKey);
  }
  const response = await app.inject({
    method,
    url: `/v1/workspaces/${workspaceId}${path}`,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });
  bodies.push(response.body);
  return response;
}

function keyCredentials(pair: TestKeyPair = p256KeyPair()) {
  return {
    issuerId: TEST_ISSUER_ID,
    keyId: TEST_KEY_ID,
    privateKey: pair.privateKeyPem,
  };
}

async function connectionCount(): Promise<number> {
  const [row] = await admin`select count(*)::int as count from connections`;
  return row!.count as number;
}

async function storedCredentials(connectionId: string) {
  const [row] = await admin`
    select credentials_encrypted from connections where id = ${connectionId}
  `;
  const envelope = row!.credentials_encrypted as Buffer;
  return {
    envelope: envelope.toString("utf8"),
    credentials: JSON.parse(
      decryptCredentials(envelope.toString("utf8"), KEYRING, {
        workspaceId,
        connectionId,
      }),
    ) as Record<string, string>,
  };
}

async function create(credentials: Record<string, unknown>) {
  return call("POST", "/connections", {
    connectorId: CONNECTOR_ID,
    name: "App Store",
    config: { vendorNumber: "85012345" },
    credentials,
  });
}

function errorOf(response: InjectResponse): string {
  expect(response.statusCode).toBe(400);
  return errorResponseSchema.parse(response.json()).error;
}

describe("catalog", () => {
  it("offers a signed-key connector whose provider this server has, with the wizard's fields", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/connectors",
      headers: { cookie },
    });
    const entries = new Map(
      connectorListResponseSchema
        .parse(response.json())
        .connectors.map((entry) => [entry.id, entry]),
    );
    const entry = entries.get(CONNECTOR_ID)!;
    expect(entry).toMatchObject({ available: true, unavailable: null });
    expect(entry.authStrategies).toEqual([
      {
        strategy: "signed-key",
        provider: "app-store-connect",
        providerName: "App Store Connect",
        fields: [
          expect.objectContaining({
            key: "issuerId",
            label: "Issuer ID",
            input: "text",
            secret: false,
          }),
          expect.objectContaining({
            key: "keyId",
            label: "Key ID",
            input: "text",
            secret: false,
          }),
          expect.objectContaining({
            key: "privateKey",
            label: "Private key",
            input: "file",
            secret: true,
            maxBytes: 4096,
          }),
        ],
        setup: {
          steps: expect.arrayContaining([
            expect.stringMatching(/Sales role/),
          ]) as unknown as string[],
          url: "https://appstoreconnect.apple.com/access/integrations/api",
          links: [
            {
              step: 0,
              label: "Open App Store Connect API keys",
              url: "https://appstoreconnect.apple.com/access/integrations/api",
            },
            {
              step: 3,
              label: "Open Payments and Financial Reports",
              url: "https://appstoreconnect.apple.com/itc/payments_and_financial_reports",
            },
          ],
        },
      },
    ]);
    expect(entries.get("unknown-signer")).toMatchObject({
      available: false,
      unavailable: {
        reason: "signed_key_provider_unsupported",
        provider: "acme-ads",
      },
    });
  });
});

describe("creating a connection with a key", () => {
  it("refuses malformed or mismatched keys before persistence, with field-specific messages", async () => {
    const before = await connectionCount();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString();
    const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" })
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString();
    const encrypted = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({
        format: "pem",
        type: "pkcs8",
        cipher: "aes-256-cbc",
        passphrase: "secret passphrase",
      })
      .toString();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...keyCredentials(), issuerId: "abc" }, /^Issuer ID must be a UUID/],
      [{ ...keyCredentials(), keyId: "abc" }, /^Key ID must be 10/],
      [
        { ...keyCredentials(), privateKey: rsa },
        /^Private key: This is an RSA/,
      ],
      [{ ...keyCredentials(), privateKey: p384 }, /curve secp384r1/],
      [{ ...keyCredentials(), privateKey: encrypted }, /encrypted/],
      [{ ...keyCredentials(), privateKey: "garbage" }, /BEGIN PRIVATE KEY/],
      [{ token: "a-token" }, /remove the unknown field "token"/],
    ];
    for (const [credentials, message] of cases) {
      expect(errorOf(await create(credentials))).toMatch(message);
    }
    // The preview validates the same way.
    expect(
      errorOf(
        await call("POST", "/connections/preview", {
          connectorId: CONNECTOR_ID,
          config: {},
          credentials: { ...keyCredentials(), privateKey: rsa },
        }),
      ),
    ).toMatch(/RSA/);
    expect(await connectionCount()).toBe(before);
    expect(received).toHaveLength(0);
  });

  it("refuses a key the probe rejects, before persistence", async () => {
    const before = await connectionCount();
    probeAnswer = "wrong-vendor";
    try {
      const message = errorOf(await create(keyCredentials()));
      expect(message).toMatch(/^Vendor number 85012345 is not one/);
      expect(message).toContain("[redacted]");
    } finally {
      probeAnswer = "ok";
    }
    expect(await connectionCount()).toBe(before);
    expect(received).toHaveLength(0);
  });

  it("refuses a key the provider rejects during the connector check", async () => {
    const before = await connectionCount();
    behaviour = "revoked";
    try {
      expect(errorOf(await create(keyCredentials()))).toBe(
        appStoreConnectProvider.authFailure.unauthorized,
      );
    } finally {
      behaviour = "ok";
      received.length = 0;
    }
    expect(await connectionCount()).toBe(before);
  });

  it("previews with fresh tokens and persists nothing", async () => {
    const before = await connectionCount();
    const pair = p256KeyPair();
    const response = await call("POST", "/connections/preview", {
      connectorId: CONNECTOR_ID,
      config: { vendorNumber: "85012345" },
      credentials: keyCredentials(pair),
    });
    expect(response.statusCode).toBe(200);
    expect(connectionPreviewResponseSchema.parse(response.json())).toEqual({
      check: { ok: true },
      resources: [{ id: "1234567890", name: "Fixture App", kind: "app" }],
    });
    expect(received).toHaveLength(2);
    for (const credentials of received.splice(0)) {
      expect(Object.keys(credentials)).toEqual(["accessToken"]);
      expect(
        decodeJwt(String(credentials.accessToken), pair.publicKey).verifies,
      ).toBe(true);
    }
    expect(await connectionCount()).toBe(before);
  });
});

describe("a signed-key connection", () => {
  let connectionId: string;
  let pair: TestKeyPair;

  it("stores { issuerId, keyId, privateKey } in the envelope and hands the connector only a token", async () => {
    pair = p256KeyPair();
    const response = await create({
      ...keyCredentials(pair),
      // A paste that lost its line breaks is stored re-wrapped.
      privateKey: pair.privateKeyPem.replace(/\n/g, " "),
    });
    expect(response.statusCode).toBe(200);
    connectionId = connectionResponseSchema.parse(response.json()).connection
      .id;
    const { credentials } = await storedCredentials(connectionId);
    expect(credentials).toEqual({
      issuerId: TEST_ISSUER_ID,
      keyId: TEST_KEY_ID,
      privateKey: pair.privateKeyPem,
    });
    expect(received).toHaveLength(1);
    const [checked] = received.splice(0);
    expect(Object.keys(checked!)).toEqual(["accessToken"]);
    const decoded = decodeJwt(String(checked!.accessToken), pair.publicKey);
    expect(decoded.verifies).toBe(true);
    expect(decoded.header).toMatchObject({ kid: TEST_KEY_ID });
    expect(decoded.claims).toMatchObject({
      iss: TEST_ISSUER_ID,
      aud: "appstoreconnect-v1",
    });
  });

  it("discovers resources with a fresh token from the stored key", async () => {
    const response = await call(
      "GET",
      `/connections/${connectionId}/resources`,
    );
    expect(response.statusCode).toBe(200);
    expect(
      connectionResourcesResponseSchema.parse(response.json()).resources,
    ).toHaveLength(1);
    const [discovered] = received.splice(0);
    expect(Object.keys(discovered!)).toEqual(["accessToken"]);
  });

  async function runSync() {
    const handlers = createJobHandlers({
      registry: registry(),
      credentialKeyring: KEYRING,
      signedKeys,
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

  async function state() {
    const [row] = await admin`
      select auth_state, consecutive_failures
      from connection_state where connection_id = ${connectionId}
    `;
    return row!;
  }

  it("syncs with a fresh token per connector call", async () => {
    await runSync();
    // check, one sync page and the first discover of the resource names
    // (#194), each with its own token.
    expect(received).toHaveLength(3);
    for (const credentials of received) {
      expect(Object.keys(credentials)).toEqual(["accessToken"]);
      expect(
        decodeJwt(String(credentials.accessToken), pair.publicKey).verifies,
      ).toBe(true);
    }
    received.length = 0;
    expect((await state()).auth_state).toBe("ok");
  });

  it("moves to auth_failed with the provider's message when the key is refused, without retrying", async () => {
    behaviour = "revoked";
    try {
      await expect(runSync()).rejects.toBeInstanceOf(TerminalJobError);
    } finally {
      behaviour = "ok";
    }
    expect(received).toHaveLength(1);
    received.length = 0;
    expect((await state()).auth_state).toBe("auth_failed");
    const [run] = await admin`
      select error_class, error_message from sync_runs
      where connection_id = ${connectionId} and status = 'failed'
      order by started_at desc limit 1
    `;
    expect(run).toMatchObject({
      error_class: "auth",
      error_message: appStoreConnectProvider.authFailure.unauthorized,
    });
  });

  it("keeps the old key when a rotation fails validation", async () => {
    const before = await storedCredentials(connectionId);
    const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" })
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString();
    expect(
      errorOf(
        await call("PATCH", `/connections/${connectionId}`, {
          credentials: { ...keyCredentials(), privateKey: p384 },
        }),
      ),
    ).toMatch(/curve secp384r1/);
    probeAnswer = "wrong-vendor";
    try {
      expect(
        errorOf(
          await call("PATCH", `/connections/${connectionId}`, {
            credentials: keyCredentials(),
          }),
        ),
      ).toMatch(/^Vendor number/);
    } finally {
      probeAnswer = "ok";
    }
    behaviour = "revoked";
    try {
      expect(
        errorOf(
          await call("PATCH", `/connections/${connectionId}`, {
            credentials: keyCredentials(),
          }),
        ),
      ).toMatch(/Upload a new App Store Connect key/);
    } finally {
      behaviour = "ok";
      received.length = 0;
    }
    const after = await storedCredentials(connectionId);
    expect(after.envelope).toBe(before.envelope);
    expect(after.credentials.privateKey).toBe(pair.privateKeyPem);
    expect((await state()).auth_state).toBe("auth_failed");
  });

  it("rotates to a validated new key, resets auth_failed and audits without key material", async () => {
    const next = p256KeyPair();
    const response = await call("PATCH", `/connections/${connectionId}`, {
      credentials: { ...keyCredentials(next), keyId: "NEWKEY1234" },
    });
    expect(response.statusCode).toBe(200);
    const { credentials } = await storedCredentials(connectionId);
    expect(credentials).toEqual({
      issuerId: TEST_ISSUER_ID,
      keyId: "NEWKEY1234",
      privateKey: next.privateKeyPem,
    });
    expect((await state()).auth_state).toBe("ok");
    const [checked] = received.splice(0);
    const decoded = decodeJwt(String(checked!.accessToken), next.publicKey);
    expect(decoded.verifies).toBe(true);
    expect(decoded.header).toMatchObject({ kid: "NEWKEY1234" });

    const audit = await admin`
      select action, metadata from audit_events
      where target = ${connectionId} and action = 'connection.credentials_updated'
    `;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toEqual({ connectorId: CONNECTOR_ID });

    // A config change re-validates the stored key and keeps it.
    const reconfigured = await call("PATCH", `/connections/${connectionId}`, {
      config: { vendorNumber: "85099999" },
    });
    expect(reconfigured.statusCode).toBe(200);
    expect((await storedCredentials(connectionId)).credentials.keyId).toBe(
      "NEWKEY1234",
    );
    received.length = 0;
  });

  it("let no key material reach logs, errors, audit events, sync runs or responses", async () => {
    expect(sentKeys.length).toBeGreaterThan(5);
    const audit = await admin`select metadata from audit_events`;
    const runs = await admin`select error_message from sync_runs`;
    const jobs = await admin`select payload, last_error from jobs`;
    const haystack = [
      ...logs,
      ...bodies,
      JSON.stringify(audit),
      JSON.stringify(runs),
      JSON.stringify(jobs),
    ].join("\n");
    expect(logs.length).toBeGreaterThan(0);
    for (const key of sentKeys) {
      for (const line of key.split(/\s+/)) {
        if (line.length >= 16 && !line.startsWith("-----")) {
          expect(haystack).not.toContain(line);
        }
      }
      const body = pemBody(key);
      if (body.length >= 24) {
        expect(haystack).not.toContain(body.slice(0, 24));
      }
    }
    // No signed token (a JWS starting with the ES256 header) either.
    expect(haystack).not.toMatch(/eyJhbGciOiJFUzI1NiI[A-Za-z0-9_-]*\./);
  });
});
