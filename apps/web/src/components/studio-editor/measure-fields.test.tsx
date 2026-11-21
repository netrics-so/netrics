import { describe, expect, it } from "vitest";
import type {
  DashboardWidget,
  PublishedModelCatalog,
} from "@netrics/contracts";
import { renderI18n } from "@/lib/i18n/test-render";
import {
  LINE_VIEW_LIMIT,
  limitForView,
  MeasureFields,
  optionsForModel,
  groupByForView,
  patchForView,
  valueViewMeasureId,
} from "./measure-fields";

const models: PublishedModelCatalog["models"] = [
  {
    modelId: "00000000-0000-4000-8000-000000000010",
    modelName: "Sales",
    measures: [
      { id: "revenue", name: "Revenue" },
      {
        id: "revenue7",
        name: "Revenue, 7 days",
        requiredDimensions: ["day"],
        perDateDimensions: ["day"],
      },
      // Kept per day, but a filter on one day gives one value.
      { id: "daily", name: "Daily revenue", requiredDimensions: ["day"] },
      { id: "byApp", name: "Revenue per app", requiredDimensions: ["app"] },
    ],
    dimensions: [
      { id: "day", name: "Day", type: "date" },
      { id: "app", name: "App", type: "string" },
    ],
  },
];
const widget = (
  view: "value" | "table" | "bar" | "line",
  measureIds: string[],
  groupBy: string[] = view === "table" ? ["day"] : [],
): Extract<DashboardWidget, { type: "measure" }> =>
  ({
    type: "measure",
    id: "00000000-0000-4000-8000-000000000020",
    x: 0,
    y: 0,
    w: 6,
    h: 3,
    title: null,
    binding: {
      modelId: models[0]!.modelId,
      measureIds,
      groupBy,
      exclusions: [],
    },
    options: { view, limit: 20 },
  }) as Extract<DashboardWidget, { type: "measure" }>;
const render = (
  view: "value" | "table" | "bar" | "line",
  measureIds: string[],
  locale: "en" | "de" = "en",
  groupBy?: string[],
) =>
  renderI18n(
    <MeasureFields
      widget={widget(view, measureIds, groupBy)}
      models={models}
      filters={[]}
      dispatch={() => {}}
      workspaceId="workspace"
    />,
    locale,
  );
const radio = (html: string, name: string) =>
  html.match(new RegExp(`<input[^>]*>(?=${name}<)`))?.[0] ?? "";

describe("measure binding fields", () => {
  it("explains measures shown per date in the single-value view", () => {
    const html = render("value", ["revenue"]);
    expect(radio(html, "Revenue, 7 days")).toContain('disabled=""');
    // A scope on another dimension can still be fixed by a filter.
    expect(radio(html, "Revenue per app")).not.toContain('disabled=""');
    expect(radio(html, "Daily revenue")).not.toContain('disabled=""');
    expect(html).not.toContain("Daily revenue has one value per date");
    expect(radio(html, "Revenue")).not.toContain('disabled=""');
    expect(html).toContain(
      "Revenue, 7 days has one value per date. Show it as a table or chart grouped by Day.",
    );
    expect(render("value", ["revenue"], "de")).toContain(
      "Revenue, 7 days hat einen Wert pro Datum. Zeige die Kennzahl als Tabelle oder Diagramm nach Day.",
    );
    // Tables and charts offer them.
    expect(
      radio(render("table", ["revenue"]), "Revenue, 7 days"),
    ).not.toContain('disabled=""');
  });

  it("keeps a measure with a date grain when switching to a single value", () => {
    expect(valueViewMeasureId(models[0], ["daily", "revenue"])).toBe("daily");
    expect(valueViewMeasureId(models[0], ["revenue7", "byApp"])).toBe("byApp");
    expect(valueViewMeasureId(models[0], ["revenue7"])).toBe("revenue");
  });
});

describe("a value view's grouping (#788)", () => {
  const fieldset = (html: string, legend: string) =>
    html.match(
      new RegExp(`<fieldset[^>]*><legend>${legend}</legend>.*?</fieldset>`),
    )?.[0] ?? "";

  it("shows what a value view is split by, and offers every dimension", () => {
    const html = render("value", ["revenue"], "en", ["app"]);
    const split = fieldset(html, "Split by");
    expect(radio(split, "App")).toContain('type="checkbox"');
    expect(radio(split, "App")).toContain('checked=""');
    expect(radio(split, "Day")).toContain('type="checkbox"');
    expect(radio(split, "Day")).not.toContain('checked=""');
    expect(split).toContain(
      "Shows a line for each group, under their total where the measure adds up. Choose none for a single value.",
    );
    // Its lines are limited as a table's rows are.
    expect(html).toContain("Maximum rows");
    const german = render("value", ["revenue"], "de", ["app"]);
    expect(fieldset(german, "Aufteilen nach")).toContain(
      "Zeigt eine Zeile pro Gruppe, darüber die Summe, wenn sich die Kennzahl addieren lässt. Ohne Auswahl bleibt es ein einzelner Wert.",
    );
  });

  it("offers the split for a plain value, which has no rows to limit", () => {
    const html = render("value", ["revenue"]);
    expect(radio(fieldset(html, "Split by"), "App")).not.toContain(
      'checked=""',
    );
    expect(html).not.toContain("Maximum rows");
  });

  it("keeps tables and charts as they were", () => {
    const table = fieldset(render("table", ["revenue"]), "Group by");
    expect(radio(table, "Day")).toContain('type="checkbox"');
    expect(table).not.toContain("Shows a line for each group");
    const line = fieldset(
      render("line", ["revenue"], "en", ["day"]),
      "Group by",
    );
    expect(radio(line, "Day")).toContain('type="radio"');
    // A line chart runs over dates only.
    expect(line).not.toContain("App<");
  });

  it("keeps the grouping across view switches where the view can show it", () => {
    expect(groupByForView("value", ["app", "day"], models[0])).toEqual([
      "app",
      "day",
    ]);
    expect(groupByForView("table", ["app"], models[0])).toEqual(["app"]);
    expect(groupByForView("bar", ["app", "day"], models[0])).toEqual(["app"]);
    expect(groupByForView("table", ["a", "b", "c", "d"], models[0])).toEqual([
      "a",
      "b",
      "c",
    ]);
    // A plain value stays plain; a table or chart needs a grouping.
    expect(groupByForView("value", [], models[0])).toEqual([]);
    expect(groupByForView("table", [], models[0])).toEqual(["day"]);
    expect(groupByForView("bar", [], models[0])).toEqual(["day"]);
    expect(
      groupByForView("line", [], {
        ...models[0]!,
        dimensions: [...models[0]!.dimensions].reverse(),
      }),
    ).toEqual(["day"]);
  });

  it("gives a template's split tile back after a switch to another view", () => {
    // The total with a line per store (#784): two lines, its own period.
    const split = widget("value", ["revenue"], ["app"]);
    split.options = {
      view: "value",
      limit: 2,
      period: "last_30_days",
      labels: { app: "Store" },
    };
    for (const view of ["table", "bar", "line"] as const) {
      const other = { ...split, ...patchForView(split, view, models[0]) };
      expect(other.options.view).toBe(view);
      expect(other.binding.groupBy).toEqual(["app"]);
      const back = { ...other, ...patchForView(other, "value", models[0]) };
      expect(back.binding).toEqual(split.binding);
      expect(back.options).toEqual(split.options);
    }
  });
});

describe("switching the model (#784)", () => {
  it("drops the old model's period, order and labels", () => {
    expect(
      optionsForModel(
        {
          view: "value",
          limit: 2,
          period: "last_30_days",
          order: { measureId: "downloads", direction: "desc" },
          labels: { downloads: "Downloads" },
        },
        models[0]!,
      ),
    ).toEqual({ view: "value", limit: 2 });
    // A measure that needs a grouping opens as a table.
    expect(
      optionsForModel(
        { view: "value", limit: 20 },
        {
          measures: [{ id: "byApp", requiredDimensions: ["app"] }],
        },
      ).view,
    ).toBe("table");
  });
});

describe("a line chart's maximum rows (#835)", () => {
  it("shows a year of points when switched to with the default untouched", () => {
    expect(limitForView("line", 20)).toBe(LINE_VIEW_LIMIT);
    expect(LINE_VIEW_LIMIT).toBeGreaterThanOrEqual(365);
    // A chosen limit stays.
    expect(limitForView("line", 31)).toBe(31);
    // Leaving the line chart restores the default it set.
    expect(limitForView("bar", LINE_VIEW_LIMIT)).toBe(20);
    expect(limitForView("table", 50)).toBe(50);
  });
});
