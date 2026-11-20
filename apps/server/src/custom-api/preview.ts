// The test response of the custom API builder (milestone 13, #806), made
// safe to return: every string (keys and values) is redacted by value with
// the draft's secrets (raw, URL-encoded in either hex case, form-encoded
// and JSON-escaped), and the body is bounded in array length, keys per
// object, string length, depth and serialized size. Pure. Key-based
// redaction (redactSecrets) is deliberately not applied: API data has keys
// like "keyword" or "token_count" whose values are not secrets.
//
// Bounding is one pass with a running byte budget: the work is bounded by
// the budget, not by the size of the body (review of #820: re-serializing
// after every cut was quadratic). Strings are redacted before they are cut,
// so a cut never splits a secret out of reach of the redaction.

export const CUSTOM_API_TEST_LIMITS = {
  maxPages: 5,
  maxRecords: 1_000,
  totalMs: 60_000,
  /** The first response's tree, serialized. */
  previewBytes: 262_144,
  /** All preview rows together, serialized. */
  rowsBytes: 524_288,
  /** The whole test answer, serialized (tree, rows, suggestions, log). */
  responseBytes: 1_048_576,
  arrayItems: 50,
  objectKeys: 200,
  stringChars: 2_000,
  depth: 32,
  rows: 100,
} as const;

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const REDACTED = "[redacted]";
/** Shorter values would over-redact; real secrets are never this short. */
const MIN_SECRET_LENGTH = 4;

/** Every form of every secret, each at least 4 characters, longest first, and one pattern matching them all. */
export interface SecretSet {
  values: readonly string[];
  /** Percent-escapes match in either hex case. Null without secrets. */
  pattern: RegExp | null;
}

function forms(value: string): string[] {
  const json = JSON.stringify(value).slice(1, -1);
  return [
    value,
    encodeURIComponent(value),
    // application/x-www-form-urlencoded (URLSearchParams): spaces as "+".
    new URLSearchParams({ v: value }).toString().slice(2),
    // JSON-escaped, with and without escaped slashes.
    json,
    json.replaceAll("/", "\\/"),
  ];
}

function collect(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    if (value.length < MIN_SECRET_LENGTH) return;
    for (const form of forms(value)) into.add(form);
    return;
  }
  if (Array.isArray(value)) for (const item of value) collect(item, into);
  else if (value !== null && typeof value === "object")
    for (const item of Object.values(value)) collect(item, into);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** A secret form as a pattern whose percent-escapes match in either hex case. */
function formPattern(form: string): string {
  return form
    .split(/(%[0-9A-Fa-f]{2})/)
    .map((part, index) =>
      index % 2 === 1
        ? `%[${part[1]!.toLowerCase()}${part[1]!.toUpperCase()}][${part[2]!.toLowerCase()}${part[2]!.toUpperCase()}]`
        : escapeRegExp(part),
    )
    .join("");
}

/**
 * The secrets of a draft: every credential value except the envelope's
 * `host` (not a secret, and it would redact every URL), every secret
 * variable value, and `extra` (derived values such as the basic
 * "Basic <base64>" or "Bearer <token>").
 */
export function secretSetOf(
  credentials: Record<string, unknown>,
  secretVariables: Record<string, string>,
  extra: readonly string[] = [],
): SecretSet {
  const set = new Set<string>();
  const { host: _host, ...secrets } = credentials;
  collect(secrets, set);
  collect(secretVariables, set);
  collect([...extra], set);
  const values = [...set]
    .filter((value) => value.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  return {
    values,
    pattern: values.length
      ? new RegExp(values.map(formPattern).join("|"), "g")
      : null,
  };
}

export function redactText(text: string, secrets: SecretSet): string {
  return secrets.pattern ? text.replace(secrets.pattern, REDACTED) : text;
}

/**
 * Redacts secrets in a URL and strips userinfo. The text is redacted before
 * and after parsing: new URL() re-encodes some characters (such as "'"),
 * which would hide a raw secret from the stored forms.
 */
export function redactUrl(url: string, secrets: SecretSet): string {
  const raw = redactText(url, secrets);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }
  parsed.username = "";
  parsed.password = "";
  return redactText(parsed.href, secrets).replaceAll(
    "%5Bredacted%5D",
    REDACTED,
  );
}

/** Serialized size of a JSON string or scalar. */
function bytesOf(value: string | number | boolean | null): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Held back for every open array or object while its items are written:
 * the closing bracket and a "more" marker with its comma (at most 30 bytes
 * for `,"…":"<10 digits> more keys"`).
 */
const CLOSE_RESERVE = 48;
/** A string is cut to fit what is left only when at least this much is left. */
const MIN_STRING_ROOM = 40;

/**
 * Redacts every string (keys and values) and bounds the body in one pass:
 * at most 50 items per array ("… N more"), 200 keys per object (key "…":
 * "N more keys"), 2,000 characters per string ("… (N characters)"), depth
 * 32 ("… (nested deeper)"), and `maxBytes` serialized. Every emitted byte
 * is counted (UTF-8, separators, brackets, quotes, markers), and the cost
 * of closing each open container is held back while it is open, so a cut
 * always leaves a valid, partial tree: a string that does not fit is cut
 * to what is left, and a container that does not fit ends with its marker.
 * Only a body whose top level cannot be opened at all is replaced.
 */
export function boundedPreview(
  body: unknown,
  secrets: SecretSet,
  maxBytes: number = CUSTOM_API_TEST_LIMITS.previewBytes,
): {
  body: JsonValue;
  truncated: boolean;
  omitted: { arrays: number; strings: number; depth: number; bytes: number };
} {
  const limits = CUSTOM_API_TEST_LIMITS;
  const omitted = { arrays: 0, strings: 0, depth: 0, bytes: 0 };
  let used = 0;
  let reserved = 0;
  const room = () => maxBytes - used - reserved;

  const text = (value: string): string => {
    const clean = redactText(value, secrets);
    if (clean.length <= limits.stringChars) return clean;
    omitted.strings += 1;
    return `${clean.slice(0, limits.stringChars)}… (${value.length} characters)`;
  };

  /** A string cut to at most `bytes` serialized, or undefined. */
  const cutToFit = (
    clean: string,
    length: number,
    bytes: number,
  ): string | undefined => {
    if (bytes < MIN_STRING_ROOM) return undefined;
    const marker = `… (${length} characters)`;
    let low = 0;
    let high = clean.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (bytesOf(clean.slice(0, mid) + marker) <= bytes) low = mid;
      else high = mid - 1;
    }
    const cut = clean.slice(0, low) + marker;
    return bytesOf(cut) <= bytes ? cut : undefined;
  };

  /** Places a value after `prefix` bytes (separator, key); undefined when it does not fit. */
  const place = (
    value: unknown,
    depth: number,
    prefix: number,
  ): JsonValue | undefined => {
    const scalar = (
      out: string | number | boolean | null,
    ): JsonValue | undefined => {
      const cost = prefix + bytesOf(out);
      if (cost <= room()) {
        used += cost;
        return out;
      }
      if (typeof out !== "string") return undefined;
      const cut = cutToFit(out, out.length, room() - prefix);
      if (cut === undefined) return undefined;
      omitted.bytes += 1;
      used += prefix + bytesOf(cut);
      return cut;
    };
    if (value === null || typeof value === "boolean") return scalar(value);
    if (typeof value === "number")
      return scalar(Number.isFinite(value) ? value : null);
    if (typeof value === "string") return scalar(text(value));
    if (typeof value !== "object") return scalar(null);
    if (depth >= limits.depth) {
      const placed = scalar("… (nested deeper)");
      if (placed !== undefined) omitted.depth += 1;
      return placed;
    }
    if (prefix + 1 + CLOSE_RESERVE > room()) return undefined;
    used += prefix + 1;
    reserved += CLOSE_RESERVE;
    const close = (markerBytes: number) => {
      reserved -= CLOSE_RESERVE;
      used += markerBytes + 1;
    };
    if (Array.isArray(value)) {
      const out: JsonValue[] = [];
      const max = Math.min(value.length, limits.arrayItems);
      for (let i = 0; i < max; i++) {
        const item = place(value[i], depth + 1, out.length > 0 ? 1 : 0);
        if (item === undefined) break;
        out.push(item);
      }
      let markerBytes = 0;
      if (out.length < value.length) {
        if (out.length < max) omitted.bytes += 1;
        else omitted.arrays += 1;
        const marker = `… ${value.length - out.length} more`;
        markerBytes = (out.length > 0 ? 1 : 0) + bytesOf(marker);
        out.push(marker);
      }
      close(markerBytes);
      return out;
    }
    const out: { [key: string]: JsonValue } = {};
    const keys = Object.keys(value);
    const max = Math.min(keys.length, limits.objectKeys);
    let count = 0;
    let kept = 0;
    for (; kept < max; kept++) {
      const key = text(keys[kept]!);
      if (key === "__proto__" || key === "…") continue;
      const item = place(
        (value as Record<string, unknown>)[keys[kept]!],
        depth + 1,
        (count > 0 ? 1 : 0) + bytesOf(key) + 1,
      );
      if (item === undefined) break;
      out[key] = item;
      count += 1;
    }
    let markerBytes = 0;
    if (kept < keys.length) {
      if (kept < max) omitted.bytes += 1;
      else omitted.arrays += 1;
      const marker = `${keys.length - kept} more keys`;
      markerBytes = (count > 0 ? 1 : 0) + bytesOf("…") + 1 + bytesOf(marker);
      out["…"] = marker;
    }
    close(markerBytes);
    return out;
  };

  let result = place(body, 0, 0);
  if (result === undefined) {
    result = "… (response too large to show)";
    omitted.bytes += 1;
  }
  return {
    body: result,
    truncated:
      omitted.arrays + omitted.strings + omitted.depth + omitted.bytes > 0,
    omitted,
  };
}
