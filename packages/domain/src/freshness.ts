/**
 * Data freshness (ADR 0025): when the next sync of a connection runs after
 * a succeeded one, and whether a provider is late. Pure functions over
 * instants; the host passes its clock.
 */

const MINUTE_MS = 60_000;

/** The spread of a provider's publication around its expected time. */
export const FRESHNESS_GRACE_MS = 10 * MINUTE_MS;
/** How often the host checks for an expected period (at most). */
export const FRESHNESS_STEP_MS = 30 * MINUTE_MS;
/** The least gap between two syncs that freshness schedules (at most). */
export const FRESHNESS_FLOOR_MS = 15 * MINUTE_MS;
/** From this long after `nextExpectedAt` a row is overdue (stale). */
export const FRESHNESS_OVERDUE_MS = 24 * 60 * MINUTE_MS;

/** The expected times of one stored freshness row of a periodic stream. */
export interface FreshnessExpectation {
  /** Earliest typical publication; null when not reported. */
  expectedFrom: Date | null;
  /** Latest normal publication; null when unknown. */
  nextExpectedAt: Date | null;
}

/**
 * The next sync of a connection after a succeeded run (ADR 0025 section 5).
 * Rows are the connection's periodic stream rows (declared streams,
 * selected resources). Without a candidate it is exactly
 * `now + interval`; freshness can only make it earlier, and never closer
 * than `min(15 min, interval)` to `now`.
 */
export function nextDueAfterSuccess(input: {
  now: Date;
  intervalSeconds: number;
  rows: readonly FreshnessExpectation[];
}): Date {
  const now = input.now.getTime();
  const interval = input.intervalSeconds * 1000;
  const step = Math.min(FRESHNESS_STEP_MS, interval);
  const floor = Math.min(FRESHNESS_FLOOR_MS, interval);
  let earliest = Number.POSITIVE_INFINITY;
  for (const row of input.rows) {
    if (!row.nextExpectedAt) continue;
    const expected = row.nextExpectedAt.getTime();
    const from = row.expectedFrom?.getTime() ?? expected;
    let candidate: number | null;
    if (now < from + FRESHNESS_GRACE_MS) {
      candidate = from + FRESHNESS_GRACE_MS; // wait
    } else if (now < expected + FRESHNESS_GRACE_MS) {
      candidate = Math.min(now + step, expected + FRESHNESS_GRACE_MS);
    } else if (now < expected + interval) {
      candidate = now + step; // late
    } else {
      candidate = null; // back to the interval
    }
    if (candidate !== null) earliest = Math.min(earliest, candidate);
  }
  if (earliest === Number.POSITIVE_INFINITY) return new Date(now + interval);
  return new Date(Math.max(now + floor, Math.min(now + interval, earliest)));
}

/**
 * The provider missed `nextExpectedAt` (ADR 0025 section 7): a sync after
 * the expected time plus grace still did not find the period. Decided from
 * stored values only, never the clock.
 */
export function isFreshnessLate(row: {
  nextExpectedAt: Date | null;
  checkedAt: Date;
}): boolean {
  return (
    row.nextExpectedAt !== null &&
    row.nextExpectedAt.getTime() + FRESHNESS_GRACE_MS < row.checkedAt.getTime()
  );
}

/** Late by a day or more: the widget's status becomes `stale`. */
export function isFreshnessOverdue(row: {
  nextExpectedAt: Date | null;
  checkedAt: Date;
}): boolean {
  return (
    row.nextExpectedAt !== null &&
    row.checkedAt.getTime() >=
      row.nextExpectedAt.getTime() + FRESHNESS_OVERDUE_MS
  );
}
