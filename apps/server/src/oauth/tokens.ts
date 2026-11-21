import { createHash } from "node:crypto";

import {
  createEgressFetch,
  type EgressOptions,
} from "@netrics/connector-runtime";
import type {
  ConnectorFetchInit,
  ConnectorResponse,
} from "@netrics/connector-sdk";
import {
  findConnection,
  findConnectionOAuth,
  lockConnectionOAuth,
  markNeedsReauthorization,
  schema,
  updateConnectionOAuthTokens,
  upsertConnectionOAuth,
  withWorkspace,
  type ConnectionOAuthRow,
  type Database,
  type OAuthAuthReason,
  type Transaction,
} from "@netrics/database";
import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";

import {
  decryptCredentials,
  decryptOAuthAccessToken,
  encryptCredentials,
  encryptOAuthAccessToken,
  type CredentialBinding,
  type CredentialKeyring,
} from "../credentials.js";
import { CUSTOM_API_MESSAGES } from "@netrics/connectors/custom-api";

import { customApiEgress } from "../custom-api/connectors.js";
import { loadConnectionCustomApiDefinition } from "../custom-api/load-definition.js";
import { clientForm, type OAuthHttpFactory } from "./client.js";
import type { ConfiguredOAuthProvider, OAuthProviders } from "./config.js";
import {
  CUSTOM_OAUTH_PROVIDER_ID,
  customGrantedScopes,
  customOAuthBinding,
  customOAuthBindingHolds,
  customOAuthProvider,
  generateCustomAccountSub,
  isCustomOAuthAuth,
  openCustomOAuthCredentials,
  sealCustomOAuthCredentials,
  type CustomOAuthCredentials,
  type CustomOAuthProvider,
} from "./providers/custom.js";

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
  /**
   * Custom APIs (#805) only, all needing the user (auth_failed), not an
   * operator: the token endpoint refused the client ID or secret
   * (client_refused) or did not grant the definition's scopes to a
   * client-credentials client (scope_refused); or the definition now names
   * other hosts than the client and tokens were entered for
   * (binding_changed), so nothing was sent.
   */
  readonly reason:
    "client_refused" | "scope_refused" | "binding_changed" | null;
  /**
   * With a reason: the digest of the custom envelope the refused call used
   * (customEnvelopeDigest), so the failure is recorded only while that
   * envelope is still stored (#825). Null when unknown.
   */
  envelopeDigest: string | null = null;

  constructor(
    kind: "transient" | "configuration",
    message: string,
    options: {
      reason?: "client_refused" | "scope_refused" | "binding_changed";
    } = {},
  ) {
    super(message);
    this.name = "OAuthTokenError";
    this.kind = kind;
    this.reason = options.reason ?? null;
  }
}

/**
 * The connector message (translated by text) for a custom OAuth failure the
 * user has to act on, or null. Each names an action that works: entering the
 * client ID and secret again (PATCH credentials) re-seals the envelope for
 * the current hosts.
 */
export function customOAuthFailureMessage(error: unknown): string | null {
  if (!(error instanceof OAuthTokenError)) return null;
  switch (error.reason) {
    case "client_refused":
      return CUSTOM_API_MESSAGES.tokenRefused;
    case "scope_refused":
      return CUSTOM_API_MESSAGES.scopeRefused;
    case "binding_changed":
      return CUSTOM_API_MESSAGES.hostChanged;
    default:
      return null;
  }
}

/** One custom OAuth connection's provider and envelope (#805). */
/**
 * A digest of a stored credentials envelope (its ciphertext): tells two
 * envelopes apart without carrying either around.
 */
export function customEnvelopeDigest(envelope: Buffer): string {
  return createHash("sha256").update(envelope).digest("hex");
}

/** The custom envelope one token call read (#825). */
interface SeenEnvelope {
  envelopeDigest: string | null;
}

export interface CustomOAuthResolution {
  provider: CustomOAuthProvider;
  credentials: CustomOAuthCredentials;
  /** A builder draft (never scheduled). */
  draft: boolean;
  /** customEnvelopeDigest of the envelope this was read from. */
  envelopeDigest: string;
  /**
   * Whether the envelope was entered for the definition's current hosts
   * (environment host with port, token and revoke hosts). When not, nothing
   * may be sent with it: no client secret, no token.
   */
  bindingHeld: boolean;
}

/**
 * Custom OAuth (milestone 13, #805): the provider of a custom-api connection
 * comes from its definition (pinned or draft, through
 * loadConnectionCustomApiDefinition) and its envelope, and its token calls go
 * through the custom API egress (same-host redirects, self-host private
 * hosts) to the token and revoke hosts only.
 */
export interface CustomOAuthResolver {
  /**
   * Reads the connection's definition and envelope inside `tx`; null when
   * the connection is not a custom OAuth connection or its envelope does
   * not hold client credentials.
   */
  resolve(
    tx: Transaction,
    binding: CredentialBinding,
  ): Promise<CustomOAuthResolution | null>;
  /**
   * The provider of a definition's OAuth login with a client, without an
   * envelope (a connection whose login was dropped, #808).
   */
  providerFor(
    definition: Parameters<typeof customOAuthProvider>[0],
    client: { clientId: string; clientSecret: string },
  ): CustomOAuthProvider;
  /** The guarded fetch for one custom provider's token and revoke calls. */
  fetch(
    provider: CustomOAuthProvider,
    timeoutMs: number,
  ): (url: string, init: ConnectorFetchInit) => Promise<ConnectorResponse>;
}

export function createCustomOAuthResolver(deps: {
  credentialKeyring: CredentialKeyring;
  webOrigin: string;
  /** Self-host only (NETRICS_CUSTOM_API_PRIVATE_HOSTS). */
  privateHosts?: readonly string[];
  /** Tests only: reach the local fixture (tlsCa, allowPrivateHosts, …). */
  egress?: Partial<EgressOptions>;
}): CustomOAuthResolver {
  return {
    async resolve(tx, binding) {
      const loaded = await loadConnectionCustomApiDefinition(
        tx,
        binding.workspaceId,
        binding.connectionId,
      );
      if (!loaded || !isCustomOAuthAuth(loaded.definition.auth)) return null;
      const found = await findConnection(
        tx,
        binding.workspaceId,
        binding.connectionId,
        { includeDrafts: true },
      );
      if (!found?.row.credentialsEncrypted) return null;
      let credentials: CustomOAuthCredentials;
      try {
        credentials = openCustomOAuthCredentials(
          found.row.credentialsEncrypted,
          deps.credentialKeyring,
          binding,
        );
      } catch {
        return null;
      }
      return {
        provider: customOAuthProvider(
          loaded.definition,
          credentials,
          deps.webOrigin,
        ),
        credentials,
        envelopeDigest: customEnvelopeDigest(found.row.credentialsEncrypted),
        draft: loaded.draft,
        bindingHeld:
          loaded.environmentId !== null &&
          customOAuthBindingHolds(
            credentials,
            customOAuthBinding(loaded.definition, loaded.environmentId),
          ),
      };
    },
    providerFor(definition, client) {
      return customOAuthProvider(definition, client, deps.webOrigin);
    },
    fetch(provider, timeoutMs) {
      return (url, init) =>
        createEgressFetch({
          ...customApiEgress(deps.privateHosts ?? [], deps.egress),
          allowedDomains: provider.definition.serverDomains,
          signal: AbortSignal.timeout(timeoutMs),
          // Token and revoke calls follow no redirect at all.
          maxRedirects: 0,
          maxResponseBytes: 64 * 1024,
          requestTimeoutMs: timeoutMs,
        })(url, init);
    },
  };
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
  /** Custom OAuth of custom API connections (#805); none without it. */
  customOAuth?: CustomOAuthResolver;
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

function isCustom(
  provider: ConfiguredOAuthProvider,
): provider is CustomOAuthProvider {
  return provider.definition.id === CUSTOM_OAUTH_PROVIDER_ID;
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
    const custom = deps.customOAuth;
    if (custom && isCustom(provider)) {
      return (url, init, timeoutMs) =>
        custom.fetch(provider, timeoutMs)(url, init);
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

  /**
   * A new access token at the provider's token endpoint: a refresh_token
   * grant, or for a custom client-credentials provider a new
   * client_credentials grant with the definition's scopes.
   */
  async function refreshAtProvider(
    provider: ConfiguredOAuthProvider,
    refreshToken: string | null,
  ): Promise<RefreshOutcome> {
    const custom = isCustom(provider) ? provider : null;
    const clientCredentials = custom?.grant === "client_credentials";
    if (!clientCredentials && !refreshToken) {
      // A custom grant without a refresh token ends with its access token.
      return { ok: false, reason: "invalid_grant" };
    }
    let response: ConnectorResponse;
    try {
      response = await providerFetch(provider)(
        provider.definition.tokenEndpoint,
        clientForm(
          provider,
          clientCredentials
            ? {
                grant_type: "client_credentials",
                ...(custom!.scopes.length
                  ? { scope: custom!.scopes.join(" ") }
                  : {}),
              }
            : { grant_type: "refresh_token", refresh_token: refreshToken! },
        ),
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
        // Custom providers may separate scopes with commas (GitHub, Slack).
        scopes: custom
          ? customGrantedScopes(parsed.scope)
          : typeof parsed.scope === "string"
            ? parsed.scope.split(" ").filter(Boolean)
            : null,
        refreshToken:
          !clientCredentials &&
          typeof parsed.refresh_token === "string" &&
          parsed.refresh_token
            ? parsed.refresh_token
            : null,
      };
    }
    const code = errorCode(body);
    if (code === "invalid_grant" && !clientCredentials) {
      return { ok: false, reason: "invalid_grant" };
    }
    // invalid_client / unauthorized_client: the OAuth app is misconfigured
    // (secret rotated, client deleted), not the user's grant. For a custom
    // API that app is the user's: a refused client needs new credentials.
    const refused =
      code === "invalid_client" ||
      code === "unauthorized_client" ||
      (custom !== null &&
        (response.status === 401 ||
          (clientCredentials && code === "invalid_grant")));
    throw new OAuthTokenError(
      refused ? "configuration" : "transient",
      `oauth token refresh failed: provider answered ${response.status} (${code})`,
      refused && custom !== null ? { reason: "client_refused" } : {},
    );
  }

  /**
   * A custom OAuth connection's provider and envelope, only when the
   * envelope was entered for the definition's current hosts: otherwise
   * nothing may be sent (binding_changed).
   */
  async function usableCustom(
    tx: Transaction,
    binding: CredentialBinding,
    seen: SeenEnvelope,
  ): Promise<CustomOAuthResolution> {
    const custom = await deps.customOAuth?.resolve(tx, binding);
    if (custom) seen.envelopeDigest = custom.envelopeDigest;
    if (!custom) {
      throw new OAuthTokenError(
        "configuration",
        "custom oauth connection has no usable definition or client credentials",
      );
    }
    if (!custom.bindingHeld) {
      throw new OAuthTokenError(
        "configuration",
        "custom oauth credentials were entered for other hosts; nothing was sent",
        { reason: "binding_changed" },
      );
    }
    return custom;
  }

  /**
   * A client-credentials client without the definition's scopes cannot be
   * reauthorized: it needs other client credentials (auth_failed).
   */
  function scopeRefused(): OAuthTokenError {
    return new OAuthTokenError(
      "configuration",
      "oauth client credentials token lacks required scopes",
      { reason: "scope_refused" },
    );
  }

  /** The provider and refresh token of a locked grant. */
  async function grantOf(
    tx: Transaction,
    binding: CredentialBinding,
    locked: { oauth: ConnectionOAuthRow; credentialsEncrypted: Buffer | null },
    seen: SeenEnvelope,
  ): Promise<{
    provider: ConfiguredOAuthProvider;
    refreshToken: string | null;
    custom: CustomOAuthResolution | null;
  }> {
    if (locked.oauth.provider === CUSTOM_OAUTH_PROVIDER_ID) {
      const custom = await usableCustom(tx, binding, seen);
      return {
        provider: custom.provider,
        refreshToken: custom.credentials.refreshToken,
        custom,
      };
    }
    const provider = configured(locked.oauth.provider);
    if (!locked.credentialsEncrypted) {
      throw new OAuthTokenError(
        "configuration",
        "oauth connection has no refresh token; reauthorize the connection",
      );
    }
    return {
      provider,
      refreshToken: openOAuthCredentials(
        locked.credentialsEncrypted,
        keyring,
        binding,
      ),
      custom: null,
    };
  }

  /**
   * The first token of a custom client-credentials connection (#805): with
   * the connection row locked, so concurrent callers mint once, a new
   * connection_oauth row with a generated account. Null when the
   * connection is not a client-credentials custom OAuth connection.
   */
  async function mintFirst(
    tx: Transaction,
    binding: CredentialBinding,
    options: GetAccessTokenOptions,
    seen: SeenEnvelope,
  ): Promise<AccessTokenResult | null> {
    const { workspaceId, connectionId } = binding;
    if (!deps.customOAuth) return null;
    await tx
      .select({ id: schema.connections.id })
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.workspaceId, workspaceId),
          eq(schema.connections.id, connectionId),
        ),
      )
      .for("update");
    const row = await findConnectionOAuth(tx, workspaceId, connectionId);
    if (row) {
      // Minted by a caller this one waited for.
      const token = cached(row, binding);
      if (token) return { ok: true, accessToken: token, refreshed: false };
      return null;
    }
    const resolved = await deps.customOAuth.resolve(tx, binding);
    if (!resolved || resolved.provider.grant !== "client_credentials")
      return null;
    const custom = await usableCustom(tx, binding, seen);
    const outcome = await refreshAtProvider(custom.provider, null);
    if (!outcome.ok) return outcome;
    const grantedScopes = outcome.scopes ?? [...custom.provider.scopes];
    // Nothing is stored for a client without the scopes (auth_failed).
    if (!covers(grantedScopes, options.requiredScopes)) throw scopeRefused();
    await upsertConnectionOAuth(tx, {
      workspaceId,
      connectionId,
      provider: CUSTOM_OAUTH_PROVIDER_ID,
      accountSub: generateCustomAccountSub(),
      accountEmail: null,
      grantedScopes,
      accessTokenEncrypted: Buffer.from(
        encryptOAuthAccessToken(outcome.accessToken, keyring, binding),
        "utf8",
      ),
      accessTokenExpiresAt: new Date(
        now().getTime() + outcome.expiresInSeconds * 1000,
      ),
    });
    deps.logger?.info(
      { connectionId, provider: CUSTOM_OAUTH_PROVIDER_ID },
      "oauth client credentials token issued",
    );
    return { ok: true, accessToken: outcome.accessToken, refreshed: true };
  }

  /** getAccessToken, recording the custom envelope it used in `seen`. */
  async function accessToken(
    binding: CredentialBinding,
    options: GetAccessTokenOptions,
    seen: SeenEnvelope,
  ): Promise<AccessTokenResult> {
    const { workspaceId, connectionId } = binding;
    const fast = await withWorkspace(db, { workspaceId }, async (tx) => {
      const row = await findConnectionOAuth(tx, workspaceId, connectionId);
      if (!row) {
        // A custom client-credentials connection mints its first token.
        return deps.customOAuth ? { stale: true as const } : null;
      }
      // A custom grant is used only with the hosts it was entered for.
      const custom =
        row.provider === CUSTOM_OAUTH_PROVIDER_ID
          ? await usableCustom(tx, binding, seen)
          : null;
      if (!covers(row.grantedScopes, options.requiredScopes)) {
        if (custom?.provider.grant === "client_credentials")
          throw scopeRefused();
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
        const minted = await mintFirst(tx, binding, options, seen);
        if (minted) return minted;
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
      const { provider, refreshToken, custom } = await grantOf(
        tx,
        binding,
        locked,
        seen,
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
      if (
        custom?.provider.grant === "client_credentials" &&
        !covers(
          outcome.scopes ?? [...custom.provider.scopes],
          options.requiredScopes,
        )
      )
        throw scopeRefused();
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
              credentialsEncrypted: custom
                ? sealCustomOAuthCredentials(
                    {
                      ...custom.credentials,
                      refreshToken: outcome.refreshToken,
                    },
                    keyring,
                    binding,
                  )
                : sealOAuthCredentials(outcome.refreshToken, keyring, binding),
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
      const seen: SeenEnvelope = { envelopeDigest: null };
      try {
        return await accessToken(binding, options, seen);
      } catch (error) {
        // A custom client refusal names the envelope it was refused with,
        // so a client changed meanwhile is not marked failed (#825).
        if (error instanceof OAuthTokenError && error.reason !== null)
          error.envelopeDigest ??= seen.envelopeDigest;
        throw error;
      }
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
     * One client_credentials token for a custom provider that has no
     * connection yet (creating a connection, #805). Throws OAuthTokenError
     * (reason client_refused when the endpoint refused the client).
     */
    async requestClientCredentialsToken(provider: CustomOAuthProvider) {
      const outcome = await refreshAtProvider(provider, null);
      if (!outcome.ok) {
        throw new OAuthTokenError(
          "configuration",
          "oauth token request refused",
          { reason: "client_refused" },
        );
      }
      return {
        accessToken: outcome.accessToken,
        expiresAt: new Date(now().getTime() + outcome.expiresInSeconds * 1000),
        scopes: outcome.scopes,
      };
    },

    /**
     * Revokes a custom grant's token at the definition's revoke URL (RFC
     * 7009, client authenticated per clientAuth): best effort, short
     * timeout, never throws. False without a revoke URL (nothing is sent).
     */
    async revokeCustomGrant(
      provider: CustomOAuthProvider,
      token: string,
      tokenTypeHint: "refresh_token" | "access_token" = "refresh_token",
    ): Promise<boolean> {
      const endpoint = provider.definition.revocationEndpoint;
      if (!endpoint) return false;
      try {
        const response = await providerFetch(provider)(
          endpoint,
          clientForm(provider, {
            token,
            token_type_hint: tokenTypeHint,
          }),
          revokeTimeoutMs,
        );
        if (response.status !== 200) {
          deps.logger?.warn(
            { provider: CUSTOM_OAUTH_PROVIDER_ID, status: response.status },
            "oauth revocation refused by the provider",
          );
          return false;
        }
        return true;
      } catch (error) {
        deps.logger?.warn(
          {
            provider: CUSTOM_OAUTH_PROVIDER_ID,
            err: error instanceof Error ? error.name : "Error",
          },
          "oauth revocation failed",
        );
        return false;
      }
    },

    /** Custom OAuth of custom API connections (#805); undefined without it. */
    customOAuth: deps.customOAuth,

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
