import type { FastifyInstance } from "fastify";

import { adminWorkspaceListResponseSchema } from "@netrics/contracts";
import { adminListWorkspaces, type Database } from "@netrics/database";

import type { AuthService } from "../auth/index.js";
import { routeSchema } from "./openapi.js";
import { createRequireInstallationAdmin } from "./principal.js";

export interface AdminRouteDeps {
  authService: AuthService;
  db: Database;
}

/**
 * Installation admin API (ADR 0009). The same endpoints serve self-hosters'
 * instance administrators and the hosted operations console (service
 * tokens); nothing here bypasses the core's authorization.
 */
export function registerAdminRoutes(
  app: FastifyInstance,
  deps: AdminRouteDeps,
): void {
  void app.register(
    (scope, _opts, done) => {
      scope.addHook(
        "onRequest",
        createRequireInstallationAdmin({
          authService: deps.authService,
          db: deps.db,
          scope: "installation:workspaces:read",
        }),
      );

      scope.get(
        "/workspaces",
        {
          schema: routeSchema({
            summary: "List all workspaces of the installation",
            tags: ["admin"],
            response: adminWorkspaceListResponseSchema,
            errors: [403],
            admin: true,
          }),
        },
        async () => {
          const workspaces = await adminListWorkspaces(deps.db);
          return adminWorkspaceListResponseSchema.parse({
            workspaces: workspaces.map((workspace) => ({
              id: workspace.id,
              name: workspace.name,
              createdAt: workspace.createdAt.toISOString(),
              memberCount: workspace.memberCount,
            })),
          });
        },
      );

      done();
    },
    { prefix: "/v1/admin" },
  );
}
