import { describe, expect, it } from "vitest";

import { deviceFeatures, withoutMeasureSplits } from "./measure-compat.js";

// Screens without `measure_split` (#784): a grouped value view arrives as
// its total alone, or with no row where a total makes no sense.
const cell = (value: string, currency?: string) => ({
  value,
  type: "decimal",
  ...(currency ? { currency } : {}),
  status: "ok",
});
const split = (totals?: unknown[]) => ({
  id: "w",
  type: "measure",
  measureIds: ["proceeds"],
  groupBy: ["store", "currency"],
  options: { view: "value", limit: 20 },
  data: {
    status: "ok",
    result: {
      groupBy: ["store", "currency"],
      rows: [
        {
          dimensions: { store: "apple", currency: "EUR" },
          measures: { proceeds: cell("12", "EUR") },
        },
        {
          dimensions: { store: "google", currency: "USD" },
          measures: { proceeds: cell("3", "USD") },
        },
      ],
      totalRows: 2,
    },
    ...(totals ? { totals } : {}),
    freshness: {
      kind: "periodic",
      stream: "Sales",
      fetchedAt: "2026-11-19T00:00:00Z",
      sources: [{ source: "App Store" }, { source: "Google Play" }],
    },
  },
});
const payload = (...widgets: unknown[]) => ({
  version: "abc",
  slides: [{ widgets }],
});
type Shaped = {
  version: string;
  slides: {
    widgets: { groupBy: unknown[]; data: Record<string, unknown> }[];
  }[];
};

describe("withoutMeasureSplits", () => {
  it("gives a total in several currencies no row", () => {
    const shaped = withoutMeasureSplits(
      payload(split([cell("12", "EUR"), cell("3", "USD")])),
    ) as unknown as Shaped;
    const widget = shaped.slides[0]!.widgets[0]!;
    expect(widget.groupBy).toEqual([]);
    expect(widget.data.result).toMatchObject({ rows: [], totalRows: 0 });
    expect(widget.data).not.toHaveProperty("totals");
    expect(widget.data.freshness).not.toHaveProperty("sources");
    expect(shaped.version).toBe("abc.v");
  });

  it("gives a split without a total no row", () => {
    const widget = (withoutMeasureSplits(payload(split())) as unknown as Shaped)
      .slides[0]!.widgets[0]!;
    expect(widget.data.result).toMatchObject({ rows: [], groupBy: [] });
  });

  it("keeps a payload without grouped value views as it is", () => {
    const table = { ...split(), options: { view: "table", limit: 20 } };
    const plain = payload(table, { type: "metric", data: {} });
    expect(withoutMeasureSplits(plain)).toBe(plain);
    const tiles = { version: "v1", tiles: [] };
    expect(withoutMeasureSplits(tiles)).toBe(tiles);
  });

  it("reads only the features it knows", () => {
    expect([...deviceFeatures("hologram, measure_split,,")]).toEqual([
      "measure_split",
    ]);
    expect(deviceFeatures(undefined).size).toBe(0);
  });
});
