import { FRESHNESS_LIMITS } from "@netrics/connector-sdk";
import { describe, expect, it } from "vitest";

import {
  PACIFIC_TIME_ZONE,
  addCalendarDays,
  boundFreshness,
  dateInZone,
  lastDayOfMonth,
  zonedInstant,
} from "./freshness.js";

describe("boundFreshness", () => {
  const perApp = (count: number, stream = "installs") =>
    Array.from({ length: count }, (_, i) => ({
      stream,
      resource: `com.example.app${i}`,
      dataThrough: i === 7 ? "2026-10-20" : "2026-10-25",
    }));
  const apps = (count: number) =>
    Array.from({ length: count }, (_, i) => `com.example.app${i}`);

  it("keeps entries within the limit as they are", () => {
    const entries = [...perApp(3), { stream: "listing_ratings" }];
    expect(boundFreshness(entries, apps(3))).toEqual(entries);
  });

  it("over the limit, reports one connection entry per stream with the oldest day", () => {
    // 1,000 apps × installs and ratings: 2,000 entries plus the listing.
    const entries = [
      ...perApp(1000),
      ...perApp(1000, "ratings"),
      { stream: "listing_ratings" },
    ];
    expect(entries.length).toBeGreaterThan(FRESHNESS_LIMITS.entries);
    expect(boundFreshness(entries, apps(1000))).toEqual([
      { stream: "installs", dataThrough: "2026-10-20" },
      { stream: "ratings", dataThrough: "2026-10-20" },
      { stream: "listing_ratings" },
    ]);
  });

  it("over the limit, drops a stream some resources have no entry for, rather than claim their day", () => {
    const entries = [...perApp(1000), ...perApp(999, "ratings")];
    expect(boundFreshness(entries, apps(1000), 1_500)).toEqual([
      { stream: "installs", dataThrough: "2026-10-20" },
    ]);
    // Without the resource list nothing can be collapsed safely.
    expect(boundFreshness(entries, undefined, 1_500)).toEqual([]);
  });

  it("drops an entry the host would refuse instead of failing the sync", () => {
    expect(
      boundFreshness([
        {
          stream: "performance",
          resource: "x".repeat(201),
          dataThrough: "2026-10-01",
        },
        { stream: "performance", dataThrough: "2026-10-01" },
      ]),
    ).toEqual([{ stream: "performance", dataThrough: "2026-10-01" }]);
  });
});

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
