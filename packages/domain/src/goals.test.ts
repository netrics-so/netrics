import { describe, expect, it } from "vitest";

import {
  GOAL_PERIODS,
  goalBindingProblem,
  goalPeriodEnd,
  goalProgress,
  isGoalPeriod,
  zonedIsoString,
} from "./goals.js";
import { PERIODS } from "./metrics.js";

const BERLIN = "Europe/Berlin";

describe("goal periods", () => {
  it("are the periods to date only", () => {
    expect(PERIODS.filter(isGoalPeriod)).toEqual([...GOAL_PERIODS]);
    expect(isGoalPeriod("last_30_days")).toBe(false);
  });

  it.each([
    // Wednesday 14 October 2026, 15:00 in Berlin (CEST).
    ["today", "2026-10-14T13:00:00Z", "2026-10-15T00:00:00+02:00"],
    ["this_week", "2026-10-14T13:00:00Z", "2026-10-19T00:00:00+02:00"],
    // The month ends after the DST change (25 October): +01:00.
    ["this_month", "2026-10-14T13:00:00Z", "2026-11-01T00:00:00+01:00"],
    ["this_quarter", "2026-10-14T13:00:00Z", "2027-01-01T00:00:00+01:00"],
    ["this_year", "2026-10-14T13:00:00Z", "2027-01-01T00:00:00+01:00"],
    // Monday 00:00 starts a new week: it ends next Monday.
    ["this_week", "2026-10-11T22:00:00Z", "2026-10-19T00:00:00+02:00"],
    // Sunday 23:59 is still the old week.
    ["this_week", "2026-10-11T21:59:00Z", "2026-10-12T00:00:00+02:00"],
    // Quarter boundaries: 30 June belongs to Q2, 1 July to Q3.
    ["this_quarter", "2026-06-30T21:00:00Z", "2026-07-01T00:00:00+02:00"],
    ["this_quarter", "2026-06-30T22:00:00Z", "2026-10-01T00:00:00+02:00"],
    // Leap day: February 2028 ends on 1 March.
    ["this_month", "2028-02-29T12:00:00Z", "2028-03-01T00:00:00+01:00"],
    // 1 January starts at 23:00 UTC in Berlin: the workspace zone decides.
    ["this_year", "2026-12-31T22:59:00Z", "2027-01-01T00:00:00+01:00"],
    ["this_year", "2026-12-31T23:00:00Z", "2028-01-01T00:00:00+01:00"],
  ] as const)("%s at %s ends %s", (period, now, end) => {
    expect(
      zonedIsoString(goalPeriodEnd(period, new Date(now), BERLIN), BERLIN),
    ).toBe(end);
  });

  it("ends at the zone's first instant of a day DST skips midnight on", () => {
    // Santiago skips 00:00–01:00 on 6 September 2026 (spring forward).
    const end = goalPeriodEnd(
      "today",
      new Date("2026-09-05T15:00:00Z"),
      "America/Santiago",
    );
    expect(zonedIsoString(end, "America/Santiago")).toBe(
      "2026-09-06T01:00:00-03:00",
    );
  });

  it("writes UTC with +00:00", () => {
    expect(zonedIsoString(new Date("2026-01-01T00:00:00Z"), "UTC")).toBe(
      "2026-01-01T00:00:00+00:00",
    );
  });
});

describe("goalBindingProblem", () => {
  const fine = {
    aggregation: "sum",
    period: "this_month",
    better: "higher",
    unit: "downloads",
    dimensions: {},
    displayCurrency: null,
  } as const;

  it("accepts a sum or last over a period to date", () => {
    expect(goalBindingProblem(fine)).toBeNull();
    expect(goalBindingProblem({ ...fine, aggregation: "last" })).toBeNull();
  });

  it("refuses other aggregations, rolling periods and lower-is-better", () => {
    expect(goalBindingProblem({ ...fine, aggregation: "avg" })).toBe(
      "aggregation_not_supported",
    );
    expect(goalBindingProblem({ ...fine, period: "last_30_days" })).toBe(
      "period_not_supported",
    );
    expect(
      goalBindingProblem({
        ...fine,
        aggregation: "last",
        unit: "position",
        better: "lower",
      }),
    ).toBe("goal_direction_unsupported");
  });

  it("needs one fixed currency for per-currency amounts", () => {
    const amount = { ...fine, unit: "currency_minor" };
    expect(goalBindingProblem(amount)).toBe("currency_required");
    expect(
      goalBindingProblem({ ...amount, dimensions: { currency: "EUR" } }),
    ).toBeNull();
    expect(
      goalBindingProblem({ ...amount, displayCurrency: "USD" }),
    ).toBeNull();
    // A single-currency unit is fixed already.
    expect(goalBindingProblem({ ...fine, unit: "EUR_minor" })).toBeNull();
  });
});

describe("goalProgress", () => {
  const now = new Date("2026-10-14T13:00:00Z");
  const base = {
    target: 100,
    aggregation: "sum",
    kind: "delta",
    period: "this_month",
    now,
    timeZone: BERLIN,
  } as const;
  const series = [
    { bucket: "2026-10-01T00:00:00.000Z", value: 40 },
    { bucket: "2026-10-02T00:00:00.000Z", value: null },
    { bucket: "2026-10-03T00:00:00.000Z", value: 50 },
    { bucket: "2026-10-04T00:00:00.000Z", value: 32 },
  ];

  it("gives value, unclipped progress and where the sum reached the target", () => {
    expect(goalProgress({ ...base, value: 122, series })).toEqual({
      value: 122,
      target: 100,
      progress: 1.22,
      reachedAt: "2026-10-04T00:00:00.000Z",
      periodEnd: "2026-11-01T00:00:00+01:00",
    });
  });

  it("has no reachedAt below the target", () => {
    const progress = goalProgress({
      ...base,
      target: 15_000,
      value: 12_480,
      series,
    });
    expect(progress.progress).toBeCloseTo(0.832, 6);
    expect(progress.reachedAt).toBeNull();
  });

  it("has no reachedAt for the last value of a gauge", () => {
    expect(
      goalProgress({
        ...base,
        aggregation: "last",
        kind: "gauge",
        value: 150,
        series: [{ bucket: "2026-10-01T00:00:00.000Z", value: 150 }],
      }).reachedAt,
    ).toBeNull();
  });

  it("is empty without data", () => {
    expect(goalProgress({ ...base, value: null, series: [] })).toEqual({
      value: null,
      target: 100,
      progress: null,
      reachedAt: null,
      periodEnd: "2026-11-01T00:00:00+01:00",
    });
  });
});
