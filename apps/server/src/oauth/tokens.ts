import {
  createEgressFetch,
  type EgressOptions,
} from "@netrics/connector-runtime";
import type {
  ConnectorFetchInit,
  ConnectorResponse,
} from "@netrics/connector-sdk";
import {
  findConnectionOAuth,
  lockConnectionOAuth,
  markNeedsReauthorization,
  updateConnectionOAuthTokens,
  withWorkspace,
  type ConnectionOAuthRow,
  type Database,
  type OAuthAuthReason,
} from "@netrics/database";
import type { Logger } from "pino";

import {
  decryptCredentials,
  decryptOAuthAccessToken,
  encryptCredentials,
  encryptOAuthAccessToken,
  type CredentialBinding,
  type CredentialKeyring,
} from "../credentials.js";
import type { OAuthHttpFactory } from "./client.js";
import type { ConfiguredOAuthProvider, OAuthProviders } from "./config.js";

// The host-side token lifecycle of OAuth connections (ADR 0012). Connector
// code only ever receives a short-lived access token; the refresh token and
// the client secret stay here.
//
// - A cached access token valid for at least REFRESH_MARGIN_MS more is used
//   as is.
// - Otherwise the connection_oauth row is locked (SELECT ... FOR UPDATE),
//   read again, and refreshed only if it is still stale; the new access token
//   (and a rotated refresh token) are stored and committed. Concurrent
//   callers wait on the lock and then find the fresh token, so the provider
//   sees one refresh. The refresh request has a short timeout, so the lock
//   is never held for long.
// - invalid_grant moves the connection to needs_reauthorization
//   (invalid_grant); granted scopes that no longer cover the connector's
//   move it to needs_reauthorization (scope_missing).
// - Token calls go through the guarded egress fetch, limited to the
//   provider's serverDomains (Google: oauth2.googleapis.com).
//
// Nothing here logs or throws token material: provider errors are reduced to
// their OAuth `error` code.

/** Refresh when the cached token has less than this left (ADR 0012). */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_REFRESH_TIMEOUT_MS = 10_000;
const DEFAULT_REVOKE_TIMEOUT_MS = 5_000;
/** When a token response omits expires_in. */
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

/**
 * Why a token could not be obtained without user action:
 * `configuration` means the instance lacks the provider (or the provider
 * refused our client); `transient` is a network or provider failure that a
 * retry may fix.
 */
export class OAuthTokenError extends Error {
  readonly kind: "transient" | "configuration";

  constructor(kind: "transient" | "configuration", message: string) {
    super(message);
    this.name = "OAuthTokenError";
    this.kind = kind;
  }
}

/**
 * The refresh token in connections.credentials_encrypted: the credentials
 * envelope of an OAuth connection holds `{ "refreshToken": "..." }`.
 */
export interface OAuthCredentials {
  refreshToken: string;
}

/** Seals a refresh token as the connection's credentials envelope. */
export function sealOAuthCredentials(
  refreshToken: string,
  keyring: CredentialKeyring,
  binding: CredentialBinding,
): Buffer {
  return Buffer.from(
    encryptCredentials(
      JSON.stringify({ refreshToken } satisfies OAuthCredentials),
      keyring,
      binding,
    ),
    "utf8",
  );
}

/** Opens the refresh token of an OAuth connection's credentials envelope. */
export function openOAuthCredentials(
  envelope: Buffer,
  keyring: CredentialKeyring,
  binding: CredentialBinding,
): string {
  const parsed = JSON.parse(
    decryptCredentials(envelope.toString("utf8"), keyring, binding),
  ) as Partial<OAuthCredentials>;
  if (typeof parsed.refreshToken !== "string" || !parsed.refreshToken) {
    throw new OAuthTokenError(
      "configuration",
      "oauth connection has no refresh token; reauthorize the connection",
    );
  }
  return parsed.refreshToken;
}

export type AccessTokenResult =
  | {
      ok: true;
      accessToken: string;
      /** True when this call refreshed the token at the provider. */
      refreshed: boolean;
    }
  | { ok: false; reason: OAuthAuthReason };

export interface GetAccessTokenOptions {
  /** The connector's scopes for this provider (manifest oauth2 strategy). */
  requiredScopes: readonly string[];
}

type TokenFetch = (
  url: string,
  init: ConnectorFetchInit,
  timeoutMs: number,
) => Promise<ConnectorResponse>;

export interface OAuthTokenServiceDeps {
  db: Database;
  credentialKeyring: CredentialKeyring;
  providers: OAuthProviders;
  logger?: Logger;
  now?: () => Date;
  refreshTimeoutMs?: number;
  revokeTimeoutMs?: number;
  /**
   * Tests only: the provider HTTP of the authorization flow (OAuthHttp),
   * so one in-process fixture provider serves both. Replaces the guarded
   * fetch (and its timeouts).
   */
  http?: OAuthHttpFactory;
  /** Tests only: reach a local fixture provider (see EgressOptions). */
  egress?: Pick<
    EgressOptions,
    "lookup" | "allowPrivateAddresses" | "allowInsecureHttp"
  >;
}

/** An OAuth `error` code, or a placeholder for anything else. */
function errorCode(body: unknown): string {
  const code =
    body && typeof body === "object" && "error" in body
      ? (body as { error: unknown }).error
      : undefined;
  return typeof code === "string" && /^[a-z_]{1,64}$/.test(code)
    ? code
    : "unknown_error";
}

function covers(granted: readonly string[], required: readonly string[]) {
  const set = new Set(granted);
  return required.every((scope) => set.has(scope));
}

export function createOAuthTokenService(deps: OAuthTokenServiceDeps) {
  const { db, credentialKeyring: keyring, providers } = deps;
  const now = deps.now ?? (() => new Date());
  const refreshTimeoutMs = deps.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
  const revokeTimeoutMs = deps.revokeTimeoutMs ?? DEFAULT_REVOKE_TIMEOUT_MS;

  /** The guarded egress fetch, limited to the provider's server domains. */
  function providerFetch(provider: ConfiguredOAuthProvider): TokenFetch {
    const injected = deps.http?.(provider.definition);
    if (injected) {
      return (url, init) => injected(url, init);
    }
    return (url, init, timeoutMs) =>
      createEgressFetch({
        ...deps.egress,
        allowedDomains: provider.definition.serverDomains,
        signal: AbortSignal.timeout(timeoutMs),
        maxRedirects: 0,
        maxResponseBytes: 64 * 1024,
      })(url, init);
  }

  function configured(providerId: string): ConfiguredOAuthProvider {
    const provider = providers.get(providerId);
    if (!provider) {
      throw new OAuthTokenError(
        "configuration",
        `oauth provider "${providerId}" is not configured on this instance`,
      );
    }
    return provider;
  }

  /** The cached token when it is valid for long enough, else null. */
  function cached(row: ConnectionOAuthRow, binding: CredentialBinding) {
    if (
      !row.accessTokenEncrypted ||
      !row.accessTokenExpiresAt ||
      row.accessTokenExpiresAt.getTime() - now().getTime() < REFRESH_MARGIN_MS
    ) {
      return null;
    }
    return decryptOAuthAccessToken(
      row.accessTokenEncrypted.toString("utf8"),
      keyring,
      binding,
    );
  }

  type RefreshOutcome =
    | {
        ok: true;
        accessToken: string;
        expiresInSeconds: number;
        scopes: string[] | null;
        refreshToken: string | null;
      }
    | { ok: false; reason: "invalid_grant" };

  async function refreshAtProvider(
    provider: ConfiguredOAuthProvider,
    refreshToken: string,
  ): Promise<RefreshOutcome> {
    let response: ConnectorResponse;
    try {
      response = await providerFetch(provider)(
        provider.definition.tokenEndpoint,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: provider.clientId,
            client_secret: provider.clientSecret.reveal(),
          }).toString(),
        },
        refreshTimeoutMs,
      );
    } catch (error) {
      // Network failures, timeouts and egress denials carry no token
      // material, but keep only their name to be sure.
      const name = error instanceof Error ? error.name : "Error";
      throw new OAuthTokenError(
        "transient",
        `oauth token refresh failed: ${name}`,
      );
    }
    let body: unknown;
    try {
      body = response.json();
    } catch {
      body = undefined;
    }
    if (response.status === 200) {
      const parsed = (body ?? {}) as Record<string, unknown>;
      if (typeof parsed.access_token !== "string" || !parsed.access_token) {
        throw new OAuthTokenError(
          "transient",
          "oauth token refresh failed: malformed token response",
        );
      }
      return {
        ok: true,
        accessToken: parsed.access_token,
        expiresInSeconds:
          typeof parsed.expires_in === "number" && parsed.expires_in > 0
            ? parsed.expires_in
            : DEFAULT_EXPIRES_IN_SECONDS,
        scopes:
          typeof parsed.scope === "string"
            ? parsed.scope.split(" ").filter(Boolean)
            : null,
        refreshToken:
          typeof parsed.refresh_token === "string" && parsed.refresh_token
            ? parsed.refresh_token
            : null,
      };
    }
    const code = errorCode(body);
    if (code === "invalid_grant") {
      return { ok: false, reason: "invalid_grant" };
    }
    // invalid_client / unauthorized_client: the instance's OAuth app is
    // misconfigured (secret rotated, client deleted), not the user's grant.
    const kind =
      code === "invalid_client" || code === "unauthorized_client"
        ? "configuration"
        : "transient";
    throw new OAuthTokenError(
      kind,
      `oauth token refresh failed: provider answered ${response.status} (${code})`,
    );
  }

  return {
    /**
     * A valid access token for an OAuth connection, refreshed if needed
     * (serialized per connection). Returns `{ ok: false }` after moving the
     * connection to needs_reauthorization. Throws OAuthTokenError for
     * transient and configuration failures, and when the connection has no
     * OAuth grant.
     */
    async getAccessToken(
      binding: CredentialBinding,
      options: GetAccessTokenOptions,
    ): Promise<AccessTokenResult> {
      const { workspaceId, connectionId } = binding;
      const fast = await withWorkspace(db, { workspaceId }, async (tx) => {
        const row = await findConnectionOAuth(tx, workspaceId, connectionId);
        if (!row) {
          return null;
        }
        if (!covers(row.grantedScopes, options.requiredScopes)) {
          await markNeedsReauthorization(
            tx,
            workspaceId,
            connectionId,
            "scope_missing",
          );
          return { ok: false as const, reason: "scope_missing" as const };
        }
        const token = cached(row, binding);
        return token
          ? { ok: true as const, accessToken: token, refreshed: false }
          : { stale: true as const };
      });
      if (!fast) {
        throw new OAuthTokenError(
          "configuration",
          "connection has no oauth grant",
        );
      }
      if (!("stale" in fast)) {
        return fast;
      }

      return withWorkspace(db, { workspaceId }, async (tx) => {
        const locked = await lockConnectionOAuth(tx, workspaceId, connectionId);
        if (!locked) {
          throw new OAuthTokenError(
            "configuration",
            "connection has no oauth grant",
          );
        }
        // Another caller may have refreshed while this one waited.
        const token = cached(locked.oauth, binding);
        if (token) {
          return { ok: true as const, accessToken: token, refreshed: false };
        }
        const provider = configured(locked.oauth.provider);
        if (!locked.credentialsEncrypted) {
          throw new OAuthTokenError(
            "configuration",
            "oauth connection has no refresh token; reauthorize the connection",
          );
        }
        const refreshToken = openOAuthCredentials(
          locked.credentialsEncrypted,
          keyring,
          binding,
        );
        const outcome = await refreshAtProvider(provider, refreshToken);
        if (!outcome.ok) {
          await updateConnectionOAuthTokens(tx, workspaceId, connectionId, {
            accessTokenEncrypted: null,
            accessTokenExpiresAt: null,
          });
          await markNeedsReauthorization(
            tx,
            workspaceId,
            connectionId,
            "invalid_grant",
          );
          deps.logger?.warn(
            { connectionId, provider: provider.definition.id },
            "oauth grant rejected (invalid_grant); connection needs reauthorization",
          );
          return { ok: false as const, reason: "invalid_grant" as const };
        }
        const grantedScopes = outcome.scopes ?? locked.oauth.grantedScopes;
        await updateConnectionOAuthTokens(tx, workspaceId, connectionId, {
          accessTokenEncrypted: Buffer.from(
            encryptOAuthAccessToken(outcome.accessToken, keyring, binding),
            "utf8",
          ),
          accessTokenExpiresAt: new Date(
            now().getTime() + outcome.expiresInSeconds * 1000,
          ),
          ...(outcome.scopes ? { grantedScopes: outcome.scopes } : {}),
          ...(outcome.refreshToken
            ? {
                credentialsEncrypted: sealOAuthCredentials(
                  outcome.refreshToken,
                  keyring,
                  binding,
                ),
              }
            : {}),
        });
        deps.logger?.info(
          {
            connectionId,
            provider: provider.definition.id,
            rotated: outcome.refreshToken !== null,
          },
          "oauth access token refreshed",
        );
        if (!covers(grantedScopes, options.requiredScopes)) {
          await markNeedsReauthorization(
            tx,
            workspaceId,
            connectionId,
            "scope_missing",
          );
          return { ok: false as const, reason: "scope_missing" as const };
        }
        return {
          ok: true as const,
          accessToken: outcome.accessToken,
          refreshed: true,
        };
      });
    },

    /**
     * Drops the cached access token after the provider API rejected it
     * (401), so the next getAccessToken refreshes. Only drops it while it is
     * still the stored token: a token another caller refreshed meanwhile
     * stays.
     */
    async invalidateAccessToken(
      binding: CredentialBinding,
      rejectedAccessToken: string,
    ): Promise<void> {
      const { workspaceId, connectionId } = binding;
      await withWorkspace(db, { workspaceId }, async (tx) => {
        const locked = await lockConnectionOAuth(tx, workspaceId, connectionId);
        if (!locked?.oauth.accessTokenEncrypted) {
          return;
        }
        let stored: string;
        try {
          stored = decryptOAuthAccessToken(
            locked.oauth.accessTokenEncrypted.toString("utf8"),
            keyring,
            binding,
          );
        } catch {
          stored = rejectedAccessToken;
        }
        if (stored === rejectedAccessToken) {
          await updateConnectionOAuthTokens(tx, workspaceId, connectionId, {
            accessTokenEncrypted: null,
            accessTokenExpiresAt: null,
          });
        }
      });
    },

    /**
     * Revokes a grant at the provider: best effort, short timeout, never
     * throws. Returns whether the provider confirmed the revocation.
     */
    async revokeGrant(providerId: string, refreshToken: string) {
      const provider = providers.get(providerId);
      const endpoint = provider?.definition.revocationEndpoint;
      if (!provider || !endpoint) {
        return false;
      }
      try {
        const response = await providerFetch(provider)(
          endpoint,
          {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: refreshToken }).toString(),
          },
          revokeTimeoutMs,
        );
        if (response.status !== 200) {
          deps.logger?.warn(
            { provider: providerId, status: response.status },
            "oauth revocation refused by the provider",
          );
          return false;
        }
        return true;
      } catch (error) {
        deps.logger?.warn(
          {
            provider: providerId,
            err: error instanceof Error ? error.name : "Error",
          },
          "oauth revocation failed",
        );
        return false;
      }
    },
  };
}

export type OAuthTokenService = ReturnType<typeof createOAuthTokenService>;
