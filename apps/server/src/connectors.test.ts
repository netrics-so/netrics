import {
  EgressDeniedError,
  createEgressFetch,
} from "@netrics/connector-runtime";
import {
  appStoreConnectManifest,
  searchConsoleManifest,
} from "@netrics/connectors";
import { validateConnectionConfig } from "@netrics/contracts";
import { describe, expect, it } from "vitest";

import {
  createDefaultRegistry,
  logRegisteredConnectors,
  PREVIEW_CONNECTORS,
} from "./connectors.js";
import { loadConfig, loadMigrationConfig } from "./env.js";
import { BUNDLE_CONNECTORS } from "./preview-connectors.js";

describe("createDefaultRegistry", () => {
  it("keeps Apple Ads out of production until its setup is finished (#374, #375)", () => {
    expect(PREVIEW_CONNECTORS.has("apple-ads")).toBe(true);
    const production = createDefaultRegistry({ nodeEnv: "production" });
    expect(production.get("apple-ads")).toBeUndefined();
    expect(production.list().map(({ manifest }) => manifest.id)).toEqual([
      "demo",
      "vercel",
      "google-search-console",
      "app-store-connect",
      "google-play",
    ]);
    for (const nodeEnv of ["development", "test"] as const) {
      expect(createDefaultRegistry({ nodeEnv }).get("apple-ads")).toBeDefined();
    }
    expect(createDefaultRegistry().get("apple-ads")).toBeDefined();
  });

  it("registers an opted-in preview connector in production (#378)", () => {
    const optedIn = createDefaultRegistry({
      nodeEnv: "production",
      previewConnectors: new Set(["apple-ads"]),
    });
    expect(optedIn.list().map(({ manifest }) => manifest.id)).toEqual([
      "demo",
      "vercel",
      "google-search-console",
      "app-store-connect",
      "google-play",
      "apple-ads",
    ]);
    expect(
      createDefaultRegistry({
        nodeEnv: "production",
        previewConnectors: new Set(),
      }).get("apple-ads"),
    ).toBeUndefined();
    // Outside production the opt-in changes nothing.
    for (const previewConnectors of [
      new Set<string>(),
      new Set(["apple-ads"]),
    ]) {
      expect(
        createDefaultRegistry({ nodeEnv: "development", previewConnectors })
          .list()
          .map(({ manifest }) => manifest.id),
      ).toEqual(
        createDefaultRegistry()
          .list()
          .map(({ manifest }) => manifest.id),
      );
    }
  });

  it("keeps BUNDLE_CONNECTORS equal to the bundle, previews included (#378)", () => {
    const ids = createDefaultRegistry({ nodeEnv: "development" })
      .list()
      .map(({ manifest }) => manifest.id);
    expect([...BUNDLE_CONNECTORS].sort()).toEqual([...ids].sort());
    for (const id of PREVIEW_CONNECTORS) {
      expect(BUNDLE_CONNECTORS.has(id)).toBe(true);
    }
  });

  it("logs the registered connectors and warns about ignored entries (#378)", () => {
    const lines: Array<[string, object, string]> = [];
    const log = {
      info: (details: object, message: string) =>
        lines.push(["info", details, message]),
      warn: (details: object, message: string) =>
        lines.push(["warn", details, message]),
    };
    logRegisteredConnectors(
      log,
      createDefaultRegistry({ nodeEnv: "production" }),
    );
    expect(lines).toEqual([
      [
        "info",
        {
          connectors: [
            "demo",
            "vercel",
            "google-search-console",
            "app-store-connect",
            "google-play",
          ],
          previews: [],
        },
        "connectors registered",
      ],
    ]);
    lines.length = 0;
    logRegisteredConnectors(log, createDefaultRegistry(), {
      previewConnectorsIgnored: ["demo"],
    });
    expect(lines.map(([level]) => level)).toEqual(["warn", "info"]);
    expect(lines[0]![1]).toEqual({ ignored: ["demo"] });
    expect(lines[1]![1]).toMatchObject({ previews: ["apple-ads"] });
  });

  it("builds the same bundle from the API and the migration config (#378)", () => {
    const env = {
      NODE_ENV: "production",
      NETRICS_PREVIEW_CONNECTORS: "apple-ads",
    };
    const ids = (registry: ReturnType<typeof createDefaultRegistry>) =>
      registry.list().map(({ manifest }) => manifest.id);
    const api = loadConfig({
      ...env,
      BETTER_AUTH_URL: "https://app.example.com",
      WEB_ORIGIN: "https://app.example.com",
      BETTER_AUTH_SECRET: "x".repeat(32),
      APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    });
    const migrate = loadMigrationConfig(env);
    expect(ids(createDefaultRegistry(api))).toContain("apple-ads");
    expect(ids(createDefaultRegistry(migrate))).toEqual(
      ids(createDefaultRegistry(api)),
    );
  });

  it("ships the demo connector", () => {
    const registry = createDefaultRegistry();
    expect(registry.get("demo")?.manifest.id).toBe("demo");
  });

  it("ships Google Search Console as an OAuth connector", () => {
    const registry = createDefaultRegistry();
    expect(
      registry.get("google-search-console")?.manifest.authStrategies,
    ).toEqual([
      {
        strategy: "oauth2",
        provider: "google",
        scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
      },
    ]);
  });
});

describe("App Store Connect in the bundle", () => {
  it("ships as a signed-key connector with the vendor number as config", () => {
    const manifest = createDefaultRegistry().get("app-store-connect")?.manifest;
    expect(manifest?.authStrategies).toEqual([
      { strategy: "signed-key", provider: "app-store-connect" },
    ]);
    const validate = (config: Record<string, unknown>) =>
      validateConnectionConfig(appStoreConnectManifest.configSchema, config);
    expect(validate({ vendorNumber: "85012345" })).toEqual({
      ok: true,
      config: { vendorNumber: "85012345", ratingStorefront: "US" },
    });
    expect(validate({}).ok).toBe(false);
    expect(validate({ vendorNumber: "85012345", issuerId: "x" }).ok).toBe(
      false,
    );
  });

  it("reaches api.appstoreconnect.apple.com and nothing else", async () => {
    const lookedUp: string[] = [];
    const fetch = createEgressFetch({
      allowedDomains: appStoreConnectManifest.outboundDomains,
      signal: new AbortController().signal,
      lookup: ((hostname: string, _options: unknown, callback: unknown) => {
        lookedUp.push(hostname);
        (callback as (error: Error) => void)(new Error("offline test"));
      }) as never,
    });
    for (const url of [
      "https://appstoreconnect.apple.com/access/integrations/api",
      "https://api.appstoreconnect.apple.com.evil.example/v1/apps",
      "http://api.appstoreconnect.apple.com/v1/apps",
      "https://example.s3.us-west-2.amazonaws.com/segment.csv.gz",
    ]) {
      await expect(fetch(url)).rejects.toBeInstanceOf(EgressDeniedError);
    }
    expect(lookedUp).toEqual([]);
    await expect(
      fetch("https://api.appstoreconnect.apple.com/v1/apps"),
    ).rejects.not.toBeInstanceOf(EgressDeniedError);
    expect(lookedUp).toEqual(["api.appstoreconnect.apple.com"]);
  });
});

describe("Google Search Console config validation (API)", () => {
  const validate = (config: Record<string, unknown>) =>
    validateConnectionConfig(searchConsoleManifest.configSchema, config);

  it("accepts up to two dimensions and applies the defaults", () => {
    expect(validate({ siteUrl: "sc-domain:example.com" })).toEqual({
      ok: true,
      config: {
        siteUrl: "sc-domain:example.com",
        dimensions: "none",
        rowLimit: 1000,
      },
    });
    expect(
      validate({ siteUrl: "https://example.com/", dimensions: "query,device" })
        .ok,
    ).toBe(true);
  });

  it("rejects three dimensions and more than 5,000 rows a day", () => {
    expect(validate({ dimensions: "page,query,country" })).toEqual({
      ok: false,
      message: expect.stringMatching(/^dimensions must be one of/),
    });
    expect(validate({ rowLimit: 5001 })).toEqual({
      ok: false,
      message: "rowLimit must be at most 5000",
    });
    expect(validate({ rowLimit: 0 }).ok).toBe(false);
    expect(validate({ searchType: "image" }).ok).toBe(false);
  });
});

describe("Google Search Console egress", () => {
  /** Fails the test if a lookup is attempted for a denied host. */
  function guardedFetch(lookedUp: string[]) {
    return createEgressFetch({
      allowedDomains: searchConsoleManifest.outboundDomains,
      signal: new AbortController().signal,
      lookup: ((hostname: string, _options: unknown, callback: unknown) => {
        lookedUp.push(hostname);
        (callback as (error: Error) => void)(new Error("offline test"));
      }) as never,
    });
  }

  it("reaches searchconsole.googleapis.com and nothing else", async () => {
    const lookedUp: string[] = [];
    const fetch = guardedFetch(lookedUp);
    for (const url of [
      "https://oauth2.googleapis.com/token",
      "https://accounts.google.com/o/oauth2/v2/auth",
      "https://www.googleapis.com/webmasters/v3/sites",
      "https://searchconsole.googleapis.com.evil.example/webmasters/v3/sites",
      "http://searchconsole.googleapis.com/webmasters/v3/sites",
    ]) {
      await expect(fetch(url)).rejects.toBeInstanceOf(EgressDeniedError);
    }
    expect(lookedUp).toEqual([]);

    // The allowed host passes the allowlist and gets as far as DNS.
    await expect(
      fetch("https://searchconsole.googleapis.com/webmasters/v3/sites"),
    ).rejects.not.toBeInstanceOf(EgressDeniedError);
    expect(lookedUp).toEqual(["searchconsole.googleapis.com"]);
  });
});
