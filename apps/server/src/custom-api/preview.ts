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

export const REDACTED = "[redacted]";
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
  echoes: readonly EchoTarget[];
  /**
   * The secret forms by plain search when `pattern` is null, longest
   * first. The hex digits of a form's own percent-escapes match in any
   * case, mixed ones (`%c3%BC`, `%cB`) included; every other character
   * matches exactly, so a letter next to a secret never changes what
   * matches (#885).
   */
  fallback: readonly FallbackForm[];
}

/** A rendered body, parsed, with its key lists taken once (#885). */
export type EchoTarget =
  | { kind: "scalar"; value: unknown }
  | { kind: "array"; items: readonly EchoTarget[] }
  | {
      kind: "object";
      keys: readonly string[];
      entries: ReadonlyMap<string, EchoTarget>;
    };

/** A secret form for the plain search, with the positions that fold hex case. */
export interface FallbackForm {
  text: string;
  /** 1 at the hex digits of the form's own `%XX` escapes. */
  fold: Uint8Array;
  /**
   * The form without its first and last BOUNDARY characters, its escape
   * digits in lower case, and its KMP failure table.
   */
  core: string;
  failure: Int32Array;
}

/**
 * Longest pattern source compiled into one RegExp. V8 refuses far larger
 * ones with a SyntaxError whose message repeats the source, that is the
 * secrets: past this, plain search is used and nothing is compiled.
 */
const MAX_PATTERN_CHARS = 262_144;

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

/** The text with the hex digits of its `%XX` escapes in lower case; same length. */
const lowerEscapes = (text: string): string =>
  text.replace(/%[0-9A-Fa-f]{2}/g, (escape) => escape.toLowerCase());

/**
 * Characters at each end of a form compared on their own. Only there can
 * a match start or end inside an escape of the text (`%ab…` for a form
 * starting with "ab", or a form ending in `%a` before `%a3`); everywhere
 * between, the form's escapes line up with the text's, since "%" is never
 * a hex digit.
 */
const BOUNDARY = 2;

export function fallbackForm(text: string): FallbackForm {
  const fold = new Uint8Array(text.length);
  for (const escape of text.matchAll(/%[0-9A-Fa-f]{2}/g)) {
    fold[escape.index + 1] = 1;
    fold[escape.index + 2] = 1;
  }
  const core = lowerEscapes(text).slice(
    BOUNDARY,
    Math.max(BOUNDARY, text.length - BOUNDARY),
  );
  const failure = new Int32Array(core.length);
  for (let i = 1, k = 0; i < core.length; i++) {
    while (k > 0 && core[i] !== core[k]) k = failure[k - 1]!;
    if (core[i] === core[k]) k += 1;
    failure[i] = k;
  }
  return { text, fold, core, failure };
}

/** A-F as a-f; every other code unit as it is. */
const lowerHex = (code: number): number =>
  code >= 65 && code <= 70 ? code + 32 : code;

/** The form's boundary characters against the text at `at`: exact, or folded at its escape digits. */
function boundaryMatches(
  text: string,
  at: number,
  form: FallbackForm,
  work: { comparisons: number },
): boolean {
  const m = form.text.length;
  if (at < 0 || at + m > text.length) return false;
  for (let k = 0; k < m; k++) {
    if (k === BOUNDARY && m - BOUNDARY > k) k = m - BOUNDARY;
    work.comparisons += 1;
    const a = form.text.charCodeAt(k);
    const b = text.charCodeAt(at + k);
    if (a !== b && (!form.fold[k] || lowerHex(a) !== lowerHex(b))) return false;
  }
  return true;
}

/**
 * Replaces every occurrence of each form, leftmost first, without
 * overlaps. A form matches where each character equals the text's, the
 * hex digits of the form's own escapes in either case; escapes outside a
 * match keep their case. Linear in the text for each form: the core of
 * the form is found by KMP in the text with its escape digits in lower
 * case (inside a match the escapes of both line up, so this compares
 * exactly what the rule says), and the BOUNDARY characters at each end are
 * then compared on their own. `work` counts the character comparisons.
 */
export function replaceFallback(
  text: string,
  forms: readonly FallbackForm[],
  work = { comparisons: 0 },
): string {
  let out = text;
  for (const form of forms) {
    const lowered = lowerEscapes(out);
    const { core, failure } = form;
    let next = "";
    let from = 0;
    const accept = (at: number): boolean => {
      if (at < from || !boundaryMatches(out, at, form, work)) return false;
      next += out.slice(from, at) + REDACTED;
      from = at + form.text.length;
      return true;
    };
    if (core.length === 0) {
      // A form of at most 2 × BOUNDARY characters: every start, O(1) each.
      for (let at = 0; at + form.text.length <= out.length;)
        at = accept(at) ? from : at + 1;
    } else {
      let k = 0;
      for (let i = BOUNDARY; i < out.length; i++) {
        work.comparisons += 1;
        while (k > 0 && lowered[i] !== core[k]) {
          k = failure[k - 1]!;
          work.comparisons += 1;
        }
        if (lowered[i] === core[k]) k += 1;
        if (k < core.length) continue;
        if (accept(i - core.length + 1 - BOUNDARY)) {
          // The next match starts after this one: its core no earlier.
          i = from + BOUNDARY - 1;
          k = 0;
        } else k = failure[k - 1]!;
      }
    }
    if (from > 0) out = next + out.slice(from);
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
  const echoes = rendered.flatMap((body) => echoTargetOf(body) ?? []);
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
      values.length > 0 && pattern === null ? values.map(fallbackForm) : [],
  };
}

export function redactText(text: string, secrets: SecretSet): string {
  // Bodies first: a secret-looking value inside an echoed body must not
  // break the body's match.
  let out = replacePlain(text, secrets.rendered);
  if (secrets.pattern) out = out.replace(secrets.pattern, REDACTED);
  return secrets.fallback.length === 0
    ? out
    : replaceFallback(out, secrets.fallback);
}

/**
 * A parsed body as an echo target. The recursion follows the body, a
 * template bounded in depth and size (CUSTOM_API_BODY_LIMITS).
 */
function echoTarget(value: unknown): EchoTarget {
  if (Array.isArray(value))
    return { kind: "array", items: value.map(echoTarget) };
  if (value !== null && typeof value === "object") {
    const entries = new Map<string, EchoTarget>();
    for (const [key, item] of Object.entries(value))
      entries.set(key, echoTarget(item));
    return { kind: "object", keys: [...entries.keys()], entries };
  }
  return { kind: "scalar", value };
}

/** Whether `value` has exactly `count` own keys; stops counting past it. */
function hasKeyCount(value: object, count: number): boolean {
  let seen = 0;
  for (const key in value)
    if (Object.hasOwn(value, key) && ++seen > count) return false;
  return seen === count;
}

/**
 * Whether a JSON value equals `target`: the same keys in any order, the
 * same items in order. The recursion follows the target, never the
 * response; a container of another size is refused before any item.
 */
function sameJson(value: unknown, target: EchoTarget): boolean {
  if (target.kind === "scalar") return value === target.value;
  if (value === null || typeof value !== "object") return false;
  if (target.kind === "array") {
    if (!Array.isArray(value) || value.length !== target.items.length)
      return false;
    for (let i = 0; i < target.items.length; i++)
      if (!sameJson(value[i], target.items[i]!)) return false;
    return true;
  }
  if (Array.isArray(value) || !hasKeyCount(value, target.keys.length))
    return false;
  for (const key of target.keys)
    if (
      !Object.hasOwn(value, key) ||
      !sameJson(
        (value as Record<string, unknown>)[key],
        target.entries.get(key)!,
      )
    )
      return false;
  return true;
}

/**
 * Whether a value of a response equals a rendered body (#885): an object
 * or array the provider echoed, shown as "[redacted]". Checked node by
 * node by every bounded walk over a response, never by a pass of its own.
 */
export function isEchoedBody(value: unknown, secrets: SecretSet): boolean {
  return matchesEcho(value, secrets.echoes);
}

/** Whether a value equals one of `targets` (see isEchoedBody). */
export function matchesEcho(
  value: unknown,
  targets: readonly EchoTarget[],
): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    targets.some((target) => sameJson(value, target))
  );
}

/**
 * A rendered body as an echo target; null unless it parses to a
 * non-empty object or array (an empty one would match too much).
 */
export function echoTargetOf(rendered: string): EchoTarget | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rendered);
  } catch (caught) {
    rethrowWorkspaceGone(caught);
    return null;
  }
  return parsed !== null &&
    typeof parsed === "object" &&
    Object.keys(parsed).length > 0
    ? echoTarget(parsed)
    : null;
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
    if (isEchoedBody(value, secrets)) return scalar(REDACTED);
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
