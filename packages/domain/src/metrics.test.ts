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
  MAX_WINDOW_DAYS,
  PERIODS,
  planBuckets,
  resolvePeriod,
  SERIES_UNITS,
  seriesPoints,
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

describe("resolvePeriod, longer periods (#212)", () => {
  it("last 90 days includes today, against the 90 days before", () => {
    const window = resolvePeriod(
      "last_90_days",
      at("2026-09-28T12:00:00Z"),
      "Europe/Berlin",
    );
    expect(window.dates).toEqual({ from: "2026-07-01", to: "2026-09-28" });
    expect(window.previousDates).toEqual({
      from: "2026-04-02",
      to: "2026-06-30",
    });
    expect(window.bucket).toBe("day");
    expect(window.series).toBe("week");
  });

  it("last 12 months: this month so far and the 11 before, against the 12 before up to the same day", () => {
    const window = resolvePeriod(
      "last_12_months",
      at("2026-09-28T12:00:00Z"),
      "Europe/Berlin",
    );
    expect(window.dates).toEqual({ from: "2025-10-01", to: "2026-09-28" });
    expect(window.previousDates).toEqual({
      from: "2024-10-01",
      to: "2025-09-28",
    });
    expect(window.series).toBe("month");
    // The previous window never runs into the current one.
    expect(window.previous.end.getTime()).toBeLessThanOrEqual(
      window.current.start.getTime(),
    );
  });

  it("last 12 months crosses the year and caps a leap day", () => {
    const window = resolvePeriod(
      "last_12_months",
      at("2028-02-29T12:00:00Z"),
      "UTC",
    );
    expect(window.dates).toEqual({ from: "2027-03-01", to: "2028-02-29" });
    expect(window.previousDates).toEqual({
      from: "2026-03-01",
      to: "2027-02-28",
    });
  });

  it("last 12 months on the 31st compares up to a shorter month's end", () => {
    const window = resolvePeriod(
      "last_12_months",
      at("2026-03-31T12:00:00Z"),
      "UTC",
    );
    expect(window.dates.from).toBe("2025-04-01");
    expect(window.previousDates).toEqual({
      from: "2024-04-01",
      to: "2025-03-31",
    });
    const january = resolvePeriod(
      "last_12_months",
      at("2027-01-15T12:00:00Z"),
      "UTC",
    );
    expect(january.dates.from).toBe("2026-02-01");
    expect(january.previousDates.from).toBe("2025-02-01");
  });

  it("uses the workspace's date at the turn of a month", () => {
    // 22:30 UTC on Sep 30 is Oct 1 in Berlin: a new month starts.
    const window = resolvePeriod(
      "last_12_months",
      at("2026-09-30T22:30:00Z"),
      "Europe/Berlin",
    );
    expect(window.dates).toEqual({ from: "2025-11-01", to: "2026-10-01" });
    expect(window.current.start.toISOString()).toBe("2025-10-31T23:00:00.000Z");
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
      for (const now of ["2026-03-31T21:00:00Z", "2028-12-31T23:59:00Z"]) {
        const window = resolvePeriod(period, at(now), "UTC");
        for (const granularity of ["day", "hour", "instant"] as const) {
          expect(planBuckets(window, granularity).starts.length).toBeLessThan(
            MAX_BUCKETS,
          );
        }
        const days =
          (Date.parse(`${window.dates.to}T00:00:00Z`) -
            Date.parse(`${window.dates.from}T00:00:00Z`)) /
            86_400_000 +
          1;
        expect(days).toBeLessThanOrEqual(MAX_WINDOW_DAYS);
      }
    }
  });

  it("has a sparkline unit for every period", () => {
    expect(Object.keys(SERIES_UNITS).sort()).toEqual([...PERIODS].sort());
  });

  it("puts 90 days into weeks starting Monday, the first one partial", () => {
    // 2026-07-01 is a Wednesday; 2026-09-28 a Monday.
    const window = resolvePeriod(
      "last_90_days",
      at("2026-09-28T12:00:00Z"),
      "Europe/Berlin",
    );
    const plan = planBuckets(window, "day");
    expect(plan).toMatchObject({
      selection: "dates",
      unit: "day",
      series: "week",
    });
    expect(plan.starts[0]).toBe("2026-07-01T00:00:00.000Z");
    expect(plan.starts[1]).toBe("2026-07-06T00:00:00.000Z");
    expect(plan.starts.at(-1)).toBe("2026-09-28T00:00:00.000Z");
    expect(plan.starts).toHaveLength(14);
  });

  it("starts weeks at local midnight across a DST change for hourly metrics", () => {
    const window = resolvePeriod(
      "last_90_days",
      at("2026-11-10T12:00:00Z"),
      "Europe/Berlin",
    );
    const plan = planBuckets(window, "hour");
    expect(plan).toMatchObject({ selection: "instants", unit: "day" });
    // Monday Oct 19 is in summer time, Monday Oct 26 in winter time.
    expect(plan.starts).toContain("2026-10-18T22:00:00.000Z");
    expect(plan.starts).toContain("2026-10-25T23:00:00.000Z");
  });

  it("puts 12 months into calendar months", () => {
    const window = resolvePeriod(
      "last_12_months",
      at("2026-09-28T12:00:00Z"),
      "Europe/Berlin",
    );
    const daily = planBuckets(window, "day");
    expect(daily.series).toBe("month");
    expect(daily.starts).toHaveLength(12);
    expect(daily.starts[0]).toBe("2025-10-01T00:00:00.000Z");
    expect(daily.starts.at(-1)).toBe("2026-09-01T00:00:00.000Z");
    const hourly = planBuckets(window, "instant");
    expect(hourly.starts[0]).toBe("2025-09-30T22:00:00.000Z");
    // November starts in winter time, April in summer time.
    expect(hourly.starts[1]).toBe("2025-10-31T23:00:00.000Z");
    expect(hourly.starts[6]).toBe("2026-03-31T22:00:00.000Z");
  });
});

describe("seriesPoints", () => {
  const day = (date: string, value: number) => ({
    bucket: `${date}T00:00:00.000Z`,
    value,
  });

  it("leaves daily points as they are", () => {
    const window = resolvePeriod(
      "last_7_days",
      at("2026-09-28T12:00:00Z"),
      "UTC",
    );
    const buckets = [day("2026-09-22", 1), day("2026-09-28", 2)];
    expect(seriesPoints(planBuckets(window, "day"), "sum", buckets)).toEqual(
      buckets,
    );
  });

  it("rolls days into weeks with the tile's aggregation", () => {
    const window = resolvePeriod(
      "last_90_days",
      at("2026-09-28T12:00:00Z"),
      "Europe/Berlin",
    );
    const plan = planBuckets(window, "day");
    // Wed Jul 1 – Sun Jul 5 is the partial first week; Mon Jul 6 starts the next.
    const buckets = [
      day("2026-07-01", 3),
      day("2026-07-05", 1),
      day("2026-07-06", 10),
      day("2026-07-12", 20),
      day("2026-09-28", 7),
    ];
    expect(seriesPoints(plan, "sum", buckets)).toEqual([
      day("2026-07-01", 4),
      day("2026-07-06", 30),
      day("2026-09-28", 7),
    ]);
    expect(seriesPoints(plan, "avg", buckets)).toEqual([
      day("2026-07-01", 2),
      day("2026-07-06", 15),
      day("2026-09-28", 7),
    ]);
    expect(seriesPoints(plan, "max", buckets)[1]).toEqual(
      day("2026-07-06", 20),
    );
    expect(seriesPoints(plan, "last", buckets)[0]).toEqual(
      day("2026-07-01", 1),
    );
  });

  it("rolls local days of hourly metrics into local months", () => {
    const window = resolvePeriod(
      "last_12_months",
      at("2026-09-28T12:00:00Z"),
      "Europe/Berlin",
    );
    const plan = planBuckets(window, "hour");
    const buckets = [
      // Oct 31 and Nov 1 local midnights, either side of the DST change.
      { bucket: "2025-10-30T23:00:00.000Z", value: 1 },
      { bucket: "2025-10-31T23:00:00.000Z", value: 5 },
      { bucket: "2025-11-30T23:00:00.000Z", value: 2 },
    ];
    expect(seriesPoints(plan, "sum", buckets)).toEqual([
      { bucket: "2025-09-30T22:00:00.000Z", value: 1 },
      { bucket: "2025-10-31T23:00:00.000Z", value: 5 },
      { bucket: "2025-11-30T23:00:00.000Z", value: 2 },
    ]);
    // Every point is one of the plan's starts.
    for (const point of seriesPoints(plan, "sum", buckets)) {
      expect(plan.starts).toContain(point.bucket);
    }
  });

  it("keeps a tile's average per day, not per week", () => {
    // Two days in one week and one in another: the tile averages days.
    const buckets = [
      day("2026-07-06", 10),
      day("2026-07-07", 20),
      day("2026-07-13", 60),
    ];
    expect(aggregateBuckets("avg", buckets)).toBe(30);
    const window = resolvePeriod(
      "last_90_days",
      at("2026-09-28T12:00:00Z"),
      "UTC",
    );
    const weekly = seriesPoints(planBuckets(window, "day"), "sum", buckets);
    // Averaging the weekly totals would say 45.
    expect(aggregateBuckets("avg", weekly)).toBe(45);
  });
});
