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
 * Id of a host-defined auth provider ("google", "app-store-connect"):
 * lowercase words joined by single hyphens.
 */
export const authProviderIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/**
 * The user authorizes netrics at an OAuth provider (ADR 0012). A connector
 * only names the provider and the scopes it needs; endpoints and client
 * secrets are trusted host code and instance configuration. The host hands
 * the connector `credentials: { accessToken }` and never the refresh token.
 * Since SDK 0.2.1.
 */
export const oauth2AuthStrategySchema = z.object({
  strategy: z.literal("oauth2"),
  provider: authProviderIdSchema,
  scopes: z
    .array(z.string().min(1))
    .min(1)
    .refine((scopes) => new Set(scopes).size === scopes.length, {
      message: "scopes must be unique",
    }),
});
export type OAuth2AuthStrategy = z.infer<typeof oauth2AuthStrategySchema>;

/**
 * The user uploads key material (an App Store Connect API key) and the host
 * signs short-lived tokens with it (ADR 0014). A connector only names the
 * provider: the credential fields, token claims and lifetime are trusted host
 * code. The host hands the connector `credentials: { accessToken }` (a fresh
 * token per call, see SignedKeyCredentials) and never the key. Unknown fields
 * are rejected, so a connector cannot smuggle claims or key settings in.
 * Since SDK 0.2.2.
 */
export const signedKeyAuthStrategySchema = z.strictObject({
  strategy: z.literal("signed-key"),
  provider: authProviderIdSchema,
});
export type SignedKeyAuthStrategy = z.infer<typeof signedKeyAuthStrategySchema>;

/**
 * What an "oauth2" or "signed-key" connector finds in
 * `ConnectionContext.credentials`: a short-lived bearer token minted by the
 * host for this one call. Refresh tokens and private keys stay with the host.
 */
export interface AccessTokenCredentials {
  accessToken: string;
}

export const authStrategySchema = z.union([
  credentialAuthStrategySchema,
  oauth2AuthStrategySchema,
  signedKeyAuthStrategySchema,
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

/**
 * Unit of a currency amount whose currency varies per observation (ADR
 * 0014): integer minor units, with the ISO 4217 code in the observation's
 * `currency` dimension (e.g. App Store proceeds per currency of proceeds).
 * Since SDK 0.2.3.
 */
export const CURRENCY_MINOR_UNIT = "currency_minor";
/** The dimension that holds a `currency_minor` value's ISO 4217 code. */
export const CURRENCY_DIMENSION = "currency";

export const metricDefinitionSchema = z
  .object({
    key: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    kind: metricKindSchema,
    /**
     * Unit of the value. Currency amounts are integer minor units named by
     * ISO 4217 code plus "_minor" (e.g. "EUR_minor" for cents), so values stay
     * exact in double precision. When the currency varies per observation, the
     * unit is "currency_minor" and the metric declares a "currency" dimension
     * holding the ISO 4217 code; amounts in different currencies are never
     * added up.
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
    /**
     * "primary" (default) metrics are shown on their own; a "helper" is an
     * input for derived values (e.g. a position sum divided by impressions).
     * Helpers are stored and queryable like any metric, but tile pickers do
     * not offer them. Presentation only: a runtime that does not know the
     * field ignores it.
     */
    role: z.enum(["primary", "helper"]).optional(),
  })
  .refine(
    (metric) =>
      metric.unit !== CURRENCY_MINOR_UNIT ||
      metric.dimensions.includes(CURRENCY_DIMENSION),
    {
      message: `a "${CURRENCY_MINOR_UNIT}" metric needs a "${CURRENCY_DIMENSION}" dimension`,
      path: ["dimensions"],
    },
  );
export type MetricDefinition = z.infer<typeof metricDefinitionSchema>;

export const rateLimitHintSchema = z.object({
  maxRequests: z.number().int().positive(),
  windowSeconds: z.number().int().positive(),
  scope: z.string().min(1).optional(),
});
export type RateLimitHint = z.infer<typeof rateLimitHintSchema>;

/**
 * What a connector calls the resources its observations name in their
 * "resource" dimension: { singular: "app", plural: "apps" }. Dashboards say
 * "Downloads · All apps" for a tile of all of them. Presentation only: a
 * runtime that does not know the field ignores it. Since SDK 0.2.4.
 */
export const resourceNounSchema = z.object({
  singular: z.string().min(1).max(40),
  plural: z.string().min(1).max(40),
});
export type ResourceNoun = z.infer<typeof resourceNounSchema>;

/** A translated title and description of a configuration or credential field. */
export const fieldTranslationSchema = z.strictObject({
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
});

/**
 * What one locale translates of a manifest (ADR 0016 section 6). Every
 * field is optional and falls back on its own to the English manifest
 * value. Unknown fields are rejected, so a typo does not silently leave
 * text in English. Since SDK 0.2.6.
 */
export const manifestTranslationSchema = z.strictObject({
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  resourceNoun: resourceNounSchema.optional(),
  /** By metric key; every key must be one of the manifest's metrics. */
  metrics: z
    .record(
      z.string().min(1),
      z.strictObject({
        name: z.string().min(1).optional(),
        description: z.string().min(1).optional(),
      }),
    )
    .optional(),
  /** Display names of dimensions the metrics declare ("territory" → "Land"). */
  dimensions: z.record(z.string().min(1), z.string().min(1).max(60)).optional(),
  /** Titles and descriptions of configSchema properties, by property key. */
  config: z.record(z.string().min(1), fieldTranslationSchema).optional(),
  /** Titles and descriptions of "token" credentialsSchema properties. */
  credentials: z.record(z.string().min(1), fieldTranslationSchema).optional(),
  /** The credential setup steps, one for each English step. */
  setupSteps: z.array(z.string().min(1)).min(1).max(8).optional(),
});
export type ManifestTranslation = z.infer<typeof manifestTranslationSchema>;

/**
 * A locale as a lowercase language subtag ("de"). English is the manifest
 * itself and has no entry.
 */
export const translationLocaleSchema = z
  .string()
  .regex(/^[a-z]{2,3}$/, {
    message: 'locales are language subtags such as "de"',
  })
  .refine((locale) => locale !== "en", {
    message: "English is the manifest itself; translate into other locales",
  });

export const manifestTranslationsSchema = z.record(
  translationLocaleSchema,
  manifestTranslationSchema,
);
export type ManifestTranslations = z.infer<typeof manifestTranslationsSchema>;

/**
 * Where the catalogue files a connector (the Sources page's category
 * filter). Presentation only. Since SDK 0.2.7.
 */
export const connectorCategorySchema = z.enum([
  "seo",
  "web",
  "apps",
  "ads",
  "revenue",
  "other",
]);
export type ConnectorCategory = z.infer<typeof connectorCategorySchema>;

/**
 * The colour of the connector's icon tile, as "#rrggbb". Presentation only;
 * hosts fall back to a neutral tile without it. Since SDK 0.2.7.
 */
export const brandColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, { message: 'brandColor must be "#rrggbb"' });

function propertyKeys(schema: unknown): Set<string> {
  const properties =
    schema && typeof schema === "object"
      ? (schema as { properties?: unknown }).properties
      : undefined;
  return new Set(
    properties && typeof properties === "object" && !Array.isArray(properties)
      ? Object.keys(properties)
      : [],
  );
}

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
    /** Catalogue category (SDK 0.2.7); hosts file connectors without one under "other". */
    category: connectorCategorySchema.optional(),
    /** Icon tile colour, "#rrggbb" (SDK 0.2.7). */
    brandColor: brandColorSchema.optional(),
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
    resourceNoun: resourceNounSchema.optional(),
    /**
     * Texts in other languages, by locale (SDK 0.2.6, ADR 0016). Optional;
     * hosts show the English values for anything not translated.
     */
    translations: manifestTranslationsSchema.optional(),
  })
  .refine(
    (manifest) =>
      !manifest.supportsBackfill || manifest.backfillDays !== undefined,
    {
      message: "backfillDays is required when supportsBackfill is true",
      path: ["backfillDays"],
    },
  )
  .superRefine((manifest, context) => {
    if (!manifest.translations) {
      return;
    }
    // Translations may only name what the manifest has.
    const metricKeys = new Set(manifest.metrics.map((metric) => metric.key));
    const dimensions = new Set(
      manifest.metrics.flatMap((metric) => metric.dimensions),
    );
    const configKeys = propertyKeys(manifest.configSchema);
    const tokenStrategies = manifest.authStrategies.flatMap((strategy) =>
      strategy.strategy === "token" ? [strategy] : [],
    );
    const credentialKeys = new Set(
      tokenStrategies.flatMap((strategy) => [
        ...propertyKeys(strategy.credentialsSchema),
      ]),
    );
    const stepCounts = new Set(
      tokenStrategies.flatMap((strategy) =>
        strategy.setup ? [strategy.setup.steps.length] : [],
      ),
    );
    const unknownKeys = (
      locale: string,
      field: string,
      keys: readonly string[],
      known: ReadonlySet<string>,
      what: string,
    ) => {
      for (const key of keys) {
        if (!known.has(key)) {
          context.addIssue({
            code: "custom",
            message: `translations.${locale}.${field} names unknown ${what} "${key}"`,
            path: ["translations", locale, field, key],
          });
        }
      }
    };
    for (const [locale, translation] of Object.entries(manifest.translations)) {
      unknownKeys(
        locale,
        "metrics",
        Object.keys(translation.metrics ?? {}),
        metricKeys,
        "metric",
      );
      unknownKeys(
        locale,
        "dimensions",
        Object.keys(translation.dimensions ?? {}),
        dimensions,
        "dimension",
      );
      unknownKeys(
        locale,
        "config",
        Object.keys(translation.config ?? {}),
        configKeys,
        "config field",
      );
      unknownKeys(
        locale,
        "credentials",
        Object.keys(translation.credentials ?? {}),
        credentialKeys,
        "credential field",
      );
      const steps = translation.setupSteps;
      if (steps && !(stepCounts.size === 1 && stepCounts.has(steps.length))) {
        context.addIssue({
          code: "custom",
          message: `translations.${locale}.setupSteps needs one step for each English setup step`,
          path: ["translations", locale, "setupSteps"],
        });
      }
    }
  });
export type ConnectorManifest = z.infer<typeof connectorManifestSchema>;
