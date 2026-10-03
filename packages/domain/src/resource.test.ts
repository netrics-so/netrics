import { describe, expect, it } from "vitest";

import { allResourcesName, tileLabel } from "./resource.js";

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

  it("names the scope of a tile of several resources added up", () => {
    expect(
      tileLabel({ ...base, dimensions: {}, allResourcesName: "All apps" }),
    ).toBe("Downloads · All apps");
    expect(tileLabel({ ...base, dimensions: {}, allResourcesName: null })).toBe(
      "Downloads",
    );
  });

  it("names the resource, not the scope, for a tile of one resource", () => {
    expect(
      tileLabel({
        ...base,
        dimensions: { resource: "1" },
        resourceName: "Wurfel",
        allResourcesName: "All apps",
      }),
    ).toBe("Downloads · Wurfel");
  });

  it("keeps a custom title over the scope", () => {
    expect(
      tileLabel({
        ...base,
        title: "All installs",
        dimensions: {},
        allResourcesName: "All apps",
      }),
    ).toBe("All installs");
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

describe("allResourcesName", () => {
  it("is the connector's plural noun with more than one resource", () => {
    expect(allResourcesName({ singular: "app", plural: "apps" }, 2)).toBe(
      "All apps",
    );
    expect(
      allResourcesName({ singular: "property", plural: "properties" }, 7),
    ).toBe("All properties");
  });

  it("falls back to resources without a noun", () => {
    expect(allResourcesName(null, 3)).toBe("All resources");
    expect(allResourcesName(undefined, 3)).toBe("All resources");
  });

  it("is null for one resource or none", () => {
    expect(allResourcesName({ singular: "app", plural: "apps" }, 1)).toBe(null);
    expect(allResourcesName(null, 0)).toBe(null);
  });
});
