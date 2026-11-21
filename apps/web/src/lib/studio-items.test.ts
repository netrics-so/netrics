import { describe, expect, it } from "vitest";
import type { PublishedModelCatalog } from "@netrics/contracts";

import { itemsBindingFor } from "./studio-items";
import { newWidget } from "./studio-new-widget";

const MODEL = "00000000-0000-4000-8000-000000000020";
// The exit gate's model (#835): the orientation comes before the prompt.
const images: PublishedModelCatalog["models"][number] = {
  modelId: MODEL,
  modelName: "voila images",
  measures: [{ id: "new", name: "New images" }],
  dimensions: [
    { id: "created", name: "Created", type: "timestamp" },
    { id: "orientation", name: "Orientation", type: "string" },
    { id: "image", name: "Image", type: "string", role: "image" },
    { id: "prompt", name: "Prompt", type: "string" },
  ],
};
const orientationFilter = {
  mappings: [{ modelId: MODEL, dimensionId: "orientation" }],
};

describe("a latest-items widget's default title (#835)", () => {
  it("is no dimension a shared filter picks values of", () => {
    expect(itemsBindingFor(images, [orientationFilter])).toMatchObject({
      imageDimensionId: "image",
      titleDimensionId: "prompt",
      timeDimensionId: "created",
    });
    // A filter of another model changes nothing.
    expect(
      itemsBindingFor(images, [
        {
          mappings: [
            {
              modelId: "00000000-0000-4000-8000-000000000021",
              dimensionId: "orientation",
            },
          ],
        },
      ])?.titleDimensionId,
    ).toBe("orientation");
    // Every string filtered: the first still beats the image.
    expect(
      itemsBindingFor(images, [
        orientationFilter,
        { mappings: [{ modelId: MODEL, dimensionId: "prompt" }] },
      ])?.titleDimensionId,
    ).toBe("orientation");
  });

  it("is chosen with the dashboard's filters when the widget is added", () => {
    const made = newWidget("items", {
      models: [images],
      metrics: [],
      imageIds: [],
      locale: "en",
      filters: [
        {
          id: "f",
          name: "Orientation",
          mode: "values",
          ...orientationFilter,
        } as never,
      ],
    });
    expect(made).toMatchObject({
      widget: { binding: { titleDimensionId: "prompt" } },
    });
  });
});
