import { describe, expect, it } from "vitest";
import { compileRowExpression } from "./data-expression.js";
import {
  dashboardModelQuery,
  measureInteractionDimension,
  measureInteractionSelected,
  measureInteractionValue,
  measureViewWindow,
  validateMeasureView,
  type DashboardDataFilter,
  type MeasureWidgetBinding,
} from "./dashboard-data.js";
const binding: MeasureWidgetBinding = {
  modelId: "store",
  measureIds: ["income"],
  groupBy: [],
  exclusions: [],
};
const filters: DashboardDataFilter[] = [
  {
    id: "country",
    name: "Country",
    type: "string",
    mode: "values",
    mappings: [{ modelId: "store", dimensionId: "territory" }],
    defaultValue: { kind: "values", values: ["DE"] },
  },
  {
    id: "day",
    name: "Date",
    type: "date",
    mode: "range",
    mappings: [{ modelId: "store", dimensionId: "day" }],
    defaultValue: null,
  },
];
function matches(
  values: Parameters<typeof dashboardModelQuery>[1],
  row: Record<string, unknown>,
  fs = filters,
) {
  const query = dashboardModelQuery(fs, values, binding);
  return query.filter
    ? compileRowExpression(query.filter, [
        { id: "territory", name: "Country", type: "string", nullable: true },
        { id: "day", name: "Date", type: "date", nullable: false },
      ]).evaluate(row).value
    : true;
}
describe("shared dashboard filters", () => {
  it("resets to defaults and applies explicit null as all values", () => {
    expect(matches({}, { territory: "FR" })).toBe(false);
    expect(matches({ country: null }, { territory: "FR" })).toBe(true);
    expect(
      matches(
        { country: { kind: "values", values: [null] } },
        { territory: null },
      ),
    ).toBe(true);
  });
  it("combines date and multiple dimension choices with the fixed scope", () => {
    const fs = filters.map((f) =>
      f.id === "country"
        ? { ...f, fixedValue: { kind: "values" as const, values: ["DE"] } }
        : f,
    );
    const values = {
      country: { kind: "values" as const, values: ["DE", "FR"] },
      day: { kind: "range" as const, from: "2026-11-01", to: "2026-11-03" },
    };
    expect(matches(values, { territory: "DE", day: "2026-11-03" }, fs)).toBe(
      true,
    );
    expect(matches(values, { territory: "FR", day: "2026-11-02" }, fs)).toBe(
      false,
    );
    expect(matches(values, { territory: "DE", day: "2026-11-04" }, fs)).toBe(
      false,
    );
    expect(matches({ country: null }, { territory: "FR" }, fs)).toBe(false);
  });
  it("refuses unknown filters, unmapped models, ambiguous mappings and silent exclusions", () => {
    expect(() =>
      dashboardModelQuery(filters, { unknown: null }, binding),
    ).toThrow("dashboard_filter_unknown");
    expect(() =>
      dashboardModelQuery(filters, {}, { ...binding, modelId: "other" }),
    ).toThrow("dashboard_filter_not_applicable");
    expect(() =>
      dashboardModelQuery(
        [
          {
            ...filters[0]!,
            mappings: [...filters[0]!.mappings, ...filters[0]!.mappings],
          },
        ],
        {},
        binding,
      ),
    ).toThrow("dashboard_filter_mapping_ambiguous");
    expect(() =>
      dashboardModelQuery(
        filters,
        {},
        { ...binding, exclusions: [{ filterId: "country", reason: "" }] },
      ),
    ).toThrow("dashboard_filter_exclusion_invalid");
  });
  it("allows a named exclusion but never an exclusion of a fixed scope", () => {
    const excluded = {
      ...binding,
      modelId: "other",
      exclusions: filters.map((f) => ({
        filterId: f.id,
        reason: "Independent total",
      })),
    };
    expect(dashboardModelQuery(filters, {}, excluded).filter).toBeUndefined();
    expect(() =>
      dashboardModelQuery(
        [{ ...filters[0]!, fixedValue: { kind: "values", values: ["DE"] } }],
        {},
        { ...excluded, exclusions: excluded.exclusions.slice(0, 1) },
      ),
    ).toThrow("dashboard_filter_fixed_scope_required");
  });
  it("validates types and ordered ranges before executing", () => {
    expect(() =>
      matches(
        { day: { kind: "range", from: "2026-11-04", to: "2026-11-01" } },
        {},
      ),
    ).toThrow("dashboard_filter_range_invalid");
    expect(() =>
      matches({ country: { kind: "range", from: "DE", to: null } }, {}),
    ).toThrow("dashboard_filter_value_invalid");
    expect(() =>
      matches({ day: { kind: "range", from: "bad", to: null } }, {}),
    ).toThrow();
  });
  it("keeps values scalar and charts at a declared grain", () => {
    expect(() =>
      validateMeasureView("value", { ...binding, groupBy: ["day"] }),
    ).toThrow("dashboard_measure_value_grain_invalid");
    expect(() => validateMeasureView("line", binding)).toThrow(
      "dashboard_measure_chart_grain_invalid",
    );
    expect(() =>
      validateMeasureView("line", { ...binding, groupBy: ["day"] }),
    ).not.toThrow();
  });
});

describe("measure view windows", () => {
  it("shows the most recent points of time-ordered charts and the first rows otherwise", () => {
    expect(measureViewWindow("line", "date")).toBe("last");
    expect(measureViewWindow("bar", "timestamp")).toBe("last");
    expect(measureViewWindow("bar", "string")).toBe("first");
    expect(measureViewWindow("table", "date")).toBe("first");
    const timed = { ...binding, groupBy: ["day"] };
    expect(dashboardModelQuery([], {}, timed, 20, "last")).toMatchObject({
      limit: 20,
      window: "last",
    });
    expect(dashboardModelQuery([], {}, timed, 20)).not.toHaveProperty("window");
  });
});
describe("large selectable dimensions", () => {
  it("keeps a hundred selections in a bounded expression rather than a deep OR tree", () => {
    const countries = Array.from(
      { length: 100 },
      (_, index) => `country-${index}`,
    );
    expect(
      matches(
        { country: { kind: "values", values: countries } },
        { territory: "country-99" },
      ),
    ).toBe(true);
    expect(
      matches(
        { country: { kind: "values", values: countries } },
        { territory: "elsewhere" },
      ),
    ).toBe(false);
  });
});

describe("declared chart-to-filter interactions", () => {
  const grouped: MeasureWidgetBinding = {
    ...binding,
    groupBy: ["territory"],
    interaction: { filterId: "country" },
  };
  it("reads the value from the grouping the filter maps to", () => {
    expect(measureInteractionDimension(filters, grouped, "bar")).toBe(
      "territory",
    );
    expect(
      measureInteractionDimension(
        filters,
        { ...grouped, groupBy: ["day", "territory"] },
        "table",
      ),
    ).toBe("territory");
    expect(
      measureInteractionDimension(
        filters,
        { ...grouped, groupBy: ["day"], interaction: { filterId: "day" } },
        "line",
      ),
    ).toBe("day");
  });
  it("rejects every unsupported combination with its own code", () => {
    const fail =
      (b: MeasureWidgetBinding, view: "value" | "bar" = "bar") =>
      () =>
        measureInteractionDimension(filters, b, view);
    expect(fail({ ...grouped, groupBy: [] }, "value")).toThrow(
      "dashboard_interaction_view_unsupported",
    );
    expect(fail({ ...grouped, interaction: { filterId: "gone" } })).toThrow(
      "dashboard_interaction_filter_unknown",
    );
    expect(
      fail({
        ...grouped,
        exclusions: [{ filterId: "country", reason: "Global total" }],
      }),
    ).toThrow("dashboard_interaction_filter_excluded");
    expect(fail({ ...grouped, groupBy: ["day"] })).toThrow(
      "dashboard_interaction_dimension_not_grouped",
    );
    expect(fail({ ...grouped, modelId: "other" })).toThrow(
      "dashboard_interaction_dimension_not_grouped",
    );
    expect(fail({ ...grouped, interaction: undefined })).toThrow(
      "dashboard_interaction_missing",
    );
  });
  it("sets a values filter to the value and a range filter to that one value", () => {
    const [country, day] = filters as [
      DashboardDataFilter,
      DashboardDataFilter,
    ];
    expect(measureInteractionValue(country, "FR")).toEqual({
      kind: "values",
      values: ["FR"],
    });
    expect(measureInteractionValue(country, null)).toEqual({
      kind: "values",
      values: [null],
    });
    expect(measureInteractionValue(day, "2026-01-02")).toEqual({
      kind: "range",
      from: "2026-01-02",
      to: "2026-01-02",
    });
    expect(measureInteractionValue(day, null)).toBeNull();
    // The resulting choice is an ordinary, validated filter value.
    expect(
      matches(
        { day: measureInteractionValue(day, "2026-01-02") },
        { territory: "DE", day: "2026-01-03" },
      ),
    ).toBe(false);
    expect(
      matches(
        { day: measureInteractionValue(day, "2026-01-02") },
        { territory: "DE", day: "2026-01-02" },
      ),
    ).toBe(true);
    expect(
      measureInteractionSelected(
        country,
        { kind: "values", values: ["FR"] },
        "FR",
      ),
    ).toBe(true);
    expect(
      measureInteractionSelected(
        country,
        { kind: "values", values: ["FR", "DE"] },
        "FR",
      ),
    ).toBe(false);
    expect(measureInteractionSelected(country, null, "FR")).toBe(false);
  });
});
