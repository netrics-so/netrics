/**
 * The JSON Schema subset connector manifests may use for their configSchema:
 * a top-level object with `properties` (each supporting
 * type/enum/default/minimum/maximum, plus title/description for forms),
 * `required`, and `additionalProperties`.
 * Deliberately NOT a full JSON Schema implementation — anything outside this
 * subset is a manifest authoring error, and keeping it small keeps it
 * auditable (no new dependency).
 *
 * One reading of the subset for everyone: the API enforces it with
 * validateConnectionConfig, and the web app renders forms from
 * parseConfigSchema.
 */

type ConfigSchema = Record<string, unknown>;

interface PropertySchema {
  type?: unknown;
  enum?: unknown;
  default?: unknown;
  minimum?: unknown;
  maximum?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readSchema(schema: ConfigSchema): {
  properties: Record<string, PropertySchema>;
  required: string[];
} {
  // A malformed (non-object) property entry is still a declared key, just
  // without constraints.
  const properties: Record<string, PropertySchema> = {};
  if (isRecord(schema.properties)) {
    for (const [key, raw] of Object.entries(schema.properties)) {
      properties[key] = isRecord(raw) ? raw : {};
    }
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];
  return { properties, required };
}

// ─── Form fields (web) ──────────────────────────────────────────────────────

export interface ConfigField {
  key: string;
  /** The property's title, or its key. */
  label: string;
  description?: string;
  type: "string" | "integer" | "number" | "boolean";
  enumValues?: string[];
  required: boolean;
  defaultValue?: unknown;
  minimum?: number;
  maximum?: number;
}

/** The schema as form fields; unknown types render as strings. */
export function parseConfigSchema(schema: ConfigSchema): ConfigField[] {
  const { required } = readSchema(schema);
  const properties = isRecord(schema.properties) ? schema.properties : {};
  return Object.entries(properties).flatMap(([key, raw]) => {
    if (!isRecord(raw)) {
      return [];
    }
    const type =
      raw.type === "integer" ||
      raw.type === "number" ||
      raw.type === "boolean" ||
      raw.type === "string"
        ? raw.type
        : "string";
    const field: ConfigField = {
      key,
      label:
        typeof raw.title === "string" && raw.title !== "" ? raw.title : key,
      ...(typeof raw.description === "string" && raw.description !== ""
        ? { description: raw.description }
        : {}),
      type,
      ...(Array.isArray(raw.enum) ? { enumValues: raw.enum.map(String) } : {}),
      required: required.includes(key),
      ...(raw.default !== undefined ? { defaultValue: raw.default } : {}),
      ...(typeof raw.minimum === "number" ? { minimum: raw.minimum } : {}),
      ...(typeof raw.maximum === "number" ? { maximum: raw.maximum } : {}),
    };
    return [field];
  });
}

// ─── Validation (API) ───────────────────────────────────────────────────────

export type ConfigValidation =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; message: string };

function checkType(
  key: string,
  value: unknown,
  property: PropertySchema,
): string | null {
  switch (property.type) {
    case "string":
      return typeof value === "string" ? null : `${key} must be a string`;
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
        ? null
        : `${key} must be an integer`;
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : `${key} must be a number`;
    case "boolean":
      return typeof value === "boolean" ? null : `${key} must be a boolean`;
    default:
      return null;
  }
}

/**
 * Validates `config` against the manifest's configSchema subset and returns a
 * normalized copy with declared defaults applied. Unknown keys are rejected
 * when the schema sets `additionalProperties: false`.
 */
export function validateConnectionConfig(
  schema: ConfigSchema,
  config: Record<string, unknown>,
): ConfigValidation {
  const { properties, required } = readSchema(schema);
  const additionalProperties = schema.additionalProperties !== false;

  const normalized: Record<string, unknown> = { ...config };

  for (const [key, property] of Object.entries(properties)) {
    if (normalized[key] === undefined && property.default !== undefined) {
      normalized[key] = property.default;
    }
  }

  if (!additionalProperties) {
    for (const key of Object.keys(normalized)) {
      if (!(key in properties)) {
        return { ok: false, message: `unknown config property "${key}"` };
      }
    }
  }

  for (const key of required) {
    if (normalized[key] === undefined) {
      return {
        ok: false,
        message: `missing required config property "${key}"`,
      };
    }
  }

  for (const [key, value] of Object.entries(normalized)) {
    const property = properties[key];
    if (!property) {
      continue;
    }
    const typeError = checkType(key, value, property);
    if (typeError) {
      return { ok: false, message: typeError };
    }
    if (
      Array.isArray(property.enum) &&
      property.enum.length > 0 &&
      !property.enum.includes(value)
    ) {
      return {
        ok: false,
        message: `${key} must be one of: ${property.enum.map(String).join(", ")}`,
      };
    }
    if (
      typeof value === "number" &&
      typeof property.minimum === "number" &&
      value < property.minimum
    ) {
      return {
        ok: false,
        message: `${key} must be at least ${property.minimum}`,
      };
    }
    if (
      typeof value === "number" &&
      typeof property.maximum === "number" &&
      value > property.maximum
    ) {
      return {
        ok: false,
        message: `${key} must be at most ${property.maximum}`,
      };
    }
  }

  return { ok: true, config: normalized };
}
