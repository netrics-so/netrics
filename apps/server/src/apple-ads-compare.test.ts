import type { Observation } from "@netrics/connector-sdk";
import {
  APPLE_ADS_METRIC_KEYS,
  appleAdsManifest,
  appleAdsDayObservations as dayObservations,
} from "@netrics/connectors";
import {
  compareChange,
  compareRatioUnit,
  compareUnitsProblem,
  ratioOf,
  toMajorUnits,
} from "@netrics/domain";
import { describe, expect, it } from "vitest";

// #372 (ADR 0020 section 6): Apple Ads stores no ratios. Cost per install
// (spend ÷ installs) and cost per tap (spend ÷ taps) come from the compare
// widget of ADR 0019 section 10, with the code it already has: the unit
// rule the dashboard service validates with, the ratio the device payload
// computes, and the ratio's unit.

function unitOf(key: string): string {
  const metric = appleAdsManifest.metrics.find((m) => m.key === key);
  if (!metric) throw new Error(`no metric ${key}`);
  return metric.unit;
}

/** A metric's sum over a period, as the query adds up series (`@>`). */
function sum(
  observations: Observation[],
  metricKey: string,
  filter: Record<string, string> = {},
): number {
  return observations
    .filter(
      (o) =>
        o.metricKey === metricKey &&
        Object.entries(filter).every(([k, v]) => o.dimensions[k] === v),
    )
    .reduce((total, o) => total + o.value, 0);
}

function metricsOf(date: string, spend: string, taps: number, tap: number) {
  return {
    date,
    localSpend: { amount: spend, currency: "EUR" },
    impressions: taps * 20,
    taps,
    tapInstalls: tap,
    viewInstalls: 5,
    totalInstalls: tap + 5,
    tapNewDownloads: tap,
    viewNewDownloads: 5,
    totalNewDownloads: tap + 5,
    tapRedownloads: 0,
    viewRedownloads: 0,
    totalRedownloads: 0,
  };
}

const note = () => undefined;
const week = (days: Array<[string, string, number, number]>) =>
  days.flatMap(([date, spend, taps, tap]) =>
    (["US", "DE"] as const).flatMap((country) =>
      dayObservations(
        { app: "1234567890", campaign: "42", country },
        metricsOf(date, spend, taps, tap),
        { accountCurrency: "EUR", note },
      ),
    ),
  );

describe("Apple Ads ratios in the compare widget (ADR 0019 §10)", () => {
  const spendSide = {
    unit: unitOf(APPLE_ADS_METRIC_KEYS.spend),
    dimensions: { currency: "EUR" },
  };

  it.each([
    ["CPI", APPLE_ADS_METRIC_KEYS.installs],
    ["CPT", APPLE_ADS_METRIC_KEYS.taps],
  ])("allows %s as an amount per unit (ratio format)", (_name, key) => {
    const denominator = { unit: unitOf(key), dimensions: {} };
    expect(
      compareUnitsProblem({
        numerator: spendSide,
        denominator,
        displayCurrency: null,
        format: "ratio",
      }),
    ).toBeNull();
    // A per-currency amount without a currency filter follows the display
    // currency (#191), like App Store proceeds.
    expect(
      compareUnitsProblem({
        numerator: { unit: spendSide.unit, dimensions: {} },
        denominator,
        displayCurrency: "USD",
        format: "ratio",
      }),
    ).toBeNull();
    // An amount over a count is not a percentage.
    expect(
      compareUnitsProblem({
        numerator: spendSide,
        denominator,
        displayCurrency: null,
        format: "percent",
      }),
    ).toBe("compare_units_incompatible");
  });

  it("computes CPI and CPT from the stored sums, and their change", () => {
    const current = week([
      ["2026-10-20", "100.00", 200, 45],
      ["2026-10-21", "50.50", 100, 20],
    ]);
    const previous = week([["2026-10-13", "120.00", 300, 55]]);

    const spend = sum(current, APPLE_ADS_METRIC_KEYS.spend, {
      currency: "EUR",
    });
    // Two countries a day: 2 × (100.00 + 50.50) EUR.
    expect(spend).toBe(30_100);
    // The headline installs are tap plus view: 2 × (50 + 25).
    const installs = sum(current, APPLE_ADS_METRIC_KEYS.installs);
    expect(installs).toBe(150);
    const taps = sum(current, APPLE_ADS_METRIC_KEYS.taps);
    expect(taps).toBe(600);

    const cpi = ratioOf(spend, installs);
    const cpt = ratioOf(spend, taps);
    // In minor units per install: €2.0067 per install, €0.5017 per tap.
    expect(toMajorUnits(cpi!, "EUR")).toBeCloseTo(2.0067, 4);
    expect(toMajorUnits(cpt!, "EUR")).toBeCloseTo(0.5017, 4);
    // The payload's ratio unit is the spend's currency.
    expect(compareRatioUnit("EUR_minor", "installs")).toBe("EUR_minor");
    expect(compareRatioUnit("EUR_minor", "taps")).toBe("EUR_minor");

    const previousCpi = ratioOf(
      sum(previous, APPLE_ADS_METRIC_KEYS.spend, { currency: "EUR" }),
      sum(previous, APPLE_ADS_METRIC_KEYS.installs),
    );
    // €240 over 120 installs: €2.00, so CPI rose by a third of a percent.
    expect(previousCpi).toBe(200);
    const change = compareChange({
      value: cpi,
      previousValue: previousCpi,
      format: "ratio",
    });
    expect(change?.direction).toBe("up");
    expect(change?.value).toBeCloseTo(0.00333, 4);
  });

  it("has no ratio for a day without installs", () => {
    const empty = week([["2026-10-20", "0.00", 0, 0]]).map((o) =>
      o.metricKey === APPLE_ADS_METRIC_KEYS.installs ? { ...o, value: 0 } : o,
    );
    expect(
      ratioOf(
        sum(empty, APPLE_ADS_METRIC_KEYS.spend),
        sum(empty, APPLE_ADS_METRIC_KEYS.installs),
      ),
    ).toBeNull();
  });
});
