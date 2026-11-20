import { assertManifestCompatible } from "@netrics/connector-sdk";
import type { CustomApiDefinition } from "@netrics/connector-sdk/custom-api";
import { describe, expect, it } from "vitest";

import {
  CustomApiConfigError,
  customApiCredentialHosts,
  customApiCredentialsSchema,
  customApiManifest,
} from "./index.js";
import { pinFor, sdkFixture } from "./test-helpers.js";
import {
  FIXTURE_DEFINITION_NAMES,
  fixtureDefinition,
} from "./testing/index.js";

const shop = sdkFixture("v1-shop");
const oauthDef: CustomApiDefinition = {
  ...shop,
  auth: {
    type: "oauth_client_credentials",
    tokenUrl: "https://auth.example.com/token",
    scopes: [],
    clientAuth: "body",
  },
};

describe("custom API effective manifest", () => {
  it("builds a valid manifest for every fixture definition", () => {
    const all = [
      sdkFixture("v1-shop"),
      sdkFixture("v1-all-auth"),
      sdkFixture("v1-images"),
      ...FIXTURE_DEFINITION_NAMES.map((name) =>
        fixtureDefinition(name, "https://127.0.0.1:4443"),
      ),
    ];
    for (const def of all)
      expect(() =>
        assertManifestCompatible(customApiManifest(def, pinFor(def))),
      ).not.toThrow();
  });

  it("declares only the environment and auth endpoint hosts", () =>
    expect(
      customApiManifest(
        oauthDef,
        pinFor(oauthDef, { environmentId: "staging" }),
      ).outboundDomains,
    ).toEqual(["staging.example.com", "auth.example.com"]));

  it("adds the definition's image hosts to outboundDomains", () => {
    const withImages = {
      ...shop,
      images: { hosts: ["cdn.example.com"], newestItems: 12 },
    };
    expect(
      customApiManifest(withImages, pinFor(withImages)).outboundDomains,
    ).toEqual(["api.example.com", "cdn.example.com"]);
    expect(customApiCredentialHosts(withImages, "production")).toEqual([
      "api.example.com",
    ]);
  });

  it("maps the image role and dataset versions", () => {
    const images = sdkFixture("v1-images");
    const manifest = customApiManifest(
      images,
      pinFor(images, { version: 7, datasetVersions: { images: 4 } }),
    );
    expect(manifest.version).toBe("1.0.7");
    const dataset = manifest.datasets![0]!;
    expect(dataset.version).toBe(4);
    expect(dataset.fields.find((f) => f.id === "url")).toMatchObject({
      type: "string",
      role: "image",
    });
    expect(dataset.grain).toBe("One record per id");
    expect(manifest.outboundDomains).toEqual([
      "gallery.example.com",
      "*.cdn.example.com",
    ]);
  });

  it("sets the shop's schedule, backfill, config and zone", () => {
    const manifest = customApiManifest(shop, pinFor(shop));
    expect(manifest).toMatchObject({
      id: "custom-api",
      name: "Shop API",
      category: "other",
      metrics: [],
      minRefreshIntervalSeconds: 3600,
      supportsBackfill: true,
      backfillDays: 365,
      authStrategies: [{ strategy: "token" }],
      configSchema: {
        required: ["account_id"],
        additionalProperties: false,
      },
    });
    expect(manifest.datasets![0]).toMatchObject({
      reportingTimeZone: "UTC",
      retentionDays: null,
    });
  });

  it("refuses an unknown environment", () => {
    expect(() =>
      customApiManifest(shop, pinFor(shop, { environmentId: "nope" })),
    ).toThrow(CustomApiConfigError);
  });

  it("refuses a pin without a stream's dataset version", () => {
    expect(() =>
      customApiManifest(shop, pinFor(shop, { datasetVersions: {} })),
    ).toThrow(CustomApiConfigError);
  });

  it("describes the credentials per auth type", () => {
    const schema = customApiCredentialsSchema(shop);
    expect(
      schema.safeParse({ host: "api.example.com", token: "t" }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ host: "api.example.com", apiKey: "k" }).success,
    ).toBe(false);
    const secret = {
      ...shop,
      auth: { type: "none" as const },
      variables: [{ id: "tenant", label: "Tenant", secret: true }],
    };
    expect(
      customApiCredentialsSchema(secret).safeParse({
        host: "api.example.com",
        variables: { tenant: "x" },
      }).success,
    ).toBe(true);
    expect(
      customApiCredentialsSchema(secret).safeParse({ host: "api.example.com" })
        .success,
    ).toBe(false);
  });
});
