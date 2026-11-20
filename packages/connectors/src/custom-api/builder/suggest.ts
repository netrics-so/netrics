// What the custom API builder suggests from a test response (milestone 13,
// #806): the arrays that may hold the records, and a typed field per leaf
// value of the first records. Pure; bounded in depth and breadth, so a
// hostile body cannot make it slow. Paths use the dotted syntax of the
// definition (`data`, `meta.next`, `items[0].url`).

import type { DatasetField } from "@netrics/connector-sdk";
import {
  DataPathError,
  formatDataPath,
  parseDataPath,
  readDataPath,
  type CustomApiField,
  type DataPathSegment,
} from "@netrics/connector-sdk/custom-api";

export interface RecordArrayCandidate {
  path: string;
  length: number;
  objectItems: boolean;
}

export interface FieldSuggestion {
  /** Relative to the record, dotted with indexes. */
  path: string;
  /** fieldIdFromPath(path), unique within the result. */
  id: string;
  /** "revenue.amount" → "Revenue amount". */
  name: string;
  type: DatasetField["type"];
  /** "iso" for ISO dates and timestamps, "unix_seconds", "unix_millis". */
  format?: CustomApiField["format"];
  role?: "image";
  nullable: boolean;
  /** Up to 3, each at most 80 characters (redacted by the caller). */
  samples: string[];
}

const MAX_CANDIDATES = 20;
/** Keys looked at per object, items per array when looking for arrays. */
const MAX_KEYS = 200;
const MAX_ITEMS_CHECKED = 20;
/** Leaf depth below the record; deeper objects become json fields. */
const FIELD_DEPTH = 4;
const MAX_FIELDS = 100;
const MAX_SAMPLES = 3;
const SAMPLE_CHARS = 80;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ownKeys(value: Record<string, unknown>): string[] {
  const keys: string[] = [];
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (key === "__proto__" || key === "constructor" || key === "prototype")
      continue;
    keys.push(key);
    if (keys.length >= MAX_KEYS) break;
  }
  return keys;
}

function objectItems(items: readonly unknown[]): boolean {
  const checked = items.slice(0, MAX_ITEMS_CHECKED);
  return checked.length > 0 && checked.every(isPlainObject);
}

/** Arrays in the body, depth-first, arrays of objects first, at most 20; "" = the body itself. */
export function findRecordArrays(
  body: unknown,
  maxDepth = 8,
): RecordArrayCandidate[] {
  const found: RecordArrayCandidate[] = [];
  const visit = (value: unknown, path: DataPathSegment[]) => {
    if (found.length >= MAX_CANDIDATES * 4) return;
    if (Array.isArray(value)) {
      found.push({
        path: formatDataPath(path),
        length: value.length,
        objectItems: objectItems(value),
      });
      return;
    }
    if (!isPlainObject(value) || path.length >= maxDepth) return;
    for (const key of ownKeys(value)) visit(value[key], [...path, { key }]);
  };
  visit(body, []);
  return [
    ...found.filter((candidate) => candidate.objectItems),
    ...found.filter((candidate) => !candidate.objectItems),
  ].slice(0, MAX_CANDIDATES);
}

/** The value at a dotted path; a path that does not parse is not found. */
export function readPath(
  body: unknown,
  path: string,
): { found: true; value: unknown } | { found: false } {
  let segments: DataPathSegment[];
  try {
    segments = parseDataPath(path);
  } catch (error) {
    if (error instanceof DataPathError) return { found: false };
    throw error;
  }
  const value = readDataPath(body, segments);
  return value === undefined ? { found: false } : { found: true, value };
}

/** A field id for a path: /^[a-z][a-z0-9_.-]{0,99}$/, unique against `taken`. */
export function fieldIdFromPath(
  path: string,
  taken: ReadonlySet<string>,
): string {
  let base = path
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(base)) base = `f_${base}`.replace(/_+$/, "");
  base = base.slice(0, 94).replace(/_+$/, "") || "f";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function fieldName(path: string): string {
  const words = path
    .replace(/\[(\d+)\]/g, " $1")
    .replace(/[[\]"]/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s._-]+/)
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const name = words ? words[0]!.toUpperCase() + words.slice(1) : path;
  return (name || "Field").slice(0, 100);
}

type Leaf = unknown;

/** Leaf values of one record by path, objects up to FIELD_DEPTH. */
function leaves(
  record: Record<string, unknown>,
  into: Map<string, Leaf[]>,
  recordIndex: number,
): void {
  const visit = (value: unknown, path: DataPathSegment[]) => {
    if (isPlainObject(value) && path.length < FIELD_DEPTH) {
      for (const key of ownKeys(value)) visit(value[key], [...path, { key }]);
      return;
    }
    if (path.length === 0) return;
    const key = formatDataPath(path);
    let values = into.get(key);
    if (!values) {
      if (into.size >= MAX_FIELDS * 2) return;
      values = [];
      into.set(key, values);
    }
    values[recordIndex] = value;
  };
  visit(record, []);
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

function lastKey(path: string): string {
  const segments = parseDataPath(path);
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]!;
    if ("key" in segment) return segment.key;
  }
  return "";
}

function httpsUrl(value: string): URL | null {
  if (!value.startsWith("https://")) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function suggestType(
  name: string,
  values: readonly unknown[],
): Pick<FieldSuggestion, "type" | "format" | "role"> {
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

/** Redacted first, then cut: a cut must never split a secret out of reach of the redaction. */
function sample(value: unknown, redact: (text: string) => string): string {
  const text = redact(
    typeof value === "string" ? value : JSON.stringify(value),
  );
  return text.length > SAMPLE_CHARS
    ? `${text.slice(0, SAMPLE_CHARS - 1)}…`
    : text;
}

/**
 * Leaf paths of the first `limit` records (objects up to depth 4; arrays of
 * scalars and deeper objects → json). `redact` runs on every path and
 * sample before anything is shortened or derived from it (ids, names).
 */
export function suggestFields(
  records: readonly unknown[],
  limit = 100,
  redact: (text: string) => string = (text) => text,
): FieldSuggestion[] {
  const read = records.slice(0, limit);
  const byPath = new Map<string, Leaf[]>();
  read.forEach((record, index) => {
    if (isPlainObject(record)) leaves(record, byPath, index);
  });
  const taken = new Set<string>();
  const out: FieldSuggestion[] = [];
  for (const [path, slots] of byPath) {
    if (out.length >= MAX_FIELDS) break;
    const values: unknown[] = [];
    let missing = false;
    for (let i = 0; i < read.length; i++) {
      const value = slots[i];
      if (value === undefined || value === null) missing = true;
      else values.push(value);
    }
    const shown = redact(path);
    const id = fieldIdFromPath(shown, taken);
    taken.add(id);
    const samples: string[] = [];
    for (const value of values) {
      const text = sample(value, redact);
      if (!samples.includes(text)) samples.push(text);
      if (samples.length >= MAX_SAMPLES) break;
    }
    out.push({
      path: shown,
      id,
      name: fieldName(shown),
      ...suggestType(lastKey(path), values),
      nullable: missing || values.length === 0,
      samples,
    });
  }
  return out;
}
