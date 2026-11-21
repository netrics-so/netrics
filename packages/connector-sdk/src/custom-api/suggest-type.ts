// The type the custom API builder suggests for a field from its values
// (milestone 13): shared by the server's suggestions (first records) and
// the builder's fields that the server did not suggest, such as an
// array item (`daily.time[0]`, #834). Pure.

import type { CustomApiField } from "./definition.js";

export interface CustomApiFieldTypeSuggestion {
  type: CustomApiField["type"];
  /** "iso" for ISO dates and timestamps, "unix_seconds", "unix_millis". */
  format?: CustomApiField["format"];
  role?: "image";
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|z|[+-]\d{2}:?\d{2})$/;
const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;
const IMAGE_EXTENSION = /\.(png|jpe?g|webp)$/i;
const IMAGE_NAME = /image|thumbnail|thumb|photo|picture|avatar|cover/i;
const TIME_NAME = /(^|_)(at|time|timestamp|ts|date)$|At$/;
const MONEY_NAME = /amount|price|revenue|cost|total|value/i;
const UNIX_SECONDS = [946_684_800, 4_102_444_800] as const;

function httpsUrl(value: string): URL | null {
  if (!value.startsWith("https://")) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * The suggested type of a field named `name` (its last key) with these
 * non-null values; no values: text.
 */
export function suggestCustomApiFieldType(
  name: string,
  values: readonly unknown[],
): CustomApiFieldTypeSuggestion {
  if (values.length === 0) return { type: "string" };
  if (values.some((v) => typeof v === "object"))
    return values.every((v) => typeof v === "object")
      ? { type: "json" }
      : { type: "string" };
  if (values.every((v) => typeof v === "boolean")) return { type: "boolean" };
  const strings = values.filter((v): v is string => typeof v === "string");
  const numbers = values.filter((v): v is number => typeof v === "number");
  if (strings.length + numbers.length !== values.length)
    return { type: "string" };
  if (numbers.length === values.length) {
    if (numbers.every(Number.isSafeInteger)) {
      if (TIME_NAME.test(name)) {
        const [low, high] = UNIX_SECONDS;
        if (numbers.every((n) => n >= low && n <= high))
          return { type: "timestamp", format: "unix_seconds" };
        if (numbers.every((n) => n >= low * 1000 && n <= high * 1000))
          return { type: "timestamp", format: "unix_millis" };
      }
      return { type: "integer" };
    }
    return MONEY_NAME.test(name) ? { type: "decimal" } : { type: "number" };
  }
  if (strings.every((s) => DECIMAL_STRING.test(s))) return { type: "decimal" };
  if (numbers.length > 0) return { type: "string" };
  if (strings.every((s) => DATE.test(s) && Number.isFinite(Date.parse(s))))
    return { type: "date", format: "iso" };
  if (strings.every((s) => DATE_TIME.test(s) && Number.isFinite(Date.parse(s))))
    return { type: "timestamp", format: "iso" };
  const urls = strings.map(httpsUrl);
  if (
    urls.every((url) => url !== null) &&
    (IMAGE_NAME.test(name) ||
      urls.every((url) => IMAGE_EXTENSION.test(url!.pathname)))
  )
    return { type: "string", role: "image" };
  return { type: "string" };
}
