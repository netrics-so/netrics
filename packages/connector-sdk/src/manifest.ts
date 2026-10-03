import { z } from "zod";

import { parseRange } from "./semver.js";

/**
 * Connector-defined schemas (credentials, configuration) travel as plain JSON
 * Schema objects so the same manifest can cross a JSON-RPC process boundary.
 */
export const jsonSchemaSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof jsonSchemaSchema>;

/**
 * How a user obtains the credential, shown in the connection wizard: a few
 * short steps and, optionally, the provider page where it is created.
 */
export const credentialSetupSchema = z.object({
  steps: z.array(z.string().min(1)).min(1).max(8),
  url: z.url().optional(),
});
export type CredentialSetup = z.infer<typeof credentialSetupSchema>;

/** Credentials the user pastes ("token") or none at all ("none"). */
export const credentialAuthStrategySchema = z.object({
  strategy: z.enum(["token", "none"]),
  /**
   * For "token": `{ properties: { token: { title?, description? } } }`; the
   * title and description label the token field.
   */
  credentialsSchema: jsonSchemaSchema.optional(),
  setup: credentialSetupSchema.optional(),
});
export type CredentialAuthStrategy = z.infer<
  typeof credentialAuthStrategySchema
>;

/**
 * The user authorizes netrics at an OAuth provider (ADR 0012). A connector
 * only names the provider and the scopes it needs; endpoints and client
 * secrets are trusted host code and instance configuration. The host hands
 * the connector `credentials: { accessToken }` and never the refresh token.
 * Since SDK 0.2.1.
 */
export const oauth2AuthStrategySchema = z.object({
  strategy: z.literal("oauth2"),
  provider: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  scopes: z
    .array(z.string().min(1))
    .min(1)
    .refine((scopes) => new Set(scopes).size === scopes.length, {
      message: "scopes must be unique",
    }),
});
export type OAuth2AuthStrategy = z.infer<typeof oauth2AuthStrategySchema>;

export const authStrategySchema = z.union([
  credentialAuthStrategySchema,
  oauth2AuthStrategySchema,
]);
export type AuthStrategy = z.infer<typeof authStrategySchema>;

export const metricKindSchema = z.enum(["gauge", "delta", "counter"]);
export type MetricKind = z.infer<typeof metricKindSchema>;

export const aggregationSchema = z.enum(["sum", "avg", "min", "max", "last"]);
/**
 * Time resolution of a metric's observations. "day" and "hour" values cover
 * a bucket and are stamped at the bucket start in UTC (a daily value for the
 * provider's reporting date D is stamped D T00:00:00Z); "instant" values are
 * point-in-time readings.
 */
export const granularitySchema = z.enum(["day", "hour", "instant"]);
export type Granularity = z.infer<typeof granularitySchema>;
export type Aggregation = z.infer<typeof aggregationSchema>;

export const metricDefinitionSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  kind: metricKindSchema,
  /**
   * Unit of the value. Currency amounts are integer minor units named by
   * ISO 4217 code plus "_minor" (e.g. "EUR_minor" for cents), so values stay
   * exact in double precision.
   */
  unit: z.string().min(1),
  granularity: granularitySchema,
  dimensions: z.array(z.string().min(1)),
  aggregations: z.array(aggregationSchema).min(1),
  /**
   * Which way is good: "higher" (default; more clicks, more revenue) or
   * "lower" (a rank such as average position, an error rate). Dashboards
   * colour a change by it.
   */
  better: z.enum(["higher", "lower"]).optional(),
});
export type MetricDefinition = z.infer<typeof metricDefinitionSchema>;

export const rateLimitHintSchema = z.object({
  maxRequests: z.number().int().positive(),
  windowSeconds: z.number().int().positive(),
  scope: z.string().min(1).optional(),
});
export type RateLimitHint = z.infer<typeof rateLimitHintSchema>;

export const connectorManifestSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    sdkVersion: z
      .string()
      .min(1)
      .refine((value) => parseRange(value) !== null, {
        message: "sdkVersion must be a supported semver range",
      }),
    name: z.string().min(1),
    description: z.string().min(1),
    icon: z.string().min(1).optional(),
    url: z.url().optional(),
    docsUrl: z.url().optional(),
    authStrategies: z.array(authStrategySchema).min(1),
    configSchema: jsonSchemaSchema,
    metrics: z
      .array(metricDefinitionSchema)
      .min(1)
      .refine(
        (metrics) =>
          new Set(metrics.map((metric) => metric.key)).size === metrics.length,
        { message: "metric keys must be unique" },
      ),
    minRefreshIntervalSeconds: z.number().int().positive(),
    supportsBackfill: z.boolean(),
    /** How far back a backfill reaches; required when supportsBackfill. */
    backfillDays: z.number().int().positive().max(3650).optional(),
    outboundDomains: z.array(z.string().min(1)),
    rateLimit: rateLimitHintSchema.optional(),
  })
  .refine(
    (manifest) =>
      !manifest.supportsBackfill || manifest.backfillDays !== undefined,
    {
      message: "backfillDays is required when supportsBackfill is true",
      path: ["backfillDays"],
    },
  );
export type ConnectorManifest = z.infer<typeof connectorManifestSchema>;
