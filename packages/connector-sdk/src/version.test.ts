import { describe, expect, it } from "vitest";

import { SDK_VERSION, assertManifestCompatible } from "./version.js";

function validManifest() {
  return {
    id: "acme-analytics",
    version: "1.0.0",
    sdkVersion: `^${SDK_VERSION}`,
    name: "Acme Analytics",
    description: "Fixture manifest for SDK tests.",
    authStrategies: [{ strategy: "token" }],
    configSchema: { type: "object" },
    metrics: [
      {
        key: "acme.visitors",
        name: "Visitors",
        description: "Daily visitors.",
        kind: "gauge",
        unit: "visitors",
        dimensions: ["resource"],
        aggregations: ["sum", "avg", "min", "max", "last"],
      },
    ],
    minRefreshIntervalSeconds: 300,
    supportsBackfill: true,
    outboundDomains: ["api.acme.test"],
  };
}

describe("assertManifestCompatible", () => {
  it("accepts a valid manifest with a compatible range", () => {
    const manifest = assertManifestCompatible(validManifest());
    expect(manifest.id).toBe("acme-analytics");
  });

  it("accepts exact and comparator-set ranges that include SDK_VERSION", () => {
    assertManifestCompatible({
      ...validManifest(),
      sdkVersion: SDK_VERSION,
    });
    assertManifestCompatible({
      ...validManifest(),
      sdkVersion: `>=0.1.0 <1.0.0`,
    });
  });

  it("rejects a manifest whose range excludes SDK_VERSION", () => {
    expect(() =>
      assertManifestCompatible({ ...validManifest(), sdkVersion: "^0.2.0" }),
    ).toThrow(/requires SDK version/);
    expect(() =>
      assertManifestCompatible({ ...validManifest(), sdkVersion: ">=9.0.0" }),
    ).toThrow(/requires SDK version/);
  });

  it("rejects malformed manifests", () => {
    expect(() => assertManifestCompatible({})).toThrow();
    expect(() =>
      assertManifestCompatible({ ...validManifest(), id: "Not A Slug" }),
    ).toThrow();
    expect(() =>
      assertManifestCompatible({ ...validManifest(), sdkVersion: "1.x" }),
    ).toThrow();
    expect(() =>
      assertManifestCompatible({
        ...validManifest(),
        metrics: [validManifest().metrics[0], validManifest().metrics[0]],
      }),
    ).toThrow(/unique/);
  });
});
