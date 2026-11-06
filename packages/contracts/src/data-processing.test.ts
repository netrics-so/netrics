import { describe, expect, it } from "vitest";
import {
  modelMeasureCellSchema,
  semanticModelDefinitionSchema,
} from "./data-processing.js";

const model = (measure: Record<string, unknown>) => ({
  version: 1,
  datasets: ["sales"],
  relationships: [],
  dimensions: [
    {
      id: "day",
      name: "Day",
      datasetId: "sales",
      fieldId: "date",
      timeAlignment: "reporting_date",
    },
  ],
  measures: [
    {
      id: "revenue",
      name: "Revenue",
      kind: "aggregate",
      datasetId: "sales",
      aggregate: { id: "revenue", name: "Revenue", op: "sum", fieldId: "x" },
    },
    { id: "windowed", name: "Windowed", ...measure },
  ],
});
const rolling = (unit: string, length: number) => ({
  kind: "rolling",
  baseMeasureId: "revenue",
  timeDimensionId: "day",
  window: { unit, length },
});
const offset = (unit: string, length: number, output = "value") => ({
  kind: "period_offset",
  baseMeasureId: "revenue",
  timeDimensionId: "day",
  offset: { unit, length },
  output,
});
const valid = (measure: Record<string, unknown>) =>
  semanticModelDefinitionSchema.safeParse(model(measure)).success;

describe("windowed measure contracts", () => {
  it("accepts rolling windows within each unit's bounds", () => {
    expect(valid(rolling("day", 1))).toBe(true);
    expect(valid(rolling("day", 366))).toBe(true);
    expect(valid(rolling("week", 53))).toBe(true);
    expect(valid(rolling("month", 12))).toBe(true);
  });

  it("rejects rolling lengths and units outside the bounds", () => {
    expect(valid(rolling("day", 0))).toBe(false);
    expect(valid(rolling("day", 367))).toBe(false);
    expect(valid(rolling("week", 54))).toBe(false);
    expect(valid(rolling("month", 13))).toBe(false);
    expect(valid(rolling("day", 1.5))).toBe(false);
    expect(valid(rolling("year", 1))).toBe(false);
    expect(valid(rolling("range", 1))).toBe(false);
  });

  it("accepts period offsets with every output and the year/range units", () => {
    for (const output of ["value", "change", "percent_change"])
      expect(valid(offset("month", 1, output))).toBe(true);
    expect(valid(offset("year", 1))).toBe(true);
    expect(valid(offset("range", 1))).toBe(true);
    expect(valid(offset("week", 53))).toBe(true);
  });

  it("rejects period offsets outside the bounds or with unknown outputs", () => {
    expect(valid(offset("year", 2))).toBe(false);
    expect(valid(offset("range", 2))).toBe(false);
    expect(valid(offset("day", 367))).toBe(false);
    expect(valid(offset("month", 1, "ratio"))).toBe(false);
    expect(
      valid({ ...offset("month", 1), window: { unit: "day", length: 7 } }),
    ).toBe(false);
  });

  it("carries the compared interval on measure cells", () => {
    const cell = {
      value: "5",
      type: "decimal",
      status: "ok",
      comparedTo: { from: "2026-09-01", to: "2026-09-30" },
    };
    expect(modelMeasureCellSchema.parse(cell)).toEqual(cell);
    expect(
      modelMeasureCellSchema.safeParse({
        ...cell,
        comparedTo: { from: "2026-09-01T00:00:00Z", to: "2026-09-30" },
      }).success,
    ).toBe(false);
  });
});
