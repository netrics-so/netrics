import { describe, expect, it } from "vitest";

import {
  displayUnit,
  formatCompactValue,
  formatChange,
  formatValue,
  metricPickerLabel,
  observationBreakdown,
  pickableMetrics,
  sparkBucketLabel,
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
    expect(formatValue(value, unit, "en")).toBe(expected);
  });
});

describe("currency amounts in minor units", () => {
  it.each([
    // EUR and USD have two decimals; whole amounts drop ".00".
    [123_456, "EUR", "€1,234.56"],
    [150, "EUR", "€1.50"],
    [1_500, "EUR", "€15"],
    [99, "USD", "$0.99"],
    [420_000_000, "USD", "$4.2M"],
    // JPY has no minor unit: 1234 minor units are ¥1,234, not ¥12.34.
    [1_234, "JPY", "¥1,234"],
    [12_345_678, "JPY", "¥12.3M"],
    // BHD has three decimals.
    [1_234, "BHD", "BHD\u00a01.234"],
  ])("%s %s → %s", (value, currency, expected) => {
    expect(formatValue(value, `${currency}_minor`, "en")).toBe(expected);
    expect(
      formatValue(value, displayUnit("currency_minor", currency), "en"),
    ).toBe(expected);
  });

  it("resolves a per-currency unit with the tile's currency", () => {
    expect(displayUnit("currency_minor", "JPY")).toBe("JPY_minor");
    expect(displayUnit("currency_minor", null)).toBe("currency_minor");
    expect(displayUnit("EUR_minor", null)).toBe("EUR_minor");
    expect(displayUnit("visitors", "EUR")).toBe("visitors");
  });

  it("shows an amount without a currency as a plain number", () => {
    expect(formatValue(1_234, "currency_minor", "en")).toBe("1,234");
  });

  it("formats an absolute change in the currency", () => {
    expect(formatChange(-500, null, "JPY_minor")?.text).toBe("−¥500");
    expect(formatChange(250, null, "EUR_minor")?.text).toBe("+€2.50");
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
      metricPickerLabel({ name: "Clicks", dimensions: ["resource"] }, "en"),
    ).toBe("Clicks");
    expect(
      metricPickerLabel(
        {
          name: "Clicks by breakdown",
          dimensions: ["resource", "page", "query", "country", "device"],
        },
        "en",
      ),
    ).toBe("Clicks by breakdown (per page / query / country / device)");
    expect(
      metricPickerLabel(
        {
          name: "Requests by route",
          dimensions: ["resource", "route"],
        },
        "en",
      ),
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

describe("sparkBucketLabel", () => {
  it.each([
    ["2026-09-28T12:00:00.000Z", "today", "14:00"],
    ["2026-09-28T00:00:00.000Z", "last_7_days", "Sep 28"],
    // A reporting date is read in UTC, an instant bucket in the zone.
    ["2026-09-27T22:00:00.000Z", "last_30_days", "Sep 28"],
    ["2026-09-28T00:00:00.000Z", "last_90_days", "Week of Sep 28"],
    ["2026-08-31T22:00:00.000Z", "last_12_months", "Sep 2026"],
    ["2026-09-01T00:00:00.000Z", "last_12_months", "Sep 2026"],
  ] as const)("%s in %s → %s", (bucket, period, expected) => {
    expect(sparkBucketLabel(bucket, period, "Europe/Berlin", "en")).toBe(
      expected,
    );
  });

  it("has no label without a bucket", () => {
    expect(sparkBucketLabel(undefined, "last_90_days", "UTC", "en")).toBeNull();
  });
});

describe("German formatting", () => {
  it.each([
    [1284, "signups", "1.284"],
    [12.25, "seconds", "12,25"],
    [12_900, "visitors", "12,9\u00a0Tsd."],
    [4_200_000, "visitors", "4,2\u00a0Mio."],
    [999_950, "visitors", "1\u00a0Mio."],
    [123_456, "EUR_minor", "1.234,56\u00a0€"],
    [420_000_000, "USD_minor", "4,2\u00a0Mio.\u00a0$"],
    [42.25, "percent", "42,3%"],
    [0.0353, "ratio", "3,53%"],
    [4.5, "position", "4,5"],
  ])("%s %s → %s", (value, unit, expected) => {
    expect(formatValue(value, unit, "de")).toBe(expected);
  });

  it("compacts narrow values with the layout's suffixes", () => {
    // Widgets measure the shared compact text (studio vectors), so narrow
    // values keep K/M and only take the language's decimal separator.
    expect(formatCompactValue(12_345, "visitors", "de")).toBe("12,3K");
    expect(formatCompactValue(12_345, "visitors", "en")).toBe("12.3K");
  });

  it("formats changes and labels", () => {
    expect(formatChange(-3, -0.034, "signups", "higher", "de")?.text).toBe(
      "−3,4%",
    );
    expect(
      sparkBucketLabel(
        "2026-09-28T00:00:00.000Z",
        "last_90_days",
        "Europe/Berlin",
        "de",
      ),
    ).toBe("Woche vom 28. Sept.");
    expect(
      metricPickerLabel(
        { name: "Klicks", dimensions: ["resource", "page"] },
        "de",
      ),
    ).toBe("Klicks (pro page)");
    expect(
      metricPickerLabel(
        {
          name: "Klicks",
          dimensions: ["resource", "page", "query"],
          dimensionNames: { page: "Seite", query: "Suchanfrage" },
        },
        "de",
      ),
    ).toBe("Klicks (pro Seite / Suchanfrage)");
  });
});
