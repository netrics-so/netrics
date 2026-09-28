import type { FastifyInstance } from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import swagger from "@fastify/swagger";
import { z } from "zod";

import { errorResponseSchema } from "@netrics/contracts";

// Error codes each route documents. Every session route can also answer 401
// (added automatically), and workspace-scoped routes 404 for non-members.
type ErrorStatus = 400 | 403 | 404 | 409 | 410 | 429 | 502;

const ERROR_DESCRIPTIONS: Record<ErrorStatus | 401, string> = {
  400: "Invalid request",
  401: "No valid session",
  403: "Role does not allow this action",
  404: "Not found (also for workspaces the caller is not a member of)",
  409: "Conflict",
  410: "No longer valid",
  429: "Too many requests; try again later",
  502: "Upstream failure",
};

export interface RouteDoc {
  summary: string;
  tags: string[];
  body?: z.ZodType;
  querystring?: z.ZodType;
  /** Success response; omit for 204 No Content. */
  response?: z.ZodType;
  errors?: ErrorStatus[];
  /** Public route (no session): no 401 documented. */
  public?: boolean;
  /** Admin API: instance-admin session or a scoped service bearer token. */
  admin?: boolean;
}

function securityFor(doc: RouteDoc): Array<Record<string, string[]>> {
  return doc.admin ? [{ session: [] }, { bearer: [] }] : [{ session: [] }];
}

/**
 * Route schema for validation (body, querystring), response serialization
 * and the generated OpenAPI document. Path parameters are validated in the
 * handlers on purpose: a malformed id must answer 404 like an unknown one, so
 * the API reveals nothing about which ids exist.
 */
export function routeSchema(doc: RouteDoc) {
  const errors = new Set<ErrorStatus | 401>(doc.errors ?? []);
  if (!doc.public) {
    errors.add(401);
  }
  if (doc.body || doc.querystring) {
    errors.add(400);
  }
  const response: Record<number, z.ZodType> = doc.response
    ? { 200: doc.response }
    : { 204: z.null().describe("No content") };
  for (const status of errors) {
    response[status] = errorResponseSchema.describe(ERROR_DESCRIPTIONS[status]);
  }
  return {
    summary: doc.summary,
    tags: doc.tags,
    ...(doc.body ? { body: doc.body } : {}),
    ...(doc.querystring ? { querystring: doc.querystring } : {}),
    response,
    ...(doc.public ? {} : { security: securityFor(doc) }),
  };
}

/** Installs zod validation/serialization and the OpenAPI generator. */
export async function registerOpenApi(
  app: FastifyInstance,
  version: string,
): Promise<void> {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "netrics API",
        version,
        description:
          "REST API of a netrics installation. Browser clients authenticate " +
          "with the session cookie issued by /api/auth; mutating requests " +
          "from browsers must come from the configured web origin.",
      },
      components: {
        securitySchemes: {
          session: {
            type: "apiKey",
            in: "cookie",
            name: "better-auth.session_token",
          },
          bearer: {
            type: "http",
            scheme: "bearer",
            description:
              "Service-account or device token (nt_…), created by the " +
              "operator CLI or device pairing.",
          },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
}
