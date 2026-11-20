import type {
  ConnectorFetchInit,
  ConnectorResponse,
} from "@netrics/connector-sdk";
import type { CustomApiAuth } from "@netrics/connector-sdk/custom-api";
import { describe, expect, it } from "vitest";

import {
  buildAuthorizationUrl,
  exchangeCode,
  pkceChallenge,
} from "./client.js";
import { googleProvider } from "./providers/google.js";
import {
  customOAuthProvider,
  generateCustomAccountSub,
  CUSTOM_OAUTH_PROVIDER_ID,
} from "./providers/custom.js";

// The custom OAuth provider (#805): built from a definition's auth block and
// the envelope's client credentials, no OpenID, PKCE unless turned off.

const WEB_ORIGIN = "https://app.example.test";
const CLIENT = { clientId: "client id", clientSecret: "secret:with&chars" };

function codeAuth(
  extra: Partial<
    Extract<CustomApiAuth, { type: "oauth_authorization_code" }>
  > = {},
): CustomApiAuth {
  return {
    type: "oauth_authorization_code",
    authorizeUrl: "https://login.example.test/authorize?tenant=t1",
    tokenUrl: "https://tokens.example.test/token",
    revokeUrl: "https://revoke.example.test/revoke",
    scopes: ["read", "offline_access"],
    pkce: true,
    clientAuth: "body",
    authorizeParams: { audience: "api", prompt: "consent" },
    ...extra,
  };
}

const request = {
  state: "state-1",
  nonce: "nonce-1",
  codeVerifier: "v".repeat(43),
  scopes: ["read", "offline_access"],
};

function capture() {
  const calls: Array<{ url: string; init: ConnectorFetchInit }> = [];
  const http = async (url: string, init: ConnectorFetchInit) => {
    calls.push({ url, init });
    return {
      status: 200,
      headers: {},
      text: () => "",
      json: () => ({ access_token: "a", token_type: "bearer" }),
    } as unknown as ConnectorResponse;
  };
  return { calls, http };
}

describe("the custom OAuth provider", () => {
  it("builds the authorization URL with PKCE, the definition's params and no nonce", () => {
    const provider = customOAuthProvider(
      { name: "Shop", auth: codeAuth() },
      CLIENT,
      WEB_ORIGIN,
    );
    expect(provider.definition).toMatchObject({
      id: CUSTOM_OAUTH_PROVIDER_ID,
      name: "Shop",
      pkce: "S256",
      openIdConnect: null,
      identityScopes: [],
      serverDomains: ["tokens.example.test", "revoke.example.test"],
      accountPermissionsUrl: "https://login.example.test",
    });
    expect(provider.redirectUri).toBe(`${WEB_ORIGIN}/oauth/custom/callback`);
    expect(provider.grant).toBe("authorization_code");
    const url = new URL(buildAuthorizationUrl(provider, request));
    expect(url.origin + url.pathname).toBe(
      "https://login.example.test/authorize",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      tenant: "t1",
      response_type: "code",
      client_id: CLIENT.clientId,
      redirect_uri: `${WEB_ORIGIN}/oauth/custom/callback`,
      scope: "read offline_access",
      state: "state-1",
      code_challenge: pkceChallenge(request.codeVerifier),
      code_challenge_method: "S256",
      audience: "api",
      prompt: "consent",
    });
  });

  it("omits scope when the definition has none", () => {
    const provider = customOAuthProvider(
      { auth: codeAuth({ scopes: [], pkce: false, authorizeParams: {} }) },
      CLIENT,
      WEB_ORIGIN,
    );
    expect(provider.definition.name).toBe("Custom API");
    const url = new URL(
      buildAuthorizationUrl(provider, { ...request, scopes: [] }),
    );
    expect(url.searchParams.has("scope")).toBe(false);
    expect(url.searchParams.has("code_challenge")).toBe(false);
    expect(url.searchParams.has("nonce")).toBe(false);
  });

  it("keeps the nonce and PKCE for Google", () => {
    const url = new URL(
      buildAuthorizationUrl(
        {
          definition: googleProvider,
          clientId: "g",
          clientSecret: CLIENT.clientSecret as never,
          redirectUri: `${WEB_ORIGIN}/oauth/google/callback`,
        },
        request,
      ),
    );
    expect(url.searchParams.get("nonce")).toBe("nonce-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("sends client credentials as basic auth when asked", async () => {
    const provider = customOAuthProvider(
      { auth: codeAuth({ clientAuth: "basic" }) },
      CLIENT,
      WEB_ORIGIN,
    );
    const { calls, http } = capture();
    await exchangeCode(provider, http, {
      code: "c1",
      codeVerifier: request.codeVerifier,
    });
    const init = calls[0]!.init;
    const body = new URLSearchParams(init.body as string);
    expect(body.has("client_id")).toBe(false);
    expect(body.has("client_secret")).toBe(false);
    expect(body.get("code_verifier")).toBe(request.codeVerifier);
    const header = (init.headers as Record<string, string>).authorization!;
    expect(Buffer.from(header.slice(6), "base64").toString()).toBe(
      "client+id:secret%3Awith%26chars",
    );
  });

  it("exchanges a code without a verifier when PKCE is off", async () => {
    const provider = customOAuthProvider(
      { auth: codeAuth({ pkce: false }) },
      CLIENT,
      WEB_ORIGIN,
    );
    const { calls, http } = capture();
    await exchangeCode(provider, http, { code: "c1", codeVerifier: "unused" });
    const body = new URLSearchParams(calls[0]!.init.body as string);
    expect(body.has("code_verifier")).toBe(false);
    expect(body.get("client_id")).toBe(CLIENT.clientId);
    expect(body.get("client_secret")).toBe(CLIENT.clientSecret);
    expect(calls[0]!.url).toBe("https://tokens.example.test/token");
  });

  it("describes a client-credentials grant and refuses other auth types", () => {
    const provider = customOAuthProvider(
      {
        auth: {
          type: "oauth_client_credentials",
          tokenUrl: "https://tokens.example.test/token",
          scopes: [],
          clientAuth: "body",
        },
      },
      CLIENT,
      WEB_ORIGIN,
    );
    expect(provider.grant).toBe("client_credentials");
    expect(provider.definition.revocationEndpoint).toBeNull();
    expect(provider.definition.serverDomains).toEqual(["tokens.example.test"]);
    expect(() =>
      customOAuthProvider({ auth: { type: "none" } }, CLIENT, WEB_ORIGIN),
    ).toThrow();
    expect(generateCustomAccountSub()).toMatch(/^custom:[0-9a-f-]{36}$/);
  });
});
