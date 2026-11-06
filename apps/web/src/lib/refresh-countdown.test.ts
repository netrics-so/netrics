import { describe, expect, it } from "vitest";

import { refreshCountdown } from "./refresh-countdown";

describe("refreshCountdown", () => {
  const cycle = { since: 1_000_000, everyMs: 60_000 };

  it("counts the whole seconds down to the next refresh", () => {
    expect(refreshCountdown(cycle.since, cycle)).toEqual({
      seconds: 60,
      fraction: 0,
    });
    expect(refreshCountdown(cycle.since + 18_400, cycle)).toEqual({
      seconds: 42,
      fraction: 18_400 / 60_000,
    });
    expect(refreshCountdown(cycle.since + 59_999, cycle).seconds).toBe(1);
  });

  it("starts over when a refresh is late, never below one second", () => {
    expect(refreshCountdown(cycle.since + 60_000, cycle)).toEqual({
      seconds: 60,
      fraction: 0,
    });
    expect(refreshCountdown(cycle.since + 75_000, cycle).seconds).toBe(45);
    // A clock behind the last refresh: the full cycle.
    expect(refreshCountdown(cycle.since - 5_000, cycle).seconds).toBe(60);
  });
});
