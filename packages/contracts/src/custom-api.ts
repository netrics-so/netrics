import { z } from "zod";

import { customApiStoredDefinitionSchema } from "@netrics/connector-sdk/custom-api";

import { connectionRetentionChoiceSchema } from "./connection-retention.js";
import { projectFilterQuerySchema } from "./project-filter.js";

// Custom API definitions (milestone 13). The document schema lives in the
// connector SDK's internal subpath, the one package both contracts and
// connectors may import; the API contract re-exports it.
export {
  CUSTOM_API_BODY_LIMITS,
  CUSTOM_API_GRAPHQL_RESERVED_PARAMS,
  CUSTOM_API_CREDENTIAL_NAMES,
  CUSTOM_API_FIELD_FORMATS,
  CUSTOM_API_FORBIDDEN_HEADERS,
  CUSTOM_API_ISSUE_CODES,
  CUSTOM_API_LIMITS,
  CUSTOM_API_SCHEMA_VERSION,
  CustomApiDefinitionError,
  checkCustomApiStreamRequest,
  customApiAuthSchema,
  customApiBodySchema,
  customApiGraphqlProblem,
  customApiDefinitionSchema,
  customApiEnvironmentSchema,
  customApiFieldSchema,
  customApiIssues,
  customApiPagePlaceholders,
  customApiPaginationSchema,
  customApiReservedVariableId,
  customApiStoredDefinitionSchema,
  customApiStreamSchema,
  customApiVariableSchema,
  customApiWindowSchema,
  CUSTOM_API_VALUE_LENGTH,
  customApiConfigSchema,
  formatDataPath,
  readStoredCustomApiDefinition,
  PAGE_PLACEHOLDERS,
  parseDataPath,
  parsePlaceholders,
  readDataPath,
  suggestCustomApiFieldType,
  upgradeCustomApiDefinition,
  WINDOW_PLACEHOLDERS,
} from "@netrics/connector-sdk/custom-api";
export type {
  DataPathSegment,
  CustomApiAuth,
  CustomApiBody,
  CustomApiJsonValue,
  CustomApiDefinition,
  CustomApiDefinitionErrorCode,
  CustomApiEnvironment,
  CustomApiField,
  CustomApiImages,
  CustomApiIssue,
  CustomApiIssueCode,
  CustomApiPagination,
  CustomApiFieldTypeSuggestion,
  CustomApiStream,
  CustomApiVariable,
  CustomApiWindow,
} from "@netrics/connector-sdk/custom-api";

// Definitions API (#803): workspace-scoped, versioned definitions. Requests
// carry the document as unknown JSON; the server validates it with
// upgradeCustomApiDefinition and answers the issues it finds.

export const customApiDefinitionSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  projectId: z.uuid().nullable(),
  currentVersion: z.number().int().positive(),
  archivedAt: z.iso.datetime().nullable(),
  connectionCount: z.number().int().min(0),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type CustomApiDefinitionSummary = z.infer<
  typeof customApiDefinitionSummarySchema
>;

export const customApiDefinitionListResponseSchema = z.object({
  definitions: z.array(customApiDefinitionSummarySchema),
});
export type CustomApiDefinitionListResponse = z.infer<
  typeof customApiDefinitionListResponseSchema
>;

/**
 * A stored definition document in a response, one OpenAPI component.
 * Stored versions read back with their shape only: a version a later,
 * stricter rule rejects stays readable (readStoredCustomApiDefinition).
 */
export const customApiDocumentResponseSchema =
  customApiStoredDefinitionSchema.meta({ id: "CustomApiDefinition" });

export const customApiDefinitionResponseSchema = z.object({
  definition: customApiDefinitionSummarySchema.extend({
    // One OpenAPI component instead of a copy per route.
    document: customApiDocumentResponseSchema,
    datasetVersions: z.record(z.string(), z.number().int().positive()),
  }),
});
export type CustomApiDefinitionResponse = z.infer<
  typeof customApiDefinitionResponseSchema
>;

export const createCustomApiDefinitionRequestSchema = z.object({
  projectId: z.uuid().optional(),
  document: z
    .unknown()
    .describe(
      "A custom API definition document (customApiDefinitionSchema); older schema versions are upgraded",
    ),
});
export type CreateCustomApiDefinitionRequest = z.infer<
  typeof createCustomApiDefinitionRequestSchema
>;

export const createCustomApiDefinitionVersionRequestSchema = z.object({
  baseVersion: z.number().int().positive(),
  document: z
    .unknown()
    .describe(
      "A custom API definition document (customApiDefinitionSchema); older schema versions are upgraded",
    ),
});
export type CreateCustomApiDefinitionVersionRequest = z.infer<
  typeof createCustomApiDefinitionVersionRequestSchema
>;

export const updateCustomApiDefinitionRequestSchema = z.object({
  projectId: z.uuid().nullable(),
});
export type UpdateCustomApiDefinitionRequest = z.infer<
  typeof updateCustomApiDefinitionRequestSchema
>;

export const customApiDefinitionListQuerySchema =
  projectFilterQuerySchema.extend({
    includeArchived: z.enum(["true", "false"]).optional(),
  });
export type CustomApiDefinitionListQuery = z.infer<
  typeof customApiDefinitionListQuerySchema
>;

export const customApiErrorResponseSchema = z.object({
  error: z.string(),
  issues: z
    .array(
      z.object({ path: z.string(), code: z.string(), message: z.string() }),
    )
    .max(20)
    .optional(),
  /**
   * 400 custom_api_read_only_unconfirmed (a draft test of a JSON-body POST,
   * ADR 0030 §2): the confirmation of exactly this request. Show the
   * method and body, ask "this request only reads data", and send the
   * test again with it as `readOnlyConfirmation`.
   */
  readOnlyConfirmation: z.string().optional(),
});
export type CustomApiErrorResponse = z.infer<
  typeof customApiErrorResponseSchema
>;

/**
 * A connection of a custom API definition (milestone 13): the version it
 * pins (default: the current one), the environment it reads, the values of
 * the definition's connection variables, and the credentials its login
 * method needs. Secret variables and credentials are input only: no
 * response ever carries them.
 */
export const createCustomApiConnectionRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  environmentId: z.string().min(1).max(40),
  /** Default: the definition's current version. */
  version: z.number().int().positive().optional(),
  /** The non-secret connection variables, by id. */
  variables: z.record(z.string(), z.string().min(1).max(500)).default({}),
  /** The secret connection variables, by id (input only). */
  secretVariables: z
    .record(z.string(), z.string().min(1).max(2_000))
    .default({}),
  /**
   * apiKey | token | username + password | clientId + clientSecret for the
   * OAuth logins (input only).
   */
  credentials: z.record(z.string(), z.string().min(1).max(4_096)).default({}),
  projectId: z.uuid().optional(),
  /** Overrides the definition's refresh interval, never below the instance minimum. */
  refreshMinutes: z.number().int().positive().max(10_080).optional(),
  retention: connectionRetentionChoiceSchema.optional(),
});
export type CreateCustomApiConnectionRequest = z.infer<
  typeof createCustomApiConnectionRequestSchema
>;

/**
 * The custom OAuth setup (#805): the redirect URI (`<WEB_ORIGIN>/oauth/
 * custom/callback`) a user registers at their own OAuth app. netrics cannot
 * own apps for APIs it does not know.
 */
export const customApiOAuthInfoResponseSchema = z.object({
  redirectUri: z.url(),
});
export type CustomApiOAuthInfoResponse = z.infer<
  typeof customApiOAuthInfoResponseSchema
>;

/** What a custom-api connection runs; null on bundled connectors. */
export const connectionCustomApiViewSchema = z.object({
  definitionId: z.uuid(),
  version: z.number().int().positive(),
  environmentId: z.string(),
  environmentName: z.string(),
  /** The definition's current version (#808). */
  currentVersion: z.number().int().positive(),
  /** A newer version exists; it is offered, never applied by itself. */
  updateAvailable: z.boolean(),
  /**
   * The login method needs secrets and none are stored, for example after
   * an update to a version that sends them to other hosts: the login has
   * to be entered again (custom OAuth: the client, then a sign-in).
   */
  loginMissing: z.boolean(),
  /**
   * What each stream of the pinned version sends (ADR 0030 §2), shown to
   * everyone who can see the connection: the method, path and, for POST,
   * the body template. Bodies hold no secrets (secret variables are only
   * allowed in auth headers), only `{{ placeholders }}`. A JSON body's
   * read-only promise is its author's; netrics cannot verify it.
   */
  requests: z.array(
    z.object({
      stream: z.string(),
      name: z.string(),
      method: z.enum(["GET", "POST"]),
      path: z.string(),
      body: z
        .discriminatedUnion("kind", [
          z.object({
            kind: z.literal("json"),
            value: z.json(),
            readOnlyConfirmed: z.boolean(),
          }),
          z.object({
            kind: z.literal("graphql"),
            query: z.string(),
            variables: z.record(z.string(), z.json()),
          }),
        ])
        .nullable(),
    }),
  ),
});
export type ConnectionCustomApiView = z.infer<
  typeof connectionCustomApiViewSchema
>;
