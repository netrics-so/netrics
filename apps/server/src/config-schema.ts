import type { JsonSchema } from "@netrics/connector-sdk";

/**
 * Tiny validator for the JSON Schema subset connector manifests are allowed
 * to use for their configSchema: a top-level object with `properties` (each
 * supporting type/enum/default/minimum/maximum), `required`, and
 * `additionalProperties`. Deliberately NOT a full JSON Schema implementation
 * — anything outside this subset is a manifest authoring error, and keeping
 * the validator small keeps it auditable (no new dependency).
 */

interface PropertySchema {
  type?: string;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
}

export type ConfigValidation =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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
  schema: JsonSchema,
  config: Record<string, unknown>,
): ConfigValidation {
  const rawProperties = schema.properties;
  const properties: Record<string, PropertySchema> = isPlainObject(
    rawProperties,
  )
    ? (rawProperties as Record<string, PropertySchema>)
    : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];
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
