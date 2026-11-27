import {
  RateLimitedError,
  type ConnectorRuntime,
} from "@netrics/connector-sdk";

import { abortableSleep } from "../sleep.js";

/**
 * Railway's public GraphQL API (https://docs.railway.com/reference/public-api).
 * One endpoint for every query; netrics only ever sends queries, never a
 * mutation (see `assertReadOnly`).
 */
export const RAILWAY_HOST = "backboard.railway.com";
export const RAILWAY_API = `https://${RAILWAY_HOST}/graphql/v2`;

/**
 * Longest wait for a rate-limit reset within one call. A later reset ends
 * the call with a RateLimitedError, and the host runs the connection's jobs
 * again after it (#781).
 */
const MAX_RATE_LIMIT_WAIT_MS = 30_000;
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 500;
/**
 * Pacing: Railway reports the rest of the hourly window with every answer
 * (`X-RateLimit-Remaining`, `X-RateLimit-Reset`). Below this many requests
 * left the client stops before Railway answers 429, so a backfill leaves
 * the window for the connection's own checks.
 */
export const MIN_REMAINING_REQUESTS = 5;
/** The longest one request to Railway may take (the host allows 60 s). */
export const REQUEST_TIMEOUT_MS = 20_000;

export type RailwayErrorKind =
  /** "Not Authorized": the token is wrong, revoked, or may not read this. */
  | "auth"
  /**
   * "Workspace not found", "Project not found": an id the token cannot see
   * (Railway answers the same whether it does not exist or is not shared).
   */
  | "not_found"
  /** The query no longer matches Railway's schema. */
  | "schema"
  /** Any other answer Railway refused. */
  | "other";

/**
 * A refused Railway request. Only Railway's own error text is kept (never
 * the request, its variables or headers), so the token cannot leak through
 * it; the text is cut short.
 */
export class RailwayApiError extends Error {
  readonly status: number;
  readonly kind: RailwayErrorKind;

  constructor(status: number, kind: RailwayErrorKind, detail: string) {
    super(describe(status, kind, detail));
    this.name = "RailwayApiError";
    this.status = status;
    this.kind = kind;
  }

  get isAuth(): boolean {
    return this.kind === "auth";
  }
}

function describe(
  status: number,
  kind: RailwayErrorKind,
  detail: string,
): string {
  if (kind === "auth") {
    return "Railway did not accept the token for this request (Not Authorized).";
  }
  if (status === 429) {
    return "Railway's API rate limit is used up for now (429). netrics tries again later.";
  }
  if (status >= 500) {
    return `Railway is not answering right now (${status}). netrics tries again later.`;
  }
  const text = detail.replace(/\s+/g, " ").trim().slice(0, 200);
  if (kind === "not_found") {
    return `Railway did not find a workspace or project the token may read: ${text}`;
  }
  return kind === "schema"
    ? `Railway's API no longer accepts netrics' query: ${text}`
    : `Railway API answered ${status}: ${text || "no message"}`;
}

/**
 * The time a sync page has for Railway ran out before a request or a wait
 * could be made (#901 item 1): the page ends with what it read, or the
 * host retries it. Fixed text.
 */
export class RailwayTimeoutError extends Error {
  constructor() {
    super("Railway did not answer in time. netrics tries again later.");
    this.name = "RailwayTimeoutError";
  }
}

const graphQlErrorSchema = (value: unknown) =>
  value && typeof value === "object"
    ? (value as { message?: unknown; extensions?: { code?: unknown } })
    : {};

/** Classifies the `errors` of a GraphQL answer. */
export function graphQlError(
  status: number,
  errors: readonly unknown[],
): RailwayApiError {
  const parsed = errors.map(graphQlErrorSchema);
  const messages = parsed.map((error) =>
    typeof error.message === "string" ? error.message : "",
  );
  if (messages.some((message) => /not authori[sz]ed/i.test(message))) {
    return new RailwayApiError(status, "auth", "");
  }
  if (messages.some((message) => /\bnot found\b/i.test(message))) {
    return new RailwayApiError(status, "not_found", messages[0] ?? "");
  }
  if (
    parsed.some(
      (error) => error.extensions?.code === "GRAPHQL_VALIDATION_FAILED",
    )
  ) {
    return new RailwayApiError(status, "schema", messages[0] ?? "");
  }
  return new RailwayApiError(status, "other", messages[0] ?? "");
}

/**
 * When the limit resets, in ms since the epoch: `Retry-After` (seconds or
 * an HTTP date), else `X-RateLimit-Reset` (epoch seconds, epoch ms or an
 * ISO date: the docs only say "when the current window ends"). Null when
 * Railway says neither.
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
  const reset = headers["x-ratelimit-reset"]?.trim();
  if (reset) {
    if (/^\d+$/.test(reset)) {
      const value = Number(reset);
      // Seconds since the epoch until 2286; larger numbers are ms.
      return Math.max(now, value < 1e10 ? value * 1000 : value);
    }
    const date = Date.parse(reset);
    if (Number.isFinite(date)) return Math.max(now, date);
  }
  return null;
}

/**
 * Refuses anything but a query document. The connector only declares
 * queries; this guard keeps a future edit from sending a mutation or a
 * subscription by accident.
 */
export function assertReadOnly(document: string): void {
  const withoutComments = document.replace(/#[^\n]*/g, "").trim();
  if (!/^(query\b|\{)/.test(withoutComments)) {
    throw new Error("The Railway connector only sends GraphQL queries");
  }
}

export interface ClientOptions {
  /** Waits between retries; replaced in tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  /**
   * When every request and wait of this client has to be over (ms since
   * the epoch): each request is bounded to it, and a wait that would end
   * after it is not made (#901 item 1). The host's own deadline for the
   * call is later, so a sync page still returns its checkpoint.
   */
  deadline?: number;
}

export type RailwayQuery = <T = unknown>(
  document: string,
  variables?: Record<string, unknown>,
) => Promise<T>;

/**
 * A GraphQL query against Railway through the runtime's allowlisted fetch,
 * with an account or workspace token (`Authorization: Bearer`). Retries
 * server errors and near rate-limit resets with backoff; a later reset
 * surfaces as RateLimitedError, everything else as RailwayApiError.
 * Returns the answer's `data`.
 */
export function createRailwayClient(
  runtime: ConnectorRuntime,
  token: string,
  options: ClientOptions = {},
): RailwayQuery {
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? Date.now;
  const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
  let window: { remaining: number; resetAt: number } | null = null;
  /** A wait of `ms` from now would end after the deadline. */
  const pastDeadline = (ms: number) => now() + ms >= deadline;

  async function pace(): Promise<void> {
    if (!window || window.remaining >= MIN_REMAINING_REQUESTS) return;
    const { remaining, resetAt } = window;
    const wait = resetAt - now();
    // A reset past the deadline is the host's to wait for (#901 item 1).
    if (wait > MAX_RATE_LIMIT_WAIT_MS || (wait > 0 && pastDeadline(wait))) {
      throw new RateLimitedError(
        `Railway's API rate limit is nearly used up (${remaining} requests left). netrics continues after the reset.`,
        new Date(resetAt),
      );
    }
    window = null;
    if (wait > 0) await sleep(wait, runtime.signal);
  }

  return async function query<T>(
    document: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    assertReadOnly(document);
    const body = JSON.stringify({ query: document, variables });
    for (let attempt = 1; ; attempt += 1) {
      await pace();
      // A stalled request ends in time for the page to return its
      // checkpoint (#901 item 1).
      const left = deadline - now();
      if (left <= 0) throw new RailwayTimeoutError();
      const response = await runtime.fetch(RAILWAY_API, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body,
        timeoutMs: Math.ceil(Math.min(REQUEST_TIMEOUT_MS, left)),
      });
      const remainingHeader = response.headers["x-ratelimit-remaining"];
      const remaining = Number(remainingHeader);
      const resetAt = rateLimitReset(
        { "x-ratelimit-reset": response.headers["x-ratelimit-reset"] ?? "" },
        now(),
      );
      if (
        remainingHeader !== undefined &&
        Number.isFinite(remaining) &&
        resetAt !== null
      ) {
        window = { remaining, resetAt };
      }

      if (response.status === 429) {
        const reset = rateLimitReset(response.headers, now());
        const wait = reset === null ? BASE_BACKOFF_MS : reset - now();
        // A reset past the deadline is the host's to wait for, and the
        // page's checkpoint carries it (#901 item 1).
        if (
          reset !== null &&
          (wait > MAX_RATE_LIMIT_WAIT_MS ||
            attempt >= MAX_ATTEMPTS ||
            pastDeadline(wait))
        ) {
          throw new RateLimitedError(
            "Railway's API rate limit is used up (429). netrics continues after the reset.",
            new Date(reset),
          );
        }
        if (attempt >= MAX_ATTEMPTS || pastDeadline(wait)) {
          throw new RailwayApiError(429, "other", "");
        }
        window = null;
        await sleep(wait, runtime.signal);
        continue;
      }
      if (response.status >= 500) {
        const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1);
        if (attempt >= MAX_ATTEMPTS || pastDeadline(backoff)) {
          throw new RailwayApiError(response.status, "other", "");
        }
        await sleep(backoff, runtime.signal);
        continue;
      }

      let json: unknown;
      try {
        json = response.json();
      } catch {
        // Non-JSON page (proxy, outage): the status alone classifies it.
        throw new RailwayApiError(
          response.status,
          response.status === 401 || response.status === 403 ? "auth" : "other",
          "the answer was not JSON",
        );
      }
      const answer =
        json && typeof json === "object"
          ? (json as { data?: unknown; errors?: unknown })
          : {};
      if (Array.isArray(answer.errors) && answer.errors.length > 0) {
        throw graphQlError(response.status, answer.errors);
      }
      if (response.status === 401 || response.status === 403) {
        throw new RailwayApiError(response.status, "auth", "");
      }
      if (response.status < 200 || response.status >= 300) {
        throw new RailwayApiError(response.status, "other", "");
      }
      if (!answer.data || typeof answer.data !== "object") {
        throw new RailwayApiError(response.status, "other", "no data");
      }
      return answer.data as T;
    }
  };
}
