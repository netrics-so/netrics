import type { ConnectorRuntime } from "@netrics/connector-sdk";

export const VERCEL_API = "https://api.vercel.com";

/** Longest wait for a rate-limit reset before the call gives up (retried later). */
const MAX_RATE_LIMIT_WAIT_MS = 30_000;
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 500;

/**
 * A non-2xx answer from the Vercel API. Only Vercel's own error code and
 * message are kept; the request never carries the token in its URL, so the
 * message cannot leak it.
 */
export class VercelApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly invalidToken: boolean;

  constructor(
    status: number,
    body: { code?: string; message?: string; invalidToken?: boolean },
  ) {
    super(
      `Vercel API answered ${status}${body.code ? ` ${body.code}` : ""}: ${body.message ?? "no message"}`,
    );
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

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
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

/** How long to wait before retrying a 429, or null when it is too long. */
function rateLimitWait(
  headers: Record<string, string>,
  now: number,
): number | null {
  const retryAfter = Number(headers["retry-after"]);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    const ms = retryAfter * 1000;
    return ms <= MAX_RATE_LIMIT_WAIT_MS ? ms : null;
  }
  const reset = Number(headers["x-ratelimit-reset"]);
  if (Number.isFinite(reset) && reset > 0) {
    const ms = Math.max(0, reset * 1000 - now);
    return ms <= MAX_RATE_LIMIT_WAIT_MS ? ms : null;
  }
  return BASE_BACKOFF_MS;
}

/**
 * A GET against the Vercel API through the runtime's allowlisted fetch.
 * Retries rate limits (when the reset is near) and server errors with
 * exponential backoff; everything else surfaces as VercelApiError.
 */
export function createVercelClient(
  runtime: ConnectorRuntime,
  token: string,
  options: ClientOptions = {},
) {
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? Date.now;
  return async function get(path: string, query: Query = {}): Promise<unknown> {
    const url = buildUrl(path, query);
    for (let attempt = 1; ; attempt += 1) {
      const response = await runtime.fetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
      });
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
      if (attempt >= MAX_ATTEMPTS) throw error;
      if (response.status === 429) {
        const wait = rateLimitWait(response.headers, now());
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
  };
}

export type VercelGet = ReturnType<typeof createVercelClient>;
