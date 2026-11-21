// Definition updates for custom API connections (milestone 13, #808). A
// connection pins one definition version; a newer version is offered, never
// applied by itself (the pattern of template updates, #615): the plan lists
// what changes and what the user must decide, and the apply runs with the
// pinned version it was made from (409 custom_api_update_stale otherwise).
//
// Secrets and tokens are bound to the hosts they were entered for (C-G3,
// B-G1, C-G4). An update to a version that sends them to other hosts, or
// uses another login method, never carries them over: the plan says so up
// front, the apply drops them (revoking an OAuth grant at its own hosts)
// and the connection needs its login again, unless the apply brings the new
// login (methods without OAuth). Same hosts and method: they carry over.

import type {
  CustomApiChange,
  CustomApiUpdateApplyRequest,
  CustomApiUpdateBlocker,
  CustomApiUpdateLogin,
  CustomApiUpdatePlan,
  CustomApiDefinitionConnectionsResponse,
} from "@netrics/contracts";
import type { ConnectorRegistry } from "@netrics/connector-runtime";
import {
  readStoredCustomApiDefinition,
  upgradeCustomApiDefinition,
  type CustomApiDefinition,
  type CustomApiField,
  type CustomApiStream,
} from "@netrics/connector-sdk/custom-api";
import {
  CUSTOM_API_CONNECTOR_ID,
  customApiCredentialHosts,
  customApiEnvironmentHost,
} from "@netrics/connectors/custom-api";
import {
  deleteConnectionOAuth,
  findConnection,
  findCustomApiDefinition,
  insertAuditEvent,
  listCustomApiDefinitionConnections,
  lockConnectionOAuth,
  resetConnectionAuth,
  schema,
  withWorkspace,
  type ConnectionWithState,
  type CustomApiDefinitionWithVersion,
  type Database,
  type Transaction,
} from "@netrics/database";
import type { Locale } from "@netrics/domain";
import { and, eq, sql } from "drizzle-orm";

import { presentConnectionDetail } from "../connections/present.js";
import {
  decryptCredentials,
  encryptCredentials,
  type CredentialKeyring,
} from "../credentials.js";
import type { CustomApiInstanceConfig } from "../env.js";
import {
  customOAuthBinding,
  customOAuthBindingHolds,
  isCustomOAuthAuth,
} from "../oauth/providers/custom.js";
import type { OAuthTokenService } from "../oauth/tokens.js";
import { canonicalJson } from "./canonical-json.js";
import { customApiEnvelope, customApiNeedsNoSecrets } from "./connections.js";
import { customApiCredentialNames } from "./drafts.js";

// ----------------------------------------------------------------- the diff

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

const byKey = <T>(items: readonly T[], key: (item: T) => string) =>
  new Map(items.map((item) => [key(item), item]));

type FieldAspect = Extract<
  CustomApiChange,
  { kind: "field_changed" }
>["changes"][number];

function fieldChanges(from: CustomApiField, to: CustomApiField): FieldAspect[] {
  const changes: FieldAspect[] = [];
  if (from.type !== to.type) changes.push("type");
  if (from.path !== to.path) changes.push("path");
  if (from.role !== to.role) changes.push("role");
  if (from.format !== to.format) changes.push("format");
  // The value's unit: unit, currency and scale.
  if (
    from.unit !== to.unit ||
    from.currencyField !== to.currencyField ||
    from.scale !== to.scale
  )
    changes.push("unit");
  if (from.classification !== to.classification) changes.push("classification");
  return changes;
}

function streamChanges(
  from: CustomApiStream,
  to: CustomApiStream,
): CustomApiChange[] {
  const stream = to.key;
  const changes: CustomApiChange[] = [];
  const fromFields = byKey(from.fields, (field) => field.id);
  const toFields = byKey(to.fields, (field) => field.id);
  for (const field of to.fields) {
    const before = fromFields.get(field.id);
    if (!before) {
      changes.push({ kind: "field_added", stream, field: field.id });
      continue;
    }
    const aspects = fieldChanges(before, field);
    if (aspects.length)
      changes.push({
        kind: "field_changed",
        stream,
        field: field.id,
        changes: aspects,
      });
  }
  for (const field of from.fields)
    if (!toFields.has(field.id))
      changes.push({ kind: "field_removed", stream, field: field.id });
  // Where the records come from: the request and the record path.
  if (!same(from.request, to.request) || from.records !== to.records)
    changes.push({ kind: "request_changed", stream });
  if (!same(from.pagination, to.pagination))
    changes.push({ kind: "pagination_changed", stream });
  if (!same(from.window, to.window))
    changes.push({ kind: "window_changed", stream });
  // How rows are kept: the mode and its keys.
  if (
    from.mode !== to.mode ||
    !same(from.keyFields, to.keyFields) ||
    from.reportingField !== to.reportingField
  )
    changes.push({ kind: "mode_changed", stream });
  return changes;
}

/** The hosts a login is bound to: the environment host with port, and every credential host. */
function loginBinding(
  definition: Pick<CustomApiDefinition, "environments" | "auth">,
  environmentId: string,
): { host: string; hosts: string[] } | null {
  const environment = definition.environments.find(
    (entry) => entry.id === environmentId,
  );
  if (!environment) return null;
  return {
    host: customApiEnvironmentHost(environment),
    hosts: customApiCredentialHosts(definition, environmentId),
  };
}

/**
 * What changes between two versions for one connection, what the user must
 * decide before the update can run, and whether the stored login carries
 * over. `environmentId` is the connection's pinned environment;
 * `targetEnvironmentId` the one it moves to (default: the same).
 */
export function diffCustomApiVersions(
  from: CustomApiDefinition,
  to: CustomApiDefinition,
  connection: {
    environmentId: string;
    targetEnvironmentId?: string;
    variables: Record<string, string>;
  },
): {
  changes: CustomApiChange[];
  blockers: CustomApiUpdateBlocker[];
  login: CustomApiUpdateLogin;
} {
  const changes: CustomApiChange[] = [];
  const fromStreams = byKey(from.streams, (stream) => stream.key);
  const toStreams = byKey(to.streams, (stream) => stream.key);
  for (const stream of to.streams) {
    const before = fromStreams.get(stream.key);
    if (!before) changes.push({ kind: "stream_added", stream: stream.key });
    else changes.push(...streamChanges(before, stream));
  }
  for (const stream of from.streams)
    if (!toStreams.has(stream.key))
      changes.push({ kind: "stream_removed", stream: stream.key });

  const fromEnvironments = byKey(from.environments, (entry) => entry.id);
  const toEnvironments = byKey(to.environments, (entry) => entry.id);
  for (const environment of to.environments) {
    const before = fromEnvironments.get(environment.id);
    if (!before)
      changes.push({
        kind: "environment_added",
        environment: environment.id,
      });
    else if (before.baseUrl !== environment.baseUrl)
      changes.push({
        kind: "environment_url_changed",
        environment: environment.id,
      });
  }
  for (const environment of from.environments)
    if (!toEnvironments.has(environment.id))
      changes.push({
        kind: "environment_removed",
        environment: environment.id,
      });

  if (!same(from.auth, to.auth)) changes.push({ kind: "auth_changed" });

  // A variable whose secrecy flips is another variable to the connection.
  const variableKey = (v: { id: string; secret: boolean }) =>
    `${v.secret ? "s" : "p"}:${v.id}`;
  const fromVariables = byKey(from.variables, variableKey);
  const toVariables = byKey(to.variables, variableKey);
  for (const variable of to.variables)
    if (!fromVariables.has(variableKey(variable)))
      changes.push({ kind: "variable_added", variable: variable.id });
  for (const variable of from.variables)
    if (!toVariables.has(variableKey(variable)))
      changes.push({ kind: "variable_removed", variable: variable.id });

  if (!same(from.defaults, to.defaults))
    changes.push({ kind: "schedule_changed" });

  // The login: same method and same hosts carry it over.
  const target = connection.targetEnvironmentId ?? connection.environmentId;
  const before = loginBinding(from, connection.environmentId);
  const after = loginBinding(to, target);
  const login: CustomApiUpdateLogin = customApiNeedsNoSecrets(to)
    ? { carriesOver: true, reason: null, method: to.auth.type }
    : from.auth.type !== to.auth.type
      ? { carriesOver: false, reason: "auth_changed", method: to.auth.type }
      : !before ||
          !after ||
          before.host !== after.host ||
          !same([...before.hosts].sort(), [...after.hosts].sort())
        ? { carriesOver: false, reason: "hosts_changed", method: to.auth.type }
        : { carriesOver: true, reason: null, method: to.auth.type };

  const blockers: CustomApiUpdateBlocker[] = [];
  if (!toEnvironments.has(target))
    blockers.push({ code: "environment_removed", environment: target });
  const fromSecrets = new Set(
    from.variables.filter((v) => v.secret).map((v) => v.id),
  );
  for (const variable of to.variables) {
    if (!variable.secret) {
      if (!connection.variables[variable.id])
        blockers.push({
          code: "variable_required",
          variable: variable.id,
          secret: false,
        });
    } else if (login.carriesOver && !fromSecrets.has(variable.id)) {
      // A dropped login is entered again as a whole; a kept one only
      // needs the new value.
      blockers.push({
        code: "variable_required",
        variable: variable.id,
        secret: true,
      });
    }
  }
  return { changes, blockers, login };
}

// -------------------------------------------------------------- the service

export interface CustomApiUpdateActor {
  workspaceId: string;
  callerId: string;
  locale?: Locale;
}

export type CustomApiUpdateResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      status: 400 | 404 | 409;
      error: string;
      plan?: CustomApiUpdatePlan;
      blockers?: CustomApiUpdateBlocker[];
    };

const fail = (
  status: 400 | 404 | 409,
  error: string,
  extra: {
    plan?: CustomApiUpdatePlan;
    blockers?: CustomApiUpdateBlocker[];
  } = {},
) => ({ ok: false as const, status, error, ...extra });

interface Loaded {
  existing: ConnectionWithState;
  current: CustomApiDefinitionWithVersion;
  from: CustomApiDefinition;
  to: CustomApiDefinition;
}

export function createCustomApiConnectionUpdateService(deps: {
  db: Database;
  registry: ConnectorRegistry;
  credentialKeyring: CredentialKeyring;
  limits: CustomApiInstanceConfig;
  oauthTokens?: OAuthTokenService;
}) {
  const inWorkspace = <T>(
    actor: CustomApiUpdateActor,
    run: Parameters<typeof withWorkspace<T>>[2],
  ) =>
    withWorkspace(
      deps.db,
      { workspaceId: actor.workspaceId, userId: actor.callerId },
      run,
    );

  /** The connection with both documents; a failure when there is nothing to offer. */
  async function load(
    tx: Transaction,
    actor: CustomApiUpdateActor,
    connectionId: string,
  ): Promise<CustomApiUpdateResult<Loaded>> {
    const existing = await findConnection(tx, actor.workspaceId, connectionId);
    if (!existing) return fail(404, "connection_not_found");
    const pinned = existing.customApi;
    if (existing.row.connectorId !== CUSTOM_API_CONNECTOR_ID || !pinned)
      return fail(404, "custom_api_update_none");
    const current = await findCustomApiDefinition(
      tx,
      actor.workspaceId,
      pinned.definitionId,
    );
    if (!current || current.version.id === pinned.versionId)
      return fail(404, "custom_api_update_none");
    let to: CustomApiDefinition;
    let from: CustomApiDefinition;
    try {
      // The target must pass today's rules; the pinned one only has to read.
      to = upgradeCustomApiDefinition(current.version.document);
      from = readStoredCustomApiDefinition(pinned.document);
    } catch {
      return fail(409, "custom_api_definition_invalid");
    }
    return { ok: true, value: { existing, current, from, to } };
  }

  function planOf(loaded: Loaded, targetEnvironmentId?: string) {
    const { existing, current, from, to } = loaded;
    const pinned = existing.customApi!;
    const diff = diffCustomApiVersions(from, to, {
      environmentId: pinned.environmentId,
      ...(targetEnvironmentId !== undefined ? { targetEnvironmentId } : {}),
      variables: plainValues(existing),
    });
    return {
      connectionId: existing.row.id,
      definitionId: pinned.definitionId,
      environmentId: targetEnvironmentId ?? pinned.environmentId,
      fromVersion: { id: pinned.versionId, version: pinned.version },
      toVersion: { id: current.version.id, version: current.version.version },
      ...diff,
      basis: pinned.versionId,
    } satisfies CustomApiUpdatePlan;
  }

  function openEnvelope(
    actor: CustomApiUpdateActor,
    existing: ConnectionWithState,
  ): Record<string, unknown> | null {
    const sealed = existing.row.credentialsEncrypted;
    if (!sealed) return null;
    try {
      return JSON.parse(
        decryptCredentials(sealed.toString("utf8"), deps.credentialKeyring, {
          workspaceId: actor.workspaceId,
          connectionId: existing.row.id,
        }),
      ) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  return {
    /** GET …/connections/:id/custom-api-update */
    plan(
      actor: CustomApiUpdateActor,
      connectionId: string,
      environmentId?: string,
    ): Promise<CustomApiUpdateResult<CustomApiUpdatePlan>> {
      return inWorkspace(actor, async (tx) => {
        const loaded = await load(tx, actor, connectionId);
        if (!loaded.ok) return loaded;
        return { ok: true, value: planOf(loaded.value, environmentId) };
      });
    },

    /** POST …/connections/:id/custom-api-update */
    async apply(
      actor: CustomApiUpdateActor,
      connectionId: string,
      body: CustomApiUpdateApplyRequest,
    ): Promise<
      CustomApiUpdateResult<ReturnType<typeof presentConnectionDetail>>
    > {
      const binding = { workspaceId: actor.workspaceId, connectionId };
      let afterCommit: (() => Promise<void>) | null = null;
      const result = await inWorkspace(
        actor,
        async (
          tx,
        ): Promise<
          CustomApiUpdateResult<ReturnType<typeof presentConnectionDetail>>
        > => {
          // The grant row first (the lock a token refresh holds), then the
          // connection row: two applies, or an apply and a refresh, run
          // one after the other.
          await lockConnectionOAuth(tx, actor.workspaceId, connectionId);
          await tx
            .select({ id: schema.connections.id })
            .from(schema.connections)
            .where(
              and(
                eq(schema.connections.workspaceId, actor.workspaceId),
                eq(schema.connections.id, connectionId),
              ),
            )
            .for("update");
          const loaded = await load(tx, actor, connectionId);
          if (!loaded.ok) {
            // Updated meanwhile to the current version: nothing to apply.
            return loaded.error === "custom_api_update_none" &&
              loaded.status === 404
              ? fail(409, "custom_api_update_stale")
              : loaded;
          }
          const { existing, current, from, to } = loaded.value;
          const pinned = existing.customApi!;
          if (
            pinned.versionId !== body.basis ||
            current.version.id !== body.toVersionId
          )
            return fail(409, "custom_api_update_stale", {
              plan: planOf(loaded.value, body.environmentId),
            });
          const environmentId = body.environmentId ?? pinned.environmentId;
          const variables = body.variables ?? {};
          const secrets = body.secrets ?? {};
          const plainIds = to.variables
            .filter((v) => !v.secret)
            .map((v) => v.id);
          const secretIds = to.variables
            .filter((v) => v.secret)
            .map((v) => v.id);
          if (Object.keys(variables).some((id) => !plainIds.includes(id)))
            return fail(400, "custom_api_variables_invalid");
          const config: Record<string, string> = {};
          const stored = plainValues(existing);
          for (const id of plainIds) {
            const value = variables[id] || stored[id];
            if (value) config[id] = value;
          }
          const diff = diffCustomApiVersions(from, to, {
            environmentId: pinned.environmentId,
            targetEnvironmentId: environmentId,
            variables: config,
          });
          const blockers = diff.blockers.filter(
            (blocker) =>
              !(
                blocker.code === "variable_required" &&
                blocker.secret &&
                secrets[blocker.variable]
              ),
          );
          if (blockers.length)
            return fail(400, "custom_api_update_blocked", { blockers });

          // The login.
          const oauth = isCustomOAuthAuth(to.auth);
          const credentialNames = customApiCredentialNames(to.auth);
          if (
            Object.keys(secrets).some(
              (name) =>
                oauth ||
                !(credentialNames.includes(name) || secretIds.includes(name)),
            )
          )
            return fail(400, "custom_api_credentials_invalid");
          const envelope = openEnvelope(actor, existing);
          const pick = (
            source: Record<string, unknown>,
            names: readonly string[],
          ) =>
            Object.fromEntries(
              names.flatMap((name) =>
                typeof source[name] === "string" ? [[name, source[name]]] : [],
              ),
            ) as Record<string, string>;
          // What the stored envelope really is bound to decides, not only
          // the documents.
          const targetBinding = loginBinding(to, environmentId)!;
          const holds =
            envelope !== null &&
            diff.login.carriesOver &&
            (oauth
              ? customOAuthBindingHolds(
                  envelope as { host: string; hosts: string[] },
                  customOAuthBinding(to, environmentId),
                )
              : envelope.host === targetBinding.host);
          let sealed: Record<string, unknown> | null | undefined; // undefined: keep
          let login: "kept" | "replaced" | "dropped" | "none";
          if (customApiNeedsNoSecrets(to)) {
            sealed = null;
            login = "none";
          } else if (oauth) {
            sealed = holds ? undefined : null;
            login = holds ? "kept" : "dropped";
          } else {
            const storedVariables =
              holds && envelope && typeof envelope.variables === "object"
                ? (envelope.variables as Record<string, unknown>)
                : {};
            const base = holds ? envelope! : {};
            const credentials = {
              ...pick(base, credentialNames),
              ...pick(secrets, credentialNames),
            };
            const secretValues = {
              ...pick(storedVariables, secretIds),
              ...pick(secrets, secretIds),
            };
            if (!holds && Object.keys(secrets).length === 0) {
              sealed = null;
              login = "dropped";
            } else {
              sealed = customApiEnvelope(
                to,
                environmentId,
                credentials,
                secretValues,
              );
              if (sealed === undefined)
                return fail(400, "custom_api_credentials_invalid");
              login = holds ? "kept" : "replaced";
            }
          }

          // A dropped OAuth grant (or one the new method no longer uses)
          // goes; its refresh token is revoked at the hosts it was entered
          // for, after commit and best effort.
          if (existing.oauth && login !== "kept") {
            const resolver = deps.oauthTokens?.customOAuth;
            const fresh = resolver ? await resolver.resolve(tx, binding) : null;
            const refreshToken =
              fresh?.bindingHeld === true
                ? fresh.credentials.refreshToken
                : null;
            if (fresh && refreshToken && deps.oauthTokens) {
              const tokens = deps.oauthTokens;
              afterCommit = async () => {
                await tokens.revokeCustomGrant(fresh.provider, refreshToken);
              };
            }
            await deleteConnectionOAuth(tx, actor.workspaceId, connectionId);
          }

          const scheduleChanged =
            from.defaults.refreshMinutes !== to.defaults.refreshMinutes;
          await tx
            .update(schema.connections)
            .set({
              customApiDefinitionVersionId: current.version.id,
              customApiEnvironmentId: environmentId,
              config,
              ...(sealed !== undefined
                ? {
                    credentialsEncrypted: sealed
                      ? Buffer.from(
                          encryptCredentials(
                            JSON.stringify(sealed),
                            deps.credentialKeyring,
                            binding,
                          ),
                          "utf8",
                        )
                      : null,
                  }
                : {}),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.connections.workspaceId, actor.workspaceId),
                eq(schema.connections.id, connectionId),
              ),
            );
          const pending = existing.row.setupPending;
          if (login === "dropped") {
            // Needs its login again: not scheduled until it is entered.
            await tx
              .update(schema.connectionState)
              .set({ authState: "auth_failed", authReason: null })
              .where(stateScope(actor.workspaceId, connectionId));
          } else if (login === "replaced") {
            await resetConnectionAuth(tx, actor.workspaceId, connectionId, {
              schedule: !pending,
            });
          }
          await tx
            .update(schema.connectionState)
            .set({
              // The definition's refresh interval when it changed; a
              // connection's own interval stays otherwise.
              ...(scheduleChanged
                ? {
                    pollIntervalSeconds:
                      Math.max(
                        to.defaults.refreshMinutes,
                        deps.limits.minRefreshMinutes,
                      ) * 60,
                  }
                : {}),
              ...(pending ? {} : { nextDueAt: sql`now()` }),
            })
            .where(stateScope(actor.workspaceId, connectionId));
          await insertAuditEvent(tx, {
            workspaceId: actor.workspaceId,
            actorUserId: actor.callerId,
            action: "connection.custom_api_updated",
            target: connectionId,
            metadata: {
              definitionId: pinned.definitionId,
              fromVersion: pinned.version,
              toVersion: current.version.version,
              environmentId,
              changes: [...new Set(diff.changes.map((change) => change.kind))],
              login,
            },
          });
          const updated = await findConnection(
            tx,
            actor.workspaceId,
            connectionId,
          );
          return {
            ok: true,
            value: presentConnectionDetail(
              deps.registry,
              updated!,
              null,
              actor.locale,
            ),
          };
        },
      );
      if (result.ok && afterCommit) {
        await (afterCommit as () => Promise<void>)().catch(() => undefined);
      }
      return result;
    },

    /** GET …/custom-api/definitions/:definitionId/connections */
    listDefinitionConnections(
      actor: CustomApiUpdateActor,
      definitionId: string,
    ): Promise<CustomApiUpdateResult<CustomApiDefinitionConnectionsResponse>> {
      return inWorkspace(actor, async (tx) => {
        const found = await findCustomApiDefinition(
          tx,
          actor.workspaceId,
          definitionId,
        );
        if (!found) return fail(404, "custom_api_definition_not_found");
        const rows = await listCustomApiDefinitionConnections(
          tx,
          actor.workspaceId,
          definitionId,
        );
        return {
          ok: true,
          value: {
            connections: rows.map((row) => ({
              ...row,
              updateAvailable: row.version < found.definition.currentVersion,
            })),
          },
        };
      });
    },
  };
}

/** The connection's non-secret variable values (its config). */
function plainValues(existing: ConnectionWithState): Record<string, string> {
  const config = (existing.row.config ?? {}) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(config).flatMap(([id, value]) =>
      typeof value === "string" ? [[id, value]] : [],
    ),
  );
}

function stateScope(workspaceId: string, connectionId: string) {
  return and(
    eq(schema.connectionState.workspaceId, workspaceId),
    eq(schema.connectionState.connectionId, connectionId),
  );
}
