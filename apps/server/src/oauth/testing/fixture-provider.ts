import { createHash, randomBytes } from "node:crypto";

import type { ConnectorResponse } from "@netrics/connector-sdk";

import type { OAuthHttp } from "../client.js";

// Tests only: an in-process stand-in for an OAuth/OpenID provider (Google's
// endpoints by default) behind the OAuthHttp seam, so server tests run the
// whole authorization-code flow offline (ADR 0012, "Tests"). It plays both
// the consent screen (consent()) and the token and revocation endpoints
// (http). ID tokens are unsigned: the host relies on TLS to the token
// endpoint, not on signatures (oauth/client.ts, verifyIdToken).

export interface FixtureAccount {
  sub: string;
  email: string;
}

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

interface Grant {
  account: FixtureAccount;
  scopes: string[];
  revoked: boolean;
}

export const FIXTURE_ACCOUNT: FixtureAccount = {
  sub: "fixture-sub-1",
  email: "fixture-user@example.com",
};

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

export class FixtureOAuthProvider {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly issuer: string;
  /** Every code, token, ID token and verifier it issued or received. */
  readonly secrets: string[] = [];
  /** Tokens sent to the revocation endpoint. */
  readonly revoked: string[] = [];
  /** Requests per grant type. */
  readonly calls = { authorization_code: 0, refresh_token: 0, revoke: 0 };
  /** Rotate the refresh token on refresh (some providers do). */
  rotateRefreshTokens = false;

  readonly #codes = new Map<string, PendingCode>();
  readonly #refreshTokens = new Map<string, Grant>();
  readonly #accessTokens = new Map<string, Grant>();

  constructor(options: {
    clientId: string;
    clientSecret: string;
    issuer?: string;
  }) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.issuer = options.issuer ?? "https://accounts.google.com";
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

  /** Whether a refresh token still works. */
  isActive(refreshToken: string): boolean {
    const grant = this.#refreshTokens.get(refreshToken);
    return grant !== undefined && !grant.revoked;
  }

  /** The token and revocation endpoints. */
  readonly http: OAuthHttp = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    const form = new URLSearchParams(init.body ?? "");
    if (init.method !== "POST") {
      return json(405, { error: "invalid_request" });
    }
    if (url.pathname.endsWith("/revoke")) {
      this.calls.revoke += 1;
      const value = form.get("token") ?? "";
      this.revoked.push(value);
      const grant =
        this.#refreshTokens.get(value) ?? this.#accessTokens.get(value);
      if (!grant) {
        return json(400, { error: "invalid_token" });
      }
      grant.revoked = true;
      return json(200, {});
    }
    if (!url.pathname.endsWith("/token")) {
      return json(404, { error: "not_found" });
    }
    if (
      form.get("client_id") !== this.clientId ||
      form.get("client_secret") !== this.clientSecret
    ) {
      return json(401, { error: "invalid_client" });
    }
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") {
      this.calls.authorization_code += 1;
      return this.#exchange(form);
    }
    if (grantType === "refresh_token") {
      this.calls.refresh_token += 1;
      return this.#refresh(form);
    }
    return json(400, { error: "unsupported_grant_type" });
  };

  #tokens(grant: Grant, refreshToken: string | null) {
    const accessToken = token("access");
    this.secrets.push(accessToken);
    this.#accessTokens.set(accessToken, grant);
    return {
      access_token: accessToken,
      expires_in: 3599,
      token_type: "Bearer",
      scope: grant.scopes.join(" "),
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
    };
  }

  #exchange(form: URLSearchParams): ConnectorResponse {
    const code = form.get("code") ?? "";
    const pending = this.#codes.get(code);
    // Codes work once.
    this.#codes.delete(code);
    if (!pending || form.get("redirect_uri") !== pending.redirectUri) {
      return json(400, { error: "invalid_grant" });
    }
    this.secrets.push(form.get("code_verifier") ?? "");
    const challenge = createHash("sha256")
      .update(form.get("code_verifier") ?? "", "ascii")
      .digest("base64url");
    if (challenge !== pending.codeChallenge) {
      return json(400, { error: "invalid_grant" });
    }
    const grant: Grant = {
      account: pending.account,
      scopes: pending.scopes,
      revoked: false,
    };
    let refreshToken: string | null = null;
    if (!pending.noRefreshToken) {
      refreshToken = token("refresh");
      this.secrets.push(refreshToken);
      this.#refreshTokens.set(refreshToken, grant);
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
    return json(200, {
      ...this.#tokens(grant, refreshToken),
      id_token: idToken,
    });
  }

  #refresh(form: URLSearchParams): ConnectorResponse {
    const refreshToken = form.get("refresh_token") ?? "";
    const grant = this.#refreshTokens.get(refreshToken);
    if (!grant || grant.revoked) {
      return json(400, { error: "invalid_grant" });
    }
    let rotated: string | null = null;
    if (this.rotateRefreshTokens) {
      rotated = token("refresh");
      this.secrets.push(rotated);
      this.#refreshTokens.delete(refreshToken);
      this.#refreshTokens.set(rotated, grant);
    }
    return json(200, this.#tokens(grant, rotated));
  }
}
