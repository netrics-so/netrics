import { describe, expect, it } from "vitest";

import {
  PACIFIC_TIME_ZONE,
  addCalendarDays,
  dateInZone,
  lastDayOfMonth,
  zonedInstant,
} from "./freshness.js";

describe("freshness calendar helpers", () => {
  it("turns a Pacific wall-clock time into an instant, across daylight saving time", () => {
    expect(zonedInstant("2026-11-16", 12, PACIFIC_TIME_ZONE)).toBe(
      "2026-11-16T20:00:00.000Z",
    );
    expect(zonedInstant("2026-07-01", 12, PACIFIC_TIME_ZONE)).toBe(
      "2026-07-01T19:00:00.000Z",
    );
    // The changeover days themselves: 8 March (02:00 → 03:00) and
    // 1 November 2026 (02:00 → 01:00).
    expect(zonedInstant("2026-03-08", 1, PACIFIC_TIME_ZONE)).toBe(
      "2026-03-08T09:00:00.000Z",
    );
    expect(zonedInstant("2026-03-08", 5, PACIFIC_TIME_ZONE)).toBe(
      "2026-03-08T12:00:00.000Z",
    );
    expect(zonedInstant("2026-11-01", 5, PACIFIC_TIME_ZONE)).toBe(
      "2026-11-01T13:00:00.000Z",
    );
    expect(zonedInstant("2026-11-01", 0, PACIFIC_TIME_ZONE)).toBe(
      "2026-11-01T07:00:00.000Z",
    );
    expect(zonedInstant("2026-11-16", 12, "Europe/Berlin")).toBe(
      "2026-11-16T11:00:00.000Z",
    );
  });

  it("reads calendar dates in a zone and counts days and months", () => {
    expect(
      dateInZone(Date.parse("2026-11-01T06:59:00.000Z"), PACIFIC_TIME_ZONE),
    ).toBe("2026-10-31");
    expect(
      dateInZone(Date.parse("2026-11-01T07:00:00.000Z"), PACIFIC_TIME_ZONE),
    ).toBe("2026-11-01");
    expect(addCalendarDays("2026-02-27", 2)).toBe("2026-03-01");
    expect(addCalendarDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(lastDayOfMonth("2028-02-10")).toBe("2028-02-29");
    expect(lastDayOfMonth("2026-12-01")).toBe("2026-12-31");
  });
});
