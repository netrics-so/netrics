import type {
  ConnectorFetchInit,
  ConnectorResponse,
} from "@netrics/connector-sdk";
import { z } from "zod";

export const APP_STORE_CONNECT_HOST = "api.appstoreconnect.apple.com";
export const APP_STORE_CONNECT_API = `https://${APP_STORE_CONNECT_HOST}`;

/**
 * Below this many requests left in the key's rolling hour (Apple's
 * `X-Rate-Limit: user-hour-lim:3500;user-hour-rem:…;`), the client stops
 * and the job retries later: several connections may share one key, and the
 * last requests of the hour are left for the user's other tools.
 */
export const MIN_REMAINING_REQUESTS = 100;

/** HTTPS with the provider's allowlist: runtime.fetch, or a probe's fetch. */
export type AscFetch = (
  url: string,
  init?: ConnectorFetchInit,
) => Promise<ConnectorResponse>;

/**
 * One entry of Apple's `ErrorResponse.errors[]`: `status`, `code`, `title`
 * and `detail` are always present, `source` names the query parameter (or
 * JSON pointer) at fault. Apple asks clients to branch on `code`, never on
 * `title` or `detail`
 * (https://developer.apple.com/documentation/appstoreconnectapi/errorresponse/errors-data.dictionary).
 */
export interface AscErrorBody {
  status?: string;
  code?: string;
  title?: string;
  detail?: string;
  /** `source.parameter`, e.g. "filter[vendorNumber]". */
  parameter?: string;
}

const errorResponseSchema = z.object({
  errors: z
    .array(
      z
        .object({
          status: z.string().optional(),
          code: z.string().optional(),
          title: z.string().optional(),
          detail: z.string().optional(),
          source: z
            .object({ parameter: z.string().optional() })
            .loose()
            .optional(),
        })
        .loose(),
    )
    .min(1),
});

/** Apple's first error of an ErrorResponse, or {} for anything else. */
export function ascErrorBody(response: ConnectorResponse): AscErrorBody {
  let json: unknown;
  try {
    json = response.json();
  } catch {
    // An HTML error page (proxy, outage): the status alone classifies it.
    return {};
  }
  const parsed = errorResponseSchema.safeParse(json);
  if (!parsed.success) return {};
  const first = parsed.data.errors[0]!;
  return {
    ...(first.status !== undefined ? { status: first.status } : {}),
    ...(first.code !== undefined ? { code: first.code } : {}),
    ...(first.title !== undefined ? { title: first.title } : {}),
    ...(first.detail !== undefined ? { detail: first.detail } : {}),
    ...(first.source?.parameter !== undefined
      ? { parameter: first.source.parameter }
      : {}),
  };
}

function describe(status: number, body: AscErrorBody): string {
  if (status === 401) {
    return "App Store Connect refused the signed token (401): the key was revoked, or the issuer ID, key ID and private key do not belong together.";
  }
  if (status === 429) {
    return "App Store Connect's hourly request limit for this key is used up (429 RATE_LIMIT_EXCEEDED). netrics tries again later.";
  }
  if (status >= 500) {
    return `App Store Connect is not answering right now (${status}). netrics tries again later.`;
  }
  const code = body.code ? ` ${body.code}` : "";
  const text = [body.title, body.detail].filter(Boolean).join(": ");
  return `App Store Connect API answered ${status}${code}: ${(text || "no message").slice(0, 300)}`;
}

/**
 * A non-2xx answer from the App Store Connect API. Only Apple's status,
 * code, title, detail and parameter are kept; the token travels in a
 * header, never in the URL, so the message cannot carry it.
 *
 * A 401 surfaces with the name "AccessTokenRejectedError" (the name survives
 * the runtime's error redaction): the host treats it as a refused key and
 * puts the connection in auth_failed (ADR 0014). 429 and 5xx are retryable
 * provider failures: the connector throws them and the job backs off.
 */
export class AppStoreConnectApiError extends Error {
  readonly status: number;
  readonly body: AscErrorBody;

  constructor(status: number, body: AscErrorBody) {
    super(describe(status, body));
    this.name =
      status === 401 ? "AccessTokenRejectedError" : "AppStoreConnectApiError";
    this.status = status;
    this.body = body;
  }

  /** 429 or 5xx: try again later. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/**
 * The key's hourly budget is nearly used up (X-Rate-Limit user-hour-rem
 * below MIN_REMAINING_REQUESTS): a retryable failure, so the job backs off
 * before Apple answers 429.
 */
export class AppStoreConnectRateBudgetError extends Error {
  readonly remaining: number;

  constructor(remaining: number) {
    super(
      `App Store Connect's hourly request budget for this key is nearly used up (${remaining} left). netrics tries again later.`,
    );
    this.name = "AppStoreConnectRateBudgetError";
    this.remaining = remaining;
  }
}

export interface RateLimit {
  limit?: number;
  remaining?: number;
}

/**
 * Parses `X-Rate-Limit: user-hour-lim:3500;user-hour-rem:2499;`
 * (https://developer.apple.com/documentation/appstoreconnectapi/identifying-rate-limits).
 */
export function parseRateLimit(header: string | undefined): RateLimit {
  const result: RateLimit = {};
  for (const part of (header ?? "").split(";")) {
    const [name, raw] = part.split(":").map((entry) => entry.trim());
    const value = Number(raw);
    if (raw === undefined || raw === "" || !Number.isFinite(value)) continue;
    if (name === "user-hour-lim") result.limit = value;
    if (name === "user-hour-rem") result.remaining = value;
  }
  return result;
}

function headerOf(response: ConnectorResponse, name: string) {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(response.headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

export type Query = Record<string, string | undefined>;

export interface AppStoreConnectClient {
  /**
   * One request. Any status comes back as the response, except that a low
   * hourly budget left by an earlier response throws
   * AppStoreConnectRateBudgetError first.
   */
  request(
    pathOrUrl: string,
    query?: Query,
    accept?: string,
  ): Promise<ConnectorResponse>;
  /** A JSON GET: 2xx gives the body, anything else throws. */
  getJson(pathOrUrl: string, query?: Query): Promise<unknown>;
}

function urlOf(pathOrUrl: string, query: Query = {}): string {
  const url = new URL(pathOrUrl, APP_STORE_CONNECT_API);
  if (url.protocol !== "https:" || url.hostname !== APP_STORE_CONNECT_HOST) {
    // A `links.next` pointing elsewhere would leak the token to that host.
    throw new Error(
      `App Store Connect returned a link outside ${APP_STORE_CONNECT_HOST}`,
    );
  }
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * Calls the App Store Connect API with one signed token through the given
 * allowlisted fetch. Reads `X-Rate-Limit` on every answer and refuses to go
 * on when the key's hourly budget runs low.
 */
export function createAppStoreConnectClient(
  fetch: AscFetch,
  accessToken: string,
  options: { minRemaining?: number } = {},
): AppStoreConnectClient {
  const minRemaining = options.minRemaining ?? MIN_REMAINING_REQUESTS;
  let remaining: number | undefined;

  async function request(
    pathOrUrl: string,
    query?: Query,
    accept = "application/json",
  ): Promise<ConnectorResponse> {
    if (remaining !== undefined && remaining < minRemaining) {
      throw new AppStoreConnectRateBudgetError(remaining);
    }
    const response = await fetch(urlOf(pathOrUrl, query), {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}`, accept },
    });
    const budget = parseRateLimit(headerOf(response, "x-rate-limit"));
    if (budget.remaining !== undefined) remaining = budget.remaining;
    return response;
  }

  return {
    request,
    async getJson(pathOrUrl, query) {
      const response = await request(pathOrUrl, query);
      if (response.status >= 200 && response.status < 300) {
        return response.json();
      }
      throw new AppStoreConnectApiError(
        response.status,
        ascErrorBody(response),
      );
    },
  };
}
