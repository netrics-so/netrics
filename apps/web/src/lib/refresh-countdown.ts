/**
 * A screen's refresh cadence (ADR 0018 section 5): the data was last
 * refreshed at `since` and refreshes every `everyMs`. The kiosk takes it
 * from its payload (`refreshAfterSec` after the last answer); signed-in
 * screens from the widgets' poll interval since the player started.
 */
export interface RefreshCycle {
  /** Epoch ms of the last refresh (or of the cycle's start). */
  since: number;
  everyMs: number;
}

export interface RefreshCountdown {
  /** Whole seconds to the next refresh, 1 … everyMs / 1000. */
  seconds: number;
  /** How much of the cycle has passed, 0 … <1 (the progress bar). */
  fraction: number;
}

/**
 * Where `now` is in the cycle. Past one cycle (a refresh that is late or
 * a poll without a reported time) the countdown starts over, so it never
 * shows a negative or frozen number.
 */
export function refreshCountdown(
  now: number,
  cycle: RefreshCycle,
): RefreshCountdown {
  const every = Math.max(1000, cycle.everyMs);
  const elapsed = Math.max(0, now - cycle.since) % every;
  return {
    seconds: Math.max(1, Math.ceil((every - elapsed) / 1000)),
    fraction: elapsed / every,
  };
}
