import { describe, expect, it } from "vitest";

import {
  CREDENTIAL_HOSTS_KEY,
  bindCredentialHosts,
  configuredHost,
  configuredHostsChanged,
  configuredHostsOf,
  credentialHostsMatch,
  withoutCredentialHosts,
} from "./hosts.js";

describe("credentials bound to configured hosts (#884 review)", () => {
  const manifest = { configuredHosts: ["host"] };
  const at = (host: string) => ({ host });

  it("binds fresh credentials to the config's hosts, and only for such manifests", () => {
    expect(
      bindCredentialHosts(manifest, at("a.example.com"), { token: "t" }),
    ).toEqual({ token: "t", [CREDENTIAL_HOSTS_KEY]: ["a.example.com"] });
    expect(
      bindCredentialHosts({}, at("a.example.com"), { token: "t" }),
    ).toEqual({
      token: "t",
    });
    expect(
      withoutCredentialHosts({
        token: "t",
        [CREDENTIAL_HOSTS_KEY]: ["x.example"],
      }),
    ).toEqual({ token: "t" });
  });

  it("matches only the bound hosts while a secret is present", () => {
    const bound = bindCredentialHosts(manifest, at("a.example.com"), {
      token: "t",
    });
    expect(credentialHostsMatch(manifest, at("a.example.com"), bound)).toBe(
      true,
    );
    expect(credentialHostsMatch(manifest, at("b.example.com"), bound)).toBe(
      false,
    );
    // Unbound credentials never go to a configured host.
    expect(
      credentialHostsMatch(manifest, at("a.example.com"), { token: "t" }),
    ).toBe(false);
    // No secret, nothing to protect; no configuredHosts, no rule.
    expect(credentialHostsMatch(manifest, at("b.example.com"), {})).toBe(true);
    expect(credentialHostsMatch({}, at("b.example.com"), { token: "t" })).toBe(
      true,
    );
  });

  it("reads an empty or missing host as the schema's default (#884 review 2)", () => {
    const withDefault = {
      configuredHosts: ["host"],
      configSchema: {
        type: "object",
        properties: { host: { type: "string", default: "us.example.com" } },
      },
    };
    for (const empty of [{}, { host: "" }, { host: "  " }, { host: null }]) {
      expect(configuredHostsOf(withDefault, empty)).toEqual(["us.example.com"]);
      expect(
        configuredHostsChanged(withDefault, empty, at("us.example.com")),
      ).toBe(false);
      expect(
        credentialHostsMatch(
          withDefault,
          at("us.example.com"),
          bindCredentialHosts(withDefault, empty, { token: "t" }),
        ),
      ).toBe(true);
    }
  });

  it("tells a change of configured hosts from other changes", () => {
    expect(
      configuredHostsChanged(
        manifest,
        { host: "a.example.com", other: 1 },
        { host: "A.example.com", other: 2 },
      ),
    ).toBe(false);
    expect(
      configuredHostsChanged(
        manifest,
        at("a.example.com"),
        at("b.example.com"),
      ),
    ).toBe(true);
  });
});

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
