import { rethrowWorkspaceGone } from "@netrics/database";
// The test response of the custom API builder (milestone 13, #806), made
// safe to return: every string (keys and values) is redacted by value with
// the draft's secrets (raw, URL-encoded in either hex case, form-encoded
// and JSON-escaped), and the body is bounded in array length, keys per
// object, string length, depth and serialized size. Pure. Key-based
// redaction (redactSecrets) is deliberately not applied: API data has keys
// like "keyword" or "token_count" whose values are not secrets. A rendered
// request body echoed as JSON, not as text, is replaced as a whole subtree.
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
  /**
   * Percent-escapes match in either hex case. Null without secrets, or
   * when one pattern would be too large: then `fallback` holds them.
   */
  pattern: RegExp | null;
  /**
   * Rendered request bodies (ADR 0030 §4), raw and JSON-escaped, longest
   * first: matched by plain search before the pattern, never compiled
   * into it (a 128 KiB body, percent-encoded, would outgrow V8's limit).
   */
  rendered: readonly string[];
  /**
   * The rendered bodies parsed, when they are a non-empty object or array:
   * a provider that echoes the body as JSON rather than as text (`{"json":
   * {…}}`) has each matching subtree replaced, keys in any order (#885).
   */
  echoes: readonly object[];
  /**
   * The secret forms by plain search when `pattern` is null, each as it is
   * and with its percent-escapes in upper hex case: the text is searched
   * with its own escapes in upper case too, so an escape matches in any
   * hex case, mixed ones (`%c3%BC`, `%cB`) included (#885).
   */
  fallback: readonly string[];
}

/**
 * Longest pattern source compiled into one RegExp. V8 refuses far larger
 * ones with a SyntaxError whose message repeats the source, that is the
 * secrets: past this, plain search is used and nothing is compiled.
 */
const MAX_PATTERN_CHARS = 262_144;

/** The text with its percent-escapes in upper hex case; same length. */
const upperHex = (text: string): string =>
  text.replace(/%[0-9A-Fa-f]{2}/g, (e) => e.toUpperCase());

const longestFirst = (values: Iterable<string>): string[] =>
  [...new Set(values)]
    .filter((value) => value.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);

/** Replaces every occurrence of each value, in order, by plain search. */
function replacePlain(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values)
    if (out.includes(value)) out = out.split(value).join(REDACTED);
  return out;
}

/**
 * Replaces every occurrence of each value, in order, by plain search in
 * the text with its percent-escapes in upper hex case: upper-casing keeps
 * every position, so a match there is cut from the text itself, and the
 * escapes outside a match keep their case. Values with upper-case escapes
 * match escapes in any hex case; a value whose escape is cut at its end
 * (`…%c`) is left to the plain search after this one.
 */
function replaceAnyHexCase(text: string, values: readonly string[]): string {
  let out = text;
  let upper = upperHex(out);
  for (const value of values) {
    let at = upper.indexOf(value);
    if (at < 0) continue;
    let next = "";
    let from = 0;
    while (at >= 0) {
      next += out.slice(from, at) + REDACTED;
      from = at + value.length;
      at = upper.indexOf(value, from);
    }
    out = next + out.slice(from);
    upper = upperHex(out);
  }
  return out;
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
 * binding and identifiers (`host` and an OAuth envelope's `hosts`: not
 * secrets, and they would redact every URL; an OAuth `clientId`: public,
 * sent in the authorization URL), every secret variable value, and `extra`
 * (derived values such as the basic "Basic <base64>" or "Bearer <token>").
 */
export function secretSetOf(
  credentials: Record<string, unknown>,
  secretVariables: Record<string, string>,
  extra: readonly string[] = [],
  /** Request bodies as sent: no secrets in them, but never shown back. */
  rendered: readonly string[] = [],
): SecretSet {
  const set = new Set<string>();
  const {
    host: _host,
    hosts: _hosts,
    clientId: _clientId,
    ...secrets
  } = credentials;
  collect(secrets, set);
  collect(secretVariables, set);
  collect([...extra], set);
  const values = longestFirst(set);
  const bodies = longestFirst(
    rendered.flatMap((body) => {
      const json = JSON.stringify(body).slice(1, -1);
      return [body, json, json.replaceAll("/", "\\/")];
    }),
  );
  const echoes: object[] = [];
  for (const body of rendered) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (caught) {
      rethrowWorkspaceGone(caught);
      continue;
    }
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      Object.keys(parsed).length > 0
    )
      echoes.push(parsed);
  }
  const source = values.map(formPattern).join("|");
  let pattern: RegExp | null = null;
  if (values.length > 0 && source.length <= MAX_PATTERN_CHARS) {
    try {
      pattern = new RegExp(source, "g");
    } catch (caught) {
      rethrowWorkspaceGone(caught);
      // A SyntaxError is never rethrown: its message repeats the secrets.
      pattern = null;
    }
  }
  return {
    values,
    pattern,
    rendered: bodies,
    echoes,
    fallback:
      values.length > 0 && pattern === null
        ? longestFirst(values.flatMap((value) => [value, upperHex(value)]))
        : [],
  };
}

export function redactText(text: string, secrets: SecretSet): string {
  // Bodies first: a secret-looking value inside an echoed body must not
  // break the body's match.
  let out = replacePlain(text, secrets.rendered);
  if (secrets.pattern) out = out.replace(secrets.pattern, REDACTED);
  if (secrets.fallback.length === 0) return out;
  return replacePlain(
    replaceAnyHexCase(out, secrets.fallback),
    secrets.fallback,
  );
}

/**
 * Whether a JSON value equals `target`: the same keys in any order, the
 * same items in order. The recursion follows the target, a parsed body
 * template (bounded in depth and size), never the response.
 */
function sameJson(value: unknown, target: unknown): boolean {
  if (value === target) return true;
  if (
    value === null ||
    target === null ||
    typeof value !== "object" ||
    typeof target !== "object"
  )
    return false;
  if (Array.isArray(target)) {
    if (!Array.isArray(value) || value.length !== target.length) return false;
    for (let i = 0; i < target.length; i++)
      if (!sameJson(value[i], target[i])) return false;
    return true;
  }
  if (Array.isArray(value)) return false;
  const keys = Object.keys(target);
  if (Object.keys(value).length !== keys.length) return false;
  for (const key of keys)
    if (
      !Object.hasOwn(value, key) ||
      !sameJson(
        (value as Record<string, unknown>)[key],
        (target as Record<string, unknown>)[key],
      )
    )
      return false;
  return true;
}

const isEcho = (value: unknown, secrets: SecretSet): boolean =>
  value !== null &&
  typeof value === "object" &&
  secrets.echoes.some((target) => sameJson(value, target));

/**
 * The value with every subtree that equals a rendered body replaced by
 * "[redacted]" (#885). Copies only the containers on the way to a
 * replacement and returns the value itself when nothing matched. Walks
 * with its own stack, so a deeply nested response cannot overflow it.
 */
export function redactEchoes(value: unknown, secrets: SecretSet): unknown {
  if (secrets.echoes.length === 0) return value;
  if (isEcho(value, secrets)) return REDACTED;
  if (value === null || typeof value !== "object") return value;
  type Container = Record<string, unknown> | unknown[];
  interface Frame {
    source: Container;
    keys: string[];
    next: number;
    copy: Container | null;
    parent: Frame | null;
    key: string;
  }
  const open = (
    source: Container,
    parent: Frame | null,
    key: string,
  ): Frame => ({
    source,
    keys: Array.isArray(source)
      ? Array.from(source, (_, i) => String(i))
      : Object.keys(source),
    next: 0,
    copy: null,
    parent,
    key,
  });
  const set = (frame: Frame, key: string, item: unknown) => {
    frame.copy ??= Array.isArray(frame.source)
      ? frame.source.slice()
      : { ...frame.source };
    // Defined, not assigned: a "__proto__" key stays an own property.
    Object.defineProperty(frame.copy, key, {
      value: item,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  };
  let result: unknown = value;
  let top: Frame | null = open(value as Container, null, "");
  while (top) {
    if (top.next < top.keys.length) {
      const key = top.keys[top.next++]!;
      const child = (top.source as Record<string, unknown>)[key];
      if (child === null || typeof child !== "object") continue;
      if (isEcho(child, secrets)) set(top, key, REDACTED);
      else top = open(child as Container, top, key);
      continue;
    }
    const done: Frame = top;
    top = done.parent;
    if (!top) result = done.copy ?? done.source;
    else if (done.copy) set(top, done.key, done.copy);
  }
  return result;
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
  } catch (caught) {
    rethrowWorkspaceGone(caught);
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

  /** Redacted text cut to 2,000 characters; `length` is the original one. */
  const shown = (clean: string, length: number): string => {
    if (clean.length <= limits.stringChars) return clean;
    omitted.strings += 1;
    return `${clean.slice(0, limits.stringChars)}… (${length} characters)`;
  };
  const text = (value: string): string =>
    shown(redactText(value, secrets), value.length);

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
    /**
     * `source`: for a string value, its redacted text and original length,
     * so a cut by the budget is made from the text itself and its marker
     * names the original length (not that of the 2,000-character cut).
     */
    const scalar = (
      out: string | number | boolean | null,
      source?: { clean: string; length: number },
    ): JsonValue | undefined => {
      const cost = prefix + bytesOf(out);
      if (cost <= room()) {
        used += cost;
        return out;
      }
      if (typeof out !== "string") return undefined;
      const cut = cutToFit(
        source ? source.clean.slice(0, limits.stringChars) : out,
        source ? source.length : out.length,
        room() - prefix,
      );
      if (cut === undefined) return undefined;
      omitted.bytes += 1;
      used += prefix + bytesOf(cut);
      return cut;
    };
    if (value === null || typeof value === "boolean") return scalar(value);
    if (typeof value === "number")
      return scalar(Number.isFinite(value) ? value : null);
    if (typeof value === "string") {
      const clean = redactText(value, secrets);
      return scalar(shown(clean, value.length), {
        clean,
        length: value.length,
      });
    }
    if (typeof value !== "object") return scalar(null);
    if (isEcho(value, secrets)) return scalar(REDACTED);
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
