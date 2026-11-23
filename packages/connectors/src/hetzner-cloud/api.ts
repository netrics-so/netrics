import {
  RateLimitedError,
  type ConnectorRuntime,
} from "@netrics/connector-sdk";

import { abortableSleep } from "../sleep.js";

/**
 * The Hetzner Cloud API (https://docs.hetzner.cloud/reference/cloud): one
 * host, JSON over HTTPS, an API token per Hetzner project sent as
 * `Authorization: Bearer`. netrics only sends GET requests to the listings
 * it reads (see `assertReadOnly`).
 */
export const HETZNER_HOST = "api.hetzner.cloud";
export const HETZNER_API = `https://${HETZNER_HOST}/v1`;

/**
 * Longest wait for the rate limit within one call. Hetzner refills the
 * hourly budget continuously (3,600 an hour: one request a second), so a
 * short wait usually suffices; a longer one ends the call with a
 * RateLimitedError, and the host runs the connection's jobs again after it.
 */
const MAX_RATE_LIMIT_WAIT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1_000;
/**
 * Pacing: every answer carries `RateLimit-Remaining`. Below this many the
 * client waits for the budget to refill before it sends, so a sync leaves
 * room for the connection check and for the project's own tooling.
 */
export const MIN_REMAINING_REQUESTS = 20;
/** When Hetzner names no reset: try again after this long. */
const DEFAULT_RETRY_MS = 60_000;

export type HetznerErrorKind =
  /** 401 `unauthorized`: the token is wrong or was deleted. */
  | "auth"
  /** 403 `forbidden`: the token may not read this. */
  | "forbidden"
  /** 404 `not_found`: a server (or other resource) that is gone. */
  | "not_found"
  /** 403 `maintenance`, 5xx after retries: try again later. */
  | "unavailable"
  /** 2xx whose body does not have the documented shape. */
  | "invalid"
  /** Any other refused answer. */
  | "other";

/**
 * A refused Hetzner request. Its message is netrics' own fixed text for
 * the status and kind: never the request, the token or Hetzner's response
 * text (which can echo what it was sent). `detail` is netrics' own
 * description of an answer of the wrong shape.
 */
export class HetznerApiError extends Error {
  readonly status: number;
  readonly kind: HetznerErrorKind;

  constructor(status: number, kind: HetznerErrorKind, detail = "") {
    super(describe(status, kind, detail));
    this.name = "HetznerApiError";
    this.status = status;
    this.kind = kind;
  }
}

function describe(
  status: number,
  kind: HetznerErrorKind,
  detail: string,
): string {
  switch (kind) {
    case "auth":
      return "Hetzner Cloud did not accept the API token (401).";
    case "forbidden":
      return "Hetzner Cloud does not let the API token read this (403).";
    case "not_found":
      return "Hetzner Cloud did not find the resource; it may have been deleted (404).";
    case "unavailable":
      return `Hetzner Cloud is not answering right now (${status}). netrics tries again later.`;
    case "invalid":
      return `Hetzner Cloud's answer does not have the expected shape: ${detail.slice(0, 200)}`;
    default:
      return `Hetzner Cloud API answered ${status}.`;
  }
}

/** Hetzner's error body: `{ error: { code, message, details } }`. */
function errorCode(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const error = (json as { error?: unknown }).error;
  if (!error || typeof error !== "object") return "";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}

/**
 * Classifies a refused answer by status and Hetzner's error code
 * (https://docs.hetzner.cloud/reference/cloud#description/errors). The
 * body only classifies: none of its text goes into the error.
 */
export function apiError(status: number, json: unknown): HetznerApiError {
  const code = errorCode(json);
  if (status === 401) return new HetznerApiError(status, "auth");
  if (status === 403) {
    return code === "maintenance"
      ? new HetznerApiError(status, "unavailable")
      : new HetznerApiError(status, "forbidden");
  }
  if (status === 404) return new HetznerApiError(status, "not_found");
  if (status >= 500) return new HetznerApiError(status, "unavailable");
  return new HetznerApiError(status, "other");
}

function header(headers: Record<string, string>, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value.trim();
  }
  return "";
}

/**
 * The rate-limit window an answer reports: `RateLimit-Limit` (requests an
 * hour), `RateLimit-Remaining`, `RateLimit-Reset` (UNIX seconds when the
 * budget is full again). Null without them.
 */
export function rateWindow(
  headers: Record<string, string>,
): { limit: number; remaining: number; resetAt: number | null } | null {
  const limit = Number(header(headers, "ratelimit-limit"));
  const remainingText = header(headers, "ratelimit-remaining");
  const remaining = Number(remainingText);
  if (remainingText === "" || !Number.isFinite(remaining)) return null;
  const reset = header(headers, "ratelimit-reset");
  const resetAt = /^\d+$/.test(reset) ? Number(reset) * 1000 : null;
  return {
    limit: Number.isFinite(limit) && limit > 0 ? limit : 3600,
    remaining,
    resetAt,
  };
}

/**
 * How long until `wanted` more requests are available: Hetzner adds one
 * request every 3,600 / limit seconds. Bounded by the full reset when
 * Hetzner names one.
 */
export function refillMs(
  window: { limit: number; remaining: number; resetAt: number | null },
  wanted: number,
  now: number,
): number {
  const missing = Math.max(0, wanted - window.remaining);
  const refill = Math.ceil((missing * 3_600_000) / window.limit);
  return window.resetAt === null
    ? refill
    : Math.max(0, Math.min(refill, window.resetAt - now));
}

// ─── Read-only guard ────────────────────────────────────────────────────────

const READABLE_PATHS = [
  /^\/pricing$/,
  /^\/servers$/,
  /^\/servers\/\d{1,16}\/metrics$/,
  /^\/volumes$/,
  /^\/primary_ips$/,
  /^\/floating_ips$/,
  /^\/load_balancers$/,
];

/**
 * Refuses anything but the listings netrics reads. Every request is a GET;
 * this guard keeps a future edit from reaching an action endpoint (power,
 * rebuild, delete) by accident.
 */
export function assertReadOnly(path: string): void {
  if (READABLE_PATHS.some((pattern) => pattern.test(path))) return;
  throw new Error(`The Hetzner Cloud connector does not read ${path}`);
}

// ─── Client ─────────────────────────────────────────────────────────────────

export interface ClientOptions {
  /** Waits between retries; replaced in tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

export type HetznerGet = (
  path: string,
  params?: Record<string, string | number>,
) => Promise<unknown>;

/**
 * GET requests against the Hetzner Cloud API through the runtime's
 * allowlisted fetch. Retries server errors and a 429 with a short backoff;
 * a 429 that persists, or a budget that refills later than a short wait,
 * surfaces as RateLimitedError, everything else as HetznerApiError.
 * Returns the parsed JSON.
 */
export function createHetznerClient(
  runtime: ConnectorRuntime,
  token: string,
  options: ClientOptions = {},
): HetznerGet {
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? Date.now;
  let window: ReturnType<typeof rateWindow> = null;

  async function pace(): Promise<void> {
    if (!window || window.remaining >= MIN_REMAINING_REQUESTS) return;
    const wait = refillMs(window, MIN_REMAINING_REQUESTS, now());
    if (wait > MAX_RATE_LIMIT_WAIT_MS) {
      throw new RateLimitedError(
        "Hetzner Cloud's API rate limit is nearly used up. netrics continues once it refills.",
        new Date(now() + wait),
      );
    }
    window = null;
    if (wait > 0) await sleep(wait, runtime.signal);
  }

  return async function get(path, params = {}) {
    assertReadOnly(path);
    const search = new URLSearchParams(
      Object.entries(params).map(([key, value]) => [key, String(value)]),
    ).toString();
    const url = `${HETZNER_API}${path}${search ? `?${search}` : ""}`;
    for (let attempt = 1; ; attempt += 1) {
      await pace();
      const response = await runtime.fetch(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
      });
      window = rateWindow(response.headers) ?? window;

      if (response.status === 429) {
        // Every 429 stays a rate limit: retried briefly here, then handed
        // to the host with a time to come back, never as another error.
        const reported = rateWindow(response.headers);
        const wait = reported
          ? Math.max(1_000, refillMs(reported, 1, now()))
          : BASE_BACKOFF_MS * 2 ** (attempt - 1);
        if (attempt >= MAX_ATTEMPTS || wait > MAX_RATE_LIMIT_WAIT_MS) {
          const retry = reported
            ? Math.max(wait, refillMs(reported, MIN_REMAINING_REQUESTS, now()))
            : DEFAULT_RETRY_MS;
          throw new RateLimitedError(
            "Hetzner Cloud's API rate limit is used up (429). netrics continues once it refills.",
            new Date(now() + Math.max(retry, 1_000)),
          );
        }
        window = null;
        await sleep(wait, runtime.signal);
        continue;
      }
      if (response.status >= 500) {
        if (attempt >= MAX_ATTEMPTS) {
          throw new HetznerApiError(response.status, "unavailable");
        }
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1), runtime.signal);
        continue;
      }

      let json: unknown;
      try {
        json = response.json();
      } catch {
        // Not JSON (a proxy or an outage page): the status alone classifies.
        throw response.status >= 200 && response.status < 300
          ? new HetznerApiError(
              response.status,
              "invalid",
              "the answer was not JSON",
            )
          : apiError(response.status, null);
      }
      if (response.status < 200 || response.status >= 300) {
        throw apiError(response.status, json);
      }
      return json;
    }
  };
}
