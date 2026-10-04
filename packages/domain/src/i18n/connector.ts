/**
 * Connector metadata in the reader's language (ADR 0016 section 6, #257).
 *
 * A connector manifest is written in English and may carry a `translations`
 * map per locale (SDK 0.2.6). Every field falls back on its own to the
 * English manifest value, so a partial translation still shows, and a
 * locale without translations is the English manifest. Pure functions over
 * plain data: the shapes below are structural, so `@netrics/domain` does not
 * depend on the connector SDK, and rows read back from the catalog's `jsonb`
 * work as well as a manifest from the registry.
 */

import type { ResourceNoun } from "../resource.js";

/** A title and description pair, e.g. of a configuration field. */
export interface FieldTranslation {
  title?: string;
  description?: string;
}

/** What one locale translates of a connector manifest. */
export interface ConnectorTranslation {
  name?: string;
  description?: string;
  resourceNoun?: ResourceNoun;
  /** By metric key. */
  metrics?: Readonly<Record<string, { name?: string; description?: string }>>;
  /** Display names of dimensions, by dimension key ("territory" → "Land"). */
  dimensions?: Readonly<Record<string, string>>;
  /** Titles and descriptions of configSchema properties, by property key. */
  config?: Readonly<Record<string, FieldTranslation>>;
  /** Titles and descriptions of credential fields ("token"), by key. */
  credentials?: Readonly<Record<string, FieldTranslation>>;
  /** The credential setup steps, one for each English step. */
  setupSteps?: readonly string[];
}

/** Translations by locale ("de"). English is the manifest itself. */
export type ConnectorTranslations = Readonly<
  Record<string, ConnectorTranslation>
>;

/** The parts of a manifest that carry English text. */
export interface TranslatableManifest {
  name: string;
  description: string;
  resourceNoun?: ResourceNoun | undefined;
  metrics: readonly { key: string; name: string; description: string }[];
  configSchema?: Readonly<Record<string, unknown>>;
  authStrategies?: readonly {
    strategy: string;
    credentialsSchema?: Readonly<Record<string, unknown>> | undefined;
    setup?: { steps: readonly string[]; url?: string | undefined } | undefined;
  }[];
  translations?: ConnectorTranslations | null | undefined;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The translation of a manifest for a locale, or null. Tolerates malformed
 * stored data (it is read back from `jsonb`): anything that is not an
 * object reads as no translation.
 */
export function connectorTranslation(
  translations: ConnectorTranslations | null | undefined,
  locale: string,
): ConnectorTranslation | null {
  if (!isRecord(translations) || !Object.hasOwn(translations, locale)) {
    return null;
  }
  const entry = translations[locale];
  return isRecord(entry) ? entry : null;
}

function entryOf<T>(
  map: Readonly<Record<string, T>> | undefined,
  key: string,
): T | undefined {
  return isRecord(map) && Object.hasOwn(map, key) ? map[key] : undefined;
}

/**
 * A metric's name and description in the locale, each falling back to the
 * English value: `localizedMetric(manifest, metric, "de")`. `manifest`
 * only needs its `translations`, so a catalog row's metric and its
 * connector's stored translations work too.
 */
export function localizedMetric(
  manifest: Pick<TranslatableManifest, "translations">,
  metric: { key: string; name: string; description: string },
  locale: string,
): { name: string; description: string } {
  const translated = entryOf(
    connectorTranslation(manifest.translations, locale)?.metrics,
    metric.key,
  );
  return {
    name: nonEmpty(translated?.name) ? translated.name : metric.name,
    description: nonEmpty(translated?.description)
      ? translated.description
      : metric.description,
  };
}

/**
 * What the connector calls its resources in the locale: the translated
 * noun when it has both forms, else the English one, else null (callers
 * then use DEFAULT_RESOURCE_NOUN).
 */
export function localizedResourceNoun(
  manifest: Pick<TranslatableManifest, "resourceNoun" | "translations">,
  locale: string,
): ResourceNoun | null {
  const translated = connectorTranslation(
    manifest.translations,
    locale,
  )?.resourceNoun;
  if (
    isRecord(translated) &&
    nonEmpty(translated.singular) &&
    nonEmpty(translated.plural)
  ) {
    return { singular: translated.singular, plural: translated.plural };
  }
  return manifest.resourceNoun ?? null;
}

/**
 * A dimension's display name when nobody named it: the key in sentence
 * case ("territory" → "Territory", "event_name" → "Event name").
 */
export function defaultDimensionName(dimension: string): string {
  const words = dimension.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A dimension's display name in the locale, else defaultDimensionName. */
export function localizedDimensionName(
  manifest: Pick<TranslatableManifest, "translations">,
  dimension: string,
  locale: string,
): string {
  const translated = entryOf(
    connectorTranslation(manifest.translations, locale)?.dimensions,
    dimension,
  );
  return nonEmpty(translated) ? translated : defaultDimensionName(dimension);
}

/** A JSON Schema object with its properties' title/description translated. */
function localizedSchema<S extends Readonly<Record<string, unknown>>>(
  schema: S,
  fields: Readonly<Record<string, FieldTranslation>> | undefined,
): S {
  const properties = schema.properties;
  if (!isRecord(fields) || !isRecord(properties)) {
    return schema;
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(properties)) {
    const field = entryOf(fields, key);
    if (!field || !isRecord(property)) {
      next[key] = property;
      continue;
    }
    const patched: Record<string, unknown> = { ...property };
    if (nonEmpty(field.title)) {
      patched.title = field.title;
      changed = true;
    }
    if (nonEmpty(field.description)) {
      patched.description = field.description;
      changed = true;
    }
    next[key] = patched;
  }
  return changed ? { ...schema, properties: next } : schema;
}

/**
 * The manifest with its texts in the locale, field by field falling back
 * to English: name, description, resource noun, metric names and
 * descriptions, configuration and credential field titles and
 * descriptions, and the credential setup steps (only when there is one
 * translated step for each English step). Everything else, including
 * `translations`, is returned unchanged; the input is not modified.
 */
export function localizedManifest<M extends TranslatableManifest>(
  manifest: M,
  locale: string,
): M {
  const translation = connectorTranslation(manifest.translations, locale);
  if (!translation) {
    return manifest;
  }
  const resourceNoun = localizedResourceNoun(manifest, locale);
  const steps = Array.isArray(translation.setupSteps)
    ? translation.setupSteps
    : null;
  return {
    ...manifest,
    name: nonEmpty(translation.name) ? translation.name : manifest.name,
    description: nonEmpty(translation.description)
      ? translation.description
      : manifest.description,
    ...(resourceNoun ? { resourceNoun } : {}),
    metrics: manifest.metrics.map((metric) => ({
      ...metric,
      ...localizedMetric(manifest, metric, locale),
    })),
    ...(manifest.configSchema
      ? {
          configSchema: localizedSchema(
            manifest.configSchema,
            translation.config,
          ),
        }
      : {}),
    ...(manifest.authStrategies
      ? {
          authStrategies: manifest.authStrategies.map((strategy) => ({
            ...strategy,
            ...(strategy.credentialsSchema
              ? {
                  credentialsSchema: localizedSchema(
                    strategy.credentialsSchema,
                    translation.credentials,
                  ),
                }
              : {}),
            ...(strategy.setup &&
            steps &&
            steps.length === strategy.setup.steps.length &&
            steps.every(nonEmpty)
              ? { setup: { ...strategy.setup, steps: [...steps] } }
              : {}),
          })),
        }
      : {}),
  };
}
