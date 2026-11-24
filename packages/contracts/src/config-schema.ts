/**
 * The JSON Schema subset connector manifests may use for their configSchema:
 * a top-level object with `properties` (each supporting
 * type/enum/default/minimum/maximum/minLength/maxLength, plus
 * title/description for forms),
 * `required`, and `additionalProperties`.
 * Deliberately NOT a full JSON Schema implementation — anything outside this
 * subset is a manifest authoring error, and keeping it small keeps it
 * auditable (no new dependency).
 *
 * One level of nesting (#874): a property may be `type: "array"` with
 * `minItems`/`maxItems` and `items` an object schema of scalar properties
 * (the same subset, with its own `required`; unknown item keys are always
 * refused). A string property may say `format: "multiline"`, which only
 * changes its form input.
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
  minLength?: unknown;
  maxLength?: unknown;
  minItems?: unknown;
  maxItems?: unknown;
  items?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readSchema(schema: Record<string, unknown>): {
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
  type: "string" | "integer" | "number" | "boolean" | "array";
  enumValues?: string[];
  required: boolean;
  defaultValue?: unknown;
  minimum?: number;
  maximum?: number;
  /** A string's length in characters. */
  minLength?: number;
  maxLength?: number;
  /** A string entered in several lines (`format: "multiline"`). */
  multiline?: boolean;
  /** An array's item fields (scalar), in schema order (#874). */
  itemFields?: ConfigField[];
  minItems?: number;
  maxItems?: number;
}

function scalarType(
  type: unknown,
): "string" | "integer" | "number" | "boolean" {
  return type === "integer" ||
    type === "number" ||
    type === "boolean" ||
    type === "string"
    ? type
    : "string";
}

function fieldsOf(schema: Record<string, unknown>, nested: boolean) {
  const { required } = readSchema(schema);
  const properties = isRecord(schema.properties) ? schema.properties : {};
  return Object.entries(properties).flatMap(([key, raw]): ConfigField[] => {
    if (!isRecord(raw)) {
      return [];
    }
    const array =
      !nested && raw.type === "array" && isRecord(raw.items) ? raw.items : null;
    const field: ConfigField = {
      key,
      label:
        typeof raw.title === "string" && raw.title !== "" ? raw.title : key,
      ...(typeof raw.description === "string" && raw.description !== ""
        ? { description: raw.description }
        : {}),
      type: array ? "array" : scalarType(raw.type),
      ...(Array.isArray(raw.enum) ? { enumValues: raw.enum.map(String) } : {}),
      required: required.includes(key),
      ...(raw.default !== undefined ? { defaultValue: raw.default } : {}),
      ...(typeof raw.minimum === "number" ? { minimum: raw.minimum } : {}),
      ...(typeof raw.maximum === "number" ? { maximum: raw.maximum } : {}),
      ...(typeof raw.minLength === "number"
        ? { minLength: raw.minLength }
        : {}),
      ...(typeof raw.maxLength === "number"
        ? { maxLength: raw.maxLength }
        : {}),
      ...(raw.format === "multiline" ? { multiline: true } : {}),
      ...(array ? { itemFields: fieldsOf(array, true) } : {}),
      ...(typeof raw.minItems === "number" ? { minItems: raw.minItems } : {}),
      ...(typeof raw.maxItems === "number" ? { maxItems: raw.maxItems } : {}),
    };
    return [field];
  });
}

/** The schema as form fields; unknown types render as strings. */
export function parseConfigSchema(schema: ConfigSchema): ConfigField[] {
  return fieldsOf(schema, false);
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
    case "array":
      return Array.isArray(value) ? null : `${key} must be a list`;
    default:
      return null;
  }
}

/** Checks one scalar value against its property (enum, range, length). */
function checkScalar(
  key: string,
  value: unknown,
  property: PropertySchema,
): string | null {
  if (
    Array.isArray(property.enum) &&
    property.enum.length > 0 &&
    !property.enum.includes(value)
  ) {
    return `${key} must be one of: ${property.enum.map(String).join(", ")}`;
  }
  if (
    typeof value === "number" &&
    typeof property.minimum === "number" &&
    value < property.minimum
  ) {
    return `${key} must be at least ${property.minimum}`;
  }
  if (
    typeof value === "number" &&
    typeof property.maximum === "number" &&
    value > property.maximum
  ) {
    return `${key} must be at most ${property.maximum}`;
  }
  // Lengths in characters (code points), as JSON Schema counts them, of
  // the value as connectors read it: trimmed (e.g. a stored " US"
  // storefront). The value is stored as sent.
  const length =
    typeof value === "string" ? [...value.trim()].length : undefined;
  if (
    length !== undefined &&
    typeof property.minLength === "number" &&
    length < property.minLength
  ) {
    return property.minLength === 1
      ? `${key} must not be empty`
      : `${key} must be at least ${property.minLength} characters`;
  }
  if (
    length !== undefined &&
    typeof property.maxLength === "number" &&
    length > property.maxLength
  ) {
    return `${key} must be at most ${property.maxLength} characters`;
  }
  return null;
}

/**
 * Validates one object against an object schema: defaults, unknown keys
 * (when `additionalProperties` is false), required keys, types and scalar
 * bounds. `prefix` names where the object is in messages ("checks[2].").
 */
function validateObject(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  prefix: string,
  refuseUnknown: boolean,
  nested: boolean,
): ConfigValidation {
  const { properties, required } = readSchema(schema);
  const normalized: Record<string, unknown> = { ...value };

  for (const [key, property] of Object.entries(properties)) {
    if (normalized[key] === undefined && property.default !== undefined) {
      normalized[key] = property.default;
    }
  }

  if (refuseUnknown) {
    for (const key of Object.keys(normalized)) {
      if (!(key in properties)) {
        return {
          ok: false,
          message: `unknown config property "${prefix}${key}"`,
        };
      }
    }
  }

  for (const key of required) {
    if (normalized[key] === undefined) {
      return {
        ok: false,
        message: `missing required config property "${prefix}${key}"`,
      };
    }
  }

  for (const [key, entry] of Object.entries(normalized)) {
    const property = properties[key];
    if (!property) {
      continue;
    }
    const name = `${prefix}${key}`;
    if (property.type === "array" && nested) {
      return { ok: false, message: `${name} must not be a list` };
    }
    const typeError = checkType(name, entry, property);
    if (typeError) {
      return { ok: false, message: typeError };
    }
    if (property.type === "array") {
      const list = entry as unknown[];
      if (
        typeof property.minItems === "number" &&
        list.length < property.minItems
      ) {
        return {
          ok: false,
          message:
            property.minItems === 1
              ? `${name} must not be empty`
              : `${name} must have at least ${property.minItems} entries`,
        };
      }
      if (
        typeof property.maxItems === "number" &&
        list.length > property.maxItems
      ) {
        return {
          ok: false,
          message: `${name} must have at most ${property.maxItems} entries`,
        };
      }
      const itemSchema = isRecord(property.items) ? property.items : {};
      const items: Record<string, unknown>[] = [];
      for (const [index, item] of list.entries()) {
        if (!isRecord(item)) {
          return { ok: false, message: `${name}[${index}] must be an object` };
        }
        const checked = validateObject(
          itemSchema,
          item,
          `${name}[${index}].`,
          true,
          true,
        );
        if (!checked.ok) return checked;
        items.push(checked.config);
      }
      normalized[key] = items;
      continue;
    }
    const scalarError = checkScalar(name, entry, property);
    if (scalarError) {
      return { ok: false, message: scalarError };
    }
  }

  return { ok: true, config: normalized };
}

/**
 * Validates `config` against the manifest's configSchema subset and returns a
 * normalized copy with declared defaults applied (in array items too).
 * Unknown keys are rejected when the schema sets `additionalProperties:
 * false`, and always in array items.
 */
export function validateConnectionConfig(
  schema: ConfigSchema,
  config: Record<string, unknown>,
): ConfigValidation {
  return validateObject(
    schema,
    config,
    "",
    schema.additionalProperties === false,
    false,
  );
}
