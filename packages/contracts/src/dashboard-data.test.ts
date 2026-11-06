import { describe, expect, it } from "vitest";
import { measureWidgetBindingSchema } from "./dashboard-data.js";

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
