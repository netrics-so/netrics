// The test response of the custom API builder (milestone 13, #806), made
// safe to return: every string (keys and values) is redacted by value with
// the draft's secrets, raw and URL-encoded, and the body is bounded in
// array length, string length, depth and serialized size. Pure. Key-based
// redaction (redactSecrets) is deliberately not applied: API data has keys
// like "keyword" or "token_count" whose values are not secrets.

export const CUSTOM_API_TEST_LIMITS = {
  maxPages: 5,
  maxRecords: 1_000,
  totalMs: 60_000,
  previewBytes: 262_144,
  arrayItems: 50,
  stringChars: 2_000,
  depth: 32,
  rows: 100,
} as const;

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const REDACTED = "[redacted]";
/** Shorter values would over-redact; real secrets are never this short. */
const MIN_SECRET_LENGTH = 4;

/** Raw and URL-encoded forms of every secret, each at least 4 characters, longest first. */
export interface SecretSet {
  values: readonly string[];
}

function collect(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    if (value.length < MIN_SECRET_LENGTH) return;
    into.add(value);
    into.add(encodeURIComponent(value));
    // application/x-www-form-urlencoded (URLSearchParams): spaces as "+".
    into.add(new URLSearchParams({ v: value }).toString().slice(2));
    return;
  }
  if (Array.isArray(value)) for (const item of value) collect(item, into);
  else if (value !== null && typeof value === "object")
    for (const item of Object.values(value)) collect(item, into);
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
  const values = new Set<string>();
  const { host: _host, ...secrets } = credentials;
  collect(secrets, values);
  collect(secretVariables, values);
  collect([...extra], values);
  return {
    values: [...values]
      .filter((value) => value.length >= MIN_SECRET_LENGTH)
      .sort((a, b) => b.length - a.length),
  };
}

export function redactText(text: string, secrets: SecretSet): string {
  let out = text;
  for (const secret of secrets.values)
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  return out;
}

/** Redacts secrets in a URL, also strips userinfo; a URL that does not parse is redacted as text. */
export function redactUrl(url: string, secrets: SecretSet): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return redactText(url, secrets);
  }
  parsed.username = "";
  parsed.password = "";
  return redactText(parsed.href, secrets).replaceAll(
    "%5Bredacted%5D",
    REDACTED,
  );
}

interface CutArray {
  node: JsonValue[];
  items: JsonValue[];
  /** Length of the array in the response. */
  total: number;
  kept: number;
}

function arrayMarker(omitted: number): string {
  return `… ${omitted} more`;
}

/** Redacts every string (keys and values), truncates arrays/strings/depth, then cuts to previewBytes. */
export function boundedPreview(
  body: unknown,
  secrets: SecretSet,
): {
  body: JsonValue;
  truncated: boolean;
  omitted: { arrays: number; strings: number; depth: number };
} {
  const limits = CUSTOM_API_TEST_LIMITS;
  const omitted = { arrays: 0, strings: 0, depth: 0 };
  const arrays: CutArray[] = [];

  const text = (value: string): string => {
    const clean = redactText(value, secrets);
    if (clean.length <= limits.stringChars) return clean;
    omitted.strings += 1;
    return `${clean.slice(0, limits.stringChars)}… (${value.length} characters)`;
  };

  const walk = (value: unknown, depth: number): JsonValue => {
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") return text(value);
    if (typeof value !== "object") return null;
    if (depth >= limits.depth) {
      omitted.depth += 1;
      return "… (nested deeper)";
    }
    if (Array.isArray(value)) {
      const items = value
        .slice(0, limits.arrayItems)
        .map((item) => walk(item, depth + 1));
      const node: JsonValue[] = [...items];
      if (value.length > items.length) {
        omitted.arrays += 1;
        node.push(arrayMarker(value.length - items.length));
      }
      arrays.push({
        node,
        items,
        total: value.length,
        kept: items.length,
      });
      return node;
    }
    const out: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value)) {
      const safeKey = text(key);
      if (safeKey === "__proto__") continue;
      out[safeKey] = walk((value as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  };

  let result = walk(body, 0);
  const size = () => Buffer.byteLength(JSON.stringify(result), "utf8");
  let cut = false;
  while (size() > limits.previewBytes) {
    const largest = arrays
      .filter((entry) => entry.kept > 0)
      .sort((a, b) => b.kept - a.kept)[0];
    if (!largest) {
      result = "… (response too large to show)";
      cut = true;
      break;
    }
    largest.kept = Math.floor(largest.kept / 2);
    largest.node.splice(
      0,
      largest.node.length,
      ...largest.items.slice(0, largest.kept),
      arrayMarker(largest.total - largest.kept),
    );
    cut = true;
  }
  return {
    body: result,
    truncated: cut || omitted.arrays + omitted.strings + omitted.depth > 0,
    omitted,
  };
}
