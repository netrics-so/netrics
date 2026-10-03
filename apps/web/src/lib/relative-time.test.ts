import { describe, expect, it } from "vitest";

import { intervalLabel } from "./relative-time";

describe("intervalLabel", () => {
  it.each([
    [21_600, "every 6 hours"],
    [300, "every 5 minutes"],
    [3_600, "every hour"],
    [86_400, "every day"],
    [90, "every 90 seconds"],
  ])("%s → %s", (seconds, expected) => {
    expect(intervalLabel(seconds)).toBe(expected);
  });
});
