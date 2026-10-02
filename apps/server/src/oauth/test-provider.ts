import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { eq } from "drizzle-orm";
import {
  schema,
  upsertConnectionOAuth,
  withWorkspace,
  type Database,
} from "@netrics/database";
import pino, { type Logger } from "pino";

import {
  encryptOAuthAccessToken,
  type CredentialKeyring,
} from "../credentials.js";
import { Secret } from "../secret.js";
import { OAuthProviders } from "./config.js";
import type { OAuthProviderDefinition } from "./providers/types.js";
import { sealOAuthCredentials } from "./tokens.js";

// Test-only (kept out of the image by package.json "files"): an in-process
// OAuth provider that behaves like Google where netrics depends on it
// (ADR 0012). It serves, on 127.0.0.1:
//
// - POST /token: grant_type=refresh_token (refresh, optional rotation,
//   invalid_grant for unknown or revoked grants, scope reporting) and
//   grant_type=authorization_code (codes issued with issueCode(); the
//   response carries an unsigned ID token with iss, aud, sub, email, nonce);
// - POST /revoke: revokes the whole grant of the token's account, every
//   refresh and access token of that account (Google's documented behaviour:
//   "Revocation removes all OAuth 2.0 scopes previously granted to a
//   project, invalidating any issued access or refresh tokens");
// - GET /api/resource: a provider API that answers 200 for a live access
//   token and 401 otherwise, for fixture connectors.
//
// Tests drive failures with the `next*` switches and read the counters.

export const TEST_PROVIDER_ID = "fixture";
export const TEST_CLIENT_ID = "fixture-client-id";
export const TEST_CLIENT_SECRET = "fixture-client-secret-do-not-log";
export const TEST_PROVIDER_ISSUER = "https://fixture.invalid";

interface Grant {
  sub: string;
  email: string;
  scopes: string[];
  revoked: boolean;
}

interface IssuedCode {
  sub: string;
  email: string;
  scopes: string[];
  nonce: string;
  codeVerifier?: string;
}

export interface TestOAuthProvider {
  /** http://127.0.0.1:<port> */
  readonly origin: string;
  /** A definition pointing at this server (serverDomains: 127.0.0.1). */
  readonly definition: OAuthProviderDefinition;
  /** Every refresh_token grant request received. */
  refreshRequests: number;
  /** Every revocation request received (token values, in order). */
  readonly revocations: string[];
  /** Access tokens issued, newest last. */
  readonly accessTokens: string[];
  /** Lifetime of issued access tokens in seconds (default 3600). */
  accessTokenLifetimeSeconds: number;
  /** Issue a new refresh token on every refresh (rotation). */
  rotateRefreshTokens: boolean;
  /** Delay before answering /token (ms), to widen race windows. */
  tokenDelayMs: number;
  /** The next /token answers are these OAuth errors (FIFO). */
  readonly nextTokenErrors: Array<{ status: number; error: string }>;
  /** The next /revoke answers fail with this status (FIFO). */
  readonly nextRevokeFailures: number[];
  /** The next /api/resource answers are 401 even for live tokens (count). */
  rejectNextApiCalls: number;
  /** Creates a grant and returns its refresh token. */
  grant(input: { sub: string; email?: string; scopes: string[] }): string;
  /** Narrows the scopes the provider reports for an account's grant. */
  setGrantedScopes(sub: string, scopes: string[]): void;
  /** Revokes an account's grant out of band (user removed access). */
  revokeAccount(sub: string): void;
  /** Whether the account's grant is still live. */
  isRevoked(sub: string): boolean;
  /** An authorization code for grant_type=authorization_code. */
  issueCode(input: {
    sub: string;
    email?: string;
    scopes: string[];
    nonce: string;
    codeVerifier?: string;
  }): string;
  close(): Promise<void>;
}

function token(prefix: string): string {
  return `${prefix}-${randomBytes(18).toString("base64url")}`;
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export async function startTestOAuthProvider(): Promise<TestOAuthProvider> {
  const grants = new Map<string, Grant>(); // by sub
  const refreshTokens = new Map<string, string>(); // token -> sub
  const accessTokens = new Map<string, { sub: string; expiresAt: number }>();
  const codes = new Map<string, IssuedCode>();

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  function issueAccessToken(sub: string): string {
    const value = token("fixture-at");
    accessTokens.set(value, {
      sub,
      expiresAt: Date.now() + state.accessTokenLifetimeSeconds * 1000,
    });
    state.accessTokens.push(value);
    return value;
  }

  const server: Server = createServer((request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "POST" && url.pathname === "/token") {
        const form = await readForm(request);
        if (form.get("grant_type") === "refresh_token") {
          state.refreshRequests += 1;
        }
        if (state.tokenDelayMs > 0) {
          await sleep(state.tokenDelayMs);
        }
        const injected = state.nextTokenErrors.shift();
        if (injected) {
          return send(injected.status, {
            error: injected.error,
            error_description: "injected by the test provider",
          });
        }
        if (
          form.get("client_id") !== TEST_CLIENT_ID ||
          form.get("client_secret") !== TEST_CLIENT_SECRET
        ) {
          return send(401, { error: "invalid_client" });
        }
        if (form.get("grant_type") === "refresh_token") {
          const sub = refreshTokens.get(form.get("refresh_token") ?? "");
          const grant = sub ? grants.get(sub) : undefined;
          if (!sub || !grant || grant.revoked) {
            return send(400, {
              error: "invalid_grant",
              error_description: "Token has been expired or revoked.",
            });
          }
          const body: Record<string, unknown> = {
            access_token: issueAccessToken(sub),
            expires_in: state.accessTokenLifetimeSeconds,
            scope: grant.scopes.join(" "),
            token_type: "Bearer",
          };
          if (state.rotateRefreshTokens) {
            const rotated = token("fixture-rt");
            refreshTokens.delete(form.get("refresh_token")!);
            refreshTokens.set(rotated, sub);
            body.refresh_token = rotated;
          }
          return send(200, body);
        }
        if (form.get("grant_type") === "authorization_code") {
          const code = codes.get(form.get("code") ?? "");
          codes.delete(form.get("code") ?? "");
          if (
            !code ||
            (code.codeVerifier !== undefined &&
              code.codeVerifier !== form.get("code_verifier"))
          ) {
            return send(400, { error: "invalid_grant" });
          }
          const refreshToken = state.grant(code);
          const now = Math.floor(Date.now() / 1000);
          const idToken = [
            base64url({ alg: "none", typ: "JWT" }),
            base64url({
              iss: TEST_PROVIDER_ISSUER,
              aud: TEST_CLIENT_ID,
              sub: code.sub,
              email: code.email,
              nonce: code.nonce,
              iat: now,
              exp: now + 3600,
            }),
            "",
          ].join(".");
          return send(200, {
            access_token: issueAccessToken(code.sub),
            refresh_token: refreshToken,
            expires_in: state.accessTokenLifetimeSeconds,
            scope: code.scopes.join(" "),
            token_type: "Bearer",
            id_token: idToken,
          });
        }
        return send(400, { error: "unsupported_grant_type" });
      }
      if (request.method === "POST" && url.pathname === "/revoke") {
        const form = await readForm(request);
        const value = form.get("token") ?? "";
        state.revocations.push(value);
        const failure = state.nextRevokeFailures.shift();
        if (failure !== undefined) {
          return send(failure, { error: "server_error" });
        }
        const sub = refreshTokens.get(value) ?? accessTokens.get(value)?.sub;
        if (!sub) {
          return send(400, { error: "invalid_token" });
        }
        state.revokeAccount(sub);
        return send(200, {});
      }
      if (request.method === "GET" && url.pathname === "/api/resource") {
        const bearer = /^Bearer (.+)$/.exec(
          request.headers.authorization ?? "",
        )?.[1];
        const issued = bearer ? accessTokens.get(bearer) : undefined;
        if (state.rejectNextApiCalls > 0) {
          state.rejectNextApiCalls -= 1;
          return send(401, { error: { code: 401, status: "UNAUTHENTICATED" } });
        }
        if (
          !issued ||
          issued.expiresAt <= Date.now() ||
          grants.get(issued.sub)?.revoked !== false
        ) {
          return send(401, { error: { code: 401, status: "UNAUTHENTICATED" } });
        }
        return send(200, { ok: true, sub: issued.sub });
      }
      return send(404, { error: "not_found" });
    })().catch(() => send(500, { error: "server_error" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  const state: TestOAuthProvider = {
    origin,
    definition: {
      id: TEST_PROVIDER_ID,
      name: "Fixture",
      authorizationEndpoint: `${origin}/authorize`,
      tokenEndpoint: `${origin}/token`,
      revocationEndpoint: `${origin}/revoke`,
      pkce: "S256",
      openIdConnect: { issuers: [TEST_PROVIDER_ISSUER] },
      identityScopes: ["openid", "email"],
      authorizationParams: { access_type: "offline", prompt: "consent" },
      serverDomains: ["127.0.0.1"],
      accountPermissionsUrl: `${origin}/permissions`,
    },
    refreshRequests: 0,
    revocations: [],
    accessTokens: [],
    accessTokenLifetimeSeconds: 3600,
    rotateRefreshTokens: false,
    tokenDelayMs: 0,
    nextTokenErrors: [],
    nextRevokeFailures: [],
    rejectNextApiCalls: 0,
    grant({ sub, email, scopes }) {
      const existing = grants.get(sub);
      // Like Google with include_granted_scopes: a new consent adds scopes
      // to the account's one grant for this client.
      grants.set(sub, {
        sub,
        email: email ?? `${sub}@example.com`,
        scopes: [
          ...new Set([
            ...(existing?.revoked ? [] : (existing?.scopes ?? [])),
            ...scopes,
          ]),
        ],
        revoked: false,
      });
      const value = token("fixture-rt");
      refreshTokens.set(value, sub);
      return value;
    },
    setGrantedScopes(sub, scopes) {
      const grant = grants.get(sub);
      if (grant) {
        grant.scopes = [...scopes];
      }
    },
    revokeAccount(sub) {
      const grant = grants.get(sub);
      if (grant) {
        grant.revoked = true;
      }
      for (const [value, owner] of refreshTokens) {
        if (owner === sub) {
          refreshTokens.delete(value);
        }
      }
    },
    isRevoked(sub) {
      return grants.get(sub)?.revoked ?? true;
    },
    issueCode(input) {
      const value = token("fixture-code");
      codes.set(value, {
        sub: input.sub,
        email: input.email ?? `${input.sub}@example.com`,
        scopes: input.scopes,
        nonce: input.nonce,
        ...(input.codeVerifier !== undefined
          ? { codeVerifier: input.codeVerifier }
          : {}),
      });
      return value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  return state;
}

/** The instance's providers with only the test provider configured. */
export function testOAuthProviders(
  provider: TestOAuthProvider,
): OAuthProviders {
  return new OAuthProviders(
    [
      {
        definition: provider.definition,
        clientId: TEST_CLIENT_ID,
        clientSecret: new Secret(TEST_CLIENT_SECRET),
        redirectUri: `http://localhost:3000/oauth/${TEST_PROVIDER_ID}/callback`,
      },
    ],
    new Map([[provider.definition.id, provider.definition]]),
  );
}

/** Egress options that let the token service reach the test provider. */
export const TEST_PROVIDER_EGRESS = {
  allowInsecureHttp: true,
  allowPrivateAddresses: true,
} as const;

/**
 * An OAuth connection as the authorization callback leaves it (ADR 0012):
 * the refresh token in the credentials envelope, the grant in
 * connection_oauth, optionally a cached access token.
 */
export async function seedOAuthConnection(
  db: Database,
  keyring: CredentialKeyring,
  input: {
    workspaceId: string;
    connectorId: string;
    refreshToken: string;
    sub: string;
    grantedScopes: string[];
    provider?: string;
    accessToken?: { value: string; expiresAt: Date };
  },
): Promise<string> {
  const { workspaceId } = input;
  return withWorkspace(db, { workspaceId }, async (tx) => {
    const [row] = await tx
      .insert(schema.connections)
      .values({
        workspaceId,
        connectorId: input.connectorId,
        name: `${input.connectorId} via ${input.sub}`,
        config: {},
      })
      .returning({ id: schema.connections.id });
    const connectionId = row!.id;
    const binding = { workspaceId, connectionId };
    await tx
      .update(schema.connections)
      .set({
        credentialsEncrypted: sealOAuthCredentials(
          input.refreshToken,
          keyring,
          binding,
        ),
      })
      .where(eq(schema.connections.id, connectionId));
    await tx
      .insert(schema.connectionState)
      .values({ connectionId, workspaceId, pollIntervalSeconds: 300 });
    await upsertConnectionOAuth(tx, {
      workspaceId,
      connectionId,
      provider: input.provider ?? TEST_PROVIDER_ID,
      accountSub: input.sub,
      accountEmail: `${input.sub}@example.com`,
      grantedScopes: input.grantedScopes,
      accessTokenEncrypted: input.accessToken
        ? Buffer.from(
            encryptOAuthAccessToken(input.accessToken.value, keyring, binding),
            "utf8",
          )
        : null,
      accessTokenExpiresAt: input.accessToken?.expiresAt ?? null,
    });
    return connectionId;
  });
}

/** A pino logger whose lines land in `lines`, for no-token assertions. */
export function capturingLogger(lines: string[]): Logger {
  return pino(
    { level: "debug" },
    {
      write(line: string) {
        lines.push(line);
      },
    },
  );
}
