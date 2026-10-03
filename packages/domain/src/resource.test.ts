import { describe, expect, it } from "vitest";

import { tileLabel } from "./resource.js";

describe("tileLabel", () => {
  const base = { title: null, metricName: "Downloads", resourceName: null };

  it("is the metric name for a tile of all resources", () => {
    expect(tileLabel({ ...base, dimensions: {} })).toBe("Downloads");
  });

  it("adds the resource name for a tile of one resource", () => {
    expect(
      tileLabel({
        ...base,
        dimensions: { resource: "6767935139" },
        resourceName: "Wurfel",
      }),
    ).toBe("Downloads · Wurfel");
  });

  it("falls back to the resource id without a name", () => {
    expect(tileLabel({ ...base, dimensions: { resource: "prj_1" } })).toBe(
      "Downloads · prj_1",
    );
  });

  it("keeps a custom title", () => {
    expect(
      tileLabel({
        ...base,
        title: "Wurfel installs",
        dimensions: { resource: "1" },
        resourceName: "Wurfel",
      }),
    ).toBe("Wurfel installs");
  });
});
