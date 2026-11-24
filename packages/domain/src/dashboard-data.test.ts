import { describe, expect, it } from "vitest";
import { compileRowExpression } from "./data-expression.js";
import {
  dashboardModelQuery,
  measureOptionsForBinding,
  measureQueryOrder,
  formatDataDate,
  MEASURE_UNIT_FRACTION_DIGITS,
  roundDecimalText,
  allowedTimeGrains,
  measureBindingGrains,
  measureFixedGrainDimensions,
  unsupportedMeasureGrain,
  measureResultDimensions,
  measureInteractionDimension,
  measureInteractionSelected,
  measureInteractionValue,
  measureViewWindow,
  connectionResourceKey,
  slideScopeConflicts,
  scopedFreshnessResources,
  slideScopeResource,
  validateDeviceFilterScope,
  validateMeasureView,
  validateSlideFilterScope,
  itemsModelQuery,
  ITEMS_COUNT_MEASURE_ID,
  stateModelQuery,
  STATE_RANK_MEASURE_ID,
  STATE_TIER_MEASURE_IDS,
  STATE_QUERY_MAX,
  type StateWidgetBinding,
  type DashboardDataFilter,
  type DashboardFilterValue,
  type DeviceFilterScope,
  type ItemsWidgetBinding,
  type MeasureWidgetBinding,
} from "./dashboard-data.js";
import {
  querySemanticModel,
  type SemanticModelDefinition,
} from "./data-model.js";
import type { DataTable } from "./data-preparation.js";
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
  it("lets connection widgets follow a linked product through its member apps (#777)", () => {
    const apple = "0b1c6c0e-1e43-4c55-9b0f-5a4ad1f4e001",
      play = "0b1c6c0e-1e43-4c55-9b0f-5a4ad1f4e002",
      other = "0b1c6c0e-1e43-4c55-9b0f-5a4ad1f4e003";
    const app = (...values: string[]) => ({
      app: { kind: "values" as const, values },
    });
    const products = new Map([
      [
        "product:wurfel",
        [
          connectionResourceKey(apple, "123"),
          connectionResourceKey(play, "com.example"),
        ],
      ],
      [
        "product:twins",
        [connectionResourceKey(apple, "1"), connectionResourceKey(apple, "2")],
      ],
    ]);
    // Each store's widget reads the product's app of its connection.
    expect(
      slideScopeResource(app("product:wurfel"), apple, [], undefined, products),
    ).toEqual({ follows: ["app"], resource: "123", conflict: false });
    expect(
      slideScopeResource(app("product:wurfel"), play, [], undefined, products),
    ).toEqual({ follows: ["app"], resource: "com.example", conflict: false });
    // The record an API response carries resolves the same way.
    expect(
      slideScopeResource(
        app("product:wurfel"),
        play,
        [],
        undefined,
        Object.fromEntries(products),
      ).resource,
    ).toBe("com.example");
    // A widget fixed to another app of the connection conflicts.
    expect(
      slideScopeResource(app("product:wurfel"), apple, [], "456", products)
        .conflict,
    ).toBe(true);
    // Not followed: a connection the product has no app of, a product with
    // two apps of the connection, a product no mapping names, and an
    // exclusion.
    for (const [scope, connection, exclusions] of [
      [app("product:wurfel"), other, []],
      [app("product:twins"), apple, []],
      [app("product:unknown"), apple, []],
      [app("constructor"), apple, []],
      [app("product:wurfel"), apple, [{ filterId: "app", reason: "All" }]],
    ] as const)
      expect(
        slideScopeResource(
          scope,
          connection,
          exclusions,
          undefined,
          connection === other ? products : Object.fromEntries(products),
        ),
      ).toEqual({ follows: [], conflict: false });
  });
  it("picks a connection's apps of a scope for freshness (#767)", () => {
    const apple = "0b1c6c0e-1e43-4c55-9b0f-5a4ad1f4e001",
      play = "0b1c6c0e-1e43-4c55-9b0f-5a4ad1f4e002";
    const app = (...values: unknown[]) => ({
      app: { kind: "values" as const, values },
    });
    const one = app(connectionResourceKey(apple, "123"));
    expect(scopedFreshnessResources(one, apple, [])).toEqual(["123"]);
    // An App Store app's slide names no Play app: Play adds nothing.
    expect(scopedFreshnessResources(one, play, [])).toEqual([]);
    // A linked product stands for its apps, of either store.
    const products = new Map([
      [
        "product:wurfel",
        [
          connectionResourceKey(apple, "123"),
          connectionResourceKey(apple, "456"),
          connectionResourceKey(play, "com.example"),
        ],
      ],
    ]);
    expect(
      scopedFreshnessResources(app("product:wurfel"), apple, [], products),
    ).toEqual(["123", "456"]);
    expect(
      scopedFreshnessResources(app("product:wurfel"), play, [], products),
    ).toEqual(["com.example"]);
    // Two filters that pick apps leave those both pick.
    expect(
      scopedFreshnessResources(
        {
          ...app("product:wurfel"),
          other: {
            kind: "values",
            values: [connectionResourceKey(apple, "456")],
          },
        },
        apple,
        [],
        products,
      ),
    ).toEqual(["456"]);
    // Every resource: no scope, an excluded filter, values that are not
    // apps (an unknown product, a store, null), or a range.
    for (const [scope, exclusions] of [
      [{}, []],
      [one, [{ filterId: "app", reason: "All apps" }]],
      [app("product:unknown"), []],
      [app(connectionResourceKey(apple, "123"), "google"), []],
      [app(null), []],
      [app(), []],
      [{ day: { kind: "range" as const, from: "2026-11-01", to: null } }, []],
    ] as const)
      expect(
        scopedFreshnessResources(scope, apple, exclusions, products),
      ).toBeUndefined();
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
  it("keeps values to one measure and charts at a declared grain", () => {
    // A grouped value is a total with its split (#784).
    expect(() =>
      validateMeasureView("value", {
        ...binding,
        measureIds: ["revenue"],
        groupBy: ["day"],
      }),
    ).not.toThrow();
    expect(() =>
      validateMeasureView("value", {
        ...binding,
        measureIds: ["revenue", "orders"],
        groupBy: [],
      }),
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
    // Years before 100 keep the year they are (review 3 of #852): the
    // bucket of a source's zero time is a date like any other.
    expect(formatDataDate("0001-01-01", "date", "en")).toBe("Jan 1, 1");
    expect(formatDataDate("0001-01-01", "date", "de")).toBe("01.01.1");
    expect(formatDataDate("0050-12-31", "date", "en")).toBe("Dec 31, 50");
    expect(formatDataDate("0050-12-31", "date", "de")).toBe("31.12.50");
    expect(formatDataDate("0099-02-28", "date", "en")).toBe("Feb 28, 99");
    expect(formatDataDate("0100-03-01", "date", "de")).toBe("01.03.100");
    expect(formatDataDate("0004-02-29", "date", "en")).toBe("Feb 29, 4");
    // No day, in any year.
    expect(formatDataDate("0001-02-29", "date", "en")).toBeNull();
    expect(formatDataDate("0050-02-30", "date", "de")).toBeNull();
    // The year 0 has no wording that tells it from the year 1: as stored.
    expect(formatDataDate("0000-01-01", "date", "en")).toBeNull();
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

describe("a measure table's order and labels follow its binding (#768)", () => {
  const order = { measureId: "rating_count", direction: "desc" as const };
  const binding = {
    measureIds: ["rating", "rating_count"],
    groupBy: ["listing", "storefront"],
  };
  const options = {
    view: "table" as const,
    limit: 20,
    order,
    labels: { listing: "App", storefront: "Country", rating_count: "Ratings" },
  };

  it("applies a table's order by a measure it shows", () => {
    expect(measureQueryOrder(binding, options)).toEqual(order);
  });

  it("ignores an order on another view or by a measure no longer bound", () => {
    // A date-grouped chart keeps its latest points, not the top N.
    expect(measureQueryOrder(binding, { ...options, view: "line" })).toBe(
      undefined,
    );
    expect(measureQueryOrder(binding, { ...options, view: "bar" })).toBe(
      undefined,
    );
    expect(
      measureQueryOrder({ ...binding, measureIds: ["rating"] }, options),
    ).toBe(undefined);
  });

  it("drops the order and labels a changed binding or view no longer shows", () => {
    expect(
      measureOptionsForBinding(
        { measureIds: ["rating"], groupBy: ["listing"] },
        options,
      ),
    ).toEqual({ view: "table", limit: 20, labels: { listing: "App" } });
    expect(
      measureOptionsForBinding(binding, { ...options, view: "bar" as const }),
    ).toEqual({ view: "bar", limit: 20, labels: options.labels });
    expect(
      measureOptionsForBinding(
        { measureIds: ["rating"], groupBy: [] },
        options,
      ),
    ).toEqual({ view: "table", limit: 20 });
    // Unchanged when everything is still shown.
    expect(measureOptionsForBinding(binding, options)).toEqual(options);
  });
});

describe("itemsModelQuery (#810)", () => {
  const photos: DataTable = {
    fields: [
      { id: "taken_at", name: "Taken", type: "date", nullable: true },
      { id: "title", name: "Title", type: "string", nullable: true },
      { id: "caption", name: "Caption", type: "string", nullable: true },
      {
        id: "photo",
        name: "Photo",
        type: "string",
        nullable: true,
        role: "image",
      },
    ],
    rows: ["a", "b", "c", "d", "e", "f", "g", "h"].map((title, index) => ({
      taken_at: `2026-11-0${index + 1}`,
      title,
      caption: `caption ${title}`,
      photo: `https://img.example/${title}.png`,
    })),
  };
  const photoModel: SemanticModelDefinition = {
    version: 1,
    datasets: ["photos"],
    relationships: [],
    dimensions: ["taken_at", "title", "caption", "photo"].map((id) => ({
      id,
      name: id,
      datasetId: "photos",
      fieldId: id,
      ...(id === "taken_at"
        ? { timeAlignment: "reporting_date" as const }
        : {}),
    })),
    measures: [],
  };
  const itemsBinding: ItemsWidgetBinding = {
    modelId: "photos-model",
    imageDimensionId: "photo",
    titleDimensionId: "title",
    subtitleDimensionId: "caption",
    timeDimensionId: "taken_at",
    exclusions: [],
  };
  const titleFilter: DashboardDataFilter = {
    id: "name",
    name: "Name",
    type: "string",
    mode: "values",
    mappings: [{ modelId: "photos-model", dimensionId: "title" }],
    defaultValue: null,
  };

  it("queries the newest items: grouped by time, image, title, subtitle, window last", () => {
    const { model, query } = itemsModelQuery(
      photoModel,
      [],
      {},
      itemsBinding,
      6,
    );
    expect(query).toMatchObject({
      measureIds: [ITEMS_COUNT_MEASURE_ID],
      groupBy: ["taken_at", "photo", "title", "caption"],
      window: "last",
      limit: 6,
    });
    expect(model.measures.at(-1)).toMatchObject({
      id: ITEMS_COUNT_MEASURE_ID,
      kind: "aggregate",
      datasetId: "photos",
      aggregate: { op: "count" },
    });
    // The model itself is not changed.
    expect(photoModel.measures).toEqual([]);
  });

  it("leaves the subtitle out of the grouping when there is none", () => {
    const { subtitleDimensionId: _subtitle, ...withoutSubtitle } = itemsBinding;
    expect(
      itemsModelQuery(photoModel, [], {}, withoutSubtitle, 3).query.groupBy,
    ).toEqual(["taken_at", "photo", "title"]);
  });

  it("applies a mapped dashboard filter and refuses an unmapped one without exclusion", () => {
    const run = (values: Record<string, DashboardFilterValue>) => {
      const { model, query } = itemsModelQuery(
        photoModel,
        [titleFilter],
        values,
        itemsBinding,
        6,
      );
      return querySemanticModel(model, new Map([["photos", photos]]), query);
    };
    expect(
      run({ name: { kind: "values", values: ["c"] } }).rows.map(
        (row) => row.dimensions.title,
      ),
    ).toEqual(["c"]);
    const unmapped = { ...titleFilter, mappings: [] };
    expect(() =>
      itemsModelQuery(photoModel, [unmapped], {}, itemsBinding, 6),
    ).toThrow("dashboard_filter_not_applicable");
    expect(
      itemsModelQuery(
        photoModel,
        [unmapped],
        {},
        { ...itemsBinding, exclusions: [{ filterId: "name", reason: "All" }] },
        6,
      ).query.measureIds,
    ).toEqual([ITEMS_COUNT_MEASURE_ID]);
  });

  it("returns the newest rows last, so reversing puts the newest first", () => {
    const { model, query } = itemsModelQuery(
      photoModel,
      [],
      {},
      itemsBinding,
      3,
    );
    const result = querySemanticModel(
      model,
      new Map([["photos", photos]]),
      query,
    );
    expect(result.rows.map((row) => row.dimensions.title)).toEqual([
      "f",
      "g",
      "h",
    ]);
  });

  it("leaves items without a time out instead of showing them as newest", () => {
    const { model, query } = itemsModelQuery(
      photoModel,
      [],
      {},
      itemsBinding,
      2,
    );
    const undated: DataTable = {
      ...photos,
      rows: [...photos.rows, { ...photos.rows[0], taken_at: null, title: "x" }],
    };
    expect(
      querySemanticModel(model, new Map([["photos", undated]]), query).rows.map(
        (row) => row.dimensions.title,
      ),
    ).toEqual(["g", "h"]);
  });

  it("refuses an image dimension the model does not have", () => {
    expect(() =>
      itemsModelQuery(
        photoModel,
        [],
        {},
        { ...itemsBinding, imageDimensionId: "nope" },
        3,
      ),
    ).toThrow("items_dimension_unknown");
  });
});

describe("a measure widget's time grains (#838)", () => {
  const grouped: MeasureWidgetBinding = {
    ...binding,
    groupBy: ["day", "territory"],
    groupByGrain: { day: "week" },
    exclusions: [{ filterId: "country", reason: "all" }],
  };
  it("queries with the grains of its grouping, and none otherwise", () => {
    expect(dashboardModelQuery(filters, {}, grouped).groupByGrain).toEqual({
      day: "week",
    });
    expect(
      "groupByGrain" in
        dashboardModelQuery(filters, {}, { ...grouped, groupByGrain: {} }),
    ).toBe(false);
    expect("groupByGrain" in dashboardModelQuery(filters, {}, binding)).toBe(
      false,
    );
  });
  it("drops a grain with its dimension", () => {
    expect(measureBindingGrains(grouped)).toEqual(grouped);
    const without = measureBindingGrains({
      ...grouped,
      groupBy: ["territory"],
    });
    expect("groupByGrain" in without).toBe(false);
    expect(without.groupBy).toEqual(["territory"]);
    expect(
      measureBindingGrains({
        ...grouped,
        groupByGrain: { day: "week", territory: "day" },
        groupBy: ["day"],
      }).groupByGrain,
    ).toEqual({ day: "week" });
  });
  it("refuses a grain for a dimension the widget does not group by", () => {
    expect(() => validateMeasureView("table", grouped)).not.toThrow();
    expect(() =>
      validateMeasureView("table", { ...grouped, groupBy: ["territory"] }),
    ).toThrow("dashboard_measure_grain_invalid");
    expect(() =>
      validateMeasureView("table", {
        ...grouped,
        groupByGrain: { day: "hour" as "day" },
      }),
    ).toThrow("dashboard_measure_grain_invalid");
  });
  it("reports a bucketed timestamp as the date its groups carry", () => {
    const dimensions = [
      { id: "taken", name: "Taken", type: "timestamp" as const },
      { id: "day", name: "Day", type: "date" as const },
      { id: "kind", name: "Kind", type: "string" as const },
    ];
    expect(
      measureResultDimensions(dimensions, {
        groupByGrain: { taken: "day", day: "month" },
      }).map((dimension) => dimension.type),
    ).toEqual(["date", "date", "string"]);
    expect(measureResultDimensions(dimensions, {})).toEqual(dimensions);
  });
  it("keeps a click from setting a filter to a bucket", () => {
    const clickable = { ...grouped, exclusions: [], groupBy: ["day"] };
    expect(
      measureInteractionDimension(
        filters,
        { ...clickable, groupByGrain: {}, interaction: { filterId: "day" } },
        "table",
      ),
    ).toBe("day");
    expect(() =>
      measureInteractionDimension(
        filters,
        { ...clickable, interaction: { filterId: "day" } },
        "table",
      ),
    ).toThrow("dashboard_interaction_grain_unsupported");
  });
  describe("with the model's dimensions and measures (review 2 of #852)", () => {
    const dimensions = [
      { id: "taken", name: "Taken", type: "timestamp" as const },
      { id: "day", name: "Day", type: "date" as const },
      { id: "kind", name: "Kind", type: "string" as const },
    ];
    const measures = [
      { id: "count" },
      { id: "rolling", fixedGrainDimensions: ["day"] },
      { id: "perTime", fixedGrainDimensions: ["taken"] },
    ];
    it("has one stored form: a date per day is the date itself", () => {
      const perDay = {
        ...binding,
        groupBy: ["day", "taken"],
        groupByGrain: { day: "day" as const, taken: "day" as const },
      };
      // A timestamp's day is a bucket; a date's is not.
      expect(measureBindingGrains(perDay, { dimensions }).groupByGrain).toEqual(
        { taken: "day" },
      );
      expect(
        "groupByGrain" in
          measureBindingGrains(
            { ...perDay, groupByGrain: { day: "day" } },
            { dimensions },
          ),
      ).toBe(false);
      // So a click on such a table sets its filter as without the grain.
      expect(
        measureInteractionDimension(
          filters,
          measureBindingGrains(
            {
              ...binding,
              groupBy: ["day"],
              groupByGrain: { day: "day" },
              interaction: { filterId: "day" },
            },
            { dimensions },
          ),
          "table",
        ),
      ).toBe("day");
    });
    it("allows only grains that leave the measures' dimensions as they are", () => {
      const none = new Set<string>();
      const fixed = measureFixedGrainDimensions(measures, ["count", "rolling"]);
      expect([...fixed]).toEqual(["day"]);
      expect(allowedTimeGrains(dimensions[1]!, none)).toEqual([
        "day",
        "week",
        "month",
      ]);
      expect(allowedTimeGrains(dimensions[1]!, fixed)).toEqual(["day"]);
      expect(allowedTimeGrains(dimensions[0]!, fixed)).toEqual([
        "day",
        "week",
        "month",
      ]);
      expect(
        allowedTimeGrains(
          dimensions[0]!,
          measureFixedGrainDimensions(measures, ["perTime"]),
        ),
      ).toEqual([]);
      expect(allowedTimeGrains(dimensions[2]!, none)).toEqual([]);
    });
    it("names the grain the measures refuse, and resets it on request", () => {
      const weekly = {
        ...binding,
        measureIds: ["count", "rolling"],
        groupBy: ["day", "taken"],
        groupByGrain: { day: "week" as const, taken: "month" as const },
      };
      const fixed = measureFixedGrainDimensions(measures, weekly.measureIds);
      expect(unsupportedMeasureGrain(weekly, dimensions, fixed)).toBe("day");
      expect(
        unsupportedMeasureGrain(weekly, dimensions, new Set()),
      ).toBeUndefined();
      expect(
        unsupportedMeasureGrain(
          { groupByGrain: { day: "day" } },
          dimensions,
          fixed,
        ),
      ).toBeUndefined();
      // Kept for validation to refuse, unless asked to reset.
      expect(measureBindingGrains(weekly, { dimensions }).groupByGrain).toEqual(
        weekly.groupByGrain,
      );
      expect(
        measureBindingGrains(weekly, { dimensions, reset: fixed }).groupByGrain,
      ).toEqual({ taken: "month" });
    });
  });
});

describe("stateModelQuery (#875)", () => {
  const services: DataTable = {
    fields: [
      { id: "service", name: "Service", type: "string", nullable: false },
      { id: "project", name: "Project", type: "string", nullable: false },
      { id: "state", name: "State", type: "string", nullable: false },
      { id: "changed", name: "Changed", type: "timestamp", nullable: true },
      { id: "rolled", name: "Rolled back", type: "boolean", nullable: true },
    ],
    rows: [
      ["web", "shop", "up", "2026-11-20T10:00:00.000Z", false],
      ["api", "shop", "failed", "2026-11-21T10:00:00.000Z", false],
      ["site", "blog", "up", null, true],
    ].map(([service, project, state, changed, rolled]) => ({
      service,
      project,
      state,
      changed,
      rolled,
    })),
  };
  const model: SemanticModelDefinition = {
    version: 1,
    datasets: ["services"],
    relationships: [],
    dimensions: ["service", "project", "state", "changed", "rolled"].map(
      (id) => ({ id, name: id, datasetId: "services", fieldId: id }),
    ),
    measures: [],
  };
  const stateBinding: StateWidgetBinding = {
    modelId: "ops",
    nameDimensionId: "service",
    stateDimensionId: "state",
    changedAtDimensionId: "changed",
    rolledBackDimensionId: "rolled",
    exclusions: [],
  };
  const projectFilter: DashboardDataFilter = {
    id: "project",
    name: "Project",
    type: "string",
    mode: "values",
    mappings: [{ modelId: "ops", dimensionId: "project" }],
    defaultValue: null,
  };
  const run = (
    item: string | null = null,
    values: Record<string, DashboardFilterValue> = {},
    filters: DashboardDataFilter[] = [],
  ) => {
    const built = stateModelQuery(model, filters, values, stateBinding, item);
    return querySemanticModel(
      built.model,
      new Map([["services", services]]),
      built.query,
    ).rows.map((row) => row.dimensions);
  };

  it("groups by name, state, changed-at and rolled-back with a count", () => {
    const { model: counted, query } = stateModelQuery(
      model,
      [],
      {},
      stateBinding,
    );
    expect(query).toMatchObject({
      measureIds: [STATE_RANK_MEASURE_ID],
      groupBy: ["service", "state", "changed", "rolled"],
      limit: STATE_QUERY_MAX,
      orderBy: { measureId: STATE_RANK_MEASURE_ID, direction: "asc" },
    });
    expect(counted.measures.at(-1)).toMatchObject({
      id: STATE_RANK_MEASURE_ID,
      kind: "formula",
    });
    expect(model.measures).toEqual([]);
    expect(run()).toHaveLength(3);
  });

  it("leaves the optional dimensions out of the grouping", () => {
    const {
      changedAtDimensionId: _c,
      rolledBackDimensionId: _r,
      ...plain
    } = stateBinding;
    expect(stateModelQuery(model, [], {}, plain).query.groupBy).toEqual([
      "service",
      "state",
    ]);
  });

  it("keeps one item for the single form", () => {
    expect(run("api").map((row) => row.service)).toEqual(["api"]);
    expect(run("nope")).toEqual([]);
  });

  it("follows a dashboard filter mapped to the model", () => {
    expect(
      run(null, { project: { kind: "values", values: ["blog"] } }, [
        projectFilter,
      ]).map((row) => row.service),
    ).toEqual(["site"]);
    expect(() =>
      stateModelQuery(
        model,
        [{ ...projectFilter, mappings: [] }],
        {},
        stateBinding,
      ),
    ).toThrow("dashboard_filter_not_applicable");
  });

  it("reads the distinct state values, or only items of given values (review)", () => {
    const read = (stateRead: Parameters<typeof stateModelQuery>[7]) => {
      const built = stateModelQuery(
        model,
        [],
        {},
        stateBinding,
        null,
        {},
        {},
        stateRead,
      );
      return querySemanticModel(
        built.model,
        new Map([["services", services]]),
        built.query,
      );
    };
    const rows = read({});
    // Ranked inside the query: failed, then up after a rollback, then up.
    expect(rows.rows.map((row) => row.dimensions.service)).toEqual([
      "api",
      "site",
      "web",
    ]);
    expect(
      rows.rows.map((row) => row.measures[STATE_RANK_MEASURE_ID]!.value),
    ).toEqual([1, 5, 6]);
    const first = read({ limit: 1 });
    expect(first.rows.map((row) => row.dimensions.service)).toEqual(["api"]);
    expect(first.totalRows).toBe(3);
    const [counts] = read({ kind: "counts" }).rows;
    expect(
      STATE_TIER_MEASURE_IDS.map((id) => counts!.measures[id]!.value),
    ).toEqual([0, 1, 0, 0, 0, 1, 1]);
    expect(read({ kind: "unknownValues" }).rows).toEqual([]);
  });

  it("applies the widget's overrides inside the query (final review)", () => {
    const built = stateModelQuery(
      model,
      [],
      {},
      stateBinding,
      null,
      {},
      {},
      {},
      { FAILED: "sleeping" },
    );
    const result = querySemanticModel(
      built.model,
      new Map([["services", services]]),
      built.query,
    );
    expect(
      result.rows.map((row) => row.measures[STATE_RANK_MEASURE_ID]!.value),
    ).toEqual([4, 5, 6]);
  });

  it("refuses a state dimension the model does not have", () => {
    expect(() =>
      stateModelQuery(
        model,
        [],
        {},
        {
          ...stateBinding,
          stateDimensionId: "nope",
        },
      ),
    ).toThrow("state_dimension_unknown");
  });
});
