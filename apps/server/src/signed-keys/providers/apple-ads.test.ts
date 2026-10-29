import {
  APPLE_ADS_RATE_LIMITED_MESSAGE,
  appleAdsManifest,
} from "@netrics/connectors";
import { describe, expect, it } from "vitest";

import { SignedKeyProviders } from "../registry.js";
import {
  apiUserCredentials,
  createFakeAppleAdsServer,
  fakeApiUserKey,
  type FakeAdAccount,
  type FakeApiUserKey,
} from "../test-apple-ads.js";
import { decodeJwt, p256KeyPair } from "../test-keys.js";
import { SIGNED_KEY_PROVIDER_DEFINITIONS } from "./index.js";
import {
  APPLE_ADS_AUDIENCE,
  INVALID_CLIENT_MESSAGE,
  appleAdsProvider,
} from "./apple-ads.js";

// The Apple Ads provider (#373): its fields, the token exchange at
// appleid.apple.com with a signed client secret, and the access probe on
// /v1/acls, before anything is stored.

const APP_STORE: FakeAdAccount = {
  id: "4100000001",
  name: "Example Apps US",
  orgId: "4000000001",
  currency: "USD",
  timezone: "America/Los_Angeles",
  productFeatures: ["APPSTORE_APP_MANUAL"],
  campaigns: [],
};
const MAPS: FakeAdAccount = {
  ...APP_STORE,
  id: "4100000003",
  name: "Example Cafés on Maps",
  productFeatures: ["BUSINESS_BRAND_MANUAL"],
};

function setup(users: FakeApiUserKey[]) {
  const server = createFakeAppleAdsServer([APP_STORE, MAPS], users);
  const hosts: string[] = [];
  const providers = new SignedKeyProviders({
    definitions: new Map([[appleAdsProvider.id, appleAdsProvider]]),
    http: () => (url, init) => {
      hosts.push(new URL(url).host);
      return server.fetch(url, init);
    },
  });
  const validate = (
    user: FakeApiUserKey,
    config: Record<string, unknown> = {},
    credentials: Record<string, unknown> = apiUserCredentials(user),
  ) => providers.validate(appleAdsProvider, credentials, config);
  return { server, hosts, validate };
}

const messageOf = (result: { ok: boolean; message?: string }) =>
  result.ok ? "" : (result.message ?? "");

describe("Apple Ads provider", () => {
  it("is registered for the connector's signed-key strategy", () => {
    expect(SIGNED_KEY_PROVIDER_DEFINITIONS.get("apple-ads")).toBe(
      appleAdsProvider,
    );
    expect(appleAdsManifest.authStrategies).toEqual([
      { strategy: "signed-key", provider: appleAdsProvider.id },
    ]);
    expect(appleAdsProvider.serverDomains).toEqual([
      "appleid.apple.com",
      "api.ads.apple.com",
    ]);
  });

  it("exchanges a client secret signed as Apple asks, then reads /v1/acls and the account", async () => {
    const user = fakeApiUserKey(p256KeyPair(), {
      [APP_STORE.id]: ["API Account Read Only"],
    });
    const { server, hosts, validate } = setup([user]);
    const result = await validate(user, { adAccountId: APP_STORE.id });
    expect(result.ok).toBe(true);
    expect(server.exchanges).toBe(1);
    const { header, claims, verifies } = decodeJwt(
      server.clientSecrets[0]!,
      user.key.publicKey,
    );
    expect(verifies).toBe(true);
    expect(header).toMatchObject({ alg: "ES256", kid: user.keyId });
    expect(claims).toMatchObject({
      iss: user.teamId,
      sub: user.clientId,
      aud: APPLE_ADS_AUDIENCE,
    });
    const exp = claims.exp as number;
    const iat = claims.iat as number;
    expect(exp - iat).toBe(11 * 60);
    expect(server.calls.map((call) => [call.path, call.context])).toEqual([
      ["/v1/acls", undefined],
      [`/v1/ad-accounts/${APP_STORE.id}`, `adAccountId=${APP_STORE.id}`],
    ]);
    expect(new Set(hosts)).toEqual(
      new Set(["appleid.apple.com", "api.ads.apple.com"]),
    );
  });

  it("answers invalid_client with the IDs-do-not-match message", async () => {
    const user = fakeApiUserKey(p256KeyPair(), {
      [APP_STORE.id]: ["API Account Read Only"],
    });
    const { validate } = setup([user]);
    const other = { ...user, key: p256KeyPair() };
    const result = await validate(other);
    expect(messageOf(result)).toBe(INVALID_CLIENT_MESSAGE);
    expect(INVALID_CLIENT_MESSAGE).toContain(
      "do not match the public key you saved in Apple Ads",
    );
  });

  it("refuses an API user who reads only Apple Maps accounts", async () => {
    const user = fakeApiUserKey(p256KeyPair(), {
      [MAPS.id]: ["API Account Read Only"],
    });
    const { validate } = setup([user]);
    expect(messageOf(await validate(user))).toContain(
      "Apple Maps ads are not supported yet",
    );
  });

  it("refuses a non-API role, and an ad account the user cannot read", async () => {
    const user = fakeApiUserKey(p256KeyPair(), {
      [APP_STORE.id]: ["Read Only"],
    });
    const { validate } = setup([user]);
    expect(messageOf(await validate(user))).toContain("needs an API role");
    const reader = fakeApiUserKey(p256KeyPair(), {
      [MAPS.id]: ["API Account Read Only"],
    });
    const second = setup([reader]);
    expect(
      messageOf(await second.validate(reader, { adAccountId: APP_STORE.id })),
    ).toContain(`no longer has access to ad account ${APP_STORE.id}`);
  });

  it("answers a rate limit with its own message", async () => {
    const user = fakeApiUserKey(p256KeyPair(), {
      [APP_STORE.id]: ["API Account Read Only"],
    });
    const { server, validate } = setup([user]);
    const fetch = server.fetch;
    server.fetch = async (url, init) =>
      url.startsWith("https://api.ads.apple.com/")
        ? { ...(await fetch(url, init)), status: 429 }
        : fetch(url, init);
    expect(messageOf(await validate(user))).toBe(
      APPLE_ADS_RATE_LIMITED_MESSAGE,
    );
  });

  it("checks the format of the IDs before any call", async () => {
    const user = fakeApiUserKey(p256KeyPair(), {});
    const { server, validate } = setup([user]);
    const credentials = apiUserCredentials(user);
    expect(
      messageOf(await validate(user, {}, { ...credentials, clientId: "abc" })),
    ).toContain("SEARCHADS.");
    expect(
      messageOf(
        await validate(user, {}, { ...credentials, keyId: "not a key id" }),
      ),
    ).toContain("Key ID");
    expect(server.exchanges).toBe(0);
    expect(server.clientSecrets).toHaveLength(0);
  });

  it("accepts the ID shapes of Apple's own examples", () => {
    const [clientId, teamId, keyId] = appleAdsProvider.fields;
    expect(
      clientId!.validate!("SEARCHADS.aeb3ef5f-0c5a-4f2a-99c8-fca83f25a9"),
    ).toBeNull();
    expect(
      teamId!.validate!("SEARCHADS.hgw3ef3p-0w7a-8a2n-77c8-scv83f25a7"),
    ).toBeNull();
    expect(keyId!.validate!("a273d0d3-4d9e-458c-a173-0db8619ca7d7")).toBeNull();
  });
});
