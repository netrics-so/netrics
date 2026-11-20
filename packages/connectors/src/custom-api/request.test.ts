import type { CustomApiDefinition } from "@netrics/connector-sdk/custom-api";
import { describe, expect, it } from "vitest";

import {
  applyCustomApiAuth,
  buildRequest,
  CUSTOM_API_MESSAGES,
  CustomApiAuthError,
  CustomApiConfigError,
  CustomApiResponseError,
  customApiSecretValues,
  type CustomApiCredentials,
} from "./index.js";
import { b64, sdkFixture } from "./test-helpers.js";
import { FIXTURE_SECRETS } from "./testing/index.js";

const shop = sdkFixture("v1-shop");
const production = shop.environments[0]!;
const stream = shop.streams[0]!;
const host = "api.example.com";

function build(overrides: Partial<Parameters<typeof buildRequest>[0]> = {}) {
  return buildRequest({
    definition: shop,
    stream,
    environment: production,
    config: { account_id: "acc-1" },
    credentials: { host, token: FIXTURE_SECRETS.token },
    placeholders: { "window.start": "2024-01-01", "window.end": "2024-02-01" },
    pageParams: {},
    ...overrides,
  });
}

function withAuth(auth: CustomApiDefinition["auth"]): CustomApiDefinition {
  return { ...shop, auth };
}

const basicDef = withAuth({ type: "basic" });
const basicCreds: CustomApiCredentials = {
  host,
  username: FIXTURE_SECRETS.username,
  password: FIXTURE_SECRETS.password,
};

describe("custom API requests", () => {
  it.each([
    [
      "api_key header",
      withAuth({ type: "api_key", placement: "header", name: "X-Api-Key" }),
      { host, apiKey: FIXTURE_SECRETS.apiKey },
      { "x-api-key": FIXTURE_SECRETS.apiKey },
    ],
    [
      "bearer default",
      shop,
      { host, token: FIXTURE_SECRETS.token },
      { authorization: `Bearer ${FIXTURE_SECRETS.token}` },
    ],
    [
      "bearer custom header and prefix",
      withAuth({ type: "bearer", headerName: "X-Token", prefix: "Token" }),
      { host, token: FIXTURE_SECRETS.token },
      { "x-token": `Token ${FIXTURE_SECRETS.token}` },
    ],
    [
      "basic",
      basicDef,
      basicCreds,
      { authorization: `Basic ${b64("fx-user:fx-pass-0001")}` },
    ],
  ] as const)("applies %s", (_name, definition, credentials, expected) => {
    const built = build({ definition, credentials });
    expect(built.headers).toMatchObject({
      accept: "application/json",
      ...expected,
    });
  });

  it("puts the api key in the query and redacts it in redactedUrl", () => {
    const built = build({
      definition: withAuth({
        type: "api_key",
        placement: "query",
        name: "api_key",
      }),
      credentials: { host, apiKey: FIXTURE_SECRETS.apiKey },
    });
    expect(new URL(built.url).searchParams.get("api_key")).toBe(
      FIXTURE_SECRETS.apiKey,
    );
    expect(built.redactedUrl).not.toContain(FIXTURE_SECRETS.apiKey);
    expect(built.redactedUrl).toBe(
      "https://api.example.com/v1/accounts/acc-1/stats?from=2024-01-01&to=2024-02-01&api_key=[redacted]",
    );
    expect(JSON.stringify(built.headers)).not.toContain(FIXTURE_SECRETS.apiKey);
  });

  it("redacts the cursor value in redactedUrl", () => {
    const built = build({
      placeholders: {
        "window.start": "2024-01-01",
        "window.end": "2024-02-01",
        "page.cursor": "opaque-cursor",
      },
      pageParams: { cursor: "opaque-cursor" },
    });
    expect(built.url).toContain("cursor=opaque-cursor");
    expect(built.redactedUrl).toContain("cursor=[redacted]");
  });

  it("encodes path placeholders once and query values once", () =>
    expect(
      build({
        config: { account_id: "a b+c" },
        placeholders: { "window.start": "2024-01-01 x&y", "window.end": "e" },
      }).url,
    ).toBe(
      "https://api.example.com/v1/accounts/a%20b%2Bc/stats?from=2024-01-01+x%26y&to=e",
    ));

  it.each([".", "..", "a/b", "a\\b"])(
    "refuses the connection value %j in a path segment",
    (value) => {
      expect(() => build({ config: { account_id: value } })).toThrow(
        CustomApiConfigError,
      );
    },
  );

  it("refuses credentials bound to another host", () => {
    expect(() =>
      build({ credentials: { host: "staging.example.com", token: "t0k3n" } }),
    ).toThrow(new CustomApiAuthError(CUSTOM_API_MESSAGES.hostChanged));
  });

  it("follows a next URL on the API host only", () => {
    const next = build({
      nextUrl: "https://api.example.com/v1/accounts/acc-1/stats?page=2&sig=abc",
    });
    expect(next.url).toBe(
      "https://api.example.com/v1/accounts/acc-1/stats?page=2&sig=abc",
    );
    expect(next.redactedUrl).toBe(
      "https://api.example.com/v1/accounts/acc-1/stats?page=[redacted]&sig=[redacted]",
    );
    expect(() => build({ nextUrl: "https://evil.example.com/x" })).toThrow(
      new CustomApiResponseError(CUSTOM_API_MESSAGES.nextUrlOffHost),
    );
    expect(() => build({ nextUrl: "http://api.example.com/x" })).toThrow(
      CustomApiResponseError,
    );
  });

  it("applies auth to an image URL on the API host and refuses another host", () => {
    const request = {
      url: new URL("https://api.example.com/v1/images/1.png"),
      headers: {} as Record<string, string>,
    };
    applyCustomApiAuth(request, shop, production, {
      host,
      token: FIXTURE_SECRETS.token,
    });
    expect(request.headers.authorization).toBe(
      `Bearer ${FIXTURE_SECRETS.token}`,
    );
    const other = {
      url: new URL("https://cdn.example.com/1.png"),
      headers: {} as Record<string, string>,
    };
    expect(() =>
      applyCustomApiAuth(other, shop, production, {
        host,
        token: FIXTURE_SECRETS.token,
      }),
    ).toThrow(CustomApiConfigError);
    expect(other.headers).toEqual({});
  });

  it("renders auth headers with secret variables", () => {
    const definition: CustomApiDefinition = {
      ...shop,
      variables: [
        ...shop.variables,
        { id: "tenant_secret", label: "Tenant secret", secret: true },
      ],
      auth: {
        type: "bearer",
        headerName: "Authorization",
        prefix: "Bearer",
        headers: { "X-Tenant": "t-{{tenant_secret}}" },
      },
    };
    const credentials = {
      host,
      token: FIXTURE_SECRETS.token,
      variables: { tenant_secret: "s3cret-tenant" },
    };
    expect(build({ definition, credentials }).headers["x-tenant"]).toBe(
      "t-s3cret-tenant",
    );
    expect(customApiSecretValues(definition, credentials)).toEqual(
      expect.arrayContaining(["s3cret-tenant", "t-s3cret-tenant"]),
    );
  });

  it("lists derived secrets for redaction", () =>
    expect(customApiSecretValues(basicDef, basicCreds)).toEqual(
      expect.arrayContaining([
        b64("fx-user:fx-pass-0001"),
        `Basic ${b64("fx-user:fx-pass-0001")}`,
      ]),
    ));
});
