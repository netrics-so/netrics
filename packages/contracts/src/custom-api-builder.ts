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
  // password | clientId + clientSecret) plus secret variable ids. Replaces
  // all stored secrets when present.
  // Secret values have at least 4 characters; the Basic auth username and
  // the OAuth client ID are not secrets and may be shorter.
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
