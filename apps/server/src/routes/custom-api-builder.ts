import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  createCustomApiDraftRequestSchema,
  customApiDraftResponseSchema,
  customApiErrorResponseSchema,
  customApiTestRequestSchema,
  customApiTestResponseSchema,
  promoteCustomApiDraftRequestSchema,
  promoteCustomApiDraftResponseSchema,
  updateCustomApiDraftRequestSchema,
} from "@netrics/contracts";
import type { ExecuteOptions } from "@netrics/connector-runtime";
import type { Database } from "@netrics/database";
import { can, type WorkspaceAction } from "@netrics/domain";

import type { AuthService } from "../auth/index.js";
import type { CredentialKeyring } from "../credentials.js";
import {
  createCustomApiDraftService,
  type DraftResult,
} from "../custom-api/drafts.js";
import { createCustomApiTestRequestService } from "../custom-api/test-request.js";
import type { CustomApiInstanceConfig } from "../env.js";
import type { OAuthTokenService } from "../oauth/tokens.js";
import {
  parseBody,
  resolveAccess,
  sendError,
  type WorkspaceAccess,
} from "./access.js";
import { routeSchema } from "./openapi.js";
import { createRequireSession } from "./session.js";

// HTTP layer of the custom API builder (milestone 13, #806): draft
// connections that hold the builder's secrets on the server. Every route
// needs connections:create.

export interface CustomApiBuilderRouteDeps {
  authService: AuthService;
  db: Database;
  limits: CustomApiInstanceConfig;
  credentialKeyring: CredentialKeyring;
  /** Self-host only (NETRICS_CUSTOM_API_PRIVATE_HOSTS). */
  privateHosts: readonly string[];
  /** Tests only: egress options of the test request (e.g. a local fixture). */
  executeOptions?: ExecuteOptions;
  /** Clock of the draft touches and the test rate window; tests pin it. */
  now?: () => Date;
  /** Custom OAuth tokens and revocation of OAuth drafts (#805). */
  oauthTokens?: OAuthTokenService;
}

/** A test request carries one unsaved definition. */
const TEST_BODY_LIMIT = 512 * 1024;

const draftParamsSchema = z.object({ draftId: z.uuid() });

const customApiErrors = {
  400: customApiErrorResponseSchema,
  404: customApiErrorResponseSchema,
  409: customApiErrorResponseSchema,
};

const TAGS = ["custom-api"];
const BASE = "/workspaces/:workspaceId/custom-api/drafts";

function unwrap<T>(result: DraftResult<T>, reply: FastifyReply): T | null {
  if (result.ok) return result.value;
  void reply
    .code(result.status)
    .send(customApiErrorResponseSchema.parse({ error: result.error }));
  return null;
}

export function registerCustomApiBuilderRoutes(
  app: FastifyInstance,
  deps: CustomApiBuilderRouteDeps,
): void {
  const requireSession = createRequireSession(deps.authService);
  const drafts = createCustomApiDraftService(deps);
  const tests = createCustomApiTestRequestService(deps);

  async function authorize(
    request: FastifyRequest,
    reply: FastifyReply,
    action: WorkspaceAction,
  ): Promise<WorkspaceAccess | null> {
    const access = await resolveAccess(deps.db, request, reply);
    if (!access) return null;
    if (!can(access.role, action)) {
      sendError(reply, 403, "forbidden");
      return null;
    }
    return access;
  }

  function draftId(request: FastifyRequest, reply: FastifyReply) {
    const params = draftParamsSchema.safeParse(request.params);
    if (!params.success) {
      sendError(reply, 404, "custom_api_draft_not_found");
      return null;
    }
    return params.data.draftId;
  }

  void app.register(
    (scope, _opts, done) => {
      scope.addHook("onRequest", requireSession);

      scope.post(
        BASE,
        {
          schema: routeSchema({
            summary:
              "Start a draft connection for the custom API builder: it holds the builder's secrets on the server, is never synced and is deleted 24 hours after it was last used (409 custom_api_draft_limit beyond 10 open drafts)",
            tags: TAGS,
            body: createCustomApiDraftRequestSchema,
            response: customApiDraftResponseSchema,
            responseStatus: 201,
            errors: [403, 404, 409],
            errorSchemas: customApiErrors,
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "connections:create");
          if (!access) return;
          const body = parseBody(
            createCustomApiDraftRequestSchema,
            request,
            reply,
          );
          if (!body) return;
          const draft = unwrap(await drafts.create(access, body), reply);
          if (!draft) return;
          return reply
            .code(201)
            .send(customApiDraftResponseSchema.parse({ draft }));
        },
      );

      scope.put(
        `${BASE}/:draftId`,
        {
          schema: routeSchema({
            summary:
              "Store the builder's definition, environment, connection values and (optionally) secrets on a draft. Secrets are bound to the hosts they were entered for: without new secrets, stored ones are forgotten when those hosts change. The response names stored secrets, never their values",
            tags: TAGS,
            body: updateCustomApiDraftRequestSchema,
            response: customApiDraftResponseSchema,
            errors: [403, 404, 409],
            errorSchemas: customApiErrors,
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "connections:create");
          const id = access && draftId(request, reply);
          if (!access || !id) return;
          const body = parseBody(
            updateCustomApiDraftRequestSchema,
            request,
            reply,
          );
          if (!body) return;
          const draft = unwrap(await drafts.update(access, id, body), reply);
          if (!draft) return;
          return customApiDraftResponseSchema.parse({ draft });
        },
      );

      scope.delete(
        `${BASE}/:draftId`,
        {
          schema: routeSchema({
            summary: "Delete a draft connection and its secrets",
            tags: TAGS,
            errors: [403, 404],
            errorSchemas: customApiErrors,
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "connections:create");
          const id = access && draftId(request, reply);
          if (!access || !id) return;
          const removed = await drafts.remove(access, id);
          if (!removed.ok) return unwrap(removed, reply);
          return reply.code(204).send();
        },
      );

      scope.post(
        `${BASE}/:draftId/promote`,
        {
          schema: routeSchema({
            summary:
              "Turn a draft into a scheduled connection pinned to a saved definition version, keeping its secrets (409 custom_api_credentials_host_changed when that version sends them to other hosts)",
            tags: TAGS,
            body: promoteCustomApiDraftRequestSchema,
            response: promoteCustomApiDraftResponseSchema,
            errors: [403, 404, 409],
            errorSchemas: customApiErrors,
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "connections:create");
          const id = access && draftId(request, reply);
          if (!access || !id) return;
          const body = parseBody(
            promoteCustomApiDraftRequestSchema,
            request,
            reply,
          );
          if (!body) return;
          const promoted = unwrap(
            await drafts.promote(access, id, body),
            reply,
          );
          if (!promoted) return;
          return promoteCustomApiDraftResponseSchema.parse(promoted);
        },
      );

      scope.post(
        `${BASE}/:draftId/test`,
        {
          bodyLimit: TEST_BODY_LIMIT,
          schema: routeSchema({
            summary:
              "Run one stream of the builder's unsaved definition against the draft's secrets (at most 5 pages, 1,000 records, 60 s) and answer the redacted, bounded first response, record arrays, field suggestions, mapped preview rows and a request log. The definition is stored on the draft first. At most 30 test requests per workspace and minute (429 custom_api_test_rate_limited with Retry-After); 409 custom_api_credentials_host_changed without any request when the secrets were entered for other hosts",
            tags: TAGS,
            body: customApiTestRequestSchema,
            response: customApiTestResponseSchema,
            errors: [403, 404, 409, 429],
            errorSchemas: {
              ...customApiErrors,
              429: customApiErrorResponseSchema,
            },
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "connections:create");
          const id = access && draftId(request, reply);
          if (!access || !id) return;
          const body = parseBody(customApiTestRequestSchema, request, reply);
          if (!body) return;
          const result = await tests.run(access, id, body, (fields) =>
            request.log.info(fields, "custom api test request"),
          );
          if (result.ok) return customApiTestResponseSchema.parse(result.value);
          if (result.status === 429)
            void reply.header("retry-after", String(result.retryAfterSeconds));
          return reply
            .code(result.status)
            .send(customApiErrorResponseSchema.parse({ error: result.error }));
        },
      );

      done();
    },
    { prefix: "/v1" },
  );
}
