import { MAX_RATE_LIMIT_HOLD_MS } from "@netrics/connectors";
import { describe, expect, it } from "vitest";

import { rateLimitedRunAt } from "./engine.js";

// When a rate-limited connection runs again (#781): the provider's reset,
// bounded to between 5 seconds and a day ahead, plus jitter of a tenth of
// the wait (at least a second, at most a minute).

const NOW = new Date("2026-11-19T10:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const run = (retryAt: string, random: number) =>
  rateLimitedRunAt(retryAt, NOW, () => random).getTime() - NOW.getTime();

describe("rateLimitedRunAt", () => {
  it("runs at the reset, plus no more than a tenth of the wait", () => {
    const tenMinutes = 10 * 60 * 1000;
    expect(run(at(tenMinutes), 0)).toBe(tenMinutes);
    expect(run(at(tenMinutes), 0.999)).toBeLessThanOrEqual(
      tenMinutes + tenMinutes / 10,
    );
    expect(run(at(tenMinutes), 0.999)).toBeGreaterThan(tenMinutes + 50_000);
  });

  it("adds at most a minute of jitter to a long wait", () => {
    const hours = 6 * 60 * 60 * 1000;
    expect(run(at(hours), 0.999)).toBeLessThanOrEqual(hours + 60_000);
  });

  it("waits at least 5 seconds for a reset that has passed or is now", () => {
    expect(run(at(-60_000), 0)).toBe(5_000);
    expect(run(at(0), 0)).toBe(5_000);
    // Jitter of at least a second's range even for a short wait.
    expect(run(at(0), 0.999)).toBeGreaterThan(5_900);
  });

  it("waits no longer than a day for a reset far ahead", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(run(at(30 * day), 0)).toBe(day);
    expect(run(at(30 * day), 0.999)).toBeLessThanOrEqual(day + 60_000);
  });

  it("defers a run as long as a connector's checkpoint holds a rate limit (#888 review, #914)", () => {
    // Connectors cap a carried hold at MAX_RATE_LIMIT_HOLD_MS, mirroring
    // this bound: a longer hold would refuse every retry made before it.
    const day = 24 * 60 * 60 * 1000;
    expect(run(at(30 * day), 0)).toBe(MAX_RATE_LIMIT_HOLD_MS);
  });
});
