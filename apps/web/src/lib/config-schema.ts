/**
 * Client-side rendering support for the JSON Schema subset connector
 * manifests use (mirrors the server's validator): object properties with
 * type/enum/default/minimum/maximum and a required list. Only used to render
 * and coerce form inputs — the server remains the enforcing validator.
 */

export interface ConfigField {
  key: string;
  type: "string" | "integer" | "number" | "boolean";
  enumValues?: string[];
  required: boolean;
  defaultValue?: unknown;
  minimum?: number;
  maximum?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseConfigSchema(
  schema: Record<string, unknown>,
): ConfigField[] {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];
  const fields: ConfigField[] = [];
  for (const [key, raw] of Object.entries(properties)) {
    if (!isRecord(raw)) {
      continue;
    }
    const type =
      raw.type === "integer" ||
      raw.type === "number" ||
      raw.type === "boolean" ||
      raw.type === "string"
        ? raw.type
        : "string";
    fields.push({
      key,
      type,
      ...(Array.isArray(raw.enum) ? { enumValues: raw.enum.map(String) } : {}),
      required: required.includes(key),
      ...(raw.default !== undefined ? { defaultValue: raw.default } : {}),
      ...(typeof raw.minimum === "number" ? { minimum: raw.minimum } : {}),
      ...(typeof raw.maximum === "number" ? { maximum: raw.maximum } : {}),
    });
  }
  return fields;
}

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
