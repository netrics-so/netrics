import { describe, expect, it } from "vitest";

import {
  effectiveResource,
  hasResources,
  offersResourceChoice,
  resourceOptionLabel,
  withResource,
} from "./tile-resource";

const apps = [
  { id: "6767935139", name: "Wurfel" },
  { id: "6700000001", name: null },
];

describe("tile resources", () => {
  it("applies to metrics with a resource dimension", () => {
    expect(hasResources({ dimensions: ["resource", "territory"] })).toBe(true);
    expect(hasResources({ dimensions: ["page"] })).toBe(false);
    expect(hasResources(undefined)).toBe(false);
  });

  it("offers a choice only between several resources", () => {
    expect(offersResourceChoice(null)).toBe(false);
    expect(offersResourceChoice([apps[0]!])).toBe(false);
    expect(offersResourceChoice(apps)).toBe(true);
  });

  it("labels a resource by name, else by id", () => {
    expect(resourceOptionLabel(apps[0]!)).toBe("Wurfel");
    expect(resourceOptionLabel(apps[1]!)).toBe("6700000001");
  });

  it("keeps the picked resource while it is listed, else all", () => {
    expect(effectiveResource(apps, "6767935139")).toEqual(apps[0]);
    expect(effectiveResource(apps, "")).toBeNull();
    expect(effectiveResource(apps, "gone")).toBeNull();
    expect(effectiveResource(null, "6767935139")).toBeNull();
  });

  it("adds the resource to the tile's dimension filter", () => {
    expect(withResource({ currency: "EUR" }, apps[0]!)).toEqual({
      currency: "EUR",
      resource: "6767935139",
    });
    expect(withResource({ currency: "EUR" }, null)).toEqual({
      currency: "EUR",
    });
  });
});
