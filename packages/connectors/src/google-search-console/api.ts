import type { ConnectorRuntime } from "@netrics/connector-sdk";

import { abortableSleep } from "../sleep.js";

export const SEARCH_CONSOLE_API =
  "https://searchconsole.googleapis.com/webmasters/v3";

/** Longest wait for a rate limit before the call gives up (retried later). */
const MAX_RATE_LIMIT_WAIT_MS = 30_000;
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 1_000;

/**
 * Google's per-minute quota reasons (`error.errors[].reason`). Search
 * Console answers an exhausted short-term quota with 429, older paths with
 * 403 and one of these reasons; both are waited out.
 */
const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
]);
/** Quotas that do not recover within a call: give up, retry the job later. */
const DAILY_QUOTA_REASONS = new Set(["dailyLimitExceeded", "quotaExceeded"]);

export interface GoogleErrorBody {
  /** Google's canonical status, e.g. PERMISSION_DENIED. */
  status?: string;
  /** The first `errors[].reason`, e.g. forbidden or rateLimitExceeded. */
  reason?: string;
  message?: string;
}

function describe(status: number, body: GoogleErrorBody): string {
  if (status === 401) {
    return "Google rejected the access token (401). netrics refreshes it and tries again.";
  }
  if (isQuota(status, body)) {
    return `Search Console's API quota is used up for now (${status}${body.reason ? ` ${body.reason}` : ""}). netrics tries again later.`;
  }
  if (status >= 500) {
    return `Search Console is not answering right now (${status}). netrics tries again later.`;
  }
  const code = body.status ?? body.reason;
  return `Search Console API answered ${status}${code ? ` ${code}` : ""}: ${(body.message ?? "no message").slice(0, 300)}`;
}

function isQuota(status: number, body: GoogleErrorBody): boolean {
  if (status === 429 || body.status === "RESOURCE_EXHAUSTED") return true;
  return (
    status === 403 &&
    body.reason !== undefined &&
    (RATE_LIMIT_REASONS.has(body.reason) ||
      DAILY_QUOTA_REASONS.has(body.reason))
  );
}

/**
 * A non-2xx answer from the Search Console API. Only Google's status,
 * reason and message are kept; the access token travels in a header, never
 * in the URL, so the message cannot carry it.
 *
 * A 401 surfaces with the name "AccessTokenRejectedError" (the name survives
 * the runtime's error redaction): the host's token service treats it as a
 * stale access token, drops the cached one and lets the job retry (ADR 0012).
 */
export class SearchConsoleApiError extends Error {
  readonly status: number;
  readonly body: GoogleErrorBody;

  constructor(status: number, body: GoogleErrorBody) {
    super(describe(status, body));
    this.name =
      status === 401 ? "AccessTokenRejectedError" : "SearchConsoleApiError";
    this.status = status;
    this.body = body;
  }

  /** The access token itself was rejected (expired, revoked). */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /** A per-minute or daily quota, not a permission problem. */
  get isQuota(): boolean {
    return isQuota(this.status, this.body);
  }

  /**
   * The token is valid but may not read this resource: the Google account
   * lost access to the property, or the grant lacks the scope.
   */
  get isPermissionDenied(): boolean {
    return this.status === 403 && !this.isQuota;
  }
}

export function googleErrorBody(json: unknown): GoogleErrorBody {
  if (!json || typeof json !== "object" || !("error" in json)) return {};
  const error = (json as { error: unknown }).error;
  if (!error || typeof error !== "object") return {};
  const { status, message, errors } = error as Record<string, unknown>;
  let reason: string | undefined;
  if (Array.isArray(errors)) {
    const first: unknown = errors[0];
    if (first && typeof first === "object") {
      const value = (first as Record<string, unknown>).reason;
      if (typeof value === "string") reason = value;
    }
  }
  return {
    ...(typeof status === "string" ? { status } : {}),
    ...(typeof message === "string" ? { message } : {}),
    ...(reason ? { reason } : {}),
  };
}

export interface ClientOptions {
  /** Waits between retries; replaced in tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

/** How long to wait before retrying a rate limit, or null to give up. */
function rateLimitWait(
  headers: Record<string, string>,
  body: GoogleErrorBody,
  attempt: number,
): number | null {
  if (body.reason && DAILY_QUOTA_REASONS.has(body.reason)) return null;
  const retryAfter = Number(headers["retry-after"]);
  if (headers["retry-after"] !== undefined && Number.isFinite(retryAfter)) {
    const ms = Math.max(0, retryAfter) * 1000;
    return ms <= MAX_RATE_LIMIT_WAIT_MS ? ms : null;
  }
  return BASE_BACKOFF_MS * 2 ** (attempt - 1);
}

export interface SearchConsoleClient {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

/**
 * Calls the Search Console API through the runtime's allowlisted fetch.
 * Retries rate limits (429, or 403 with a per-minute quota reason) and
 * server errors with exponential backoff; everything else surfaces as
 * SearchConsoleApiError.
 */
export function createSearchConsoleClient(
  runtime: ConnectorRuntime,
  accessToken: string,
  options: ClientOptions = {},
): SearchConsoleClient {
  const sleep = options.sleep ?? abortableSleep;

  async function call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const url = `${SEARCH_CONSOLE_API}${path}`;
    for (let attempt = 1; ; attempt += 1) {
      const response = await runtime.fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status >= 200 && response.status < 300) {
        return response.json();
      }
      let errorBody: GoogleErrorBody = {};
      try {
        errorBody = googleErrorBody(response.json());
      } catch {
        // Non-JSON error page (proxy, outage): status alone classifies it.
      }
      const error = new SearchConsoleApiError(response.status, errorBody);
      if (attempt >= MAX_ATTEMPTS) throw error;
      if (error.isQuota) {
        const wait = rateLimitWait(response.headers, errorBody, attempt);
        if (wait === null) throw error;
        await sleep(wait, runtime.signal);
        continue;
      }
      if (response.status >= 500) {
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1), runtime.signal);
        continue;
      }
      throw error;
    }
  }

  return {
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body),
  };
}
