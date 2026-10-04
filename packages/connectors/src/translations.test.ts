import {
  assertManifestCompatible,
  type ConnectorManifest,
} from "@netrics/connector-sdk";
import { describe, expect, it } from "vitest";

import { appStoreConnectManifest } from "./app-store-connect/index.js";
import { demoManifest } from "./demo/index.js";
import { searchConsoleManifest } from "./google-search-console/index.js";
import { vercelManifest } from "./vercel/index.js";

// #257 (ADR 0016 section 6): the first-party connectors are complete in
// German. Every English text a user sees has a German counterpart, so
// nothing falls back to English for them.

const FIRST_PARTY: ConnectorManifest[] = [
  demoManifest,
  vercelManifest,
  searchConsoleManifest,
  appStoreConnectManifest,
];

const LOCALES = ["de"] as const;

/** Property keys of a JSON Schema whose property has the given text. */
function textKeys(schema: unknown, text: "title" | "description"): string[] {
  const properties = (schema as { properties?: Record<string, unknown> })
    ?.properties;
  return Object.entries(properties ?? {})
    .filter(([, property]) => {
      const value = (property as Record<string, unknown>)[text];
      return typeof value === "string" && value !== "";
    })
    .map(([key]) => key);
}

describe.each(FIRST_PARTY.map((manifest) => [manifest.id, manifest] as const))(
  "%s translations",
  (_id, manifest) => {
    it("validate against SDK 0.2.7 (0.2.8 with review text)", () => {
      expect(manifest.sdkVersion).toBe(
        manifest.id === "app-store-connect" ? "^0.2.8" : "^0.2.7",
      );
      expect(assertManifestCompatible(manifest).translations).toEqual(
        manifest.translations,
      );
    });

    it("is filed under a catalogue category (#306)", () => {
      expect(assertManifestCompatible(manifest).category).toBeDefined();
    });

    describe.each(LOCALES)("%s", (locale) => {
      const translation = manifest.translations?.[locale];

      it("names and describes the connector", () => {
        expect(translation?.name).toBeTruthy();
        expect(translation?.description).toBeTruthy();
      });

      it("has a name and a description for every metric", () => {
        for (const metric of manifest.metrics) {
          const translated = translation?.metrics?.[metric.key];
          expect(translated?.name, metric.key).toBeTruthy();
          expect(translated?.description, metric.key).toBeTruthy();
        }
      });

      it("names the resources and every dimension", () => {
        if (manifest.resourceNoun) {
          expect(translation?.resourceNoun?.singular).toBeTruthy();
          expect(translation?.resourceNoun?.plural).toBeTruthy();
        }
        for (const dimension of new Set(
          manifest.metrics.flatMap((metric) => metric.dimensions),
        )) {
          expect(translation?.dimensions?.[dimension], dimension).toBeTruthy();
        }
      });

      it("translates every titled config and credential field", () => {
        for (const text of ["title", "description"] as const) {
          for (const key of textKeys(manifest.configSchema, text)) {
            expect(translation?.config?.[key]?.[text], key).toBeTruthy();
          }
          for (const strategy of manifest.authStrategies) {
            if (strategy.strategy !== "token") {
              continue;
            }
            for (const key of textKeys(strategy.credentialsSchema, text)) {
              expect(translation?.credentials?.[key]?.[text], key).toBeTruthy();
            }
            if (strategy.setup) {
              expect(translation?.setupSteps).toHaveLength(
                strategy.setup.steps.length,
              );
            }
          }
        }
      });
    });
  },
);
