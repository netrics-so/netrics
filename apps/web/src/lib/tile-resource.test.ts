import { describe, expect, it } from "vitest";

import {
  allResourcesOption,
  effectiveResource,
  hasResources,
  newTileScope,
  offersResourceChoice,
  resourceFieldLabel,
  resourceOptionLabel,
  withResource,
} from "./tile-resource";

const apps = [
  { id: "6767935139", name: "Wurfel" },
  { id: "6700000001", name: null },
];

const appNoun = { singular: "app", plural: "apps" };

describe("tile resources", () => {
  it("names the picker after what the connector calls its resources", () => {
    expect(resourceFieldLabel(appNoun)).toBe("App");
    expect(allResourcesOption(appNoun, "en")).toBe("All apps");
    expect(
      resourceFieldLabel({ singular: "resource", plural: "resources" }),
    ).toBe("Resource");
  });

  it("gives a new tile of all of several resources their scope", () => {
    expect(newTileScope(apps, null, appNoun)).toBe("All apps");
    expect(newTileScope(apps, null, null)).toBe("All resources");
    // One resource picked: its name labels the tile instead.
    expect(newTileScope(apps, apps[0]!, appNoun)).toBeNull();
    // A single resource, or none yet, is the same as all of them.
    expect(newTileScope([apps[0]!], null, appNoun)).toBeNull();
    expect(newTileScope(null, null, appNoun)).toBeNull();
  });

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
