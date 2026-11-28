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

  it("keeps loading connectors written for SDK ^0.2.0 to ^0.2.24", () => {
    expect(SDK_VERSION).toBe("0.2.24");
    for (const sdkVersion of [
      "^0.2.0",
      "^0.2.1",
      "^0.2.2",
      "^0.2.3",
      "^0.2.4",
      "^0.2.5",
      "^0.2.6",
      "^0.2.7",
      "^0.2.8",
      "^0.2.9",
      "^0.2.10",
      "^0.2.11",
      "^0.2.12",
      "^0.2.13",
      "^0.2.14",
      "^0.2.15",
      "^0.2.16",
      "^0.2.17",
      "^0.2.18",
      "^0.2.19",
      "^0.2.20",
      "^0.2.21",
      "^0.2.22",
      "^0.2.23",
      "^0.2.24",
    ]) {
      expect(
        assertManifestCompatible({ ...validManifest(), sdkVersion }).id,
      ).toBe("acme-analytics");
    }
  });

  it("accepts configOptions that name string config properties only (0.2.24)", () => {
    const withOptions = (configOptions: unknown) => ({
      ...validManifest(),
      configSchema: {
        type: "object",
        properties: {
          reports: { type: "string" },
          limit: { type: "integer" },
        },
      },
      configOptions,
    });
    expect(
      assertManifestCompatible(
        withOptions([{ key: "reports", per: "resource", maxSelected: 20 }]),
      ).configOptions,
    ).toEqual([{ key: "reports", per: "resource", maxSelected: 20 }]);
    expect(
      assertManifestCompatible(validManifest()).configOptions,
    ).toBeUndefined();
    expect(() =>
      assertManifestCompatible(
        withOptions([{ key: "limit", per: "resource", maxSelected: 20 }]),
      ),
    ).toThrow(/not a string property of configSchema/);
    expect(() =>
      assertManifestCompatible(
        withOptions([{ key: "missing", per: "resource", maxSelected: 20 }]),
      ),
    ).toThrow(/not a string property of configSchema/);
    expect(() =>
      assertManifestCompatible(
        withOptions([
          { key: "reports", per: "resource", maxSelected: 20 },
          { key: "reports", per: "resource", maxSelected: 5 },
        ]),
      ),
    ).toThrow(/unique/);
    expect(() =>
      assertManifestCompatible(
        withOptions([{ key: "reports", per: "resource", maxSelected: 0 }]),
      ),
    ).toThrow();
  });

  it("refuses a required picked field without a default (0.2.24 review)", () => {
    const withRequired = (reports: Record<string, unknown>) => ({
      ...validManifest(),
      configSchema: {
        type: "object",
        properties: { reports },
        required: ["reports"],
      },
      configOptions: [{ key: "reports", per: "resource", maxSelected: 5 }],
    });
    expect(() =>
      assertManifestCompatible(withRequired({ type: "string" })),
    ).toThrow(/required property without a valid default/);
    expect(() =>
      assertManifestCompatible(withRequired({ type: "string", default: null })),
    ).toThrow(/required property without a valid default/);
    expect(() =>
      assertManifestCompatible(
        withRequired({ type: "string", default: "", minLength: 1 }),
      ),
    ).toThrow(/required property without a valid default/);
    expect(() =>
      assertManifestCompatible(
        withRequired({ type: "string", default: "x", enum: ["a", "b"] }),
      ),
    ).toThrow(/required property without a valid default/);
    expect(
      assertManifestCompatible(withRequired({ type: "string", default: "" }))
        .configOptions,
    ).toHaveLength(1);
  });

  it("reads an empty enum as no enum for a picked field's default, as the host does (#937)", () => {
    // validateConnectionConfig only checks a nonempty enum, so a default
    // under `enum: []` is one the host accepts.
    const withRequired = (reports: Record<string, unknown>) => ({
      ...validManifest(),
      configSchema: {
        type: "object",
        properties: { reports },
        required: ["reports"],
      },
      configOptions: [{ key: "reports", per: "resource", maxSelected: 5 }],
    });
    expect(
      assertManifestCompatible(
        withRequired({ type: "string", default: "r1/a", enum: [] }),
      ).configOptions,
    ).toHaveLength(1);
    expect(() =>
      assertManifestCompatible(
        withRequired({ type: "string", default: "r1/a", enum: ["r1/b"] }),
      ),
    ).toThrow(/required property without a valid default/);
  });

  it("accepts configuredHosts that name config properties only (0.2.20)", () => {
    const withHosts = (configuredHosts: string[]) => ({
      ...validManifest(),
      configSchema: {
        type: "object",
        properties: { host: { type: "string" } },
      },
      configuredHosts,
    });
    expect(
      assertManifestCompatible(withHosts(["host"])).configuredHosts,
    ).toEqual(["host"]);
    expect(
      assertManifestCompatible(validManifest()).configuredHosts,
    ).toBeUndefined();
    expect(() => assertManifestCompatible(withHosts(["url"]))).toThrow(
      /not a property of configSchema/,
    );
  });

  it("accepts configuredHosts that name a URL in each item of an array (0.2.21)", () => {
    const withChecks = (configuredHosts: string[], items: unknown) => ({
      ...validManifest(),
      configSchema: {
        type: "object",
        properties: {
          host: { type: "string" },
          checks: { type: "array", items },
        },
      },
      configuredHosts,
    });
    const items = { type: "object", properties: { url: { type: "string" } } };
    expect(
      assertManifestCompatible(withChecks(["checks[].url"], items))
        .configuredHosts,
    ).toEqual(["checks[].url"]);
    expect(() =>
      assertManifestCompatible(withChecks(["checks[].name"], items)),
    ).toThrow(/not an item property of an array/);
    expect(() =>
      assertManifestCompatible(withChecks(["host[].url"], items)),
    ).toThrow(/not an item property of an array/);
  });

  it("refuses item translations of unknown config item fields (0.2.21)", () => {
    const manifest = (items: Record<string, { title: string }>) => ({
      ...validManifest(),
      configSchema: {
        type: "object",
        properties: {
          checks: {
            type: "array",
            items: {
              type: "object",
              properties: { url: { type: "string" } },
            },
          },
        },
      },
      translations: { de: { config: { checks: { items } } } },
    });
    expect(
      assertManifestCompatible(manifest({ url: { title: "Adresse" } }))
        .translations?.de?.config?.checks?.items?.url?.title,
    ).toBe("Adresse");
    expect(() =>
      assertManifestCompatible(manifest({ name: { title: "Name" } })),
    ).toThrow(/unknown config item field/);
  });

  it("keeps the optional discoversBeforeFirstSync, off by default (0.2.19)", () => {
    expect(
      assertManifestCompatible(validManifest()).discoversBeforeFirstSync,
    ).toBeUndefined();
    expect(
      assertManifestCompatible({
        ...validManifest(),
        discoversBeforeFirstSync: true,
      }).discoversBeforeFirstSync,
    ).toBe(true);
  });

  it("keeps an optional catalogue category and brand colour (0.2.7)", () => {
    const manifest = assertManifestCompatible({
      ...validManifest(),
      category: "seo",
      brandColor: "#4285f4",
    });
    expect(manifest.category).toBe("seo");
    expect(manifest.brandColor).toBe("#4285f4");
    const plain = assertManifestCompatible(validManifest());
    expect(plain.category).toBe(undefined);
    expect(plain.brandColor).toBe(undefined);
    for (const category of ["seo", "web", "apps", "ads", "revenue", "other"]) {
      expect(
        assertManifestCompatible({ ...validManifest(), category }).category,
      ).toBe(category);
    }
    expect(() =>
      assertManifestCompatible({ ...validManifest(), category: "games" }),
    ).toThrow();
    for (const brandColor of ["4285f4", "#428", "#4285f4ff", "blue", ""]) {
      expect(() =>
        assertManifestCompatible({ ...validManifest(), brandColor }),
      ).toThrow();
    }
  });

  it("keeps the noun a connector calls its resources by (0.2.4)", () => {
    const manifest = assertManifestCompatible({
      ...validManifest(),
      resourceNoun: { singular: "app", plural: "apps" },
    });
    expect(manifest.resourceNoun).toEqual({ singular: "app", plural: "apps" });
    expect(assertManifestCompatible(validManifest()).resourceNoun).toBe(
      undefined,
    );
    expect(() =>
      assertManifestCompatible({
        ...validManifest(),
        resourceNoun: { singular: "app", plural: "" },
      }),
    ).toThrow();
  });

  describe("translations (0.2.6)", () => {
    function translatable() {
      const base = validManifest();
      return {
        ...base,
        configSchema: {
          type: "object",
          properties: { teamId: { type: "string", title: "Team ID" } },
        },
        authStrategies: [
          {
            strategy: "token",
            credentialsSchema: {
              type: "object",
              properties: { token: { type: "string", title: "Token" } },
            },
            setup: { steps: ["Open settings.", "Copy the token."] },
          },
        ],
        metrics: [
          {
            ...base.metrics[0]!,
            dimensions: ["resource", "territory"],
          },
        ],
      };
    }
    const de = {
      name: "Acme-Analyse",
      description: "Testmanifest.",
      resourceNoun: { singular: "Website", plural: "Websites" },
      metrics: {
        "acme.visitors": { name: "Besucher", description: "Pro Tag." },
      },
      dimensions: { territory: "Land", resource: "Website" },
      config: { teamId: { title: "Team-ID" } },
      credentials: { token: { title: "Token", description: "Geheim." } },
      setupSteps: ["Öffne die Einstellungen.", "Kopiere das Token."],
    };

    it("validates manifests with and without translations", () => {
      expect(assertManifestCompatible(translatable()).translations).toBe(
        undefined,
      );
      const manifest = assertManifestCompatible({
        ...translatable(),
        translations: { de },
      });
      expect(manifest.translations).toEqual({ de });
      // Partial translations are fine: everything falls back to English.
      expect(
        assertManifestCompatible({
          ...translatable(),
          translations: { de: { metrics: { "acme.visitors": {} } }, fr: {} },
        }).translations,
      ).toEqual({ de: { metrics: { "acme.visitors": {} } }, fr: {} });
    });

    it("rejects keys the manifest does not have", () => {
      const cases: [unknown, RegExp][] = [
        [{ metrics: { "acme.unknown": { name: "x" } } }, /unknown metric/],
        [{ dimensions: { page: "Seite" } }, /unknown dimension/],
        [{ config: { siteUrl: { title: "x" } } }, /unknown config field/],
        [{ credentials: { apiKey: { title: "x" } } }, /unknown credential/],
        [{ setupSteps: ["Nur einer."] }, /one step for each/],
      ];
      for (const [translation, message] of cases) {
        expect(
          () =>
            assertManifestCompatible({
              ...translatable(),
              translations: { de: translation },
            }),
          JSON.stringify(translation),
        ).toThrow(message);
      }
    });

    it("rejects malformed translations", () => {
      for (const translations of [
        { en: { name: "Acme" } },
        { DE: { name: "Acme" } },
        { "de-AT": { name: "Acme" } },
        { de: { name: "" } },
        { de: { title: "typo" } },
        { de: { metrics: { "acme.visitors": { label: "x" } } } },
        { de: { resourceNoun: { singular: "App" } } },
        { de: "Acme" },
      ]) {
        expect(
          () => assertManifestCompatible({ ...translatable(), translations }),
          JSON.stringify(translations),
        ).toThrow();
      }
    });
  });

  it("accepts a signed-key strategy that names only its provider", () => {
    const manifest = assertManifestCompatible({
      ...validManifest(),
      sdkVersion: "^0.2.2",
      authStrategies: [
        { strategy: "signed-key", provider: "app-store-connect" },
      ],
    });
    expect(manifest.authStrategies).toEqual([
      { strategy: "signed-key", provider: "app-store-connect" },
    ]);
  });

  it("rejects signed-key strategies with unknown fields or bad provider ids", () => {
    const withStrategy = (strategy: unknown) => ({
      ...validManifest(),
      authStrategies: [strategy],
    });
    for (const strategy of [
      { strategy: "signed-key" },
      { strategy: "signed-key", provider: "" },
      { strategy: "signed-key", provider: "App-Store-Connect" },
      { strategy: "signed-key", provider: "app store connect" },
      { strategy: "signed-key", provider: "-app-store" },
      { strategy: "signed-key", provider: "app--store" },
      { strategy: "signed-key", provider: 7 },
      // The host owns the key fields, claims and lifetime (ADR 0014).
      { strategy: "signed-key", provider: "app-store-connect", scopes: ["a"] },
      {
        strategy: "signed-key",
        provider: "app-store-connect",
        claims: { aud: "x" },
      },
      {
        strategy: "signed-key",
        provider: "app-store-connect",
        credentialsSchema: { type: "object" },
      },
      { strategy: "signed-keys", provider: "app-store-connect" },
    ]) {
      expect(
        () => assertManifestCompatible(withStrategy(strategy)),
        JSON.stringify(strategy),
      ).toThrow();
    }
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

  it("requires a currency dimension for currency_minor metrics", () => {
    const proceeds = {
      ...validManifest().metrics[0]!,
      key: "acme.proceeds",
      kind: "delta",
      unit: "currency_minor",
      aggregations: ["sum"],
    };
    expect(() =>
      assertManifestCompatible({ ...validManifest(), metrics: [proceeds] }),
    ).toThrow(/needs a .*currency.* dimension/);
    expect(
      assertManifestCompatible({
        ...validManifest(),
        metrics: [{ ...proceeds, dimensions: ["resource", "currency"] }],
      }).metrics[0]!.unit,
    ).toBe("currency_minor");
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
