import { describe, expect, it } from "vitest";

import {
  oauthCallbackOutcomeSchema,
  type ConnectionRevocation,
} from "@netrics/contracts";

import {
  GOOGLE_OAUTH_SETUP_GUIDE,
  disconnectQuery,
  parseDisconnected,
  fromDimensionsValue,
  oauthOutcomeMessage,
  oauthProviderOf,
  parseOAuthOutcome,
  parseRowLimit,
  propertyView,
  providerName,
  reauthorizationCopy,
  revocationMessage,
  toDimensionsValue,
  unavailableCopy,
} from "./oauth-connection";

describe("callback outcomes", () => {
  it("parses only known outcomes from the query", () => {
    expect(parseOAuthOutcome("denied")).toBe("denied");
    expect(parseOAuthOutcome(["failed", "denied"])).toBe("failed");
    expect(parseOAuthOutcome("<script>")).toBeNull();
    expect(parseOAuthOutcome(undefined)).toBeNull();
  });

  it("has a message for every outcome but connected", () => {
    for (const outcome of oauthCallbackOutcomeSchema.options) {
      const message = oauthOutcomeMessage(outcome);
      if (outcome === "connected") {
        expect(message).toBeNull();
        continue;
      }
      expect(message, outcome).not.toBeNull();
      expect(message!.text.length).toBeGreaterThan(20);
      expect(message!.tone).toBe(
        outcome === "reauthorized" ? "notice" : "error",
      );
    }
    expect(oauthOutcomeMessage(null)).toBeNull();
  });

  it("says what happened for each refusal", () => {
    expect(oauthOutcomeMessage("denied")!.text).toContain(
      "You cancelled at Google",
    );
    expect(oauthOutcomeMessage("invalid_state")!.text).toContain("expired");
    expect(oauthOutcomeMessage("scope_missing")!.text).toContain(
      "leave all boxes ticked",
    );
    expect(oauthOutcomeMessage("account_mismatch")!.text).toContain(
      "Use a different Google account",
    );
    expect(oauthOutcomeMessage("forbidden")!.text).toContain(
      "different netrics user",
    );
    expect(oauthOutcomeMessage("failed")!.text).toContain("nothing was stored");
  });
});

describe("providers", () => {
  it("names providers", () => {
    expect(providerName("google")).toBe("Google");
    expect(providerName("fixture")).toBe("Fixture");
  });

  it("finds the OAuth provider of a connector", () => {
    expect(
      oauthProviderOf({
        authStrategies: [
          { strategy: "oauth2", provider: "google", scopes: ["s"] },
        ],
      }),
    ).toBe("google");
    expect(oauthProviderOf({ authStrategies: [{ strategy: "token" }] })).toBe(
      null,
    );
  });

  it("explains unavailable connectors, with the guide for Google", () => {
    const google = unavailableCopy({
      reason: "oauth_provider_not_configured",
      provider: "google",
    });
    expect(google.detail).toContain("NETRICS_OAUTH_GOOGLE_CLIENT_ID");
    expect(google.guideUrl).toBe(GOOGLE_OAUTH_SETUP_GUIDE);
    expect(
      unavailableCopy({
        reason: "oauth_provider_unsupported",
        provider: "acme",
      }).guideUrl,
    ).toBeNull();
  });
});

describe("reconnect and disconnect copy", () => {
  it("tells expiry and revocation apart from a missing permission", () => {
    expect(reauthorizationCopy("invalid_grant").detail).toContain("7 days");
    expect(reauthorizationCopy(null).title).toContain("stopped working");
    expect(reauthorizationCopy("scope_missing").title).toContain(
      "one more Google permission",
    );
  });

  it("reports what the disconnect did at the provider", () => {
    const base: Omit<ConnectionRevocation, "status"> = {
      provider: "google",
      accountPermissionsUrl: "https://myaccount.google.com/permissions",
    };
    expect(revocationMessage({ ...base, status: "revoked" })).toEqual({
      tone: "notice",
      text: "Disconnected. netrics no longer has access to your Google account.",
    });
    expect(revocationMessage({ ...base, status: "kept" }).text).toContain(
      "stays listed in your Google account while other netrics connections use it",
    );
    expect(revocationMessage({ ...base, status: "failed" }).tone).toBe("error");
  });
});

describe("Search Console settings", () => {
  it("orders breakdown dimensions like the connector's enum", () => {
    expect(toDimensionsValue([])).toBe("none");
    expect(toDimensionsValue(["device", "query"])).toBe("query,device");
    expect(toDimensionsValue(["page"])).toBe("page");
    expect(fromDimensionsValue("query,device")).toEqual(["query", "device"]);
    expect(fromDimensionsValue("none")).toEqual([]);
    expect(fromDimensionsValue("bogus,page")).toEqual(["page"]);
    expect(fromDimensionsValue(undefined)).toEqual([]);
  });

  it("accepts 1 to 5,000 rows per day", () => {
    expect(parseRowLimit("1000")).toBe(1000);
    expect(parseRowLimit(" 5000 ")).toBe(5000);
    expect(parseRowLimit("1")).toBe(1);
    for (const bad of ["0", "5001", "12.5", "-3", "", "1e3"]) {
      expect(parseRowLimit(bad), bad).toBeNull();
    }
  });

  it("labels domain and URL-prefix properties and permissions", () => {
    expect(
      propertyView({
        id: "sc-domain:example.com",
        name: "example.com",
        kind: "domain_property",
        metadata: { permissionLevel: "siteOwner" },
      }),
    ).toEqual({
      siteUrl: "sc-domain:example.com",
      name: "example.com",
      kind: "Domain property",
      permission: "Owner",
    });
    expect(
      propertyView({
        id: "https://example.org/blog/",
        name: "https://example.org/blog/",
        kind: "url_prefix_property",
        metadata: { permissionLevel: "siteRestrictedUser" },
      }),
    ).toMatchObject({
      kind: "URL-prefix property",
      permission: "Restricted user",
    });
    expect(
      propertyView({
        id: "https://x.test/",
        name: "x",
        kind: "url_prefix_property",
      }).permission,
    ).toBeNull();
  });
});

describe("disconnect outcome on the workspace page", () => {
  it("round-trips through the query without taking a URL from it", () => {
    const query = Object.fromEntries(
      new URLSearchParams(
        disconnectQuery({
          provider: "google",
          status: "kept",
          accountPermissionsUrl: "https://evil.example/",
        }),
      ),
    );
    expect(query).toEqual({ disconnected: "kept", provider: "google" });
    expect(parseDisconnected(query)).toEqual({
      provider: "google",
      status: "kept",
      accountPermissionsUrl: "https://myaccount.google.com/permissions",
    });
  });

  it("ignores anything else", () => {
    expect(parseDisconnected({})).toBeNull();
    expect(
      parseDisconnected({ disconnected: "gone", provider: "google" }),
    ).toBeNull();
    expect(
      parseDisconnected({ disconnected: "revoked", provider: "<b>" }),
    ).toBeNull();
    expect(
      parseDisconnected({ disconnected: "failed", provider: "acme" })
        ?.accountPermissionsUrl,
    ).toBeNull();
  });
});
