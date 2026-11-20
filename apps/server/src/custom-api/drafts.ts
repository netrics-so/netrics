// Draft connections of the custom API builder (milestone 13, #806). A draft
// is a custom-api connection with status 'draft': it holds the builder's
// secrets on the server while the definition is not saved yet, bound to the
// hosts they were entered for. It is never scheduled, hidden from every
// connection path, and deleted 24 hours after it was last touched (every
// call here touches it). Promotion turns it into a pinned, scheduled
// connection in one UPDATE, keeping its credential envelope.
//
// Storage: config = { draft: DraftState }; secrets in credentials_encrypted
// in the shape C stores for the auth type, so promotion keeps the envelope:
// { host, …authSecrets, variables } for none/API key/bearer/basic and
// { host, clientId, clientSecret, refreshToken: null } for the OAuth types.

import { randomUUID } from "node:crypto";

import { and, count, eq, sql } from "drizzle-orm";

import {
  customApiDraftDefinitionSchema,
  type CreateCustomApiDraftRequest,
  type CustomApiDraft,
  type CustomApiDraftDefinition,
  type PromoteCustomApiDraftRequest,
  type UpdateCustomApiDraftRequest,
} from "@netrics/contracts";
import {
  upgradeCustomApiDefinition,
  type CustomApiAuth,
  type CustomApiDefinition,
} from "@netrics/connector-sdk/custom-api";
import {
  CUSTOM_API_CONNECTOR_ID,
  customApiCredentialHosts,
  customApiCredentialsSchema,
  customApiEnvironmentHost,
} from "@netrics/connectors/custom-api";
import {
  countCustomApiConnections,
  DRAFT_CONNECTION_TTL_HOURS,
  enqueueJob,
  findConnection,
  findCustomApiDefinition,
  findCustomApiDefinitionVersion,
  findProject,
  insertAuditEvent,
  insertConnection,
  schema,
  withWorkspace,
  type ConnectionRow,
  type Database,
  type Transaction,
} from "@netrics/database";

import {
  decryptCredentials,
  encryptCredentials,
  type CredentialKeyring,
} from "../credentials.js";
import type { CustomApiInstanceConfig } from "../env.js";

/** Open drafts per workspace. */
export const CUSTOM_API_DRAFT_LIMIT = 10;

const HOUR_MS = 60 * 60 * 1000;

/** A draft is never scheduled; the interval is set again on promotion. */
const CUSTOM_API_DEFAULT_POLL_SECONDS = 3_600;

export interface DraftActor {
  workspaceId: string;
  callerId: string;
}

export type DraftResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 404 | 409; error: string };

function fail(
  status: 400 | 404 | 409,
  error: string,
): { ok: false; status: 400 | 404 | 409; error: string } {
  return { ok: false, status, error };
}

const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });

/** What `connections.config.draft` holds. */
export interface DraftState {
  /** The saved definition the builder edits, if any. */
  definitionId: string | null;
  definition: CustomApiDraftDefinition | null;
  environmentId: string | null;
  /** Non-secret variable values. */
  variables: Record<string, string>;
  /** customApiCredentialHosts at the time the secrets were entered. */
  credentialHosts: string[];
  /** The environment host (with a non-default port) of the stored envelope. */
  secretHost: string | null;
  /** Names of the stored secrets: credential names and secret variable ids. */
  secretNames: string[];
}

const EMPTY_STATE: DraftState = {
  definitionId: null,
  definition: null,
  environmentId: null,
  variables: {},
  credentialHosts: [],
  secretHost: null,
  secretNames: [],
};

/** A draft as the test runner needs it (server-internal: holds secrets). */
export interface OpenedDraft {
  id: string;
  state: DraftState;
  /** The decrypted envelope; null without stored secrets. */
  credentials: Record<string, unknown> | null;
  updatedAt: Date;
}

const OAUTH_TYPES = new Set<CustomApiAuth["type"]>([
  "oauth_client_credentials",
  "oauth_authorization_code",
]);

export function isCustomApiOAuth(auth: Pick<CustomApiAuth, "type">): boolean {
  return OAUTH_TYPES.has(auth.type);
}

/** The credential names the login method declares (secret variables aside). */
export function customApiCredentialNames(
  auth: Pick<CustomApiAuth, "type">,
): string[] {
  switch (auth.type) {
    case "api_key":
      return ["apiKey"];
    case "bearer":
      return ["token"];
    case "basic":
      return ["username", "password"];
    case "oauth_client_credentials":
    case "oauth_authorization_code":
      return ["clientId", "clientSecret"];
    case "none":
      return [];
  }
}

function secretVariableIds(
  definition: Pick<CustomApiDraftDefinition, "variables">,
): string[] {
  return definition.variables.filter((v) => v.secret).map((v) => v.id);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((x) => right.has(x));
}

/** The hosts a draft's secrets are bound to, and its environment host with port. */
export function draftBinding(
  definition: Pick<CustomApiDraftDefinition, "environments" | "auth">,
  environmentId: string,
): { hosts: string[]; host: string } {
  const environment = definition.environments.find(
    (entry) => entry.id === environmentId,
  )!;
  return {
    hosts: customApiCredentialHosts(definition, environmentId),
    host: customApiEnvironmentHost(environment),
  };
}

/** Whether stored secrets may go to the draft's current hosts. */
export function draftBindingHolds(
  state: Pick<DraftState, "credentialHosts" | "secretHost" | "secretNames">,
  binding: { hosts: string[]; host: string },
): boolean {
  return (
    state.secretNames.length === 0 ||
    (sameSet(state.credentialHosts, binding.hosts) &&
      state.secretHost === binding.host)
  );
}

function readState(row: ConnectionRow): DraftState {
  const config = row.config as { draft?: Partial<DraftState> } | null;
  const stored = config?.draft ?? {};
  const parsed =
    stored.definition == null
      ? null
      : customApiDraftDefinitionSchema.safeParse(stored.definition);
  return {
    ...EMPTY_STATE,
    ...stored,
    definition: parsed?.success ? parsed.data : null,
  };
}

function view(row: ConnectionRow, state: DraftState): CustomApiDraft {
  return {
    id: row.id,
    expiresAt: new Date(
      row.updatedAt.getTime() + DRAFT_CONNECTION_TTL_HOURS * HOUR_MS,
    ).toISOString(),
    environmentId: state.environmentId,
    variables: state.variables,
    secretsSet: state.secretNames,
    credentialHosts: state.secretNames.length ? state.credentialHosts : [],
  };
}

/** The draft row (status 'draft', custom-api) with an explicit workspace predicate. */
async function findDraft(
  tx: Transaction,
  workspaceId: string,
  draftId: string,
): Promise<ConnectionRow | null> {
  const found = await findConnection(tx, workspaceId, draftId, {
    includeDrafts: true,
  });
  if (
    !found ||
    found.row.status !== "draft" ||
    found.row.connectorId !== CUSTOM_API_CONNECTOR_ID
  )
    return null;
  return found.row;
}

export interface CustomApiDraftDeps {
  db: Database;
  credentialKeyring: CredentialKeyring;
  limits: CustomApiInstanceConfig;
  /** Clock for the draft's updated_at (tests pin it). */
  now?: () => Date;
}

export function createCustomApiDraftService(deps: CustomApiDraftDeps) {
  const now = deps.now ?? (() => new Date());
  const inWorkspace = <T>(
    actor: DraftActor,
    run: (tx: Transaction) => Promise<T>,
  ) =>
    withWorkspace(
      deps.db,
      { workspaceId: actor.workspaceId, userId: actor.callerId },
      run,
    );

  const seal = (
    actor: DraftActor,
    connectionId: string,
    envelope: Record<string, unknown>,
  ) =>
    Buffer.from(
      encryptCredentials(JSON.stringify(envelope), deps.credentialKeyring, {
        workspaceId: actor.workspaceId,
        connectionId,
      }),
      "utf8",
    );

  function open(
    actor: DraftActor,
    row: ConnectionRow,
  ): Record<string, unknown> | null {
    if (!row.credentialsEncrypted) return null;
    return JSON.parse(
      decryptCredentials(
        row.credentialsEncrypted.toString("utf8"),
        deps.credentialKeyring,
        { workspaceId: actor.workspaceId, connectionId: row.id },
      ),
    ) as Record<string, unknown>;
  }

  async function write(
    tx: Transaction,
    actor: DraftActor,
    draftId: string,
    state: DraftState,
    credentials?: Buffer | null,
  ): Promise<ConnectionRow | null> {
    const [row] = await tx
      .update(schema.connections)
      .set({
        config: { draft: state },
        ...(credentials !== undefined
          ? { credentialsEncrypted: credentials }
          : {}),
        updatedAt: now(),
      })
      .where(
        and(
          eq(schema.connections.workspaceId, actor.workspaceId),
          eq(schema.connections.id, draftId),
          eq(schema.connections.status, "draft"),
        ),
      )
      .returning();
    return row ?? null;
  }

  return {
    /** POST …/custom-api/drafts */
    async create(
      actor: DraftActor,
      body: CreateCustomApiDraftRequest,
    ): Promise<DraftResult<CustomApiDraft>> {
      return inWorkspace(actor, async (tx) => {
        if (body.definitionId) {
          const found = await findCustomApiDefinition(
            tx,
            actor.workspaceId,
            body.definitionId,
          );
          if (!found) return fail(404, "custom_api_definition_not_found");
        }
        const [open] = await tx
          .select({ n: count() })
          .from(schema.connections)
          .where(
            and(
              eq(schema.connections.workspaceId, actor.workspaceId),
              eq(schema.connections.status, "draft"),
            ),
          );
        if (Number(open?.n ?? 0) >= CUSTOM_API_DRAFT_LIMIT)
          return fail(409, "custom_api_draft_limit");
        const state: DraftState = {
          ...EMPTY_STATE,
          definitionId: body.definitionId ?? null,
        };
        const created = await insertConnection(tx, {
          id: randomUUID(),
          workspaceId: actor.workspaceId,
          connectorId: CUSTOM_API_CONNECTOR_ID,
          name: "Custom API draft",
          config: { draft: state },
          credentialsEncrypted: null,
          projectId: null,
          pollIntervalSeconds: CUSTOM_API_DEFAULT_POLL_SECONDS,
          status: "draft",
        });
        return ok(view(created.row, state));
      });
    },

    /**
     * PUT …/drafts/:draftId: stores the definition, environment, values
     * and (when given) the secrets. Without new secrets, stored ones whose
     * hosts no longer match the definition are deleted (secretsSet: []).
     */
    async update(
      actor: DraftActor,
      draftId: string,
      body: UpdateCustomApiDraftRequest,
    ): Promise<DraftResult<CustomApiDraft>> {
      const definition = customApiDraftDefinitionSchema.parse(body.definition);
      return inWorkspace(actor, async (tx) => {
        const row = await findDraft(tx, actor.workspaceId, draftId);
        if (!row) return fail(404, "custom_api_draft_not_found");
        const state = readState(row);
        if (!definition.environments.some((e) => e.id === body.environmentId))
          return fail(400, "custom_api_environment_not_found");
        const plain = new Set(
          definition.variables.filter((v) => !v.secret).map((v) => v.id),
        );
        const variables = body.variables ?? {};
        if (Object.keys(variables).some((id) => !plain.has(id)))
          return fail(400, "custom_api_variables_invalid");
        const binding = draftBinding(definition, body.environmentId);
        const next: DraftState = {
          ...state,
          definition,
          environmentId: body.environmentId,
          variables,
        };
        let credentials: Buffer | null | undefined;
        if (body.secrets !== undefined) {
          const names = customApiCredentialNames(definition.auth);
          const secretIds = secretVariableIds(definition);
          const allowed = new Set([...names, ...secretIds]);
          const given = Object.keys(body.secrets);
          if (given.some((name) => !allowed.has(name)))
            return fail(400, "custom_api_secret_unknown");
          const authSecrets = Object.fromEntries(
            names.flatMap((name) =>
              Object.hasOwn(body.secrets!, name)
                ? [[name, body.secrets![name]!]]
                : [],
            ),
          );
          const variableSecrets = Object.fromEntries(
            secretIds.flatMap((id) =>
              Object.hasOwn(body.secrets!, id)
                ? [[id, body.secrets![id]!]]
                : [],
            ),
          );
          const envelope = isCustomApiOAuth(definition.auth)
            ? {
                host: binding.host,
                ...authSecrets,
                refreshToken: null,
              }
            : {
                host: binding.host,
                ...authSecrets,
                ...(secretIds.length ? { variables: variableSecrets } : {}),
              };
          next.secretNames = given.sort();
          next.credentialHosts = given.length ? binding.hosts : [];
          next.secretHost = given.length ? binding.host : null;
          credentials = given.length ? seal(actor, draftId, envelope) : null;
        } else if (!draftBindingHolds(state, binding)) {
          // The secrets were entered for another host: never sent there.
          next.secretNames = [];
          next.credentialHosts = [];
          next.secretHost = null;
          credentials = null;
        }
        const written = await write(tx, actor, draftId, next, credentials);
        if (!written) return fail(404, "custom_api_draft_not_found");
        return ok(view(written, next));
      });
    },

    /** DELETE …/drafts/:draftId */
    async remove(
      actor: DraftActor,
      draftId: string,
    ): Promise<DraftResult<null>> {
      return inWorkspace(actor, async (tx) => {
        const deleted = await tx
          .delete(schema.connections)
          .where(
            and(
              eq(schema.connections.workspaceId, actor.workspaceId),
              eq(schema.connections.id, draftId),
              eq(schema.connections.status, "draft"),
            ),
          )
          .returning({ id: schema.connections.id });
        return deleted.length
          ? ok(null)
          : fail(404, "custom_api_draft_not_found");
      });
    },

    /**
     * POST …/drafts/:draftId/promote: the draft becomes a scheduled
     * connection pinned to the saved version, keeping its envelope.
     */
    async promote(
      actor: DraftActor,
      draftId: string,
      body: PromoteCustomApiDraftRequest,
    ): Promise<DraftResult<{ connectionId: string }>> {
      return inWorkspace(actor, async (tx) => {
        const row = await findDraft(tx, actor.workspaceId, draftId);
        if (!row) return fail(409, "custom_api_draft_not_found");
        const state = readState(row);
        const found = await findCustomApiDefinition(
          tx,
          actor.workspaceId,
          body.definitionId,
        );
        if (!found) return fail(404, "custom_api_definition_not_found");
        if (found.definition.archivedAt !== null)
          return fail(409, "custom_api_definition_archived");
        const version = await findCustomApiDefinitionVersion(
          tx,
          actor.workspaceId,
          body.definitionId,
          body.version,
        );
        if (!version) return fail(404, "custom_api_definition_not_found");
        let definition: CustomApiDefinition;
        try {
          definition = upgradeCustomApiDefinition(version.document);
        } catch {
          return fail(400, "custom_api_definition_invalid");
        }
        const environmentId = state.environmentId;
        if (
          environmentId === null ||
          !definition.environments.some((e) => e.id === environmentId)
        )
          return fail(400, "custom_api_environment_not_found");
        const plainIds = definition.variables
          .filter((v) => !v.secret)
          .map((v) => v.id);
        const secretIds = secretVariableIds(definition);
        const storedSecretVariables = state.secretNames.filter(
          (name) => !customApiCredentialNames(definition.auth).includes(name),
        );
        if (
          !sameSet(Object.keys(state.variables), plainIds) ||
          !sameSet(storedSecretVariables, secretIds)
        )
          return fail(400, "custom_api_variables_invalid");
        if (isCustomApiOAuth(definition.auth))
          return fail(400, "custom_api_oauth_unavailable");
        if (!draftBindingHolds(state, draftBinding(definition, environmentId)))
          return fail(409, "custom_api_credentials_host_changed");
        const envelope = open(actor, row);
        const needsSecrets =
          definition.auth.type !== "none" || secretIds.length > 0;
        if (
          needsSecrets
            ? !envelope ||
              !customApiCredentialsSchema(definition).safeParse(envelope)
                .success
            : envelope !== null
        )
          return fail(400, "custom_api_credentials_invalid");
        if (
          (await countCustomApiConnections(tx, actor.workspaceId)) >=
          deps.limits.maxConnections
        )
          return fail(409, "custom_api_connection_limit");
        if (body.projectId) {
          const project = await findProject(
            tx,
            actor.workspaceId,
            body.projectId,
          );
          if (!project || project.archivedAt !== null)
            return fail(404, "project_not_found");
        }
        const refreshMinutes = Math.max(
          definition.defaults.refreshMinutes,
          deps.limits.minRefreshMinutes,
        );
        // One UPDATE flips the status and sets the pin, so the pin check
        // holds; only a row that is still a draft is promoted.
        const [promoted] = await tx
          .update(schema.connections)
          .set({
            status: "active",
            name: body.name,
            projectId: body.projectId,
            customApiDefinitionVersionId: version.id,
            customApiEnvironmentId: environmentId,
            config: { ...state.variables },
            updatedAt: now(),
          })
          .where(
            and(
              eq(schema.connections.workspaceId, actor.workspaceId),
              eq(schema.connections.id, draftId),
              eq(schema.connections.status, "draft"),
            ),
          )
          .returning({ id: schema.connections.id });
        if (!promoted) return fail(409, "custom_api_draft_not_found");
        await tx
          .update(schema.connectionState)
          .set({
            nextDueAt: sql`now()`,
            pollIntervalSeconds: refreshMinutes * 60,
          })
          .where(
            and(
              eq(schema.connectionState.workspaceId, actor.workspaceId),
              eq(schema.connectionState.connectionId, draftId),
            ),
          );
        await enqueueJob(tx, {
          kind: "connection.backfill",
          workspaceId: actor.workspaceId,
          connectionId: draftId,
          idempotencyKey: `backfill:${draftId}`,
        });
        await insertAuditEvent(tx, {
          workspaceId: actor.workspaceId,
          actorUserId: actor.callerId,
          action: "connection.created",
          target: draftId,
          metadata: {
            name: body.name,
            connectorId: CUSTOM_API_CONNECTOR_ID,
            definitionId: body.definitionId,
            version: version.version,
            environmentId,
            fromDraft: true,
          },
        });
        return ok({ connectionId: draftId });
      });
    },

    /** Secrets, values and the stored definition for the test runner (server-internal). */
    async open(
      actor: DraftActor,
      draftId: string,
    ): Promise<DraftResult<OpenedDraft>> {
      return inWorkspace(actor, async (tx) => {
        const row = await findDraft(tx, actor.workspaceId, draftId);
        if (!row) return fail(404, "custom_api_draft_not_found");
        const touched = await write(tx, actor, draftId, readState(row));
        if (!touched) return fail(404, "custom_api_draft_not_found");
        return ok({
          id: row.id,
          state: readState(touched),
          credentials: open(actor, touched),
          updatedAt: touched.updatedAt,
        });
      });
    },

    /** The draft's public view (no secrets). */
    view,
  };
}

export type CustomApiDraftService = ReturnType<
  typeof createCustomApiDraftService
>;
