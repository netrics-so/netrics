import { describe, expect, it } from "vitest";

import {
  addDays,
  aggregateBuckets,
  bucketCombination,
  civilDate,
  compare,
  compatibleAggregations,
  isValidTimeZone,
  MAX_BUCKETS,
  PERIODS,
  planBuckets,
  resolvePeriod,
  startOfDay,
} from "./metrics.js";

const at = (iso: string) => new Date(iso);

describe("compatibleAggregations", () => {
  it("offers only aggregations that fit the kind and the connector declares", () => {
    expect(compatibleAggregations("delta", ["sum", "last", "avg"])).toEqual([
      "sum",
      "avg",
    ]);
    expect(compatibleAggregations("gauge", ["sum", "max", "last"])).toEqual([
      "last",
      "max",
    ]);
    expect(compatibleAggregations("counter", ["sum", "avg"])).toEqual([]);
  });

  it("combines deltas by sum and levels by their latest reading", () => {
    expect(bucketCombination("delta")).toBe("sum");
    expect(bucketCombination("gauge")).toBe("sum_of_last");
    expect(bucketCombination("counter")).toBe("sum_of_last");
  });
});

describe("aggregateBuckets", () => {
  const buckets = [
    { bucket: "2026-09-02T00:00:00.000Z", value: 5 },
    { bucket: "2026-09-01T00:00:00.000Z", value: 3 },
    { bucket: "2026-09-03T00:00:00.000Z", value: 10 },
  ];

  it.each([
    ["sum", 18],
    ["avg", 6],
    ["min", 3],
    ["max", 10],
    ["last", 10],
  ] as const)("%s", (aggregation, expected) => {
    expect(aggregateBuckets(aggregation, buckets)).toBe(expected);
  });

  it("is null without data", () => {
    expect(aggregateBuckets("sum", [])).toBeNull();
  });
});

describe("compare", () => {
  it("reports absolute and relative change", () => {
    expect(compare(150, 100)).toEqual({
      value: 150,
      previousValue: 100,
      delta: 50,
      ratio: 0.5,
    });
    expect(compare(-50, -100).ratio).toBe(0.5);
  });

  it("has no ratio against zero or missing data", () => {
    expect(compare(5, 0)).toMatchObject({ delta: 5, ratio: null });
    expect(compare(5, null)).toMatchObject({ delta: null, ratio: null });
    expect(compare(null, 5)).toMatchObject({ delta: null, ratio: null });
  });
});

describe("time zones", () => {
  it("validates IANA names", () => {
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });

  it("finds the calendar date in the zone", () => {
    const instant = at("2026-09-27T23:30:00Z");
    expect(civilDate(instant, "UTC")).toBe("2026-09-27");
    expect(civilDate(instant, "Europe/Berlin")).toBe("2026-09-28");
    expect(civilDate(instant, "America/Los_Angeles")).toBe("2026-09-27");
    expect(civilDate(instant, "Pacific/Kiritimati")).toBe("2026-09-28");
  });

  it("adds days across month and year ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it.each([
    ["UTC", "2026-09-28", "2026-09-28T00:00:00.000Z"],
    ["Europe/Berlin", "2026-09-28", "2026-09-27T22:00:00.000Z"],
    ["Europe/Berlin", "2026-01-15", "2026-01-14T23:00:00.000Z"],
    // DST starts at 02:00 and ends at 03:00: midnight itself is unaffected.
    ["Europe/Berlin", "2026-03-29", "2026-03-28T23:00:00.000Z"],
    ["Europe/Berlin", "2026-10-25", "2026-10-24T22:00:00.000Z"],
    ["Asia/Kolkata", "2026-09-28", "2026-09-27T18:30:00.000Z"],
    ["Pacific/Kiritimati", "2026-09-28", "2026-09-27T10:00:00.000Z"],
    ["America/Los_Angeles", "2026-09-28", "2026-09-28T07:00:00.000Z"],
    // Chile's DST starts at midnight: 00:00 does not exist, the day starts
    // at 01:00 local (-03:00).
    ["America/Santiago", "2026-09-06", "2026-09-06T04:00:00.000Z"],
  ])("%s: %s starts at %s", (timeZone, date, expected) => {
    expect(startOfDay(date, timeZone).toISOString()).toBe(expected);
  });
});

describe("resolvePeriod", () => {
  const berlin = "Europe/Berlin";

  it("today: since local midnight, against yesterday up to the same time", () => {
    const window = resolvePeriod("today", at("2026-09-28T08:30:00Z"), berlin);
    expect(window.dates).toEqual({ from: "2026-09-28", to: "2026-09-28" });
    expect(window.previousDates).toEqual({
      from: "2026-09-27",
      to: "2026-09-27",
    });
    expect(window.current.start.toISOString()).toBe("2026-09-27T22:00:00.000Z");
    expect(window.current.end.toISOString()).toBe("2026-09-28T08:30:00.000Z");
    expect(window.previous.start.toISOString()).toBe(
      "2026-09-26T22:00:00.000Z",
    );
    expect(window.previous.end.toISOString()).toBe("2026-09-27T08:30:00.000Z");
    expect(window.bucket).toBe("hour");
  });

  it("uses the workspace's date, not UTC's, just after local midnight", () => {
    const window = resolvePeriod("today", at("2026-09-27T22:30:00Z"), berlin);
    expect(window.dates.from).toBe("2026-09-28");
  });

  it("last 7 days includes today, against the 7 days before", () => {
    const window = resolvePeriod(
      "last_7_days",
      at("2026-09-28T12:00:00Z"),
      berlin,
    );
    expect(window.dates).toEqual({ from: "2026-09-22", to: "2026-09-28" });
    expect(window.previousDates).toEqual({
      from: "2026-09-15",
      to: "2026-09-21",
    });
    expect(window.bucket).toBe("day");
  });

  it("last 30 days", () => {
    const window = resolvePeriod(
      "last_30_days",
      at("2026-09-28T12:00:00Z"),
      "UTC",
    );
    expect(window.dates).toEqual({ from: "2026-08-30", to: "2026-09-28" });
    expect(window.previousDates).toEqual({
      from: "2026-07-31",
      to: "2026-08-29",
    });
  });

  it("this month, against the same days of the previous month", () => {
    const window = resolvePeriod(
      "this_month",
      at("2026-09-28T12:00:00Z"),
      berlin,
    );
    expect(window.dates).toEqual({ from: "2026-09-01", to: "2026-09-28" });
    expect(window.previousDates).toEqual({
      from: "2026-08-01",
      to: "2026-08-28",
    });
  });

  it("this month caps the previous month at its last day", () => {
    const window = resolvePeriod(
      "this_month",
      at("2026-03-31T12:00:00Z"),
      berlin,
    );
    expect(window.previousDates).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    // The previous window never runs into the current month.
    expect(window.previous.end.toISOString()).toBe("2026-02-28T23:00:00.000Z");
  });

  it("this month in January compares with December", () => {
    const window = resolvePeriod(
      "this_month",
      at("2027-01-10T12:00:00Z"),
      "UTC",
    );
    expect(window.previousDates).toEqual({
      from: "2026-12-01",
      to: "2026-12-10",
    });
  });

  it("keeps equal elapsed time across a DST change", () => {
    // Sunday 2026-10-25 has 25 hours in Berlin; the previous window is
    // measured in elapsed time, not wall-clock hours.
    const window = resolvePeriod("today", at("2026-10-26T09:00:00Z"), berlin);
    const currentLength =
      window.current.end.getTime() - window.current.start.getTime();
    const previousLength =
      window.previous.end.getTime() - window.previous.start.getTime();
    expect(previousLength).toBe(currentLength);
  });
});

describe("planBuckets", () => {
  it("selects daily metrics by reporting date at UTC midnight", () => {
    const window = resolvePeriod(
      "last_7_days",
      at("2026-09-28T12:00:00Z"),
      "Europe/Berlin",
    );
    const plan = planBuckets(window, "day");
    expect(plan.selection).toBe("dates");
    expect(plan.starts).toHaveLength(7);
    expect(plan.starts[0]).toBe("2026-09-22T00:00:00.000Z");
    expect(plan.starts[6]).toBe("2026-09-28T00:00:00.000Z");
  });

  it("puts a daily metric's today into one bucket", () => {
    const window = resolvePeriod(
      "today",
      at("2026-09-28T12:00:00Z"),
      "Europe/Berlin",
    );
    expect(planBuckets(window, "day").starts).toEqual([
      "2026-09-28T00:00:00.000Z",
    ]);
  });

  it("buckets hourly metrics by local day for multi-day periods", () => {
    const window = resolvePeriod(
      "last_7_days",
      at("2026-09-28T12:00:00Z"),
      "Europe/Berlin",
    );
    const plan = planBuckets(window, "hour");
    expect(plan).toMatchObject({ selection: "instants", unit: "day" });
    expect(plan.starts[0]).toBe("2026-09-21T22:00:00.000Z");
  });

  it("buckets today by hour, 25 of them on the day DST ends", () => {
    const window = resolvePeriod(
      "today",
      at("2026-10-25T22:59:00Z"),
      "Europe/Berlin",
    );
    const plan = planBuckets(window, "instant");
    expect(plan.unit).toBe("hour");
    expect(plan.starts).toHaveLength(25);
  });

  it("stays within the bounds for every period", () => {
    for (const period of PERIODS) {
      const window = resolvePeriod(period, at("2026-03-31T21:00:00Z"), "UTC");
      for (const granularity of ["day", "hour", "instant"] as const) {
        expect(planBuckets(window, granularity).starts.length).toBeLessThan(
          MAX_BUCKETS,
        );
      }
    }
  });
});
