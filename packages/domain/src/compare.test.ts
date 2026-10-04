import { describe, expect, it } from "vitest";

import {
  compareChange,
  compareLayout,
  compareRatioUnit,
  compareSideCurrency,
  compareUnitsProblem,
  ratioOf,
} from "./compare.js";
import {
  STUDIO_MIN_WIDGET_SIZE,
  labelFit,
  widgetTypeScale,
} from "./studio-layout.js";
import { dataWidgetCost, isDataWidgetType } from "./studio.js";

describe("ratioOf", () => {
  it("divides the numerator by the denominator", () => {
    expect(ratioOf(12_500, 38_200)).toBeCloseTo(0.327, 3);
    expect(ratioOf(4_620, 1_000)).toBe(4.62);
    expect(ratioOf(0, 5)).toBe(0);
    expect(ratioOf(-12, 4)).toBe(-3);
  });

  it("is null for a zero or missing side, never infinity", () => {
    expect(ratioOf(5, 0)).toBeNull();
    expect(ratioOf(0, 0)).toBeNull();
    expect(ratioOf(null, 5)).toBeNull();
    expect(ratioOf(5, null)).toBeNull();
    expect(ratioOf(Number.NaN, 5)).toBeNull();
    expect(ratioOf(5, Number.POSITIVE_INFINITY)).toBeNull();
    expect(ratioOf(1e300, 1e-300)).toBeNull();
  });
});

describe("compareChange", () => {
  it("is in percentage points for the percent format", () => {
    const change = compareChange({
      value: 0.327,
      previousValue: 0.308,
      format: "percent",
    });
    expect(change!.kind).toBe("points");
    expect(change!.value).toBeCloseTo(1.9, 9);
    expect(change!.direction).toBe("up");
    expect(
      compareChange({ value: 0.3, previousValue: 0.5, format: "percent" })!
        .direction,
    ).toBe("down");
    expect(
      compareChange({ value: 0, previousValue: 0, format: "percent" }),
    ).toEqual({ kind: "points", value: 0, direction: "flat" });
  });

  it("is relative for the ratio format, and null against zero", () => {
    const change = compareChange({
      value: 4.62,
      previousValue: 4.4,
      format: "ratio",
    });
    expect(change!.kind).toBe("relative");
    expect(change!.value).toBeCloseTo(0.05, 9);
    expect(
      compareChange({ value: -2, previousValue: 4, format: "ratio" })!.value,
    ).toBe(-1.5);
    expect(
      compareChange({ value: 3, previousValue: 0, format: "ratio" }),
    ).toBeNull();
  });

  it("is null without both ratios", () => {
    expect(
      compareChange({ value: null, previousValue: 0.3, format: "percent" }),
    ).toBeNull();
    expect(
      compareChange({ value: 0.3, previousValue: null, format: "ratio" }),
    ).toBeNull();
  });
});

const DESIGN = {
  label: "Downloads vs visitors",
  numerator: { full: "12,500", compact: "12.5K" },
  denominator: { full: "38,200", compact: "38.2K" },
  ratio: "32.7%",
  ratioLabel: "conversion",
  change: "▲ 1.9 pt",
};

describe("compareLayout", () => {
  it("fits everything at the 4 × 3 minimum at 16:9", () => {
    const layout = compareLayout({ ...DESIGN, width: 560, height: 294.65 });
    expect(layout.sizes.operand).toBe(48);
    expect(layout.sizes.caption).toBe(24);
    expect(layout.sizes.ratio).toBeGreaterThanOrEqual(64);
    expect(layout.showPeriod).toBe(true);
    expect(layout.showFooter).toBe(true);
    expect(layout.compact).toBe(false);
    expect(layout.ratioLine).toBe("beside");
  });

  it("drops the footer first, then the period line, never the ratio minimum", () => {
    const tight = compareLayout({
      ...DESIGN,
      width: 560,
      height: 294.65,
      fontScale: 1.3,
    });
    expect(tight.sizes.ratio).toBeCloseTo(64 * 1.3, 9);
    expect(tight.showFooter).toBe(false);
    const tighter = compareLayout({ ...DESIGN, width: 560, height: 200 });
    expect(tighter.showPeriod).toBe(false);
    expect(tighter.showFooter).toBe(false);
    expect(tighter.sizes.ratio).toBe(64);
  });

  it("grows the ratio with the widget and uses compact operands when narrow", () => {
    const large = compareLayout({ ...DESIGN, width: 1808, height: 892.4 });
    expect(large.sizes.ratio).toBeGreaterThan(200);
    const narrow = compareLayout({
      ...DESIGN,
      numerator: { full: "$1,234,567.89", compact: "$1.2M" },
      denominator: { full: "$98,765.43", compact: "$98.8K" },
      width: 560,
      height: 294.65,
    });
    expect(narrow.compact).toBe(true);
  });

  it("puts a long ratio label below the ratio", () => {
    const layout = compareLayout({
      ...DESIGN,
      ratioLabel: "average rating of the last thirty d",
      width: 560,
      height: 294.65,
    });
    expect(layout.ratioLine).toBe("below");
  });
});

describe("compareUnitsProblem", () => {
  const count = { unit: "count", dimensions: {} };
  const visitors = { unit: "visitors", dimensions: { resource: "prj_1" } };
  const proceeds = { unit: "currency_minor", dimensions: {} };
  const proceedsEur = {
    unit: "currency_minor",
    dimensions: { currency: "EUR" },
  };
  const adSpendEur = { unit: "EUR_minor", dimensions: {} };
  const adSpendUsd = { unit: "USD_minor", dimensions: {} };
  const problem = (
    numerator: { unit: string; dimensions: Record<string, string> },
    denominator: { unit: string; dimensions: Record<string, string> },
    format: "percent" | "ratio",
    displayCurrency: string | null = null,
  ) => compareUnitsProblem({ numerator, denominator, format, displayCurrency });

  it("allows two counts in either format", () => {
    expect(problem(count, visitors, "percent")).toBeNull();
    expect(problem(count, visitors, "ratio")).toBeNull();
  });

  it("allows an amount per unit only as a ratio", () => {
    expect(problem(proceeds, count, "ratio")).toBeNull();
    expect(problem(proceeds, count, "percent")).toBe(
      "compare_units_incompatible",
    );
  });

  it("allows a currency denominator only over the same currency", () => {
    expect(problem(proceedsEur, adSpendEur, "ratio")).toBeNull();
    expect(problem(proceeds, adSpendEur, "ratio", "EUR")).toBeNull();
    expect(problem(proceedsEur, adSpendUsd, "ratio")).toBe(
      "compare_units_incompatible",
    );
    expect(problem(proceeds, adSpendEur, "ratio")).toBe(
      "compare_units_incompatible",
    );
    expect(problem(proceeds, proceeds, "ratio")).toBeNull();
    expect(problem(count, adSpendEur, "ratio")).toBe(
      "compare_units_incompatible",
    );
    expect(problem(proceedsEur, adSpendEur, "percent")).toBe(
      "compare_units_incompatible",
    );
  });

  it("needs a side the display currency converts", () => {
    expect(problem(count, visitors, "percent", "EUR")).toBe(
      "currency_choice_conflict",
    );
    expect(problem(proceedsEur, adSpendEur, "ratio", "EUR")).toBe(
      "currency_choice_conflict",
    );
  });

  it("names the ratio's unit: a currency only for an amount per unit", () => {
    expect(compareRatioUnit("EUR_minor", "count")).toBe("EUR_minor");
    expect(compareRatioUnit("EUR_minor", "EUR_minor")).toBeNull();
    expect(compareRatioUnit("count", "visitors")).toBeNull();
    expect(compareRatioUnit(null, "count")).toBeNull();
    expect(compareSideCurrency(proceeds, null)).toBe("*");
    expect(compareSideCurrency(count, "EUR")).toBeNull();
  });
});

describe("the compare type", () => {
  it("is a 4 × 3 data widget with a label that counts twice", () => {
    expect(STUDIO_MIN_WIDGET_SIZE.compare).toEqual({ w: 4, h: 3 });
    expect(isDataWidgetType("compare")).toBe(true);
    expect(dataWidgetCost("compare")).toBe(2);
    expect(dataWidgetCost("metric")).toBe(1);
    expect(dataWidgetCost("clock")).toBe(0);
    expect(
      labelFit("Downloads · Wurfel", { type: "compare", w: 4, h: 3 }).fits,
    ).toBe(true);
    const scale = widgetTypeScale("compare", { x: 0, y: 0, w: 4, h: 3 });
    expect(scale.operand).toBe(48);
    expect(scale.valueMin).toBe(64);
  });
});
