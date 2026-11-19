import {
  RateLimitedError,
  type ConnectorRuntime,
} from "@netrics/connector-sdk";

import { abortableSleep } from "../sleep.js";

export const VERCEL_API = "https://api.vercel.com";

/**
 * Longest wait for a rate-limit reset within one call. A later reset ends
 * the call with a RateLimitedError: the host runs the connection's jobs
 * again after the reset (#781).
 */
const MAX_RATE_LIMIT_WAIT_MS = 30_000;
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 500;
/**
 * Pacing (#781): Vercel reports the rest of the current window with every
 * answer (`x-ratelimit-remaining`, `x-ratelimit-reset`). Below this many
 * requests left, the client stops before Vercel answers 429 and waits for
 * the reset (or hands it to the host), so a first backfill of many projects
 * never runs into the limit and the window is left for the connection's
 * own checks.
 */
export const MIN_REMAINING_REQUESTS = 5;

/**
 * A non-2xx answer from the Vercel API. Only Vercel's own error code and
 * message are kept; the request never carries the token in its URL, so the
 * message cannot leak it.
 */
function describe(
  status: number,
  body: { code?: string; message?: string },
): string {
  if (status === 429) {
    return "Vercel's API rate limit is used up for now (429). netrics tries again later.";
  }
  if (status >= 500) {
    return `Vercel is not answering right now (${status}). netrics tries again later.`;
  }
  return `Vercel API answered ${status}${body.code ? ` ${body.code}` : ""}: ${body.message ?? "no message"}`;
}

export class VercelApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly invalidToken: boolean;

  constructor(
    status: number,
    body: { code?: string; message?: string; invalidToken?: boolean },
  ) {
    super(describe(status, body));
    this.name = "VercelApiError";
    this.status = status;
    this.code = body.code;
    this.invalidToken = body.invalidToken === true;
  }

  /** The token itself was rejected (expired, revoked, malformed). */
  get isAuth(): boolean {
    return this.status === 401 || (this.status === 403 && this.invalidToken);
  }
}

export type Query = Record<string, string | string[] | undefined>;

export interface ClientOptions {
  /** Waits between retries; replaced in tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

function buildUrl(path: string, query: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      params.append(key, item);
    }
  }
  const search = params.toString();
  return `${VERCEL_API}${path}${search ? `?${search}` : ""}`;
}

function errorBody(json: unknown): {
  code?: string;
  message?: string;
  invalidToken?: boolean;
} {
  if (json && typeof json === "object" && "error" in json) {
    const error = (json as { error: unknown }).error;
    if (error && typeof error === "object") {
      const { code, message, invalidToken } = error as Record<string, unknown>;
      return {
        ...(typeof code === "string" ? { code } : {}),
        ...(typeof message === "string" ? { message } : {}),
        ...(invalidToken === true ? { invalidToken: true } : {}),
      };
    }
  }
  return {};
}

/**
 * When the limit resets, in ms since the epoch: `retry-after` (seconds or
 * an HTTP date), else `x-ratelimit-reset` (UTC epoch seconds). Null when
 * Vercel says neither.
 */
export function rateLimitReset(
  headers: Record<string, string>,
  now: number,
): number | null {
  const retryAfter = headers["retry-after"]?.trim();
  if (retryAfter) {
    if (/^\d+$/.test(retryAfter)) return now + Number(retryAfter) * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(now, date);
  }
  const reset = Number(headers["x-ratelimit-reset"]);
  if (Number.isFinite(reset) && reset > 0) return Math.max(now, reset * 1000);
  return null;
}

function rateLimited(message: string, resetAt: number): RateLimitedError {
  return new RateLimitedError(message, new Date(resetAt));
}

/**
 * A GET against the Vercel API through the runtime's allowlisted fetch.
 * Retries rate limits (when the reset is near) and server errors with
 * exponential backoff. A rate limit with a later reset, or a window that
 * is nearly used up until a later reset, surfaces as RateLimitedError;
 * everything else as VercelApiError.
 */
export function createVercelClient(
  runtime: ConnectorRuntime,
  token: string,
  options: ClientOptions = {},
) {
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? Date.now;
  /** The window as Vercel last reported it. */
  let window: { remaining: number; resetAt: number } | null = null;

  /** Stops before the window runs out: waits for a near reset, else defers. */
  async function pace(): Promise<void> {
    if (!window || window.remaining >= MIN_REMAINING_REQUESTS) return;
    const { remaining, resetAt } = window;
    const wait = resetAt - now();
    if (wait > MAX_RATE_LIMIT_WAIT_MS) {
      throw rateLimited(
        `Vercel's API rate limit is nearly used up (${remaining} requests left). netrics continues after the reset.`,
        resetAt,
      );
    }
    window = null;
    if (wait > 0) await sleep(wait, runtime.signal);
  }

  return async function get(path: string, query: Query = {}): Promise<unknown> {
    const url = buildUrl(path, query);
    for (let attempt = 1; ; attempt += 1) {
      await pace();
      const response = await runtime.fetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
      });
      const remaining = Number(response.headers["x-ratelimit-remaining"]);
      const resetAt = rateLimitReset(
        { "x-ratelimit-reset": response.headers["x-ratelimit-reset"] ?? "" },
        now(),
      );
      if (
        response.headers["x-ratelimit-remaining"] !== undefined &&
        Number.isFinite(remaining) &&
        resetAt !== null
      ) {
        window = { remaining, resetAt };
      }
      if (response.status >= 200 && response.status < 300) {
        return response.json();
      }
      let body: ReturnType<typeof errorBody> = {};
      try {
        body = errorBody(response.json());
      } catch {
        // Non-JSON error page (proxy, outage): status alone classifies it.
      }
      const error = new VercelApiError(response.status, body);
      if (response.status === 429) {
        const reset = rateLimitReset(response.headers, now());
        const wait = reset === null ? BASE_BACKOFF_MS : reset - now();
        if (
          reset !== null &&
          (wait > MAX_RATE_LIMIT_WAIT_MS || attempt >= MAX_ATTEMPTS)
        ) {
          // The host waits for the reset instead of retrying (#781).
          throw rateLimited(
            "Vercel's API rate limit is used up (429). netrics continues after the reset.",
            reset,
          );
        }
        if (attempt >= MAX_ATTEMPTS) throw error;
        window = null;
        await sleep(wait, runtime.signal);
        continue;
      }
      if (attempt >= MAX_ATTEMPTS) throw error;
      if (response.status >= 500) {
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1), runtime.signal);
        continue;
      }
      throw error;
    }
  };
}

export type VercelGet = ReturnType<typeof createVercelClient>;
