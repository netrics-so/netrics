import {
  EgressDeniedError,
  createEgressFetch,
} from "@netrics/connector-runtime";
import { searchConsoleManifest } from "@netrics/connectors";
import { validateConnectionConfig } from "@netrics/contracts";
import { describe, expect, it } from "vitest";

import { createDefaultRegistry } from "./connectors.js";

describe("createDefaultRegistry", () => {
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
