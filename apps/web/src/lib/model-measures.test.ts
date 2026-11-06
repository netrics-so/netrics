import { describe, expect, it } from "vitest";
import type { DataField, SemanticModelDefinition } from "@netrics/domain";
import { dataErrorCodeKey } from "./data-errors";
import {
  changeMeasureSiblings,
  measureDependents,
  offsetPreset,
  rollingBaseOf,
  OFFSET_PRESETS,
  timeDimensionCandidates,
  toWindowedMeasure,
  windowBaseCandidates,
  windowLengthMax,
  type PeriodOffsetMeasure,
} from "./model-measures";

const fields: Record<string, DataField[]> = {
  sales: [
    { id: "date", name: "Date", type: "date", nullable: false },
    { id: "at", name: "At", type: "timestamp", nullable: false },
    { id: "app", name: "App", type: "string", nullable: false },
    { id: "amount", name: "Amount", type: "decimal", nullable: true },
  ],
};
const fieldsFor = (id: string) => fields[id] ?? [];
const model: SemanticModelDefinition = {
  version: 1,
  datasets: ["sales"],
  relationships: [],
  dimensions: [
    {
      id: "app",
      name: "App",
      datasetId: "sales",
      fieldId: "app",
    },
    {
      id: "day",
      name: "Day",
      datasetId: "sales",
      fieldId: "date",
      timeAlignment: "reporting_date",
    },
    {
      id: "moment",
      name: "Moment",
      datasetId: "sales",
      fieldId: "at",
      timeAlignment: "instant",
    },
  ],
  measures: [
    {
      id: "revenue",
      name: "Revenue",
      kind: "aggregate",
      datasetId: "sales",
      aggregate: {
        id: "revenue",
        name: "Revenue",
        op: "sum",
        fieldId: "amount",
      },
    },
    {
      id: "orders",
      name: "Orders",
      kind: "aggregate",
      datasetId: "sales",
      aggregate: { id: "orders", name: "Orders", op: "count" },
    },
    {
      id: "aov",
      name: "Average order",
      kind: "formula",
      expression: {
        kind: "call",
        fn: "divide",
        args: [
          { kind: "field", fieldId: "revenue" },
          { kind: "field", fieldId: "orders" },
        ],
      },
    },
    {
      id: "revenue7",
      name: "Revenue 7 days",
      kind: "rolling",
      baseMeasureId: "revenue",
      timeDimensionId: "day",
      window: { unit: "day", length: 7 },
    },
    {
      id: "revenue7_prev",
      name: "Revenue 7 days, previous week",
      kind: "period_offset",
      baseMeasureId: "revenue7",
      timeDimensionId: "day",
      offset: { unit: "week", length: 1 },
      output: "value",
    },
  ],
};
const offsetMeasure = model.measures[4] as PeriodOffsetMeasure;

describe("windowed measure editing", () => {
  it("maps each preset to its offset and recognises custom shifts", () => {
    expect(OFFSET_PRESETS.map((p) => [p.key, p.unit, p.length])).toEqual([
      ["previousDay", "day", 1],
      ["previousWeek", "week", 1],
      ["previousMonth", "month", 1],
      ["lastYear", "year", 1],
      ["previousPeriod", "range", 1],
    ]);
    for (const preset of OFFSET_PRESETS)
      expect(offsetPreset(preset)).toBe(preset.key);
    expect(offsetPreset({ unit: "day", length: 2 })).toBeNull();
    expect(offsetPreset({ unit: "month", length: 3 })).toBeNull();
  });

  it("bounds lengths by the shared model window limits", () => {
    expect(windowLengthMax("day")).toBe(366);
    expect(windowLengthMax("week")).toBe(53);
    expect(windowLengthMax("month")).toBe(12);
    expect(windowLengthMax("year")).toBe(1);
    expect(windowLengthMax("range")).toBe(1);
  });

  it("offers only date dimensions on reporting dates as anchors", () => {
    expect(timeDimensionCandidates(model, fieldsFor).map((d) => d.id)).toEqual([
      "day",
    ]);
    // A reporting-date alignment on a non-date column is not a valid anchor.
    expect(
      timeDimensionCandidates(
        {
          ...model,
          dimensions: [
            { ...model.dimensions[0]!, timeAlignment: "reporting_date" },
          ],
        },
        fieldsFor,
      ),
    ).toEqual([]);
  });

  it("limits rolling bases to aggregates and keeps offsets out of cycles", () => {
    const rolling = model.measures[3] as Parameters<
      typeof windowBaseCandidates
    >[1];
    expect(windowBaseCandidates(model, rolling).map((m) => m.id)).toEqual([
      "revenue",
      "orders",
    ]);
    // An offset may build on aggregates, formulas and rolling measures, but
    // not on itself; and a rolling measure cannot pick a measure built on it.
    expect(windowBaseCandidates(model, offsetMeasure).map((m) => m.id)).toEqual(
      ["revenue", "orders", "aov", "revenue7"],
    );
    const second: PeriodOffsetMeasure = {
      ...offsetMeasure,
      id: "second",
      baseMeasureId: "revenue7_prev",
    };
    const nested = { ...model, measures: [...model.measures, second] };
    expect(
      windowBaseCandidates(nested, {
        ...offsetMeasure,
      }).map((m) => m.id),
    ).not.toContain("second");
  });

  it("keeps offsets from picking formulas built on themselves", () => {
    const growth = {
      id: "growth",
      name: "Growth",
      kind: "formula" as const,
      expression: {
        kind: "call" as const,
        fn: "subtract" as const,
        args: [
          { kind: "field" as const, fieldId: "revenue7" },
          { kind: "field" as const, fieldId: "revenue7_prev" },
        ],
      },
    };
    const outer = {
      id: "outer",
      name: "Outer",
      kind: "formula" as const,
      expression: {
        kind: "call" as const,
        fn: "multiply" as const,
        args: [
          { kind: "field" as const, fieldId: "growth" },
          { kind: "literal" as const, type: "integer" as const, value: 2 },
        ],
      },
    };
    const withFormulas = {
      ...model,
      measures: [...model.measures, growth, outer],
    };
    expect(
      windowBaseCandidates(withFormulas, offsetMeasure).map((m) => m.id),
    ).toEqual(["revenue", "orders", "aov", "revenue7"]);
    // Formulas not built on the offset stay available.
    expect(
      windowBaseCandidates(withFormulas, {
        ...offsetMeasure,
        id: "other",
      }).map((m) => m.id),
    ).toContain("outer");
    expect(rollingBaseOf(withFormulas, "revenue").map((m) => m.id)).toEqual([
      "revenue7",
    ]);
    expect(rollingBaseOf(withFormulas, "revenue7")).toEqual([]);
  });

  it("converts a measure to a windowed kind with valid defaults", () => {
    const rolling = toWindowedMeasure(
      model.measures[2]!,
      "rolling",
      model,
      fieldsFor,
    );
    expect(rolling).toEqual({
      id: "aov",
      name: "Average order",
      requiredDimensions: undefined,
      kind: "rolling",
      baseMeasureId: "revenue",
      timeDimensionId: "day",
      window: { unit: "day", length: 7 },
    });
    // A rolling measure switched to a comparison keeps its base and anchor.
    expect(
      toWindowedMeasure(model.measures[3]!, "period_offset", model, fieldsFor),
    ).toMatchObject({
      kind: "period_offset",
      baseMeasureId: "revenue",
      timeDimensionId: "day",
      offset: { unit: "range", length: 1 },
      output: "value",
    });
    // An aggregate rolling over itself is not offered.
    expect(
      toWindowedMeasure(model.measures[0]!, "rolling", model, fieldsFor)
        .baseMeasureId,
    ).toBe("orders");
    // Without any candidates the selects stay empty and block saving.
    expect(
      toWindowedMeasure(
        model.measures[0]!,
        "rolling",
        { ...model, dimensions: [], measures: [model.measures[0]!] },
        fieldsFor,
      ),
    ).toMatchObject({ baseMeasureId: "", timeDimensionId: "" });
  });

  it("adds change and percent-change siblings once, sharing the comparison", () => {
    let n = 0;
    const added = changeMeasureSiblings(
      model,
      offsetMeasure,
      { change: "Change", percent_change: "Change %" },
      () => "new" + ++n,
    );
    expect(added).toEqual([
      {
        id: "new1",
        name: "Change",
        kind: "period_offset",
        baseMeasureId: "revenue7",
        timeDimensionId: "day",
        offset: { unit: "week", length: 1 },
        output: "change",
      },
      {
        id: "new2",
        name: "Change %",
        kind: "period_offset",
        baseMeasureId: "revenue7",
        timeDimensionId: "day",
        offset: { unit: "week", length: 1 },
        output: "percent_change",
      },
    ]);
    const after = { ...model, measures: [...model.measures, ...added] };
    expect(
      changeMeasureSiblings(
        after,
        offsetMeasure,
        { change: "", percent_change: "" },
        () => "x",
      ),
    ).toEqual([]);
    // A comparison already showing the change only adds the percentage.
    expect(
      changeMeasureSiblings(
        model,
        { ...offsetMeasure, output: "change" },
        { change: "c", percent_change: "p" },
        () => "y",
      ).map((m) => m.output),
    ).toEqual(["percent_change"]);
    // A different offset is a different comparison.
    expect(
      changeMeasureSiblings(
        after,
        { ...offsetMeasure, offset: { unit: "year", length: 1 } },
        { change: "c", percent_change: "p" },
        () => "z",
      ),
    ).toHaveLength(2);
  });

  it("finds the measures that would break when their base is removed", () => {
    expect(measureDependents(model, "revenue").map((m) => m.id)).toEqual([
      "revenue7",
    ]);
    expect(measureDependents(model, "revenue7").map((m) => m.id)).toEqual([
      "revenue7_prev",
    ]);
    expect(measureDependents(model, "orders")).toEqual([]);
  });

  it("explains window validation codes before limit, filter and unit codes", () => {
    for (const code of [
      "model_window_base_aggregate_required",
      "model_window_date_dimension_required",
      "model_window_length_invalid",
      "model_window_lookback_limit",
      "model_window_currency_mismatch",
    ])
      expect(dataErrorCodeKey(code)).toBe("window");
    expect(dataErrorCodeKey("model_window_time_grouping_required")).toBe(
      "windowGrouping",
    );
    expect(dataErrorCodeKey("model_window_time_range_required")).toBe(
      "windowRange",
    );
    expect(dataErrorCodeKey("dashboard_filter_window_unsupported")).toBe(
      "windowFilterMode",
    );
    expect(dataErrorCodeKey("model_window_time_filter_unsupported")).toBe(
      "windowFilter",
    );
    expect(dataErrorCodeKey("model_window_time_dimension_conflict")).toBe(
      "windowFilter",
    );
    expect(dataErrorCodeKey("aggregate_currency_mixed")).toBe("units");
    expect(dataErrorCodeKey("model_measure_cycle")).toBe("cycle");
    expect(dataErrorCodeKey("data_query_row_limit")).toBe("limit");
  });
});
