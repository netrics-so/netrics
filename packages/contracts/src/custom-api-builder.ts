import { z } from "zod";

import { datasetFieldTypeSchema } from "@netrics/connector-sdk";
import {
  CUSTOM_API_FIELD_FORMATS,
  CUSTOM_API_LIMITS,
  customApiAuthSchema,
  customApiDefinitionSchema,
  customApiEnvironmentSchema,
  customApiFieldSchema,
  customApiStreamSchema,
  customApiVariableSchema,
} from "@netrics/connector-sdk/custom-api";

import {
  customApiDocumentResponseSchema,
  customApiErrorResponseSchema,
} from "./custom-api.js";

// The custom API builder (milestone 13, #806): a draft connection holds the
// builder's secrets on the server while the definition is not saved yet; a
// test request runs one stream of the unsaved definition against it. No
// response carries a secret: drafts answer the names of stored secrets,
// test responses are redacted by value.

/**
 * The definition as the builder edits it: one stream whose fields may
 * still be empty while the user maps them. `defaults` carries the time zone
 * the test request reads windows and dates in.
 */
export const customApiDraftDefinitionSchema = z.strictObject({
  name: z.string().min(1).max(100).optional(),
  environments: z
    .array(customApiEnvironmentSchema)
    .min(1)
    .max(CUSTOM_API_LIMITS.environments),
  variables: z
    .array(customApiVariableSchema)
    .max(CUSTOM_API_LIMITS.variables)
    .default([]),
  auth: customApiAuthSchema,
  defaults: customApiDefinitionSchema.shape.defaults,
  // one stream, fields may still be empty while the user maps them
  stream: customApiStreamSchema.extend({
    fields: z.array(customApiFieldSchema).max(100),
    keyFields: z.array(z.string()).max(10).optional(),
  }),
});
export type CustomApiDraftDefinition = z.output<
  typeof customApiDraftDefinitionSchema
>;

export const customApiDraftSchema = z.object({
  id: z.uuid(),
  /** 24 hours after the draft was last touched; then it is deleted. */
  expiresAt: z.iso.datetime(),
  environmentId: z.string().nullable(),
  /** Non-secret values only. */
  variables: z.record(z.string(), z.string()),
  /** Names of stored secrets, never values. */
  secretsSet: z.array(z.string()),
  /** The hosts the stored secrets are bound to ([] without secrets). */
  credentialHosts: z.array(z.string()),
});
export type CustomApiDraft = z.infer<typeof customApiDraftSchema>;

export const customApiDraftResponseSchema = z.object({
  draft: customApiDraftSchema,
});
export type CustomApiDraftResponse = z.infer<
  typeof customApiDraftResponseSchema
>;

export const createCustomApiDraftRequestSchema = z.strictObject({
  /** The definition being edited, when the builder edits a saved one. */
  definitionId: z.uuid().optional(),
});
export type CreateCustomApiDraftRequest = z.infer<
  typeof createCustomApiDraftRequestSchema
>;

/** Credential names whose values are not secrets (no minimum length). */
const NON_SECRET_CREDENTIALS = new Set(["username", "clientId"]);

export const updateCustomApiDraftRequestSchema = z.strictObject({
  definition: customApiDraftDefinitionSchema,
  environmentId: z.string().min(1).max(64),
  variables: z.record(z.string(), z.string().max(1000)).default({}),
  // Keys: the auth method's credential names (apiKey | token | username +
  // password | clientId + clientSecret) plus secret variable ids.
  // Merged into the stored secrets while the hosts and the login method
  // stay the same: only the names sent are replaced, null removes one, {}
  // keeps everything. Secret values have at least 4 characters; the Basic
  // auth username and the OAuth client ID are not secrets and may be
  // shorter.
  secrets: z
    .record(z.string(), z.string().min(1).max(8192).nullable())
    .superRefine((secrets, ctx) => {
      for (const [name, value] of Object.entries(secrets))
        if (
          value !== null &&
          !NON_SECRET_CREDENTIALS.has(name) &&
          value.length < 4
        )
          ctx.addIssue({
            code: "custom",
            path: [name],
            message: "A secret has at least 4 characters",
          });
    })
    .optional(),
});
export type UpdateCustomApiDraftRequest = z.input<
  typeof updateCustomApiDraftRequestSchema
>;

export const promoteCustomApiDraftRequestSchema = z.strictObject({
  definitionId: z.uuid(),
  /** The version just saved (the definition response's currentVersion). */
  version: z.number().int().positive(),
  name: z.string().min(1).max(100),
  projectId: z.uuid().nullable(),
});
export type PromoteCustomApiDraftRequest = z.infer<
  typeof promoteCustomApiDraftRequestSchema
>;

export const promoteCustomApiDraftResponseSchema = z.object({
  connectionId: z.uuid(),
});
export type PromoteCustomApiDraftResponse = z.infer<
  typeof promoteCustomApiDraftResponseSchema
>;

// ------------------------------------------------------------ test request

/** Any JSON value (a redacted, bounded response body or a preview cell). */
export const customApiJsonValueSchema = z.json();

export const customApiFieldSuggestionSchema = z.object({
  /** Relative to the record, dotted with indexes. */
  path: z.string(),
  id: z.string(),
  name: z.string(),
  type: datasetFieldTypeSchema,
  format: z.enum(CUSTOM_API_FIELD_FORMATS).optional(),
  role: z.literal("image").optional(),
  nullable: z.boolean(),
  /** Up to 3 redacted sample values, each at most 80 characters. */
  samples: z.array(z.string()).max(3),
});
export type CustomApiFieldSuggestion = z.infer<
  typeof customApiFieldSuggestionSchema
>;

export const customApiTestRequestSchema = z.strictObject({
  definition: customApiDraftDefinitionSchema,
  environmentId: z.string().min(1).max(64),
  variables: z.record(z.string(), z.string().max(1000)).default({}),
  pages: z.number().int().min(1).max(5).default(1),
  window: z
    .object({ start: z.iso.datetime(), end: z.iso.datetime() })
    .optional(),
});
export type CustomApiTestRequest = z.input<typeof customApiTestRequestSchema>;

export const customApiRequestLogEntrySchema = z.object({
  page: z.number().int(),
  method: z.literal("GET"),
  /** Redacted: no API key, cursor or secret value. */
  url: z.string(),
  status: z.number().int().nullable(),
  durationMs: z.number().int(),
  bytes: z.number().int(),
  records: z.number().int().nullable(),
});
export type CustomApiRequestLogEntry = z.infer<
  typeof customApiRequestLogEntrySchema
>;

export const customApiTestResponseSchema = z.object({
  ok: z.boolean(),
  /**
   * Something in the answer was cut to keep it bounded: the response tree
   * (256 KiB), the preview rows (512 KiB together) or, past 1 MiB for the
   * whole answer, rows, samples and the tree.
   */
  truncated: z.boolean(),
  /** The message is redacted. */
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  /** The first page. */
  response: z
    .object({
      status: z.number().int(),
      contentType: z.string().nullable(),
      body: customApiJsonValueSchema,
      truncated: z.boolean(),
      bytes: z.number().int(),
    })
    .nullable(),
  recordArrays: z.array(
    z.object({ path: z.string(), length: z.number().int() }),
  ),
  records: z.object({
    path: z.string(),
    count: z.number().int(),
    found: z.boolean(),
  }),
  suggestions: z.array(customApiFieldSuggestionSchema),
  rows: z.array(z.record(z.string(), customApiJsonValueSchema)).max(100),
  /** The mapping's counts: records skipped, values set to null by field. */
  mapping: z.object({
    skipped: z.number().int().min(0),
    nulled: z.record(z.string(), z.number().int().min(0)),
  }),
  log: z.array(customApiRequestLogEntrySchema).max(5),
  stopped: z.enum(["end", "page_limit", "record_limit", "duration", "error"]),
  window: z.object({ start: z.string(), end: z.string() }).nullable(),
  draft: customApiDraftSchema,
});
export type CustomApiTestResponse = z.infer<typeof customApiTestResponseSchema>;

// ------------------------------------------------- history and rollback (#808)

export const customApiVersionHistorySchema = z.object({
  versions: z
    .array(
      z.object({
        id: z.uuid(),
        version: z.number().int(),
        createdAt: z.iso.datetime(),
        /** Null: the author's account was deleted. */
        author: z.object({ id: z.uuid(), name: z.string() }).nullable(),
        current: z.boolean(),
        /** An earlier version with an identical document (restores show this). */
        sameAs: z.number().int().nullable(),
        summary: z.object({
          streams: z.number().int(),
          fields: z.number().int(),
          environments: z.number().int(),
        }),
      }),
    )
    .max(20),
  /** Pass as `before` for the next older page; null on the last page. */
  nextBefore: z.number().int().nullable(),
});
export type CustomApiVersionHistory = z.infer<
  typeof customApiVersionHistorySchema
>;

export const customApiVersionHistoryQuerySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
});

export const customApiVersionResponseSchema = z.object({
  version: z.number().int().positive(),
  document: customApiDocumentResponseSchema,
});
export type CustomApiVersionResponse = z.infer<
  typeof customApiVersionResponseSchema
>;

/** baseVersion: the current version the restore was decided on (stale check). */
export const restoreCustomApiVersionRequestSchema = z.strictObject({
  baseVersion: z.number().int().positive(),
});
export type RestoreCustomApiVersionRequest = z.infer<
  typeof restoreCustomApiVersionRequestSchema
>;

// ------------------------------------------------ connection updates (#808)

export const customApiChangeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(["stream_added", "stream_removed"]),
    stream: z.string(),
  }),
  z.object({
    kind: z.enum(["field_added", "field_removed"]),
    stream: z.string(),
    field: z.string(),
  }),
  z.object({
    kind: z.literal("field_changed"),
    stream: z.string(),
    field: z.string(),
    changes: z.array(
      z.enum([
        "type",
        "path",
        "role",
        "format",
        "unit",
        "classification",
        "nullable",
        "name",
      ]),
    ),
  }),
  z.object({
    kind: z.enum([
      "request_changed",
      "pagination_changed",
      "window_changed",
      "mode_changed",
    ]),
    stream: z.string(),
  }),
  z.object({
    kind: z.enum([
      "environment_added",
      "environment_removed",
      "environment_url_changed",
    ]),
    environment: z.string(),
  }),
  z.object({ kind: z.literal("auth_changed") }),
  z.object({
    kind: z.enum(["variable_added", "variable_removed"]),
    variable: z.string(),
  }),
  z.object({ kind: z.literal("schedule_changed") }),
  /** The image hosts or the number of newest items with images (#834). */
  z.object({ kind: z.literal("images_changed") }),
]);
export type CustomApiChange = z.infer<typeof customApiChangeSchema>;

/** What the apply request must resolve before the update can run. */
export const customApiUpdateBlockerSchema = z.discriminatedUnion("code", [
  /** The connection's environment is gone: choose another (environmentId). */
  z.object({ code: z.literal("environment_removed"), environment: z.string() }),
  /** A new connection variable: supply a value (variables, or secrets when secret). */
  z.object({
    code: z.literal("variable_required"),
    variable: z.string(),
    secret: z.boolean(),
  }),
]);
export type CustomApiUpdateBlocker = z.infer<
  typeof customApiUpdateBlockerSchema
>;

/**
 * Whether the stored login carries over. Secrets and tokens are bound to
 * the hosts they were entered for: when the new version sends them to
 * other hosts, or uses another login method, the update drops them and
 * the connection needs its login again (custom OAuth: the client, then a
 * sign-in). The apply may carry the new login for the methods without
 * OAuth (`secrets`).
 */
export const customApiUpdateLoginSchema = z.object({
  carriesOver: z.boolean(),
  reason: z.enum(["hosts_changed", "auth_changed"]).nullable(),
  /** The new version's login method. */
  method: z.enum([
    "none",
    "api_key",
    "bearer",
    "basic",
    "oauth_client_credentials",
    "oauth_authorization_code",
  ]),
});
export type CustomApiUpdateLogin = z.infer<typeof customApiUpdateLoginSchema>;

export const customApiUpdatePlanSchema = z.object({
  connectionId: z.uuid(),
  definitionId: z.uuid(),
  /** The connection's environment the plan was computed for. */
  environmentId: z.string(),
  fromVersion: z.object({ id: z.uuid(), version: z.number().int() }),
  toVersion: z.object({ id: z.uuid(), version: z.number().int() }),
  changes: z.array(customApiChangeSchema),
  blockers: z.array(customApiUpdateBlockerSchema),
  login: customApiUpdateLoginSchema,
  /** The pinned version id the plan was made from; send it back with the apply. */
  basis: z.uuid(),
});
export type CustomApiUpdatePlan = z.infer<typeof customApiUpdatePlanSchema>;

export const customApiUpdatePlanResponseSchema = z.object({
  plan: customApiUpdatePlanSchema,
});
export type CustomApiUpdatePlanResponse = z.infer<
  typeof customApiUpdatePlanResponseSchema
>;

export const customApiUpdateQuerySchema = z.object({
  /** Plan for another environment of the new version. */
  environmentId: z.string().min(1).max(64).optional(),
});

export const customApiUpdateApplyRequestSchema = z.strictObject({
  basis: z.uuid(),
  toVersionId: z.uuid(),
  environmentId: z.string().min(1).max(64).optional(),
  variables: z.record(z.string(), z.string().max(1000)).optional(),
  // The login method's credentials and/or secret variable values. As on a
  // draft, the Basic username and the OAuth client ID may be short; every
  // other value has at least 4 characters.
  secrets: z
    .record(z.string(), z.string().min(1).max(8192))
    .superRefine((secrets, ctx) => {
      for (const [name, value] of Object.entries(secrets))
        if (!NON_SECRET_CREDENTIALS.has(name) && value.length < 4)
          ctx.addIssue({
            code: "custom",
            path: [name],
            message: "A secret has at least 4 characters",
          });
    })
    .optional(),
});
export type CustomApiUpdateApplyRequest = z.infer<
  typeof customApiUpdateApplyRequestSchema
>;

/** 409 custom_api_update_stale carries the fresh plan; 400 custom_api_update_blocked the blockers. */
export const customApiUpdateErrorResponseSchema = z.object({
  error: z.string(),
  plan: customApiUpdatePlanSchema.optional(),
  blockers: z.array(customApiUpdateBlockerSchema).optional(),
  /** invalid_request: what is wrong with the body (#834), never its values. */
  issues: customApiErrorResponseSchema.shape.issues,
});
export type CustomApiUpdateErrorResponse = z.infer<
  typeof customApiUpdateErrorResponseSchema
>;

export const customApiDefinitionConnectionsResponseSchema = z.object({
  connections: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      environmentId: z.string(),
      version: z.number().int().positive(),
      updateAvailable: z.boolean(),
    }),
  ),
});
export type CustomApiDefinitionConnectionsResponse = z.infer<
  typeof customApiDefinitionConnectionsResponseSchema
>;

// --------------------------------------------------- export and import (#808)

export const CUSTOM_API_EXPORT_FORMAT = "netrics.custom-api-definition";

/** Uploaded definition files at most this large (the import route's body limit). */
export const CUSTOM_API_IMPORT_MAX_BYTES = 512 * 1024;

/**
 * An exported definition: the document only, with its schema version. No
 * credentials, connection values, connection or workspace ids.
 */
export const customApiExportSchema = z.strictObject({
  format: z.literal(CUSTOM_API_EXPORT_FORMAT),
  schemaVersion: z.number().int().positive(),
  exportedAt: z.iso.datetime(),
  definition: z
    .unknown()
    .describe(
      "The definition document; validated by upgradeCustomApiDefinition and customApiDefinitionSchema on import",
    ),
});
export type CustomApiExport = z.infer<typeof customApiExportSchema>;

export const customApiExportQuerySchema = z.object({
  /** Default: the current version. */
  version: z.coerce.number().int().positive().optional(),
});

export const importCustomApiDefinitionRequestSchema = z.strictObject({
  file: z
    .unknown()
    .describe("The exported file's JSON (customApiExportSchema)"),
  name: z.string().trim().min(1).max(100).optional(),
  projectId: z.uuid().nullable().default(null),
});
export type ImportCustomApiDefinitionRequest = z.input<
  typeof importCustomApiDefinitionRequestSchema
>;
