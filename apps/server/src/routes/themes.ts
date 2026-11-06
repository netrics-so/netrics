import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  createThemeRequestSchema,
  themeErrorResponseSchema,
  themeListResponseSchema,
  themeResponseSchema,
  updateThemeRequestSchema,
} from "@netrics/contracts";
import type { Database } from "@netrics/database";
import { can, type WorkspaceAction } from "@netrics/domain";

import type { AuthService } from "../auth/index.js";
import { createThemeService, type ThemeResult } from "../themes/service.js";
import {
  parseBody,
  resolveAccess,
  sendError,
  type WorkspaceAccess,
} from "./access.js";
import { routeSchema } from "./openapi.js";
import { createRequireSession } from "./session.js";

// HTTP layer for dashboard themes (#216); the work happens in ../themes.
// Reading needs dashboards:view, changing dashboards:update (ADR 0015).

export interface ThemeRouteDeps {
  authService: AuthService;
  db: Database;
}

const themeParamsSchema = z.object({ themeId: z.uuid() });

const themeErrors = {
  400: themeErrorResponseSchema,
  409: themeErrorResponseSchema,
};

function unwrap<T>(result: ThemeResult<T>, reply: FastifyReply): T | null {
  if (result.ok) {
    return result.value;
  }
  const { ok: _ok, status, ...body } = result;
  void reply.code(status).send(themeErrorResponseSchema.parse(body));
  return null;
}

export function registerThemeRoutes(
  app: FastifyInstance,
  deps: ThemeRouteDeps,
): void {
  const requireSession = createRequireSession(deps.authService);
  const themes = createThemeService(deps);

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

  function themeId(request: FastifyRequest, reply: FastifyReply) {
    const params = themeParamsSchema.safeParse(request.params);
    if (!params.success) {
      sendError(reply, 404, "theme_not_found");
      return null;
    }
    return params.data.themeId;
  }

  void app.register(
    (scope, _opts, done) => {
      scope.addHook("onRequest", requireSession);

      scope.get(
        "/workspaces/:workspaceId/themes",
        {
          schema: routeSchema({
            summary: "List the built-in and the workspace's custom themes",
            tags: ["themes"],
            response: themeListResponseSchema,
            errors: [403, 404],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "dashboards:view");
          if (!access) {
            return;
          }
          return themeListResponseSchema.parse(await themes.list(access));
        },
      );

      scope.post(
        "/workspaces/:workspaceId/themes",
        {
          schema: routeSchema({
            summary:
              "Create a custom theme from a built-in (400 contrast_too_low below 3:1)",
            tags: ["themes"],
            body: createThemeRequestSchema,
            response: themeResponseSchema,
            errors: [403, 404, 409],
            errorSchemas: themeErrors,
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "dashboards:update");
          if (!access) {
            return;
          }
          const body = parseBody(createThemeRequestSchema, request, reply);
          if (!body) {
            return;
          }
          const theme = unwrap(await themes.create(access, body), reply);
          if (!theme) {
            return;
          }
          return themeResponseSchema.parse({ theme });
        },
      );

      scope.get(
        "/workspaces/:workspaceId/themes/:themeId",
        {
          schema: routeSchema({
            summary: "Get a custom theme",
            tags: ["themes"],
            response: themeResponseSchema,
            errors: [403, 404],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "dashboards:view");
          const id = access && themeId(request, reply);
          if (!access || !id) {
            return;
          }
          const theme = unwrap(await themes.get(access, id), reply);
          if (!theme) {
            return;
          }
          return themeResponseSchema.parse({ theme });
        },
      );

      scope.put(
        "/workspaces/:workspaceId/themes/:themeId",
        {
          schema: routeSchema({
            summary:
              "Replace a custom theme's name and tokens (409 when the version is stale)",
            tags: ["themes"],
            body: updateThemeRequestSchema,
            response: themeResponseSchema,
            errors: [403, 404, 409],
            errorSchemas: themeErrors,
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "dashboards:update");
          const id = access && themeId(request, reply);
          if (!access || !id) {
            return;
          }
          const body = parseBody(updateThemeRequestSchema, request, reply);
          if (!body) {
            return;
          }
          const theme = unwrap(await themes.update(access, id, body), reply);
          if (!theme) {
            return;
          }
          return themeResponseSchema.parse({ theme });
        },
      );

      scope.delete(
        "/workspaces/:workspaceId/themes/:themeId",
        {
          schema: routeSchema({
            summary:
              "Delete a custom theme (409 theme_in_use with the dashboards that show it)",
            tags: ["themes"],
            errors: [403, 404, 409],
            errorSchemas: themeErrors,
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "dashboards:update");
          const id = access && themeId(request, reply);
          if (!access || !id) {
            return;
          }
          const result = await themes.remove(access, id);
          if (!result.ok) {
            unwrap(result, reply);
            return;
          }
          return reply.code(204).send();
        },
      );

      done();
    },
    { prefix: "/v1" },
  );
}
