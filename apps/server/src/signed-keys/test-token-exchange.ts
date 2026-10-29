import { randomBytes } from "node:crypto";

import type {
  Connector,
  ConnectorFetchInit,
  ConnectorManifest,
  ConnectorResponse,
} from "@netrics/connector-sdk";
import { z } from "zod";

import type { SignedKeyProviderDefinition } from "./providers/index.js";
import { decodeJwt, type TestKeyPair } from "./test-keys.js";

// Tests only (#369): a signed-key provider with a token exchange, shaped
// like Apple Ads (ADR 0020 §2) but not it, an in-memory token endpoint that
// verifies the signed client secret, an API that accepts only the tokens it
// issued, and a connector that uses it. No Apple Ads connector code.

export const FIXTURE_PROVIDER_ID = "test-exchange";
export const FIXTURE_CONNECTOR_ID = "test-exchange-ads";
export const FIXTURE_AUTH_HOST = "auth.exchange.test";
export const FIXTURE_API_HOST = "api.exchange.test";
export const FIXTURE_TOKEN_ENDPOINT = `https://${FIXTURE_AUTH_HOST}/auth/oauth2/token`;
export const FIXTURE_AUDIENCE = `https://${FIXTURE_AUTH_HOST}`;
export const FIXTURE_SCOPE = "testadsorg";
export const FIXTURE_INVALID_CLIENT =
  "Test Ads refused the key: it was removed, or the IDs do not match the key. Upload a new key.";
export const FIXTURE_UNAUTHORIZED =
  "Test Ads refused the access token. Upload a new key.";

const CLIENT_ID = /^TESTADS\.[0-9a-f-]{36}$/;

export const fixtureExchangeProvider: SignedKeyProviderDefinition = {
  id: FIXTURE_PROVIDER_ID,
  name: "Test Ads",
  fields: [
    {
      key: "clientId",
      label: "Client ID",
      description: "TESTADS.<uuid>",
      input: "text",
      secret: false,
      maxBytes: 64,
      validate: (value) =>
        CLIENT_ID.test(value) ? null : "Client ID must be TESTADS.<uuid>.",
    },
    {
      key: "teamId",
      label: "Team ID",
      description: "TESTADS.<uuid>",
      input: "text",
      secret: false,
      maxBytes: 64,
      validate: (value) =>
        CLIENT_ID.test(value) ? null : "Team ID must be TESTADS.<uuid>.",
    },
    {
      key: "keyId",
      label: "Key ID",
      description: "A UUID",
      input: "text",
      secret: false,
      maxBytes: 64,
    },
    {
      key: "privateKey",
      label: "Private key",
      description: "PEM",
      input: "file",
      secret: true,
      maxBytes: 4096,
      privateKey: true,
    },
  ],
  token: (values) => ({
    kid: values.keyId!,
    claims: {
      iss: values.teamId!,
      sub: values.clientId!,
      aud: FIXTURE_AUDIENCE,
    },
  }),
  lifetime: { issuedBeforeSeconds: 60, expiresInSeconds: 600 },
  exchange: {
    tokenEndpoint: FIXTURE_TOKEN_ENDPOINT,
    form: (values) => ({
      grant_type: "client_credentials",
      client_id: values.clientId!,
      scope: FIXTURE_SCOPE,
    }),
    response: z.object({
      access_token: z.string().min(1),
      expires_in: z.number().int().positive(),
    }),
    invalidClient: FIXTURE_INVALID_CLIENT,
  },
  serverDomains: [FIXTURE_AUTH_HOST, FIXTURE_API_HOST],
  setup: { steps: ["Create an API user."], url: "https://exchange.test/" },
  probes: [
    {
      name: "me",
      async run(context) {
        const response = await context.fetch(
          `https://${FIXTURE_API_HOST}/v1/me`,
          {
            headers: { authorization: `Bearer ${context.accessToken()}` },
          },
        );
        return response.status === 200
          ? { ok: true }
          : { ok: false, message: `Test Ads answered ${response.status}.` };
      },
    },
  ],
  authFailure: {
    unauthorized: FIXTURE_UNAUTHORIZED,
    forbidden: "Test Ads: the API user lacks a read role.",
  },
};

export interface FixtureClient {
  clientId: string;
  teamId: string;
  keyId: string;
  key: TestKeyPair;
}

export function fixtureClient(key: TestKeyPair): FixtureClient {
  const uuid = () =>
    [8, 4, 4, 4, 12]
      .map((length) => randomBytes(length).toString("hex").slice(0, length))
      .join("-");
  return {
    clientId: `TESTADS.${uuid()}`,
    teamId: `TESTADS.${uuid()}`,
    keyId: uuid(),
    key,
  };
}

export function fixtureCredentials(client: FixtureClient) {
  return {
    clientId: client.clientId,
    teamId: client.teamId,
    keyId: client.keyId,
    privateKey: client.key.privateKeyPem,
  };
}

function reply(status: number, body: unknown): ConnectorResponse {
  const text = JSON.stringify(body);
  return {
    status,
    headers: { "content-type": "application/json" },
    text: () => text,
    json: () => JSON.parse(text) as unknown,
    bytes: () => new TextEncoder().encode(text),
  };
}

export interface FakeTokenExchange {
  fetch(url: string, init?: ConnectorFetchInit): Promise<ConnectorResponse>;
  /** Successful exchanges so far. */
  exchanges: number;
  /** Every client secret received, and every token issued. */
  clientSecrets: string[];
  issued: string[];
  /** Delay of the token endpoint, to make concurrent callers overlap. */
  delayMs: number;
  /** expires_in of the next tokens. */
  expiresIn: number;
  /** Queued answers of the token endpoint (thrown errors simulate timeouts). */
  nextErrors: Array<{ status: number; body: unknown } | Error>;
  /** Tokens the API no longer accepts (revoked early by the provider). */
  revoke(token: string): void;
  /** The API refuses every token (the key's access is gone). */
  refuseAll: boolean;
  /** API calls by bearer token. */
  apiCalls: string[];
  clients: FixtureClient[];
}

/** The token endpoint and API of the fixture provider. */
export function createFakeTokenExchange(
  clients: FixtureClient[],
): FakeTokenExchange {
  const valid = new Set<string>();
  const fake: FakeTokenExchange = {
    exchanges: 0,
    clientSecrets: [],
    issued: [],
    delayMs: 0,
    expiresIn: 3600,
    nextErrors: [],
    refuseAll: false,
    apiCalls: [],
    clients,
    revoke(token) {
      valid.delete(token);
    },
    async fetch(raw, init) {
      const url = new URL(raw);
      if (url.href === FIXTURE_TOKEN_ENDPOINT) {
        if (init?.method !== "POST") {
          return reply(405, { error: "invalid_request" });
        }
        if (fake.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, fake.delayMs));
        }
        const queued = fake.nextErrors.shift();
        if (queued instanceof Error) {
          throw queued;
        }
        if (queued) {
          return reply(queued.status, queued.body);
        }
        const form = new URLSearchParams(init.body ?? "");
        const secret = form.get("client_secret") ?? "";
        fake.clientSecrets.push(secret);
        const client = fake.clients.find(
          (entry) => entry.clientId === form.get("client_id"),
        );
        if (
          !client ||
          form.get("grant_type") !== "client_credentials" ||
          form.get("scope") !== FIXTURE_SCOPE
        ) {
          return reply(400, { error: "invalid_client" });
        }
        let decoded;
        try {
          decoded = decodeJwt(secret, client.key.publicKey);
        } catch {
          return reply(400, { error: "invalid_client" });
        }
        const now = Math.floor(Date.now() / 1000);
        const { claims, header } = decoded;
        if (
          !decoded.verifies ||
          header.alg !== "ES256" ||
          header.kid !== client.keyId ||
          claims.iss !== client.teamId ||
          claims.sub !== client.clientId ||
          claims.aud !== FIXTURE_AUDIENCE ||
          typeof claims.exp !== "number" ||
          claims.exp < now
        ) {
          return reply(400, { error: "invalid_client" });
        }
        fake.exchanges += 1;
        const token = `fixture-access-${randomBytes(18).toString("base64url")}`;
        fake.issued.push(token);
        valid.add(token);
        return reply(200, {
          access_token: token,
          token_type: "Bearer",
          expires_in: fake.expiresIn,
        });
      }
      if (url.host === FIXTURE_API_HOST) {
        const token = (init?.headers?.authorization ?? "").replace(
          /^Bearer /,
          "",
        );
        fake.apiCalls.push(token);
        if (fake.refuseAll || !valid.has(token)) {
          return reply(401, { error: { code: "UNAUTHORIZED" } });
        }
        if (url.pathname === "/v1/me") {
          return reply(200, { userId: "user-1" });
        }
        if (url.pathname === "/v1/accounts") {
          return reply(200, { accounts: [{ id: "acct-1", name: "Account" }] });
        }
        if (url.pathname === "/v1/report") {
          return reply(200, { value: 7 });
        }
      }
      return reply(404, { error: "not_found" });
    },
  };
  return fake;
}

export const fixtureManifest: ConnectorManifest = {
  id: FIXTURE_CONNECTOR_ID,
  version: "0.1.0",
  sdkVersion: "^0.2.7",
  category: "other",
  name: "Test Ads",
  description: "Fixture connector for signed-key token exchange tests.",
  authStrategies: [{ strategy: "signed-key", provider: FIXTURE_PROVIDER_ID }],
  configSchema: { type: "object", properties: {}, additionalProperties: false },
  metrics: [
    {
      key: "test_ads.spend",
      name: "Spend",
      description: "Daily spend.",
      kind: "delta",
      unit: "count",
      granularity: "day",
      dimensions: [],
      aggregations: ["sum"],
    },
  ],
  minRefreshIntervalSeconds: 300,
  supportsBackfill: true,
  backfillDays: 2,
  outboundDomains: [FIXTURE_API_HOST],
  resourceNoun: { singular: "account", plural: "accounts" },
};

/** Connectors signal a refused token by this error name (ADR 0012). */
function rejected(status: number): Error {
  const error = new Error(`Test Ads answered ${status}`);
  if (status === 401) {
    error.name = "AccessTokenRejectedError";
  }
  return error;
}

/**
 * A connector on the fixture API. `pages` sync pages each read the report
 * with the access token it was handed; a 401 throws AccessTokenRejectedError.
 * Its fetch goes to `fake` (the runtime's egress would refuse the test
 * host).
 */
export function createFixtureConnector(
  fake: FakeTokenExchange,
  options: { pages?: number } = {},
): Connector {
  const pages = options.pages ?? 1;
  const get = async (path: string, credentials: Record<string, unknown>) => {
    const response = await fake.fetch(`https://${FIXTURE_API_HOST}${path}`, {
      headers: { authorization: `Bearer ${String(credentials.accessToken)}` },
    });
    if (response.status !== 200) {
      throw rejected(response.status);
    }
    return response;
  };
  return {
    manifest: fixtureManifest,
    async check(context) {
      await get("/v1/me", context.credentials);
      return { ok: true };
    },
    async discover(context) {
      await get("/v1/accounts", context.credentials);
      return [{ id: "acct-1", name: "Account", kind: "account" }];
    },
    async sync(context, request) {
      // The engine hands back the run's own cursor in later runs; only
      // this connector's page cursors ("page:N") continue a run.
      const page = request.cursor?.startsWith("page:")
        ? Number(request.cursor.slice(5))
        : 0;
      await get("/v1/report", context.credentials);
      const day = new Date(Date.UTC(2026, 8, 1 + page)).toISOString();
      const last = page + 1 >= pages;
      return {
        observations: [
          {
            metricKey: "test_ads.spend",
            sourceTimestamp: day,
            value: 7,
            dimensions: {},
          },
        ],
        ...(last ? {} : { nextCursor: `page:${page + 1}` }),
        done: last,
      };
    },
  };
}
