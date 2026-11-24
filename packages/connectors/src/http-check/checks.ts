// The checks of an HTTP check connection (#874): read from the connection's
// configuration, validated beyond the config schema (URLs, names, expected
// statuses, headers), each with a stable resource id.

import { createHash } from "node:crypto";

import { ConnectorError, configuredUrlHost } from "@netrics/connector-sdk";

/** Checks per connection: at most this many requests per run. */
export const MAX_CHECKS = 20;
/** A check's own time limit, in seconds: at most, and by default. */
export const MAX_TIMEOUT_SECONDS = 10;
/** Bytes of a body read to look for the expected text. */
export const MAX_BODY_BYTES = 1024 * 1024;
/** Request headers per check. */
export const MAX_HEADERS = 10;
/** The expected status when a check names none: any success or redirect. */
export const DEFAULT_EXPECTED_STATUS = "200-399";
export const MAX_NAME_LENGTH = 100;
export const MAX_URL_LENGTH = 2048;
export const MAX_TEXT_LENGTH = 200;
const MAX_HEADER_VALUE_LENGTH = 500;
const MAX_STATUS_PARTS = 10;

export type CheckMethod = "GET" | "HEAD";

export interface HttpCheck {
  /** The resource id: stable while the name stays (see checkId). */
  id: string;
  name: string;
  url: string;
  /** The URL's host, as the egress allowlist holds it. */
  host: string;
  method: CheckMethod;
  /** As configured ("200-399"), for the snapshot. */
  expectedStatus: string;
  /** Inclusive [low, high] status ranges any of which counts as up. */
  statusRanges: Array<[number, number]>;
  expectedText: string | null;
  timeoutMs: number;
  headers: Record<string, string>;
}

// ─── Reason codes of a failed check (#795) ─────────────────────────────────

export const NO_CHECKS_CODE = "http_check.no_checks";
export const NO_CHECKS_MESSAGE = `Add at least one check, and at most ${MAX_CHECKS}.`;
export const URL_INVALID_CODE = "http_check.url_invalid";
export const URL_INVALID_MESSAGE =
  "Every check needs an https URL whose host is a full domain name or an IP address, without a user name or password, of at most 2,048 characters.";
export const URL_SECRET_CODE = "http_check.url_secret";
export const URL_SECRET_MESSAGE =
  "A check URL cannot carry a secret in its query (a key, token, signature, password or similar parameter, as in a signed URL): the configuration is not encrypted and everyone in the workspace sees it. Checks that need a credential are not supported yet.";
export const NAME_DUPLICATE_CODE = "http_check.name_duplicate";
export const NAME_DUPLICATE_MESSAGE =
  "Every check needs a name, and a name of its own: two checks in a connection cannot share one.";
export const STATUS_INVALID_CODE = "http_check.status_invalid";
export const STATUS_INVALID_MESSAGE =
  "Expected status: a code (200), a range (200-299), a class (2xx), or up to ten of them separated by commas, all between 100 and 599.";
export const TEXT_INVALID_CODE = "http_check.text_invalid";
export const TEXT_INVALID_MESSAGE =
  "Expected text works only with GET: a HEAD request has no body to look in.";
export const HEADERS_INVALID_CODE = "http_check.headers_invalid";
export const HEADERS_INVALID_MESSAGE =
  "Request headers: one “Name: value” per line, at most ten. Headers that carry secrets (Authorization, Cookie, or a name with key, token, secret, auth, session, password or signature) and Host, Content-Length, Connection and Transfer-Encoding are not allowed: the configuration is not encrypted.";

/** A configuration the checks cannot run with; its code names why. */
export class HttpCheckConfigError extends ConnectorError {
  constructor(message: string, code: string) {
    super(message, code);
    this.name = "HttpCheckConfigError";
  }
}

// ─── Parsing ────────────────────────────────────────────────────────────────

/**
 * The resource id of a check: a hash of its name (trimmed, case-folded),
 * so it stays while the URL or the expectations change and the check keeps
 * its project links; renaming a check makes it another resource.
 */
export function checkId(name: string): string {
  return `check-${createHash("sha256")
    .update(name.trim().toLowerCase())
    .digest("hex")
    .slice(0, 16)}`;
}

/** "200", "200-299", "2xx", "200, 301-302" → ranges, or null. */
export function parseExpectedStatus(
  value: string,
): Array<[number, number]> | null {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0 || parts.length > MAX_STATUS_PARTS) return null;
  const ranges: Array<[number, number]> = [];
  for (const part of parts) {
    let range: [number, number] | null = null;
    const single = /^(\d{3})$/.exec(part);
    const span = /^(\d{3})\s*-\s*(\d{3})$/.exec(part);
    const klass = /^([1-5])xx$/i.exec(part);
    if (single) range = [Number(single[1]), Number(single[1])];
    else if (span) range = [Number(span[1]), Number(span[2])];
    else if (klass)
      range = [Number(klass[1]) * 100, Number(klass[1]) * 100 + 99];
    if (!range || range[0] < 100 || range[1] > 599 || range[0] > range[1])
      return null;
    ranges.push(range);
  }
  return ranges;
}

/**
 * Query parameter names that carry credentials (#874 review): API keys,
 * tokens, signatures of signed URLs (`sig`, AWS `X-Amz-*`, Google
 * `X-Goog-*`), passwords and sessions. Case-insensitive, by part of the
 * name, so `api_key`, `apiKey` and `access_token` are refused too.
 */
const SECRET_QUERY =
  /key|token|secret|passw|pwd|auth|sig|credential|session|jwt|^code$|^x-amz-|^x-goog-/i;

/** Whether a URL's query names a parameter that carries a credential. */
export function querySecret(url: URL): boolean {
  for (const name of url.searchParams.keys()) {
    if (SECRET_QUERY.test(name)) return true;
  }
  return false;
}

/** Header names refused in the (unencrypted) configuration. */
const SECRET_HEADER =
  /auth|token|key|secret|cookie|session|password|signature/i;
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "te",
  "upgrade",
  "keep-alive",
  "proxy-connection",
  "expect",
]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;

/** "Name: value" lines → headers, or null when one is not allowed. */
export function parseHeaders(value: string): Record<string, string> | null {
  const headers: Record<string, string> = {};
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length > MAX_HEADERS) return null;
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) return null;
    const name = line.slice(0, colon).trim();
    const headerValue = line.slice(colon + 1).trim();
    const lower = name.toLowerCase();
    if (
      !HEADER_NAME.test(name) ||
      SECRET_HEADER.test(name) ||
      RESERVED_HEADERS.has(lower) ||
      Object.hasOwn(headers, lower) ||
      headerValue.length > MAX_HEADER_VALUE_LENGTH ||
      // Visible ASCII and spaces only: no control characters.
      !/^[\x20-\x7e]*$/.test(headerValue)
    )
      return null;
    headers[lower] = headerValue;
  }
  return headers;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The connection's checks, or an HttpCheckConfigError with a reason code.
 * The config schema has already bounded types and lengths when the host
 * validated it; this reads it again, defensively, and checks the rest.
 */
export function readChecks(config: Record<string, unknown>): HttpCheck[] {
  const raw = config.checks;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_CHECKS) {
    throw new HttpCheckConfigError(NO_CHECKS_MESSAGE, NO_CHECKS_CODE);
  }
  const checks: HttpCheck[] = [];
  const ids = new Set<string>();
  for (const item of raw) {
    const entry =
      item && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : {};
    const name = text(entry.name);
    const url = text(entry.url);
    const host = configuredUrlHost(url);
    if (name === "" || name.length > MAX_NAME_LENGTH) {
      throw new HttpCheckConfigError(
        NAME_DUPLICATE_MESSAGE,
        NAME_DUPLICATE_CODE,
      );
    }
    if (host === null || url.length > MAX_URL_LENGTH) {
      throw new HttpCheckConfigError(URL_INVALID_MESSAGE, URL_INVALID_CODE);
    }
    if (querySecret(new URL(url))) {
      throw new HttpCheckConfigError(URL_SECRET_MESSAGE, URL_SECRET_CODE);
    }
    const id = checkId(name);
    if (ids.has(id)) {
      throw new HttpCheckConfigError(
        NAME_DUPLICATE_MESSAGE,
        NAME_DUPLICATE_CODE,
      );
    }
    ids.add(id);
    const method: CheckMethod = entry.method === "HEAD" ? "HEAD" : "GET";
    const expectedStatus =
      text(entry.expectedStatus) || DEFAULT_EXPECTED_STATUS;
    const statusRanges = parseExpectedStatus(expectedStatus);
    if (!statusRanges) {
      throw new HttpCheckConfigError(
        STATUS_INVALID_MESSAGE,
        STATUS_INVALID_CODE,
      );
    }
    const expectedText = text(entry.expectedText);
    if (
      expectedText.length > MAX_TEXT_LENGTH ||
      (expectedText !== "" && method === "HEAD")
    ) {
      throw new HttpCheckConfigError(TEXT_INVALID_MESSAGE, TEXT_INVALID_CODE);
    }
    const headers = parseHeaders(
      typeof entry.headers === "string" ? entry.headers : "",
    );
    if (!headers) {
      throw new HttpCheckConfigError(
        HEADERS_INVALID_MESSAGE,
        HEADERS_INVALID_CODE,
      );
    }
    const seconds =
      typeof entry.timeoutSeconds === "number" &&
      Number.isInteger(entry.timeoutSeconds) &&
      entry.timeoutSeconds >= 1
        ? Math.min(entry.timeoutSeconds, MAX_TIMEOUT_SECONDS)
        : MAX_TIMEOUT_SECONDS;
    // The fragment never leaves the client; dropping it keeps one URL one check.
    const parsed = new URL(url);
    parsed.hash = "";
    checks.push({
      id,
      name,
      url: parsed.toString(),
      host,
      method,
      expectedStatus,
      statusRanges,
      expectedText: expectedText === "" ? null : expectedText,
      timeoutMs: seconds * 1000,
      headers,
    });
  }
  return checks;
}

/**
 * What a check's results depend on, hashed: the URL, method, expectations,
 * time limit and headers. A previous state counts for a check only while
 * this stays the same.
 */
export function checkFingerprint(check: HttpCheck): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        check.url,
        check.method,
        check.statusRanges,
        check.expectedText,
        check.timeoutMs,
        Object.entries(check.headers).sort(),
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}

/** The URL as the snapshot shows it: without query, which may carry values. */
export function displayUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}
