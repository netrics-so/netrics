import { PgTransaction } from "drizzle-orm/pg-core";

import { hasSqlstate } from "./context.js";

/**
 * SQLSTATEs that mean "run the whole transaction again": a serialization
 * failure (SSI or a concurrent update under repeatable read) and a deadlock.
 */
export const SERIALIZATION_RETRY_SQLSTATES = ["40001", "40P01"] as const;

/** Whether an error (or one it wraps) is a serialization failure or deadlock. */
export function isSerializationFailure(error: unknown): boolean {
  return SERIALIZATION_RETRY_SQLSTATES.some((code) => hasSqlstate(error, code));
}

/**
 * Whether `handle` is an open transaction (or savepoint) rather than a
 * database. A serialization failure dooms the enclosing transaction, so a
 * nested unit of work must not retry itself: the outermost transaction does.
 */
export function isTransactionHandle(handle: unknown): boolean {
  return handle instanceof PgTransaction;
}

export interface SerializationRetryOptions {
  /** Attempts in total, the first included. */
  attempts?: number;
  /** Upper bound of the first backoff; it doubles per attempt. */
  baseDelayMs?: number;
  /** Upper bound of any single backoff. */
  maxDelayMs?: number;
  /**
   * Time after which no further attempt starts, counted from the first.
   * Bounds how long a request can spend retrying under contention.
   */
  budgetMs?: number;
  /** Which failures to retry; serialization failures and deadlocks by default. */
  retryable?: (error: unknown, index: number) => boolean;
  /** Called before each wait, with the attempt that failed (0-based). */
  onRetry?: (error: unknown, index: number, delayMs: number) => void;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

/**
 * Defaults for request transactions (#598). On small tables, serializable
 * transactions of unrelated workspaces conflict: predicate locks are taken
 * per index page, or for the whole table when the planner picks a
 * sequential scan, and one page holds every workspace's rows. A conflict
 * that hit once tends to hit again (more than half of the retries failed again
 * under load), so three immediate retries ran into the same rivals and
 * failed. Fifteen attempts with full-jitter exponential backoff (10 ms
 * doubling, at most 500 ms per wait) spread the retries out; the budget
 * keeps a request under contention from retrying past ~8 s.
 */
export const SERIALIZATION_RETRY_DEFAULTS = {
  attempts: 15,
  baseDelayMs: 10,
  maxDelayMs: 500,
  budgetMs: 8_000,
} as const;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `attempt` until it succeeds, it fails with an error that is not
 * retryable, or the attempts or the time budget run out; then rethrows the
 * last error, so callers map an exhausted retry exactly as before (409
 * version_conflict). `attempt` must open its own transaction: every call is
 * a fresh run of the whole unit of work.
 *
 * Waits between attempts use full jitter: a random time up to
 * min(maxDelayMs, baseDelayMs * 2^n), so transactions that failed together
 * do not retry in lockstep.
 */
export async function retryOnSerializationFailure<T>(
  attempt: (index: number) => Promise<T>,
  options: SerializationRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? SERIALIZATION_RETRY_DEFAULTS.attempts;
  const base = options.baseDelayMs ?? SERIALIZATION_RETRY_DEFAULTS.baseDelayMs;
  const cap = options.maxDelayMs ?? SERIALIZATION_RETRY_DEFAULTS.maxDelayMs;
  const budget = options.budgetMs ?? SERIALIZATION_RETRY_DEFAULTS.budgetMs;
  const retryable = options.retryable ?? isSerializationFailure;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const started = now();
  for (let index = 0; ; index++) {
    try {
      return await attempt(index);
    } catch (error) {
      if (index + 1 >= attempts || !retryable(error, index)) throw error;
      const delay = Math.floor(
        random() * Math.min(cap, base * 2 ** Math.min(index, 30)),
      );
      if (now() - started + delay >= budget) throw error;
      options.onRetry?.(error, index, delay);
      await sleep(delay);
    }
  }
}
