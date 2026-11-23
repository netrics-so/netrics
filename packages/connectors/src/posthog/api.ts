import {
  RateLimitedError,
  type ConnectorRuntime,
} from "@netrics/connector-sdk";

import { abortableSleep } from "../sleep.js";

/**
 * PostHog's private API (https://posthog.com/docs/api): the app host of
 * the project's region, or the host of a self-hosted instance. netrics only
 * reads: GET on the organization, project and insight listings, and POST
 * on the query endpoint, which runs a read-only query (see `assertReadOnly`).
 */
export const US_HOST = "us.posthog.com";
export const EU_HOST = "eu.posthog.com";

/**
 * Longest wait for a rate-limit reset within one call. A later reset ends
 * the call with a RateLimitedError, and the host runs the connection's jobs
 * again after it (#781). Short, because one PostHog query may itself take
 * up to ten seconds and a call has a minute.
 */
const MAX_RATE_LIMIT_WAIT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

export type PostHogErrorKind =
  /** 401: the key is wrong, deleted or expired. */
  | "auth"
  /** 403 naming a scope: the key lacks a scope netrics needs. */
  | "scope"
  /**
   * 403 on an organization endpoint for a key limited to projects
   * (PostHog's `scoped_teams`, posthog/permissions.py): such a key reads
   * project endpoints only.
   */
  | "project_scoped"
  /** 403 otherwise: the key may not read this organization or project. */
  | "forbidden"
  /** 404: an organization, project or insight the key cannot see. */
  | "not_found"
  /** 400 on a query: PostHog refused netrics' query. */
  | "query"
  /** The answer does not have the documented shape. */
  | "invalid"
  /** Any other refused answer. */
  | "other";

/**
 * A refused PostHog request. Its message is netrics' own fixed text for the
 * status and kind: never the request, its headers, the key, or PostHog's
 * response text, which may echo what it was sent (#884 review 2). `detail`
 * is netrics' own description of an answer of the wrong shape.
 */
export class PostHogApiError extends Error {
  readonly status: number;
  readonly kind: PostHogErrorKind;
  /** The scope PostHog names as missing, e.g. "query:read". */
  readonly scope: string | null;

  constructor(
    status: number,
    kind: PostHogErrorKind,
    detail: string,
    scope: string | null = null,
  ) {
    super(describe(status, kind, detail, scope));
    this.name = "PostHogApiError";
    this.status = status;
    this.kind = kind;
    this.scope = scope;
  }
}

function describe(
  status: number,
  kind: PostHogErrorKind,
  detail: string,
  scope: string | null,
): string {
  if (kind === "auth") {
    return "PostHog did not accept the personal API key (401).";
  }
  if (kind === "scope") {
    return `The personal API key lacks the scope ${scope ?? "netrics needs"} (403).`;
  }
  if (status === 429) {
    return "PostHog's API rate limit is used up for now (429). netrics tries again later.";
  }
  if (status >= 500) {
    return `PostHog is not answering right now (${status}). netrics tries again later.`;
  }
  switch (kind) {
    case "project_scoped":
      return "The personal API key is limited to projects; PostHog answers organization requests only for other keys (403).";
    case "forbidden":
      return "PostHog does not let the key read this organization or project (403).";
    case "not_found":
      return "PostHog did not find a project or insight the key may read (404).";
    case "query":
      return `PostHog refused netrics' query (${status}).`;
    case "invalid":
      return `PostHog's answer does not have the expected shape: ${detail.slice(0, 200)}`;
    default:
      return `PostHog API answered ${status}.`;
  }
}

/** PostHog's DRF error body: `{ type, code, detail, attr }`. */
function errorDetail(json: unknown): { code: string; detail: string } {
  if (!json || typeof json !== "object") return { code: "", detail: "" };
  const body = json as { code?: unknown; detail?: unknown };
  return {
    code: typeof body.code === "string" ? body.code : "",
    detail: typeof body.detail === "string" ? body.detail : "",
  };
}

/**
 * Classifies a refused answer by status and PostHog's error body. The body
 * only classifies: none of its text goes into the error.
 */
export function apiError(status: number, json: unknown): PostHogApiError {
  const { detail } = errorDetail(json);
  if (status === 401) return new PostHogApiError(status, "auth", "");
  if (status === 403) {
    // "API key missing required scope 'query:read'"
    const scope = /scope '([a-z_]+:[a-z]+)'/i.exec(detail)?.[1] ?? null;
    // "API keys with scoped projects are only supported on project-based
    // endpoints."
    if (/scoped projects/i.test(detail)) {
      return new PostHogApiError(status, "project_scoped", "");
    }
    if (scope !== null || /\bscope\b/i.test(detail)) {
      return new PostHogApiError(status, "scope", "", scope);
    }
    return new PostHogApiError(status, "forbidden", "");
  }
  if (status === 404) return new PostHogApiError(status, "not_found", "");
  if (status === 400) return new PostHogApiError(status, "query", "");
  return new PostHogApiError(status, "other", "");
}

/**
 * When the limit resets, in ms since the epoch: `Retry-After` in seconds
 * or as an HTTP date (PostHog sends it with a 429). Null without it.
 */
export function rateLimitReset(
  headers: Record<string, string>,
  now: number,
): number | null {
  const retryAfter = headers["retry-after"]?.trim();
  if (!retryAfter) return null;
  if (/^\d+(\.\d+)?$/.test(retryAfter)) {
    return now + Math.ceil(Number(retryAfter) * 1000);
  }
  const date = Date.parse(retryAfter);
  return Number.isFinite(date) ? Math.max(now, date) : null;
}

// ─── Read-only guard ────────────────────────────────────────────────────────

const READABLE_PATHS = [
  /^\/api\/organizations\/$/,
  /^\/api\/organizations\/[0-9a-f-]{1,64}\/projects\/$/,
  /^\/api\/projects\/\d{1,20}\/insights\/$/,
];
const QUERY_PATH = /^\/api\/projects\/\d{1,20}\/query\/$/;
const QUERY_KINDS = new Set(["HogQLQuery", "TrendsQuery"]);

/**
 * Refuses any request but the listings netrics reads and a query of a
 * kind it sends. The query endpoint only runs queries, but this guard keeps
 * a future edit from reaching anything else by accident.
 */
export function assertReadOnly(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): void {
  if (method === "GET") {
    if (READABLE_PATHS.some((pattern) => pattern.test(path))) return;
    throw new Error(`The PostHog connector does not read ${path}`);
  }
  const query =
    body && typeof body === "object"
      ? (body as { query?: { kind?: unknown; query?: unknown } }).query
      : undefined;
  if (
    QUERY_PATH.test(path) &&
    typeof query?.kind === "string" &&
    QUERY_KINDS.has(query.kind) &&
    (query.kind !== "HogQLQuery" ||
      (typeof query.query === "string" &&
        /^\s*select\b/i.test(query.query) &&
        !query.query.includes(";")))
  ) {
    return;
  }
  throw new Error("The PostHog connector only sends read-only queries");
}

// ─── Client ─────────────────────────────────────────────────────────────────

export interface ClientOptions {
  /** Waits between retries; replaced in tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface PostHogClient {
  /** The API host this client reads, e.g. "us.posthog.com". */
  readonly host: string;
  /** GET a listing path with query parameters; the parsed JSON. */
  get(path: string, params?: Record<string, string | number>): Promise<unknown>;
  /** POST a query to a project's query endpoint; the parsed JSON. */
  query(projectId: string, body: Record<string, unknown>): Promise<unknown>;
}

/**
 * PostHog's API through the runtime's allowlisted fetch, with a personal
 * API key (`Authorization: Bearer`). Retries server errors and near
 * rate-limit resets with backoff; a later reset surfaces as
 * RateLimitedError, everything else as PostHogApiError.
 */
export function createPostHogClient(
  runtime: ConnectorRuntime,
  host: string,
  apiKey: string,
  options: ClientOptions = {},
): PostHogClient {
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? Date.now;

  async function send(
    method: "GET" | "POST",
    path: string,
    params: Record<string, string | number>,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    assertReadOnly(method, path, body);
    const search = new URLSearchParams(
      Object.entries(params).map(([key, value]) => [key, String(value)]),
    ).toString();
    const url = `https://${host}${path}${search ? `?${search}` : ""}`;
    for (let attempt = 1; ; attempt += 1) {
      const response = await runtime.fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

      if (response.status === 429) {
        const reset = rateLimitReset(response.headers, now());
        const wait = reset === null ? BASE_BACKOFF_MS * attempt : reset - now();
        if (
          reset !== null &&
          (wait > MAX_RATE_LIMIT_WAIT_MS || attempt >= MAX_ATTEMPTS)
        ) {
          throw new RateLimitedError(
            "PostHog's API rate limit or query budget is used up (429). netrics continues after the reset.",
            new Date(reset),
          );
        }
        if (attempt >= MAX_ATTEMPTS) {
          throw new PostHogApiError(429, "other", "");
        }
        await sleep(Math.max(0, wait), runtime.signal);
        continue;
      }
      if (response.status >= 500) {
        if (attempt >= MAX_ATTEMPTS) {
          throw new PostHogApiError(response.status, "other", "");
        }
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1), runtime.signal);
        continue;
      }

      let json: unknown;
      try {
        json = response.json();
      } catch {
        // Non-JSON page (proxy, login page of a self-hosted instance).
        throw response.status === 401
          ? new PostHogApiError(401, "auth", "")
          : new PostHogApiError(
              response.status,
              response.status >= 200 && response.status < 300
                ? "invalid"
                : "other",
              "the answer was not JSON",
            );
      }
      if (response.status < 200 || response.status >= 300) {
        throw apiError(response.status, json);
      }
      return json;
    }
  }

  return {
    host,
    get: (path, params = {}) => send("GET", path, params),
    query: (projectId, body) =>
      send("POST", `/api/projects/${projectId}/query/`, {}, body),
  };
}
