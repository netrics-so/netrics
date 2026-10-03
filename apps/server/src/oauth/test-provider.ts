import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { ConnectorResponse } from "@netrics/connector-sdk";
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
import type { OAuthHttp } from "./client.js";
import { OAuthProviders } from "./config.js";
import type { OAuthProviderDefinition } from "./providers/types.js";
import { sealOAuthCredentials } from "./tokens.js";

// Test-only (kept out of the image by package.json "files"): one fixture
// OAuth/OpenID provider that behaves like Google where netrics depends on it
// (ADR 0012, "Tests"), for the authorization flow, the token service and the
// connectors alike. One state, two ways in:
//
// - `http`, an in-process OAuthHttp (the flow's seam, AppDeps.oauthHttp),
//   with any provider definition (Google's endpoints by default);
// - startTestOAuthProvider(): the same provider also served on 127.0.0.1,
//   for the token service's guarded fetch and for fixture connectors.
//
// Endpoints:
// - consent(): the user at the consent screen (approve, deny, untick
//   scopes, choose an account, override ID-token claims, no refresh token);
// - POST …/token: authorization_code (PKCE S256 and redirect_uri checked;
//   an unsigned ID token with iss, aud, azp, sub, email, nonce, exp) and
//   refresh_token (optional rotation, invalid_grant for revoked grants,
//   scope reporting);
// - POST …/revoke: revokes the whole grant of the token's account, every
//   refresh and access token of that account, including ones issued a
//   moment earlier (Google's documented behaviour: "Revocation removes all
//   OAuth 2.0 scopes previously granted to a project, invalidating any
//   issued access or refresh tokens");
// - GET …/api/resource: a provider API answering 200 for a live access token
//   and 401 otherwise.
//
// Tests drive failures and timing with the `next*`/`*DelayMs` switches and
// read the counters.

export const TEST_PROVIDER_ID = "fixture";
export const TEST_CLIENT_ID = "fixture-client-id";
export const TEST_CLIENT_SECRET = "fixture-client-secret-do-not-log";
export const TEST_PROVIDER_ISSUER = "https://fixture.invalid";

export interface FixtureAccount {
  sub: string;
  email: string;
}

export const FIXTURE_ACCOUNT: FixtureAccount = {
  sub: "fixture-sub-1",
  email: "fixture-user@example.com",
};

export interface ConsentOptions {
  account?: FixtureAccount;
  /** Refuse consent (error=access_denied). */
  deny?: boolean;
  /** Scopes the user leaves ticked; default: every requested scope. */
  grantScopes?: string[];
  /** Overrides of ID token claims (wrong aud, nonce, iss, exp…). */
  idTokenClaims?: Record<string, unknown>;
  /** Omit the refresh token from the token response. */
  noRefreshToken?: boolean;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce: string;
  scopes: string[];
  account: FixtureAccount;
  idTokenClaims: Record<string, unknown>;
  noRefreshToken: boolean;
}

/** One account's grant for this client (Google keeps one per account). */
interface Grant {
  sub: string;
  email: string;
  scopes: string[];
  revoked: boolean;
  /** Bumped by every revocation: tokens of an older epoch stay dead. */
  epoch: number;
}

interface IssuedToken {
  sub: string;
  epoch: number;
}

interface Answer {
  status: number;
  body: unknown;
}

function token(prefix: string): string {
  return `${prefix}-${randomBytes(18).toString("base64url")}`;
}

function json(status: number, body: unknown): ConnectorResponse {
  const text = JSON.stringify(body);
  return {
    status,
    headers: { "content-type": "application/json" },
    text: () => text,
    json: () => JSON.parse(text) as unknown,
  };
}

/** An unsigned JWT (alg "none") carrying the claims. */
export function unsignedJwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part(claims)}.`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class FixtureOAuthProvider {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly issuer: string;

  /** Every code, token, ID token and verifier it issued or received. */
  readonly secrets: string[] = [];
  /** Tokens sent to the revocation endpoint, in order of arrival. */
  readonly revoked: string[] = [];
  /** Requests per grant type, and revocations. */
  readonly calls = { authorization_code: 0, refresh_token: 0, revoke: 0 };
  /** Access tokens issued, newest last. */
  readonly accessTokens: string[] = [];

  /** Lifetime of issued access tokens in seconds. */
  accessTokenLifetimeSeconds = 3600;
  /** Issue a new refresh token on every refresh (rotation). */
  rotateRefreshTokens = false;
  /** Delay before answering /token (ms), to widen race windows. */
  tokenDelayMs = 0;
  /**
   * Delay between receiving a revocation and applying it (ms): the request
   * is counted at once, the account's tokens die when it answers.
   */
  revokeDelayMs = 0;
  /** The next /token answers are these OAuth errors (FIFO). */
  readonly nextTokenErrors: Array<{ status: number; error: string }> = [];
  /** The next /revoke answers fail with this status (FIFO). */
  readonly nextRevokeFailures: number[] = [];
  /** The next /api/resource answers are 401 even for live tokens (count). */
  rejectNextApiCalls = 0;

  readonly #codes = new Map<string, PendingCode>();
  readonly #grants = new Map<string, Grant>(); // by sub
  readonly #refreshTokens = new Map<string, IssuedToken>();
  readonly #accessTokens = new Map<
    string,
    IssuedToken & { expiresAt: number }
  >();

  constructor(
    options: { clientId?: string; clientSecret?: string; issuer?: string } = {},
  ) {
    this.clientId = options.clientId ?? TEST_CLIENT_ID;
    this.clientSecret = options.clientSecret ?? TEST_CLIENT_SECRET;
    this.issuer = options.issuer ?? "https://accounts.google.com";
  }

  /** Every refresh_token grant request received. */
  get refreshRequests(): number {
    return this.calls.refresh_token;
  }

  /** Tokens sent to the revocation endpoint (alias of `revoked`). */
  get revocations(): string[] {
    return this.revoked;
  }

  /**
   * Creates (or, like Google with include_granted_scopes, extends) the
   * account's grant and returns a new refresh token for it.
   */
  grant(input: { sub: string; email?: string; scopes: string[] }): string {
    const grant = this.#liveGrant(input.sub, input.email, input.scopes);
    const value = token("fixture-rt");
    this.secrets.push(value);
    this.#refreshTokens.set(value, { sub: grant.sub, epoch: grant.epoch });
    return value;
  }

  /** Narrows the scopes the provider reports for an account's grant. */
  setGrantedScopes(sub: string, scopes: string[]): void {
    const grant = this.#grants.get(sub);
    if (grant) {
      grant.scopes = [...scopes];
    }
  }

  /** Revokes an account's grant (user removed access, or /revoke). */
  revokeAccount(sub: string): void {
    const grant = this.#grants.get(sub);
    if (grant) {
      grant.revoked = true;
      grant.epoch += 1;
    }
  }

  /** Whether the account has no live grant. */
  isRevoked(sub: string): boolean {
    return this.#grants.get(sub)?.revoked ?? true;
  }

  /** Whether a refresh token still works. */
  isActive(refreshToken: string): boolean {
    const issued = this.#refreshTokens.get(refreshToken);
    return issued !== undefined && this.#live(issued);
  }

  /**
   * The user at the consent screen for `authorizationUrl`: returns the query
   * the provider redirects back with.
   */
  consent(
    authorizationUrl: string,
    options: ConsentOptions = {},
  ): { state: string; code?: string; error?: string } {
    const url = new URL(authorizationUrl);
    const param = (key: string) => url.searchParams.get(key) ?? "";
    const state = param("state");
    if (options.deny) {
      return { state, error: "access_denied" };
    }
    if (
      param("response_type") !== "code" ||
      param("client_id") !== this.clientId
    ) {
      return { state, error: "invalid_request" };
    }
    if (param("code_challenge_method") !== "S256" || !param("code_challenge")) {
      return { state, error: "invalid_request" };
    }
    const requested = param("scope").split(" ").filter(Boolean);
    const code = token("code");
    this.secrets.push(code);
    this.#codes.set(code, {
      clientId: param("client_id"),
      redirectUri: param("redirect_uri"),
      codeChallenge: param("code_challenge"),
      nonce: param("nonce"),
      scopes: options.grantScopes ?? requested,
      account: options.account ?? FIXTURE_ACCOUNT,
      idTokenClaims: options.idTokenClaims ?? {},
      noRefreshToken: options.noRefreshToken ?? false,
    });
    return { state, code };
  }

  /** The provider's endpoints in process (the flow's OAuthHttp seam). */
  readonly http: OAuthHttp = async (rawUrl, init) => {
    const answer = await this.handle(
      init.method ?? "GET",
      new URL(rawUrl).pathname,
      new URLSearchParams(init.body ?? ""),
      init.headers?.authorization ?? init.headers?.Authorization,
    );
    return json(answer.status, answer.body);
  };

  /** One request to the provider, by path suffix. */
  async handle(
    method: string,
    pathname: string,
    form: URLSearchParams,
    authorization?: string,
  ): Promise<Answer> {
    if (method === "GET" && pathname.endsWith("/api/resource")) {
      return this.#resource(authorization);
    }
    if (method !== "POST") {
      return { status: 405, body: { error: "invalid_request" } };
    }
    if (pathname.endsWith("/revoke")) {
      return this.#revoke(form);
    }
    if (!pathname.endsWith("/token")) {
      return { status: 404, body: { error: "not_found" } };
    }
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") {
      this.calls.authorization_code += 1;
    } else if (grantType === "refresh_token") {
      this.calls.refresh_token += 1;
    }
    if (this.tokenDelayMs > 0) {
      await sleep(this.tokenDelayMs);
    }
    const injected = this.nextTokenErrors.shift();
    if (injected) {
      return {
        status: injected.status,
        body: {
          error: injected.error,
          error_description: "injected by the test provider",
        },
      };
    }
    if (
      form.get("client_id") !== this.clientId ||
      form.get("client_secret") !== this.clientSecret
    ) {
      return { status: 401, body: { error: "invalid_client" } };
    }
    if (grantType === "authorization_code") {
      return this.#exchange(form);
    }
    if (grantType === "refresh_token") {
      return this.#refresh(form);
    }
    return { status: 400, body: { error: "unsupported_grant_type" } };
  }

  #live(issued: IssuedToken): boolean {
    const grant = this.#grants.get(issued.sub);
    return (
      grant !== undefined && !grant.revoked && grant.epoch === issued.epoch
    );
  }

  #liveGrant(sub: string, email: string | undefined, scopes: string[]): Grant {
    const existing = this.#grants.get(sub);
    if (existing && !existing.revoked) {
      existing.scopes = [...new Set([...existing.scopes, ...scopes])];
      if (email) {
        existing.email = email;
      }
      return existing;
    }
    const grant: Grant = {
      sub,
      email: email ?? `${sub}@example.com`,
      scopes: [...scopes],
      revoked: false,
      epoch: (existing?.epoch ?? 0) + 1,
    };
    this.#grants.set(sub, grant);
    return grant;
  }

  #issueAccessToken(grant: Grant): string {
    const value = token("fixture-at");
    this.secrets.push(value);
    this.accessTokens.push(value);
    this.#accessTokens.set(value, {
      sub: grant.sub,
      epoch: grant.epoch,
      expiresAt: Date.now() + this.accessTokenLifetimeSeconds * 1000,
    });
    return value;
  }

  #exchange(form: URLSearchParams): Answer {
    const code = form.get("code") ?? "";
    const pending = this.#codes.get(code);
    // Codes work once.
    this.#codes.delete(code);
    if (!pending || form.get("redirect_uri") !== pending.redirectUri) {
      return { status: 400, body: { error: "invalid_grant" } };
    }
    const verifier = form.get("code_verifier") ?? "";
    this.secrets.push(verifier);
    const challenge = createHash("sha256")
      .update(verifier, "ascii")
      .digest("base64url");
    if (challenge !== pending.codeChallenge) {
      return { status: 400, body: { error: "invalid_grant" } };
    }
    // The token response reports the scopes of this consent; the account's
    // grant accumulates them (include_granted_scopes).
    const grant = this.#liveGrant(
      pending.account.sub,
      pending.account.email,
      pending.scopes,
    );
    let refreshToken: string | null = null;
    if (!pending.noRefreshToken) {
      refreshToken = token("fixture-rt");
      this.secrets.push(refreshToken);
      this.#refreshTokens.set(refreshToken, {
        sub: grant.sub,
        epoch: grant.epoch,
      });
    }
    const now = Math.floor(Date.now() / 1000);
    const idToken = unsignedJwt({
      iss: this.issuer,
      aud: pending.clientId,
      azp: pending.clientId,
      sub: pending.account.sub,
      email: pending.account.email,
      email_verified: true,
      nonce: pending.nonce,
      iat: now,
      exp: now + 3600,
      ...pending.idTokenClaims,
    });
    this.secrets.push(idToken);
    return {
      status: 200,
      body: {
        access_token: this.#issueAccessToken(grant),
        expires_in: this.accessTokenLifetimeSeconds,
        token_type: "Bearer",
        scope: pending.scopes.join(" "),
        ...(refreshToken ? { refresh_token: refreshToken } : {}),
        id_token: idToken,
      },
    };
  }

  #refresh(form: URLSearchParams): Answer {
    const value = form.get("refresh_token") ?? "";
    const issued = this.#refreshTokens.get(value);
    const grant = issued ? this.#grants.get(issued.sub) : undefined;
    if (!issued || !grant || !this.#live(issued)) {
      return {
        status: 400,
        body: {
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
        },
      };
    }
    const body: Record<string, unknown> = {
      access_token: this.#issueAccessToken(grant),
      expires_in: this.accessTokenLifetimeSeconds,
      scope: grant.scopes.join(" "),
      token_type: "Bearer",
    };
    if (this.rotateRefreshTokens) {
      const rotated = token("fixture-rt");
      this.secrets.push(rotated);
      this.#refreshTokens.delete(value);
      this.#refreshTokens.set(rotated, issued);
      body.refresh_token = rotated;
    }
    return { status: 200, body };
  }

  async #revoke(form: URLSearchParams): Promise<Answer> {
    this.calls.revoke += 1;
    const value = form.get("token") ?? "";
    this.revoked.push(value);
    const failure = this.nextRevokeFailures.shift();
    if (failure !== undefined) {
      return { status: failure, body: { error: "server_error" } };
    }
    if (this.revokeDelayMs > 0) {
      await sleep(this.revokeDelayMs);
    }
    const issued =
      this.#refreshTokens.get(value) ?? this.#accessTokens.get(value);
    if (!issued) {
      return { status: 400, body: { error: "invalid_token" } };
    }
    // The whole grant of the account, whatever the token's epoch.
    this.revokeAccount(issued.sub);
    return { status: 200, body: {} };
  }

  #resource(authorization: string | undefined): Answer {
    const bearer = /^Bearer (.+)$/.exec(authorization ?? "")?.[1];
    const issued = bearer ? this.#accessTokens.get(bearer) : undefined;
    const unauthenticated = {
      status: 401,
      body: { error: { code: 401, status: "UNAUTHENTICATED" } },
    };
    if (this.rejectNextApiCalls > 0) {
      this.rejectNextApiCalls -= 1;
      return unauthenticated;
    }
    if (!issued || issued.expiresAt <= Date.now() || !this.#live(issued)) {
      return unauthenticated;
    }
    return { status: 200, body: { ok: true, sub: issued.sub } };
  }
}

/** The fixture provider, also served on 127.0.0.1. */
export interface TestOAuthProvider extends FixtureOAuthProvider {
  /** http://127.0.0.1:<port> */
  readonly origin: string;
  /** A definition pointing at this server (serverDomains: 127.0.0.1). */
  readonly definition: OAuthProviderDefinition;
  close(): Promise<void>;
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Starts the fixture provider on 127.0.0.1 with the test client and issuer;
 * `http` and the server share its state.
 */
export async function startTestOAuthProvider(): Promise<TestOAuthProvider> {
  const provider = new FixtureOAuthProvider({
    clientId: TEST_CLIENT_ID,
    clientSecret: TEST_CLIENT_SECRET,
    issuer: TEST_PROVIDER_ISSUER,
  });
  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const answer = await provider.handle(
        request.method ?? "GET",
        url.pathname,
        await readForm(request),
        request.headers.authorization,
      );
      response.writeHead(answer.status, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify(answer.body));
    })().catch(() => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "server_error" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const definition: OAuthProviderDefinition = {
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
  };
  return Object.assign(provider, {
    origin,
    definition,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}

/** The instance's providers with only the test provider configured. */
export function testOAuthProviders(
  provider: Pick<TestOAuthProvider, "definition">,
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
