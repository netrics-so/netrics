import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  appStoreAnalyticsStatusResponseSchema,
  connectionDetailResponseSchema,
  connectionListResponseSchema,
  connectionPreviewResponseSchema,
  connectionResourcesResponseSchema,
  connectionResponseSchema,
  connectorListResponseSchema,
  createConnectionRequestSchema,
  deleteConnectionResponseSchema,
  enableAppStoreAnalyticsRequestSchema,
  enableAppStoreAnalyticsResponseSchema,
  enqueueSyncResponseSchema,
  observationListQuerySchema,
  observationListResponseSchema,
  previewConnectionRequestSchema,
  updateConnectionRequestSchema,
} from "@netrics/contracts";
import type { ConnectorRegistry } from "@netrics/connector-runtime";
import type { Database } from "@netrics/database";
import { can } from "@netrics/domain";

import type { AuthService } from "../auth/index.js";
import {
  createConnectionService,
  type Result,
} from "../connections/service.js";
import type { CredentialKeyring } from "../credentials.js";
import type { OAuthProviders } from "../oauth/config.js";
import type { OAuthTokenService } from "../oauth/tokens.js";
import type { SignedKeyProviders } from "../signed-keys/registry.js";
import { parseBody, resolveAccess, sendError } from "./access.js";
import { routeSchema } from "./openapi.js";
import { createRequireSession } from "./session.js";

// HTTP layer for connections: authentication, authorization, request parsing
// and response shapes. The work happens in ../connections/service.ts.

export interface ConnectionRouteDeps {
  authService: AuthService;
  db: Database;
  registry: ConnectorRegistry;
  credentialKeyring: CredentialKeyring;
  oauthProviders: OAuthProviders;
  oauthTokens?: OAuthTokenService;
  signedKeys?: SignedKeyProviders;
}

const connectionParamsSchema = z.object({ connectionId: z.uuid() });

/** Sends the failure and returns null, or returns the value. */
function unwrap<T>(result: Result<T>, reply: FastifyReply): T | null {
  if (!result.ok) {
    sendError(reply, result.status, result.error);
    return null;
  }
  return result.value;
}

export function registerConnectionRoutes(
  app: FastifyInstance,
  deps: ConnectionRouteDeps,
): void {
  const requireSession = createRequireSession(deps.authService);
  const connections = createConnectionService(deps);

  void app.register(
    (scope, _opts, done) => {
      // onRequest: authentication precedes body validation.
      scope.addHook("onRequest", requireSession);

      // Installation-level catalog, served from the deployed bundle (the
      // registry is the source of truth; the connectors table is its
      // persistence mirror).
      scope.get(
        "/connectors",
        {
          schema: routeSchema({
            summary: "Connector catalog of this installation",
            tags: ["connections"],
            response: connectorListResponseSchema,
          }),
        },
        async () =>
          connectorListResponseSchema.parse({
            connectors: connections.listConnectors(),
          }),
      );

      scope.post(
        "/workspaces/:workspaceId/connections",
        {
          schema: routeSchema({
            summary: "Create a connection",
            tags: ["connections"],
            body: createConnectionRequestSchema,
            response: connectionResponseSchema,
            errors: [403, 404],
          }),
        },
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
          const connection = unwrap(
            await connections.create(access, body),
            reply,
          );
          if (!connection) {
            return;
          }
          return connectionResponseSchema.parse({ connection });
        },
      );

      scope.post(
        "/workspaces/:workspaceId/connections/preview",
        {
          schema: routeSchema({
            summary: "Check credentials and discover resources without saving",
            tags: ["connections"],
            body: previewConnectionRequestSchema,
            response: connectionPreviewResponseSchema,
            errors: [403, 404],
          }),
        },
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
          const preview = unwrap(await connections.preview(body), reply);
          if (!preview) {
            return;
          }
          return connectionPreviewResponseSchema.parse(preview);
        },
      );

      scope.get(
        "/workspaces/:workspaceId/connections",
        {
          schema: routeSchema({
            summary: "List connections",
            tags: ["connections"],
            response: connectionListResponseSchema,
            errors: [403, 404],
          }),
        },
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) {
            return;
          }
          if (!can(access.role, "connections:view")) {
            return sendError(reply, 403, "forbidden");
          }
          return connectionListResponseSchema.parse({
            connections: await connections.list(access),
          });
        },
      );

      scope.get(
        "/workspaces/:workspaceId/connections/:connectionId",
        {
          schema: routeSchema({
            summary: "Get a connection with sync history",
            tags: ["connections"],
            response: connectionDetailResponseSchema,
            errors: [403, 404],
          }),
        },
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
          const detail = unwrap(
            await connections.get(access, params.data.connectionId),
            reply,
          );
          if (!detail) {
            return;
          }
          return connectionDetailResponseSchema.parse(detail);
        },
      );

      // Discovery for an existing OAuth connection (ADR 0012): the
      // connector lists what the linked account can read, with an access
      // token from the token service. A signed-key connection (ADR 0014)
      // gets a freshly signed token from its stored key. Needs
      // connections:update, because it
      // serves finishing setup and changing the chosen resource.
      scope.get(
        "/workspaces/:workspaceId/connections/:connectionId/resources",
        {
          schema: routeSchema({
            summary: "Discover resources of an OAuth or signed-key connection",
            tags: ["connections"],
            response: connectionResourcesResponseSchema,
            errors: [400, 403, 404],
          }),
        },
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
          const resources = unwrap(
            await connections.discoverResources(
              access,
              params.data.connectionId,
            ),
            reply,
          );
          if (!resources) {
            return;
          }
          reply.header("cache-control", "no-store");
          return connectionResourcesResponseSchema.parse(resources);
        },
      );

      // App Store analytics (ADR 0014, #174): the status per app, read with
      // the connection's stored key, and the one-time enablement with a
      // temporary Admin key that is used in memory only. Both need
      // connections:update; the body is never logged.
      scope.get(
        "/workspaces/:workspaceId/connections/:connectionId/app-store-analytics",
        {
          schema: routeSchema({
            summary: "App Store analytics status per app",
            tags: ["connections"],
            response: appStoreAnalyticsStatusResponseSchema,
            errors: [400, 403, 404],
          }),
        },
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
          const status = unwrap(
            await connections.appStoreAnalytics(
              access,
              params.data.connectionId,
            ),
            reply,
          );
          if (!status) {
            return;
          }
          reply.header("cache-control", "no-store");
          return appStoreAnalyticsStatusResponseSchema.parse(status);
        },
      );

      scope.post(
        "/workspaces/:workspaceId/connections/:connectionId/app-store-analytics",
        {
          schema: routeSchema({
            summary:
              "Enable App Store analytics with a temporary Admin key (not stored)",
            tags: ["connections"],
            body: enableAppStoreAnalyticsRequestSchema,
            response: enableAppStoreAnalyticsResponseSchema,
            errors: [400, 403, 404],
          }),
        },
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
          const body = parseBody(
            enableAppStoreAnalyticsRequestSchema,
            request,
            reply,
          );
          if (!body) {
            return;
          }
          const enabled = unwrap(
            await connections.enableAppStoreAnalytics(
              access,
              params.data.connectionId,
              body,
            ),
            reply,
          );
          if (!enabled) {
            return;
          }
          reply.header("cache-control", "no-store");
          return enableAppStoreAnalyticsResponseSchema.parse(enabled);
        },
      );

      scope.patch(
        "/workspaces/:workspaceId/connections/:connectionId",
        {
          schema: routeSchema({
            summary: "Update a connection",
            tags: ["connections"],
            body: updateConnectionRequestSchema,
            response: connectionResponseSchema,
            errors: [403, 404],
          }),
        },
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
          const connection = unwrap(
            await connections.update(access, params.data.connectionId, body),
            reply,
          );
          if (!connection) {
            return;
          }
          return connectionResponseSchema.parse({ connection });
        },
      );

      scope.delete(
        "/workspaces/:workspaceId/connections/:connectionId",
        {
          schema: routeSchema({
            summary: "Delete a connection",
            tags: ["connections"],
            response: deleteConnectionResponseSchema,
            errors: [403, 404],
          }),
        },
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
          const result = await connections.remove(
            access,
            params.data.connectionId,
          );
          if (!result.ok) {
            return sendError(reply, result.status, result.error);
          }
          return deleteConnectionResponseSchema.parse(result.value);
        },
      );

      scope.post(
        "/workspaces/:workspaceId/connections/:connectionId/sync",
        {
          schema: routeSchema({
            summary: "Request a sync",
            tags: ["connections"],
            response: enqueueSyncResponseSchema,
            errors: [400, 403, 404],
          }),
        },
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
          const jobId = unwrap(
            await connections.requestSync(access, params.data.connectionId),
            reply,
          );
          if (!jobId) {
            return;
          }
          return enqueueSyncResponseSchema.parse({ jobId });
        },
      );

      scope.get(
        "/workspaces/:workspaceId/connections/:connectionId/observations",
        {
          schema: routeSchema({
            summary: "List collected observations",
            tags: ["connections"],
            querystring: observationListQuerySchema,
            response: observationListResponseSchema,
            errors: [403, 404],
          }),
        },
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
          const query = observationListQuerySchema.safeParse(request.query);
          if (!query.success) {
            return sendError(reply, 400, "invalid_request");
          }
          const observations = unwrap(
            await connections.listObservations(
              access,
              params.data.connectionId,
              query.data,
            ),
            reply,
          );
          if (!observations) {
            return;
          }
          return observationListResponseSchema.parse({ observations });
        },
      );

      done();
    },
    { prefix: "/v1" },
  );
}
