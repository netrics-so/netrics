import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { nextSyncLabel } from "./sync-schedule";

describe("nextSyncLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const inSixHours = "2026-10-03T18:00:00Z";

  it("shows the due time of a healthy connection", () => {
    expect(nextSyncLabel({ authState: "ok", nextDueAt: inSixHours })).toBe(
      "in 6 hours",
    );
    expect(nextSyncLabel({ authState: "outage", nextDueAt: inSixHours })).toBe(
      "in 6 hours",
    );
  });

  it("says the schedule is paused while the scheduler skips the connection", () => {
    expect(
      nextSyncLabel({
        authState: "needs_reauthorization",
        nextDueAt: inSixHours,
      }),
    ).toBe("Paused until reconnected");
    expect(
      nextSyncLabel({ authState: "auth_failed", nextDueAt: inSixHours }),
    ).toBe("Paused until the credentials work");
  });
});
