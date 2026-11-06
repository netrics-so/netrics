import { describe, expect, it } from "vitest";

import type { WorkspaceMetric } from "@netrics/contracts";

import {
  formatGoalNumber,
  goalMetrics,
  goalNumbers,
  progressPercent,
  targetFromDisplay,
  targetToDisplay,
  targetUnit,
} from "./goals";

function metric(overrides: Partial<WorkspaceMetric>): WorkspaceMetric {
  return {
    connectionId: "00000000-0000-4000-8000-000000000001",
    connectionName: "Demo",
    connectorId: "demo",
    key: "demo.signups",
    name: "Signups",
    description: "",
    kind: "delta",
    unit: "signups",
    granularity: "day",
    dimensions: ["resource"],
    aggregations: ["sum", "avg"],
    better: "higher",
    role: "primary",
    ...overrides,
  } as WorkspaceMetric;
}

const none = { dimensions: {}, displayCurrency: null };

describe("goal metrics (#335)", () => {
  it("offers metrics where higher is better and a sum or last fits", () => {
    const keys = goalMetrics([
      metric({ key: "a" }),
      metric({ key: "b", kind: "gauge", aggregations: ["last", "avg"] }),
      metric({ key: "c", better: "lower", aggregations: ["last"] }),
      metric({ key: "d", aggregations: ["avg"] }),
    ]).map((m) => m.key);
    expect(keys).toEqual(["a", "b"]);
  });
});

describe("targets in display units", () => {
  it("knows the unit from the metric and the currency choice", () => {
    expect(targetUnit("signups", none)).toEqual({ kind: "number" });
    expect(targetUnit("ratio", none)).toEqual({ kind: "percent" });
    expect(targetUnit("EUR_minor", none)).toEqual({
      kind: "currency",
      currency: "EUR",
    });
    expect(targetUnit("currency_minor", none)).toEqual({
      kind: "currency_missing",
    });
    expect(
      targetUnit("currency_minor", {
        dimensions: { currency: "JPY" },
        displayCurrency: null,
      }),
    ).toEqual({ kind: "currency", currency: "JPY" });
    expect(
      targetUnit("currency_minor", { dimensions: {}, displayCurrency: "USD" }),
    ).toEqual({ kind: "currency", currency: "USD" });
  });

  it("enters major units and percent, stores minor units and shares", () => {
    const eur = { kind: "currency", currency: "EUR" } as const;
    expect(targetFromDisplay("1234.5", eur)).toBe(123_450);
    expect(targetFromDisplay("1234,5", eur)).toBe(123_450);
    expect(targetToDisplay(123_450, eur)).toBe(1234.5);
    const jpy = { kind: "currency", currency: "JPY" } as const;
    expect(targetFromDisplay("900", jpy)).toBe(900);
    expect(targetFromDisplay("12.5", { kind: "percent" })).toBe(0.125);
    expect(targetToDisplay(0.125, { kind: "percent" })).toBe(12.5);
    expect(targetFromDisplay("15000", { kind: "number" })).toBe(15_000);
    for (const input of ["", "0", "-3", "abc"]) {
      expect(targetFromDisplay(input, { kind: "number" })).toBeNull();
    }
  });

  it("rounds progress down: never 100 % before the goal is reached", () => {
    expect(progressPercent(0.832)).toBe(83);
    expect(progressPercent(0.999)).toBe(99);
    expect(progressPercent(0.29)).toBe(29);
    expect(progressPercent(1)).toBe(100);
    expect(progressPercent(1.224)).toBe(122);
  });

  it("formats numbers in full, in the reader's language", () => {
    expect(formatGoalNumber(15_000, { kind: "number" }, "en")).toBe("15,000");
    expect(formatGoalNumber(15_000, { kind: "number" }, "de")).toBe("15.000");
    expect(
      formatGoalNumber(123_450, { kind: "currency", currency: "EUR" }, "en"),
    ).toBe("€1,234.50");
    expect(formatGoalNumber(0.125, { kind: "percent" }, "en")).toBe("12.5%");
    expect(formatGoalNumber(null, { kind: "number" }, "en")).toBe("—");
    expect(
      goalNumbers(
        {
          target: 1_000_000,
          dimensions: {},
          displayCurrency: null,
          current: {
            value: 12_345,
            target: 1_000_000,
            progress: 0.012345,
            reachedAt: null,
            periodEnd: "2027-01-01T00:00:00+01:00",
            currency: "USD",
            approximate: false,
          },
        },
        "currency_minor",
        "en",
      ),
    ).toEqual({ value: "$123.45", target: "$10,000" });
  });
});
