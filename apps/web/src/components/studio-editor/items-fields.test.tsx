import { describe, expect, it } from "vitest";
import type {
  DashboardWidget,
  PublishedModelCatalog,
} from "@netrics/contracts";

import { renderI18n } from "@/lib/i18n/test-render";
import { newWidget } from "@/lib/studio-new-widget";

import { ItemsFields } from "./items-fields";

// The latest-items widget's inspector and its defaults (#810).

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const photos: PublishedModelCatalog["models"][number] = {
  modelId: ID(1),
  modelName: "Photos",
  measures: [],
  dimensions: [
    { id: "photo", name: "Photo", type: "string", role: "image" },
    { id: "taken", name: "Taken", type: "timestamp" },
    { id: "caption", name: "Caption", type: "string" },
    { id: "team", name: "Team", type: "string" },
  ],
};
const sales: PublishedModelCatalog["models"][number] = {
  modelId: ID(2),
  modelName: "Sales",
  measures: [{ id: "revenue", name: "Revenue" }],
  dimensions: [
    { id: "day", name: "Day", type: "date" },
    { id: "app", name: "App", type: "string" },
  ],
};

const widget = (
  options: Partial<Extract<DashboardWidget, { type: "items" }>["options"]> = {},
): Extract<DashboardWidget, { type: "items" }> => ({
  type: "items",
  id: ID(3),
  x: 0,
  y: 0,
  w: 6,
  h: 4,
  title: null,
  binding: {
    modelId: photos.modelId,
    imageDimensionId: "photo",
    titleDimensionId: "caption",
    timeDimensionId: "taken",
    exclusions: [],
  },
  options: {
    layout: "grid",
    count: 6,
    rotateSeconds: 8,
    imageFit: "cover",
    showTime: true,
    ...options,
  },
});

const render = (
  options: Parameters<typeof widget>[0] = {},
  locale: "en" | "de" = "en",
) =>
  renderI18n(
    <ItemsFields
      widget={widget(options)}
      models={[sales, photos]}
      filters={[]}
      dispatch={() => {}}
      workspaceId="workspace"
    />,
    locale,
  );

const select = (html: string, label: string) => {
  const id = html.match(
    new RegExp(`<label for="([^"]+)">${label}</label>`),
  )?.[1];
  return html.match(new RegExp(`<select id="${id}"[^>]*>(.*?)</select>`))?.[1];
};

describe("latest items fields (#810)", () => {
  it("offers only models with an image dimension", () => {
    const models = select(render(), "Model")!;
    expect(models).toContain("Photos");
    expect(models).not.toContain("Sales");
    // Only image fields as the image, only dates and times as the time.
    expect(select(render(), "Image")).toBe(
      '<option value="photo" selected="">Photo</option>',
    );
    expect(select(render(), "Time")).toBe(
      '<option value="taken" selected="">Taken</option>',
    );
    expect(select(render(), "Subtitle")).toContain(
      '<option value="" selected="">None</option>',
    );
  });

  it("creates a widget with image, time and title picked from the model", () => {
    const made = newWidget("items", {
      models: [sales, photos],
      metrics: [],
      imageIds: [],
      locale: "en",
    });
    expect(made).toEqual({
      widget: {
        type: "items",
        title: null,
        binding: {
          modelId: photos.modelId,
          imageDimensionId: "photo",
          titleDimensionId: "caption",
          timeDimensionId: "taken",
          exclusions: [],
        },
        options: {
          layout: "grid",
          count: 6,
          rotateSeconds: 8,
          imageFit: "cover",
          showTime: true,
        },
      },
    });
  });

  it("explains why items cannot be added without an image model", () => {
    const input = { models: [sales], metrics: [], imageIds: [] };
    expect(newWidget("items", { ...input, locale: "en" })).toEqual({
      reason:
        "Publish a model with an image field first, for example from a custom API.",
    });
    expect(newWidget("items", { ...input, locale: "de" })).toEqual({
      reason:
        "Veröffentliche zuerst ein Modell mit einem Bildfeld, zum Beispiel aus einer eigenen API.",
    });
  });

  it("hides seconds per item for a grid", () => {
    expect(render()).not.toContain("Seconds per item");
    expect(render({ layout: "rotate" })).toContain("Seconds per item");
  });

  it("speaks German", () => {
    const html = render({ layout: "rotate" }, "de");
    for (const text of [
      "Neueste Einträge",
      "Modell",
      "Untertitel",
      "Einzeln nacheinander",
      "Sekunden pro Eintrag",
      "Zeit anzeigen",
      "Einpassen",
    ])
      expect(html).toContain(text);
  });
});
