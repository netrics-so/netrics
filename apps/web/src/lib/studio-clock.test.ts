import { describe, expect, it } from "vitest";

import { clockText, msUntilNextMinute } from "./studio-clock";

const at = new Date("2026-10-04T12:05:30Z");

describe("clockText", () => {
  it("shows 24-hour time in the workspace's zone", () => {
    expect(clockText(at, { timeZone: "Europe/Berlin" })).toEqual({
      time: "14:05",
      date: null,
    });
    expect(clockText(at, { timeZone: "America/New_York" }).time).toBe("08:05");
  });

  it("shows 12-hour time and the date when asked", () => {
    expect(
      clockText(at, { timeZone: "Asia/Tokyo", hour12: true, showDate: true }),
    ).toEqual({ time: "9:05 PM", date: "Sun 4 Oct" });
  });

  it("falls back to UTC for a zone the browser does not know", () => {
    expect(clockText(at, { timeZone: "Mars/Olympus" }).time).toBe("12:05");
  });
});

describe("msUntilNextMinute", () => {
  it("ticks on the minute", () => {
    expect(msUntilNextMinute(at.getTime())).toBe(30_000);
  });
});
