import { randomBytes, randomUUID } from "node:crypto";

import type {
  ConnectorFetchInit,
  ConnectorResponse,
} from "@netrics/connector-sdk";

import { APPLE_ADS_AUDIENCE, APPLE_ADS_SCOPE } from "./providers/apple-ads.js";
import { decodeJwt, type TestKeyPair } from "./test-keys.js";

// Tests only (#373): Apple's token endpoint and the parts of the Apple Ads
// Platform API the connector reads, in the shapes of Apple's documentation
// (packages/connectors/src/apple-ads/fixtures name the pages). The token
// endpoint verifies the signed client secret like Apple; the API accepts
// only tokens it issued and serves an ad account only in its own
// `X-AP-Context` and only to an API user whose ACL has it.

export interface FakeAdAccount {
  id: string;
  name: string;
  orgId: string;
  currency: string;
  timezone: string;
  productFeatures: string[];
  campaigns: Array<{ id: string; name: string; appId: string }>;
}

export interface FakeApiUserKey {
  clientId: string;
  teamId: string;
  keyId: string;
  key: TestKeyPair;
  /** ACL: ad account ID → roles. Mutable (a lost ACL). */
  acl: Map<string, string[]>;
}

export function fakeApiUserKey(
  key: TestKeyPair,
  acl: Record<string, string[]>,
): FakeApiUserKey {
  return {
    clientId: `SEARCHADS.${randomUUID()}`,
    teamId: `SEARCHADS.${randomUUID()}`,
    keyId: randomUUID(),
    key,
    acl: new Map(Object.entries(acl)),
  };
}

export function apiUserCredentials(user: FakeApiUserKey) {
  return {
    clientId: user.clientId,
    teamId: user.teamId,
    keyId: user.keyId,
    privateKey: user.key.privateKeyPem,
  };
}

const API_ROLES = new Set([
  "API Account Read Only",
  "Limited Access: API Read Only",
  "API Account Manager",
  "Limited Access: API Read & Write",
  "Admin",
]);

function reply(status: number, body: unknown): ConnectorResponse {
  const text = JSON.stringify(body);
  return {
    status,
    headers: {
      "content-type": "application/json",
      "ratelimit-limit": "100",
      "ratelimit-remaining": "90",
      "ratelimit-reset": "30",
    },
    text: () => text,
    json: () => JSON.parse(text) as unknown,
    bytes: () => new TextEncoder().encode(text),
  };
}

export interface FakeAppleAdsCall {
  path: string;
  token: string;
  context: string | undefined;
}

export interface FakeAppleAdsServer {
  fetch(url: string, init?: ConnectorFetchInit): Promise<ConnectorResponse>;
  users: FakeApiUserKey[];
  exchanges: number;
  clientSecrets: string[];
  issued: string[];
  /** API calls (not the token endpoint). */
  calls: FakeAppleAdsCall[];
}

export function createFakeAppleAdsServer(
  accounts: FakeAdAccount[],
  users: FakeApiUserKey[],
): FakeAppleAdsServer {
  /** Issued token → its API user. */
  const tokens = new Map<string, FakeApiUserKey>();
  const server: FakeAppleAdsServer = {
    users,
    exchanges: 0,
    clientSecrets: [],
    issued: [],
    calls: [],
    async fetch(raw, init = {}) {
      const url = new URL(raw);
      if (url.href === "https://appleid.apple.com/auth/oauth2/token") {
        const form = new URLSearchParams(init.body ?? "");
        const secret = form.get("client_secret") ?? "";
        server.clientSecrets.push(secret);
        const user = server.users.find(
          (entry) => entry.clientId === form.get("client_id"),
        );
        if (
          init.method !== "POST" ||
          !user ||
          form.get("grant_type") !== "client_credentials" ||
          form.get("scope") !== APPLE_ADS_SCOPE
        ) {
          return reply(400, { error: "invalid_client" });
        }
        let decoded;
        try {
          decoded = decodeJwt(secret, user.key.publicKey);
        } catch {
          return reply(400, { error: "invalid_client" });
        }
        const { header, claims } = decoded;
        if (
          !decoded.verifies ||
          header.alg !== "ES256" ||
          header.kid !== user.keyId ||
          claims.iss !== user.teamId ||
          claims.sub !== user.clientId ||
          claims.aud !== APPLE_ADS_AUDIENCE ||
          typeof claims.exp !== "number" ||
          claims.exp < Math.floor(Date.now() / 1000)
        ) {
          return reply(400, { error: "invalid_client" });
        }
        server.exchanges += 1;
        const token = `apple-ads-test-${randomBytes(18).toString("base64url")}`;
        server.issued.push(token);
        tokens.set(token, user);
        return reply(200, {
          access_token: token,
          token_type: "Bearer",
          expires_in: 3600,
          scope: APPLE_ADS_SCOPE,
        });
      }
      if (url.host !== "api.ads.apple.com") {
        return reply(404, {});
      }
      const headers = init.headers ?? {};
      const token = (headers.authorization ?? "").replace(/^Bearer /, "");
      const context = headers["x-ap-context"];
      server.calls.push({ path: url.pathname, token, context });
      const user = tokens.get(token);
      if (!user) {
        return reply(401, { error: { code: "UNAUTHORIZED", message: "" } });
      }
      if (url.pathname === "/v1/acls") {
        return reply(200, {
          result: {
            acls: [...user.acl].flatMap(([id, roles]) => {
              const account = accounts.find((entry) => entry.id === id);
              return account
                ? [
                    {
                      adAccount: {
                        id: Number(id),
                        name: account.name,
                        orgId: Number(account.orgId),
                      },
                      roles,
                    },
                  ]
                : [];
            }),
          },
        });
      }
      const contextId = /^adAccountId=(\d+)$/.exec(context ?? "")?.[1];
      const roles = contextId ? user.acl.get(contextId) : undefined;
      const account = accounts.find((entry) => entry.id === contextId);
      if (!account || !roles?.some((role) => API_ROLES.has(role))) {
        return reply(403, {
          error: { code: "FORBIDDEN", message: "Insufficient privileges" },
        });
      }
      if (url.pathname === `/v1/ad-accounts/${account.id}`) {
        return reply(200, {
          result: {
            id: Number(account.id),
            name: account.name,
            orgId: Number(account.orgId),
            timezone: account.timezone,
            currency: account.currency,
            systemStatus: "ACTIVE",
            systemStatusReasons: [],
            productFeatures: account.productFeatures,
          },
        });
      }
      if (url.pathname === "/v1/campaigns/query") {
        return reply(200, {
          result: account.campaigns.map((campaign) => ({
            id: Number(campaign.id),
            name: campaign.name,
            adAccountId: Number(account.id),
            promotedObjectType: "APPSTORE_APP",
            promotedObjectId: campaign.appId,
            status: "ENABLED",
            displayStatus: "RUNNING",
            deleted: false,
          })),
          pagination: {
            totalCount: account.campaigns.length,
            offset: 0,
            pageSize: 1000,
          },
        });
      }
      const app = /^\/v1\/apps\/(\d+)$/.exec(url.pathname);
      if (app) {
        return reply(200, {
          result: { id: app[1], appName: `App ${app[1]}` },
        });
      }
      return reply(404, { error: { code: "NOT_FOUND", message: "" } });
    },
  };
  return server;
}
