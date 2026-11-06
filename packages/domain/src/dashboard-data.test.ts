import { describe, expect, it } from "vitest";
import { compileRowExpression } from "./data-expression.js";
import {
  dashboardModelQuery,
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
