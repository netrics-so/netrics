/**
 * The longest rate-limit hold a checkpoint carries to the next page: the
 * host defers a rate-limited connection by at most a day
 * (`rateLimitedRunAt` in apps/server/src/sync/engine.ts, which the
 * connectors package may not import; apps/server's
 * sync/rate-limited-run-at.test.ts pins the two together). A longer hold
 * would refuse every retry the host makes before it (#888 review, #914).
 */
export const MAX_RATE_LIMIT_HOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Until when a checkpoint holds a rate limit's reset (an ISO time): the
 * reset, at most MAX_RATE_LIMIT_HOLD_MS after `now`. Undefined for a reset
 * that does not parse, which carries no hold.
 */
export function rateLimitHold(
  retryAt: string,
  now: number,
): number | undefined {
  const until = Date.parse(retryAt);
  if (!Number.isFinite(until)) return undefined;
  return Math.min(until, now + MAX_RATE_LIMIT_HOLD_MS);
}

/**
 * The hold a resumed checkpoint still carries: its time when that is after
 * `now` and at most MAX_RATE_LIMIT_HOLD_MS ahead; otherwise undefined. A
 * hold further ahead was stored before the cap and would refuse every
 * retry the host makes; the host has already waited its longest, so the
 * page asks the provider again (#914 review). Capping it relative to `now`
 * instead would hold it for ever: the cursor is not rewritten while the
 * hold refuses the page.
 */
export function pendingHold(
  until: number | undefined,
  now: number,
): number | undefined {
  if (until === undefined || !(until > now)) return undefined;
  return until <= now + MAX_RATE_LIMIT_HOLD_MS ? until : undefined;
}
