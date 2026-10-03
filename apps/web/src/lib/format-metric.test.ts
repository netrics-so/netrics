import { describe, expect, it } from "vitest";

import {
  aggregationLabel,
  formatChange,
  formatValue,
  metricPickerLabel,
  observationBreakdown,
  pickableMetrics,
} from "./format-metric";

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
      tone: "good",
      text: "+50%",
    });
    expect(formatChange(-3, -0.034, "signups")).toEqual({
      direction: "down",
      tone: "bad",
      text: "−3.4%",
    });
    expect(formatChange(0, 0, "signups")).toEqual({
      direction: "flat",
      tone: "neutral",
      text: "±0%",
    });
  });

  it("falls back to the absolute change without a ratio", () => {
    expect(formatChange(1500, null, "EUR_minor")).toEqual({
      direction: "up",
      tone: "good",
      text: "+€15",
    });
  });

  it("has nothing to show without a previous value", () => {
    expect(formatChange(null, null, "signups")).toBeNull();
  });
});

describe("Search Console readings", () => {
  it("shows a change of average position in places, not percent", () => {
    expect(formatChange(0.4, 0.1, "position", "lower")).toEqual({
      direction: "up",
      tone: "bad",
      text: "+0.4",
    });
    expect(formatChange(-1.2, -0.2, "position", "lower")).toMatchObject({
      direction: "down",
      tone: "good",
      text: "−1.2",
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

describe("the tile metric picker", () => {
  const metric = (
    key: string,
    role: "primary" | "helper",
    aggregations: string[] = ["sum"],
  ) => ({ key, role, aggregations });

  it("leaves out helpers and metrics no aggregation fits", () => {
    const metrics = [
      metric("clicks", "primary"),
      metric("position_sum", "helper"),
      metric("breakdown_position_sum", "helper"),
      metric("raw", "primary", []),
    ];
    expect(pickableMetrics(metrics).map((m) => m.key)).toEqual(["clicks"]);
  });

  it("names a breakdown by its dimensions besides the resource", () => {
    expect(
      metricPickerLabel({ name: "Clicks", dimensions: ["resource"] }),
    ).toBe("Clicks");
    expect(
      metricPickerLabel({
        name: "Clicks by breakdown",
        dimensions: ["resource", "page", "query", "country", "device"],
      }),
    ).toBe("Clicks by breakdown (per page / query / country / device)");
    expect(
      metricPickerLabel({
        name: "Requests by route",
        dimensions: ["resource", "route"],
      }),
    ).toBe("Requests by route (per route)");
  });
});

describe("observationBreakdown", () => {
  it("lists the values besides the resource", () => {
    expect(observationBreakdown({ resource: "sc-domain:a.example" })).toEqual(
      [],
    );
    expect(
      observationBreakdown({
        resource: "sc-domain:a.example",
        query: "running shoes",
        device: "MOBILE",
      }),
    ).toEqual([
      ["device", "MOBILE"],
      ["query", "running shoes"],
    ]);
  });
});
