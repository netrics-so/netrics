import { describe, expect, it } from "vitest";

import { aggregationLabel, formatChange, formatValue } from "./format-metric";

describe("formatValue", () => {
  it.each([
    [1284, "signups", "1,284"],
    [12_900, "visitors", "12.9K"],
    [4_200_000, "visitors", "4.2M"],
    [3.14159, "seconds", "3.14"],
    [123_456, "EUR_minor", "€1,234.56"],
    [420_000_000, "USD_minor", "$4.2M"],
    [42.25, "percent", "42.3%"],
    [0.0353, "ratio", "3.53%"],
    [0.125, "ratio", "12.5%"],
    [4.5, "position", "4.5"],
    [12, "position", "12.0"],
    [null, "visitors", "—"],
  ])("%s %s → %s", (value, unit, expected) => {
    expect(formatValue(value, unit)).toBe(expected);
  });
});

describe("formatChange", () => {
  it("shows the relative change with a sign", () => {
    expect(formatChange(50, 0.5, "signups")).toEqual({
      direction: "up",
      text: "+50%",
    });
    expect(formatChange(-3, -0.034, "signups")).toEqual({
      direction: "down",
      text: "−3.4%",
    });
    expect(formatChange(0, 0, "signups")).toEqual({
      direction: "flat",
      text: "±0%",
    });
  });

  it("falls back to the absolute change without a ratio", () => {
    expect(formatChange(1500, null, "EUR_minor")).toEqual({
      direction: "up",
      text: "+€15",
    });
  });

  it("has nothing to show without a previous value", () => {
    expect(formatChange(null, null, "signups")).toBeNull();
  });
});

describe("Search Console readings", () => {
  it("shows a change of average position in places, not percent", () => {
    expect(formatChange(0.4, 0.1, "position")).toEqual({
      direction: "up",
      text: "+0.4",
    });
  });

  it("names a daily gauge's aggregations by day", () => {
    const gauge = { kind: "gauge", granularity: "day" };
    expect(aggregationLabel("last", gauge)).toBe("Latest day");
    expect(aggregationLabel("min", gauge)).toBe("Lowest day");
    expect(aggregationLabel("max", gauge)).toBe("Highest day");
    expect(aggregationLabel("sum", { kind: "delta", granularity: "day" })).toBe(
      "Total",
    );
  });
});
