import { describe, expect, it } from "vitest";

import { createDefaultRegistry } from "./connectors.js";

describe("createDefaultRegistry", () => {
  it("ships the demo connector", () => {
    const registry = createDefaultRegistry();
    expect(registry.get("demo")?.manifest.id).toBe("demo");
  });
});
