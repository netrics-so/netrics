import { inspect } from "node:util";

import type { ConnectorManifest } from "@netrics/connector-sdk";
import { demoManifest } from "@netrics/connectors";
import { describe, expect, it } from "vitest";

import {
  appStoreConnectProvider,
  type SignedKeyProbe,
  type SignedKeyProviderDefinition,
} from "./providers/index.js";
import { SignedKeyProviders, type SignedKey } from "./registry.js";
import {
  decodeJwt,
  p256KeyPair,
  pemBody,
  TEST_ISSUER_ID,
  TEST_KEY_ID,
} from "./test-keys.js";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const NOW_SECONDS = NOW / 1000;

function providers(
  definition: SignedKeyProviderDefinition = appStoreConnectProvider,
  http: ConstructorParameters<typeof SignedKeyProviders>[0] = {},
) {
  return new SignedKeyProviders({
    definitions: new Map([[definition.id, definition]]),
    now: () => NOW,
    ...http,
  });
}

function credentials(privateKey = p256KeyPair().privateKeyPem) {
  return { issuerId: TEST_ISSUER_ID, keyId: TEST_KEY_ID, privateKey };
}

function parsed(
  registry: SignedKeyProviders,
  input: Record<string, unknown>,
): SignedKey {
  const result = registry.parse(appStoreConnectProvider, input);
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.value;
}

function manifestWith(
  authStrategies: ConnectorManifest["authStrategies"],
): ConnectorManifest {
  return { ...demoManifest, sdkVersion: "^0.2.2", authStrategies };
}

describe("App Store Connect credentials", () => {
  it("parses valid fields and stores them normalized", () => {
    const { privateKeyPem } = p256KeyPair();
    const key = parsed(providers(), {
      issuerId: `  ${TEST_ISSUER_ID}\n`,
      keyId: TEST_KEY_ID,
      privateKey: privateKeyPem.replace(/\n/g, "\r\n"),
    });
    expect(key.stored()).toEqual({
      issuerId: TEST_ISSUER_ID,
      keyId: TEST_KEY_ID,
      privateKey: privateKeyPem,
    });
    expect(key.publicFields).toEqual({
      issuerId: TEST_ISSUER_ID,
      keyId: TEST_KEY_ID,
    });
  });

  it("refuses malformed fields with field-specific messages, before any key parsing", () => {
    const registry = providers();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [
        { ...credentials(), issuerId: "not-a-uuid" },
        /^Issuer ID must be a UUID/,
      ],
      [
        { ...credentials(), keyId: "2x9r4hxf34" },
        /^Key ID must be 10 uppercase/,
      ],
      [
        { ...credentials(), keyId: "2X9R4HXF3" },
        /^Key ID must be 10 uppercase/,
      ],
      [{ ...credentials(), issuerId: undefined }, /^Issuer ID is required\.$/],
      [{ ...credentials(), keyId: 1234567890 }, /^Key ID is required\.$/],
      [{ ...credentials(), privateKey: "   " }, /^Private key is required\.$/],
      [
        { ...credentials(), privateKey: "x".repeat(4097) },
        /^Private key is larger than 4 KiB/,
      ],
      [
        { ...credentials(), vendorNumber: "85012345" },
        /remove the unknown field "vendorNumber"/,
      ],
      [
        { ...credentials(), privateKey: "garbage" },
        /^Private key: .*BEGIN PRIVATE KEY/,
      ],
    ];
    for (const [input, message] of cases) {
      const result = registry.parse(appStoreConnectProvider, input);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.message).toMatch(message);
    }
  });

  it("never shows key material when serialized or inspected", () => {
    const input = credentials();
    const key = parsed(providers(), input);
    const body = pemBody(input.privateKey);
    expect(JSON.stringify({ key })).not.toContain(body.slice(0, 24));
    expect(inspect(key, { depth: 5 })).not.toContain(body.slice(0, 24));
    expect(inspect(key)).toBe("SignedKey(app-store-connect)");
  });
});

describe("token signing", () => {
  it("signs an ES256 JWT for App Store Connect that verifies with the public key", () => {
    const { privateKeyPem, publicKey } = p256KeyPair();
    const key = parsed(providers(), credentials(privateKeyPem));
    const decoded = decodeJwt(key.mintToken(), publicKey);
    expect(decoded.verifies).toBe(true);
    expect(decoded.header).toEqual({
      alg: "ES256",
      kid: TEST_KEY_ID,
      typ: "JWT",
    });
    expect(decoded.claims).toEqual({
      iss: TEST_ISSUER_ID,
      aud: "appstoreconnect-v1",
      iat: NOW_SECONDS - 60,
      exp: NOW_SECONDS + 9 * 60,
    });
    const claims = decoded.claims as { iat: number; exp: number };
    // Apple refuses tokens living 20 minutes or more; exp is at most 10
    // minutes ahead.
    expect(claims.exp - claims.iat).toBeLessThan(20 * 60);
    expect(claims.exp - NOW_SECONDS).toBeLessThanOrEqual(10 * 60);
    // No scope claim (ADR 0014), no subject (team keys only).
    expect(Object.keys(decoded.claims).sort()).toEqual([
      "aud",
      "exp",
      "iat",
      "iss",
    ]);
  });

  it("signs a fresh token per call", () => {
    let now = NOW;
    const registry = new SignedKeyProviders({ now: () => now });
    const key = parsed(registry, credentials());
    const first = key.mintToken();
    now += 1000;
    const second = key.mintToken();
    expect(second).not.toBe(first);
  });
});

describe("providerFor", () => {
  const appStoreKey = {
    strategy: "signed-key" as const,
    provider: "app-store-connect",
  };
  const registry = new SignedKeyProviders();

  it("uses the signed key for a signed-key-only connector", () => {
    expect(
      registry.providerFor(manifestWith([appStoreKey]), { token: "x" }),
    ).toBe(appStoreConnectProvider);
    expect(registry.providerFor(manifestWith([appStoreKey]), undefined)).toBe(
      appStoreConnectProvider,
    );
  });

  it("with a token alternative, uses the key only when its fields are sent", () => {
    const manifest = manifestWith([appStoreKey, { strategy: "token" }]);
    expect(registry.providerFor(manifest, { token: "x" })).toBeUndefined();
    expect(registry.providerFor(manifest, { privateKey: "…" })).toBe(
      appStoreConnectProvider,
    );
  });

  it("ignores providers this server does not have, and other strategies", () => {
    expect(
      registry.providerFor(
        manifestWith([{ ...appStoreKey, provider: "acme-ads" }]),
        {},
      ),
    ).toBeUndefined();
    expect(
      registry.providerFor(manifestWith([{ strategy: "token" }]), {
        privateKey: "x",
      }),
    ).toBeUndefined();
  });
});

describe("validation probes", () => {
  function withProbes(probes: SignedKeyProbe[]): SignedKeyProviderDefinition {
    return { ...appStoreConnectProvider, probes };
  }

  it("runs every probe with a fresh token, the config and the public fields, in order", async () => {
    const { privateKeyPem, publicKey } = p256KeyPair();
    const seen: Array<{ name: string; claims: unknown; config: unknown }> = [];
    const probe = (name: string): SignedKeyProbe => ({
      name,
      async run(context) {
        const token = context.accessToken();
        const response = await context.fetch(
          "https://api.appstoreconnect.apple.com/v1/apps?limit=1",
          { headers: { authorization: `Bearer ${token}` } },
        );
        expect(response.status).toBe(200);
        expect(context.fields).toEqual({
          issuerId: TEST_ISSUER_ID,
          keyId: TEST_KEY_ID,
        });
        seen.push({
          name,
          claims: decodeJwt(token, publicKey).claims,
          config: context.config,
        });
        return { ok: true };
      },
    });
    const requests: Array<{ url: string; authorization: string | undefined }> =
      [];
    const registry = providers(withProbes([probe("apps"), probe("sales")]), {
      http: (provider) => {
        expect(provider.id).toBe("app-store-connect");
        return async (url, init) => {
          requests.push({ url, authorization: init?.headers?.authorization });
          return {
            status: 200,
            headers: {},
            text: () => "{}",
            json: () => ({}),
            bytes: () => new Uint8Array(),
          };
        };
      },
    });
    const result = await registry.validate(
      withProbes([probe("apps"), probe("sales")]),
      credentials(privateKeyPem),
      { vendorNumber: "85012345" },
    );
    expect(result.ok).toBe(true);
    expect(seen.map((entry) => entry.name)).toEqual(["apps", "sales"]);
    expect(seen[0]!.config).toEqual({ vendorNumber: "85012345" });
    expect(seen[0]!.claims).toMatchObject({ aud: "appstoreconnect-v1" });
    expect(requests).toHaveLength(2);
    expect(requests[0]!.authorization).toMatch(/^Bearer ey/);
  });

  it("answers with the first failing probe, redacting tokens and key material", async () => {
    const input = credentials();
    let ran = 0;
    const definition = withProbes([
      {
        name: "apps",
        async run(context) {
          ran += 1;
          const token = context.accessToken();
          return {
            ok: false,
            message: `issuer ID, key ID and private key do not belong together (token ${token}, key ${input.privateKey})`,
          };
        },
      },
      {
        name: "never",
        async run() {
          ran += 1;
          return { ok: true };
        },
      },
    ]);
    const result = await providers(definition).validate(definition, input, {});
    expect(ran).toBe(1);
    expect(result.ok).toBe(false);
    const message = !result.ok ? result.message : "";
    expect(message).toMatch(/^issuer ID, key ID and private key do not belong/);
    expect(message).not.toMatch(/ey[A-Za-z0-9_-]{10,}\./);
    expect(message).not.toContain(pemBody(input.privateKey).slice(0, 24));
    expect(message).toContain("[redacted]");
  });

  it("turns a thrown probe into a generic message without the error's text", async () => {
    const definition = withProbes([
      {
        name: "apps",
        async run(context) {
          throw new Error(`socket hang up with ${context.accessToken()}`);
        },
      },
    ]);
    const result = await providers(definition).validate(
      definition,
      credentials(),
      {},
    );
    expect(result).toEqual({
      ok: false,
      message:
        "App Store Connect could not be reached to check the key. Try again in a few minutes.",
    });
  });

  it("does not probe a key that fails the field checks", async () => {
    let ran = 0;
    const definition = withProbes([
      {
        name: "apps",
        async run() {
          ran += 1;
          return { ok: true };
        },
      },
    ]);
    const result = await providers(definition).validate(
      definition,
      { ...credentials(), keyId: "short" },
      {},
    );
    expect(result.ok).toBe(false);
    expect(ran).toBe(0);
  });

  it("limits probe egress to the provider's server domains by default", async () => {
    const definition = withProbes([
      {
        name: "elsewhere",
        async run(context) {
          await context.fetch("https://example.com/");
          return { ok: true };
        },
      },
    ]);
    const result = await new SignedKeyProviders({
      definitions: new Map([[definition.id, definition]]),
    }).validate(definition, credentials(), {});
    // The guarded fetch refuses the host before any connection is made.
    expect(result.ok).toBe(false);
  });
});

describe("an additional key (#190, the App Store reviews key)", () => {
  const REVIEWS_KEY_ID = "CS5UPP0RT1";

  it("parses a reviews key next to the main key and signs a token for each", () => {
    const main = p256KeyPair();
    const support = p256KeyPair();
    const key = parsed(providers(), {
      ...credentials(main.privateKeyPem),
      reviews: { keyId: REVIEWS_KEY_ID, privateKey: support.privateKeyPem },
    });
    expect(key.additionalIds).toEqual(["reviews"]);
    expect(key.stored()).toEqual({
      ...credentials(main.privateKeyPem),
      reviews: { keyId: REVIEWS_KEY_ID, privateKey: support.privateKeyPem },
    });
    const tokens = key.mintTokens();
    expect(Object.keys(tokens).sort()).toEqual([
      "accessToken",
      "reviewsAccessToken",
    ]);
    const mainToken = decodeJwt(tokens.accessToken, main.publicKey);
    const reviewsToken = decodeJwt(
      tokens.reviewsAccessToken!,
      support.publicKey,
    );
    expect(mainToken.verifies).toBe(true);
    expect(mainToken.header.kid).toBe(TEST_KEY_ID);
    expect(reviewsToken.verifies).toBe(true);
    expect(reviewsToken.header.kid).toBe(REVIEWS_KEY_ID);
    // The issuer ID is team-wide: the reviews key shares it.
    expect(reviewsToken.claims).toMatchObject({
      iss: TEST_ISSUER_ID,
      aud: "appstoreconnect-v1",
      iat: NOW_SECONDS - 60,
      exp: NOW_SECONDS + 540,
    });
    expect(inspect(key)).not.toContain(pemBody(support.privateKeyPem));
    expect(JSON.stringify(key)).toBe('"[signed key]"');
  });

  it("without a reviews key, hands the connector the main token only", () => {
    const key = parsed(providers(), credentials());
    expect(Object.keys(key.mintTokens())).toEqual(["accessToken"]);
    expect(
      parsed(providers(), { ...credentials(), reviews: null }).additionalIds,
    ).toEqual([]);
  });

  it("checks the reviews key's fields like the main key's", () => {
    const registry = providers();
    const check = (reviews: unknown) => {
      const result = registry.parse(appStoreConnectProvider, {
        ...credentials(),
        reviews,
      });
      return result.ok ? "ok" : result.message;
    };
    expect(
      check({ keyId: "short", privateKey: p256KeyPair().privateKeyPem }),
    ).toMatch(/^Key ID must be 10 uppercase letters/);
    expect(check({ keyId: REVIEWS_KEY_ID, privateKey: "nope" })).toMatch(
      /^Private key: /,
    );
    expect(check({ keyId: REVIEWS_KEY_ID })).toBe("Private key is required.");
    expect(check("AuthKey")).toMatch(/^The Customer Support key takes/);
    expect(
      check({
        keyId: REVIEWS_KEY_ID,
        privateKey: p256KeyPair().privateKeyPem,
        role: "ADMIN",
      }),
    ).toMatch(/remove the unknown field "role"/);
    expect(
      check({ keyId: TEST_KEY_ID, privateKey: p256KeyPair().privateKeyPem }),
    ).toMatch(/must be a separate key/);
  });

  it("runs only the reviews key's probes for it, with its own tokens", async () => {
    const seen: Array<{ name: string; token: string }> = [];
    const definition: SignedKeyProviderDefinition = {
      ...appStoreConnectProvider,
      probes: [],
      additionalKeys: [
        {
          ...appStoreConnectProvider.additionalKeys![0]!,
          probes: [
            {
              name: "reviews",
              run: async (context) => {
                seen.push({ name: "reviews", token: context.accessToken() });
                return { ok: false, message: "role missing" };
              },
            },
          ],
        },
      ],
    };
    const registry = providers(definition);
    const support = p256KeyPair();
    const result = registry.parse(definition, {
      ...credentials(),
      reviews: { keyId: REVIEWS_KEY_ID, privateKey: support.privateKeyPem },
    });
    if (!result.ok) throw new Error(result.message);
    expect(await registry.probeAdditional(result.value, "reviews", {})).toEqual(
      {
        ok: false,
        message: "role missing",
      },
    );
    expect(decodeJwt(seen[0]!.token, support.publicKey).header.kid).toBe(
      REVIEWS_KEY_ID,
    );
    // A config change re-checks the main key only.
    seen.length = 0;
    const validated = await registry.validate(
      definition,
      {
        ...credentials(),
        reviews: { keyId: REVIEWS_KEY_ID, privateKey: support.privateKeyPem },
      },
      {},
      { probeAdditional: false },
    );
    expect(validated.ok).toBe(true);
    expect(seen).toEqual([]);
  });
});
