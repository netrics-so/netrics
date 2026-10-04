import { randomUUID } from "node:crypto";

import type {
  AppStoreAnalyticsStatusResponse,
  AppStoreReviewsStatusResponse,
  ConnectionPreviewResponse,
  ConnectionResourcesResponse,
  ConnectionSignedKeyView,
  ConnectorAuthStrategy,
  CreateConnectionRequest,
  DeleteConnectionResponse,
  EnableAppStoreAnalyticsRequest,
  EnableAppStoreAnalyticsResponse,
  ObservationListQuery,
  PreviewConnectionRequest,
  UpdateConnectionRequest,
} from "@netrics/contracts";
import { validateConnectionConfig } from "@netrics/contracts";
import {
  executeCheck,
  executeDiscover,
  type ConnectorRegistry,
  type ExecuteOptions,
} from "@netrics/connector-runtime";
import type {
  ConnectionContext,
  Connector,
  ConnectorManifest,
} from "@netrics/connector-sdk";
import { ANALYTICS_METRIC_KEYS } from "@netrics/connectors";
import {
  DEFAULT_LOCALE,
  localizedManifest,
  type Locale,
} from "@netrics/domain";
import {
  deleteConnection as deleteConnectionRow,
  enqueueJob,
  findConnection,
  findConnectionOAuth,
  finishConnectionSetup,
  findProject,
  findResourceNames,
  insertAuditEvent,
  insertConnection,
  latestObservationByResource,
  listConnections as listConnectionRows,
  listObservations as listObservationRows,
  listRecentSyncRuns,
  releaseOAuthGrant,
  requestConnectionBackfill,
  requestConnectionSync,
  resetConnectionAuth,
  resourceNameKey,
  updateConnection as updateConnectionRow,
  withOAuthGrantLocks,
  withWorkspace,
  type ConnectionChanges,
  type ConnectionWithState,
  type Database,
  type Transaction,
} from "@netrics/database";

import {
  decryptCredentials,
  encryptCredentials,
  redactSecrets,
  type CredentialKeyring,
} from "../credentials.js";
import type { OAuthProviders } from "../oauth/config.js";
import {
  callWithAccessToken,
  NeedsReauthorizationError,
  oauthStrategyFor,
} from "../oauth/connector-auth.js";
import {
  createOAuthTokenService,
  openOAuthCredentials,
  type OAuthTokenService,
} from "../oauth/tokens.js";
import {
  callWithSignedKey,
  SignedKeyRejectedError,
} from "../signed-keys/connector-auth.js";
import {
  APP_STORE_CONNECT_KEYS_URL,
  appStoreAnalyticsStatus,
  enableAppStoreAnalytics,
} from "../signed-keys/app-store-analytics.js";
import {
  REVIEWS_KEY_ID,
  appStoreReviewsStatus,
} from "../signed-keys/app-store-reviews.js";
import type { SignedKeyProviderDefinition } from "../signed-keys/providers/index.js";
import {
  createSignedKeyProviders,
  type SignedKey,
  type SignedKeyProviders,
} from "../signed-keys/registry.js";
import {
  presentConnection,
  presentConnectionDetail,
  presentSyncRun,
} from "./present.js";

/**
 * Connection use cases for the API: validation against the connector
 * manifest, credential checks, encryption, persistence, job enqueueing and
 * audit. Callers have already authenticated and authorized the request; the
 * service reports failures as HTTP-shaped results instead of replying.
 */

export interface ConnectionServiceDeps {
  db: Database;
  registry: ConnectorRegistry;
  credentialKeyring: CredentialKeyring;
  oauthProviders: OAuthProviders;
  /** Default: a token service over db, keyring and providers. */
  oauthTokens?: OAuthTokenService;
  /** Default: the signed-key providers of this server (ADR 0014). */
  signedKeys?: SignedKeyProviders;
}

/** Who acts on which workspace (see routes/access.ts). */
export interface Actor {
  workspaceId: string;
  callerId: string;
  /** The caller's language, for connector names (#257). Default English. */
  locale?: Locale;
}

export type Result<T> =
  { ok: true; value: T } | { ok: false; status: 400 | 404; error: string };

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail<T>(status: 400 | 404, error: string): Result<T> {
  return { ok: false, status, error };
}

const NOT_FOUND = "connection_not_found";

type ConnectionDetail = ReturnType<typeof presentConnectionDetail>;

/** Redacted, bounded message for connector-facing errors. */
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return String(redactSecrets(message)).slice(0, 500);
}

function validateConfig(
  manifest: ConnectorManifest,
  config: Record<string, unknown>,
): Result<Record<string, unknown>> {
  const validated = validateConnectionConfig(manifest.configSchema, config);
  return validated.ok ? ok(validated.config) : fail(400, validated.message);
}

/** JSON with sorted object keys, so equal configs serialize equally. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Whether a config change alters what the connection collects, so the
 * stored history no longer matches it (#153). Every config property of a
 * connector selects or shapes its data (the Search Console property,
 * breakdown and rows per day; the Vercel team), so any change counts;
 * defaults are applied to both sides first, so an omitted default is no
 * change. The resource selection is not part of a PATCH and is ignored.
 */
function configChanged(
  manifest: ConnectorManifest,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  const normalize = (config: Record<string, unknown>): string => {
    const { resourceSelection: _selection, ...rest } = config;
    const validated = validateConnectionConfig(manifest.configSchema, rest);
    return canonicalJson(validated.ok ? validated.config : rest);
  };
  return normalize(before) !== normalize(after);
}

/**
 * Runs the connector check for a candidate config/credentials pair. A failed
 * or thrown check is a 400 with the connector's actionable, already-redacted
 * message; callers persist nothing in that case.
 */
async function checkCredentials(
  registry: ConnectorRegistry,
  connectorId: string,
  connectionId: string,
  config: Record<string, unknown>,
  credentials: Record<string, unknown>,
): Promise<Result<true>> {
  const registered = registry.get(connectorId);
  if (!registered) {
    return fail(400, "invalid_request");
  }
  try {
    const check = await executeCheck(registered.connector, {
      connectionId,
      config,
      credentials,
    });
    return check.ok
      ? ok(true)
      : fail(400, check.message ?? "credential check failed");
  } catch (error) {
    // Thrown checks signal a provider-side failure (outage, rate limit); the
    // message is redacted at the runtime boundary already.
    return fail(400, safeMessage(error));
  }
}

/**
 * The connector check with a signed key (ADR 0014): the connector gets a
 * freshly signed token, never the key. A provider 401/403 answers with the
 * provider's actionable message.
 */
async function checkSignedKey(
  registry: ConnectorRegistry,
  connectorId: string,
  connectionId: string,
  config: Record<string, unknown>,
  key: SignedKey,
): Promise<Result<true>> {
  const registered = registry.get(connectorId);
  if (!registered) {
    return fail(400, "invalid_request");
  }
  try {
    const check = await callWithSignedKey({
      key,
      call: (credentials, options) =>
        executeCheck(
          registered.connector,
          { connectionId, config, credentials: { ...credentials } },
          options,
        ),
      rejected: (result) => !result.ok,
    });
    return check.ok
      ? ok(true)
      : fail(400, check.message ?? "credential check failed");
  } catch (error) {
    return signedKeyCallFailure(error);
  }
}

/** Maps a failed signed-key connector call to a 400 the web app can show. */
function signedKeyCallFailure<T>(error: unknown): Result<T> {
  // SignedKeyRejectedError carries the provider's fixed text; connector
  // errors are redacted of the token at the runtime boundary.
  return fail(
    400,
    error instanceof SignedKeyRejectedError
      ? error.message
      : safeMessage(error),
  );
}

function encrypt(
  keyring: CredentialKeyring,
  credentials: Record<string, unknown>,
  scope: { workspaceId: string; connectionId: string },
): Buffer {
  return Buffer.from(
    encryptCredentials(JSON.stringify(credentials), keyring, scope),
    "utf8",
  );
}

/**
 * The wizard's view of an auth strategy: token field labels and setup
 * steps, the OAuth provider and scopes, or the signed-key provider.
 */
function presentAuthStrategy(
  strategy: ConnectorManifest["authStrategies"][number],
  signedKeys: SignedKeyProviders,
): ConnectorAuthStrategy {
  if (strategy.strategy === "signed-key") {
    const provider = signedKeys.get(strategy.provider);
    return {
      strategy: "signed-key",
      provider: strategy.provider,
      ...(provider ? presentSignedKeyProvider(provider) : {}),
    };
  }
  if (strategy.strategy === "oauth2") {
    return {
      strategy: "oauth2",
      provider: strategy.provider,
      scopes: [...strategy.scopes],
    };
  }
  const properties = strategy.credentialsSchema?.properties;
  const token =
    properties && typeof properties === "object" && "token" in properties
      ? (properties as { token: unknown }).token
      : undefined;
  const text = (key: "title" | "description") => {
    const value =
      token && typeof token === "object"
        ? (token as Record<string, unknown>)[key]
        : undefined;
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const tokenLabel = text("title");
  const tokenDescription = text("description");
  return {
    strategy: strategy.strategy,
    ...(tokenLabel ? { tokenLabel } : {}),
    ...(tokenDescription ? { tokenDescription } : {}),
    ...(strategy.setup
      ? {
          setup: {
            steps: [...strategy.setup.steps],
            ...(strategy.setup.url ? { url: strategy.setup.url } : {}),
          },
        }
      : {}),
  };
}

/** The wizard's form for a signed-key provider: fields and setup copy. */
function presentSignedKeyProvider(
  provider: SignedKeyProviderDefinition,
): Pick<ConnectorAuthStrategy, "providerName" | "fields" | "setup"> {
  return {
    providerName: provider.name,
    fields: provider.fields.map((field) => ({
      key: field.key,
      label: field.label,
      description: field.description,
      input: field.input,
      secret: field.secret,
      ...(field.placeholder ? { placeholder: field.placeholder } : {}),
      maxBytes: field.maxBytes,
    })),
    setup: {
      steps: [...provider.setup.steps],
      url: provider.setup.url,
      ...(provider.setup.links
        ? { links: provider.setup.links.map((link) => ({ ...link })) }
        : {}),
    },
  };
}

/** Whether the connector has an auth strategy besides OAuth. */
function acceptsCredentials(manifest: ConnectorManifest): boolean {
  return manifest.authStrategies.some(
    (strategy) => strategy.strategy !== "oauth2",
  );
}

export function createConnectionService(deps: ConnectionServiceDeps) {
  const { db, registry, credentialKeyring, oauthProviders } = deps;
  const signedKeys = deps.signedKeys ?? createSignedKeyProviders();
  const oauthTokens =
    deps.oauthTokens ??
    createOAuthTokenService({
      db,
      credentialKeyring,
      providers: oauthProviders,
    });

  /**
   * The connector check of an existing OAuth connection with a candidate
   * config: the connector gets a fresh access token, never the stored
   * refresh token (ADR 0012).
   */
  async function checkOAuthConnection(
    actor: Actor,
    connectorId: string,
    connectionId: string,
    provider: string,
    config: Record<string, unknown>,
  ): Promise<Result<true>> {
    const registered = registry.get(connectorId);
    const strategy = registered
      ? oauthStrategyFor(registered.manifest, provider)
      : undefined;
    if (!registered || !strategy) {
      return fail(400, "invalid_request");
    }
    try {
      const check = await callWithAccessToken({
        tokens: oauthTokens,
        binding: { workspaceId: actor.workspaceId, connectionId },
        requiredScopes: strategy.scopes,
        call: (credentials, options) =>
          executeCheck(
            registered.connector,
            { connectionId, config, credentials: { ...credentials } },
            options,
          ),
        rejected: (result) => !result.ok,
      });
      return check.ok
        ? ok(true)
        : fail(400, check.message ?? "credential check failed");
    } catch (error) {
      // OAuthTokenError and connector failures carry redacted messages.
      return oauthCallFailure(error);
    }
  }

  /**
   * Validates candidate credentials of a credentials-based connection and
   * runs the connector check; returns what the envelope stores. With a
   * signed-key provider (ADR 0014) the fields and the key are checked, then
   * the provider's probes run, then the connector check gets a freshly
   * signed token: the key is stored normalized, and only after all of it
   * passed. Otherwise the credentials go to the connector check as given.
   */
  async function checkCandidate(
    manifest: ConnectorManifest,
    connectionId: string,
    config: Record<string, unknown>,
    credentials: Record<string, unknown>,
    options: { probeAdditional?: boolean } = {},
  ): Promise<Result<Record<string, unknown>>> {
    const provider = signedKeys.providerFor(manifest, credentials);
    if (provider) {
      const key = await signedKeys.validate(
        provider,
        credentials,
        config,
        options,
      );
      if (!key.ok) {
        return fail(400, key.message);
      }
      const check = await checkSignedKey(
        registry,
        manifest.id,
        connectionId,
        config,
        key.value,
      );
      return check.ok ? ok(key.value.stored()) : check;
    }
    const check = await checkCredentials(
      registry,
      manifest.id,
      connectionId,
      config,
      credentials,
    );
    return check.ok ? ok(credentials) : check;
  }

  /**
   * The non-secret fields of a signed-key connection's stored key (ADR
   * 0014), e.g. issuer ID and key ID, for the connection page. Only fields
   * the provider marks as not secret are read out of the envelope; the
   * private key never leaves this function. Null for other connections, or
   * when the envelope cannot be opened (the page then shows "stored").
   */
  function signedKeyView(
    workspaceId: string,
    row: ConnectionWithState["row"],
  ): ConnectionSignedKeyView | null {
    const manifest = registry.get(row.connectorId)?.manifest;
    if (!manifest || !row.credentialsEncrypted) {
      return null;
    }
    const strategy = manifest.authStrategies.find(
      (entry) => entry.strategy === "signed-key",
    );
    const provider =
      strategy?.strategy === "signed-key"
        ? signedKeys.get(strategy.provider)
        : undefined;
    if (!provider) {
      return null;
    }
    let stored: Record<string, unknown>;
    try {
      stored = JSON.parse(
        decryptCredentials(
          row.credentialsEncrypted.toString("utf8"),
          credentialKeyring,
          { workspaceId, connectionId: row.id },
        ),
      ) as Record<string, unknown>;
    } catch {
      return null;
    }
    // A connector that also takes a token may hold one instead of a key.
    if (signedKeys.providerFor(manifest, stored) !== provider) {
      return null;
    }
    return {
      provider: provider.id,
      fields: provider.fields
        .filter((field) => !field.secret)
        .flatMap((field) => {
          const value = stored[field.key];
          return typeof value === "string"
            ? [{ key: field.key, label: field.label, value }]
            : [];
        }),
    };
  }

  /** The stored signed key of a connection, re-checked (no probes). */
  function storedSignedKey(
    manifest: ConnectorManifest,
    credentials: Record<string, unknown>,
  ): Result<SignedKey> | null {
    const provider = signedKeys.providerFor(manifest, credentials);
    if (!provider) {
      return null;
    }
    const key = signedKeys.parse(provider, credentials);
    return key.ok ? ok(key.value) : fail(400, key.message);
  }

  /** The decrypted credentials envelope of a connection, or a 400. */
  function openEnvelope(
    workspaceId: string,
    row: ConnectionWithState["row"],
  ): Result<Record<string, unknown>> {
    if (!row.credentialsEncrypted) {
      return ok({});
    }
    try {
      return ok(
        JSON.parse(
          decryptCredentials(
            row.credentialsEncrypted.toString("utf8"),
            credentialKeyring,
            { workspaceId, connectionId: row.id },
          ),
        ) as Record<string, unknown>,
      );
    } catch (error) {
      return fail(400, safeMessage(error));
    }
  }

  /**
   * Whether a credential update names only additional keys of the
   * connector's signed-key provider (#190, `{ reviews: … }`): it then adds,
   * replaces or removes that key and leaves the main key as it is.
   */
  function additionalKeyUpdate(
    manifest: ConnectorManifest,
    credentials: Record<string, unknown>,
  ): SignedKeyProviderDefinition | null {
    const strategy = manifest.authStrategies.find(
      (entry) => entry.strategy === "signed-key",
    );
    const provider =
      strategy?.strategy === "signed-key"
        ? signedKeys.get(strategy.provider)
        : undefined;
    const ids = new Set((provider?.additionalKeys ?? []).map((key) => key.id));
    const keys = Object.keys(credentials);
    return provider && keys.length > 0 && keys.every((key) => ids.has(key))
      ? provider
      : null;
  }

  /**
   * Adds, replaces (`{ [id]: { …fields } }`) or removes (`{ [id]: null }`)
   * additional keys of a stored signed key (#190). A new key is checked in
   * full first (fields, P-256, its own probes against Apple), so a refused
   * key changes nothing. Returns the envelope to store and what changed.
   */
  async function changeAdditionalKeys(
    workspaceId: string,
    existing: ConnectionWithState,
    manifest: ConnectorManifest,
    provider: SignedKeyProviderDefinition,
    credentials: Record<string, unknown>,
  ): Promise<
    Result<{
      stored: Record<string, unknown>;
      changes: Array<{ key: string; change: "added" | "replaced" | "removed" }>;
    }>
  > {
    const envelope = openEnvelope(workspaceId, existing.row);
    if (!envelope.ok) {
      return envelope;
    }
    if (signedKeys.providerFor(manifest, envelope.value) !== provider) {
      return fail(
        400,
        `Upload a ${provider.name} key for this connection first.`,
      );
    }
    const stored = signedKeys.parse(provider, envelope.value);
    if (!stored.ok) {
      return fail(400, stored.message);
    }
    const config = existing.row.config as Record<string, unknown>;
    let key = stored.value;
    const changes: Array<{
      key: string;
      change: "added" | "replaced" | "removed";
    }> = [];
    for (const [id, raw] of Object.entries(credentials)) {
      const had = key.additional(id) !== undefined;
      if (raw === null) {
        key = key.withAdditional(id, null);
        if (had) {
          changes.push({ key: id, change: "removed" });
        }
        continue;
      }
      const additional = signedKeys.parseAdditional(key, id, raw);
      if (!additional.ok) {
        return fail(400, additional.message);
      }
      key = key.withAdditional(id, additional.value);
      const probed = await signedKeys.probeAdditional(key, id, config);
      if (!probed.ok) {
        return fail(400, probed.message);
      }
      changes.push({ key: id, change: had ? "replaced" : "added" });
    }
    return ok({ stored: key.stored(), changes });
  }

  /**
   * After a main-key rotation: the stored additional keys (#190) that the
   * new credentials do not mention are kept when the new key belongs to the
   * same team (same non-secret shared fields, the issuer ID); a key of
   * another team drops them, since they would not work with it.
   */
  function carryAdditionalKeys(
    manifest: ConnectorManifest,
    existing: ConnectionWithState,
    workspaceId: string,
    requested: Record<string, unknown>,
    next: Record<string, unknown>,
  ): Record<string, unknown> {
    const provider = signedKeys.providerFor(manifest, next);
    const additionalKeys = provider?.additionalKeys ?? [];
    if (!provider || additionalKeys.length === 0) {
      return next;
    }
    const envelope = openEnvelope(workspaceId, existing.row);
    if (!envelope.ok) {
      return next;
    }
    const previous = envelope.value;
    const ownKeys = new Set(
      additionalKeys.flatMap((key) => key.fields.map((field) => field.key)),
    );
    const sameTeam = provider.fields
      .filter((field) => !field.secret && !ownKeys.has(field.key))
      .every((field) => previous[field.key] === next[field.key]);
    if (!sameTeam) {
      return next;
    }
    const carried = { ...next };
    for (const key of additionalKeys) {
      if (!(key.id in requested) && previous[key.id] !== undefined) {
        carried[key.id] = previous[key.id];
      }
    }
    return carried;
  }

  /**
   * Preview with a signed key: validation and probes, then check and
   * discover, each with its own freshly signed token. Persists nothing.
   */
  async function previewSignedKey(
    connector: Connector,
    provider: SignedKeyProviderDefinition,
    config: Record<string, unknown>,
    credentials: Record<string, unknown> | undefined,
  ): Promise<Result<ConnectionPreviewResponse>> {
    const key = await signedKeys.validate(provider, credentials, config);
    if (!key.ok) {
      return fail(400, key.message);
    }
    const context = { connectionId: "preview", config };
    try {
      const check = await callWithSignedKey({
        key: key.value,
        call: (tokenCredentials, options) =>
          executeCheck(
            connector,
            { ...context, credentials: { ...tokenCredentials } },
            options,
          ),
        rejected: (result) => !result.ok,
      });
      if (!check.ok) {
        return ok({ check, resources: [] });
      }
      const resources = await callWithSignedKey({
        key: key.value,
        call: (tokenCredentials, options) =>
          executeDiscover(
            connector,
            { ...context, credentials: { ...tokenCredentials } },
            options,
          ),
      });
      return ok({ check, resources });
    } catch (error) {
      return signedKeyCallFailure(error);
    }
  }

  /**
   * Discovery of an existing signed-key connection (ADR 0014) with a
   * freshly signed token from its stored key. Other credentials-based
   * connections keep "oauth_connection_required".
   */
  async function discoverWithSignedKey(
    actor: Actor,
    connectionId: string,
    existing: ConnectionWithState,
  ): Promise<Result<ConnectionResourcesResponse>> {
    const registered = registry.get(existing.row.connectorId);
    if (!registered || !existing.row.credentialsEncrypted) {
      return fail(400, "oauth_connection_required");
    }
    let credentials: Record<string, unknown>;
    try {
      credentials = JSON.parse(
        decryptCredentials(
          existing.row.credentialsEncrypted.toString("utf8"),
          credentialKeyring,
          { workspaceId: actor.workspaceId, connectionId },
        ),
      ) as Record<string, unknown>;
    } catch (error) {
      return fail(400, safeMessage(error));
    }
    const key = storedSignedKey(registered.manifest, credentials);
    if (!key) {
      return fail(400, "oauth_connection_required");
    }
    if (!key.ok) {
      return key;
    }
    const config = existing.row.config as Record<string, unknown>;
    try {
      const resources = await callWithSignedKey({
        key: key.value,
        call: (tokenCredentials, options) =>
          executeDiscover(
            registered.connector,
            { connectionId, config, credentials: { ...tokenCredentials } },
            options,
          ),
      });
      return ok({ resources });
    } catch (error) {
      return signedKeyCallFailure(error);
    }
  }

  /**
   * An App Store Connect connection with its stored key, for the analytics
   * steps (#174). Other connections answer "analytics_unsupported".
   */
  async function appStoreConnection(
    actor: Actor,
    connectionId: string,
  ): Promise<
    Result<{
      existing: ConnectionWithState;
      key: SignedKey;
      selection: string[] | undefined;
    }>
  > {
    const existing = await inWorkspace(actor, (tx) =>
      findConnection(tx, actor.workspaceId, connectionId),
    );
    if (!existing) {
      return fail(404, NOT_FOUND);
    }
    const registered = registry.get(existing.row.connectorId);
    const strategy = registered?.manifest.authStrategies.find(
      (entry) => entry.strategy === "signed-key",
    );
    if (
      !registered ||
      existing.oauth ||
      strategy?.strategy !== "signed-key" ||
      strategy.provider !== "app-store-connect" ||
      !existing.row.credentialsEncrypted
    ) {
      return fail(400, "analytics_unsupported");
    }
    let credentials: Record<string, unknown>;
    try {
      credentials = JSON.parse(
        decryptCredentials(
          existing.row.credentialsEncrypted.toString("utf8"),
          credentialKeyring,
          { workspaceId: actor.workspaceId, connectionId },
        ),
      ) as Record<string, unknown>;
    } catch (error) {
      return fail(400, safeMessage(error));
    }
    const key = storedSignedKey(registered.manifest, credentials);
    if (!key) {
      return fail(400, "analytics_unsupported");
    }
    if (!key.ok) {
      return key;
    }
    const selection = (existing.row.config as Record<string, unknown>)
      .resourceSelection;
    return ok({
      existing,
      key: key.value,
      selection: Array.isArray(selection)
        ? selection.filter((id): id is string => typeof id === "string")
        : undefined,
    });
  }

  /** Maps a failed OAuth connector call to a 400 the web app can explain. */
  function oauthCallFailure<T>(error: unknown): Result<T> {
    if (error instanceof NeedsReauthorizationError) {
      return fail(400, "oauth_reauthorization_required");
    }
    return fail(400, safeMessage(error));
  }

  /**
   * Connections made from credentials (POST /connections, preview) need a
   * connector that is available on this instance and takes credentials.
   * OAuth-only connectors are connected through the authorization flow,
   * whose callback creates the connection (ADR 0012).
   */
  function checkCredentialConnector(manifest: ConnectorManifest): Result<true> {
    if (!oauthProviders.connectorAvailability(manifest, signedKeys).available) {
      return fail(400, "connector_unavailable");
    }
    if (!acceptsCredentials(manifest)) {
      return fail(400, "oauth_authorization_required");
    }
    return ok(true);
  }
  const inWorkspace = <T>(actor: Actor, run: (tx: Transaction) => Promise<T>) =>
    withWorkspace(
      db,
      { workspaceId: actor.workspaceId, userId: actor.callerId },
      run,
    );

  /**
   * The disconnect under the grant lock of `key` (null: not an OAuth
   * connection when looked up). Answers "account_changed" when the
   * connection's grant no longer belongs to the locked account.
   */
  async function disconnect(
    handle: Database,
    actor: Actor,
    connectionId: string,
    key: { provider: string; accountSub: string } | null,
  ): Promise<Result<DeleteConnectionResponse> | "account_changed"> {
    const deleted = await withWorkspace(
      handle,
      { workspaceId: actor.workspaceId, userId: actor.callerId },
      async (tx) => {
        const loaded = await findConnection(
          tx,
          actor.workspaceId,
          connectionId,
        );
        if (!loaded) {
          return null;
        }
        const grant = loaded.oauth
          ? await findConnectionOAuth(tx, actor.workspaceId, connectionId)
          : null;
        if (
          (grant?.provider ?? null) !== (key?.provider ?? null) ||
          (grant?.accountSub ?? null) !== (key?.accountSub ?? null)
        ) {
          return "account_changed" as const;
        }
        let release: {
          provider: string;
          refreshToken: string | null;
          shared: boolean;
        } | null = null;
        if (grant) {
          let refreshToken: string | null;
          try {
            refreshToken = loaded.row.credentialsEncrypted
              ? openOAuthCredentials(
                  loaded.row.credentialsEncrypted,
                  credentialKeyring,
                  { workspaceId: actor.workspaceId, connectionId },
                )
              : null;
          } catch {
            // An unreadable envelope cannot be revoked; deletion goes on
            // and the revocation is reported as failed.
            refreshToken = null;
          }
          const shared = await releaseOAuthGrant(tx, {
            provider: grant.provider,
            accountSub: grant.accountSub,
            connectionId,
          });
          release = { provider: grant.provider, refreshToken, shared };
        }
        await deleteConnectionRow(tx, actor.workspaceId, connectionId);
        await insertAuditEvent(tx, {
          workspaceId: actor.workspaceId,
          actorUserId: actor.callerId,
          action: "connection.deleted",
          target: connectionId,
          metadata: {
            name: loaded.row.name,
            connectorId: loaded.row.connectorId,
            ...(release
              ? {
                  oauthProvider: release.provider,
                  oauthGrant: release.shared ? "kept" : "released",
                }
              : {}),
          },
        });
        return { release };
      },
    );
    if (deleted === "account_changed") {
      return deleted;
    }
    if (!deleted) {
      return fail(404, NOT_FOUND);
    }
    const { release } = deleted;
    if (!release) {
      return ok({ revocation: null });
    }
    const accountPermissionsUrl =
      oauthProviders.get(release.provider)?.definition.accountPermissionsUrl ??
      null;
    if (release.shared) {
      return ok({
        revocation: {
          provider: release.provider,
          status: "kept",
          accountPermissionsUrl,
        },
      });
    }
    // Still under the grant lock: no grant of this account can be stored
    // until the provider has answered (or the short timeout passed).
    const revoked = release.refreshToken
      ? await oauthTokens.revokeGrant(release.provider, release.refreshToken)
      : false;
    return ok({
      revocation: {
        provider: release.provider,
        status: revoked ? "revoked" : "failed",
        accountPermissionsUrl,
      },
    });
  }

  return {
    /** The installation's catalog, from the deployed bundle. */
    /** The catalog, its texts in `locale` (#257). */
    listConnectors(locale: Locale = DEFAULT_LOCALE) {
      return registry.list().map(({ manifest: english }) => {
        const manifest = localizedManifest(english, locale);
        return {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          metricsCount: manifest.metrics.length,
          minRefreshIntervalSeconds: manifest.minRefreshIntervalSeconds,
          supportsBackfill: manifest.supportsBackfill,
          configSchema: { ...manifest.configSchema },
          authStrategies: manifest.authStrategies.map((strategy) =>
            presentAuthStrategy(strategy, signedKeys),
          ),
          ...oauthProviders.connectorAvailability(manifest, signedKeys),
        };
      });
    },

    async create(
      actor: Actor,
      body: CreateConnectionRequest,
    ): Promise<Result<ConnectionDetail>> {
      const registered = registry.get(body.connectorId);
      if (!registered) {
        return fail(400, "invalid_request");
      }
      const usable = checkCredentialConnector(registered.manifest);
      if (!usable.ok) {
        return usable;
      }
      const validated = validateConfig(registered.manifest, body.config);
      if (!validated.ok) {
        return validated;
      }
      const config = { ...validated.value };
      if (body.resources && body.resources.length > 0) {
        config.resourceSelection = body.resources;
      }

      // Check BEFORE anything is persisted: bad credentials are a 400 with
      // the connector's actionable message and leave no rows behind.
      const connectionId = randomUUID();
      const check = await checkCandidate(
        registered.manifest,
        connectionId,
        config,
        body.credentials ?? {},
      );
      if (!check.ok) {
        return check;
      }
      const credentials = body.credentials ? check.value : null;

      return inWorkspace(actor, async (tx) => {
        if (body.projectId) {
          const project = await findProject(
            tx,
            actor.workspaceId,
            body.projectId,
          );
          if (!project) {
            return fail(404, "project_not_found");
          }
        }
        const created = await insertConnection(tx, {
          id: connectionId,
          workspaceId: actor.workspaceId,
          connectorId: body.connectorId,
          name: body.name,
          config,
          credentialsEncrypted: credentials
            ? encrypt(credentialKeyring, credentials, {
                workspaceId: actor.workspaceId,
                connectionId,
              })
            : null,
          projectId: body.projectId ?? null,
          pollIntervalSeconds: registered.manifest.minRefreshIntervalSeconds,
        });
        // Transactional enqueue invariant: the connection, its state, and the
        // initial backfill job commit atomically.
        await enqueueJob(tx, {
          kind: "connection.backfill",
          workspaceId: actor.workspaceId,
          connectionId,
          idempotencyKey: `backfill:${connectionId}`,
        });
        await insertAuditEvent(tx, {
          workspaceId: actor.workspaceId,
          actorUserId: actor.callerId,
          action: "connection.created",
          target: connectionId,
          metadata: { name: body.name, connectorId: body.connectorId },
        });
        return ok(
          presentConnectionDetail(
            registry,
            created,
            signedKeyView(actor.workspaceId, created.row),
            actor.locale,
          ),
        );
      });
    },

    /** Checks credentials and discovers resources; persists nothing. */
    async preview(body: PreviewConnectionRequest) {
      const registered = registry.get(body.connectorId);
      if (!registered) {
        return fail(400, "invalid_request");
      }
      const usable = checkCredentialConnector(registered.manifest);
      if (!usable.ok) {
        return usable;
      }
      const validated = validateConfig(registered.manifest, body.config);
      if (!validated.ok) {
        return validated;
      }
      const provider = signedKeys.providerFor(
        registered.manifest,
        body.credentials,
      );
      if (provider) {
        return previewSignedKey(
          registered.connector,
          provider,
          validated.value,
          body.credentials,
        );
      }
      const context = {
        connectionId: "preview",
        config: validated.value,
        credentials: body.credentials ?? {},
      };
      let check;
      try {
        check = await executeCheck(registered.connector, context);
      } catch (error) {
        return fail(400, safeMessage(error));
      }
      if (!check.ok) {
        return ok({ check, resources: [] });
      }
      try {
        const resources = await executeDiscover(registered.connector, context);
        return ok({ check, resources });
      } catch (error) {
        return fail(400, safeMessage(error));
      }
    },

    /**
     * What an existing OAuth connection can read at its provider (finish
     * setup, change the property). The connector's discover gets a fresh
     * access token from the token service, never the refresh token, and the
     * response carries only the connector's resources (ADR 0012).
     */
    async discoverResources(
      actor: Actor,
      connectionId: string,
    ): Promise<Result<ConnectionResourcesResponse>> {
      const existing = await inWorkspace(actor, (tx) =>
        findConnection(tx, actor.workspaceId, connectionId),
      );
      if (!existing) {
        return fail(404, NOT_FOUND);
      }
      if (!existing.oauth) {
        return discoverWithSignedKey(actor, connectionId, existing);
      }
      const registered = registry.get(existing.row.connectorId);
      const strategy = registered
        ? oauthStrategyFor(registered.manifest, existing.oauth.provider)
        : undefined;
      if (!registered || !strategy) {
        return fail(400, "invalid_request");
      }
      const config = existing.row.config as Record<string, unknown>;
      try {
        const resources = await callWithAccessToken({
          tokens: oauthTokens,
          binding: { workspaceId: actor.workspaceId, connectionId },
          requiredScopes: strategy.scopes,
          call: (credentials, options) =>
            executeDiscover(
              registered.connector,
              { connectionId, config, credentials: { ...credentials } },
              options,
            ),
        });
        return ok({ resources });
      } catch (error) {
        return oauthCallFailure(error);
      }
    },

    /**
     * Runs one connector call for an existing connection with its stored
     * credentials: a freshly signed token for a signed key (ADR 0014), a
     * valid access token for OAuth (ADR 0012), or the stored credentials.
     * Setup problems are results; a failed call throws (redacted by the
     * runtime), for the caller to classify. Used for resource icons
     * (#226).
     */
    async callConnection<T>(
      actor: Actor,
      connectionId: string,
      call: (
        connector: Connector,
        context: ConnectionContext,
        options: ExecuteOptions,
      ) => Promise<T>,
    ): Promise<Result<T>> {
      const existing = await inWorkspace(actor, (tx) =>
        findConnection(tx, actor.workspaceId, connectionId),
      );
      if (!existing) {
        return fail(404, NOT_FOUND);
      }
      const registered = registry.get(existing.row.connectorId);
      if (!registered) {
        return fail(400, "connector_unavailable");
      }
      const config = existing.row.config as Record<string, unknown>;
      const connector = registered.connector;
      if (existing.oauth) {
        const strategy = oauthStrategyFor(
          registered.manifest,
          existing.oauth.provider,
        );
        if (!strategy) {
          return fail(400, "connector_unavailable");
        }
        return ok(
          await callWithAccessToken({
            tokens: oauthTokens,
            binding: { workspaceId: actor.workspaceId, connectionId },
            requiredScopes: strategy.scopes,
            call: (credentials, options) =>
              call(
                connector,
                { connectionId, config, credentials: { ...credentials } },
                options,
              ),
          }),
        );
      }
      const envelope = openEnvelope(actor.workspaceId, existing.row);
      if (!envelope.ok) {
        return envelope;
      }
      const key = storedSignedKey(registered.manifest, envelope.value);
      if (key && !key.ok) {
        return key;
      }
      if (key) {
        return ok(
          await callWithSignedKey({
            key: key.value,
            call: (tokenCredentials, options) =>
              call(
                connector,
                { connectionId, config, credentials: { ...tokenCredentials } },
                options,
              ),
          }),
        );
      }
      return ok(
        await call(
          connector,
          { connectionId, config, credentials: envelope.value },
          {},
        ),
      );
    },

    /**
     * Whether an App Store Connect connection holds the optional reviews
     * key (#190), read from its stored envelope without any provider call.
     */
    async hasReviewsKey(actor: Actor, connectionId: string): Promise<boolean> {
      const loaded = await appStoreConnection(actor, connectionId);
      return (
        loaded.ok && loaded.value.key.additional(REVIEWS_KEY_ID) !== undefined
      );
    },

    async list(actor: Actor) {
      const rows = await inWorkspace(actor, (tx) =>
        listConnectionRows(tx, actor.workspaceId),
      );
      return rows.map((loaded) =>
        presentConnection(registry, loaded, actor.locale),
      );
    },

    /** The connection with its 20 most recent sync runs. */
    async get(actor: Actor, connectionId: string) {
      const found = await inWorkspace(actor, async (tx) => {
        const loaded = await findConnection(
          tx,
          actor.workspaceId,
          connectionId,
        );
        if (!loaded) {
          return null;
        }
        const syncRuns = await listRecentSyncRuns(
          tx,
          actor.workspaceId,
          connectionId,
          20,
        );
        return { ...loaded, syncRuns };
      });
      if (!found) {
        return fail(404, NOT_FOUND);
      }
      return ok({
        connection: presentConnectionDetail(
          registry,
          found,
          signedKeyView(actor.workspaceId, found.row),
          actor.locale,
        ),
        syncRuns: found.syncRuns.map(presentSyncRun),
      });
    },

    async update(
      actor: Actor,
      connectionId: string,
      body: UpdateConnectionRequest,
    ): Promise<Result<ConnectionDetail>> {
      const existing = await inWorkspace(actor, (tx) =>
        findConnection(tx, actor.workspaceId, connectionId),
      );
      if (!existing) {
        return fail(404, NOT_FOUND);
      }
      const registered = registry.get(existing.row.connectorId);
      if (!registered) {
        return fail(400, "invalid_request");
      }
      // An OAuth connection's credentials are its grant: they change only
      // through reauthorization (ADR 0012), never by pasting a token.
      if (existing.oauth && body.credentials !== undefined) {
        return fail(400, "oauth_authorization_required");
      }

      const existingConfig = existing.row.config as Record<string, unknown>;
      let nextConfig: Record<string, unknown> | undefined;
      if (body.config !== undefined) {
        const validated = validateConfig(registered.manifest, body.config);
        if (!validated.ok) {
          return validated;
        }
        nextConfig = { ...validated.value };
        // PATCH cannot change the resource selection; carry it over.
        if (existingConfig.resourceSelection !== undefined) {
          nextConfig.resourceSelection = existingConfig.resourceSelection;
        }
      }

      if (body.projectId) {
        const projectId = body.projectId;
        const project = await inWorkspace(actor, (tx) =>
          findProject(tx, actor.workspaceId, projectId),
        );
        if (!project) {
          return fail(404, "project_not_found");
        }
      }

      // A config change of an OAuth connection is checked with a fresh access
      // token from the token service, never the stored refresh token.
      if (existing.oauth && body.config !== undefined) {
        const check = await checkOAuthConnection(
          actor,
          existing.row.connectorId,
          connectionId,
          existing.oauth.provider,
          nextConfig ?? existingConfig,
        );
        if (!check.ok) {
          return check;
        }
      }

      // Config or credential changes are re-checked against the connector
      // before they persist (same rule as creation).
      let storedCredentials: Record<string, unknown> | undefined;
      // An optional additional key (#190, the App Store reviews key) is
      // added, replaced or removed on its own: the main key and the
      // connection's auth state stay as they are.
      const additionalProvider =
        !existing.oauth && body.credentials !== undefined
          ? additionalKeyUpdate(registered.manifest, body.credentials)
          : null;
      let additionalChanges: Array<{
        key: string;
        change: "added" | "replaced" | "removed";
      }> | null = null;
      if (additionalProvider && body.credentials !== undefined) {
        if (body.config !== undefined) {
          return fail(
            400,
            "Change the configuration and the reviews key in separate requests.",
          );
        }
        const changed = await changeAdditionalKeys(
          actor.workspaceId,
          existing,
          registered.manifest,
          additionalProvider,
          body.credentials,
        );
        if (!changed.ok) {
          return changed;
        }
        storedCredentials = changed.value.stored;
        additionalChanges = changed.value.changes;
      } else if (
        !existing.oauth &&
        (body.config !== undefined || body.credentials !== undefined)
      ) {
        let credentials: Record<string, unknown>;
        if (body.credentials !== undefined) {
          credentials = body.credentials;
        } else if (existing.row.credentialsEncrypted) {
          try {
            credentials = JSON.parse(
              decryptCredentials(
                existing.row.credentialsEncrypted.toString("utf8"),
                credentialKeyring,
                { workspaceId: actor.workspaceId, connectionId },
              ),
            ) as Record<string, unknown>;
          } catch (error) {
            return fail(400, safeMessage(error));
          }
        } else {
          credentials = {};
        }
        // Rotation (ADR 0014): a new key is validated in full before it
        // replaces the envelope; a failure keeps the old one untouched. A
        // config change re-checks the stored main key only, so a paused
        // reviews key (#190) never blocks it.
        const check = await checkCandidate(
          registered.manifest,
          connectionId,
          nextConfig ?? existingConfig,
          credentials,
          { probeAdditional: body.credentials !== undefined },
        );
        if (!check.ok) {
          return check;
        }
        storedCredentials = check.value;
        if (body.credentials !== undefined) {
          // A rotated main key keeps the stored additional keys it does not
          // name, as long as it is a key of the same team (issuer).
          const carried = carryAdditionalKeys(
            registered.manifest,
            existing,
            actor.workspaceId,
            body.credentials,
            check.value,
          );
          storedCredentials = carried;
        }
      }

      const changes: ConnectionChanges = {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(nextConfig !== undefined ? { config: nextConfig } : {}),
        ...(body.credentials !== undefined
          ? {
              credentialsEncrypted: encrypt(
                credentialKeyring,
                storedCredentials ?? body.credentials,
                { workspaceId: actor.workspaceId, connectionId },
              ),
            }
          : {}),
        ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
      };

      return inWorkspace(actor, async (tx) => {
        const row = await updateConnectionRow(
          tx,
          actor.workspaceId,
          connectionId,
          changes,
        );
        if (!row) {
          return fail(404, NOT_FOUND);
        }
        let state = existing.state;
        let setupPending = row.setupPending;
        // Finishing setup (ADR 0012): a connection created by an OAuth
        // callback gets its first checked config. It is scheduled and its
        // backfill queued in this commit, like a newly created connection;
        // finishConnectionSetup lets only one concurrent finish do it.
        if (existing.row.setupPending && nextConfig !== undefined) {
          const finished = await finishConnectionSetup(
            tx,
            actor.workspaceId,
            connectionId,
          );
          if (finished) {
            state = finished;
            setupPending = false;
            await enqueueJob(tx, {
              kind: "connection.backfill",
              workspaceId: actor.workspaceId,
              connectionId,
              idempotencyKey: `backfill:${connectionId}`,
            });
            await insertAuditEvent(tx, {
              workspaceId: actor.workspaceId,
              actorUserId: actor.callerId,
              action: "connection.setup_finished",
              target: connectionId,
              metadata: { connectorId: row.connectorId },
            });
          }
        }
        // A config change that alters what the connection collects reads the
        // connector's whole backfill window again with the new config (#153).
        // Observations collected under the old config stay (ADR 0008: a
        // series is its dimensions; e.g. an earlier breakdown's series are
        // kept, not deleted). Renames, project moves and new credentials or
        // reauthorization keep the history and continue from the cursor.
        const refetch =
          !existing.row.setupPending &&
          registered.manifest.supportsBackfill &&
          ((nextConfig !== undefined &&
            configChanged(registered.manifest, existingConfig, nextConfig)) ||
            // A new reviews key (#190) reads the review history of the
            // backfill window.
            (additionalChanges ?? []).some(
              (entry) => entry.change !== "removed",
            ));
        if (refetch) {
          await requestConnectionBackfill(tx, {
            workspaceId: actor.workspaceId,
            connectionId,
          });
        }
        if (additionalChanges !== null) {
          // The main key is unchanged: its auth state stays as it is.
          for (const entry of additionalChanges) {
            await insertAuditEvent(tx, {
              workspaceId: actor.workspaceId,
              actorUserId: actor.callerId,
              action: "connection.credentials_updated",
              target: connectionId,
              metadata: {
                connectorId: row.connectorId,
                key: entry.key,
                change: entry.change,
                ...(refetch ? { backfillRequested: true } : {}),
              },
            });
          }
        } else if (body.credentials !== undefined) {
          // Recovery path for auth_failed/outage: fresh credentials make the
          // connection due immediately and reset the failure streak.
          state =
            (await resetConnectionAuth(tx, actor.workspaceId, connectionId)) ??
            state;
          await insertAuditEvent(tx, {
            workspaceId: actor.workspaceId,
            actorUserId: actor.callerId,
            action: "connection.credentials_updated",
            target: connectionId,
            metadata: { connectorId: row.connectorId },
          });
        }
        if (
          body.name !== undefined ||
          nextConfig !== undefined ||
          body.projectId !== undefined
        ) {
          await insertAuditEvent(tx, {
            workspaceId: actor.workspaceId,
            actorUserId: actor.callerId,
            action: "connection.updated",
            target: connectionId,
            metadata: {
              connectorId: row.connectorId,
              changed: [
                ...(body.name !== undefined ? ["name"] : []),
                ...(nextConfig !== undefined ? ["config"] : []),
                ...(body.projectId !== undefined ? ["projectId"] : []),
              ],
              ...(refetch ? { backfillRequested: true } : {}),
            },
          });
        }
        return ok(
          presentConnectionDetail(
            registry,
            {
              row: { ...row, setupPending },
              state,
              oauth: existing.oauth,
            },
            signedKeyView(actor.workspaceId, row),
            actor.locale,
          ),
        );
      });
    },

    /**
     * Deletes a connection. For an OAuth connection (ADR 0012, "Disconnect")
     * the whole disconnect runs under the session-level grant lock of its
     * provider account: oauth_release_grant (in the deleting transaction)
     * says whether another connection on the instance still uses the grant,
     * and only when none does is the refresh token revoked at the provider,
     * after commit, best effort, before the lock is released. A callback
     * storing a grant of the same account waits for the lock, so the
     * provider's account-wide revocation cannot hit a grant stored in
     * between. A failed revocation still deletes and is reported.
     */
    async remove(
      actor: Actor,
      connectionId: string,
    ): Promise<Result<DeleteConnectionResponse>> {
      // The grant's account decides the lock; a reauthorization may change
      // the account while this waits, so it is read again under the lock.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const linked = await inWorkspace(actor, (tx) =>
          findConnectionOAuth(tx, actor.workspaceId, connectionId),
        );
        const key = linked
          ? { provider: linked.provider, accountSub: linked.accountSub }
          : null;
        const outcome = key
          ? await withOAuthGrantLocks(db, [key], (lockedDb) =>
              disconnect(lockedDb, actor, connectionId, key),
            )
          : await disconnect(db, actor, connectionId, null);
        if (outcome !== "account_changed") {
          return outcome;
        }
      }
      return fail(400, "connection_busy");
    },

    /** Reuses a sync that is already waiting instead of queueing another. */
    async requestSync(actor: Actor, connectionId: string) {
      return inWorkspace(actor, async (tx) => {
        const loaded = await findConnection(
          tx,
          actor.workspaceId,
          connectionId,
        );
        if (!loaded) {
          return fail<string>(404, NOT_FOUND);
        }
        // Not syncable before its setup is finished (ADR 0012).
        if (loaded.row.setupPending) {
          return fail<string>(400, "connection_setup_pending");
        }
        // The grant no longer works: a sync can only fail until the
        // connection is reconnected, which then schedules one itself.
        if (loaded.state?.authState === "needs_reauthorization") {
          return fail<string>(400, "oauth_reauthorization_required");
        }
        const jobId = await requestConnectionSync(tx, {
          workspaceId: actor.workspaceId,
          connectionId,
        });
        await insertAuditEvent(tx, {
          workspaceId: actor.workspaceId,
          actorUserId: actor.callerId,
          action: "connection.sync_requested",
          target: connectionId,
          metadata: { jobId },
        });
        return ok(jobId);
      });
    },

    /**
     * App Store analytics per app (#174), read with the connection's stored
     * key: requested or not, stopped, and whether analytics data arrived.
     */
    async appStoreAnalytics(
      actor: Actor,
      connectionId: string,
    ): Promise<Result<AppStoreAnalyticsStatusResponse>> {
      const loaded = await appStoreConnection(actor, connectionId);
      if (!loaded.ok) {
        return loaded;
      }
      const { key, selection } = loaded.value;
      const latest = await inWorkspace(actor, (tx) =>
        latestObservationByResource(tx, actor.workspaceId, connectionId, [
          ANALYTICS_METRIC_KEYS.impressions,
          ANALYTICS_METRIC_KEYS.productPageViews,
          ANALYTICS_METRIC_KEYS.storeDownloads,
        ]),
      );
      const status = await appStoreAnalyticsStatus({
        key,
        http: signedKeys.httpFor(key.provider),
        selection,
        latest,
      });
      if (!status.ok) {
        return fail(400, status.message);
      }
      return ok({ apps: status.value, keysUrl: APP_STORE_CONNECT_KEYS_URL });
    },

    /**
     * The optional reviews key (#190): stored or not, and whether Apple
     * still accepts it, asked live with its own freshly signed token.
     */
    async appStoreReviews(
      actor: Actor,
      connectionId: string,
    ): Promise<Result<AppStoreReviewsStatusResponse>> {
      const loaded = await appStoreConnection(actor, connectionId);
      if (!loaded.ok) {
        return loaded;
      }
      const { existing, key } = loaded.value;
      return ok(
        await appStoreReviewsStatus({
          key,
          http: signedKeys.httpFor(key.provider),
          config: existing.row.config as Record<string, unknown>,
        }),
      );
    },

    /**
     * "Enable App Store analytics" (ADR 0014, #174): the temporary Admin
     * key in the body is checked like any App Store Connect key (format,
     * P-256), used in memory to create the missing ONGOING report requests
     * of the connection's apps, and dropped. It is never stored, enqueued
     * or logged; the audit event names the apps only.
     */
    async enableAppStoreAnalytics(
      actor: Actor,
      connectionId: string,
      body: EnableAppStoreAnalyticsRequest,
    ): Promise<Result<EnableAppStoreAnalyticsResponse>> {
      const loaded = await appStoreConnection(actor, connectionId);
      if (!loaded.ok) {
        return loaded;
      }
      const { existing, key: storedKey, selection } = loaded.value;
      const provider = storedKey.provider;
      const adminKey = signedKeys.parse(provider, body.credentials);
      if (!adminKey.ok) {
        return fail(400, adminKey.message);
      }
      const storedIssuer = storedKey.publicFields.issuerId;
      if (
        storedIssuer !== undefined &&
        adminKey.value.publicFields.issuerId !== storedIssuer
      ) {
        return fail(
          400,
          `This key belongs to another App Store Connect team. Use an Admin key of the team with issuer ID ${storedIssuer}.`,
        );
      }
      const enabled = await enableAppStoreAnalytics({
        adminKey: adminKey.value,
        http: signedKeys.httpFor(provider),
        selection,
      });
      if (!enabled.ok) {
        return fail(400, enabled.message);
      }
      const ids = (outcome: string) =>
        enabled.value
          .filter((app) => app.outcome === outcome)
          .map((app) => app.appId);
      await inWorkspace(actor, (tx) =>
        insertAuditEvent(tx, {
          workspaceId: actor.workspaceId,
          actorUserId: actor.callerId,
          action: "connection.analytics_enabled",
          target: connectionId,
          metadata: {
            connectorId: existing.row.connectorId,
            created: ids("created"),
            existing: ids("existing"),
            failed: ids("failed"),
          },
        }),
      );
      return ok({ apps: enabled.value, keysUrl: APP_STORE_CONNECT_KEYS_URL });
    },

    async listObservations(
      actor: Actor,
      connectionId: string,
      query: ObservationListQuery,
    ) {
      const rows = await inWorkspace(actor, async (tx) => {
        const loaded = await findConnection(
          tx,
          actor.workspaceId,
          connectionId,
        );
        if (!loaded) {
          return null;
        }
        const observations = await listObservationRows(
          tx,
          actor.workspaceId,
          connectionId,
          {
            ...(query.metricKey ? { metricKey: query.metricKey } : {}),
            ...(query.from ? { from: new Date(query.from) } : {}),
            ...(query.to ? { to: new Date(query.to) } : {}),
            limit: query.limit,
          },
        );
        // The names the connector reported for the resources (#196).
        const names = await findResourceNames(
          tx,
          actor.workspaceId,
          [
            ...new Set(
              observations.flatMap((row) => {
                const resource = (row.dimensions as Record<string, string>)
                  .resource;
                return resource ? [resource] : [];
              }),
            ),
          ].map((resourceId) => ({ connectionId, resourceId })),
        );
        return { observations, names };
      });
      if (!rows) {
        return fail(404, NOT_FOUND);
      }
      return ok(
        rows.observations.map((row) => {
          const dimensions = row.dimensions as Record<string, string>;
          return {
            metricKey: row.metricKey,
            seriesKey: row.seriesKey,
            sourceTimestamp: row.sourceTimestamp.toISOString(),
            value: row.value,
            dimensions,
            ingestedAt: row.ingestedAt.toISOString(),
            resourceName: dimensions.resource
              ? (rows.names.get(
                  resourceNameKey(connectionId, dimensions.resource),
                ) ?? null)
              : null,
          };
        }),
      );
    },
  };
}

export type ConnectionService = ReturnType<typeof createConnectionService>;
