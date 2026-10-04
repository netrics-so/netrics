import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  createDashboardFromTemplateRequestSchema,
  dashboardResponseSchema,
  dashboardTemplateOptionsResponseSchema,
  imageResponseSchema,
  resourceIconListResponseSchema,
  useResourceIconRequestSchema,
} from "@netrics/contracts";
import type { ConnectorRegistry } from "@netrics/connector-runtime";
import type { Database, ImageQuota } from "@netrics/database";
import { can, type WorkspaceAction } from "@netrics/domain";

import type { AuthService } from "../auth/index.js";
import { createConnectionService } from "../connections/service.js";
import type { CredentialKeyring } from "../credentials.js";
import { createDashboardService } from "../dashboards/service.js";
import { createTemplateService } from "../dashboards/template-service.js";
import { createResourceIconService } from "../images/resource-icons.js";
import type { OAuthProviders } from "../oauth/config.js";
import type { OAuthTokenService } from "../oauth/tokens.js";
import type { SignedKeyProviders } from "../signed-keys/registry.js";
import {
  parseBody,
  resolveAccess,
  sendError,
  type WorkspaceAccess,
} from "./access.js";
import { routeSchema } from "./openapi.js";
import { createRequireSession } from "./session.js";

// HTTP layer for dashboard templates and resource icons (#226, ADR 0015
// sections 5 and 9). Icons are fetched on the server by the connector,
// through its allowlisted egress; the browser only ever receives the
// stored workspace image.

export interface TemplateRouteDeps {
  authService: AuthService;
  db: Database;
  registry: ConnectorRegistry;
  credentialKeyring: CredentialKeyring;
  oauthProviders: OAuthProviders;
  oauthTokens?: OAuthTokenService;
  signedKeys?: SignedKeyProviders;
  quota: ImageQuota;
}

export function registerTemplateRoutes(
  app: FastifyInstance,
  deps: TemplateRouteDeps,
): void {
  const requireSession = createRequireSession(deps.authService);
  const connections = createConnectionService(deps);
  const icons = createResourceIconService({
    db: deps.db,
    quota: deps.quota,
    registry: deps.registry,
    callConnection: (actor, connectionId, call) =>
      connections.callConnection(actor, connectionId, call),
  });
  const templates = createTemplateService({
    db: deps.db,
    registry: deps.registry,
    dashboards: createDashboardService(deps),
    icons,
    hasReviewsKey: (actor, connectionId) =>
      connections.hasReviewsKey(actor, connectionId),
  });

  async function authorize(
    request: FastifyRequest,
    reply: FastifyReply,
    action: WorkspaceAction,
  ): Promise<WorkspaceAccess | null> {
    const access = await resolveAccess(deps.db, request, reply);
    if (!access) {
      return null;
    }
    if (!can(access.role, action)) {
      sendError(reply, 403, "forbidden");
      return null;
    }
    return access;
  }

  void app.register(
    (scope, _opts, done) => {
      scope.addHook("onRequest", requireSession);

      scope.get(
        "/workspaces/:workspaceId/resource-icons",
        {
          schema: routeSchema({
            summary:
              "Resources whose icon can be used as an image (e.g. App Store apps), with the stored icon if any",
            tags: ["images"],
            response: resourceIconListResponseSchema,
            errors: [403, 404],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "dashboards:view");
          if (!access) {
            return;
          }
          return resourceIconListResponseSchema.parse({
            resources: await icons.list(access),
          });
        },
      );

      scope.post(
        "/workspaces/:workspaceId/resource-icons",
        {
          schema: routeSchema({
            summary:
              "Use a resource's icon: fetched by its connector (at most daily) and stored as a workspace image",
            tags: ["images"],
            body: useResourceIconRequestSchema,
            response: imageResponseSchema,
            errors: [403, 404, 409, 502],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "dashboards:update");
          if (!access) {
            return;
          }
          const body = parseBody(useResourceIconRequestSchema, request, reply);
          if (!body) {
            return;
          }
          const result = await icons.use(
            access,
            body.connectionId,
            body.resourceId,
          );
          if (!result.ok) {
            return sendError(reply, result.status, result.error);
          }
          return imageResponseSchema.parse({ image: result.value });
        },
      );

      scope.get(
        "/workspaces/:workspaceId/dashboard-templates",
        {
          schema: routeSchema({
            summary:
              "What the dashboard templates (Overview, Brand) can be built from",
            tags: ["dashboards"],
            response: dashboardTemplateOptionsResponseSchema,
            errors: [403, 404],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "dashboards:create");
          if (!access) {
            return;
          }
          return dashboardTemplateOptionsResponseSchema.parse(
            await templates.options(access),
          );
        },
      );

      scope.post(
        "/workspaces/:workspaceId/dashboard-templates",
        {
          schema: routeSchema({
            summary:
              "Create a dashboard from a template: Overview of all connections, or Brand for one resource",
            tags: ["dashboards"],
            body: createDashboardFromTemplateRequestSchema,
            response: dashboardResponseSchema,
            errors: [403, 404, 409],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "dashboards:create");
          if (!access) {
            return;
          }
          const body = parseBody(
            createDashboardFromTemplateRequestSchema,
            request,
            reply,
          );
          if (!body) {
            return;
          }
          const result = await templates.create(access, body);
          if (!result.ok) {
            return sendError(reply, result.status, result.error);
          }
          return dashboardResponseSchema.parse({ dashboard: result.value });
        },
      );

      done();
    },
    { prefix: "/v1" },
  );
}
