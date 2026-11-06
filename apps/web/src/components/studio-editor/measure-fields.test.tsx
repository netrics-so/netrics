import { describe, expect, it } from "vitest";
import type {
  DashboardWidget,
  PublishedModelCatalog,
} from "@netrics/contracts";
import { renderI18n } from "@/lib/i18n/test-render";
import { MeasureFields } from "./measure-fields";

const models: PublishedModelCatalog["models"] = [
  {
    modelId: "00000000-0000-4000-8000-000000000010",
    modelName: "Sales",
    measures: [
      { id: "revenue", name: "Revenue" },
      { id: "revenue7", name: "Revenue, 7 days", requiredDimensions: ["day"] },
      { id: "byApp", name: "Revenue per app", requiredDimensions: ["app"] },
    ],
    dimensions: [
      { id: "day", name: "Day", type: "date" },
      { id: "app", name: "App", type: "string" },
    ],
  },
];
const widget = (
  view: "value" | "table",
  measureIds: string[],
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
      groupBy: view === "table" ? ["day"] : [],
      exclusions: [],
    },
    options: { view, limit: 20 },
  }) as Extract<DashboardWidget, { type: "measure" }>;
const render = (
  view: "value" | "table",
  measureIds: string[],
  locale: "en" | "de" = "en",
) =>
  renderI18n(
    <MeasureFields
      widget={widget(view, measureIds)}
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
});
