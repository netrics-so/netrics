import { describe, expect, it } from "vitest";

import {
  addDays,
  addUpBuckets,
  aggregateBuckets,
  alignedPreviousSeries,
  dimensionValueLabel,
  rankBreakdown,
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

describe("resolvePeriod, periods to date (ADR 0019 §3)", () => {
  const berlin = "Europe/Berlin";
  const iso = (date: Date) => date.toISOString();

  it("this week: Monday to now, against last week up to the same weekday and time", () => {
    // Thursday 2026-10-01, 10:30 in Berlin (UTC+2).
    const window = resolvePeriod(
      "this_week",
      at("2026-10-01T08:30:00Z"),
      berlin,
    );
    expect(window.dates).toEqual({ from: "2026-09-28", to: "2026-10-01" });
    expect(window.previousDates).toEqual({
      from: "2026-09-21",
      to: "2026-09-24",
    });
    expect(iso(window.current.start)).toBe("2026-09-27T22:00:00.000Z");
    expect(iso(window.previous.start)).toBe("2026-09-20T22:00:00.000Z");
    expect(iso(window.previous.end)).toBe("2026-09-24T08:30:00.000Z");
    expect(window.bucket).toBe("day");
    expect(window.series).toBe("day");
    expect(planBuckets(window, "day").starts).toEqual([
      "2026-09-28T00:00:00.000Z",
      "2026-09-29T00:00:00.000Z",
      "2026-09-30T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
    ]);
  });

  it("this week starts at Monday 00:00 in the workspace zone", () => {
    // Monday 00:00 in Berlin: a new, empty week against an empty one.
    const monday = resolvePeriod(
      "this_week",
      at("2026-09-27T22:00:00Z"),
      berlin,
    );
    expect(monday.dates).toEqual({ from: "2026-09-28", to: "2026-09-28" });
    expect(monday.previousDates).toEqual({
      from: "2026-09-21",
      to: "2026-09-21",
    });
    expect(iso(monday.previous.end)).toBe(iso(monday.previous.start));
    // A minute before, it is still Sunday: the whole week but one minute.
    const sunday = resolvePeriod(
      "this_week",
      at("2026-09-27T21:59:00Z"),
      berlin,
    );
    expect(sunday.dates).toEqual({ from: "2026-09-21", to: "2026-09-27" });
    expect(sunday.previousDates).toEqual({
      from: "2026-09-14",
      to: "2026-09-20",
    });
    expect(iso(sunday.previous.end)).toBe("2026-09-20T21:59:00.000Z");
  });

  it("this week compares at the same wall-clock time across a DST change", () => {
    // Tuesday 2026-10-27, 10:00 CET; last Tuesday 10:00 was CEST.
    const window = resolvePeriod(
      "this_week",
      at("2026-10-27T09:00:00Z"),
      berlin,
    );
    expect(window.previousDates).toEqual({
      from: "2026-10-19",
      to: "2026-10-20",
    });
    expect(iso(window.current.start)).toBe("2026-10-25T23:00:00.000Z");
    expect(iso(window.previous.start)).toBe("2026-10-18T22:00:00.000Z");
    expect(iso(window.previous.end)).toBe("2026-10-20T08:00:00.000Z");
    // On the day of the change itself: Sunday 12:00 CET is 13 hours after
    // midnight, the Sunday before at 12:00 CEST.
    const sunday = resolvePeriod(
      "this_week",
      at("2026-10-25T11:00:00Z"),
      berlin,
    );
    expect(iso(sunday.previous.end)).toBe("2026-10-18T10:00:00.000Z");
  });

  it("this quarter: from the quarter's first day, against the same day of the previous quarter", () => {
    // 2026-08-15 is day 46 of Q3; day 46 of Q2 is 05-16.
    const window = resolvePeriod(
      "this_quarter",
      at("2026-08-15T12:00:00Z"),
      "UTC",
    );
    expect(window.dates).toEqual({ from: "2026-07-01", to: "2026-08-15" });
    expect(window.previousDates).toEqual({
      from: "2026-04-01",
      to: "2026-05-16",
    });
    expect(iso(window.previous.end)).toBe("2026-05-16T12:00:00.000Z");
    expect(window.series).toBe("week");
  });

  it("this quarter starts on 1 January, April, July and October", () => {
    for (const [now, from, previousFrom] of [
      ["2026-01-01T00:00:00Z", "2026-01-01", "2025-10-01"],
      ["2026-04-01T00:00:00Z", "2026-04-01", "2026-01-01"],
      ["2026-07-01T00:00:00Z", "2026-07-01", "2026-04-01"],
      ["2026-10-01T00:00:00Z", "2026-10-01", "2026-07-01"],
      ["2026-12-31T23:59:00Z", "2026-10-01", "2026-07-01"],
    ] as const) {
      const window = resolvePeriod("this_quarter", at(now), "UTC");
      expect(window.dates.from).toBe(from);
      expect(window.previousDates.from).toBe(previousFrom);
    }
    // Midnight on 1 October in Berlin is still 30 September in UTC.
    const berlinStart = resolvePeriod(
      "this_quarter",
      at("2026-09-30T22:00:00Z"),
      berlin,
    );
    expect(berlinStart.dates).toEqual({ from: "2026-10-01", to: "2026-10-01" });
    expect(berlinStart.previousDates).toEqual({
      from: "2026-07-01",
      to: "2026-07-01",
    });
  });

  it("this quarter caps the previous quarter at its last day", () => {
    // 30 September is day 92 of Q3; Q2 has 91 days.
    const september = resolvePeriod(
      "this_quarter",
      at("2026-09-30T12:00:00Z"),
      "UTC",
    );
    expect(september.previousDates).toEqual({
      from: "2026-04-01",
      to: "2026-06-30",
    });
    // A capped previous quarter runs to the end of its last day, never into
    // the current quarter.
    expect(iso(september.previous.end)).toBe("2026-07-01T00:00:00.000Z");
    // 30 June is day 91 of Q2; Q1 2026 has 90 days.
    const june = resolvePeriod(
      "this_quarter",
      at("2026-06-30T12:00:00Z"),
      "UTC",
    );
    expect(june.previousDates).toEqual({
      from: "2026-01-01",
      to: "2026-03-31",
    });
    // Q1 of a leap year has 91 days; Q4 before it 92.
    const leap = resolvePeriod(
      "this_quarter",
      at("2028-03-31T12:00:00Z"),
      "UTC",
    );
    expect(leap.previousDates).toEqual({
      from: "2027-10-01",
      to: "2027-12-30",
    });
  });

  it("this quarter across a DST change: weeks from local Mondays, same wall time", () => {
    // Tuesday 2026-11-10, 12:00 CET is day 41 of Q4; day 41 of Q3 is 08-10,
    // 12:00 CEST.
    const window = resolvePeriod(
      "this_quarter",
      at("2026-11-10T11:00:00Z"),
      berlin,
    );
    expect(window.previousDates).toEqual({
      from: "2026-07-01",
      to: "2026-08-10",
    });
    expect(iso(window.current.start)).toBe("2026-09-30T22:00:00.000Z");
    expect(iso(window.previous.end)).toBe("2026-08-10T10:00:00.000Z");
    const plan = planBuckets(window, "hour");
    expect(plan).toMatchObject({ unit: "day", series: "week" });
    // Thursday 1 October (partial first week), then Mondays at local
    // midnight, in summer and in winter time.
    expect(plan.starts.slice(0, 2)).toEqual([
      "2026-09-30T22:00:00.000Z",
      "2026-10-04T22:00:00.000Z",
    ]);
    expect(plan.starts).toContain("2026-10-25T23:00:00.000Z");
    expect(plan.starts.at(-1)).toBe("2026-11-08T23:00:00.000Z");
    expect(plan.starts).toHaveLength(7);
  });

  it("this year: from 1 January, against last year up to the same date", () => {
    const window = resolvePeriod(
      "this_year",
      at("2026-09-28T12:00:00Z"),
      berlin,
    );
    expect(window.dates).toEqual({ from: "2026-01-01", to: "2026-09-28" });
    expect(window.previousDates).toEqual({
      from: "2025-01-01",
      to: "2025-09-28",
    });
    // 14:00 CEST on both dates.
    expect(iso(window.previous.end)).toBe("2025-09-28T12:00:00.000Z");
    expect(window.series).toBe("month");
    expect(planBuckets(window, "day").starts).toHaveLength(9);
  });

  it("this year starts at 1 January 00:00 in the workspace zone", () => {
    const window = resolvePeriod(
      "this_year",
      at("2026-12-31T23:00:00Z"),
      berlin,
    );
    expect(window.dates).toEqual({ from: "2027-01-01", to: "2027-01-01" });
    expect(window.previousDates).toEqual({
      from: "2026-01-01",
      to: "2026-01-01",
    });
    expect(iso(window.current.start)).toBe("2026-12-31T23:00:00.000Z");
    expect(iso(window.previous.end)).toBe("2025-12-31T23:00:00.000Z");
  });

  it("this year turns 29 February into 28 February", () => {
    const leap = resolvePeriod("this_year", at("2028-02-29T12:00:00Z"), "UTC");
    expect(leap.dates).toEqual({ from: "2028-01-01", to: "2028-02-29" });
    expect(leap.previousDates).toEqual({
      from: "2027-01-01",
      to: "2027-02-28",
    });
    expect(iso(leap.previous.end)).toBe("2027-03-01T00:00:00.000Z");
    // The year after a leap year compares up to the same date, the leap
    // day included.
    const after = resolvePeriod("this_year", at("2029-03-01T12:00:00Z"), "UTC");
    expect(after.previousDates).toEqual({
      from: "2028-01-01",
      to: "2028-03-01",
    });
    expect(iso(after.previous.end)).toBe("2028-03-01T12:00:00.000Z");
  });

  it("this year compares at the same wall-clock time across a DST change", () => {
    // 1 April 2026 10:00 CEST against 1 April 2025 10:00 CEST, though the
    // year started in winter time.
    const window = resolvePeriod(
      "this_year",
      at("2026-04-01T08:00:00Z"),
      berlin,
    );
    expect(iso(window.current.start)).toBe("2025-12-31T23:00:00.000Z");
    expect(iso(window.previous.end)).toBe("2025-04-01T08:00:00.000Z");
  });

  it("aligns previous points by weekday, day of the quarter and month", () => {
    const day = (date: string, value: number) => ({
      bucket: `${date}T00:00:00.000Z`,
      value,
    });
    const week = resolvePeriod("this_week", at("2026-10-01T12:00:00Z"), "UTC");
    const weekPoints = alignedPreviousSeries(
      week,
      planBuckets(week, "day"),
      "sum",
      [day("2026-09-21", 1), day("2026-09-24", 4)],
    );
    expect(weekPoints.map((p) => p.value)).toEqual([1, null, null, 4]);

    // Q3's 07-01 and 07-04 sit where Q4's 10-01 and 10-04 do (the partial
    // first week, Thursday to Sunday), 07-06 where 10-06 does (a Tuesday).
    const quarter = resolvePeriod(
      "this_quarter",
      at("2026-10-14T12:00:00Z"),
      "UTC",
    );
    const quarterPoints = alignedPreviousSeries(
      quarter,
      planBuckets(quarter, "day"),
      "sum",
      [day("2026-07-01", 1), day("2026-07-04", 2), day("2026-07-06", 5)],
    );
    expect(quarterPoints).toEqual([
      { bucket: "2026-10-01T00:00:00.000Z", value: 3 },
      { bucket: "2026-10-05T00:00:00.000Z", value: 5 },
      { bucket: "2026-10-12T00:00:00.000Z", value: null },
    ]);

    const year = resolvePeriod("this_year", at("2026-03-15T12:00:00Z"), "UTC");
    const yearPoints = alignedPreviousSeries(
      year,
      planBuckets(year, "day"),
      "sum",
      [day("2025-01-31", 1), day("2025-03-15", 2), day("2025-03-16", 9)],
    );
    expect(yearPoints.map((p) => p.value)).toEqual([1, null, 2]);
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

describe("alignedPreviousSeries (ADR 0015 line charts)", () => {
  const day = (date: string, value: number) => ({
    bucket: `${date}T00:00:00.000Z`,
    value,
  });

  it("puts each previous day under the day at the same position", () => {
    // Tuesday 2025-07-15: 07-09..07-15 against 07-02..07-08.
    const window = resolvePeriod(
      "last_7_days",
      at("2025-07-15T12:00:00Z"),
      "UTC",
    );
    const plan = planBuckets(window, "day");
    const previous = alignedPreviousSeries(window, plan, "sum", [
      day("2025-07-02", 1),
      day("2025-07-05", 4),
      day("2025-07-08", 7),
      day("2025-07-09", 99), // the current window: never part of it
    ]);
    expect(previous.map((p) => p.bucket)).toEqual(plan.starts);
    expect(previous.map((p) => p.value)).toEqual([
      1,
      null,
      null,
      4,
      null,
      null,
      7,
    ]);
  });

  it("rolls the previous 90 days into the current window's weeks", () => {
    // Monday 2026-09-28 in Berlin: 07-01 (Wednesday)..09-28 against
    // 04-02..06-30. 04-02 sits where 07-01 does, 04-06 where 07-05 (still
    // the first, partial week) and 04-07 where 07-06 (the first Monday).
    const window = resolvePeriod(
      "last_90_days",
      at("2026-09-28T12:00:00Z"),
      "Europe/Berlin",
    );
    const plan = planBuckets(window, "day");
    const previous = alignedPreviousSeries(window, plan, "sum", [
      day("2026-04-02", 2),
      day("2026-04-06", 3),
      day("2026-04-07", 10),
      day("2026-06-30", 5),
    ]);
    expect(previous).toHaveLength(plan.starts.length);
    expect(previous.slice(0, 3)).toEqual([
      { bucket: "2026-07-01T00:00:00.000Z", value: 5 },
      { bucket: "2026-07-06T00:00:00.000Z", value: 10 },
      { bucket: "2026-07-13T00:00:00.000Z", value: null },
    ]);
    expect(previous.at(-1)).toEqual({
      bucket: "2026-09-28T00:00:00.000Z",
      value: 5,
    });
  });

  it("aligns months by month and this month by day of the month", () => {
    const now = at("2026-09-28T12:00:00Z");
    const year = resolvePeriod("last_12_months", now, "UTC");
    const yearPlan = planBuckets(year, "day");
    const months = alignedPreviousSeries(year, yearPlan, "sum", [
      day("2024-10-01", 1),
      day("2024-10-31", 2),
      day("2025-09-28", 3),
    ]);
    expect(months).toHaveLength(12);
    expect(months[0]).toEqual({ bucket: "2025-10-01T00:00:00.000Z", value: 3 });
    expect(months[11]).toEqual({
      bucket: "2026-09-01T00:00:00.000Z",
      value: 3,
    });

    // March 2026 so far against February: day 28 of February is day 28 of
    // March.
    const march = resolvePeriod(
      "this_month",
      at("2026-03-30T12:00:00Z"),
      "UTC",
    );
    const marchPlan = planBuckets(march, "day");
    const days = alignedPreviousSeries(march, marchPlan, "sum", [
      day("2026-02-01", 1),
      day("2026-02-28", 28),
    ]);
    expect(days).toHaveLength(30);
    expect(days[0]?.value).toBe(1);
    expect(days[27]?.value).toBe(28);
    expect(days[28]?.value).toBeNull();
  });

  it("aligns today's hours with yesterday's in the workspace zone", () => {
    // 10:30 in Berlin (UTC+2): today so far is 11 hours.
    const window = resolvePeriod(
      "today",
      at("2025-07-15T08:30:00Z"),
      "Europe/Berlin",
    );
    const plan = planBuckets(window, "hour");
    const previous = alignedPreviousSeries(window, plan, "last", [
      { bucket: "2025-07-13T22:00:00.000Z", value: 5 }, // yesterday 00:00
      { bucket: "2025-07-14T08:00:00.000Z", value: 9 }, // yesterday 10:00
    ]);
    expect(previous).toHaveLength(11);
    expect(previous[0]).toEqual({
      bucket: "2025-07-14T22:00:00.000Z",
      value: 5,
    });
    expect(previous[10]).toEqual({
      bucket: "2025-07-15T08:00:00.000Z",
      value: 9,
    });
    expect(previous.slice(1, 10).every((p) => p.value === null)).toBe(true);
  });

  it("is all nulls without previous data", () => {
    const window = resolvePeriod(
      "last_7_days",
      at("2025-07-15T12:00:00Z"),
      "UTC",
    );
    const plan = planBuckets(window, "day");
    expect(
      alignedPreviousSeries(window, plan, "sum", []).every(
        (p) => p.value === null,
      ),
    ).toBe(true);
  });
});

describe("rankBreakdown (ADR 0015 bar charts)", () => {
  const row = (key: string | null, bucket: string, value: number) => ({
    key,
    bucket: `2025-07-${bucket}T00:00:00.000Z`,
    value,
  });

  it("keeps the largest groups and adds the rest up as Others", () => {
    const rows = [
      row("a", "01", 5),
      row("a", "02", 5),
      row("b", "01", 30),
      row("c", "01", 1),
      row("d", "02", 2),
      row("e", "01", 10),
      row(null, "02", 4), // a series without the dimension
      row("Others", "01", 6), // the connector's own remainder
    ];
    expect(rankBreakdown("sum", rows, 3)).toEqual({
      groups: [
        { key: "b", value: 30 },
        { key: "a", value: 10 },
        { key: "e", value: 10 },
      ],
      others: { value: 13, groups: 3 },
    });
    expect(rankBreakdown("sum", rows.slice(0, 6), 10)).toEqual({
      groups: [
        { key: "b", value: 30 },
        { key: "a", value: 10 },
        { key: "e", value: 10 },
        { key: "d", value: 2 },
        { key: "c", value: 1 },
      ],
      others: null,
    });
  });

  it("forms each group like a tile, and Others over the summed days", () => {
    const rows = [
      row("a", "01", 10),
      row("a", "02", 20),
      row("b", "01", 1),
      row("b", "02", 3),
      row("c", "01", 2),
      row("c", "02", 2),
      row("d", "01", 1),
    ];
    // Latest reading per group; Others' latest day is c 2 (+ nothing of d).
    expect(rankBreakdown("last", rows, 1)).toEqual({
      groups: [{ key: "a", value: 20 }],
      others: { value: 5, groups: 3 },
    });
    // Highest day: Others' days are 1+2+1 = 4 and 3+2 = 5.
    expect(rankBreakdown("max", rows, 1).others).toEqual({
      value: 5,
      groups: 3,
    });
    expect(rankBreakdown("avg", rows, 1).groups).toEqual([
      { key: "a", value: 15 },
    ]);
  });

  it("is empty without rows", () => {
    expect(rankBreakdown("sum", [], 5)).toEqual({ groups: [], others: null });
  });

  it("adds buckets up per bucket in order", () => {
    expect(
      addUpBuckets([
        { bucket: "b", value: 1 },
        { bucket: "a", value: 2 },
        { bucket: "b", value: 3 },
      ]),
    ).toEqual([
      { bucket: "a", value: 2 },
      { bucket: "b", value: 4 },
    ]);
  });
});

describe("dimensionValueLabel", () => {
  it("names resources, territories and countries, else shows the value", () => {
    expect(dimensionValueLabel("resource", "app-1", "Wurfel")).toBe("Wurfel");
    expect(dimensionValueLabel("resource", "app-9", null)).toBe("app-9");
    expect(dimensionValueLabel("territory", "DE")).toBe("Germany");
    expect(dimensionValueLabel("country", "US")).toBe("United States");
    expect(dimensionValueLabel("territory", "Unknown")).toBe("Unknown");
    expect(dimensionValueLabel("territory", "XX")).toBe("XX");
    expect(dimensionValueLabel("device", "iPhone")).toBe("iPhone");
    expect(dimensionValueLabel("device", "")).toBe("(none)");
  });
});
