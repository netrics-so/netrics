import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  connectionResponseSchema,
  createCustomApiConnectionRequestSchema,
  createCustomApiDefinitionRequestSchema,
  createCustomApiDefinitionVersionRequestSchema,
  customApiDefinitionListQuerySchema,
  customApiDefinitionListResponseSchema,
  customApiDefinitionResponseSchema,
  customApiErrorResponseSchema,
  updateCustomApiDefinitionRequestSchema,
} from "@netrics/contracts";
import type {
  ConnectorRegistry,
  ExecuteOptions,
} from "@netrics/connector-runtime";
import type { Database } from "@netrics/database";
import { can, type WorkspaceAction } from "@netrics/domain";

import type { AuthService } from "../auth/index.js";
import {
  createCustomApiService,
  type CustomApiResult,
} from "../custom-api/service.js";
import { createCustomApiConnectionService } from "../custom-api/connections.js";
import type { CredentialKeyring } from "../credentials.js";
import type { CustomApiInstanceConfig } from "../env.js";
import {
  parseBody,
  resolveAccess,
  sendError,
  type WorkspaceAccess,
} from "./access.js";
import { routeSchema } from "./openapi.js";
import { createRequireSession } from "./session.js";

// HTTP layer for custom API definitions (milestone 13, #803); the work
// happens in ../custom-api. Reading needs connections:view, creating
// connections:create, new versions, project changes and archiving
// connections:update.

export interface CustomApiRouteDeps {
  authService: AuthService;
  db: Database;
  limits: CustomApiInstanceConfig;
  registry: ConnectorRegistry;
  credentialKeyring: CredentialKeyring;
  /** Self-host only (NETRICS_CUSTOM_API_PRIVATE_HOSTS). */
  privateHosts: readonly string[];
  /** Tests only: options for every connector call (e.g. local egress). */
  executeOptions?: ExecuteOptions;
}

const definitionParamsSchema = z.object({ definitionId: z.uuid() });

const customApiErrors = {
  400: customApiErrorResponseSchema,
  404: customApiErrorResponseSchema,
  409: customApiErrorResponseSchema,
};

const TAGS = ["custom-api"];
const BASE = "/workspaces/:workspaceId/custom-api/definitions";

function unwrap<T>(result: CustomApiResult<T>, reply: FastifyReply): T | null {
  if (result.ok) {
    return result.value;
  }
  const { ok: _ok, status, ...body } = result;
  void reply.code(status).send(customApiErrorResponseSchema.parse(body));
  return null;
}

export function registerCustomApiRoutes(
  app: FastifyInstance,
  deps: CustomApiRouteDeps,
): void {
  const requireSession = createRequireSession(deps.authService);
  const definitions = createCustomApiService(deps);
  const connections = createCustomApiConnectionService(deps);

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

  function definitionId(request: FastifyRequest, reply: FastifyReply) {
    const params = definitionParamsSchema.safeParse(request.params);
    if (!params.success) {
      sendError(reply, 404, "custom_api_definition_not_found");
      return null;
    }
    return params.data.definitionId;
  }

  void app.register(
    (scope, _opts, done) => {
      scope.addHook("onRequest", requireSession);

      scope.get(
        BASE,
        {
          schema: routeSchema({
            summary:
              "List the workspace's custom API definitions (archived ones with includeArchived=true)",
            tags: TAGS,
            querystring: customApiDefinitionListQuerySchema,
            response: customApiDefinitionListResponseSchema,
            errors: [403, 404],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "connections:view");
          if (!access) {
            return;
          }
          const query = customApiDefinitionListQuerySchema.safeParse(
            request.query,
          );
          if (!query.success) {
            sendError(reply, 400, "invalid_request");
            return;
          }
          const list = unwrap(
            await definitions.list(access, query.data),
            reply,
          );
          if (!list) {
            return;
          }
          return customApiDefinitionListResponseSchema.parse(list);
        },
      );

      scope.post(
        BASE,
        {
          schema: routeSchema({
            summary:
              "Create a custom API definition (version 1). The document is a customApiDefinitionSchema; 400 custom_api_definition_invalid answers its issues",
            tags: TAGS,
            body: createCustomApiDefinitionRequestSchema,
            response: customApiDefinitionResponseSchema,
            responseStatus: 201,
            errors: [403, 404, 409],
            errorSchemas: customApiErrors,
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "connections:create");
          if (!access) {
            return;
          }
          const body = parseBody(
            createCustomApiDefinitionRequestSchema,
            request,
            reply,
          );
          if (!body) {
            return;
          }
          const created = unwrap(await definitions.create(access, body), reply);
          if (!created) {
            return;
          }
          return reply
            .code(201)
            .send(customApiDefinitionResponseSchema.parse(created));
        },
      );

      scope.get(
        `${BASE}/:definitionId`,
        {
          schema: routeSchema({
            summary:
              "Get a custom API definition with its current version's document",
            tags: TAGS,
            response: customApiDefinitionResponseSchema,
            errors: [403, 404],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "connections:view");
          const id = access && definitionId(request, reply);
          if (!access || !id) {
            return;
          }
          const found = unwrap(await definitions.get(access, id), reply);
          if (!found) {
            return;
          }
          return customApiDefinitionResponseSchema.parse(found);
        },
      );

      scope.post(
        `${BASE}/:definitionId/versions`,
        {
          schema: routeSchema({
            summary:
              "Save a new version of a custom API definition (409 custom_api_definition_stale when baseVersion is not the current version)",
            tags: TAGS,
            body: createCustomApiDefinitionVersionRequestSchema,
            response: customApiDefinitionResponseSchema,
            responseStatus: 201,
            errors: [403, 404, 409],
            errorSchemas: customApiErrors,
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "connections:update");
          const id = access && definitionId(request, reply);
          if (!access || !id) {
            return;
          }
          const body = parseBody(
            createCustomApiDefinitionVersionRequestSchema,
            request,
            reply,
          );
          if (!body) {
            return;
          }
          const created = unwrap(
            await definitions.createVersion(access, id, body),
            reply,
          );
          if (!created) {
            return;
          }
          return reply
            .code(201)
            .send(customApiDefinitionResponseSchema.parse(created));
        },
      );

      scope.patch(
        `${BASE}/:definitionId`,
        {
          schema: routeSchema({
            summary: "Move a custom API definition to a project (or none)",
            tags: TAGS,
            body: updateCustomApiDefinitionRequestSchema,
            response: customApiDefinitionResponseSchema,
            errors: [403, 404, 409],
            errorSchemas: customApiErrors,
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "connections:update");
          const id = access && definitionId(request, reply);
          if (!access || !id) {
            return;
          }
          const body = parseBody(
            updateCustomApiDefinitionRequestSchema,
            request,
            reply,
          );
          if (!body) {
            return;
          }
          const updated = unwrap(
            await definitions.update(access, id, body),
            reply,
          );
          if (!updated) {
            return;
          }
          return customApiDefinitionResponseSchema.parse(updated);
        },
      );

      scope.post(
        `${BASE}/:definitionId/archive`,
        {
          schema: routeSchema({
            summary:
              "Archive a custom API definition: hidden from the default list, no new versions or connections",
            tags: TAGS,
            response: customApiDefinitionResponseSchema,
            errors: [403, 404],
            errorSchemas: customApiErrors,
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "connections:update");
          const id = access && definitionId(request, reply);
          if (!access || !id) {
            return;
          }
          const archived = unwrap(await definitions.archive(access, id), reply);
          if (!archived) {
            return;
          }
          return customApiDefinitionResponseSchema.parse(archived);
        },
      );

      scope.post(
        `${BASE}/:definitionId/connections`,
        {
          schema: routeSchema({
            summary:
              "Connect a custom API definition: pins a version (default: the current one) and an environment, checks the credentials, then stores the connection and queues its backfill",
            tags: TAGS,
            body: createCustomApiConnectionRequestSchema,
            response: connectionResponseSchema,
            responseStatus: 201,
            errors: [403, 404, 409],
            errorSchemas: customApiErrors,
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "connections:create");
          const id = access && definitionId(request, reply);
          if (!access || !id) {
            return;
          }
          const body = parseBody(
            createCustomApiConnectionRequestSchema,
            request,
            reply,
          );
          if (!body) {
            return;
          }
          const created = unwrap(
            await connections.create(access, id, body),
            reply,
          );
          if (!created) {
            return;
          }
          return reply
            .code(201)
            .send(connectionResponseSchema.parse({ connection: created }));
        },
      );

      done();
    },
    { prefix: "/v1" },
  );
}
