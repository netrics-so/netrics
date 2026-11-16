/**
 * Typed literal inputs of the visual builder: the text of an input element
 * to a `DataLiteral` and back. Decimals stay exact text, timestamps are
 * wall-clock UTC, and every literal passes `validateDataValue`.
 */
import {
  canonicalJson,
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

/**
 * The input type that shows a stored literal next to a column: the column's
 * type when the literal's text reads as one (an integer `0` in a decimal
 * column), else the literal's own type, so no stored value is hidden.
 */
export function literalDisplayType(
  columnType: DataType,
  literal: DataLiteral | undefined,
  locale: Locale,
): DataType {
  if (
    !literal ||
    literal.type === columnType ||
    literal.value === null ||
    literal.value === undefined
  )
    return columnType;
  const read = literalFromInput(
    columnType,
    literalInputText(literal, locale),
    locale,
  );
  if (!read) return literal.type;
  // An integer reads as the same decimal text ("0" for 0).
  const same =
    columnType === "decimal" && literal.type === "integer"
      ? read.value === String(literal.value)
      : canonicalJson(read.value) === canonicalJson(literal.value);
  return same ? columnType : literal.type;
}

/**
 * A comparison row's input type, decided when the row opens (or its column
 * or operator changes, `key`) and then kept while the value is typed, so the
 * input never switches type mid-edit.
 */
export function rowDisplayType(
  previous: { key: string; type: DataType } | undefined,
  columnType: DataType,
  literal: DataLiteral | undefined,
  locale: Locale,
  key: string,
): { key: string; type: DataType } {
  if (previous?.key === key) return previous;
  return { key, type: literalDisplayType(columnType, literal, locale) };
}

/**
 * The literal after typing `text` (and a currency code) into the input of
 * `previous`. Invalid or empty text gives an empty literal that keeps the
 * unit and currency, so retyping the value does not lose them.
 */
export function literalEdit(
  type: DataType,
  text: string,
  currencyCode: string,
  locale: Locale,
  previous: DataLiteral | undefined,
): DataLiteral {
  // Units belong to numbers, currencies to exact decimals.
  const numeric = type === "integer" || type === "number" || type === "decimal";
  const code = type === "decimal" ? currencyCode : "";
  const units = !numeric
    ? undefined
    : code
      ? { unit: previous?.unit ?? "currency", currency: code }
      : previous?.unit !== undefined && previous.currency === undefined
        ? { unit: previous.unit }
        : undefined;
  return (
    literalFromInput(type, text, locale, units) ?? {
      kind: "literal",
      type,
      value: type === "boolean" ? false : null,
      ...units,
    }
  );
}

/**
 * How a calculation's fixed value is typed until someone picks a type
 * (#630): like the value next to it when that is a decimal or a number, and
 * otherwise as typed, a whole number an integer and anything else a decimal.
 * An integer column next to it stays an integer only for whole numbers, so
 * `[Downloads] * 0.5` can still be typed.
 */
export type FixedValueMode = "decimal" | "number" | "typed";
export function fixedValueMode(partner: DataType | undefined): FixedValueMode {
  return partner === "decimal" || partner === "number" ? partner : "typed";
}

/** In "typed" mode: a decimal without unit whose text is a whole number is an integer. */
export function typedNumericLiteral(literal: DataLiteral): DataLiteral {
  if (
    literal.type !== "decimal" ||
    literal.unit !== undefined ||
    literal.currency !== undefined
  )
    return literal;
  if (literal.value === null) return { ...literal, type: "integer" };
  const whole =
    typeof literal.value === "string" &&
    /^(0|-?[1-9][0-9]*)$/.test(literal.value)
      ? Number(literal.value)
      : Number.NaN;
  return Number.isSafeInteger(whole)
    ? { ...literal, type: "integer", value: whole }
    : literal;
}
