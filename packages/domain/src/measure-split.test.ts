import { describe, expect, it } from "vitest";

import { measureSplitTotals, type MeasureSplitCell } from "./dashboard-data.js";

// A total with its split (#784): the groups of a value view summed.
const sum = { kind: "aggregate", aggregate: { op: "sum" } };
const row = (cell: Partial<MeasureSplitCell> & { value: unknown }) => ({
  measures: {
    m: { type: "integer", status: "ok", ...cell } as MeasureSplitCell,
  },
});

describe("measureSplitTotals", () => {
  it("adds the groups of a sum", () => {
    expect(
      measureSplitTotals(sum, "m", {
        rows: [row({ value: 412 }), row({ value: 223 })],
        totalRows: 2,
      }),
    ).toEqual([{ value: 635, type: "integer", status: "ok" }]);
  });

  it("adds decimals exactly, one total per currency", () => {
    expect(
      measureSplitTotals(sum, "m", {
        rows: [
          row({ value: "0.10", type: "decimal", currency: "EUR" }),
          row({ value: "5", type: "decimal", currency: "USD" }),
          row({ value: "0.20", type: "decimal", currency: "EUR" }),
        ],
      }),
    ).toEqual([
      { value: "0.3", type: "decimal", currency: "EUR", status: "ok" },
      { value: "5", type: "decimal", currency: "USD", status: "ok" },
    ]);
  });

  it("skips groups without a value and keeps a partial group's mark", () => {
    expect(
      measureSplitTotals(
        { kind: "aggregate", aggregate: { op: "count" } },
        "m",
        {
          rows: [
            row({ value: null, status: "missing" }),
            row({ value: 3, status: "partial" }),
            row({ value: 4 }),
          ],
        },
      ),
    ).toEqual([{ value: 7, type: "integer", status: "partial" }]);
  });

  it("has none where a total makes no sense", () => {
    const rows = [row({ value: 1 }), row({ value: 2 })];
    // Not additive: an average, a last value, a formula.
    expect(
      measureSplitTotals({ kind: "aggregate", aggregate: { op: "avg" } }, "m", {
        rows,
      }),
    ).toBeUndefined();
    expect(
      measureSplitTotals({ kind: "formula" }, "m", { rows }),
    ).toBeUndefined();
    expect(measureSplitTotals(undefined, "m", { rows })).toBeUndefined();
    // Not every group received.
    expect(
      measureSplitTotals(sum, "m", { rows, totalRows: 3 }),
    ).toBeUndefined();
    // No values at all, or text that is no number.
    expect(
      measureSplitTotals(sum, "m", { rows: [row({ value: null })] }),
    ).toBeUndefined();
    expect(
      measureSplitTotals(sum, "m", { rows: [row({ value: "n/a" })] }),
    ).toBeUndefined();
  });
});
