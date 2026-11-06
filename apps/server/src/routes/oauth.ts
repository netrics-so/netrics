import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  oauthCallbackRequestSchema,
  oauthCallbackResponseSchema,
  startOAuthAuthorizationRequestSchema,
  startOAuthAuthorizationResponseSchema,
} from "@netrics/contracts";
import type { Database } from "@netrics/database";

import type { AuthService } from "../auth/index.js";
import type { OAuthFlow } from "../oauth/flow.js";
import { parseBody, resolveAccess, sendError } from "./access.js";
import { routeSchema } from "./openapi.js";
import { createRequireSession } from "./session.js";

// HTTP layer of the OAuth authorization flow (ADR 0012). The work happens in
// ../oauth/flow.ts. Neither route echoes the state, code or any token.

export interface OAuthRouteDeps {
  authService: AuthService;
  db: Database;
  flow: OAuthFlow;
}

const providerParamsSchema = z.object({
  provider: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});

export function registerOAuthRoutes(
  app: FastifyInstance,
  deps: OAuthRouteDeps,
): void {
  const requireSession = createRequireSession(deps.authService);

  void app.register(
    (scope, _opts, done) => {
      scope.addHook("onRequest", requireSession);

      scope.post(
        "/workspaces/:workspaceId/oauth/authorizations",
        {
          schema: routeSchema({
            summary:
              "Start an OAuth authorization (new connection or reauthorization)",
            tags: ["connections"],
            body: startOAuthAuthorizationRequestSchema,
            response: startOAuthAuthorizationResponseSchema,
            errors: [403, 404],
          }),
        },
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) {
            return;
          }
          const body = parseBody(
            startOAuthAuthorizationRequestSchema,
            request,
            reply,
          );
          if (!body) {
            return;
          }
          const result = await deps.flow.start(access, body);
          if (!result.ok) {
            return sendError(reply, result.status, result.error);
          }
          reply.header("cache-control", "no-store");
          return startOAuthAuthorizationResponseSchema.parse(result.value);
        },
      );

      // Called by the web app's /oauth/:provider/callback route with the
      // provider's redirect query and the user's session cookie. Answers 200
      // with the app path to redirect to, also when the flow was refused.
      scope.post(
        "/oauth/:provider/callback",
        {
          schema: routeSchema({
            summary: "Complete an OAuth authorization (web callback relay)",
            tags: ["connections"],
            body: oauthCallbackRequestSchema,
            response: oauthCallbackResponseSchema,
            errors: [404],
          }),
        },
        async (request, reply) => {
          const params = providerParamsSchema.safeParse(request.params);
          if (!params.success) {
            return sendError(reply, 404, "not_found");
          }
          const body = parseBody(oauthCallbackRequestSchema, request, reply);
          if (!body) {
            return;
          }
          const result = await deps.flow.callback(
            request.sessionIdentity!.domainUserId,
            params.data.provider,
            body,
          );
          reply.header("cache-control", "no-store");
          return oauthCallbackResponseSchema.parse(result);
        },
      );

      done();
    },
    { prefix: "/v1" },
  );
}
