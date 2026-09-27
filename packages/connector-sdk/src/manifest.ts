import { z } from "zod";

import { parseRange } from "./semver.js";

/**
 * Connector-defined schemas (credentials, configuration) travel as plain JSON
 * Schema objects so the same manifest can cross a JSON-RPC process boundary.
 */
export const jsonSchemaSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof jsonSchemaSchema>;

export const authStrategySchema = z.object({
  strategy: z.enum(["token", "none"]),
  credentialsSchema: jsonSchemaSchema.optional(),
});
export type AuthStrategy = z.infer<typeof authStrategySchema>;

export const metricKindSchema = z.enum(["gauge", "delta", "counter"]);
export type MetricKind = z.infer<typeof metricKindSchema>;

export const aggregationSchema = z.enum(["sum", "avg", "min", "max", "last"]);
export type Aggregation = z.infer<typeof aggregationSchema>;

export const metricDefinitionSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  kind: metricKindSchema,
  unit: z.string().min(1),
  dimensions: z.array(z.string().min(1)),
  aggregations: z.array(aggregationSchema).min(1),
});
export type MetricDefinition = z.infer<typeof metricDefinitionSchema>;

export const rateLimitHintSchema = z.object({
  maxRequests: z.number().int().positive(),
  windowSeconds: z.number().int().positive(),
  scope: z.string().min(1).optional(),
});
export type RateLimitHint = z.infer<typeof rateLimitHintSchema>;

export const connectorManifestSchema = z.object({
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
  outboundDomains: z.array(z.string().min(1)),
  rateLimit: rateLimitHintSchema.optional(),
});
export type ConnectorManifest = z.infer<typeof connectorManifestSchema>;
