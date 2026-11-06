import { describe, expect, it } from "vitest";
import type { DashboardWidgetData } from "@netrics/contracts";
import { renderI18n } from "@/lib/i18n/test-render";
import { formatMeasureCell, MeasureWidgetView } from "./measure-widget";
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
