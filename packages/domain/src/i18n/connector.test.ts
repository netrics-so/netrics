import { describe, expect, it } from "vitest";

import {
  connectorTranslation,
  defaultDimensionName,
  localizedDimensionName,
  localizedManifest,
  localizedMetric,
  localizedResourceNoun,
  type TranslatableManifest,
} from "../index.js";

// #257 (ADR 0016 section 6): connector metadata in the reader's language,
// field by field falling back to the English manifest.

function manifest(
  translations?: TranslatableManifest["translations"],
): TranslatableManifest & { id: string } {
  return {
    id: "acme",
    name: "Acme Analytics",
    description: "Visitors from Acme.",
    resourceNoun: { singular: "site", plural: "sites" },
    metrics: [
      { key: "acme.visitors", name: "Visitors", description: "Per day." },
      { key: "acme.signups", name: "Signups", description: "New per day." },
    ],
    configSchema: {
      type: "object",
      properties: {
        teamId: { type: "string", title: "Team ID", description: "Optional." },
        region: { type: "string", title: "Region" },
      },
    },
    authStrategies: [
      {
        strategy: "token",
        credentialsSchema: {
          type: "object",
          properties: { token: { type: "string", title: "Access token" } },
        },
        setup: {
          steps: ["Open settings.", "Copy the token."],
          url: "https://acme.test",
        },
      },
      { strategy: "none" },
    ],
    ...(translations === undefined ? {} : { translations }),
  };
}

const de = {
  name: "Acme-Analyse",
  resourceNoun: { singular: "Website", plural: "Websites" },
  metrics: { "acme.visitors": { name: "Besucher" } },
  dimensions: { territory: "Land" },
  config: { teamId: { title: "Team-ID" } },
  credentials: {
    token: {
      title: "Zugriffstoken",
      description: "Wird verschlüsselt gespeichert.",
    },
  },
  setupSteps: ["Öffne die Einstellungen.", "Kopiere das Token."],
};

describe("localizedManifest", () => {
  it("translates what the locale has and keeps English for the rest", () => {
    const localized = localizedManifest(manifest({ de }), "de");
    expect(localized.name).toBe("Acme-Analyse");
    expect(localized.description).toBe("Visitors from Acme.");
    expect(localized.resourceNoun).toEqual({
      singular: "Website",
      plural: "Websites",
    });
    expect(localized.metrics).toEqual([
      { key: "acme.visitors", name: "Besucher", description: "Per day." },
      { key: "acme.signups", name: "Signups", description: "New per day." },
    ]);
    expect(localized.configSchema).toEqual({
      type: "object",
      properties: {
        teamId: { type: "string", title: "Team-ID", description: "Optional." },
        region: { type: "string", title: "Region" },
      },
    });
    expect(localized.authStrategies?.[0]).toEqual({
      strategy: "token",
      credentialsSchema: {
        type: "object",
        properties: {
          token: {
            type: "string",
            title: "Zugriffstoken",
            description: "Wird verschlüsselt gespeichert.",
          },
        },
      },
      setup: {
        steps: ["Öffne die Einstellungen.", "Kopiere das Token."],
        url: "https://acme.test",
      },
    });
    expect(localized.authStrategies?.[1]).toEqual({ strategy: "none" });
    // Not a translated field: kept as is.
    expect(localized.id).toBe("acme");
  });

  it("is the English manifest for English, unknown locales and none", () => {
    const withDe = manifest({ de });
    expect(localizedManifest(withDe, "en")).toBe(withDe);
    expect(localizedManifest(withDe, "fr")).toBe(withDe);
    const without = manifest();
    expect(localizedManifest(without, "de")).toBe(without);
  });

  it("does not modify the manifest it is given", () => {
    const original = manifest({ de });
    const snapshot = structuredClone(original);
    localizedManifest(original, "de");
    expect(original).toEqual(snapshot);
  });

  it("keeps English steps unless every step is translated", () => {
    const localized = localizedManifest(
      manifest({ de: { setupSteps: ["Nur ein Schritt."] } }),
      "de",
    );
    expect(localized.authStrategies?.[0]?.setup?.steps).toEqual([
      "Open settings.",
      "Copy the token.",
    ]);
  });

  it("ignores empty and malformed stored translations", () => {
    for (const translations of [
      { de: { name: "", metrics: { "acme.visitors": { name: " " } } } },
      { de: "Deutsch" },
      { de: null },
      "nonsense",
      null,
    ]) {
      const localized = localizedManifest(
        manifest(translations as TranslatableManifest["translations"]),
        "de",
      );
      expect(localized.name).toBe("Acme Analytics");
      expect(localized.metrics[0]?.name).toBe("Visitors");
    }
  });

  it("does not read inherited properties as locales", () => {
    expect(connectorTranslation({}, "constructor")).toBeNull();
    expect(connectorTranslation({}, "__proto__")).toBeNull();
  });
});

describe("localizedMetric", () => {
  it("falls back per field", () => {
    const m = manifest({
      de: { metrics: { "acme.signups": { description: "Neue pro Tag." } } },
    });
    expect(localizedMetric(m, m.metrics[1]!, "de")).toEqual({
      name: "Signups",
      description: "Neue pro Tag.",
    });
    expect(localizedMetric(m, m.metrics[1]!, "en")).toEqual({
      name: "Signups",
      description: "New per day.",
    });
  });

  it("works from stored translations and a catalog row", () => {
    expect(
      localizedMetric(
        { translations: { de } },
        { key: "acme.visitors", name: "Visitors", description: "Per day." },
        "de",
      ),
    ).toEqual({ name: "Besucher", description: "Per day." });
  });
});

describe("localizedResourceNoun", () => {
  it("needs both forms, else English, else null", () => {
    expect(localizedResourceNoun(manifest({ de }), "de")).toEqual({
      singular: "Website",
      plural: "Websites",
    });
    expect(
      localizedResourceNoun(
        manifest({
          de: { resourceNoun: { singular: "Website" } as never },
        }),
        "de",
      ),
    ).toEqual({ singular: "site", plural: "sites" });
    expect(localizedResourceNoun({ translations: { de } }, "en")).toBeNull();
  });
});

describe("dimension names", () => {
  it("uses the translation, else the key in sentence case", () => {
    const m = manifest({ de });
    expect(localizedDimensionName(m, "territory", "de")).toBe("Land");
    expect(localizedDimensionName(m, "territory", "en")).toBe("Territory");
    expect(localizedDimensionName(m, "event_name", "de")).toBe("Event name");
    expect(defaultDimensionName("route")).toBe("Route");
  });
});
