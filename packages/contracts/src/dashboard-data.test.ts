import { describe, expect, it } from "vitest";
import {
  dashboardDataResponseSchema,
  dashboardMeasurePreviewSchema,
  itemsWidgetBindingSchema,
  itemsWidgetDataSchema,
  itemsWidgetOptionsSchema,
  measureWidgetBindingSchema,
  stateWidgetOptionsSchema,
} from "./dashboard-data.js";

const binding = {
  modelId: "00000000-0000-4000-8000-000000000001",
  measureIds: ["downloads"],
  groupBy: ["country"],
};

describe("measure widget interaction contract", () => {
  it("keeps older bindings without an interaction valid", () => {
    const parsed = measureWidgetBindingSchema.parse(binding);
    expect(parsed).toEqual({ ...binding, exclusions: [] });
    expect("interaction" in parsed).toBe(false);
  });
  it("accepts one declared filter and nothing else", () => {
    expect(
      measureWidgetBindingSchema.parse({
        ...binding,
        interaction: { filterId: "country" },
      }).interaction,
    ).toEqual({ filterId: "country" });
    for (const interaction of [
      { filterId: "" },
      { filterId: "country", dimensionId: "country" },
      { filterId: "country; drop" },
      "country",
    ])
      expect(
        measureWidgetBindingSchema.safeParse({ ...binding, interaction })
          .success,
      ).toBe(false);
  });
});

describe("latest items widget contract (#810)", () => {
  const itemsBinding = {
    modelId: "00000000-0000-4000-8000-000000000001",
    imageDimensionId: "photo",
    titleDimensionId: "title",
    timeDimensionId: "taken_at",
  };
  it("defaults items options to a 6-item grid", () =>
    expect(itemsWidgetOptionsSchema.parse({})).toEqual({
      layout: "grid",
      count: 6,
      rotateSeconds: 8,
      imageFit: "cover",
      showTime: true,
    }));
  it("refuses count 51 and unknown binding keys", () => {
    expect(itemsWidgetOptionsSchema.safeParse({ count: 50 }).success).toBe(
      true,
    );
    expect(itemsWidgetOptionsSchema.safeParse({ count: 51 }).success).toBe(
      false,
    );
    expect(itemsWidgetOptionsSchema.safeParse({ count: 0 }).success).toBe(
      false,
    );
    expect(itemsWidgetBindingSchema.parse(itemsBinding)).toEqual({
      ...itemsBinding,
      exclusions: [],
    });
    expect(
      itemsWidgetBindingSchema.safeParse({ ...itemsBinding, url: "x" }).success,
    ).toBe(false);
  });
  it("keeps older data responses and previews valid without items", () => {
    expect(
      dashboardDataResponseSchema.parse({ widgets: [], values: {} }).items,
    ).toEqual([]);
    expect(
      dashboardMeasurePreviewSchema.parse({ filters: [], widgets: [] }).items,
    ).toEqual([]);
  });
  it("carries an image reference, never more than the newest 50", () => {
    const item = {
      title: "a",
      subtitle: null,
      time: "2026-11-05",
      image: {
        id: "00000000-0000-4000-8000-000000000002",
        sha256: "a".repeat(64),
        width: 10,
        height: 10,
      },
    };
    const data = {
      widgetId: "00000000-0000-4000-8000-000000000003",
      status: "ok",
      items: [item],
      error: null,
      exclusions: [],
    };
    expect(itemsWidgetDataSchema.parse(data).items[0]!.image!.width).toBe(10);
    expect(
      itemsWidgetDataSchema.safeParse({
        ...data,
        items: Array.from({ length: 51 }, () => item),
      }).success,
    ).toBe(false);
  });
});

describe("state widget options (#900)", () => {
  it("keeps the single form's item exactly as written", () => {
    expect(stateWidgetOptionsSchema.parse({ item: " web " }).item).toBe(
      " web ",
    );
    expect(stateWidgetOptionsSchema.safeParse({ item: "   " }).success).toBe(
      false,
    );
    expect(stateWidgetOptionsSchema.parse({}).item).toBeNull();
  });
});
