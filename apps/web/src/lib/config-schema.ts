/**
 * Form helpers for a connector's config fields. Reading the manifest's JSON
 * Schema subset is shared with the API's validator (@netrics/contracts); the
 * server remains the enforcing side.
 */

import type { ConfigField } from "@netrics/contracts";

export { parseConfigSchema, type ConfigField } from "@netrics/contracts";

/** Form state is stringly-typed; defaults and existing config prefill it. */
export function initialConfigValues(
  fields: ConfigField[],
  existing: Record<string, unknown> = {},
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    const value = existing[field.key] ?? field.defaultValue;
    if (value !== undefined && value !== null) {
      values[field.key] = String(value);
    }
  }
  return values;
}

/**
 * Coerces form values back to JSON: empty strings are dropped (server-side
 * defaults then apply), integers/numbers are parsed, booleans become real.
 */
export function coerceConfigValues(
  fields: ConfigField[],
  values: Record<string, string>,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.key];
    if (raw === undefined || raw === "") {
      continue;
    }
    if (field.type === "integer" || field.type === "number") {
      const parsed = Number(raw);
      if (!Number.isNaN(parsed)) {
        config[field.key] = parsed;
      }
    } else if (field.type === "boolean") {
      config[field.key] = raw === "true";
    } else {
      config[field.key] = raw;
    }
  }
  return config;
}
