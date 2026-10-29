import type {
  ConnectorFetchInit,
  ConnectorResponse,
} from "@netrics/connector-sdk";
import { z } from "zod";

import { abortableSleep } from "../sleep.js";

// The Apple Ads Platform API 1.0 client (ADR 0020 sections 1, 5 and 9):
// https://api.ads.apple.com/v1, a bearer access token the host exchanged,
// and `X-AP-Context: adAccountId=<id>` on every ad-account-scoped call.
//
// Apple's documentation, checked 2026-10-29:
// - Calling the API (headers, `result`/`pagination`/`error` envelopes, the
//   error table 400 bad_request, 401 unauthorized, 403 forbidden, 404
//   not_found, 429 rate_limit_exceeded, 500 internal_server_error):
//   https://developer.apple.com/documentation/apple-ads-platform-api/calling-apple-ads-platform-api
// - Error and ErrorResponse (`{error:{code,message,details[]}}`):
//   https://developer.apple.com/documentation/apple-ads-platform-api/error
//   https://developer.apple.com/documentation/apple-ads-platform-api/errorresponse
// - Rate limits (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`
//   on every response; `Retry-After` on a 429; both in seconds):
//   https://developer.apple.com/documentation/apple-ads-platform-api/rate-limits

export const APPLE_ADS_HOST = "api.ads.apple.com";
export const APPLE_ADS_API = `https://${APPLE_ADS_HOST}`;

/**
 * Below this many requests left in the current window (`RateLimit-
 * Remaining`), the client stops before Apple answers 429 and the job
 * retries later. Apple publishes no quota (ADR 0020 section 9); its own
 * sample client pauses below 5. TO BE CONFIRMED by #370: the
 * `RateLimit-Limit` values seen in practice.
 */
export const MIN_REMAINING_REQUESTS = 5;

/** Longest `Retry-After` the client waits for within one call. */
export const MAX_RETRY_AFTER_SECONDS = 20;
/** Attempts per request (429 within MAX_RETRY_AFTER_SECONDS, 5xx). */
export const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;

/** HTTPS with the provider's allowlist: runtime.fetch, or a probe's fetch. */
export type AppleAdsFetch = (
  url: string,
  init?: ConnectorFetchInit,
) => Promise<ConnectorResponse>;

/** Apple's `Error`: the request-level code and message, and the first detail. */
export interface AppleAdsErrorBody {
  code?: string;
  message?: string;
  detailCode?: string;
  detailMessage?: string;
}

const errorSchema = z.object({
  error: z
    .object({
      code: z.string().optional(),
      message: z.string().nullable().optional(),
      details: z
        .array(
          z
            .object({
              code: z.string().optional(),
              message: z.string().nullable().optional(),
            })
            .loose(),
        )
        .nullable()
        .optional(),
    })
    .loose(),
});

/** Apple's error envelope of a response, or {} for anything else. */
export function appleAdsErrorBody(
  response: ConnectorResponse,
): AppleAdsErrorBody {
  let json: unknown;
  try {
    json = response.json();
  } catch {
    // An HTML error page (proxy, outage): the status alone classifies it.
    return {};
  }
  const parsed = errorSchema.safeParse(json);
  if (!parsed.success) return {};
  const { code, message, details } = parsed.data.error;
  const detail = details?.[0];
  return {
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
    ...(detail?.code ? { detailCode: detail.code } : {}),
    ...(detail?.message ? { detailMessage: detail.message } : {}),
  };
}

/** Apple's own words, bounded; the runtime redacts credential values. */
function appleText(body: AppleAdsErrorBody): string {
  const code = [body.code, body.detailCode].filter(Boolean).join("/");
  const text = [body.message, body.detailMessage].filter(Boolean).join(": ");
  return [code, text].filter(Boolean).join(" ").slice(0, 300);
}

function describe(status: number, body: AppleAdsErrorBody): string {
  const text = appleText(body);
  const suffix = text ? ` (${text})` : "";
  if (status === 401) {
    return `Apple Ads refused the access token (401)${suffix}.`;
  }
  if (status === 403) {
    return `Apple Ads refused access (403)${suffix}: the API user needs an API role in this ad account. A non-API role removes API access.`;
  }
  if (status === 429) {
    return `Apple Ads' request limit is used up (429)${suffix}. netrics tries again later.`;
  }
  if (status >= 500) {
    return `Apple Ads is not answering right now (${status}). netrics tries again later.`;
  }
  return `Apple Ads API answered ${status}${text ? `: ${text}` : ""}`;
}

/**
 * A non-2xx answer of the Apple Ads API. Only Apple's status, code and
 * message are kept; the token travels in a header, never in the URL.
 *
 * A 401 surfaces with the name "AccessTokenRejectedError" (the name survives
 * the runtime's error redaction): the host drops the cached access token
 * and retries once with a fresh exchange; a second 401 is auth_failed (ADR
 * 0020 section 2). A 403 is auth_failed with the provider's role message
 * (the host sees the status). 429 and 5xx are retryable provider failures.
 */
export class AppleAdsApiError extends Error {
  readonly status: number;
  readonly body: AppleAdsErrorBody;
  /** `Retry-After` of a 429 in seconds, when Apple sent one. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    status: number,
    body: AppleAdsErrorBody,
    retryAfterSeconds?: number,
  ) {
    super(describe(status, body));
    this.name =
      status === 401 ? "AccessTokenRejectedError" : "AppleAdsApiError";
    this.status = status;
    this.body = body;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  /** 429 or 5xx: try again later. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/**
 * The current rate-limit window is nearly used up (`RateLimit-Remaining`
 * below the threshold): a retryable failure, so a sync ends early and the
 * job comes back after the window reset.
 */
export class AppleAdsRateBudgetError extends Error {
  readonly remaining: number;
  /** `RateLimit-Reset` in seconds, when Apple sent one. */
  readonly resetSeconds: number | undefined;

  constructor(remaining: number, resetSeconds?: number) {
    super(
      `Apple Ads' request limit is nearly used up (${remaining} left${
        resetSeconds !== undefined ? `, resets in ${resetSeconds} s` : ""
      }). netrics tries again later.`,
    );
    this.name = "AppleAdsRateBudgetError";
    this.remaining = remaining;
    this.resetSeconds = resetSeconds;
  }
}

function headerOf(
  response: ConnectorResponse,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(response.headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/** A non-negative integer header (seconds or a count), else undefined. */
function seconds(value: string | undefined): number | undefined {
  if (value === undefined || !/^\s*\d{1,9}\s*$/.test(value)) return undefined;
  return Number(value);
}

export interface RateLimit {
  limit?: number;
  remaining?: number;
  resetSeconds?: number;
}

/** `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`. */
export function parseRateLimit(response: ConnectorResponse): RateLimit {
  const limit = seconds(headerOf(response, "ratelimit-limit"));
  const remaining = seconds(headerOf(response, "ratelimit-remaining"));
  const resetSeconds = seconds(headerOf(response, "ratelimit-reset"));
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(resetSeconds !== undefined ? { resetSeconds } : {}),
  };
}

/** `Retry-After` in seconds (Apple sends a delta, not an HTTP date). */
export function retryAfterSeconds(
  response: ConnectorResponse,
): number | undefined {
  return seconds(headerOf(response, "retry-after"));
}

/** Apple IDs (int64): digits only, so a header or path cannot be forged. */
const AD_ACCOUNT_ID = /^\d{1,19}$/;

export function isAdAccountId(value: unknown): value is string {
  return typeof value === "string" && AD_ACCOUNT_ID.test(value);
}

export interface AppleAdsRequestOptions {
  /**
   * The ad account of an ad-account-scoped call: sent as `X-AP-Context:
   * adAccountId=<id>`. Left out for `/v1/me`, `/v1/acls` and `/v1/orgs`,
   * which take no context.
   */
  adAccountId?: string;
  /** A JSON body: the request is a POST (the `/query` endpoints). */
  body?: unknown;
}

export interface AppleAdsClientOptions {
  /**
   * Waits for a 429's Retry-After and between 5xx attempts; the connector
   * passes runtime.signal so the host's time budget ends a wait. Without
   * a signal (validation probes) nothing is retried.
   */
  signal?: AbortSignal;
  /** Replaced in tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  minRemaining?: number;
}

export interface AppleAdsClient {
  /** A JSON call: 2xx gives the body, anything else throws AppleAdsApiError. */
  json(path: string, options?: AppleAdsRequestOptions): Promise<unknown>;
  /** The latest rate-limit headers seen. */
  readonly rateLimit: RateLimit;
}

/**
 * Calls the Apple Ads Platform API with one access token through the given
 * allowlisted fetch. Reads the `RateLimit-*` headers of every answer and
 * refuses to go on when the window runs low; honours a short `Retry-After`
 * and retries 5xx when it may wait.
 */
export function createAppleAdsClient(
  fetch: AppleAdsFetch,
  accessToken: string,
  options: AppleAdsClientOptions = {},
): AppleAdsClient {
  const minRemaining = options.minRemaining ?? MIN_REMAINING_REQUESTS;
  const sleep = options.sleep ?? abortableSleep;
  const { signal } = options;
  let rateLimit: RateLimit = {};

  async function json(
    path: string,
    request: AppleAdsRequestOptions = {},
  ): Promise<unknown> {
    if (!path.startsWith("/v1/")) {
      throw new Error("Apple Ads paths start with /v1/");
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    };
    if (request.adAccountId !== undefined) {
      if (!isAdAccountId(request.adAccountId)) {
        throw new Error("Apple Ads ad account IDs are digits only");
      }
      headers["x-ap-context"] = `adAccountId=${request.adAccountId}`;
    }
    const init: ConnectorFetchInit =
      request.body === undefined
        ? { method: "GET", headers }
        : {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify(request.body),
          };
    for (let attempt = 1; ; attempt += 1) {
      if (
        rateLimit.remaining !== undefined &&
        rateLimit.remaining < minRemaining
      ) {
        throw new AppleAdsRateBudgetError(
          rateLimit.remaining,
          rateLimit.resetSeconds,
        );
      }
      const response = await fetch(`${APPLE_ADS_API}${path}`, init);
      const seen = parseRateLimit(response);
      if (seen.remaining !== undefined) rateLimit = seen;
      if (response.status >= 200 && response.status < 300) {
        return response.json();
      }
      const retryAfter =
        response.status === 429 ? retryAfterSeconds(response) : undefined;
      const error = new AppleAdsApiError(
        response.status,
        appleAdsErrorBody(response),
        retryAfter,
      );
      if (!signal || !error.isRetryable || attempt >= MAX_ATTEMPTS) {
        throw error;
      }
      if (response.status === 429) {
        // Retry-After first, then RateLimit-Reset (Apple's order).
        const wait = retryAfter ?? seen.resetSeconds;
        if (wait === undefined || wait > MAX_RETRY_AFTER_SECONDS) {
          throw error;
        }
        // The window starts over after the wait.
        rateLimit = {};
        await sleep(wait * 1000, signal);
        continue;
      }
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1), signal);
    }
  }

  return {
    json,
    get rateLimit() {
      return rateLimit;
    },
  };
}
