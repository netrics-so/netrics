/**
 * Form helpers for a connector's config fields. Reading the manifest's JSON
 * Schema subset is shared with the API's validator (@netrics/contracts); the
 * server remains the enforcing side.
 */

import type { ConfigField } from "@netrics/contracts";

export { parseConfigSchema, type ConfigField } from "@netrics/contracts";

/** One item of an array field in the form: its item fields as strings. */
export type ConfigItemValues = Record<string, string>;

/** An array field's items as the form keeps them (a JSON string). */
export function readConfigItems(raw: string | undefined): ConfigItemValues[] {
  if (raw === undefined || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map((item) =>
          item && typeof item === "object" && !Array.isArray(item)
            ? Object.fromEntries(
                Object.entries(item as Record<string, unknown>).map(
                  ([key, value]) => [key, String(value)],
                ),
              )
            : {},
        )
      : [];
  } catch {
    return [];
  }
}

export function writeConfigItems(items: readonly ConfigItemValues[]): string {
  return JSON.stringify(items);
}

/** An item's values as the form starts them: defaults and existing values. */
export function initialItemValues(
  fields: readonly ConfigField[],
  existing: Record<string, unknown> = {},
): ConfigItemValues {
  const values: ConfigItemValues = {};
  for (const field of fields) {
    const value = existing[field.key] ?? field.defaultValue;
    if (value !== undefined && value !== null) {
      values[field.key] = String(value);
    }
  }
  return values;
}

/** Form state is stringly-typed; defaults and existing config prefill it. */
export function initialConfigValues(
  fields: ConfigField[],
  existing: Record<string, unknown> = {},
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    if (field.type === "array") {
      const current = existing[field.key];
      const items = Array.isArray(current)
        ? current.map((item) =>
            initialItemValues(
              field.itemFields ?? [],
              item && typeof item === "object"
                ? (item as Record<string, unknown>)
                : {},
            ),
          )
        : // A list that needs an entry starts with an empty one.
          (field.minItems ?? 0) > 0
          ? [initialItemValues(field.itemFields ?? [])]
          : [];
      values[field.key] = writeConfigItems(items);
      continue;
    }
    const value = existing[field.key] ?? field.defaultValue;
    if (value !== undefined && value !== null) {
      values[field.key] = String(value);
    }
  }
  return values;
}

function coerceScalar(
  field: ConfigField,
  raw: string | undefined,
): { set: boolean; value?: unknown } {
  if (raw === undefined || raw === "") {
    return { set: false };
  }
  if (field.type === "integer" || field.type === "number") {
    const parsed = Number(raw);
    return Number.isNaN(parsed) ? { set: false } : { set: true, value: parsed };
  }
  if (field.type === "boolean") {
    return { set: true, value: raw === "true" };
  }
  return { set: true, value: raw };
}

/**
 * Coerces form values back to JSON: empty strings are dropped (server-side
 * defaults then apply), integers/numbers are parsed, booleans become real,
 * and an array field's items are coerced the same way, item by item.
 */
export function coerceConfigValues(
  fields: ConfigField[],
  values: Record<string, string>,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.type === "array") {
      config[field.key] = readConfigItems(values[field.key]).map((item) => {
        const coerced: Record<string, unknown> = {};
        for (const itemField of field.itemFields ?? []) {
          const result = coerceScalar(itemField, item[itemField.key]);
          if (result.set) coerced[itemField.key] = result.value;
        }
        return coerced;
      });
      continue;
    }
    const result = coerceScalar(field, values[field.key]);
    if (result.set) {
      config[field.key] = result.value;
    }
  }
  return config;
}
