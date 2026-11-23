import { describe, expect, it } from "vitest";

import { configuredHost, configuredHostsOf } from "./hosts.js";

describe("configuredHost (#873)", () => {
  it("reads a bare host name or an https origin", () => {
    expect(configuredHost("posthog.example.com")).toBe("posthog.example.com");
    expect(configuredHost(" PostHog.Example.com ")).toBe("posthog.example.com");
    expect(configuredHost("https://posthog.example.com")).toBe(
      "posthog.example.com",
    );
    expect(configuredHost("https://posthog.example.com/")).toBe(
      "posthog.example.com",
    );
    expect(configuredHost("analytics.example.co.uk.")).toBe(
      "analytics.example.co.uk",
    );
  });

  it("refuses anything that is not a host name", () => {
    for (const value of [
      undefined,
      null,
      42,
      "",
      "localhost",
      "http://posthog.example.com",
      "ftp://posthog.example.com",
      "https://posthog.example.com/api",
      "https://user:pass@posthog.example.com",
      "posthog.example.com:8443",
      "posthog.example.com/path",
      "posthog.example.com?x=1",
      "*.example.com",
      "10.0.0.1",
      "169.254.169.254",
      "[::1]",
      "-bad.example.com",
      "bad-.example.com",
      "exa mple.com",
      `${"a".repeat(64)}.example.com`,
      `${"a.".repeat(127)}com`,
    ]) {
      expect(configuredHost(value), String(value)).toBeNull();
    }
  });

  it("lists the valid hosts of the manifest's keys only", () => {
    const manifest = { configuredHosts: ["host", "other"] };
    expect(
      configuredHostsOf(manifest, {
        host: "https://posthog.example.com",
        other: "http://insecure.example.com",
        unlisted: "elsewhere.example.com",
      }),
    ).toEqual(["posthog.example.com"]);
    expect(configuredHostsOf({}, { host: "posthog.example.com" })).toEqual([]);
    expect(
      configuredHostsOf(manifest, {
        host: "posthog.example.com",
        other: "POSTHOG.example.com",
      }),
    ).toEqual(["posthog.example.com"]);
  });
});
