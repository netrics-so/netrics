import { randomUUID } from "node:crypto";

import type {
  AppStoreAnalyticsStatusResponse,
  AppStoreReviewsStatusResponse,
  ConnectionItemImages,
  ConnectionRecordSkips,
  ConnectionPreviewResponse,
  ConnectionResourcesResponse,
  ConnectionSignedKeyView,
  SignedKeyPairResponse,
  ConnectorAuthStrategy,
  CreateConnectionRequest,
  CreateConnectionsRequest,
  CreateSharedKeyConnectionsRequest,
  DeleteConnectionResponse,
  EnableAppStoreAnalyticsRequest,
  EnableAppStoreAnalyticsResponse,
  LatestReviewRequestParsed,
  LatestReviewResponse,
  ObservationListQuery,
  PreviewConnectionRequest,
  SharedKeyResourcesResponse,
  UpdateConnectionRequest,
  StoredConnectionPreviewRequest,
  StoredConnectionPreviewResponse,
} from "@netrics/contracts";
import {
  connectorDatasetRetention,
  CUSTOM_API_IMAGE_SKIP_REASONS,
  HISTORY_RELOAD_INTERVAL_HOURS,
  validateConnectionConfig,
  type ConnectionHistory,
  type ConnectionRetentionChoice,
} from "@netrics/contracts";
import { retentionNamesDatasets } from "./retention.js";
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
import { ANALYTICS_METRIC_KEYS, ANALYTICS_STREAM } from "@netrics/connectors";
import { upgradeCustomApiDefinition } from "@netrics/connector-sdk/custom-api";
import { CUSTOM_API_CONNECTOR_ID } from "@netrics/connectors/custom-api";
import {
  DEFAULT_LOCALE,
  connectorHasReviews,
  localizedManifest,
  type Locale,
} from "@netrics/domain";
import {
  activeBackfillConnections,
  connectionBackfillState,
  datasetVersions,
  deleteConnection as deleteConnectionRow,
  deleteConnectionAppReviews,
  enqueueJob,
  findBackfillingConnectionIds,
  findConnection,
  findConnectionOAuth,
  finishConnectionSetup,
  findProject,
  findResourceNames,
  lockHistoryReload,
  lockWorkspaceBackfills,
  markHistoryReloadRequested,
  hideAppReview,
  insertAuditEvent,
  insertConnection,
  latestObservationByResource,
  listConnections as listConnectionRows,
  listObservations as listObservationRows,
  listConnectionFreshness,
  listStreamImages,
  listStreamRecords,
  listRecentSyncRuns,
  releaseOAuthGrant,
  latestBackfillFailed,
  requestConnectionBackfill,
  requestConnectionSync,
  resetConnectionAuth,
  resourceNameKey,
  storedDatasetsMissingBackfill,
  updateConnection as updateConnectionRow,
  withOAuthGrantLocks,
  withWorkspace,
  type ConnectionChanges,
  type ConnectionWithState,
  type Database,
  type Transaction,
  type ProjectFilter,
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
  connectionOAuthProvider,
  NeedsReauthorizationError,
  requiredOAuthScopes,
} from "../oauth/connector-auth.js";
import {
  CUSTOM_OAUTH_PROVIDER_ID,
  type CustomOAuthProvider,
} from "../oauth/providers/custom.js";
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
  ADMIN_ROLE_REQUIRED,
  APP_STORE_CONNECT_KEYS_URL,
  REVIEWS_KEY_CANNOT_REQUEST,
  SALES_KEY_CANNOT_REQUEST,
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
  SignedKeyExchangeError,
  type SignedKey,
  type SignedKeyProviders,
} from "../signed-keys/registry.js";
import { createSignedKeyTokenStore } from "../signed-keys/token-store.js";
import {
  createPendingKeyStore,
  PENDING_KEY_UNUSABLE,
  type PendingKeyStore,
} from "../signed-keys/pending-keys.js";
import { PREVIEW_CONNECTORS } from "../preview-connectors.js";
import {
  callOptionsFor,
  connectorFor,
  type ResolvedConnector,
} from "../custom-api/connectors.js";
import {
  prepareCustomApiUpdate,
  CustomOAuthClientChangeRefused,
  prepareCustomOAuthClientChange,
  type CustomOAuthClientChange,
} from "../custom-api/connections.js";

/** Ends a transaction with a refusal, rolling back what it wrote. */
class RollBack<T> extends Error {
  constructor(readonly result: T) {
    super("rolled back");
    this.name = "RollBack";
  }
}
import { latestReview, storedReviewsKey } from "../reviews/latest.js";
import {
  applyFreshness,
  createFreshnessReader,
  REVIEWS_FRESHNESS_STREAM,
} from "../dashboards/freshness.js";
import {
  presentConnection,
  presentConnectionDetail,
  presentFreshness,
  presentSyncRun,
  toStateView,
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
  /** Default: pending generated keys over db and keyring (ADR 0020 §3). */
  pendingKeys?: PendingKeyStore;
  /**
   * Connectors the catalog marks as previews. Default: PREVIEW_CONNECTORS;
   * tests pass their own.
   */
  previews?: ReadonlySet<string>;
  /** Tests only: options for every connector call (e.g. local egress). */
  executeOptions?: ExecuteOptions;
  /**
   * Self-host only (NETRICS_CUSTOM_API_PRIVATE_HOSTS): private hosts the
   * custom-api connector may reach. Never given to bundled connectors.
   */
  customApiPrivateHosts?: readonly string[];
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

/** A "Reload history" result: also busy (409) and rate limited (429). */
export type HistoryReloadResult =
  | Result<{ jobId: string; reloadAvailableAt: string }>
  | { ok: false; status: 409 | 429; error: string };

const NOT_FOUND = "connection_not_found";
/** Custom API connections come from a definition (milestone 13). */
export const CUSTOM_API_REQUIRES_DEFINITION = "custom_api_requires_definition";

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
 * change. Resource selections compare as sets; null follows all resources.
 */
function configChanged(
  manifest: ConnectorManifest,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  const normalize = (config: Record<string, unknown>): string => {
    const { resourceSelection: _selection, ...rest } = config;
    const validated = validateConnectionConfig(manifest.configSchema, rest);
    return canonicalJson({
      config: validated.ok ? validated.config : rest,
      selection: resourceSelectionOf(config),
    });
  };
  return normalize(before) !== normalize(after);
}

function resourceSelectionOf(config: Record<string, unknown>): string[] | null {
  const value = config.resourceSelection;
  return Array.isArray(value)
    ? [
        ...new Set(value.filter((id): id is string => typeof id === "string")),
      ].sort()
    : null;
}

/**
 * Runs the connector check for a candidate config/credentials pair. A failed
 * or thrown check is a 400 with the connector's actionable, already-redacted
 * message; callers persist nothing in that case.
 */
export async function checkCredentials(
  registered: ResolvedConnector | undefined,
  connectionId: string,
  config: Record<string, unknown>,
  credentials: Record<string, unknown>,
  options: {
    executeOptions?: ExecuteOptions;
    privateHosts?: readonly string[];
  } = {},
): Promise<Result<true>> {
  if (!registered) {
    return fail(400, "invalid_request");
  }
  try {
    const check = await executeCheck(
      registered.connector,
      { connectionId, config, credentials },
      callOptionsFor(registered, options.executeOptions ?? {}, {
        credentials,
        config,
        privateHosts: options.privateHosts ?? [],
      }),
    );
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
  // errors are redacted of the token at the runtime boundary. A failed
  // token exchange (ADR 0020) names no status or code to the user.
  if (error instanceof SignedKeyExchangeError) {
    return fail(
      400,
      "The provider's sign-in service could not be reached. Try again in a few minutes.",
    );
  }
  return fail(
    400,
    error instanceof SignedKeyRejectedError
      ? error.message
      : safeMessage(error),
  );
}

/** Which key a signed-key view names: provider and non-secret fields. */
function signedKeyIdentity(view: ConnectionSignedKeyView): string {
  return canonicalJson({
    provider: view.provider,
    fields: Object.fromEntries(
      view.fields.map((field) => [field.key, field.value]),
    ),
  });
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
): Pick<
  ConnectorAuthStrategy,
  "providerName" | "generatedKeyPair" | "fields" | "setup"
> {
  return {
    providerName: provider.name,
    ...(provider.generatedKeyPair ? { generatedKeyPair: true } : {}),
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

/**
 * Connectors whose key may serve several connections, one account each
 * (#395): the resource kind their discovery lists the key's accounts as,
 * with no account configured, and the config key naming a connection's
 * account. Apple Ads: one API user's key reads several ad accounts.
 */
interface KeySharing {
  resourceKind: string;
  configKey: string;
}

const KEY_SHARING: Readonly<Record<string, KeySharing>> = {
  "apple-ads": { resourceKind: "ad_account", configKey: "adAccountId" },
};

const SHARED_KEY_UNSUPPORTED = "shared_key_unsupported";

/** The stored key of an existing connection, lent to new ones (#395). */
interface LentKey {
  connectionId: string;
  /** The decrypted envelope; never logged, returned or enqueued. */
  credentials: Record<string, unknown>;
  sharing: KeySharing;
  /** The ciphertext the checks ran with, compared again when storing. */
  envelope: Buffer;
}

/** The account a connection's config names, as discovery's resource id. */
function configAccount(
  config: Readonly<Record<string, unknown>>,
  sharing: KeySharing,
): string | undefined {
  const value = config[sharing.configKey];
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

/** Account → connection, for the workspace's connections of a connector. */
function connectedAccounts(
  rows: readonly ConnectionWithState[],
  connectorId: string,
  sharing: KeySharing,
): Map<string, { id: string; name: string }> {
  const connected = new Map<string, { id: string; name: string }>();
  for (const { row } of rows) {
    if (row.connectorId !== connectorId) {
      continue;
    }
    const account = configAccount(
      row.config as Record<string, unknown>,
      sharing,
    );
    if (account && !connected.has(account)) {
      connected.set(account, { id: row.id, name: row.name });
    }
  }
  return connected;
}

/** When the next "Reload history" may be requested after one at `at`. */
function reloadAvailableAt(at: Date | null): Date | null {
  return at
    ? new Date(at.getTime() + HISTORY_RELOAD_INTERVAL_HOURS * 60 * 60 * 1000)
    : null;
}

/**
 * The declared datasets the connection stores and no backfill has read
 * (#617, #634). None while nothing is recorded (a connection from before
 * #617, recorded by its next sync), during setup, or without backfills.
 */
async function incompleteHistory(
  tx: Transaction,
  loaded: ConnectionWithState,
  registry: ConnectorRegistry,
): Promise<string[]> {
  const { row, state } = loaded;
  const manifest = connectorFor(registry, loaded)?.manifest;
  const recorded = state?.backfilledDatasets ?? null;
  if (!recorded || row.setupPending || !manifest?.supportsBackfill) return [];
  return storedDatasetsMissingBackfill(tx, {
    workspaceId: row.workspaceId,
    connectionId: row.id,
    declared: datasetVersions(manifest.datasets),
    backfilled: recorded,
  });
}

/**
 * The connection page's history status (#617): whether a backfill waits or
 * runs, which datasets no backfill has read yet, and the reload slot.
 */
function historyView(
  loaded: ConnectionWithState,
  backfill: "idle" | "queued" | "running",
  missing: string[],
  registry: ConnectorRegistry,
  now: Date = new Date(),
): ConnectionHistory {
  const { state } = loaded;
  const manifest = connectorFor(registry, loaded)?.manifest;
  const availableAt = reloadAvailableAt(
    state?.historyReloadRequestedAt ?? null,
  );
  return {
    supportsBackfill: manifest?.supportsBackfill === true,
    backfillDays: manifest?.backfillDays ?? 0,
    backfill,
    incompleteDatasets: missing.map((key) => ({
      key,
      name: manifest?.datasets?.find((d) => d.key === key)?.name ?? key,
    })),
    reloadAvailableAt:
      availableAt && availableAt > now ? availableAt.toISOString() : null,
  };
}

/**
 * The auth type a stored custom API definition names, read without
 * decoding the definition (one that no longer decodes, #829).
 */
function storedCustomAuthType(document: unknown): string | null {
  const auth =
    document && typeof document === "object"
      ? (document as { auth?: unknown }).auth
      : undefined;
  const type =
    auth && typeof auth === "object"
      ? (auth as { type?: unknown }).type
      : undefined;
  return typeof type === "string" ? type : null;
}

export function createConnectionService(deps: ConnectionServiceDeps) {
  const { db, registry, credentialKeyring, oauthProviders } = deps;
  /** Execute options of connector checks: test egress, custom API private hosts. */
  const callOptions = {
    ...(deps.executeOptions ? { executeOptions: deps.executeOptions } : {}),
    privateHosts: deps.customApiPrivateHosts ?? [],
  };
  const signedKeys = deps.signedKeys ?? createSignedKeyProviders();
  const previews = deps.previews ?? PREVIEW_CONNECTORS;
  // Cached exchanged tokens of stored signed keys (ADR 0020 §2); candidate
  // keys (create, preview, rotation) are never cached.
  const signedKeyTokens = createSignedKeyTokenStore({ db, credentialKeyring });
  const pendingKeys =
    deps.pendingKeys ?? createPendingKeyStore({ db, credentialKeyring });
  const signedKeyCache = (
    key: SignedKey,
    workspaceId: string,
    connectionId: string,
  ) =>
    key.exchanges
      ? { cache: signedKeyTokens.forConnection({ workspaceId, connectionId }) }
      : {};
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
    registered: ResolvedConnector,
    connectionId: string,
    provider: string,
    config: Record<string, unknown>,
  ): Promise<Result<true>> {
    const requiredScopes = requiredOAuthScopes(registered, provider);
    if (!requiredScopes) {
      return fail(400, "invalid_request");
    }
    try {
      const check = await callWithAccessToken({
        tokens: oauthTokens,
        binding: { workspaceId: actor.workspaceId, connectionId },
        requiredScopes,
        call: (credentials, options) =>
          executeCheck(
            registered.connector,
            { connectionId, config, credentials: { ...credentials } },
            callOptionsFor(
              registered,
              { ...deps.executeOptions, ...options },
              {
                credentials: { ...credentials },
                config,
                privateHosts: callOptions.privateHosts,
              },
            ),
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

  async function callStoredConnection<T>(
    actor: Actor,
    connectionId: string,
    call: (
      connector: Connector,
      context: ConnectionContext,
      options: ExecuteOptions,
    ) => Promise<T>,
    configOverride?: Record<string, unknown>,
    rejected?: (value: T) => boolean,
  ): Promise<Result<T>> {
    const existing = await inWorkspace(actor, (tx) =>
      findConnection(tx, actor.workspaceId, connectionId),
    );
    if (!existing) {
      return fail(404, NOT_FOUND);
    }
    const registered = connectorFor(registry, existing);
    if (!registered) {
      return fail(400, "connector_unavailable");
    }
    const config =
      configOverride ?? (existing.row.config as Record<string, unknown>);
    const connector = registered.connector;
    /** Every call through here: custom API egress, bounds and redaction (ADR 0027). */
    const optionsFor = (
      base: ExecuteOptions,
      credentials: Record<string, unknown>,
    ): ExecuteOptions =>
      callOptionsFor(
        registered,
        { ...deps.executeOptions, ...base },
        { credentials, config, privateHosts: callOptions.privateHosts },
      );
    const oauthProvider = connectionOAuthProvider(
      registered,
      existing.oauth?.provider,
    );
    if (oauthProvider) {
      const requiredScopes = requiredOAuthScopes(registered, oauthProvider);
      if (!requiredScopes) {
        return fail(400, "connector_unavailable");
      }
      return ok(
        await callWithAccessToken({
          tokens: oauthTokens,
          binding: { workspaceId: actor.workspaceId, connectionId },
          requiredScopes,
          rejected,
          call: (credentials, options) =>
            call(
              connector,
              { connectionId, config, credentials: { ...credentials } },
              optionsFor(options, { ...credentials }),
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
          ...signedKeyCache(key.value, actor.workspaceId, connectionId),
          rejected,
          call: (tokenCredentials, options) =>
            call(
              connector,
              { connectionId, config, credentials: { ...tokenCredentials } },
              optionsFor(options, { ...tokenCredentials }),
            ),
        }),
      );
    }
    return ok(
      await call(
        connector,
        { connectionId, config, credentials: envelope.value },
        optionsFor({}, envelope.value),
      ),
    );
  }

  /** Check a draft configuration using stored credentials, without importing. */
  async function previewStoredConnection(
    actor: Actor,
    connectionId: string,
    input: StoredConnectionPreviewRequest,
  ): Promise<Result<StoredConnectionPreviewResponse>> {
    const existing = await inWorkspace(actor, (tx) =>
      findConnection(tx, actor.workspaceId, connectionId),
    );
    if (!existing) return fail(404, NOT_FOUND);
    const registered = connectorFor(registry, existing);
    if (!registered) return fail(400, "connector_unavailable");
    const validated = validateConfig(registered.manifest, input.config);
    if (!validated.ok) return validated;
    const selection = resourceSelectionOf(
      existing.row.config as Record<string, unknown>,
    );
    try {
      const checked = await callStoredConnection(
        actor,
        connectionId,
        (connector, context, options) =>
          executeCheck(connector, context, options),
        validated.value,
        (result) => !result.ok,
      );
      if (!checked.ok) return checked;
      if (!checked.value.ok)
        return ok({ check: checked.value, resources: [], selection });
      const discovered = await callStoredConnection(
        actor,
        connectionId,
        (connector, context, options) =>
          executeDiscover(connector, context, options),
        validated.value,
      );
      if (!discovered.ok) return discovered;
      // A connector that cannot name an app right now (Google Play without
      // the Reporting API lists package names) keeps the name an earlier
      // sync stored, so the picker shows app names (#623).
      const unnamed = discovered.value.filter(
        (resource) => resource.name === resource.id,
      );
      const stored = unnamed.length
        ? await inWorkspace(actor, (tx) =>
            findResourceNames(
              tx,
              actor.workspaceId,
              unnamed.map((resource) => ({
                connectionId,
                resourceId: resource.id,
              })),
            ),
          )
        : new Map<string, string>();
      const resources = discovered.value.map((resource) => {
        const name =
          resource.name === resource.id
            ? stored.get(resourceNameKey(connectionId, resource.id))
            : undefined;
        return name ? { ...resource, name } : resource;
      });
      return ok({ check: checked.value, resources, selection });
    } catch (error) {
      return connectionOAuthProvider(registered, existing.oauth?.provider)
        ? oauthCallFailure(error)
        : signedKeyCallFailure(error);
    }
  }

  /**
   * Credentials that name a key pair netrics generated (ADR 0020 §3,
   * #371): the pending private key of the caller, in this workspace, of the
   * connector's signed-key provider, is put in the private key field, so
   * validation, probes and the connector check run as for a pasted key.
   * The key is not consumed here: the storing transaction does that
   * (`consumePending`). Without `pendingKeyId` the credentials are as sent.
   */
  async function withPendingKey(
    actor: Actor,
    manifest: ConnectorManifest,
    credentials: Record<string, unknown> | undefined,
    pendingKeyId: string | undefined,
  ): Promise<
    Result<{
      credentials: Record<string, unknown> | undefined;
      pending: { provider: string; id: string } | null;
    }>
  > {
    if (pendingKeyId === undefined) {
      return ok({ credentials, pending: null });
    }
    const strategy = manifest.authStrategies.find(
      (entry) => entry.strategy === "signed-key",
    );
    const provider =
      strategy?.strategy === "signed-key"
        ? signedKeys.get(strategy.provider)
        : undefined;
    const field = provider?.fields.find((entry) => entry.privateKey);
    if (!provider?.generatedKeyPair || !field) {
      return fail(400, "This connector does not take a generated key pair.");
    }
    if (credentials && field.key in credentials) {
      return fail(
        400,
        `Send either the generated key pair or a ${field.label}, not both.`,
      );
    }
    const privateKey = await pendingKeys.privateKey(
      { workspaceId: actor.workspaceId, userId: actor.callerId },
      provider.id,
      pendingKeyId,
    );
    if (privateKey === null) {
      return fail(400, PENDING_KEY_UNUSABLE);
    }
    return ok({
      credentials: { ...(credentials ?? {}), [field.key]: privateKey },
      pending: { provider: provider.id, id: pendingKeyId },
    });
  }

  /**
   * Deletes the pending key whose private key this transaction stores; a
   * 400 (and nothing stored) when a concurrent request took it first or it
   * expired meanwhile.
   */
  async function consumePending(
    tx: Transaction,
    actor: Actor,
    pending: { provider: string; id: string } | null,
  ): Promise<Result<true>> {
    if (!pending) {
      return ok(true);
    }
    const consumed = await pendingKeys.consume(
      tx,
      { workspaceId: actor.workspaceId, userId: actor.callerId },
      pending.provider,
      pending.id,
    );
    return consumed ? ok(true) : fail(400, PENDING_KEY_UNUSABLE);
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
    registered: ResolvedConnector,
    connectionId: string,
    config: Record<string, unknown>,
    credentials: Record<string, unknown>,
    options: { probeAdditional?: boolean } = {},
  ): Promise<Result<Record<string, unknown>>> {
    const manifest = registered.manifest;
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
      registered,
      connectionId,
      config,
      credentials,
      callOptions,
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
   * Whether the connector keeps review text with an additional reviews key
   * (ADR 0019 §11): its signed-key provider declares one.
   */
  function hasReviewsKey(manifest: ConnectorManifest): boolean {
    const strategy = manifest.authStrategies.find(
      (entry) => entry.strategy === "signed-key",
    );
    const provider =
      strategy?.strategy === "signed-key"
        ? signedKeys.get(strategy.provider)
        : undefined;
    return (provider?.additionalKeys ?? []).some(
      (key) => key.id === REVIEWS_KEY_ID,
    );
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
    const registered = connectorFor(registry, existing);
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
        ...signedKeyCache(key.value, actor.workspaceId, connectionId),
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
          /** A custom API's own OAuth app (#805), built before the delete. */
          custom: CustomOAuthProvider | null;
          /** A custom client-credentials grant: no consent to withdraw. */
          clientCredentials: boolean;
        } | null = null;
        if (grant) {
          let refreshToken: string | null;
          let custom: CustomOAuthProvider | null = null;
          let clientCredentials = false;
          if (grant.provider === CUSTOM_OAUTH_PROVIDER_ID) {
            // Endpoints from the pinned definition, client and refresh
            // token from the custom envelope.
            const resolved = await oauthTokens.customOAuth?.resolve(tx, {
              workspaceId: actor.workspaceId,
              connectionId,
            });
            custom = resolved?.provider ?? null;
            // A definition that no longer decodes still names its grant
            // type (#829).
            clientCredentials = resolved
              ? resolved.provider.grant === "client_credentials"
              : storedCustomAuthType(loaded.customApi?.document) ===
                "oauth_client_credentials";
            // Never sent to hosts it was not entered for.
            refreshToken = resolved?.bindingHeld
              ? resolved.credentials.refreshToken
              : null;
          } else {
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
          }
          const shared = await releaseOAuthGrant(tx, {
            provider: grant.provider,
            accountSub: grant.accountSub,
            connectionId,
          });
          release = {
            provider: grant.provider,
            refreshToken,
            shared,
            custom,
            clientCredentials,
          };
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
    if (release.clientCredentials) {
      // A client-credentials grant has no user consent to withdraw; its
      // cached token was deleted with the connection.
      return ok({ revocation: null });
    }
    if (release.provider === CUSTOM_OAUTH_PROVIDER_ID) {
      // Without a revoke URL nothing is sent: the user removes access at
      // the provider (the authorize URL's origin).
      const revoked =
        release.custom && release.refreshToken
          ? await oauthTokens.revokeCustomGrant(
              release.custom,
              release.refreshToken,
            )
          : false;
      return ok({
        revocation: {
          provider: release.provider,
          status: revoked ? "revoked" : "failed",
          accountPermissionsUrl:
            release.custom?.definition.accountPermissionsUrl ?? null,
        },
      });
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

  /**
   * Creates connections of one connector with one credential (one, or
   * several for e.g. several Apple Ads ad accounts of one key, #375). Each
   * connection is checked with the credential and its own config BEFORE
   * anything is persisted: bad credentials are a 400 with the connector's
   * actionable message and leave no rows behind. Then every connection, its
   * state and initial backfill job, and the consumed pending key commit in
   * one transaction.
   */
  async function createConnections(
    actor: Actor,
    body: CreateConnectionsRequest & { retention?: ConnectionRetentionChoice },
    lent?: LentKey,
  ): Promise<Result<ConnectionDetail[]>> {
    // A custom API connection needs a definition, environment and pin.
    if (body.connectorId === CUSTOM_API_CONNECTOR_ID) {
      return fail(400, CUSTOM_API_REQUIRES_DEFINITION);
    }
    const registered = connectorFor(registry, {
      row: { connectorId: body.connectorId },
      customApi: null,
    });
    if (!registered) {
      return fail(400, "invalid_request");
    }
    // Retention chosen in setup (#492) names only the connector's datasets.
    if (
      body.retention &&
      !retentionNamesDatasets(registered.manifest, body.retention)
    ) {
      return fail(400, "retention_dataset_unknown");
    }
    const usable = checkCredentialConnector(registered.manifest);
    if (!usable.ok) {
      return usable;
    }
    const entries: Array<{
      id: string;
      name: string;
      config: Record<string, unknown>;
    }> = [];
    const seen = new Set<string>();
    for (const entry of body.connections) {
      const validated = validateConfig(registered.manifest, entry.config);
      if (!validated.ok) {
        return validated;
      }
      const config = { ...validated.value };
      if (
        entry.resources !== undefined &&
        (registered.manifest.supportsResourceSelection ||
          entry.resources.length > 0)
      ) {
        config.resourceSelection = [...new Set(entry.resources)].sort();
      }
      // Two connections of one request reading the same thing would only
      // count it twice.
      const identity = canonicalJson(config);
      if (seen.has(identity)) {
        return fail(
          400,
          "Each connection of one request needs its own configuration.",
        );
      }
      seen.add(identity);
      entries.push({ id: randomUUID(), name: entry.name, config });
    }

    // A lent key (#395) is the stored key of another connection, never a
    // credential from the request.
    const resolved: Result<{
      credentials: Record<string, unknown> | undefined;
      pending: { provider: string; id: string } | null;
    }> = lent
      ? ok({ credentials: lent.credentials, pending: null })
      : await withPendingKey(
          actor,
          registered.manifest,
          body.credentials,
          body.pendingKeyId,
        );
    if (!resolved.ok) {
      return resolved;
    }
    const { pending } = resolved.value;

    const stored: Array<Record<string, unknown> | null> = [];
    for (const entry of entries) {
      const check = await checkCandidate(
        registered,
        entry.id,
        entry.config,
        resolved.value.credentials ?? {},
      );
      if (!check.ok) {
        return entries.length > 1
          ? fail(400, `${entry.name}: ${check.error}`)
          : check;
      }
      stored.push(resolved.value.credentials ? check.value : null);
    }

    return inWorkspace(actor, async (tx) => {
      // A generated key moves into these connections: its pending row goes
      // in this commit, before anything is written.
      const consumed = await consumePending(tx, actor, pending);
      if (!consumed.ok) {
        return consumed;
      }
      if (lent) {
        const still = await stillLends(tx, actor, lent, entries);
        if (!still.ok) {
          return still;
        }
      }
      if (body.projectId) {
        const project = await findProject(
          tx,
          actor.workspaceId,
          body.projectId,
        );
        // Archived projects take no new connections (#572).
        if (!project || project.archivedAt !== null) {
          return fail(404, "project_not_found");
        }
      }
      const rows: ConnectionWithState[] = [];
      for (const [index, entry] of entries.entries()) {
        const credentials = stored[index] ?? null;
        const connectionId = entry.id;
        const created = await insertConnection(tx, {
          id: connectionId,
          workspaceId: actor.workspaceId,
          connectorId: body.connectorId,
          name: entry.name,
          config: entry.config,
          credentialsEncrypted: credentials
            ? encrypt(credentialKeyring, credentials, {
                workspaceId: actor.workspaceId,
                connectionId,
              })
            : null,
          projectId: body.projectId ?? null,
          pollIntervalSeconds: registered.manifest.minRefreshIntervalSeconds,
          ...(body.retention
            ? {
                retention: {
                  choice: body.retention,
                  chosenBy: actor.callerId,
                },
              }
            : {}),
        });
        // Transactional enqueue invariant: the connection, its state, and
        // the initial backfill job commit atomically.
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
          metadata: {
            name: entry.name,
            connectorId: body.connectorId,
            ...(entries.length > 1 || lent ? { sharedCredential: true } : {}),
            ...(lent ? { keySharedFrom: lent.connectionId } : {}),
            ...(body.retention ? { retention: body.retention } : {}),
          },
        });
        rows.push(created);
      }
      if (lent) {
        // The lending connection's audit trail names who got its key.
        await insertAuditEvent(tx, {
          workspaceId: actor.workspaceId,
          actorUserId: actor.callerId,
          action: "connection.key_shared",
          target: lent.connectionId,
          metadata: {
            connectorId: body.connectorId,
            connectionIds: rows.map((created) => created.row.id),
          },
        });
      }
      // Every connection of the request stores the same key, and a lent
      // key also that of the connections already holding it.
      const details: ConnectionDetail[] = [];
      for (const created of rows) {
        details.push(
          presentConnectionDetail(
            registry,
            created,
            lent
              ? await withSharedKey(tx, actor.workspaceId, created.row)
              : signedKeyView(actor.workspaceId, created.row),
            actor.locale,
          ),
        );
      }
      if (lent) {
        return ok(details);
      }
      return ok(
        details.map((detail) =>
          detail.signedKey
            ? {
                ...detail,
                signedKey: {
                  ...detail.signedKey,
                  sharedWith: details
                    .filter((other) => other.id !== detail.id)
                    .map((other) => ({ id: other.id, name: other.name })),
                },
              }
            : detail,
        ),
      );
    });
  }

  /** The project if it still takes new connections (not archived), else null. */
  async function activeProjectOf(
    actor: Actor,
    projectId: string | null,
  ): Promise<string | null> {
    if (!projectId) {
      return null;
    }
    const project = await inWorkspace(actor, (tx) =>
      findProject(tx, actor.workspaceId, projectId),
    );
    return project && project.archivedAt === null ? project.id : null;
  }

  /**
   * An existing connection of this workspace that can lend its stored
   * signed key to new connections (#395): found with the workspace
   * predicate (404 otherwise, as everywhere), of a connector that lists
   * accounts to share a key with, and holding a signed key. The decrypted
   * key stays in this process.
   */
  async function lendingConnection(
    actor: Actor,
    connectionId: string,
  ): Promise<
    Result<{
      existing: ConnectionWithState;
      registered: NonNullable<ReturnType<ConnectorRegistry["get"]>>;
      sharing: KeySharing;
      lent: LentKey;
      key: SignedKey;
    }>
  > {
    const existing = await inWorkspace(actor, (tx) =>
      findConnection(tx, actor.workspaceId, connectionId),
    );
    if (!existing) {
      return fail(404, NOT_FOUND);
    }
    const registered = registry.get(existing.row.connectorId);
    const sharing = KEY_SHARING[existing.row.connectorId];
    if (!registered || !sharing || existing.oauth) {
      return fail(400, SHARED_KEY_UNSUPPORTED);
    }
    const envelope = openEnvelope(actor.workspaceId, existing.row);
    if (!envelope.ok) {
      return envelope;
    }
    const key = storedSignedKey(registered.manifest, envelope.value);
    if (!key || !existing.row.credentialsEncrypted) {
      return fail(400, SHARED_KEY_UNSUPPORTED);
    }
    if (!key.ok) {
      return key;
    }
    return ok({
      existing,
      registered,
      sharing,
      key: key.value,
      lent: {
        connectionId,
        credentials: envelope.value,
        sharing,
        envelope: existing.row.credentialsEncrypted,
      },
    });
  }

  /**
   * In the storing transaction: the lending connection still exists with
   * the same key (not deleted or rotated since the checks), and none of
   * the new connections reads an account this workspace connected already.
   */
  async function stillLends(
    tx: Transaction,
    actor: Actor,
    lent: LentKey,
    entries: ReadonlyArray<{ name: string; config: Record<string, unknown> }>,
  ): Promise<Result<true>> {
    const current = await findConnection(
      tx,
      actor.workspaceId,
      lent.connectionId,
    );
    if (!current) {
      return fail(404, NOT_FOUND);
    }
    if (
      !current.row.credentialsEncrypted ||
      !current.row.credentialsEncrypted.equals(lent.envelope)
    ) {
      return fail(
        400,
        "The key of this connection changed meanwhile. Reload and try again.",
      );
    }
    const connected = connectedAccounts(
      await listConnectionRows(tx, actor.workspaceId),
      current.row.connectorId,
      lent.sharing,
    );
    for (const entry of entries) {
      const account = configAccount(entry.config, lent.sharing);
      const already = account ? connected.get(account) : undefined;
      if (already) {
        return fail(
          400,
          `${entry.name}: this account is connected already, as “${already.name}”.`,
        );
      }
    }
    return ok(true);
  }

  /**
   * The other connections of the workspace that store the same signed key
   * as `row` (the same provider and non-secret fields, ADR 0014): one Apple
   * Ads key may serve several ad accounts (#375). Only non-secret fields
   * are compared; envelopes that cannot be opened are skipped.
   */
  async function sharedKeyConnections(
    tx: Transaction,
    workspaceId: string,
    row: ConnectionWithState["row"],
    view: ConnectionSignedKeyView | null,
  ): Promise<ConnectionWithState[]> {
    if (!view || view.fields.length === 0) {
      return [];
    }
    const identity = signedKeyIdentity(view);
    const rows = await listConnectionRows(tx, workspaceId);
    return rows.filter((other) => {
      if (
        other.row.id === row.id ||
        other.row.connectorId !== row.connectorId ||
        other.oauth
      ) {
        return false;
      }
      const otherView = signedKeyView(workspaceId, other.row);
      return otherView !== null && signedKeyIdentity(otherView) === identity;
    });
  }

  /** A signed-key view with the connections sharing its key. */
  async function withSharedKey(
    tx: Transaction,
    workspaceId: string,
    row: ConnectionWithState["row"],
  ): Promise<ConnectionSignedKeyView | null> {
    const view = signedKeyView(workspaceId, row);
    if (!view) {
      return null;
    }
    const shared = await sharedKeyConnections(tx, workspaceId, row, view);
    return {
      ...view,
      sharedWith: shared.map((other) => ({
        id: other.row.id,
        name: other.row.name,
      })),
    };
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
          datasetsCount: manifest.datasets?.length ?? 0,
          ...(manifest.datasets?.length
            ? { datasets: manifest.datasets.map(connectorDatasetRetention) }
            : {}),
          supportsResourceSelection:
            manifest.supportsResourceSelection ?? false,
          category: manifest.category ?? "other",
          brandColor: manifest.brandColor ?? null,
          metrics: manifest.metrics
            .filter((metric) => metric.role !== "helper")
            .map((metric) => ({ key: metric.key, name: metric.name })),
          minRefreshIntervalSeconds: manifest.minRefreshIntervalSeconds,
          supportsBackfill: manifest.supportsBackfill,
          configSchema: { ...manifest.configSchema },
          authStrategies: manifest.authStrategies.map((strategy) =>
            presentAuthStrategy(strategy, signedKeys),
          ),
          ...oauthProviders.connectorAvailability(manifest, signedKeys),
          preview: previews.has(manifest.id),
        };
      });
    },

    async create(
      actor: Actor,
      body: CreateConnectionRequest,
    ): Promise<Result<ConnectionDetail>> {
      const created = await createConnections(actor, {
        connectorId: body.connectorId,
        ...(body.credentials !== undefined
          ? { credentials: body.credentials }
          : {}),
        ...(body.pendingKeyId !== undefined
          ? { pendingKeyId: body.pendingKeyId }
          : {}),
        ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
        ...(body.retention !== undefined ? { retention: body.retention } : {}),
        connections: [
          {
            name: body.name,
            config: body.config,
            ...(body.resources !== undefined
              ? { resources: body.resources }
              : {}),
          },
        ],
      });
      return created.ok ? ok(created.value[0]!) : created;
    },

    /**
     * Several connections with one credential (ADR 0020 §5, #375): one
     * Apple Ads key for several ad accounts. All or none are stored.
     */
    createMany(
      actor: Actor,
      body: CreateConnectionsRequest,
    ): Promise<Result<ConnectionDetail[]>> {
      return createConnections(actor, body);
    },

    /**
     * What the stored key of a connection reads with no account chosen
     * (#395): for Apple Ads the API user's ad accounts, as the wizard's
     * preview lists them, and which of them this workspace has connected.
     * The check and discovery get a token from the stored key; the key
     * itself never leaves the server.
     */
    async sharedKeyResources(
      actor: Actor,
      connectionId: string,
    ): Promise<Result<SharedKeyResourcesResponse>> {
      const lending = await lendingConnection(actor, connectionId);
      if (!lending.ok) {
        return lending;
      }
      const { registered, sharing, key } = lending.value;
      const context = { connectionId, config: {} };
      const cache = signedKeyCache(key, actor.workspaceId, connectionId);
      try {
        const check = await callWithSignedKey({
          key,
          ...cache,
          call: (tokenCredentials, options) =>
            executeCheck(
              registered.connector,
              { ...context, credentials: { ...tokenCredentials } },
              options,
            ),
          rejected: (result) => !result.ok,
        });
        if (!check.ok) {
          return ok({ check, resources: [], connected: [] });
        }
        const resources = await callWithSignedKey({
          key,
          ...cache,
          call: (tokenCredentials, options) =>
            executeDiscover(
              registered.connector,
              { ...context, credentials: { ...tokenCredentials } },
              options,
            ),
        });
        const connected = connectedAccounts(
          await inWorkspace(actor, (tx) =>
            listConnectionRows(tx, actor.workspaceId),
          ),
          registered.manifest.id,
          sharing,
        );
        return ok({
          check,
          resources,
          connected: resources.flatMap((resource) => {
            const connection =
              resource.kind === sharing.resourceKind
                ? connected.get(resource.id)
                : undefined;
            return connection
              ? [
                  {
                    resourceId: resource.id,
                    connectionId: connection.id,
                    connectionName: connection.name,
                  },
                ]
              : [];
          }),
        });
      } catch (error) {
        return signedKeyCallFailure(error);
      }
    },

    /**
     * New connections with the stored key of an existing one (#395), for
     * accounts its key reads that are not connected yet: the batch path
     * with the lent key, checked first and stored all or none. They join
     * the lending connection's project unless the request names one.
     */
    async createWithSharedKey(
      actor: Actor,
      connectionId: string,
      body: CreateSharedKeyConnectionsRequest,
    ): Promise<Result<ConnectionDetail[]>> {
      const lending = await lendingConnection(actor, connectionId);
      if (!lending.ok) {
        return lending;
      }
      const { existing, lent } = lending.value;
      // The lending connection's project only while it takes new
      // connections: an archived one leaves them without a project instead
      // of refusing the request (#589). A project the request names is
      // checked as usual.
      const projectId =
        body.projectId ??
        (await activeProjectOf(actor, existing.row.projectId));
      return createConnections(
        actor,
        {
          connectorId: existing.row.connectorId,
          ...(projectId ? { projectId } : {}),
          connections: body.connections,
        },
        lent,
      );
    },

    /**
     * Generates a key pair for a signed-key provider with
     * `generatedKeyPair` (ADR 0020 §3, #371): the private key stays here as
     * the caller's pending key; the answer has the public key and the
     * pending key's id, never the private key.
     */
    async generateKeyPair(
      actor: Actor,
      providerId: string,
    ): Promise<Result<SignedKeyPairResponse>> {
      const provider = signedKeys.get(providerId);
      if (!provider) {
        return fail(404, "signed_key_provider_not_found");
      }
      const generated = await pendingKeys.generate(
        { workspaceId: actor.workspaceId, userId: actor.callerId },
        provider,
      );
      if (!generated.ok) {
        return fail(generated.status, generated.error);
      }
      await inWorkspace(actor, (tx) =>
        insertAuditEvent(tx, {
          workspaceId: actor.workspaceId,
          actorUserId: actor.callerId,
          action: "signed_key.key_pair_generated",
          target: generated.value.pendingKeyId,
          metadata: { provider: provider.id },
        }),
      );
      return ok(generated.value);
    },

    /** Checks credentials and discovers resources; persists nothing. */
    async preview(actor: Actor, body: PreviewConnectionRequest) {
      if (body.connectorId === CUSTOM_API_CONNECTOR_ID) {
        return fail(400, CUSTOM_API_REQUIRES_DEFINITION);
      }
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
      // A generated key pair is only read here; the preview stores nothing.
      const resolved = await withPendingKey(
        actor,
        registered.manifest,
        body.credentials,
        body.pendingKeyId,
      );
      if (!resolved.ok) {
        return resolved;
      }
      const provider = signedKeys.providerFor(
        registered.manifest,
        resolved.value.credentials,
      );
      if (provider) {
        return previewSignedKey(
          registered.connector,
          provider,
          validated.value,
          resolved.value.credentials,
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
        const discovered = await discoverWithSignedKey(
          actor,
          connectionId,
          existing,
        );
        return discovered.ok
          ? ok({
              ...discovered.value,
              selection: resourceSelectionOf(
                existing.row.config as Record<string, unknown>,
              ),
            })
          : discovered;
      }
      const registered = connectorFor(registry, existing);
      const strategy = registered
        ? requiredOAuthScopes(registered, existing.oauth.provider)
        : undefined;
      if (!registered || !strategy) {
        return fail(400, "invalid_request");
      }
      const config = existing.row.config as Record<string, unknown>;
      try {
        const resources = await callWithAccessToken({
          tokens: oauthTokens,
          binding: { workspaceId: actor.workspaceId, connectionId },
          requiredScopes: strategy,
          call: (credentials, options) =>
            executeDiscover(
              registered.connector,
              { connectionId, config, credentials: { ...credentials } },
              options,
            ),
        });
        return ok({ resources, selection: resourceSelectionOf(config) });
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
    callConnection: callStoredConnection,
    previewStored: previewStoredConnection,

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

    async list(actor: Actor, filter: ProjectFilter = {}) {
      const rows = await inWorkspace(actor, (tx) =>
        listConnectionRows(tx, actor.workspaceId, filter),
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
        const signedKey = await withSharedKey(
          tx,
          actor.workspaceId,
          loaded.row,
        );
        const backfill = await connectionBackfillState(
          tx,
          actor.workspaceId,
          connectionId,
        );
        const incomplete = await incompleteHistory(tx, loaded, registry);
        const freshness = await listConnectionFreshness(
          tx,
          actor.workspaceId,
          connectionId,
        );
        const itemImages = await connectionItemImages(
          tx,
          actor.workspaceId,
          loaded,
        );
        const recordSkips = await connectionRecordSkips(
          tx,
          actor.workspaceId,
          loaded,
        );
        return {
          ...loaded,
          syncRuns,
          signedKey,
          backfill,
          incomplete,
          freshness,
          itemImages,
          recordSkips,
        };
      });
      if (!found) {
        return fail(404, NOT_FOUND);
      }
      return ok({
        connection: presentConnectionDetail(
          registry,
          found,
          found.signedKey,
          actor.locale,
        ),
        syncRuns: found.syncRuns.map(presentSyncRun),
        history: historyView(found, found.backfill, found.incomplete, registry),
        freshness: presentFreshness(
          registry,
          found.row,
          found.freshness,
          actor.locale,
        ),
        ...(found.itemImages ? { itemImages: found.itemImages } : {}),
        ...(found.recordSkips ? { recordSkips: found.recordSkips } : {}),
      });
    },

    /**
     * "Reload history" (#617): a member reads the connector's whole
     * backfill window again, e.g. when totals look short. Same job as a
     * config change queues; stored data stays and is overwritten window by
     * window. Refused while a backfill of the connection, or of another
     * connection of the workspace, waits or runs, and more often than
     * once per HISTORY_RELOAD_INTERVAL_HOURS per connection (provider
     * quotas). The state row is locked, so two clicks queue one backfill.
     */
    async requestHistoryReload(
      actor: Actor,
      connectionId: string,
    ): Promise<HistoryReloadResult> {
      type Reload = { jobId: string; reloadAvailableAt: string };
      return inWorkspace(actor, async (tx): Promise<HistoryReloadResult> => {
        const loaded = await findConnection(
          tx,
          actor.workspaceId,
          connectionId,
        );
        if (!loaded) {
          return fail<Reload>(404, NOT_FOUND);
        }
        if (loaded.row.setupPending) {
          return fail<Reload>(400, "connection_setup_pending");
        }
        const manifest = connectorFor(registry, loaded)?.manifest;
        if (!manifest?.supportsBackfill) {
          return fail<Reload>(400, "backfill_not_supported");
        }
        if (loaded.state?.authState === "needs_reauthorization") {
          return fail<Reload>(400, "oauth_reauthorization_required");
        }
        const state = await lockHistoryReload(
          tx,
          actor.workspaceId,
          connectionId,
        );
        if (!state) {
          return fail<Reload>(400, "connection_setup_pending");
        }
        // One backfill per workspace at a time, as for the automatic ones:
        // connections of a workspace often share a provider key and its
        // rate limit (ADR 0014). Serialized across replicas.
        await lockWorkspaceBackfills(tx, actor.workspaceId);
        const active = await activeBackfillConnections(tx, actor.workspaceId);
        if (active.includes(connectionId)) {
          return { ok: false, status: 409, error: "backfill_in_progress" };
        }
        if (active.length > 0) {
          return {
            ok: false,
            status: 409,
            error: "workspace_backfill_in_progress",
          };
        }
        const now = new Date();
        const availableAt = reloadAvailableAt(state.requestedAt);
        if (availableAt && availableAt > now) {
          return {
            ok: false,
            status: 429,
            error: "history_reload_rate_limited",
          };
        }
        const jobId = await requestConnectionBackfill(tx, {
          workspaceId: actor.workspaceId,
          connectionId,
        });
        await markHistoryReloadRequested(tx, {
          workspaceId: actor.workspaceId,
          connectionId,
          at: now,
        });
        await insertAuditEvent(tx, {
          workspaceId: actor.workspaceId,
          actorUserId: actor.callerId,
          action: "connection.backfill_requested",
          target: connectionId,
          metadata: {
            connectorId: loaded.row.connectorId,
            by: "member",
            reason: "history_reload",
            jobId,
          },
        });
        return ok<Reload>({
          jobId,
          reloadAvailableAt: reloadAvailableAt(now)!.toISOString(),
        });
      });
    },

    async update(
      actor: Actor,
      connectionId: string,
      request: UpdateConnectionRequest,
    ): Promise<Result<ConnectionDetail>> {
      let body = request;
      const existing = await inWorkspace(actor, (tx) =>
        findConnection(tx, actor.workspaceId, connectionId),
      );
      if (!existing) {
        return fail(404, NOT_FOUND);
      }
      let registered = connectorFor(registry, existing);
      if (!registered) {
        return fail(400, "invalid_request");
      }
      const customApi = existing.row.connectorId === CUSTOM_API_CONNECTOR_ID;
      if (
        (body.customApiEnvironmentId !== undefined ||
          body.secretVariables !== undefined) &&
        !customApi
      ) {
        return fail(400, "invalid_request");
      }
      // An OAuth connection's credentials are its grant: they change only
      // through reauthorization (ADR 0012), never by pasting a token. A
      // custom API with an OAuth login (#805) keeps its client credentials
      // and environment: its grant is bound to both.
      const oauthProvider = connectionOAuthProvider(
        registered,
        existing.oauth?.provider,
      );
      // A custom API's own OAuth client may be replaced on the same
      // environment (#805): validated here (token request, check), written
      // in this update's transaction (prepareCustomOAuthClientChange).
      const customClientChange =
        oauthProvider === CUSTOM_OAUTH_PROVIDER_ID &&
        body.credentials !== undefined &&
        body.pendingKeyId === undefined &&
        body.customApiEnvironmentId === undefined &&
        body.secretVariables === undefined;
      if (
        oauthProvider &&
        !customClientChange &&
        (body.credentials !== undefined ||
          body.pendingKeyId !== undefined ||
          (oauthProvider === CUSTOM_OAUTH_PROVIDER_ID &&
            (body.customApiEnvironmentId !== undefined ||
              body.secretVariables !== undefined)))
      ) {
        return fail(400, "oauth_authorization_required");
      }
      // A config change is checked with the stored client's token, which
      // the new client replaces (#825): the two are saved one after the
      // other.
      if (customClientChange && body.config !== undefined) {
        return fail(400, "custom_api_client_change_with_config");
      }
      let clientChange: CustomOAuthClientChange | null = null;
      if (customClientChange) {
        const changed = await prepareCustomOAuthClientChange({
          db,
          credentialKeyring,
          oauthTokens,
          actor,
          existing,
          resolved: registered,
          credentials: body.credentials!,
          privateHosts: callOptions.privateHosts,
          ...(deps.executeOptions
            ? { executeOptions: deps.executeOptions }
            : {}),
        });
        if (!changed.ok) {
          return fail(
            changed.status === 409 ? 400 : changed.status,
            changed.error,
          );
        }
        clientChange = changed.value;
        body = { ...body, credentials: undefined };
      }
      // Key replacement with a generated key pair (ADR 0020 §3): from here
      // on it is a key upload like any other; the pending row goes in the
      // storing commit.
      const resolved = await withPendingKey(
        actor,
        registered.manifest,
        body.credentials,
        body.pendingKeyId,
      );
      if (!resolved.ok) {
        return resolved;
      }
      const { pending } = resolved.value;
      body = { ...body, credentials: resolved.value.credentials };

      /**
       * A custom API connection's environment or credentials (milestone
       * 13): credentials are bound to the environment host, so a new
       * environment needs them again; both are checked against the target
       * environment before the pin changes.
       */
      let customApiChange:
        | {
            environmentId: string;
            envelope: Record<string, unknown> | null | undefined;
          }
        | undefined;
      if (
        customApi &&
        (body.credentials !== undefined ||
          body.customApiEnvironmentId !== undefined ||
          body.secretVariables !== undefined)
      ) {
        let stored: Record<string, unknown> | null = null;
        if (existing.row.credentialsEncrypted) {
          try {
            stored = JSON.parse(
              decryptCredentials(
                existing.row.credentialsEncrypted.toString("utf8"),
                credentialKeyring,
                { workspaceId: actor.workspaceId, connectionId },
              ),
            ) as Record<string, unknown>;
          } catch (error) {
            return fail(400, safeMessage(error));
          }
        }
        const prepared = prepareCustomApiUpdate({
          registry,
          existing,
          environmentId: body.customApiEnvironmentId,
          credentials: body.credentials,
          secretVariables: body.secretVariables,
          stored,
        });
        if (!prepared.ok) {
          return fail(
            prepared.status === 409 ? 400 : prepared.status,
            prepared.error,
          );
        }
        registered = prepared.value.resolved;
        const envelope =
          prepared.value.envelope === undefined
            ? stored
            : prepared.value.envelope;
        const check = await checkCredentials(
          registered,
          connectionId,
          (body.config as Record<string, unknown> | undefined) ??
            (existing.row.config as Record<string, unknown>),
          envelope ?? {},
          callOptions,
        );
        if (!check.ok) {
          return check;
        }
        customApiChange = {
          environmentId: prepared.value.environmentId,
          envelope: prepared.value.envelope,
        };
      }

      const existingConfig = existing.row.config as Record<string, unknown>;
      let nextConfig: Record<string, unknown> | undefined;
      if (body.config !== undefined) {
        const validated = validateConfig(registered.manifest, body.config);
        if (!validated.ok) {
          return validated;
        }
        nextConfig = { ...validated.value };
        // Configuration forms do not clear an existing resource selection.
        if (existingConfig.resourceSelection !== undefined) {
          nextConfig.resourceSelection = existingConfig.resourceSelection;
        }
      }

      if (body.resources !== undefined) {
        if (!registered.manifest.supportsResourceSelection)
          return fail(
            400,
            "This connector manages its resource through its connection settings.",
          );
        if (body.credentials !== undefined || body.pendingKeyId !== undefined)
          return fail(
            400,
            "Change credentials and the app selection in separate requests.",
          );
        if (existing.row.setupPending && body.config === undefined)
          return fail(
            400,
            "Finish the connection settings before choosing apps.",
          );
        nextConfig ??= { ...existingConfig };
        const selection =
          body.resources === null ? null : [...new Set(body.resources)].sort();
        if (selection?.length) {
          const { resourceSelection: _selection, ...candidate } = nextConfig;
          const preview = await previewStoredConnection(actor, connectionId, {
            config: candidate,
          });
          if (!preview.ok) return preview;
          if (!preview.value.check.ok)
            return fail(
              400,
              preview.value.check.message ?? "credential check failed",
            );
          const allowed = new Set([
            ...preview.value.resources.map((resource) => resource.id),
            ...(resourceSelectionOf(existingConfig) ?? []),
          ]);
          if (selection.some((id) => !allowed.has(id)))
            return fail(
              400,
              "Choose apps returned by this account. Refresh the app list and try again.",
            );
        }
        if (selection === null) delete nextConfig.resourceSelection;
        else nextConfig.resourceSelection = selection;
      }

      // Moving into an archived project is refused; a connection already in
      // one keeps saving (#572).
      if (body.projectId && body.projectId !== existing.row.projectId) {
        const projectId = body.projectId;
        const project = await inWorkspace(actor, (tx) =>
          findProject(tx, actor.workspaceId, projectId),
        );
        if (!project || project.archivedAt !== null) {
          return fail(404, "project_not_found");
        }
      }

      // A config change of an OAuth connection is checked with a fresh access
      // token from the token service, never the stored refresh token.
      if (oauthProvider && body.config !== undefined) {
        const check = await checkOAuthConnection(
          actor,
          registered,
          connectionId,
          oauthProvider,
          nextConfig ?? existingConfig,
        );
        if (!check.ok) {
          return check;
        }
      }

      // Config or credential changes are re-checked against the connector
      // before they persist (same rule as creation).
      let storedCredentials: Record<string, unknown> | undefined;
      /** Connections sharing the replaced key, with their new envelope. */
      const siblingKeys: Array<{
        connectionId: string;
        stored: Record<string, unknown>;
      }> = [];
      // An optional additional key (#190, the App Store reviews key) is
      // added, replaced or removed on its own: the main key and the
      // connection's auth state stay as they are.
      const additionalProvider =
        !oauthProvider && body.credentials !== undefined
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
      } else if (customApiChange) {
        // Checked above against the target environment.
        if (customApiChange.envelope !== undefined)
          storedCredentials = customApiChange.envelope ?? undefined;
      } else if (
        !oauthProvider &&
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
          registered,
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
          // The same key in other connections of the workspace (one Apple
          // Ads key for several ad accounts, #375) is replaced with it:
          // the old key is removed at the provider afterwards, which would
          // stop them. Each is checked with the new key and its own config
          // first; one refusal changes nothing.
          const siblings = await inWorkspace(actor, (tx) =>
            sharedKeyConnections(
              tx,
              actor.workspaceId,
              existing.row,
              signedKeyView(actor.workspaceId, existing.row),
            ),
          );
          for (const sibling of siblings) {
            const siblingCheck = await checkCandidate(
              registered,
              sibling.row.id,
              sibling.row.config as Record<string, unknown>,
              body.credentials,
              { probeAdditional: true },
            );
            if (!siblingCheck.ok) {
              return fail(
                400,
                `The new key does not work for “${sibling.row.name}”, which uses the same key: ${siblingCheck.error}`,
              );
            }
            siblingKeys.push({
              connectionId: sibling.row.id,
              stored: carryAdditionalKeys(
                registered.manifest,
                sibling,
                actor.workspaceId,
                body.credentials,
                siblingCheck.value,
              ),
            });
          }
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
        ...(customApiChange
          ? { customApiEnvironmentId: customApiChange.environmentId }
          : {}),
        // A custom API connection's envelope for its (new) environment;
        // null when its login needs no secrets.
        ...(customApiChange?.envelope !== undefined
          ? {
              credentialsEncrypted: customApiChange.envelope
                ? encrypt(credentialKeyring, customApiChange.envelope, {
                    workspaceId: actor.workspaceId,
                    connectionId,
                  })
                : null,
            }
          : {}),
      };

      const write = async (
        tx: Transaction,
      ): Promise<Result<ConnectionDetail>> => {
        const consumed = await consumePending(tx, actor, pending);
        if (!consumed.ok) {
          return consumed;
        }
        const row = await updateConnectionRow(
          tx,
          actor.workspaceId,
          connectionId,
          changes,
        );
        if (!row) {
          return fail(404, NOT_FOUND);
        }
        // Review text is kept only while a reviews key is stored (ADR 0019
        // §11): removing it, or a main key of another team dropping it,
        // deletes the connection's stored reviews in this commit.
        const reviewTextDeleted =
          body.credentials !== undefined &&
          hasReviewsKey(registered.manifest) &&
          (storedCredentials ?? body.credentials)[REVIEWS_KEY_ID] == null
            ? await deleteConnectionAppReviews(
                tx,
                actor.workspaceId,
                connectionId,
              )
            : 0;
        const reviewsDeletedNote =
          reviewTextDeleted > 0 ? { reviewTextDeleted } : {};
        let state = existing.state;
        let setupPending = row.setupPending;
        /**
         * New credentials for a connection whose backfill ended without
         * reading its history (#378: one that died on a refused key): it
         * is queued again, unless one waits or runs already. Connections
         * whose history start is only unknown (runs pruned before it was
         * recorded) are left alone: no 12-month reads on every key change.
         */
        const backfillUnreadHistory = async (
          tx: Transaction,
          id: string,
          current: { historyFrom: Date | null } | null,
          active: readonly string[],
        ) => {
          if (
            !registered.manifest.supportsBackfill ||
            !current ||
            current.historyFrom !== null ||
            active.includes(id) ||
            !(await latestBackfillFailed(tx, actor.workspaceId, id))
          ) {
            return;
          }
          const jobId = await requestConnectionBackfill(tx, {
            workspaceId: actor.workspaceId,
            connectionId: id,
          });
          await insertAuditEvent(tx, {
            workspaceId: actor.workspaceId,
            actorUserId: actor.callerId,
            action: "connection.backfill_requested",
            target: id,
            metadata: {
              connectorId: row.connectorId,
              by: "member",
              reason: "history_incomplete",
              jobId,
            },
          });
        };
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
                ...(entry.change === "removed" ? reviewsDeletedNote : {}),
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
            metadata: { connectorId: row.connectorId, ...reviewsDeletedNote },
          });
          const active = registered.manifest.supportsBackfill
            ? await activeBackfillConnections(tx, actor.workspaceId)
            : [];
          if (!setupPending) {
            await backfillUnreadHistory(tx, connectionId, state, active);
          }
          for (const sibling of siblingKeys) {
            const updated = await updateConnectionRow(
              tx,
              actor.workspaceId,
              sibling.connectionId,
              {
                credentialsEncrypted: encrypt(
                  credentialKeyring,
                  sibling.stored,
                  {
                    workspaceId: actor.workspaceId,
                    connectionId: sibling.connectionId,
                  },
                ),
              },
            );
            if (!updated) {
              // Deleted meanwhile: nothing to replace.
              continue;
            }
            // As for the connection itself: a key of another team drops
            // the reviews key, and with it the stored review text.
            if (
              hasReviewsKey(registered.manifest) &&
              sibling.stored[REVIEWS_KEY_ID] == null
            ) {
              await deleteConnectionAppReviews(
                tx,
                actor.workspaceId,
                sibling.connectionId,
              );
            }
            const siblingState = await resetConnectionAuth(
              tx,
              actor.workspaceId,
              sibling.connectionId,
            );
            await backfillUnreadHistory(
              tx,
              sibling.connectionId,
              siblingState,
              active,
            );
            await insertAuditEvent(tx, {
              workspaceId: actor.workspaceId,
              actorUserId: actor.callerId,
              action: "connection.credentials_updated",
              target: sibling.connectionId,
              metadata: {
                connectorId: row.connectorId,
                sharedKeyOf: connectionId,
              },
            });
          }
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
              customApi:
                existing.customApi && row.customApiEnvironmentId
                  ? {
                      ...existing.customApi,
                      environmentId: row.customApiEnvironmentId,
                    }
                  : existing.customApi,
            },
            await withSharedKey(tx, actor.workspaceId, row),
            actor.locale,
          ),
        );
      };
      if (!clientChange) {
        return inWorkspace(actor, write);
      }
      // The client change and the rest of the update commit together: it
      // takes its locks first in the transaction, and a later refusal
      // rolls it back.
      const change = clientChange;
      let afterCommit: () => Promise<void> = async () => {};
      try {
        const result = await inWorkspace(actor, async (tx) => {
          afterCommit = await change.apply(tx);
          const written = await write(tx);
          if (!written.ok) throw new RollBack(written);
          return written;
        });
        await afterCommit();
        return result;
      } catch (error) {
        if (error instanceof RollBack) return error.result;
        if (error instanceof CustomOAuthClientChangeRefused)
          return fail(400, error.code);
        throw error;
      }
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
     * "Hide this review" (ADR 0019 §11, moderation): sets `hidden_at`, so no
     * widget shows the review again. The audit event names the connection,
     * the app and the provider's review id, never the review's text.
     */
    /**
     * A latest-review widget's data for the Studio (ADR 0019 section 12):
     * the newest matching review that is not hidden, with its provider id
     * for "Hide this review". One review per call; there is no list.
     */
    async latestReview(
      actor: Actor,
      connectionId: string,
      request: LatestReviewRequestParsed,
    ) {
      return inWorkspace(actor, async (tx) => {
        const found = await findConnection(tx, actor.workspaceId, connectionId);
        if (!found) {
          return fail<LatestReviewResponse>(404, NOT_FOUND);
        }
        if (!connectorHasReviews(found.row.connectorId)) {
          return fail<LatestReviewResponse>(400, "reviews_not_supported");
        }
        const backfilling = await findBackfillingConnectionIds(
          tx,
          actor.workspaceId,
        );
        const latest = await latestReview(tx, {
          workspaceId: actor.workspaceId,
          connectionId,
          resourceId: request.resource ?? null,
          options: request,
          state: toStateView(found.state),
          backfilling: backfilling.has(connectionId),
          reviewsKey: storedReviewsKey(found.row, credentialKeyring),
          now: new Date(),
        });
        // As on screens: the reviews stream of the widget's app (ADR 0025).
        return ok(
          applyFreshness(
            latest,
            await createFreshnessReader(
              actor.workspaceId,
              registry,
              actor.locale,
            ).read(tx, [
              {
                connectionId,
                stream: REVIEWS_FRESHNESS_STREAM,
                resource: request.resource,
              },
            ]),
          ),
        );
      });
    },

    async hideReview(actor: Actor, connectionId: string, reviewId: string) {
      return inWorkspace(actor, async (tx) => {
        const hidden = await hideAppReview(tx, {
          workspaceId: actor.workspaceId,
          connectionId,
          providerReviewId: reviewId,
          now: new Date(),
        });
        if (!hidden) {
          return fail<null>(404, "review_not_found");
        }
        await insertAuditEvent(tx, {
          workspaceId: actor.workspaceId,
          actorUserId: actor.callerId,
          action: "review.hidden",
          target: connectionId,
          metadata: { resource: hidden.resourceId, reviewId },
        });
        return ok(null);
      });
    },

    /**
     * App Store analytics per app (#174), read with the connection's stored
     * key: requested or not, stopped, and whether analytics data arrived.
     * "Available through" is the day the data status shows (#771): the
     * stored freshness of the analytics stream, not the newest data point.
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
      const { latest, completeThrough } = await inWorkspace(
        actor,
        async (tx) => ({
          latest: await latestObservationByResource(
            tx,
            actor.workspaceId,
            connectionId,
            [
              ANALYTICS_METRIC_KEYS.impressions,
              ANALYTICS_METRIC_KEYS.productPageViews,
              ANALYTICS_METRIC_KEYS.storeDownloads,
            ],
          ),
          completeThrough: new Map(
            (
              await listConnectionFreshness(tx, actor.workspaceId, connectionId)
            ).flatMap((row) =>
              row.stream === ANALYTICS_STREAM && row.dataThrough !== null
                ? [[row.resource, row.dataThrough] as const]
                : [],
            ),
          ),
        }),
      );
      const status = await appStoreAnalyticsStatus({
        key,
        http: signedKeys.httpFor(key.provider),
        selection,
        latest,
        completeThrough,
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
      if (!enabled.ok && enabled.role) {
        // Not an Admin key (#715): Apple refused (403) a step before any
        // request was created, whether listing apps, listing an app's
        // report requests or creating one. Owners setting up the reviews key end
        // up here: say which key it is, and offer a key that passes the
        // reviews key's own checks as that key. It is not kept: the
        // browser still holds it and stores it with the usual update.
        const keyId = adminKey.value.publicFields.keyId ?? "";
        if (keyId === storedKey.publicFields.keyId) {
          return fail(400, SALES_KEY_CANNOT_REQUEST);
        }
        const reviewsKeyId =
          storedKey.additional(REVIEWS_KEY_ID)?.publicFields.keyId ?? null;
        if (keyId === reviewsKeyId) {
          return fail(400, REVIEWS_KEY_CANNOT_REQUEST);
        }
        const asReviews = signedKeys.parseAdditional(
          storedKey,
          REVIEWS_KEY_ID,
          {
            keyId,
            privateKey: adminKey.value.stored().privateKey,
          },
        );
        const probed = asReviews.ok
          ? await signedKeys.probeAdditional(
              storedKey.withAdditional(REVIEWS_KEY_ID, asReviews.value),
              REVIEWS_KEY_ID,
              existing.row.config as Record<string, unknown>,
            )
          : asReviews;
        if (!probed.ok) {
          // A rate limit or outage decided nothing: try again, not "Admin".
          return fail(400, probed.retry ? probed.message : ADMIN_ROLE_REQUIRED);
        }
        return ok({
          apps: [],
          keysUrl: APP_STORE_CONNECT_KEYS_URL,
          reviewsKeyOffer: { keyId, replacesKeyId: reviewsKeyId },
        });
      }
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
            ...(query.nonZero === "true" ? { nonZero: true } : {}),
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

/**
 * The last run's skipped records per stream of a custom API connection
 * (#834 review), with the stream names and field paths of its pinned
 * definition: a path the definition no longer has is left out.
 * Undefined for bundled connectors.
 */
async function connectionRecordSkips(
  tx: Transaction,
  workspaceId: string,
  loaded: ConnectionWithState,
): Promise<ConnectionRecordSkips[] | undefined> {
  if (!loaded.customApi) return undefined;
  let streams: Map<string, { name: string; paths: Set<string> }>;
  try {
    const definition = upgradeCustomApiDefinition(loaded.customApi.document);
    streams = new Map(
      definition.streams.map((stream) => [
        stream.key,
        {
          name: stream.name,
          paths: new Set(stream.fields.map((field) => field.path)),
        },
      ]),
    );
  } catch {
    return undefined;
  }
  const rows = await listStreamRecords(tx, workspaceId, loaded.row.id);
  return rows.flatMap((row) => {
    const stream = streams.get(row.streamKey);
    if (!stream) return [];
    return [
      {
        streamKey: row.streamKey,
        streamName: stream.name || row.streamKey,
        checkedAt: row.checkedAt.toISOString(),
        skipped: row.skipped,
        skippedFields: Object.entries(row.skippedFields)
          .filter(
            ([path, count]) =>
              stream.paths.has(path) && Number.isInteger(count) && count > 0,
          )
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 5)
          .map(([path, count]) => ({ path, count })),
      },
    ];
  });
}

/**
 * The last image step per image stream of a custom API connection (#809),
 * with the stream names of its pinned definition; undefined for bundled
 * connectors and definitions without an image stream.
 */
async function connectionItemImages(
  tx: Transaction,
  workspaceId: string,
  loaded: ConnectionWithState,
): Promise<ConnectionItemImages[] | undefined> {
  if (!loaded.customApi) return undefined;
  let names: Map<string, string>;
  try {
    const definition = upgradeCustomApiDefinition(loaded.customApi.document);
    names = new Map(
      definition.streams
        .filter((stream) => stream.fields.some((f) => f.role === "image"))
        .map((stream) => [stream.key, stream.name]),
    );
  } catch {
    return undefined;
  }
  if (names.size === 0) return undefined;
  const rows = await listStreamImages(tx, workspaceId, loaded.row.id);
  return rows
    .filter((row) => names.has(row.streamKey))
    .map((row) => ({
      streamKey: row.streamKey,
      streamName: names.get(row.streamKey) || row.streamKey,
      checkedAt: row.checkedAt.toISOString(),
      stored: row.stored,
      unchanged: row.unchanged,
      skipped: row.skipped,
      skippedReasons: Object.fromEntries(
        Object.entries(row.skippedReasons).filter(
          ([reason, count]) =>
            (CUSTOM_API_IMAGE_SKIP_REASONS as readonly string[]).includes(
              reason,
            ) &&
            Number.isInteger(count) &&
            count > 0,
        ),
      ) as ConnectionItemImages["skippedReasons"],
    }));
}
