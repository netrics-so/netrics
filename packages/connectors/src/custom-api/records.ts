// Record selection and typed field mapping. A value that does not fit its
// field's type becomes null in a nullable field and skips the record
// otherwise; counts are reported, values never.

import { DATASET_LIMITS } from "@netrics/connector-sdk";
import {
  CUSTOM_API_LIMITS,
  parseDataPath,
  readDataPath,
  type CustomApiField,
  type CustomApiStream,
  type DataPathSegment,
} from "@netrics/connector-sdk/custom-api";

import { dateInZone } from "../freshness.js";
import { CustomApiResponseError } from "./errors.js";
import { CUSTOM_API_MESSAGES } from "./messages.js";

export { CustomApiResponseError } from "./errors.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Array → its items; object → [object]; null/absent → []; anything else → CustomApiResponseError(recordsNotList). */
export function selectRecords(body: unknown, records: string): unknown[] {
  const value = readDataPath(body, parseDataPath(records));
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (isPlainObject(value)) return [value];
  throw new CustomApiResponseError(CUSTOM_API_MESSAGES.recordsNotList);
}

export type ConvertedValue = { ok: true; value: unknown } | { ok: false };

const FAIL: ConvertedValue = { ok: false };
const ok = (value: unknown): ConvertedValue => ({ ok: true, value });

const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const NUMERIC = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|z|[+-]\d{2}:?\d{2})?$/;

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

/** "yyyy-MM-dd" when the parts form a real calendar date (years 1..9999). */
function calendarDate(y: number, m: number, d: number): string | undefined {
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return undefined;
  const last = new Date(Date.UTC(2000, m, 0)).getUTCDate();
  const days =
    m === 2
      ? (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
        ? 29
        : 28
      : last;
  if (d > days) return undefined;
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

/** Offset of a zone from UTC at an instant, in milliseconds. */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(instantMs))
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** The instant of a wall-clock time (as UTC milliseconds of its fields) in a zone. */
export function wallTimeInZone(wallMs: number, timeZone: string): number {
  let instant = wallMs - zoneOffsetMs(wallMs, timeZone);
  instant = wallMs - zoneOffsetMs(instant, timeZone);
  return instant;
}

interface ParsedIso {
  date: string;
  /** The instant, when the text names a time with an offset. */
  instantMs?: number;
  /** Wall-clock milliseconds (fields read as UTC) for zone-less text. */
  wallMs?: number;
}

function parseIso(text: string): ParsedIso | undefined {
  const dateOnly = ISO_DATE.exec(text);
  if (dateOnly) {
    const date = calendarDate(
      Number(dateOnly[1]),
      Number(dateOnly[2]),
      Number(dateOnly[3]),
    );
    return date ? { date, wallMs: Date.parse(`${date}T00:00:00Z`) } : undefined;
  }
  const match = ISO_DATETIME.exec(text);
  if (!match) return undefined;
  const date = calendarDate(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  );
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? "0");
  if (!date || hour > 23 || minute > 59 || second > 59) return undefined;
  const ms = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3) || "0");
  const wallMs =
    Date.parse(`${date}T00:00:00Z`) +
    ((hour * 60 + minute) * 60 + second) * 1000 +
    ms;
  const zone = match[8];
  if (zone === undefined) return { date, wallMs };
  if (zone === "Z" || zone === "z") return { date, instantMs: wallMs };
  const sign = zone.startsWith("-") ? -1 : 1;
  const digits = zone.slice(1).replace(":", "");
  const offset = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2));
  if (Number(digits.slice(0, 2)) > 23 || Number(digits.slice(2)) > 59)
    return undefined;
  return { date, instantMs: wallMs - sign * offset * 60_000 };
}

function calendarFormat(text: string, format: string): string | undefined {
  const patterns: Record<string, [RegExp, [number, number, number]]> = {
    "yyyy-MM-dd": [/^(\d{4})-(\d{2})-(\d{2})$/, [1, 2, 3]],
    "dd.MM.yyyy": [/^(\d{2})\.(\d{2})\.(\d{4})$/, [3, 2, 1]],
    "MM/dd/yyyy": [/^(\d{2})\/(\d{2})\/(\d{4})$/, [3, 1, 2]],
    "dd/MM/yyyy": [/^(\d{2})\/(\d{2})\/(\d{4})$/, [3, 2, 1]],
    yyyyMMdd: [/^(\d{4})(\d{2})(\d{2})$/, [1, 2, 3]],
  };
  const pattern = patterns[format];
  if (!pattern) return undefined;
  const match = pattern[0].exec(text);
  if (!match) return undefined;
  const [y, m, d] = pattern[1];
  return calendarDate(Number(match[y]), Number(match[m]), Number(match[d]));
}

const MAX_INSTANT_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
const MIN_INSTANT_MS = Date.UTC(1, 0, 1);

function unixMs(raw: unknown, format: "unix_seconds" | "unix_millis") {
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && NUMERIC.test(raw)
        ? Number(raw)
        : NaN;
  if (!Number.isFinite(value)) return undefined;
  const ms = Math.round(format === "unix_seconds" ? value * 1000 : value);
  return ms >= MIN_INSTANT_MS && ms <= MAX_INSTANT_MS ? ms : undefined;
}

/** A finite number as a decimal string without exponent. */
function plainDecimal(value: number): string | undefined {
  if (!Number.isFinite(value)) return undefined;
  if (Object.is(value, -0) || value === 0) return "0";
  let text = String(value);
  if (/e/i.test(text)) {
    if (Number.isInteger(value)) text = BigInt(value).toString();
    else {
      text = value.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
      if (text === "-0" || text === "0") return undefined;
    }
  }
  return text;
}

function boundedJson(value: unknown): boolean {
  let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 10_000 || depth > 8) return false;
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object") return false;
    for (const entry of Object.values(item as Record<string, unknown>))
      if (!visit(entry, depth + 1)) return false;
    return true;
  };
  return visit(value, 0);
}

export function convertValue(
  field: CustomApiField,
  raw: unknown,
  timeZone: string,
): ConvertedValue {
  if (raw === null || raw === undefined) return ok(null);
  switch (field.type) {
    case "string":
      if (typeof raw === "string") return ok(raw);
      if (typeof raw === "number")
        return Number.isFinite(raw) ? ok(String(raw)) : FAIL;
      if (typeof raw === "boolean") return ok(String(raw));
      return FAIL;
    case "boolean":
      if (typeof raw === "boolean") return ok(raw);
      if (raw === "true") return ok(true);
      if (raw === "false") return ok(false);
      return FAIL;
    case "integer": {
      if (typeof raw === "number")
        return Number.isSafeInteger(raw) ? ok(raw) : FAIL;
      if (typeof raw === "string" && /^-?\d+$/.test(raw)) {
        const value = Number(raw);
        return Number.isSafeInteger(value) ? ok(value === 0 ? 0 : value) : FAIL;
      }
      return FAIL;
    }
    case "number": {
      if (typeof raw === "number") return Number.isFinite(raw) ? ok(raw) : FAIL;
      if (typeof raw === "string" && NUMERIC.test(raw)) {
        const value = Number(raw);
        return Number.isFinite(value) ? ok(value) : FAIL;
      }
      return FAIL;
    }
    case "decimal": {
      const text =
        typeof raw === "string"
          ? raw
          : typeof raw === "number"
            ? plainDecimal(raw)
            : undefined;
      if (text === undefined || !DECIMAL.test(text)) return FAIL;
      const fraction = text.split(".")[1]?.length ?? 0;
      if (fraction > (field.scale ?? 18)) return FAIL;
      if (text.replace(/[-.]/g, "").length > 38) return FAIL;
      return ok(text === "-0" ? "0" : text);
    }
    case "date": {
      const format = field.format ?? "iso";
      if (format === "unix_seconds" || format === "unix_millis") {
        const ms = unixMs(raw, format);
        return ms === undefined ? FAIL : ok(dateInZone(ms, timeZone));
      }
      if (typeof raw !== "string") return FAIL;
      if (format === "iso") {
        const parsed = parseIso(raw);
        if (!parsed) return FAIL;
        return ok(
          parsed.instantMs !== undefined
            ? dateInZone(parsed.instantMs, timeZone)
            : parsed.date,
        );
      }
      const date = calendarFormat(raw, format);
      return date === undefined ? FAIL : ok(date);
    }
    case "timestamp": {
      const format = field.format ?? "iso";
      let ms: number | undefined;
      if (format === "unix_seconds" || format === "unix_millis")
        ms = unixMs(raw, format);
      else if (format === "iso" && typeof raw === "string") {
        const parsed = parseIso(raw);
        ms =
          parsed === undefined
            ? undefined
            : (parsed.instantMs ?? wallTimeInZone(parsed.wallMs!, timeZone));
      }
      if (ms === undefined || ms < MIN_INSTANT_MS || ms > MAX_INSTANT_MS)
        return FAIL;
      return ok(new Date(ms).toISOString());
    }
    case "json":
      return boundedJson(raw) ? ok(raw) : FAIL;
  }
}

export interface MappedPage {
  rows: Record<string, unknown>[];
  skipped: number;
  /**
   * Records skipped by the field that skipped them, by field id (#834
   * review): empty or unreadable though it may not be empty, or a money
   * field's currency that is no ISO code. Size refusals count in `skipped`
   * only.
   */
  skippedFields: Record<string, number>;
  /** Values set to null because they did not convert, by field id. */
  nulled: Record<string, number>;
}

const pathCache = new WeakMap<CustomApiField, DataPathSegment[]>();
function fieldPath(field: CustomApiField): DataPathSegment[] {
  let path = pathCache.get(field);
  if (!path) {
    path = parseDataPath(field.path);
    pathCache.set(field, path);
  }
  return path;
}

const encoder = new TextEncoder();

export function mapRecords(
  stream: Pick<CustomApiStream, "fields" | "keyFields">,
  raws: readonly unknown[],
  timeZone: string,
): MappedPage {
  const rows: Record<string, unknown>[] = [];
  const nulled: Record<string, number> = {};
  const skippedFields: Record<string, number> = {};
  let skipped = 0;
  const skip = (fieldId?: string) => {
    skipped += 1;
    if (fieldId !== undefined)
      skippedFields[fieldId] = (skippedFields[fieldId] ?? 0) + 1;
  };
  const money = stream.fields.flatMap((field) =>
    field.currencyField === undefined ? [] : [field.currencyField],
  );
  records: for (const raw of raws) {
    const row: Record<string, unknown> = {};
    const nulledHere: string[] = [];
    for (const field of stream.fields) {
      const converted = convertValue(
        field,
        readDataPath(raw, fieldPath(field)),
        timeZone,
      );
      if (converted.ok && (converted.value !== null || field.nullable)) {
        row[field.id] = converted.value;
      } else if (!converted.ok && field.nullable) {
        row[field.id] = null;
        nulledHere.push(field.id);
      } else {
        skip(field.id);
        continue records;
      }
    }
    // What the dataset contract refuses for a whole page skips the record.
    const badCurrency = money.find((id) => !/^[A-Z]{3}$/.test(String(row[id])));
    if (badCurrency !== undefined) {
      skip(badCurrency);
      continue;
    }
    const keyBytes = encoder.encode(
      JSON.stringify(stream.keyFields.map((key) => row[key])),
    ).length;
    if (
      keyBytes > DATASET_LIMITS.keyBytes ||
      encoder.encode(JSON.stringify({ values: row })).length >
        DATASET_LIMITS.rowBytes
    ) {
      skip();
      continue;
    }
    for (const id of nulledHere) nulled[id] = (nulled[id] ?? 0) + 1;
    rows.push(row);
  }
  return { rows, skipped, skippedFields, nulled };
}

/** Non-recursive scan of the body text; true when nesting exceeds CUSTOM_API_LIMITS.jsonDepth. */
export function jsonTooDeep(text: string): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    if (inString) {
      if (char === 0x5c) i++;
      else if (char === 0x22) inString = false;
      continue;
    }
    if (char === 0x22) inString = true;
    else if (char === 0x7b || char === 0x5b) {
      depth += 1;
      if (depth > CUSTOM_API_LIMITS.jsonDepth) return true;
    } else if (char === 0x7d || char === 0x5d) depth -= 1;
  }
  return false;
}
