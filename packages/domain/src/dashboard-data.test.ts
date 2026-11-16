import { describe, expect, it } from "vitest";
import { compileRowExpression } from "./data-expression.js";
import {
  dashboardModelQuery,
  formatDataDate,
  MEASURE_UNIT_FRACTION_DIGITS,
  roundDecimalText,
  measureInteractionDimension,
  measureInteractionSelected,
  measureInteractionValue,
  measureViewWindow,
  connectionResourceKey,
  slideScopeConflicts,
  slideScopeResource,
  validateDeviceFilterScope,
  validateMeasureView,
  validateSlideFilterScope,
  type DashboardDataFilter,
  type DeviceFilterScope,
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
  it("intersects every viewer choice with a screen's fixed scope", () => {
    const scope: DeviceFilterScope = {
      country: { kind: "values", values: ["DE"] },
    };
    const scoped = (
      values: Parameters<typeof dashboardModelQuery>[1],
      row: Record<string, unknown>,
    ) => {
      const query = dashboardModelQuery(
        filters,
        values,
        binding,
        1000,
        "first",
        scope,
      );
      return compileRowExpression(query.filter!, [
        { id: "territory", name: "Country", type: "string", nullable: true },
        { id: "day", name: "Date", type: "date", nullable: false },
      ]).evaluate(row).value;
    };
    // "All values", a wider list and another value never widen it.
    for (const values of <Parameters<typeof dashboardModelQuery>[1][]>[
      {},
      { country: null },
      { country: { kind: "values" as const, values: ["DE", "FR"] } },
      { country: { kind: "values" as const, values: [] } },
    ]) {
      expect(scoped(values, { territory: "DE", day: "2026-11-01" })).toBe(true);
      expect(scoped(values, { territory: "FR", day: "2026-11-01" })).toBe(
        false,
      );
    }
    expect(
      scoped(
        { country: { kind: "values", values: ["FR"] } },
        { territory: "DE", day: "2026-11-01" },
      ),
    ).toBe(false);
    // A scoped range filter keeps its bounds whatever the choice.
    const days = dashboardModelQuery(
      filters,
      { day: null },
      binding,
      10,
      "first",
      {
        day: { kind: "range", from: "2026-11-01", to: null },
      },
    );
    expect(JSON.stringify(days.filter)).toContain("2026-11-01");
  });
  it("refuses a screen scope that cannot be applied instead of dropping it", () => {
    const de = { kind: "values" as const, values: ["DE"] };
    expect(() =>
      dashboardModelQuery(filters, {}, binding, 10, "first", { gone: de }),
    ).toThrow("device_scope_filter_unknown");
    expect(() =>
      dashboardModelQuery(
        filters,
        {},
        {
          ...binding,
          exclusions: [{ filterId: "country", reason: "All markets" }],
        },
        10,
        "first",
        { country: de },
      ),
    ).toThrow("device_scope_not_applicable");
    for (const value of [
      { kind: "values" as const, values: [] },
      { kind: "range" as const, from: null, to: null },
      { kind: "range" as const, from: "DE", to: null },
      { kind: "values" as const, values: [1] },
    ])
      expect(() =>
        validateDeviceFilterScope(filters, { country: value }),
      ).toThrow("device_scope_value_invalid");
    expect(() =>
      validateDeviceFilterScope(filters, {
        day: { kind: "range", from: "2026-11-04", to: "2026-11-01" },
      }),
    ).toThrow("device_scope_value_invalid");
    expect(() =>
      validateDeviceFilterScope(filters, { country: de }),
    ).not.toThrow();
  });
  it("applies a slide's scope like a fixed value, unless the widget excludes the filter (#707)", () => {
    const fields = [
      {
        id: "territory",
        name: "Country",
        type: "string" as const,
        nullable: true,
      },
      { id: "day", name: "Date", type: "date" as const, nullable: false },
    ];
    const row = (territory: string) => ({ territory, day: "2026-11-01" });
    const de = { country: { kind: "values" as const, values: ["DE"] } },
      fr = { country: { kind: "values" as const, values: ["FR"] } };
    const shows = (
      slide: Parameters<typeof dashboardModelQuery>[6],
      territory: string,
      widget = binding,
      screen: DeviceFilterScope = {},
    ) => {
      const query = dashboardModelQuery(
        filters,
        { country: null },
        widget,
        10,
        "first",
        screen,
        slide,
      );
      return query.filter
        ? compileRowExpression(query.filter, fields).evaluate(row(territory))
            .value
        : true;
    };
    // Two slides of one dashboard read different rows.
    expect(shows(de, "DE")).toBe(true);
    expect(shows(de, "FR")).toBe(false);
    expect(shows(fr, "FR")).toBe(true);
    expect(shows(fr, "DE")).toBe(false);
    // A viewer's choice narrows it further, never widens it.
    const chosen = dashboardModelQuery(
      filters,
      { country: { kind: "values", values: ["DE", "FR"] } },
      binding,
      10,
      "first",
      {},
      fr,
    );
    expect(
      compileRowExpression(chosen.filter!, fields).evaluate(row("DE")).value,
    ).toBe(false);
    // An excluded filter ignores the slide's value as well.
    const total = {
      ...binding,
      exclusions: [{ filterId: "country", reason: "All markets" }],
    };
    expect(shows(fr, "DE", total)).toBe(true);
    // A screen's scope still applies: with a conflicting slide nothing shows.
    expect(shows(fr, "FR", binding, de)).toBe(false);
    expect(shows(fr, "DE", binding, de)).toBe(false);
    // An unknown filter or a scope that restricts nothing is refused.
    expect(() =>
      dashboardModelQuery(
        filters,
        {},
        binding,
        10,
        "first",
        {},
        {
          gone: { kind: "values", values: ["DE"] },
        },
      ),
    ).toThrow("slide_scope_filter_unknown");
    expect(() =>
      validateSlideFilterScope(filters, {
        country: { kind: "values", values: [] },
      }),
    ).toThrow("slide_scope_value_invalid");
  });
  it("tells a slide's scope that contradicts a screen's scope (#707)", () => {
    const values = (...values: string[]) => ({
      country: { kind: "values" as const, values },
    });
    expect(slideScopeConflicts(filters, values("FR"), values("DE"))).toBe(true);
    expect(slideScopeConflicts(filters, values("FR"), values("DE", "FR"))).toBe(
      false,
    );
    expect(slideScopeConflicts(filters, values("FR"), {})).toBe(false);
    // Values compare as the query compares them, by the filter's type.
    const typed: DashboardDataFilter[] = [
      {
        id: "price",
        name: "Price",
        type: "decimal",
        mode: "values",
        mappings: [],
        defaultValue: null,
      },
      {
        id: "at",
        name: "At",
        type: "timestamp",
        mode: "values",
        mappings: [],
        defaultValue: null,
      },
    ];
    const one = (id: string, ...values: unknown[]) => ({
      [id]: { kind: "values" as const, values },
    });
    expect(
      slideScopeConflicts(typed, one("price", "1.0"), one("price", "1.00")),
    ).toBe(false);
    expect(
      slideScopeConflicts(typed, one("price", "1.0"), one("price", "1.01")),
    ).toBe(true);
    expect(
      slideScopeConflicts(
        typed,
        one("at", "2026-11-01T00:00:00Z"),
        one("at", "2026-11-01T00:00:00.000Z"),
      ),
    ).toBe(false);
    expect(
      slideScopeConflicts(typed, one("price", null), one("price", null, "2")),
    ).toBe(false);
    expect(
      slideScopeConflicts(typed, one("price", null), one("price", "2")),
    ).toBe(true);
    expect(slideScopeConflicts(filters, {}, values("DE"))).toBe(false);
    const days = (from: string | null, to: string | null) => ({
      day: { kind: "range" as const, from, to },
    });
    expect(
      slideScopeConflicts(
        filters,
        days("2026-11-01", "2026-11-05"),
        days("2026-11-06", null),
      ),
    ).toBe(true);
    expect(
      slideScopeConflicts(
        filters,
        days("2026-11-01", "2026-11-06"),
        days("2026-11-06", null),
      ),
    ).toBe(false);
    expect(
      slideScopeConflicts(
        filters,
        days(null, "2026-11-01"),
        days(null, "2026-10-01"),
      ),
    ).toBe(false);
  });
  it("lets connection widgets follow a slide's app through their resource (#707)", () => {
    const apple = "0b1c6c0e-1e43-4c55-9b0f-5a4ad1f4e001",
      play = "0b1c6c0e-1e43-4c55-9b0f-5a4ad1f4e002";
    const app = (...values: string[]) => ({
      app: { kind: "values" as const, values },
    });
    expect(
      slideScopeResource(app(connectionResourceKey(apple, "123")), apple, []),
    ).toEqual({ follows: ["app"], resource: "123", conflict: false });
    // An app of each store: each connection reads its own.
    const pair = app(
      connectionResourceKey(apple, "123"),
      connectionResourceKey(play, "com.example"),
    );
    expect(slideScopeResource(pair, play, [])).toEqual({
      follows: ["app"],
      resource: "com.example",
      conflict: false,
    });
    // An exclusion keeps working; values that name no resource, or none or
    // two of this connection, are not followed.
    for (const [scope, exclusions] of [
      [
        app(connectionResourceKey(apple, "123")),
        [{ filterId: "app", reason: "All apps" }],
      ],
      [app("product:wurfel"), []],
      [app(connectionResourceKey(play, "com.example")), []],
      [
        app(
          connectionResourceKey(apple, "1"),
          connectionResourceKey(apple, "2"),
        ),
        [],
      ],
      [{ day: { kind: "range" as const, from: "2026-11-01", to: null } }, []],
    ] as const)
      expect(slideScopeResource(scope, apple, exclusions)).toEqual({
        follows: [],
        conflict: false,
      });
    // The widget's own other app would leave nothing to show.
    expect(
      slideScopeResource(
        app(connectionResourceKey(apple, "123")),
        apple,
        [],
        "456",
      ),
    ).toEqual({ follows: ["app"], resource: "123", conflict: true });
    expect(
      slideScopeResource(
        app(connectionResourceKey(apple, "123")),
        apple,
        [],
        "123",
      ).conflict,
    ).toBe(false);
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
  it("compares the current choice by the filter's type, as filters evaluate it", () => {
    const amount: DashboardDataFilter = {
      id: "amount",
      name: "Amount",
      type: "decimal",
      mode: "values",
      mappings: [{ modelId: "store", dimensionId: "amount" }],
      defaultValue: { kind: "values", values: ["1.0"] },
    };
    expect(
      measureInteractionSelected(amount, amount.defaultValue, "1.00"),
    ).toBe(true);
    expect(
      measureInteractionSelected(amount, amount.defaultValue, "1.01"),
    ).toBe(false);
    expect(
      measureInteractionSelected(
        { ...amount, mode: "range" },
        { kind: "range", from: "2.50", to: "2.5" },
        "2.500",
      ),
    ).toBe(true);
    const at: DashboardDataFilter = {
      ...amount,
      id: "at",
      type: "timestamp",
      mode: "range",
      defaultValue: null,
    };
    expect(
      measureInteractionSelected(
        at,
        {
          kind: "range",
          from: "2026-10-01T10:00:00Z",
          to: "2026-10-01T10:00:00.000Z",
        },
        "2026-10-01T10:00:00.000000Z",
      ),
    ).toBe(true);
    expect(
      measureInteractionSelected(
        at,
        { kind: "range", from: "2026-10-01T10:00:00Z", to: null },
        "2026-10-01T10:00:00Z",
      ),
    ).toBe(false);
    // Missing values only match a missing value.
    expect(
      measureInteractionSelected(
        amount,
        { kind: "values", values: [null] },
        null,
      ),
    ).toBe(true);
    expect(
      measureInteractionSelected(
        amount,
        { kind: "values", values: [null] },
        "0",
      ),
    ).toBe(false);
  });
});

describe("display formatting (#619)", () => {
  it("shows a calendar day in the locale's date format, the same day in every time zone", () => {
    expect(formatDataDate("2026-01-07", "date", "de")).toBe("07.01.2026");
    expect(formatDataDate("2026-01-07", "date", "en")).toBe("Jan 7, 2026");
    expect(formatDataDate("2026-01-07", "date", "de", "Pacific/Honolulu")).toBe(
      "07.01.2026",
    );
  });
  it("shows a timestamp with its time in the given zone", () => {
    expect(
      formatDataDate("2026-01-07T09:15:00.000Z", "timestamp", "de", "UTC"),
    ).toBe("07.01.2026, 09:15");
    expect(
      formatDataDate("2026-01-07T09:15:00.000Z", "timestamp", "en", "UTC"),
    ).toBe("Jan 7, 2026, 9:15 AM");
  });
  it("leaves values that are no date to the caller", () => {
    expect(formatDataDate("soon", "date", "en")).toBeNull();
    expect(formatDataDate("2026-02-30", "date", "en")).toBeNull();
    expect(formatDataDate(42, "timestamp", "en")).toBeNull();
    expect(formatDataDate("2026-01-07", "string", "en")).toBeNull();
  });
  it("rounds decimal text half away from zero without floating point", () => {
    expect(roundDecimalText("4.2857", 2)).toBe("4.29");
    expect(roundDecimalText("4.66667", 2)).toBe("4.67");
    expect(roundDecimalText("4.5", 2)).toBe("4.5");
    expect(roundDecimalText("4.995", 2)).toBe("5");
    expect(roundDecimalText("4.10", 2)).toBe("4.1");
    expect(roundDecimalText("-0.004", 2)).toBe("0");
    expect(roundDecimalText("-1.005", 2)).toBe("-1.01");
    expect(roundDecimalText("9007199254740993.125", 2)).toBe(
      "9007199254740993.13",
    );
    expect(roundDecimalText("12", 2)).toBe("12");
    expect(MEASURE_UNIT_FRACTION_DIGITS.stars).toBe(2);
  });
});
