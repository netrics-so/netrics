import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  connectionResponseSchema,
  createCustomApiDraftRequestSchema,
  CUSTOM_API_IMPORT_MAX_BYTES,
  customApiDefinitionConnectionsResponseSchema,
  customApiDefinitionResponseSchema,
  customApiExportQuerySchema,
  customApiExportSchema,
  customApiUpdateApplyRequestSchema,
  customApiUpdateErrorResponseSchema,
  customApiUpdatePlanResponseSchema,
  customApiUpdateQuerySchema,
  customApiVersionHistoryQuerySchema,
  customApiVersionHistorySchema,
  customApiVersionResponseSchema,
  importCustomApiDefinitionRequestSchema,
  restoreCustomApiVersionRequestSchema,
  customApiDraftResponseSchema,
  customApiErrorResponseSchema,
  customApiTestRequestSchema,
  customApiTestResponseSchema,
  promoteCustomApiDraftRequestSchema,
  promoteCustomApiDraftResponseSchema,
  updateCustomApiDraftRequestSchema,
} from "@netrics/contracts";
import type {
  ConnectorRegistry,
  ExecuteOptions,
} from "@netrics/connector-runtime";
import { customApiIssues } from "@netrics/connector-sdk/custom-api";
import type { Database } from "@netrics/database";
import { can, type WorkspaceAction } from "@netrics/domain";

import type { AuthService } from "../auth/index.js";
import type { CredentialKeyring } from "../credentials.js";
import {
  createCustomApiDraftService,
  type DraftResult,
} from "../custom-api/drafts.js";
import { createCustomApiTestRequestService } from "../custom-api/test-request.js";
import { createCustomApiConnectionUpdateService } from "../custom-api/connection-updates.js";
import type { CustomApiResult } from "../custom-api/service.js";
import { createCustomApiTransferService } from "../custom-api/transfer.js";
import { createCustomApiVersionService } from "../custom-api/versions.js";
import type { CustomApiInstanceConfig } from "../env.js";
import type { OAuthTokenService } from "../oauth/tokens.js";
import { resolveAccess, sendError, type WorkspaceAccess } from "./access.js";
import { routeSchema } from "./openapi.js";
import { createRequireSession } from "./session.js";

// HTTP layer of the custom API builder (milestone 13, #806): draft
// connections that hold the builder's secrets on the server (every draft
// route needs connections:create); and (#808) version history, restore,
// connection updates, export and import of saved definitions.

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
  /** Connection responses of connection updates (#808). */
  registry: ConnectorRegistry;
}

const definitionParamsSchema = z.object({ definitionId: z.uuid() });
const versionParamsSchema = z.object({
  definitionId: z.uuid(),
  version: z.coerce.number().int().positive(),
});
const connectionParamsSchema = z.object({ connectionId: z.uuid() });
const DEFINITIONS = "/workspaces/:workspaceId/custom-api/definitions";
const UPDATE =
  "/workspaces/:workspaceId/connections/:connectionId/custom-api-update";

const updateErrors = {
  400: customApiUpdateErrorResponseSchema,
  404: customApiUpdateErrorResponseSchema,
  409: customApiUpdateErrorResponseSchema,
};

function answer<T>(result: CustomApiResult<T>, reply: FastifyReply): T | null {
  if (result.ok) return result.value;
  const { ok: _ok, status, ...body } = result;
  void reply.code(status).send(customApiErrorResponseSchema.parse(body));
  return null;
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

/**
 * Parses a request body; on failure sends 400 invalid_request with the
 * first 20 issues (path, code, message; never input values), as creating
 * a definition does (#834). Routes using it set `attachValidation`, so
 * Fastify's own validation does not answer a bare invalid_request first.
 */
function parseBody<T>(
  schema: z.ZodType<T>,
  request: FastifyRequest,
  reply: FastifyReply,
): T | null {
  const parsed = schema.safeParse(request.body);
  if (parsed.success) return parsed.data;
  void reply.code(400).send(
    customApiErrorResponseSchema.parse({
      error: "invalid_request",
      issues: customApiIssues(parsed.error),
    }),
  );
  return null;
}

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
  const versions = createCustomApiVersionService(deps);
  const transfer = createCustomApiTransferService(deps);
  const updates = createCustomApiConnectionUpdateService(deps);

  function params<T>(
    schema: z.ZodType<T>,
    request: FastifyRequest,
    reply: FastifyReply,
    notFound: string,
  ): T | null {
    const parsed = schema.safeParse(request.params);
    if (!parsed.success) {
      sendError(reply, 404, notFound);
      return null;
    }
    return parsed.data;
  }

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
          attachValidation: true,
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
          attachValidation: true,
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
          attachValidation: true,
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
          attachValidation: true,
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

      // ------------------------------------------ history and restore (#808)

      scope.get(
        `${DEFINITIONS}/:definitionId/versions`,
        {
          schema: routeSchema({
            summary:
              "A custom API definition's versions, newest first, 20 per page (before= pages to older ones), with author, time and the earlier version each is identical to",
            tags: TAGS,
            querystring: customApiVersionHistoryQuerySchema,
            response: customApiVersionHistorySchema,
            errors: [403, 404],
            errorSchemas: customApiErrors,
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "connections:view");
          const id =
            access &&
            params(
              definitionParamsSchema,
              request,
              reply,
              "custom_api_definition_not_found",
            );
          if (!access || !id) return;
          const query = customApiVersionHistoryQuerySchema.safeParse(
            request.query,
          );
          if (!query.success) return sendError(reply, 400, "invalid_request");
          const page = answer(
            await versions.listVersions(
              access,
              id.definitionId,
              query.data.before,
            ),
            reply,
          );
          if (!page) return;
          return customApiVersionHistorySchema.parse(page);
        },
      );

      scope.get(
        `${DEFINITIONS}/:definitionId/versions/:version`,
        {
          schema: routeSchema({
            summary: "One version of a custom API definition",
            tags: TAGS,
            response: customApiVersionResponseSchema,
            errors: [403, 404, 409],
            errorSchemas: customApiErrors,
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "connections:view");
          const at =
            access &&
            params(
              versionParamsSchema,
              request,
              reply,
              "custom_api_version_not_found",
            );
          if (!access || !at) return;
          const found = answer(
            await versions.getVersion(access, at.definitionId, at.version),
            reply,
          );
          if (!found) return;
          return customApiVersionResponseSchema.parse(found);
        },
      );

      scope.post(
        `${DEFINITIONS}/:definitionId/versions/:version/restore`,
        {
          attachValidation: true,
          schema: routeSchema({
            summary:
              "Restore a version: saves its document as a new version (409 custom_api_version_unchanged when it is the current content, custom_api_definition_stale when baseVersion is not current). Connections keep their version until they are updated",
            tags: TAGS,
            body: restoreCustomApiVersionRequestSchema,
            response: customApiDefinitionResponseSchema,
            responseStatus: 201,
            errors: [403, 404, 409],
            errorSchemas: customApiErrors,
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "connections:update");
          const at =
            access &&
            params(
              versionParamsSchema,
              request,
              reply,
              "custom_api_version_not_found",
            );
          if (!access || !at) return;
          const body = parseBody(
            restoreCustomApiVersionRequestSchema,
            request,
            reply,
          );
          if (!body) return;
          const restored = answer(
            await versions.restore(access, at.definitionId, at.version, body),
            reply,
          );
          if (!restored) return;
          return reply
            .code(201)
            .send(customApiDefinitionResponseSchema.parse(restored));
        },
      );

      // ------------------------------------------- export and import (#808)

      scope.get(
        `${DEFINITIONS}/:definitionId/export`,
        {
          schema: routeSchema({
            summary:
              "Download a custom API definition as a file (the current version, or version=): the document with its schema version, no logins and no connection values",
            tags: TAGS,
            querystring: customApiExportQuerySchema,
            response: customApiExportSchema,
            errors: [403, 404, 409],
            errorSchemas: customApiErrors,
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "connections:view");
          const id =
            access &&
            params(
              definitionParamsSchema,
              request,
              reply,
              "custom_api_definition_not_found",
            );
          if (!access || !id) return;
          const query = customApiExportQuerySchema.safeParse(request.query);
          if (!query.success) return sendError(reply, 400, "invalid_request");
          const exported = answer(
            await transfer.export(access, id.definitionId, query.data.version),
            reply,
          );
          if (!exported) return;
          void reply
            .header(
              "content-disposition",
              `attachment; filename="${exported.filename}"`,
            )
            .header("cache-control", "no-store");
          return customApiExportSchema.parse(exported.file);
        },
      );

      scope.post(
        `${DEFINITIONS}/import`,
        {
          bodyLimit: CUSTOM_API_IMPORT_MAX_BYTES + 1024,
          attachValidation: true,
          schema: routeSchema({
            summary:
              'Import an exported custom API definition as a new definition (version 1). Older schema versions are upgraded; 400 custom_api_import_invalid lists up to 20 issues, custom_api_import_newer refuses files from a newer netrics. A name already used gets " (2)", " (3)"…',
            tags: TAGS,
            body: importCustomApiDefinitionRequestSchema,
            response: customApiDefinitionResponseSchema,
            responseStatus: 201,
            errors: [403, 404, 409, 413],
            errorSchemas: customApiErrors,
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "connections:create");
          if (!access) return;
          const body = parseBody(
            importCustomApiDefinitionRequestSchema,
            request,
            reply,
          );
          if (!body) return;
          if (
            Buffer.byteLength(JSON.stringify(body.file ?? null)) >
            CUSTOM_API_IMPORT_MAX_BYTES
          )
            return sendError(reply, 413, "custom_api_import_too_large");
          const created = answer(await transfer.import(access, body), reply);
          if (!created) return;
          return reply
            .code(201)
            .send(customApiDefinitionResponseSchema.parse(created));
        },
      );

      // ------------------------------------------- connection updates (#808)

      scope.get(
        `${DEFINITIONS}/:definitionId/connections`,
        {
          schema: routeSchema({
            summary:
              "The connections of a custom API definition, with their pinned version and whether a newer one is available",
            tags: TAGS,
            response: customApiDefinitionConnectionsResponseSchema,
            errors: [403, 404],
            errorSchemas: customApiErrors,
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "connections:view");
          const id =
            access &&
            params(
              definitionParamsSchema,
              request,
              reply,
              "custom_api_definition_not_found",
            );
          if (!access || !id) return;
          const list = answer(
            await updates.listDefinitionConnections(access, id.definitionId),
            reply,
          );
          if (!list) return;
          return customApiDefinitionConnectionsResponseSchema.parse(list);
        },
      );

      scope.get(
        UPDATE,
        {
          schema: routeSchema({
            summary:
              "The definition update offered to a custom API connection: what changes, what must be decided, and whether the login carries over (404 custom_api_update_none when the connection runs the current version)",
            tags: TAGS,
            querystring: customApiUpdateQuerySchema,
            response: customApiUpdatePlanResponseSchema,
            errors: [403, 404, 409],
            errorSchemas: updateErrors,
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "connections:view");
          const id =
            access &&
            params(
              connectionParamsSchema,
              request,
              reply,
              "connection_not_found",
            );
          if (!access || !id) return;
          const query = customApiUpdateQuerySchema.safeParse(request.query);
          if (!query.success) return sendError(reply, 400, "invalid_request");
          const result = await updates.plan(
            access,
            id.connectionId,
            query.data.environmentId,
          );
          if (!result.ok) {
            const { ok: _ok, status, ...body } = result;
            return reply
              .code(status)
              .send(customApiUpdateErrorResponseSchema.parse(body));
          }
          return customApiUpdatePlanResponseSchema.parse({
            plan: result.value,
          });
        },
      );

      scope.post(
        UPDATE,
        {
          attachValidation: true,
          schema: routeSchema({
            summary:
              "Update a custom API connection to the definition's current version. basis is the pinned version id the plan was made from (409 custom_api_update_stale with the fresh plan otherwise); 400 custom_api_update_blocked lists what is unresolved. A login bound to other hosts, or of another method, is dropped: the connection then needs its login again",
            tags: TAGS,
            body: customApiUpdateApplyRequestSchema,
            response: connectionResponseSchema,
            errors: [403, 404, 409],
            errorSchemas: updateErrors,
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "connections:update");
          const id =
            access &&
            params(
              connectionParamsSchema,
              request,
              reply,
              "connection_not_found",
            );
          if (!access || !id) return;
          const body = parseBody(
            customApiUpdateApplyRequestSchema,
            request,
            reply,
          );
          if (!body) return;
          const result = await updates.apply(access, id.connectionId, body);
          if (!result.ok) {
            const { ok: _ok, status, ...rest } = result;
            return reply
              .code(status)
              .send(customApiUpdateErrorResponseSchema.parse(rest));
          }
          return connectionResponseSchema.parse({ connection: result.value });
        },
      );

      done();
    },
    { prefix: "/v1" },
  );
}
