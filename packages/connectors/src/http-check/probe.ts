// One request of one check (#874). A check that fails is a result with a
// fixed reason code, never an error of the sync, and never quotes what the
// checked site answered: its body is only searched for the expected text.

import type { ConnectorRuntime } from "@netrics/connector-sdk";

import { MAX_BODY_BYTES, type HttpCheck } from "./checks.js";

/**
 * Why a check is down:
 *
 * - `timeout`: no answer within the check's time limit;
 * - `dns`: the host name does not resolve;
 * - `tls`: the TLS handshake or the certificate failed;
 * - `refused`: the host refused the connection;
 * - `connection`: the connection failed otherwise (reset, unreachable);
 * - `unexpected_status`: an answer with another status than expected;
 * - `text_missing`: the expected text is not in the body;
 * - `too_large`: the body is larger than netrics reads (1 MiB);
 * - `redirect`: a redirect to another host, or more than three;
 * - `egress_refused`: netrics may not reach the address (a private,
 *   loopback or metadata address, unless this instance allows it).
 */
export const DOWN_REASONS = [
  "timeout",
  "dns",
  "tls",
  "refused",
  "connection",
  "unexpected_status",
  "text_missing",
  "too_large",
  "redirect",
  "egress_refused",
] as const;
export type DownReason = (typeof DOWN_REASONS)[number];

export interface ProbeResult {
  up: boolean;
  reason: DownReason | null;
  /** The answer's status, when one came. */
  status: number | null;
  /** Milliseconds until the answer (with its body when it was read). */
  responseMs: number | null;
}

/** The product token netrics checks with; no version, no instance. */
export const USER_AGENT = "netrics-http-check/1";

const DNS_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_NODATA",
  "EAI_NONAME",
  "EAI_FAIL",
]);
const REFUSED_CODES = new Set(["ECONNREFUSED"]);
const TIMEOUT_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ETIMEDOUT",
]);

function isTlsCode(code: string): boolean {
  return (
    code.startsWith("ERR_TLS") ||
    code.startsWith("ERR_SSL") ||
    code.includes("CERT") ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" ||
    code === "EPROTO"
  );
}

/** The error, its causes, at most four deep. */
function chain(error: unknown): Array<{
  name?: unknown;
  code?: unknown;
  reason?: unknown;
  message?: unknown;
}> {
  const links = [];
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 4 && current && typeof current === "object";
    depth += 1
  ) {
    links.push(
      current as {
        name?: unknown;
        code?: unknown;
        reason?: unknown;
        message?: unknown;
      },
    );
    current = (current as { cause?: unknown }).cause;
  }
  return links;
}

/**
 * The reason a request failed for, read from the runtime's error names and
 * reasons (SDK 0.2.21) and the network error codes; never its message
 * text, except the runtime's fixed "no address" of a name without one.
 */
export function failureReason(error: unknown): DownReason {
  for (const link of chain(error)) {
    if (link.name === "EgressTimeoutError") return "timeout";
    if (link.name === "EgressDeniedError") {
      switch (link.reason) {
        case "size":
          return "too_large";
        case "redirects":
        case "redirect_host":
          return "redirect";
        default:
          return "egress_refused";
      }
    }
    const code = typeof link.code === "string" ? link.code : "";
    if (DNS_CODES.has(code)) return "dns";
    if (REFUSED_CODES.has(code)) return "refused";
    if (TIMEOUT_CODES.has(code)) return "timeout";
    if (code !== "" && isTlsCode(code)) return "tls";
    if (
      typeof link.message === "string" &&
      link.message.startsWith("no address for ")
    ) {
      return "dns";
    }
  }
  return "connection";
}

export function statusExpected(check: HttpCheck, status: number): boolean {
  return check.statusRanges.some(
    ([low, high]) => status >= low && status <= high,
  );
}

/**
 * Requests a check once. Throws only when the run itself is over (the
 * host aborted the call); every other failure is a down result.
 */
export async function probe(
  check: HttpCheck,
  runtime: ConnectorRuntime,
  clock: () => number,
): Promise<ProbeResult> {
  const readBody = check.expectedText !== null;
  const started = clock();
  try {
    const response = await runtime.fetch(check.url, {
      method: check.method,
      headers: {
        ...check.headers,
        "user-agent": USER_AGENT,
        "cache-control": "no-cache",
      },
      timeoutMs: check.timeoutMs,
      ...(readBody
        ? { maxResponseBytes: MAX_BODY_BYTES }
        : { discardBody: true }),
    });
    const responseMs = Math.max(0, Math.round(clock() - started));
    const status = response.status;
    if (!statusExpected(check, status)) {
      return { up: false, reason: "unexpected_status", status, responseMs };
    }
    if (readBody && !response.text().includes(check.expectedText!)) {
      return { up: false, reason: "text_missing", status, responseMs };
    }
    return { up: true, reason: null, status, responseMs };
  } catch (error) {
    if (runtime.signal.aborted) throw error;
    return {
      up: false,
      reason: failureReason(error),
      status: null,
      responseMs: null,
    };
  }
}
