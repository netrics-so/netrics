import { describe, expect, it } from "vitest";
import type { DashboardWidgetData } from "@netrics/contracts";
import { renderI18n } from "@/lib/i18n/test-render";
import type { DashboardDataFilter } from "@netrics/domain";
import type { StudioEnv } from "@/lib/studio-widgets";
import {
  formatMeasureCell,
  liveInteraction,
  MeasureWidgetView,
  type MeasureWidget,
} from "./measure-widget";
const format = (
  value: unknown,
  type = "decimal",
  currency?: string,
  locale = "en",
  unit?: string,
) => formatMeasureCell(value, type, currency, locale, "True", "False", unit);
describe("semantic value display", () => {
  it("preserves exact decimal amounts beyond IEEE-754 precision and localizes separators", () => {
    expect(format("9007199254740993.12", "decimal", "EUR")).toBe(
      "9,007,199,254,740,993.12 EUR",
    );
    expect(format("9007199254740993.12", "decimal", "EUR", "de")).toBe(
      "9.007.199.254.740.993,12 EUR",
    );
    expect(format("150", "decimal", "EUR")).toBe("150.00 EUR");
    expect(format(150, "integer", "EUR")).toBe("150.00 EUR");
  });
  it("scales minor units by the actual currency exponent exactly", () => {
    expect(format(150, "integer", "EUR", "en", "currency_minor")).toBe(
      "1.50 EUR",
    );
    expect(format(-1, "integer", "KWD", "en", "currency_minor")).toBe(
      "-0.001 KWD",
    );
    expect(format(150, "integer", "JPY", "en", "currency_minor")).toBe(
      "150 JPY",
    );
  });
  it("distinguishes missing, false and zero and shows rating/percent units", () => {
    expect(format(null)).toBe("—");
    expect(format(false, "boolean")).toBe("False");
    expect(format(0, "integer")).toBe("0");
    expect(format("4.5", "decimal", undefined, "en", "stars")).toBe("4.5 ★");
    expect(format("12.5", "decimal", undefined, "en", "percent")).toBe("12.5%");
  });
});

describe("percent change measures", () => {
  const data = (
    view: "value" | "table",
  ): Parameters<typeof MeasureWidgetView>[0] => ({
    widget: {
      title: null,
      options: { view, limit: 20 },
      binding: {
        measureIds: ["pct"],
        groupBy: view === "table" ? ["day"] : [],
      },
    },
    data: {
      widgetId: "00000000-0000-4000-8000-000000000001",
      status: "ok",
      error: null,
      exclusions: [],
      metadata: {
        modelId: "00000000-0000-4000-8000-000000000002",
        modelName: "Sales",
        measures: [
          { id: "pct", name: "Units, change in %", percentChange: true },
        ],
        dimensions: [{ id: "day", name: "Day", type: "date" }],
      },
      result: {
        releaseId: null,
        rows: [
          {
            dimensions: view === "table" ? { day: "2026-10-02" } : {},
            measures: {
              pct: {
                value: "0.083333333333333333",
                type: "decimal",
                status: "ok",
              },
            },
          },
        ],
        warnings: [],
        operations: 1,
        provenance: [],
        appliedFilter: null,
        groupBy: [],
      },
    } as unknown as DashboardWidgetData,
  });
  it("shows a percent change as a signed percentage in every view", () => {
    for (const view of ["value", "table"] as const) {
      const html = renderI18n(<MeasureWidgetView {...data(view)} />);
      expect(html).toContain("+8.3%");
      expect(html).not.toContain("0.083333");
    }
  });
});

describe("declared chart-to-filter interactions", () => {
  const view = (
    interaction?: Parameters<typeof MeasureWidgetView>[0]["interaction"],
    chart: "bar" | "table" = "bar",
  ): Parameters<typeof MeasureWidgetView>[0] => ({
    widget: {
      title: "Income",
      options: { view: chart, limit: 20 },
      binding: { measureIds: ["income"], groupBy: ["country"] },
    },
    interaction,
    data: {
      widgetId: "00000000-0000-4000-8000-000000000001",
      status: "ok",
      error: null,
      exclusions: [],
      metadata: {
        modelId: "00000000-0000-4000-8000-000000000002",
        modelName: "Sales",
        measures: [{ id: "income", name: "Income" }],
        dimensions: [{ id: "country", name: "Country", type: "string" }],
      },
      result: {
        releaseId: null,
        rows: ["DE", "FR"].map((country, index) => ({
          dimensions: { country },
          dimensionLabels: { country: country === "DE" ? "Germany" : "France" },
          measures: {
            income: {
              value: String(100 - index),
              type: "decimal",
              status: "ok",
            },
          },
        })),
        warnings: [],
        operations: 1,
        provenance: [],
        appliedFilter: null,
        groupBy: ["country"],
      },
    } as unknown as DashboardWidgetData,
  });
  const interaction = {
    dimensionId: "country",
    filterName: "Market",
    selectable: () => true,
    selected: (value: unknown) => value === "FR",
    toggle: () => undefined,
  };
  it("renders the grouped values as pressed/unpressed filter buttons in en and de", () => {
    for (const chart of ["bar", "table"] as const) {
      const html = renderI18n(
        <MeasureWidgetView {...view(interaction, chart)} />,
      );
      expect(html).toContain("Select a value to filter by Market.");
      expect(html).toMatch(
        /<button[^>]*aria-pressed="false"[^>]*title="Filter by Market: Germany"[^>]*>Germany<\/button>/,
      );
      expect(html).toMatch(/aria-pressed="true"[^>]*>France<\/button>/);
    }
    expect(
      renderI18n(<MeasureWidgetView {...view(interaction)} />, "de"),
    ).toContain("Wähle einen Wert, um nach Market zu filtern.");
  });
  it("keeps undeclared and non-interactive widgets as plain text", () => {
    const html = renderI18n(<MeasureWidgetView {...view()} />);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("filter by");
  });
});

describe("viewer interaction state", () => {
  const filter: DashboardDataFilter = {
    id: "market",
    name: "Market",
    type: "string",
    mode: "values",
    mappings: [{ modelId: "model", dimensionId: "country" }],
    defaultValue: { kind: "values", values: ["DE"] },
  };
  const widget = {
    id: "00000000-0000-4000-8000-000000000003",
    type: "measure",
    title: null,
    x: 0,
    y: 0,
    w: 6,
    h: 4,
    binding: {
      modelId: "model",
      measureIds: ["income"],
      groupBy: ["country"],
      exclusions: [],
      interaction: { filterId: "market" },
    },
    options: { view: "bar", limit: 20 },
  } as MeasureWidget;
  const env = (
    filterValues: StudioEnv["filterValues"],
    calls: unknown[][] = [],
  ) =>
    ({
      dataFilters: [filter],
      filterValues,
      onFilterValue: (...args: unknown[]) => calls.push(args),
    }) as unknown as StudioEnv;
  it("sets the clicked value, then clears it back to the default or to all values", () => {
    const calls: unknown[][] = [];
    liveInteraction(widget, env({}, calls))!.toggle("FR");
    liveInteraction(
      widget,
      env({ market: { kind: "values", values: ["FR"] } }, calls),
    )!.toggle("FR");
    // The default is that very value: clicking it again shows all values.
    liveInteraction(widget, env({}, calls))!.toggle("DE");
    expect(calls).toEqual([
      ["market", { kind: "values", values: ["FR"] }],
      ["market", undefined],
      ["market", null],
    ]);
  });
  it("is absent where the environment is not interactive or the declaration does not apply", () => {
    expect(
      liveInteraction(widget, { ...env({}), onFilterValue: undefined }),
    ).toBeUndefined();
    expect(
      liveInteraction(
        { ...widget, binding: { ...widget.binding, groupBy: [] } },
        env({}),
      ),
    ).toBeUndefined();
    expect(
      liveInteraction(
        { ...widget, binding: { ...widget.binding, interaction: undefined } },
        env({}),
      ),
    ).toBeUndefined();
  });
});

describe("viewer interaction state with typed values", () => {
  it("clears an equivalent decimal default to all values instead of re-selecting it", () => {
    const filter: DashboardDataFilter = {
      id: "price",
      name: "Price",
      type: "decimal",
      mode: "values",
      mappings: [{ modelId: "model", dimensionId: "price" }],
      defaultValue: { kind: "values", values: ["1.0"] },
    };
    const calls: unknown[][] = [];
    const interaction = liveInteraction(
      {
        id: "00000000-0000-4000-8000-000000000004",
        type: "measure",
        title: null,
        x: 0,
        y: 0,
        w: 6,
        h: 4,
        binding: {
          modelId: "model",
          measureIds: ["income"],
          groupBy: ["price"],
          exclusions: [],
          interaction: { filterId: "price" },
        },
        options: { view: "bar", limit: 20 },
      } as MeasureWidget,
      {
        dataFilters: [filter],
        filterValues: {},
        onFilterValue: (...args: unknown[]) => calls.push(args),
      } as unknown as StudioEnv,
    )!;
    expect(interaction.selected("1.00")).toBe(true);
    interaction.toggle("1.00");
    expect(calls).toEqual([["price", null]]);
  });
});
