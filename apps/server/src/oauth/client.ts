import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { createEgressFetch } from "@netrics/connector-runtime";
import type {
  ConnectorFetchInit,
  ConnectorResponse,
} from "@netrics/connector-sdk";

import { Secret } from "../secret.js";
import type { ConfiguredOAuthProvider } from "./config.js";
import type { OAuthProviderDefinition } from "./providers/index.js";

// The host side of the authorization-code flow (ADR 0012): authorization
// URL, code exchange, ID token checks and revocation. The HTTP client is a
// dependency, so tests run against an in-process fixture provider.

/** One HTTP call to a provider's token or revocation endpoint. */
export type OAuthHttp = (
  url: string,
  init: ConnectorFetchInit,
) => Promise<ConnectorResponse>;

/** The HTTP client for one provider. */
export type OAuthHttpFactory = (provider: OAuthProviderDefinition) => OAuthHttp;

const TOKEN_CALL_TIMEOUT_MS = 10_000;
const MAX_TOKEN_RESPONSE_BYTES = 256 * 1024;

/**
 * Host-side token calls go through the same guarded fetch as connector code
 * (https only, public addresses, no redirects), limited to the provider's
 * server domains, with a short timeout.
 */
export const providerHttp: OAuthHttpFactory = (provider) => (url, init) =>
  createEgressFetch({
    allowedDomains: provider.serverDomains,
    signal: AbortSignal.timeout(TOKEN_CALL_TIMEOUT_MS),
    maxResponseBytes: MAX_TOKEN_RESPONSE_BYTES,
    maxRedirects: 0,
  })(url, init);

/**
 * A provider refused or failed a step. Carries only a short error code
 * (the provider's `error`, reduced), never a token, code or response body.
 */
export class OAuthError extends Error {
  constructor(
    readonly step: "token_exchange" | "token_refresh" | "id_token",
    readonly code: string,
  ) {
    super(`oauth ${step} failed: ${code}`);
    this.name = "OAuthError";
  }
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/** 256 random bits, base64url: states, nonces and PKCE verifiers. */
export function randomToken(): string {
  return base64url(randomBytes(32));
}

/** How a state is stored: its SHA-256 in hex. */
export function hashState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

/** PKCE S256 (RFC 7636): base64url(SHA-256(verifier)). */
export function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}

export interface AuthorizationRequest {
  state: string;
  nonce: string;
  codeVerifier: string;
  scopes: readonly string[];
}

/** The provider URL the browser is sent to. */
export function buildAuthorizationUrl(
  provider: ConfiguredOAuthProvider,
  request: AuthorizationRequest,
): string {
  const url = new URL(provider.definition.authorizationEndpoint);
  const params = url.searchParams;
  params.set("response_type", "code");
  params.set("client_id", provider.clientId);
  params.set("redirect_uri", provider.redirectUri);
  params.set("scope", request.scopes.join(" "));
  params.set("state", request.state);
  params.set("nonce", request.nonce);
  params.set("code_challenge", pkceChallenge(request.codeVerifier));
  params.set("code_challenge_method", provider.definition.pkce);
  for (const [key, value] of Object.entries(
    provider.definition.authorizationParams,
  )) {
    params.set(key, value);
  }
  return url.toString();
}

/** What a code exchange returns; tokens stay wrapped until stored. */
export interface TokenSet {
  accessToken: Secret;
  /** Null when the provider sent none (Google always does with consent). */
  refreshToken: Secret | null;
  idToken: Secret | null;
  accessTokenExpiresAt: Date;
  /** Granted scopes; null when the provider did not say (= as requested). */
  scopes: string[] | null;
}

const ERROR_CODE = /^[a-z0-9_.-]{1,64}$/i;

/** The provider's `error` if it is a plain code, else the HTTP status. */
function providerErrorCode(response: ConnectorResponse): string {
  try {
    const body = response.json() as { error?: unknown };
    if (typeof body.error === "string" && ERROR_CODE.test(body.error)) {
      return body.error;
    }
  } catch {
    // Not JSON; fall through.
  }
  return `http_${response.status}`;
}

function form(values: Record<string, string>): ConnectorFetchInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(values).toString(),
  };
}

/** Exchanges an authorization code with its PKCE verifier (RFC 6749 4.1.3). */
export async function exchangeCode(
  provider: ConfiguredOAuthProvider,
  http: OAuthHttp,
  input: { code: string; codeVerifier: string; now?: Date },
): Promise<TokenSet> {
  let response: ConnectorResponse;
  try {
    response = await http(
      provider.definition.tokenEndpoint,
      form({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: provider.redirectUri,
        client_id: provider.clientId,
        client_secret: provider.clientSecret.reveal(),
        code_verifier: input.codeVerifier,
      }),
    );
  } catch (error) {
    // Network, egress or timeout: the name only, never the request.
    throw new OAuthError(
      "token_exchange",
      error instanceof Error && ERROR_CODE.test(error.name)
        ? error.name
        : "request_failed",
    );
  }
  if (response.status !== 200) {
    throw new OAuthError("token_exchange", providerErrorCode(response));
  }
  let body: Record<string, unknown>;
  try {
    body = response.json() as Record<string, unknown>;
  } catch {
    throw new OAuthError("token_exchange", "invalid_response");
  }
  const text = (key: string) =>
    typeof body[key] === "string" && body[key] !== ""
      ? (body[key] as string)
      : null;
  const accessToken = text("access_token");
  if (!accessToken || (text("token_type") ?? "").toLowerCase() !== "bearer") {
    throw new OAuthError("token_exchange", "invalid_response");
  }
  const expiresIn =
    typeof body.expires_in === "number" && body.expires_in > 0
      ? body.expires_in
      : 3600;
  const scope = text("scope");
  const refreshToken = text("refresh_token");
  const idToken = text("id_token");
  return {
    accessToken: new Secret(accessToken),
    refreshToken: refreshToken ? new Secret(refreshToken) : null,
    idToken: idToken ? new Secret(idToken) : null,
    accessTokenExpiresAt: new Date(
      (input.now ?? new Date()).getTime() + expiresIn * 1000,
    ),
    scopes: scope ? scope.split(/\s+/).filter((entry) => entry !== "") : null,
  };
}

/** The account an ID token names. */
export interface IdTokenAccount {
  sub: string;
  /** Null when absent or not verified by the provider. */
  email: string | null;
}

const CLOCK_SKEW_SECONDS = 60;

function equalStrings(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Validates the ID token of a code exchange (OpenID Connect Core 3.1.3.7)
 * and returns the account it names.
 *
 * The token comes straight from the provider's token endpoint over TLS (the
 * guarded fetch only speaks https to the provider's own domains), so per
 * 3.1.3.7 step 6 TLS server validation stands in for the signature check;
 * fetching and caching the provider's JWKS would add egress and a key cache
 * without adding assurance here. The claims are checked: `iss` is one of the
 * provider's issuers, `aud` holds our client id (and `azp` names it when
 * there are several audiences), `exp` has not passed, and `nonce` is the one
 * bound into the state.
 */
export function verifyIdToken(
  idToken: Secret | null,
  expected: {
    issuers: readonly string[];
    clientId: string;
    nonce: string;
    now?: Date;
  },
): IdTokenAccount {
  const fail = (code: string): never => {
    throw new OAuthError("id_token", code);
  };
  if (!idToken) {
    return fail("missing");
  }
  const parts = idToken.reveal().split(".");
  if (parts.length !== 3) {
    return fail("malformed");
  }
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    return fail("malformed");
  }
  if (typeof claims !== "object" || claims === null) {
    return fail("malformed");
  }
  if (
    typeof claims.iss !== "string" ||
    !expected.issuers.includes(claims.iss)
  ) {
    return fail("invalid_iss");
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expected.clientId)) {
    return fail("invalid_aud");
  }
  if (audiences.length > 1 && claims.azp !== expected.clientId) {
    return fail("invalid_azp");
  }
  const now = (expected.now ?? new Date()).getTime() / 1000;
  if (
    typeof claims.exp !== "number" ||
    claims.exp + CLOCK_SKEW_SECONDS <= now
  ) {
    return fail("expired");
  }
  if (
    typeof claims.nonce !== "string" ||
    !equalStrings(claims.nonce, expected.nonce)
  ) {
    return fail("invalid_nonce");
  }
  if (typeof claims.sub !== "string" || claims.sub === "") {
    return fail("missing_sub");
  }
  const email =
    typeof claims.email === "string" &&
    claims.email !== "" &&
    claims.email_verified !== false
      ? claims.email
      : null;
  return { sub: claims.sub, email };
}

/**
 * Whether a refresh token still works, by one refresh_token grant. Answers
 * false only for `invalid_grant` (revoked or expired); any other failure
 * throws an OAuthError, so callers fail closed. The new access token is
 * discarded.
 */
export async function isRefreshTokenLive(
  provider: ConfiguredOAuthProvider,
  http: OAuthHttp,
  refreshToken: Secret,
): Promise<boolean> {
  let response: ConnectorResponse;
  try {
    response = await http(
      provider.definition.tokenEndpoint,
      form({
        grant_type: "refresh_token",
        refresh_token: refreshToken.reveal(),
        client_id: provider.clientId,
        client_secret: provider.clientSecret.reveal(),
      }),
    );
  } catch (error) {
    throw new OAuthError(
      "token_refresh",
      error instanceof Error && ERROR_CODE.test(error.name)
        ? error.name
        : "request_failed",
    );
  }
  if (response.status === 200) {
    return true;
  }
  const code = providerErrorCode(response);
  if (code === "invalid_grant") {
    return false;
  }
  throw new OAuthError("token_refresh", code);
}
