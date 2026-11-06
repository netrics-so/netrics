import type { ConnectorManifest } from "@netrics/connector-sdk";
import { demoManifest } from "@netrics/connectors";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../env.js";
import { SignedKeyProviders } from "../signed-keys/registry.js";
import {
  createOAuthProviders,
  describeOAuthProviders,
  oauthRedirectUri,
} from "./config.js";
import {
  OAUTH_PROVIDER_DEFINITIONS,
  googleProvider,
} from "./providers/index.js";

const CLIENT_SECRET = "GOCSPX-never-log-me";

function configured(webOrigin = "https://app.example.com") {
  return createOAuthProviders(
    loadConfig({
      WEB_ORIGIN: webOrigin,
      NETRICS_OAUTH_GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
      NETRICS_OAUTH_GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    }),
  );
}

function manifestWith(
  authStrategies: ConnectorManifest["authStrategies"],
): ConnectorManifest {
  return { ...demoManifest, authStrategies };
}

const googleOAuth = {
  strategy: "oauth2" as const,
  provider: "google",
  scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
};

describe("provider definitions", () => {
  it("defines Google per ADR 0012", () => {
    expect(OAUTH_PROVIDER_DEFINITIONS.get("google")).toBe(googleProvider);
    expect(googleProvider).toMatchObject({
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      revocationEndpoint: "https://oauth2.googleapis.com/revoke",
      pkce: "S256",
      identityScopes: [
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
      authorizationParams: {
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
      },
      serverDomains: ["oauth2.googleapis.com"],
    });
    expect(googleProvider.openIdConnect.issuers).toContain(
      "https://accounts.google.com",
    );
  });

  it("keeps every server-side endpoint inside the provider's egress domains", () => {
    for (const provider of OAUTH_PROVIDER_DEFINITIONS.values()) {
      for (const endpoint of [
        provider.tokenEndpoint,
        provider.revocationEndpoint,
      ]) {
        if (endpoint === null) {
          continue;
        }
        const url = new URL(endpoint);
        expect(url.protocol).toBe("https:");
        expect(provider.serverDomains).toContain(url.hostname);
      }
    }
  });
});

describe("instance configuration", () => {
  it("derives the redirect URI from the web origin", () => {
    expect(oauthRedirectUri("https://app.example.com", "google")).toBe(
      "https://app.example.com/oauth/google/callback",
    );
    // Only the origin counts, never a path or query.
    expect(oauthRedirectUri("https://app.example.com/x?y=1", "google")).toBe(
      "https://app.example.com/oauth/google/callback",
    );
    expect(configured().get("google")?.redirectUri).toBe(
      "https://app.example.com/oauth/google/callback",
    );
  });

  it("has no providers without configuration", () => {
    const providers = createOAuthProviders(loadConfig({}));
    expect(providers.list()).toEqual([]);
    expect(providers.get("google")).toBeUndefined();
    expect(providers.unavailableReason("google")).toBe(
      "oauth_provider_not_configured",
    );
    expect(providers.unavailableReason("facebook")).toBe(
      "oauth_provider_unsupported",
    );
  });

  it("configures Google with the client from the environment", () => {
    const google = configured().get("google");
    expect(google?.definition).toBe(googleProvider);
    expect(google?.clientId).toBe("client-id.apps.googleusercontent.com");
    expect(google?.clientSecret.reveal()).toBe(CLIENT_SECRET);
    expect(configured().unavailableReason("google")).toBeNull();
  });

  it("logs providers and redirect URIs, never the secret", () => {
    const description = describeOAuthProviders(configured());
    expect(description).toEqual({
      oauthProviders: [
        {
          provider: "google",
          redirectUri: "https://app.example.com/oauth/google/callback",
        },
      ],
    });
    expect(JSON.stringify(description)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(configured().list())).not.toContain(CLIENT_SECRET);
  });
});

describe("connector availability", () => {
  const unconfigured = createOAuthProviders(loadConfig({}));
  const signedKeys = new SignedKeyProviders();

  it("always allows token and none strategies", () => {
    for (const providers of [unconfigured, configured()]) {
      expect(
        providers.connectorAvailability(
          manifestWith([{ strategy: "none" }]),
          signedKeys,
        ),
      ).toEqual({ available: true, unavailable: null });
    }
  });

  it("needs the provider of an OAuth-only connector to be configured", () => {
    const manifest = manifestWith([googleOAuth]);
    expect(unconfigured.connectorAvailability(manifest, signedKeys)).toEqual({
      available: false,
      unavailable: {
        reason: "oauth_provider_not_configured",
        provider: "google",
      },
    });
    expect(configured().connectorAvailability(manifest, signedKeys)).toEqual({
      available: true,
      unavailable: null,
    });
    expect(
      configured().connectorAvailability(
        manifestWith([{ ...googleOAuth, provider: "facebook" }]),
        signedKeys,
      ),
    ).toEqual({
      available: false,
      unavailable: {
        reason: "oauth_provider_unsupported",
        provider: "facebook",
      },
    });
  });

  it("offers a signed-key connector exactly when this server has its provider", () => {
    // ADR 0014: the host signs tokens. A provider it does not know must not
    // get the uploaded key handed to the connector instead (#170 replaced
    // the "never available" guard of #180 with the registry lookup).
    const appStoreKey = {
      strategy: "signed-key" as const,
      provider: "app-store-connect",
    };
    expect(
      unconfigured.connectorAvailability(
        manifestWith([appStoreKey]),
        signedKeys,
      ),
    ).toEqual({ available: true, unavailable: null });
    expect(
      unconfigured.connectorAvailability(manifestWith([appStoreKey]), {
        has: () => false,
      }),
    ).toEqual({
      available: false,
      unavailable: {
        reason: "signed_key_provider_unsupported",
        provider: "app-store-connect",
      },
    });
    expect(
      configured().connectorAvailability(
        manifestWith([{ ...appStoreKey, provider: "acme-ads" }]),
        signedKeys,
      ),
    ).toEqual({
      available: false,
      unavailable: {
        reason: "signed_key_provider_unsupported",
        provider: "acme-ads",
      },
    });
    expect(
      configured().connectorAvailability(
        manifestWith([{ ...appStoreKey, provider: "acme-ads" }, googleOAuth]),
        signedKeys,
      ),
    ).toEqual({ available: true, unavailable: null });
  });

  it("keeps a connector with a token alternative available", () => {
    expect(
      unconfigured.connectorAvailability(
        manifestWith([googleOAuth, { strategy: "token" }]),
        signedKeys,
      ),
    ).toEqual({ available: true, unavailable: null });
  });
});
