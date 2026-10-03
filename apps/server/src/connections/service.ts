import { randomUUID } from "node:crypto";

import type {
  ConnectionResourcesResponse,
  ConnectorAuthStrategy,
  CreateConnectionRequest,
  DeleteConnectionResponse,
  ObservationListQuery,
  PreviewConnectionRequest,
  UpdateConnectionRequest,
} from "@netrics/contracts";
import { validateConnectionConfig } from "@netrics/contracts";
import {
  executeCheck,
  executeDiscover,
  type ConnectorRegistry,
} from "@netrics/connector-runtime";
import type { ConnectorManifest } from "@netrics/connector-sdk";
import {
  deleteConnection as deleteConnectionRow,
  enqueueJob,
  findConnection,
  findConnectionOAuth,
  finishConnectionSetup,
  findProject,
  insertAuditEvent,
  insertConnection,
  listConnections as listConnectionRows,
  listObservations as listObservationRows,
  listRecentSyncRuns,
  releaseOAuthGrant,
  requestConnectionBackfill,
  requestConnectionSync,
  resetConnectionAuth,
  updateConnection as updateConnectionRow,
  withOAuthGrantLocks,
  withWorkspace,
  type ConnectionChanges,
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
}

/** Who acts on which workspace (see routes/access.ts). */
export interface Actor {
  workspaceId: string;
  callerId: string;
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
): ConnectorAuthStrategy {
  if (strategy.strategy === "signed-key") {
    return { strategy: "signed-key", provider: strategy.provider };
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

/** Whether the connector has an auth strategy besides OAuth. */
function acceptsCredentials(manifest: ConnectorManifest): boolean {
  return manifest.authStrategies.some(
    (strategy) => strategy.strategy !== "oauth2",
  );
}

export function createConnectionService(deps: ConnectionServiceDeps) {
  const { db, registry, credentialKeyring, oauthProviders } = deps;
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
    if (!oauthProviders.connectorAvailability(manifest).available) {
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
    listConnectors() {
      return registry.list().map(({ manifest }) => ({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        metricsCount: manifest.metrics.length,
        minRefreshIntervalSeconds: manifest.minRefreshIntervalSeconds,
        supportsBackfill: manifest.supportsBackfill,
        configSchema: { ...manifest.configSchema },
        authStrategies: manifest.authStrategies.map(presentAuthStrategy),
        ...oauthProviders.connectorAvailability(manifest),
      }));
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
      const check = await checkCredentials(
        registry,
        body.connectorId,
        connectionId,
        config,
        body.credentials ?? {},
      );
      if (!check.ok) {
        return check;
      }

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
          credentialsEncrypted: body.credentials
            ? encrypt(credentialKeyring, body.credentials, {
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
        return ok(presentConnectionDetail(registry, created));
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
        return fail(400, "oauth_connection_required");
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

    async list(actor: Actor) {
      const rows = await inWorkspace(actor, (tx) =>
        listConnectionRows(tx, actor.workspaceId),
      );
      return rows.map((loaded) => presentConnection(registry, loaded));
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
        connection: presentConnectionDetail(registry, found),
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
      if (
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
        const check = await checkCredentials(
          registry,
          existing.row.connectorId,
          connectionId,
          nextConfig ?? existingConfig,
          credentials,
        );
        if (!check.ok) {
          return check;
        }
      }

      const changes: ConnectionChanges = {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(nextConfig !== undefined ? { config: nextConfig } : {}),
        ...(body.credentials !== undefined
          ? {
              credentialsEncrypted: encrypt(
                credentialKeyring,
                body.credentials,
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
          nextConfig !== undefined &&
          registered.manifest.supportsBackfill &&
          configChanged(registered.manifest, existingConfig, nextConfig);
        if (refetch) {
          await requestConnectionBackfill(tx, {
            workspaceId: actor.workspaceId,
            connectionId,
          });
        }
        if (body.credentials !== undefined) {
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
          presentConnectionDetail(registry, {
            row: { ...row, setupPending },
            state,
            oauth: existing.oauth,
          }),
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
        return listObservationRows(tx, actor.workspaceId, connectionId, {
          ...(query.metricKey ? { metricKey: query.metricKey } : {}),
          ...(query.from ? { from: new Date(query.from) } : {}),
          ...(query.to ? { to: new Date(query.to) } : {}),
          limit: query.limit,
        });
      });
      if (!rows) {
        return fail(404, NOT_FOUND);
      }
      return ok(
        rows.map((row) => ({
          metricKey: row.metricKey,
          seriesKey: row.seriesKey,
          sourceTimestamp: row.sourceTimestamp.toISOString(),
          value: row.value,
          dimensions: row.dimensions as Record<string, string>,
          ingestedAt: row.ingestedAt.toISOString(),
        })),
      );
    },
  };
}

export type ConnectionService = ReturnType<typeof createConnectionService>;
