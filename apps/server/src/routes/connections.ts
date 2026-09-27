import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";

import {
  connectionDetailResponseSchema,
  connectionListResponseSchema,
  connectionPreviewResponseSchema,
  connectionResponseSchema,
  connectorListResponseSchema,
  createConnectionRequestSchema,
  enqueueSyncResponseSchema,
  errorResponseSchema,
  observationListResponseSchema,
  previewConnectionRequestSchema,
  updateConnectionRequestSchema,
  workspaceRoleSchema,
  type ConnectionAuthState,
  type ConnectionHealth,
  type ConnectionStateView,
  type WorkspaceRole,
} from "@netrics/contracts";
import {
  executeCheck,
  executeDiscover,
  type ConnectorRegistry,
} from "@netrics/connector-runtime";
import type { ConnectorManifest } from "@netrics/connector-sdk";
import {
  enqueueJob,
  findMembership,
  findProject,
  insertAuditEvent,
  schema,
  withUserContext,
  withWorkspace,
  type Database,
  type Transaction,
} from "@netrics/database";
import { can } from "@netrics/domain";

import type { AuthService } from "../auth/index.js";
import { validateConnectionConfig } from "../config-schema.js";
import {
  decryptCredentials,
  encryptCredentials,
  redactSecrets,
  type CredentialKeyring,
} from "../credentials.js";
import { upsertConnectorCatalog } from "../sync/catalog.js";
import { createRequireSession } from "./session.js";

export interface ConnectionRouteDeps {
  authService: AuthService;
  db: Database;
  registry: ConnectorRegistry;
  credentialKeyring: CredentialKeyring;
}

function sendError(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send(errorResponseSchema.parse({ error }));
}

function parseBody<T>(
  schema_: z.ZodType<T>,
  request: FastifyRequest,
  reply: FastifyReply,
): T | null {
  const parsed = schema_.safeParse(request.body);
  if (!parsed.success) {
    sendError(reply, 400, "invalid_request");
    return null;
  }
  return parsed.data;
}

interface WorkspaceAccess {
  workspaceId: string;
  callerId: string;
  role: WorkspaceRole;
}

const workspaceParamsSchema = z.object({ workspaceId: z.uuid() });
const connectionParamsSchema = z.object({ connectionId: z.uuid() });

// Same membership resolution as the workspace routes: a missing membership
// yields 404 so workspace existence is not leaked.
async function resolveAccess(
  db: Database,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<WorkspaceAccess | null> {
  const params = workspaceParamsSchema.safeParse(request.params);
  if (!params.success) {
    sendError(reply, 404, "workspace_not_found");
    return null;
  }
  const callerId = request.sessionIdentity!.domainUserId;
  const membership = await withUserContext(db, { userId: callerId }, (tx) =>
    findMembership(tx, params.data.workspaceId, callerId),
  );
  if (!membership) {
    sendError(reply, 404, "workspace_not_found");
    return null;
  }
  return {
    workspaceId: params.data.workspaceId,
    callerId,
    role: workspaceRoleSchema.parse(membership.role),
  };
}

type ConnectionRow = typeof schema.connections.$inferSelect;
type ConnectionStateRow = typeof schema.connectionState.$inferSelect;

/** Redacted, bounded message for connector-facing errors. */
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return String(redactSecrets(message)).slice(0, 500);
}

function toStateView(state: ConnectionStateRow | null): ConnectionStateView {
  const authState: ConnectionAuthState = state
    ? (state.authState as ConnectionAuthState)
    : "ok";
  const health: ConnectionHealth = !state?.lastSuccessAt
    ? "pending"
    : authState === "ok"
      ? "ok"
      : authState;
  return {
    health,
    authState,
    lastSuccessAt: state?.lastSuccessAt?.toISOString() ?? null,
    nextDueAt: state?.nextDueAt?.toISOString() ?? null,
    consecutiveFailures: state?.consecutiveFailures ?? 0,
    pollIntervalSeconds:
      state?.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS,
  };
}

const DEFAULT_POLL_INTERVAL_SECONDS = 300;

function toConnection(
  registry: ConnectorRegistry,
  row: ConnectionRow,
  state: ConnectionStateRow | null,
) {
  const manifest = registry.get(row.connectorId)?.manifest;
  return {
    id: row.id,
    name: row.name,
    connectorId: row.connectorId,
    connectorName: manifest?.name ?? row.connectorId,
    connectorVersion: manifest?.version ?? "unknown",
    projectId: row.projectId,
    hasCredentials: row.credentialsEncrypted != null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    state: toStateView(state),
  };
}

function toConnectionDetail(
  registry: ConnectorRegistry,
  row: ConnectionRow,
  state: ConnectionStateRow | null,
) {
  // Strip the reserved resource-selection key from the echoed config; it is
  // an engine concern, not a manifest config property.
  const { resourceSelection: _resourceSelection, ...config } =
    row.config as Record<string, unknown>;
  return {
    ...toConnection(registry, row, state),
    config,
  };
}

// Every query in this module names the workspace explicitly in addition to
// the RLS context (defense in depth): isolation must not depend on the
// database role being unprivileged.
function connectionScope(workspaceId: string, connectionId: string) {
  return and(
    eq(schema.connections.workspaceId, workspaceId),
    eq(schema.connections.id, connectionId),
  );
}

async function loadConnection(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
): Promise<{ row: ConnectionRow; state: ConnectionStateRow | null } | null> {
  const [row] = await tx
    .select()
    .from(schema.connections)
    .where(connectionScope(workspaceId, connectionId))
    .limit(1);
  if (!row) {
    return null;
  }
  const [state] = await tx
    .select()
    .from(schema.connectionState)
    .where(
      and(
        eq(schema.connectionState.workspaceId, workspaceId),
        eq(schema.connectionState.connectionId, connectionId),
      ),
    )
    .limit(1);
  return { row, state: state ?? null };
}

interface ValidatedConfigOk {
  ok: true;
  config: Record<string, unknown>;
}

/** Validates config against the manifest subset; sends 400 on failure. */
function validateConfigOrReply(
  manifest: ConnectorManifest,
  config: Record<string, unknown>,
  reply: FastifyReply,
): ValidatedConfigOk | null {
  const validated = validateConnectionConfig(manifest.configSchema, config);
  if (!validated.ok) {
    sendError(reply, 400, validated.message);
    return null;
  }
  return validated;
}

/**
 * Runs the connector check for a candidate config/credentials pair. Returns
 * null after sending the reply when the check fails (400 with the connector's
 * actionable, already-redacted message — nothing is persisted by callers in
 * that case).
 */
async function runCheckOrReply(
  deps: ConnectionRouteDeps,
  connectorId: string,
  connectionId: string,
  config: Record<string, unknown>,
  credentials: Record<string, unknown>,
  reply: FastifyReply,
) {
  const registered = deps.registry.get(connectorId);
  if (!registered) {
    sendError(reply, 400, "invalid_request");
    return null;
  }
  try {
    const check = await executeCheck(registered.connector, {
      connectionId,
      config,
      credentials,
    });
    if (!check.ok) {
      sendError(reply, 400, check.message ?? "credential check failed");
      return null;
    }
    return check;
  } catch (error) {
    // Thrown checks signal a provider-side failure (outage, rate limit); the
    // message is redacted at the runtime boundary already.
    sendError(reply, 400, safeMessage(error));
    return null;
  }
}

export function registerConnectionRoutes(
  app: FastifyInstance,
  deps: ConnectionRouteDeps,
): void {
  const requireSession = createRequireSession(deps.authService);

  void app.register(
    (scope, _opts, done) => {
      scope.addHook("preHandler", requireSession);

      // Installation-level catalog, served from the deployed bundle (the
      // registry is the source of truth; the connectors table is its
      // persistence mirror).
      scope.get("/connectors", async () =>
        connectorListResponseSchema.parse({
          connectors: deps.registry.list().map(({ manifest }) => ({
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            description: manifest.description,
            metricsCount: manifest.metrics.length,
            minRefreshIntervalSeconds: manifest.minRefreshIntervalSeconds,
            supportsBackfill: manifest.supportsBackfill,
            configSchema: { ...manifest.configSchema },
            authStrategies: manifest.authStrategies.map((strategy) => ({
              strategy: strategy.strategy,
            })),
          })),
        }),
      );

      scope.post(
        "/workspaces/:workspaceId/connections",
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) {
            return;
          }
          if (!can(access.role, "connections:create")) {
            return sendError(reply, 403, "forbidden");
          }
          const body = parseBody(createConnectionRequestSchema, request, reply);
          if (!body) {
            return;
          }
          const registered = deps.registry.get(body.connectorId);
          if (!registered) {
            return sendError(reply, 400, "invalid_request");
          }
          const validated = validateConfigOrReply(
            registered.manifest,
            body.config,
            reply,
          );
          if (!validated) {
            return;
          }
          const config = { ...validated.config };
          if (body.resources && body.resources.length > 0) {
            config.resourceSelection = body.resources;
          }
          const credentials = body.credentials ?? {};

          // Check BEFORE anything is persisted: bad credentials are a 400 with
          // the connector's actionable message and leave no rows behind.
          const connectionId = randomUUID();
          const check = await runCheckOrReply(
            deps,
            body.connectorId,
            connectionId,
            config,
            credentials,
            reply,
          );
          if (!check) {
            return;
          }

          const created = await withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            async (tx) => {
              // First-use safety net: the catalog sync runs at startup, but the
              // connections row has an FK into connectors.
              await upsertConnectorCatalog(tx, registered.manifest);
              if (body.projectId) {
                const project = await findProject(
                  tx,
                  access.workspaceId,
                  body.projectId,
                );
                if (!project) {
                  sendError(reply, 404, "project_not_found");
                  return null;
                }
              }
              const [row] = await tx
                .insert(schema.connections)
                .values({
                  id: connectionId,
                  workspaceId: access.workspaceId,
                  connectorId: body.connectorId,
                  name: body.name,
                  config,
                  credentialsEncrypted: body.credentials
                    ? Buffer.from(
                        encryptCredentials(
                          JSON.stringify(body.credentials),
                          deps.credentialKeyring,
                          { workspaceId: access.workspaceId, connectionId },
                        ),
                        "utf8",
                      )
                    : null,
                  projectId: body.projectId ?? null,
                })
                .returning();
              if (!row) {
                throw new Error("connection insert returned no row");
              }
              const [state] = await tx
                .insert(schema.connectionState)
                .values({
                  connectionId,
                  workspaceId: access.workspaceId,
                  nextDueAt: new Date(),
                  pollIntervalSeconds:
                    registered.manifest.minRefreshIntervalSeconds,
                })
                .returning();
              // Transactional enqueue invariant: the connection, its state, and
              // the initial backfill job commit atomically.
              await enqueueJob(tx, {
                kind: "connection.backfill",
                workspaceId: access.workspaceId,
                connectionId,
                idempotencyKey: `backfill:${connectionId}`,
              });
              await insertAuditEvent(tx, {
                workspaceId: access.workspaceId,
                actorUserId: access.callerId,
                action: "connection.created",
                target: connectionId,
                metadata: { name: body.name, connectorId: body.connectorId },
              });
              return { row, state: state ?? null };
            },
          );
          if (!created) {
            return;
          }
          return connectionResponseSchema.parse({
            connection: toConnectionDetail(
              deps.registry,
              created.row,
              created.state,
            ),
          });
        },
      );

      scope.post(
        "/workspaces/:workspaceId/connections/preview",
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) {
            return;
          }
          if (!can(access.role, "connections:create")) {
            return sendError(reply, 403, "forbidden");
          }
          const body = parseBody(
            previewConnectionRequestSchema,
            request,
            reply,
          );
          if (!body) {
            return;
          }
          const registered = deps.registry.get(body.connectorId);
          if (!registered) {
            return sendError(reply, 400, "invalid_request");
          }
          const validated = validateConfigOrReply(
            registered.manifest,
            body.config,
            reply,
          );
          if (!validated) {
            return;
          }
          const credentials = body.credentials ?? {};
          const context = {
            connectionId: "preview",
            config: validated.config,
            credentials,
          };
          let check;
          try {
            check = await executeCheck(registered.connector, context);
          } catch (error) {
            return sendError(reply, 400, safeMessage(error));
          }
          if (!check.ok) {
            return connectionPreviewResponseSchema.parse({
              check,
              resources: [],
            });
          }
          try {
            const resources = await executeDiscover(
              registered.connector,
              context,
            );
            return connectionPreviewResponseSchema.parse({ check, resources });
          } catch (error) {
            return sendError(reply, 400, safeMessage(error));
          }
        },
      );

      scope.get(
        "/workspaces/:workspaceId/connections",
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) {
            return;
          }
          if (!can(access.role, "connections:view")) {
            return sendError(reply, 403, "forbidden");
          }
          const rows = await withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            (tx) =>
              tx
                .select({
                  connection: schema.connections,
                  state: schema.connectionState,
                })
                .from(schema.connections)
                .leftJoin(
                  schema.connectionState,
                  and(
                    eq(
                      schema.connectionState.connectionId,
                      schema.connections.id,
                    ),
                    eq(schema.connectionState.workspaceId, access.workspaceId),
                  ),
                )
                .where(eq(schema.connections.workspaceId, access.workspaceId))
                .orderBy(schema.connections.createdAt),
          );
          return connectionListResponseSchema.parse({
            connections: rows.map(({ connection, state }) =>
              toConnection(deps.registry, connection, state),
            ),
          });
        },
      );

      scope.get(
        "/workspaces/:workspaceId/connections/:connectionId",
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) {
            return;
          }
          if (!can(access.role, "connections:view")) {
            return sendError(reply, 403, "forbidden");
          }
          const params = connectionParamsSchema.safeParse(request.params);
          if (!params.success) {
            return sendError(reply, 404, "connection_not_found");
          }
          const result = await withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            async (tx) => {
              const loaded = await loadConnection(
                tx,
                access.workspaceId,
                params.data.connectionId,
              );
              if (!loaded) {
                return null;
              }
              const syncRuns = await tx
                .select()
                .from(schema.syncRuns)
                .where(
                  and(
                    eq(schema.syncRuns.workspaceId, access.workspaceId),
                    eq(schema.syncRuns.connectionId, params.data.connectionId),
                  ),
                )
                .orderBy(desc(schema.syncRuns.startedAt))
                .limit(20);
              return { ...loaded, syncRuns };
            },
          );
          if (!result) {
            return sendError(reply, 404, "connection_not_found");
          }
          return connectionDetailResponseSchema.parse({
            connection: toConnectionDetail(
              deps.registry,
              result.row,
              result.state,
            ),
            syncRuns: result.syncRuns.map((run) => ({
              id: run.id,
              mode: run.mode,
              status: run.status,
              requestedFrom: run.requestedFrom.toISOString(),
              requestedTo: run.requestedTo.toISOString(),
              cursorBefore: run.cursorBefore,
              cursorAfter: run.cursorAfter,
              attempt: run.attempt,
              startedAt: run.startedAt.toISOString(),
              finishedAt: run.finishedAt?.toISOString() ?? null,
              errorClass: run.errorClass,
              errorMessage: run.errorMessage,
              observationsWritten: run.observationsWritten,
            })),
          });
        },
      );

      scope.patch(
        "/workspaces/:workspaceId/connections/:connectionId",
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) {
            return;
          }
          if (!can(access.role, "connections:update")) {
            return sendError(reply, 403, "forbidden");
          }
          const params = connectionParamsSchema.safeParse(request.params);
          if (!params.success) {
            return sendError(reply, 404, "connection_not_found");
          }
          const body = parseBody(updateConnectionRequestSchema, request, reply);
          if (!body) {
            return;
          }
          const existing = await withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            (tx) =>
              loadConnection(tx, access.workspaceId, params.data.connectionId),
          );
          if (!existing) {
            return sendError(reply, 404, "connection_not_found");
          }
          const registered = deps.registry.get(existing.row.connectorId);
          if (!registered) {
            return sendError(reply, 400, "invalid_request");
          }

          const existingConfig = existing.row.config as Record<string, unknown>;
          let nextConfig: Record<string, unknown> | undefined;
          if (body.config !== undefined) {
            const validated = validateConfigOrReply(
              registered.manifest,
              body.config,
              reply,
            );
            if (!validated) {
              return;
            }
            nextConfig = { ...validated.config };
            // PATCH cannot change the resource selection; carry it over.
            if (existingConfig.resourceSelection !== undefined) {
              nextConfig.resourceSelection = existingConfig.resourceSelection;
            }
          }

          if (body.projectId) {
            const project = await withWorkspace(
              deps.db,
              { workspaceId: access.workspaceId, userId: access.callerId },
              (tx) => findProject(tx, access.workspaceId, body.projectId!),
            );
            if (!project) {
              return sendError(reply, 404, "project_not_found");
            }
          }

          // Config or credential changes are re-checked against the connector
          // before they persist (same rule as creation).
          if (body.config !== undefined || body.credentials !== undefined) {
            let credentials: Record<string, unknown>;
            if (body.credentials !== undefined) {
              credentials = body.credentials;
            } else if (existing.row.credentialsEncrypted) {
              try {
                credentials = JSON.parse(
                  decryptCredentials(
                    existing.row.credentialsEncrypted.toString("utf8"),
                    deps.credentialKeyring,
                    {
                      workspaceId: access.workspaceId,
                      connectionId: existing.row.id,
                    },
                  ),
                ) as Record<string, unknown>;
              } catch (error) {
                return sendError(reply, 400, safeMessage(error));
              }
            } else {
              credentials = {};
            }
            const check = await runCheckOrReply(
              deps,
              existing.row.connectorId,
              existing.row.id,
              nextConfig ?? existingConfig,
              credentials,
              reply,
            );
            if (!check) {
              return;
            }
          }

          const updated = await withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            async (tx) => {
              const [row] = await tx
                .update(schema.connections)
                .set({
                  ...(body.name !== undefined ? { name: body.name } : {}),
                  ...(nextConfig !== undefined ? { config: nextConfig } : {}),
                  ...(body.credentials !== undefined
                    ? {
                        credentialsEncrypted: Buffer.from(
                          encryptCredentials(
                            JSON.stringify(body.credentials),
                            deps.credentialKeyring,
                            {
                              workspaceId: access.workspaceId,
                              connectionId: params.data.connectionId,
                            },
                          ),
                          "utf8",
                        ),
                      }
                    : {}),
                  ...(body.projectId !== undefined
                    ? { projectId: body.projectId }
                    : {}),
                  updatedAt: new Date(),
                })
                .where(
                  connectionScope(access.workspaceId, params.data.connectionId),
                )
                .returning();
              if (!row) {
                sendError(reply, 404, "connection_not_found");
                return null;
              }
              let state = existing.state;
              if (body.credentials !== undefined) {
                // Recovery path for auth_failed/outage: fresh credentials make
                // the connection due immediately and reset the failure streak.
                const [updatedState] = await tx
                  .update(schema.connectionState)
                  .set({
                    authState: "ok",
                    consecutiveFailures: 0,
                    nextDueAt: new Date(),
                  })
                  .where(
                    and(
                      eq(
                        schema.connectionState.workspaceId,
                        access.workspaceId,
                      ),
                      eq(
                        schema.connectionState.connectionId,
                        params.data.connectionId,
                      ),
                    ),
                  )
                  .returning();
                state = updatedState ?? state;
                await insertAuditEvent(tx, {
                  workspaceId: access.workspaceId,
                  actorUserId: access.callerId,
                  action: "connection.credentials_updated",
                  target: params.data.connectionId,
                  metadata: { connectorId: row.connectorId },
                });
              }
              if (
                body.name !== undefined ||
                nextConfig !== undefined ||
                body.projectId !== undefined
              ) {
                await insertAuditEvent(tx, {
                  workspaceId: access.workspaceId,
                  actorUserId: access.callerId,
                  action: "connection.updated",
                  target: params.data.connectionId,
                  metadata: {
                    connectorId: row.connectorId,
                    changed: [
                      ...(body.name !== undefined ? ["name"] : []),
                      ...(nextConfig !== undefined ? ["config"] : []),
                      ...(body.projectId !== undefined ? ["projectId"] : []),
                    ],
                  },
                });
              }
              return { row, state };
            },
          );
          if (!updated) {
            return;
          }
          return connectionResponseSchema.parse({
            connection: toConnectionDetail(
              deps.registry,
              updated.row,
              updated.state,
            ),
          });
        },
      );

      scope.delete(
        "/workspaces/:workspaceId/connections/:connectionId",
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) {
            return;
          }
          if (!can(access.role, "connections:delete")) {
            return sendError(reply, 403, "forbidden");
          }
          const params = connectionParamsSchema.safeParse(request.params);
          if (!params.success) {
            return sendError(reply, 404, "connection_not_found");
          }
          const removed = await withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            async (tx) => {
              const loaded = await loadConnection(
                tx,
                access.workspaceId,
                params.data.connectionId,
              );
              if (!loaded) {
                sendError(reply, 404, "connection_not_found");
                return false;
              }
              // state/observations/sync_runs cascade with the row. Pending
              // jobs for the connection are cancelled (the app role has no
              // DELETE grant on jobs — migration 0005) so the worker never
              // claims work for a gone connection.
              await tx
                .update(schema.jobs)
                .set({ status: "failed", lastError: "connection deleted" })
                .where(
                  and(
                    eq(schema.jobs.workspaceId, access.workspaceId),
                    eq(schema.jobs.connectionId, params.data.connectionId),
                    eq(schema.jobs.status, "pending"),
                  ),
                );
              await tx
                .delete(schema.connections)
                .where(
                  connectionScope(access.workspaceId, params.data.connectionId),
                );
              await insertAuditEvent(tx, {
                workspaceId: access.workspaceId,
                actorUserId: access.callerId,
                action: "connection.deleted",
                target: params.data.connectionId,
                metadata: {
                  name: loaded.row.name,
                  connectorId: loaded.row.connectorId,
                },
              });
              return true;
            },
          );
          if (!removed) {
            return;
          }
          return reply.code(204).send();
        },
      );

      scope.post(
        "/workspaces/:workspaceId/connections/:connectionId/sync",
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) {
            return;
          }
          if (!can(access.role, "connections:update")) {
            return sendError(reply, 403, "forbidden");
          }
          const params = connectionParamsSchema.safeParse(request.params);
          if (!params.success) {
            return sendError(reply, 404, "connection_not_found");
          }
          const jobId = await withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            async (tx) => {
              const loaded = await loadConnection(
                tx,
                access.workspaceId,
                params.data.connectionId,
              );
              if (!loaded) {
                sendError(reply, 404, "connection_not_found");
                return null;
              }
              const id = await enqueueJob(tx, {
                kind: "connection.sync",
                workspaceId: access.workspaceId,
                connectionId: params.data.connectionId,
                idempotencyKey: `manual:${params.data.connectionId}:${randomUUID()}`,
              });
              await insertAuditEvent(tx, {
                workspaceId: access.workspaceId,
                actorUserId: access.callerId,
                action: "connection.sync_requested",
                target: params.data.connectionId,
                metadata: { jobId: id },
              });
              return id;
            },
          );
          if (!jobId) {
            return;
          }
          return enqueueSyncResponseSchema.parse({ jobId });
        },
      );

      const observationsQuerySchema = z.object({
        metricKey: z.string().min(1).optional(),
        from: z.iso.datetime().optional(),
        to: z.iso.datetime().optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(200),
      });

      scope.get(
        "/workspaces/:workspaceId/connections/:connectionId/observations",
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) {
            return;
          }
          if (!can(access.role, "connections:view")) {
            return sendError(reply, 403, "forbidden");
          }
          const params = connectionParamsSchema.safeParse(request.params);
          if (!params.success) {
            return sendError(reply, 404, "connection_not_found");
          }
          const query = observationsQuerySchema.safeParse(request.query);
          if (!query.success) {
            return sendError(reply, 400, "invalid_request");
          }
          const result = await withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            async (tx) => {
              const loaded = await loadConnection(
                tx,
                access.workspaceId,
                params.data.connectionId,
              );
              if (!loaded) {
                return null;
              }
              const rows = await tx
                .select({
                  id: schema.observations.id,
                  metricKey: schema.metricDefinitions.key,
                  sourceTimestamp: schema.observations.sourceTimestamp,
                  value: schema.observations.value,
                  dimensions: schema.observations.dimensions,
                  ingestedAt: schema.observations.ingestedAt,
                })
                .from(schema.observations)
                .innerJoin(
                  schema.metricDefinitions,
                  eq(
                    schema.observations.metricDefinitionId,
                    schema.metricDefinitions.id,
                  ),
                )
                .where(
                  and(
                    eq(schema.observations.workspaceId, access.workspaceId),
                    eq(
                      schema.observations.connectionId,
                      params.data.connectionId,
                    ),
                    query.data.metricKey
                      ? eq(schema.metricDefinitions.key, query.data.metricKey)
                      : undefined,
                    query.data.from
                      ? gte(
                          schema.observations.sourceTimestamp,
                          new Date(query.data.from),
                        )
                      : undefined,
                    query.data.to
                      ? lte(
                          schema.observations.sourceTimestamp,
                          new Date(query.data.to),
                        )
                      : undefined,
                  ),
                )
                .orderBy(desc(schema.observations.sourceTimestamp))
                .limit(query.data.limit);
              return rows;
            },
          );
          if (!result) {
            return sendError(reply, 404, "connection_not_found");
          }
          return observationListResponseSchema.parse({
            observations: result.map((row) => ({
              id: row.id,
              metricKey: row.metricKey,
              sourceTimestamp: row.sourceTimestamp.toISOString(),
              value: row.value,
              dimensions: row.dimensions as Record<string, string>,
              ingestedAt: row.ingestedAt.toISOString(),
            })),
          });
        },
      );

      done();
    },
    { prefix: "/v1" },
  );
}
