// Connections of a custom API definition (milestone 13, ADR 0027). A
// connection pins one definition version and one environment; its config
// holds the non-secret connection variables and its credential envelope
// `{ host, …credentials, variables: secretVariables }`, bound to the
// environment host. Generic connection routes refuse custom-api: only
// this path creates such connections.

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type {
  ConnectionRetentionChoice,
  CreateCustomApiConnectionRequest,
} from "@netrics/contracts";
import type {
  ConnectorRegistry,
  ExecuteOptions,
} from "@netrics/connector-runtime";
import {
  upgradeCustomApiDefinition,
  type CustomApiDefinition,
} from "@netrics/connector-sdk/custom-api";
import {
  CUSTOM_API_CONNECTOR_ID,
  CUSTOM_API_MESSAGES,
  customApiCredentialsSchema,
  customApiEnvironmentHost,
} from "@netrics/connectors/custom-api";
import {
  countCustomApiConnections,
  lockCustomApiLimit,
  enqueueJob,
  findConnection,
  findCustomApiDefinition,
  findCustomApiDefinitionVersion,
  findProject,
  insertAuditEvent,
  insertConnection,
  lockConnectionOAuth,
  schema,
  markNeedsReauthorization,
  resetConnectionAuth,
  updateConnection,
  updateConnectionOAuthTokens,
  upsertConnectionOAuth,
  withWorkspace,
  type ConnectionWithState,
  type Transaction,
  type CustomApiDefinitionVersionRow,
  type Database,
} from "@netrics/database";
import type { Locale } from "@netrics/domain";

import {
  checkCredentials,
  type Actor as ConnectionActor,
} from "../connections/service.js";
import { presentConnectionDetail } from "../connections/present.js";
import { retentionNamesDatasets } from "../connections/retention.js";
import {
  encryptCredentials,
  encryptOAuthAccessToken,
  type CredentialKeyring,
} from "../credentials.js";
import type { CustomApiInstanceConfig } from "../env.js";
import { Secret } from "../secret.js";
import {
  CUSTOM_OAUTH_PROVIDER_ID,
  customOAuthBinding,
  customOAuthProvider,
  generateCustomAccountSub,
  isCustomOAuthAuth,
  sealCustomOAuthCredentials,
} from "../oauth/providers/custom.js";
import {
  customOAuthFailureMessage,
  type OAuthTokenService,
} from "../oauth/tokens.js";
import { connectorFor, type ResolvedConnector } from "./connectors.js";

export type CustomApiConnectionResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 404 | 409; error: string };

function fail(
  status: 400 | 404 | 409,
  error: string,
): { ok: false; status: 400 | 404 | 409; error: string } {
  return { ok: false, status, error };
}

export interface CustomApiConnectionDeps {
  db: Database;
  registry: ConnectorRegistry;
  credentialKeyring: CredentialKeyring;
  limits: CustomApiInstanceConfig;
  /** Self-host only (NETRICS_CUSTOM_API_PRIVATE_HOSTS). */
  privateHosts: readonly string[];
  /** Tests only: options for every connector call (e.g. local egress). */
  executeOptions?: ExecuteOptions;
  /** Custom OAuth (#805): client-credentials tokens. */
  oauthTokens?: OAuthTokenService;
  /** WEB_ORIGIN: the custom OAuth redirect URI. */
  webOrigin?: string;
}

/**
 * The client ID and secret of an OAuth login, exactly those two non-empty
 * strings; null otherwise.
 */
export function customOAuthClient(
  credentials: Record<string, unknown>,
): { clientId: string; clientSecret: string } | null {
  const { clientId, clientSecret, ...rest } = credentials;
  if (
    Object.keys(rest).length > 0 ||
    typeof clientId !== "string" ||
    typeof clientSecret !== "string" ||
    !clientId ||
    !clientSecret ||
    clientId.length > 4_096 ||
    clientSecret.length > 4_096
  )
    return null;
  return { clientId, clientSecret };
}

/**
 * Why a token request for a new connection failed, as an error the web app
 * can show: the token endpoint's refusal of the client (the connector
 * message, translated by text), a blocked destination, or no token.
 */
export function customOAuthTokenFailure(error: unknown): string {
  const refused = customOAuthFailureMessage(error);
  if (refused) return refused;
  if (error instanceof Error && /EgressDenied/.test(error.message))
    return "custom_api_destination_blocked";
  return "custom_api_token_failed";
}

/** Exactly the ids, as a set comparison. */
function sameKeys(values: Record<string, string>, ids: string[]): boolean {
  const keys = Object.keys(values);
  return (
    keys.length === ids.length && ids.every((id) => Object.hasOwn(values, id))
  );
}

/** Whether the login method needs nothing stored (no credentials, no secret variables). */
export function customApiNeedsNoSecrets(
  definition: Pick<CustomApiDefinition, "auth" | "variables">,
) {
  return (
    definition.auth.type === "none" &&
    !definition.variables.some((variable) => variable.secret)
  );
}

/**
 * The credential envelope for an environment: `{ host, …credentials,
 * variables }` (variables only when the definition has secret ones), or
 * null when auth is none without secret variables. Undefined when the
 * credentials do not fit the login method.
 */
export function customApiEnvelope(
  definition: Pick<CustomApiDefinition, "environments" | "auth" | "variables">,
  environmentId: string,
  credentials: Record<string, string>,
  secretVariables: Record<string, string>,
): Record<string, unknown> | null | undefined {
  if (customApiNeedsNoSecrets(definition)) {
    return Object.keys(credentials).length === 0 ? null : undefined;
  }
  const environment = definition.environments.find(
    (entry) => entry.id === environmentId,
  );
  if (!environment) return undefined;
  if (
    Object.hasOwn(credentials, "host") ||
    Object.hasOwn(credentials, "variables")
  )
    return undefined;
  const envelope = {
    host: customApiEnvironmentHost(environment),
    ...credentials,
    ...(definition.variables.some((variable) => variable.secret)
      ? { variables: secretVariables }
      : {}),
  };
  const parsed = customApiCredentialsSchema(definition).safeParse(envelope);
  return parsed.success ? (parsed.data as Record<string, unknown>) : undefined;
}

/**
 * A custom-api connection's new environment, credentials and/or secret
 * variables (PATCH): the connector for the target environment and the
 * envelope to store (undefined: keep the stored one). Secrets are bound to
 * the environment host, so a new environment needs every secret again:
 * the login method's credentials (unless it is none) and every secret
 * variable. Nothing stored is carried to another host. On the same
 * environment, what the request leaves out is kept.
 */
export function prepareCustomApiUpdate(input: {
  registry: ConnectorRegistry;
  existing: ConnectionWithState;
  environmentId: string | undefined;
  credentials: Record<string, unknown> | undefined;
  secretVariables: Record<string, string> | undefined;
  /** The stored envelope, decrypted; null without one. */
  stored: Record<string, unknown> | null;
}): CustomApiConnectionResult<{
  resolved: ResolvedConnector;
  environmentId: string;
  envelope: Record<string, unknown> | null | undefined;
}> {
  const pinned = input.existing.customApi;
  const current = connectorFor(input.registry, input.existing);
  if (!pinned || !current?.customApi) return fail(400, "invalid_request");
  const definition = current.customApi.definition;
  const environmentId = input.environmentId ?? pinned.environmentId;
  if (!definition.environments.some((entry) => entry.id === environmentId))
    return fail(400, "custom_api_environment_not_found");
  const changed = environmentId !== pinned.environmentId;
  const secretIds = definition.variables
    .filter((variable) => variable.secret)
    .map((variable) => variable.id);
  if (
    changed &&
    ((definition.auth.type !== "none" && input.credentials === undefined) ||
      (secretIds.length > 0 && input.secretVariables === undefined))
  )
    return fail(400, "custom_api_environment_needs_credentials");
  if (
    input.secretVariables !== undefined &&
    !sameKeys(input.secretVariables, secretIds)
  )
    return fail(400, "custom_api_variables_invalid");
  const resolved = connectorFor(input.registry, {
    row: input.existing.row,
    customApi: { ...pinned, environmentId },
  });
  if (!resolved) return fail(400, "custom_api_environment_not_found");
  if (
    !changed &&
    input.credentials === undefined &&
    input.secretVariables === undefined
  )
    return {
      ok: true,
      value: { resolved, environmentId, envelope: undefined },
    };

  // Auth credentials: the request's, else (same environment only) the stored ones.
  let credentials: Record<string, string> = {};
  if (input.credentials !== undefined) {
    for (const [key, value] of Object.entries(input.credentials)) {
      if (typeof value !== "string" || key === "host" || key === "variables")
        return fail(400, "custom_api_credentials_invalid");
      credentials[key] = value;
    }
  } else if (!changed && input.stored) {
    const { host: _host, variables: _variables, ...rest } = input.stored;
    credentials = rest as Record<string, string>;
  }
  const storedVariables = input.stored?.variables;
  const variables =
    input.secretVariables ??
    (!changed && storedVariables && typeof storedVariables === "object"
      ? (storedVariables as Record<string, string>)
      : {});
  const envelope = customApiEnvelope(
    definition,
    environmentId,
    credentials,
    variables,
  );
  if (envelope === undefined)
    return fail(400, "custom_api_credentials_invalid");
  return { ok: true, value: { resolved, environmentId, envelope } };
}

type ConnectionDetail = ReturnType<typeof presentConnectionDetail>;

/**
 * A client change that can no longer be written as validated (the
 * connection moved to another definition version meanwhile); thrown from
 * `apply`, it rolls the transaction back and the PATCH answers 400 `code`.
 */
export class CustomOAuthClientChangeRefused extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CustomOAuthClientChangeRefused";
  }
}

/** A validated client change, written inside the caller's transaction. */
export interface CustomOAuthClientChange {
  /**
   * Call first in the transaction that commits the PATCH: takes the grant
   * row lock (the one refresh holds) and the connection row lock, reads the
   * envelope again and writes the change against that fresh state. The
   * returned function runs after commit (best-effort revocation).
   */
  apply(tx: Transaction): Promise<() => Promise<void>>;
}

/**
 * A new client ID and/or secret for an active custom OAuth connection
 * (PATCH credentials, #805). The envelope is sealed again for the
 * definition's current hosts (which also repairs a host change). Network
 * work happens here, before any lock; the write happens in `apply`, in the
 * PATCH's transaction, so the client change and the rest of the PATCH
 * commit or fail together.
 *
 * - Client credentials: a token is requested with the new client first (a
 *   refused client or missing scopes changes nothing), the connector check
 *   runs with it, then the envelope and the grant are replaced and the
 *   connection is healthy again.
 * - Authorization code, same client ID and hosts (a rotated secret): the
 *   refresh token stays, as read under the lock (a rotation by a refresh
 *   that ran meanwhile is kept); providers keep grants across secret
 *   rotation. A connection that failed on the refused secret is healthy
 *   again.
 * - Authorization code, another client ID (or other hosts): the grant cannot
 *   be used by the new client. The refresh token read under the lock is
 *   revoked after commit (best effort, with the old client, only to the
 *   hosts it was entered for) and the connection needs reauthorization; it
 *   keeps its id, history and bindings, and signing in again restores it.
 */
export async function prepareCustomOAuthClientChange(input: {
  db: Database;
  credentialKeyring: CredentialKeyring;
  oauthTokens: OAuthTokenService;
  actor: { workspaceId: string; callerId: string };
  existing: ConnectionWithState;
  resolved: ResolvedConnector;
  credentials: Record<string, unknown>;
  privateHosts: readonly string[];
  executeOptions?: ExecuteOptions;
}): Promise<CustomApiConnectionResult<CustomOAuthClientChange>> {
  const { actor, existing, resolved, oauthTokens } = input;
  const connectionId = existing.row.id;
  const { workspaceId } = actor;
  const binding = { workspaceId, connectionId };
  const client = customOAuthClient(input.credentials);
  const definition = resolved.customApi?.definition;
  const environmentId = resolved.customApi?.pin.environmentId;
  if (!client || !definition || !environmentId)
    return fail(400, "custom_api_credentials_invalid");
  const hosts = customOAuthBinding(definition, environmentId);
  const resolver = oauthTokens.customOAuth;
  if (!hosts || !resolver) return fail(400, "connector_unavailable");
  const read = await withWorkspace(
    input.db,
    { workspaceId, userId: actor.callerId },
    (tx) => resolver.resolve(tx, binding),
  );
  // Endpoints come from the pinned definition; only the client is new. A
  // connection whose login an update dropped (#808) has no envelope: the
  // provider comes from the definition alone.
  const provider = read
    ? {
        ...read.provider,
        clientId: client.clientId,
        clientSecret: new Secret(client.clientSecret),
      }
    : resolver.providerFor(definition, client);
  const seal = (refreshToken: string | null) =>
    sealCustomOAuthCredentials(
      { ...hosts, ...client, refreshToken },
      input.credentialKeyring,
      binding,
    );
  const audit = (tx: Transaction, change: string) =>
    insertAuditEvent(tx, {
      workspaceId,
      actorUserId: actor.callerId,
      action: "connection.oauth_client_changed",
      target: connectionId,
      metadata: {
        connectorId: CUSTOM_API_CONNECTOR_ID,
        provider: CUSTOM_OAUTH_PROVIDER_ID,
        grant: provider.grant,
        change,
      },
    });
  const healthy = (tx: Transaction) =>
    resetConnectionAuth(tx, workspaceId, connectionId, {
      schedule: !existing.row.setupPending,
    });
  /** The grant row lock (refresh's), then the connection row. */
  const lock = async (tx: Transaction) => {
    const locked = await lockConnectionOAuth(tx, workspaceId, connectionId);
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
    // The client is sealed for the hosts of the pin read before the lock;
    // a definition update applied meanwhile moved them: nothing is written.
    const now = await findConnection(tx, workspaceId, connectionId);
    if (
      now?.customApi?.versionId !== existing.customApi?.versionId ||
      now?.customApi?.environmentId !== existing.customApi?.environmentId
    )
      throw new CustomOAuthClientChangeRefused(
        "custom_api_credentials_host_changed",
      );
    const fresh = await resolver.resolve(tx, binding);
    // The auth state as it is now, under the lock (#825).
    return { grant: locked?.oauth ?? null, fresh, state: now?.state ?? null };
  };
  const nothing = async () => {};

  if (provider.grant === "client_credentials") {
    let token;
    try {
      token = await oauthTokens.requestClientCredentialsToken(provider);
    } catch (error) {
      return fail(400, customOAuthTokenFailure(error));
    }
    const scopes = token.scopes ?? [...provider.scopes];
    if (provider.scopes.some((scope) => !scopes.includes(scope)))
      return fail(400, CUSTOM_API_MESSAGES.scopeRefused);
    const check = await checkCredentials(
      resolved,
      connectionId,
      existing.row.config as Record<string, unknown>,
      { accessToken: token.accessToken },
      {
        ...(input.executeOptions
          ? { executeOptions: input.executeOptions }
          : {}),
        privateHosts: input.privateHosts,
      },
    );
    if (!check.ok) return fail(400, check.error);
    return {
      ok: true,
      value: {
        async apply(tx) {
          // Under the lock: a token a refresh minted meanwhile with the old
          // client is replaced by the new client's.
          const { grant } = await lock(tx);
          await updateConnection(tx, workspaceId, connectionId, {
            credentialsEncrypted: seal(null),
          });
          await upsertConnectionOAuth(tx, {
            workspaceId,
            connectionId,
            provider: CUSTOM_OAUTH_PROVIDER_ID,
            accountSub: grant?.accountSub ?? generateCustomAccountSub(),
            accountEmail: null,
            grantedScopes: scopes,
            accessTokenEncrypted: Buffer.from(
              encryptOAuthAccessToken(
                token.accessToken,
                input.credentialKeyring,
                binding,
              ),
              "utf8",
            ),
            accessTokenExpiresAt: token.expiresAt,
          });
          await healthy(tx);
          await audit(tx, "client");
          return nothing;
        },
      },
    };
  }

  return {
    ok: true,
    value: {
      async apply(tx) {
        const { grant, fresh, state } = await lock(tx);
        const sameClient =
          fresh !== null &&
          fresh.bindingHeld &&
          fresh.credentials.clientId === client.clientId;
        if (sameClient) {
          // The refresh token as it is now, rotated or not.
          await updateConnection(tx, workspaceId, connectionId, {
            credentialsEncrypted: seal(fresh.credentials.refreshToken),
          });
          // Repairs a refused secret, also one recorded after this PATCH
          // was read; a grant that needs a new sign-in keeps needing it.
          if (state?.authState === "auth_failed") await healthy(tx);
          await audit(tx, "secret");
          return nothing;
        }
        await updateConnection(tx, workspaceId, connectionId, {
          credentialsEncrypted: seal(null),
        });
        if (grant || !fresh) {
          if (grant)
            await updateConnectionOAuthTokens(tx, workspaceId, connectionId, {
              accessTokenEncrypted: null,
              accessTokenExpiresAt: null,
            });
          // A grant, or no client before (a dropped login): sign in next.
          await markNeedsReauthorization(
            tx,
            workspaceId,
            connectionId,
            "invalid_grant",
          );
        }
        await audit(tx, "client");
        // The refresh token read under the lock, never sent to hosts it
        // was not entered for.
        const released =
          fresh?.bindingHeld === true ? fresh.credentials.refreshToken : null;
        return fresh && released
          ? async () => {
              await oauthTokens.revokeCustomGrant(fresh.provider, released);
            }
          : nothing;
      },
    },
  };
}

export function createCustomApiConnectionService(
  deps: CustomApiConnectionDeps,
) {
  const inWorkspace = <T>(
    actor: ConnectionActor,
    run: Parameters<typeof withWorkspace<T>>[2],
  ) =>
    withWorkspace(
      deps.db,
      { workspaceId: actor.workspaceId, userId: actor.callerId },
      run,
    );

  async function loadVersion(
    actor: ConnectionActor,
    definitionId: string,
    version: number | undefined,
  ): Promise<
    CustomApiConnectionResult<{
      name: string;
      row: CustomApiDefinitionVersionRow;
    }>
  > {
    return inWorkspace(actor, async (tx) => {
      const found = await findCustomApiDefinition(
        tx,
        actor.workspaceId,
        definitionId,
      );
      if (!found) return fail(404, "custom_api_definition_not_found");
      if (found.definition.archivedAt !== null)
        return fail(409, "custom_api_definition_archived");
      const row =
        version === undefined || version === found.version.version
          ? found.version
          : await findCustomApiDefinitionVersion(
              tx,
              actor.workspaceId,
              definitionId,
              version,
            );
      if (!row) return fail(404, "custom_api_definition_not_found");
      return { ok: true, value: { name: found.definition.name, row } };
    });
  }

  /**
   * A connection with an OAuth login (#805). Its envelope holds the client
   * ID and secret (custom OAuth envelope). Client credentials: a token is
   * requested at the token URL first (a refused client stores nothing),
   * the connector check runs with it, and the grant is stored with the
   * connection. Authorization code: the connection waits for its first
   * grant (setup pending, not scheduled, no check) until the user signs in
   * through the OAuth start with purpose authorize.
   */
  async function createOAuthConnection(
    actor: ConnectionActor & { locale?: Locale },
    definitionId: string,
    body: CreateCustomApiConnectionRequest,
    definition: CustomApiDefinition,
    version: CustomApiDefinitionVersionRow,
  ): Promise<CustomApiConnectionResult<ConnectionDetail>> {
    if (Object.keys(body.secretVariables).length > 0)
      return fail(400, "custom_api_variables_invalid");
    const client = customOAuthClient(body.credentials);
    if (!client) return fail(400, "custom_api_credentials_invalid");
    const pinned = {
      definitionId,
      versionId: version.id,
      version: version.version,
      environmentId: body.environmentId,
      document: version.document,
      datasetVersions: version.datasetVersions as Record<string, number>,
    };
    const resolved = connectorFor(deps.registry, {
      row: { connectorId: CUSTOM_API_CONNECTOR_ID },
      customApi: pinned,
    });
    if (!resolved) return fail(400, "custom_api_definition_invalid");
    if (
      body.retention &&
      !retentionNamesDatasets(resolved.manifest, body.retention)
    )
      return fail(400, "retention_dataset_unknown");
    const hosts = customOAuthBinding(definition, body.environmentId)!;
    if (
      (await inWorkspace(actor, (tx) =>
        countCustomApiConnections(tx, actor.workspaceId),
      )) >= deps.limits.maxConnections
    )
      return fail(409, "custom_api_connection_limit");
    if (!deps.oauthTokens || !deps.webOrigin)
      return fail(400, "connector_unavailable");
    const provider = customOAuthProvider(
      { name: body.name, auth: definition.auth },
      client,
      deps.webOrigin,
    );
    const connectionId = randomUUID();
    const config: Record<string, unknown> = { ...body.variables };
    const binding = { workspaceId: actor.workspaceId, connectionId };

    let grant: {
      accessToken: string;
      expiresAt: Date;
      scopes: string[];
    } | null = null;
    if (provider.grant === "client_credentials") {
      let token;
      try {
        token = await deps.oauthTokens.requestClientCredentialsToken(provider);
      } catch (error) {
        return fail(400, customOAuthTokenFailure(error));
      }
      const credentials = { accessToken: token.accessToken };
      const check = await checkCredentials(
        resolved,
        connectionId,
        config,
        credentials,
        {
          ...(deps.executeOptions
            ? { executeOptions: deps.executeOptions }
            : {}),
          privateHosts: deps.privateHosts,
        },
      );
      if (!check.ok) return fail(400, check.error);
      const scopes = token.scopes ?? [...provider.scopes];
      if (provider.scopes.some((scope) => !scopes.includes(scope)))
        return fail(400, CUSTOM_API_MESSAGES.scopeRefused);
      grant = {
        accessToken: token.accessToken,
        expiresAt: token.expiresAt,
        scopes,
      };
    }

    const refreshMinutes = Math.max(
      body.refreshMinutes ?? definition.defaults.refreshMinutes,
      deps.limits.minRefreshMinutes,
    );
    const retention: ConnectionRetentionChoice | undefined = body.retention;
    return inWorkspace(actor, async (tx) => {
      if (body.projectId) {
        const project = await findProject(
          tx,
          actor.workspaceId,
          body.projectId,
        );
        if (!project || project.archivedAt !== null)
          return fail(404, "project_not_found");
      }
      await lockCustomApiLimit(tx, actor.workspaceId, "connections");
      if (
        (await countCustomApiConnections(tx, actor.workspaceId)) >=
        deps.limits.maxConnections
      )
        return fail(409, "custom_api_connection_limit");
      const created = await insertConnection(tx, {
        id: connectionId,
        workspaceId: actor.workspaceId,
        connectorId: CUSTOM_API_CONNECTOR_ID,
        name: body.name,
        config,
        credentialsEncrypted: sealCustomOAuthCredentials(
          { ...hosts, ...client, refreshToken: null },
          deps.credentialKeyring,
          binding,
        ),
        projectId: body.projectId ?? null,
        pollIntervalSeconds: refreshMinutes * 60,
        // Authorization code: not scheduled before the first grant.
        setupPending: grant === null,
        customApi: {
          definitionVersionId: version.id,
          environmentId: body.environmentId,
        },
        ...(retention
          ? { retention: { choice: retention, chosenBy: actor.callerId } }
          : {}),
      });
      let oauth = null;
      if (grant) {
        oauth = await upsertConnectionOAuth(tx, {
          workspaceId: actor.workspaceId,
          connectionId,
          provider: CUSTOM_OAUTH_PROVIDER_ID,
          accountSub: generateCustomAccountSub(),
          accountEmail: null,
          grantedScopes: grant.scopes,
          accessTokenEncrypted: Buffer.from(
            encryptOAuthAccessToken(
              grant.accessToken,
              deps.credentialKeyring,
              binding,
            ),
            "utf8",
          ),
          accessTokenExpiresAt: grant.expiresAt,
        });
        await enqueueJob(tx, {
          kind: "connection.backfill",
          workspaceId: actor.workspaceId,
          connectionId,
          idempotencyKey: `backfill:${connectionId}`,
        });
      }
      await insertAuditEvent(tx, {
        workspaceId: actor.workspaceId,
        actorUserId: actor.callerId,
        action: "connection.created",
        target: connectionId,
        metadata: {
          name: body.name,
          connectorId: CUSTOM_API_CONNECTOR_ID,
          definitionId,
          version: version.version,
          environmentId: body.environmentId,
          oauth: provider.grant,
          ...(retention ? { retention } : {}),
        },
      });
      return {
        ok: true,
        value: presentConnectionDetail(
          deps.registry,
          oauth
            ? {
                ...created,
                oauth: {
                  provider: oauth.provider,
                  accountEmail: null,
                  grantedScopes: oauth.grantedScopes,
                },
              }
            : created,
          null,
          actor.locale,
        ),
      };
    });
  }

  return {
    /** POST …/custom-api/definitions/:definitionId/connections */
    async create(
      actor: ConnectionActor & { locale?: Locale },
      definitionId: string,
      body: CreateCustomApiConnectionRequest,
    ): Promise<CustomApiConnectionResult<ConnectionDetail>> {
      const loaded = await loadVersion(actor, definitionId, body.version);
      if (!loaded.ok) return loaded;
      const version = loaded.value.row;
      let definition: CustomApiDefinition;
      try {
        definition = upgradeCustomApiDefinition(version.document);
      } catch {
        return fail(400, "custom_api_definition_invalid");
      }
      if (!definition.environments.some((e) => e.id === body.environmentId))
        return fail(400, "custom_api_environment_not_found");
      const plain = definition.variables.filter((v) => !v.secret);
      const secret = definition.variables.filter((v) => v.secret);
      if (
        !sameKeys(
          body.variables,
          plain.map((v) => v.id),
        ) ||
        !sameKeys(
          body.secretVariables,
          secret.map((v) => v.id),
        )
      )
        return fail(400, "custom_api_variables_invalid");
      if (isCustomOAuthAuth(definition.auth))
        return createOAuthConnection(
          actor,
          definitionId,
          body,
          definition,
          version,
        );
      const envelope = customApiEnvelope(
        definition,
        body.environmentId,
        body.credentials,
        body.secretVariables,
      );
      if (envelope === undefined)
        return fail(400, "custom_api_credentials_invalid");

      const pinned = {
        definitionId,
        versionId: version.id,
        version: version.version,
        environmentId: body.environmentId,
        document: version.document,
        datasetVersions: version.datasetVersions as Record<string, number>,
      };
      const resolved = connectorFor(deps.registry, {
        row: { connectorId: CUSTOM_API_CONNECTOR_ID },
        customApi: pinned,
      });
      if (!resolved) return fail(400, "custom_api_definition_invalid");
      if (
        body.retention &&
        !retentionNamesDatasets(resolved.manifest, body.retention)
      )
        return fail(400, "retention_dataset_unknown");

      const count = await inWorkspace(actor, (tx) =>
        countCustomApiConnections(tx, actor.workspaceId),
      );
      if (count >= deps.limits.maxConnections)
        return fail(409, "custom_api_connection_limit");

      // The connector check runs before anything is stored; its refusal
      // is the connector's (redacted) message.
      const connectionId = randomUUID();
      const config: Record<string, unknown> = { ...body.variables };
      const check = await checkCredentials(
        resolved,
        connectionId,
        config,
        envelope ?? {},
        {
          ...(deps.executeOptions
            ? { executeOptions: deps.executeOptions }
            : {}),
          privateHosts: deps.privateHosts,
        },
      );
      if (!check.ok) return fail(400, check.error);

      const refreshMinutes = Math.max(
        body.refreshMinutes ?? definition.defaults.refreshMinutes,
        deps.limits.minRefreshMinutes,
      );
      const retention: ConnectionRetentionChoice | undefined = body.retention;
      return inWorkspace(actor, async (tx) => {
        if (body.projectId) {
          const project = await findProject(
            tx,
            actor.workspaceId,
            body.projectId,
          );
          if (!project || project.archivedAt !== null)
            return fail(404, "project_not_found");
        }
        // Counted again inside the commit's transaction, under the
        // workspace's limit lock: concurrent creates cannot both pass.
        await lockCustomApiLimit(tx, actor.workspaceId, "connections");
        if (
          (await countCustomApiConnections(tx, actor.workspaceId)) >=
          deps.limits.maxConnections
        )
          return fail(409, "custom_api_connection_limit");
        const created = await insertConnection(tx, {
          id: connectionId,
          workspaceId: actor.workspaceId,
          connectorId: CUSTOM_API_CONNECTOR_ID,
          name: body.name,
          config,
          credentialsEncrypted: envelope
            ? Buffer.from(
                encryptCredentials(
                  JSON.stringify(envelope),
                  deps.credentialKeyring,
                  { workspaceId: actor.workspaceId, connectionId },
                ),
                "utf8",
              )
            : null,
          projectId: body.projectId ?? null,
          pollIntervalSeconds: refreshMinutes * 60,
          customApi: {
            definitionVersionId: version.id,
            environmentId: body.environmentId,
          },
          ...(retention
            ? { retention: { choice: retention, chosenBy: actor.callerId } }
            : {}),
        });
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
            name: body.name,
            connectorId: CUSTOM_API_CONNECTOR_ID,
            definitionId,
            version: version.version,
            environmentId: body.environmentId,
            ...(retention ? { retention } : {}),
          },
        });
        return {
          ok: true,
          value: presentConnectionDetail(
            deps.registry,
            created,
            null,
            actor.locale,
          ),
        };
      });
    },
  };
}
