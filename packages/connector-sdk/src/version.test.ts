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
        granularity: "day",
        dimensions: ["resource"],
        aggregations: ["sum", "avg", "min", "max", "last"],
      },
    ],
    minRefreshIntervalSeconds: 300,
    supportsBackfill: true,
    backfillDays: 90,
    outboundDomains: ["api.acme.test"],
  };
}

describe("assertManifestCompatible", () => {
  it("accepts a valid manifest with a compatible range", () => {
    const manifest = assertManifestCompatible(validManifest());
    expect(manifest.id).toBe("acme-analytics");
  });

  it("accepts credential setup steps and rejects empty or unlinked ones", () => {
    const withSetup = (setup: unknown) => ({
      ...validManifest(),
      authStrategies: [{ strategy: "token", setup }],
    });
    const [strategy] = assertManifestCompatible(
      withSetup({
        steps: ["Open Settings → Tokens.", "Create a read-only token."],
        url: "https://acme.test/settings/tokens",
      }),
    ).authStrategies;
    expect(
      strategy?.strategy === "token" ? strategy.setup?.steps : undefined,
    ).toHaveLength(2);
    expect(() => assertManifestCompatible(withSetup({ steps: [] }))).toThrow();
    expect(() =>
      assertManifestCompatible(withSetup({ steps: ["x"], url: "not a url" })),
    ).toThrow();
  });

  it("keeps loading connectors written for SDK ^0.2.0", () => {
    expect(SDK_VERSION).toBe("0.2.1");
    expect(
      assertManifestCompatible({ ...validManifest(), sdkVersion: "^0.2.0" }).id,
    ).toBe("acme-analytics");
  });

  it("accepts an oauth2 strategy naming a provider and its scopes", () => {
    const manifest = assertManifestCompatible({
      ...validManifest(),
      sdkVersion: "^0.2.1",
      authStrategies: [
        {
          strategy: "oauth2",
          provider: "google",
          scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
        },
      ],
    });
    expect(manifest.authStrategies[0]).toEqual({
      strategy: "oauth2",
      provider: "google",
      scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
    });
  });

  it("rejects oauth2 strategies without a provider or scopes", () => {
    const withStrategy = (strategy: unknown) => ({
      ...validManifest(),
      authStrategies: [strategy],
    });
    for (const strategy of [
      { strategy: "oauth2", scopes: ["a"] },
      { strategy: "oauth2", provider: "google", scopes: [] },
      { strategy: "oauth2", provider: "google" },
      { strategy: "oauth2", provider: "Not A Slug", scopes: ["a"] },
      { strategy: "oauth2", provider: "google", scopes: ["a", "a"] },
    ]) {
      expect(() => assertManifestCompatible(withStrategy(strategy))).toThrow();
    }
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
      assertManifestCompatible({ ...validManifest(), sdkVersion: "^0.1.0" }),
    ).toThrow(/requires SDK version/);
    expect(() =>
      assertManifestCompatible({ ...validManifest(), sdkVersion: ">=9.0.0" }),
    ).toThrow(/requires SDK version/);
  });

  it("requires backfillDays when backfill is supported, and a granularity", () => {
    const { backfillDays: _backfillDays, ...withoutDays } = validManifest();
    expect(() => assertManifestCompatible(withoutDays)).toThrow(/backfillDays/);
    expect(
      assertManifestCompatible({ ...withoutDays, supportsBackfill: false }).id,
    ).toBe("acme-analytics");
    const { granularity: _granularity, ...metricWithout } =
      validManifest().metrics[0]!;
    expect(() =>
      assertManifestCompatible({
        ...validManifest(),
        metrics: [metricWithout],
      }),
    ).toThrow();
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
