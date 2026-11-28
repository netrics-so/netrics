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
  it("ships Apple Ads in production without an opt-in, since its exit gate passed (#378)", () => {
    expect(PREVIEW_CONNECTORS.has("apple-ads")).toBe(false);
    const finished = [
      "demo",
      "vercel",
      "google-search-console",
      "app-store-connect",
      "google-play",
      "apple-ads",
    ];
    expect(
      createDefaultRegistry({ nodeEnv: "production" })
        .list()
        .map(({ manifest }) => manifest.id),
    ).toEqual(finished);
    for (const nodeEnv of ["development", "test"] as const) {
      expect(
        createDefaultRegistry({ nodeEnv })
          .list()
          .map(({ manifest }) => manifest.id),
      ).toEqual([
        ...finished,
        "railway",
        "posthog",
        "hetzner-cloud",
        "http-check",
      ]);
    }
  });

  it("ships Railway, PostHog, Hetzner Cloud and HTTP checks as previews until milestone 13.1's exit gate (#870, #872, #873, #874, #877)", () => {
    expect([...PREVIEW_CONNECTORS]).toEqual([
      "railway",
      "posthog",
      "hetzner-cloud",
      "http-check",
    ]);
    for (const id of ["railway", "posthog", "hetzner-cloud", "http-check"]) {
      expect(
        createDefaultRegistry({ nodeEnv: "production" }).get(id),
      ).toBeUndefined();
      expect(
        createDefaultRegistry({
          nodeEnv: "production",
          previewConnectors: new Set([id]),
        }).get(id),
      ).toBeDefined();
    }
  });

  // The bundle has no preview at the moment; a test-only set keeps the
  // mechanism covered for the next one.
  it("keeps a preview out of production unless opted in (#378)", () => {
    const previews = new Set(["google-play"]);
    const production = createDefaultRegistry({
      nodeEnv: "production",
      previews,
    });
    expect(production.get("google-play")).toBeUndefined();
    expect(production.get("apple-ads")).toBeDefined();
    const optedIn = createDefaultRegistry({
      nodeEnv: "production",
      previews,
      previewConnectors: new Set(["google-play"]),
    });
    expect(optedIn.get("google-play")).toBeDefined();
    // Outside production every preview is registered, opt-in or not.
    for (const previewConnectors of [
      new Set<string>(),
      new Set(["google-play"]),
    ]) {
      expect(
        createDefaultRegistry({
          nodeEnv: "development",
          previews,
          previewConnectors,
        })
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
            "apple-ads",
          ],
          previews: [],
        },
        "connectors registered",
      ],
    ]);
    lines.length = 0;
    // A leftover NETRICS_PREVIEW_CONNECTORS=apple-ads, with a test-only
    // preview to show the previews field.
    const previews = new Set(["google-play"]);
    logRegisteredConnectors(log, createDefaultRegistry({ previews }), {
      previewConnectorsIgnored: ["apple-ads"],
      previews,
    });
    expect(lines.map(([level]) => level)).toEqual(["warn", "info"]);
    expect(lines[0]![1]).toEqual({ ignored: ["apple-ads"] });
    expect(lines[1]![1]).toMatchObject({ previews: ["google-play"] });
  });

  it("warns about broad NETRICS_CUSTOM_API_PRIVATE_HOSTS entries", () => {
    const warnings: Array<[object, string]> = [];
    const log = {
      info: () => {},
      warn: (details: object, message: string) =>
        warnings.push([details, message]),
    };
    const registry = createDefaultRegistry({ nodeEnv: "production" });
    logRegisteredConnectors(log, registry, {
      customApiPrivateHosts: ["intranet.example", "10.20.0.0/16"],
    });
    expect(warnings).toEqual([]);
    logRegisteredConnectors(log, registry, {
      customApiPrivateHosts: ["*.com", "intranet.example", "localhost"],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]![0]).toEqual({ entries: ["*.com", "localhost"] });
    expect(warnings[0]![1]).toMatch(/NETRICS_CUSTOM_API_PRIVATE_HOSTS/);
  });

  it("warns about broad NETRICS_CONNECTOR_PRIVATE_HOSTS entries (#892)", () => {
    const warnings: Array<[object, string]> = [];
    const log = {
      info: () => {},
      warn: (details: object, message: string) =>
        warnings.push([details, message]),
    };
    const registry = createDefaultRegistry({ nodeEnv: "production" });
    logRegisteredConnectors(log, registry, {
      connectorPrivateHosts: ["posthog.internal.example", "10.20.0.0/16"],
    });
    expect(warnings).toEqual([]);
    logRegisteredConnectors(log, registry, {
      connectorPrivateHosts: ["*.local", "posthog.internal.example"],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]![0]).toEqual({ entries: ["*.local"] });
    expect(warnings[0]![1]).toMatch(/NETRICS_CONNECTOR_PRIVATE_HOSTS/);
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
    expect(api.previewConnectorsIgnored).toEqual(["apple-ads"]);
    expect(migrate.previewConnectorsIgnored).toEqual(["apple-ads"]);
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
