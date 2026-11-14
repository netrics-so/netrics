/**
 * Typed literal inputs of the visual builder: the text of an input element
 * to a `DataLiteral` and back. Decimals stay exact text, timestamps are
 * wall-clock UTC, and every literal passes `validateDataValue`.
 */
import {
  validateDataValue,
  type DataLiteral,
  type DataType,
  type Locale,
} from "@netrics/domain";

const numberText = /^-?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:e[+-]?[0-9]+)?$/i;
const integerText = /^-?[0-9]+$/;
/** `datetime-local` text: seconds are left out when they are zero. */
const localDateTime = /^(\d{4}-\d\d-\d\dT\d\d:\d\d)(:\d\d(?:\.\d{1,9})?)?$/;

const separator = (locale: Locale) => (locale === "de" ? "," : ".");

/**
 * Number text in the locale's notation to the "." notation, or null when it
 * carries the other separator (a thousands separator is never accepted).
 */
function plainNumber(text: string, locale: Locale): string | null {
  const own = separator(locale);
  const other = own === "," ? "." : ",";
  if (text.includes(other) || text.split(own).length > 2) return null;
  return own === "," ? text.replace(",", ".") : text;
}

function value(type: DataType, text: string, locale: Locale): unknown {
  switch (type) {
    case "string":
      return text;
    case "boolean":
      return text === "true" ? true : text === "false" ? false : undefined;
    case "date":
      return text.trim();
    case "timestamp": {
      const match = localDateTime.exec(text.trim());
      return match ? match[1] + (match[2] ?? ":00") + "Z" : undefined;
    }
    case "json":
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return undefined;
      }
    default: {
      const plain = plainNumber(text.trim(), locale);
      if (plain === null) return undefined;
      if (type === "decimal") return plain;
      if (type === "integer")
        return integerText.test(plain) ? Number(plain) : undefined;
      return numberText.test(plain) ? Number(plain) : undefined;
    }
  }
}

/** The literal an input's text stands for; null when empty or invalid. */
export function literalFromInput(
  type: DataType,
  text: string,
  locale: Locale,
  options?: { unit?: string; currency?: string },
): DataLiteral | null {
  if (text.trim() === "") return null;
  const parsed = value(type, text, locale);
  if (parsed === undefined) return null;
  try {
    validateDataValue(type, parsed, false);
  } catch {
    return null;
  }
  return {
    kind: "literal",
    type,
    value: parsed,
    ...(options?.unit !== undefined ? { unit: options.unit } : {}),
    ...(options?.currency !== undefined ? { currency: options.currency } : {}),
  };
}

/** The input text that reads back as `literal` (inverse of `literalFromInput`). */
export function literalInputText(literal: DataLiteral, locale: Locale): string {
  const v = literal.value;
  if (v === null || v === undefined) return "";
  switch (literal.type) {
    case "integer":
    case "number":
    case "decimal":
      return String(v).replace(".", separator(locale));
    case "timestamp":
      return String(v).replace(/Z$/, "");
    case "json":
      return JSON.stringify(v);
    default:
      return String(v);
  }
}

/** The json list literal of an `in` comparison; null when empty or any item is invalid. */
export function listFromInput(
  type: DataType,
  items: readonly string[],
  locale: Locale,
): DataLiteral | null {
  if (!items.length) return null;
  const values: unknown[] = [];
  for (const item of items) {
    const literal = literalFromInput(type, item, locale);
    if (!literal) return null;
    values.push(literal.value);
  }
  return { kind: "literal", type: "json", value: values };
}
