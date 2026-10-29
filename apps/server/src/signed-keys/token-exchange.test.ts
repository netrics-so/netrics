import { describe, expect, it } from "vitest";

import { callWithSignedKey, SignedKeyRejectedError } from "./connector-auth.js";
import { SignedKeyExchangeError, SignedKeyProviders } from "./registry.js";
import { decodeJwt, p256KeyPair, pemBody } from "./test-keys.js";
import {
  createFakeTokenExchange,
  FIXTURE_AUDIENCE,
  FIXTURE_INVALID_CLIENT,
  FIXTURE_PROVIDER_ID,
  FIXTURE_SCOPE,
  FIXTURE_TOKEN_ENDPOINT,
  fixtureClient,
  fixtureCredentials,
  fixtureExchangeProvider,
} from "./test-token-exchange.js";

// #369 (ADR 0020 §2) without a database: the client secret signed per
// exchange, the form, error mapping, and probes and candidate keys that
// exchange without caching. The cached path is in token-store.test.ts.

function setup() {
  const client = fixtureClient(p256KeyPair());
  const fake = createFakeTokenExchange([client]);
  const requests: Array<{ url: string; body: string }> = [];
  const registry = new SignedKeyProviders({
    definitions: new Map([[FIXTURE_PROVIDER_ID, fixtureExchangeProvider]]),
    http: () => async (url, init) => {
      requests.push({ url, body: init?.body ?? "" });
      return fake.fetch(url, init);
    },
  });
  const parsed = registry.parse(
    fixtureExchangeProvider,
    fixtureCredentials(client),
  );
  if (!parsed.ok) {
    throw new Error(parsed.message);
  }
  return { client, fake, registry, requests, key: parsed.value };
}

describe("signed-key token exchange", () => {
  it("posts a client secret signed for this exchange only, with the provider's form", async () => {
    const { client, key, requests, fake } = setup();
    const before = Math.floor(Date.now() / 1000);
    const token = await key.exchangeAccessToken();
    expect(token.expiresInSeconds).toBe(3600);
    expect(fake.issued).toEqual([token.accessToken]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(FIXTURE_TOKEN_ENDPOINT);
    const form = new URLSearchParams(requests[0]!.body);
    expect([...form.keys()].sort()).toEqual([
      "client_id",
      "client_secret",
      "grant_type",
      "scope",
    ]);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("client_id")).toBe(client.clientId);
    expect(form.get("scope")).toBe(FIXTURE_SCOPE);
    const secret = decodeJwt(form.get("client_secret")!, client.key.publicKey);
    expect(secret.verifies).toBe(true);
    expect(secret.header).toEqual({
      alg: "ES256",
      kid: client.keyId,
      typ: "JWT",
    });
    expect(secret.claims.iss).toBe(client.teamId);
    expect(secret.claims.sub).toBe(client.clientId);
    expect(secret.claims.aud).toBe(FIXTURE_AUDIENCE);
    const iat = secret.claims.iat as number;
    const exp = secret.claims.exp as number;
    expect(iat).toBeGreaterThanOrEqual(before - 61);
    expect(iat).toBeLessThanOrEqual(before - 59);
    expect(exp - iat).toBe(660);
  });

  it("signs a new client secret for every exchange", async () => {
    const { key, fake } = setup();
    await key.exchangeAccessToken();
    await key.exchangeAccessToken();
    expect(fake.clientSecrets).toHaveLength(2);
    expect(fake.clientSecrets[0]).not.toBe(fake.clientSecrets[1]);
  });

  it("never hands the client secret to a connector: mintTokens refuses an exchange provider", () => {
    const { key } = setup();
    expect(key.exchanges).toBe(true);
    expect(() => key.mintTokens()).toThrow(/acquireTokens/);
  });

  it("maps invalid_client to the provider's key message, 5xx, 429 and timeouts to transient, others to configuration", async () => {
    const { key, fake } = setup();
    const cases: Array<
      [FakeAnswer, "rejected" | "transient" | "configuration"]
    > = [
      [{ status: 400, body: { error: "invalid_client" } }, "rejected"],
      [{ status: 401, body: { error: "invalid_client" } }, "rejected"],
      [{ status: 503, body: { error: "server_error" } }, "transient"],
      [{ status: 429, body: {} }, "transient"],
      [
        Object.assign(new Error("aborted"), { name: "TimeoutError" }),
        "transient",
      ],
      [{ status: 400, body: { error: "invalid_scope" } }, "configuration"],
      [{ status: 200, body: { token_type: "Bearer" } }, "transient"],
    ];
    for (const [answer, kind] of cases) {
      fake.nextErrors.push(answer);
      const error = await key
        .exchangeAccessToken()
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SignedKeyExchangeError);
      expect((error as SignedKeyExchangeError).kind).toBe(kind);
      if (kind === "rejected") {
        expect((error as Error).message).toBe(FIXTURE_INVALID_CLIENT);
      }
    }
  });

  it("puts no client secret, key material, token or response body in exchange errors", async () => {
    const { key, fake, client } = setup();
    const leaky = "leaky-body-access-token-value";
    fake.nextErrors.push(
      { status: 500, body: { error: "server_error", access_token: leaky } },
      { status: 400, body: { error: "invalid_request", detail: leaky } },
      new Error(`socket closed after ${leaky}`),
    );
    const messages: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const error = (await key
        .exchangeAccessToken()
        .catch((caught: unknown) => caught)) as Error;
      messages.push(error.message, String(error.stack), JSON.stringify(error));
    }
    const text = messages.join("\n");
    expect(text).not.toContain(leaky);
    expect(text).not.toContain(pemBody(client.key.privateKeyPem).slice(20, 60));
    expect(JSON.stringify(key)).toBe('"[signed key]"');
  });

  it("probes with one exchanged token, never cached, and reports a refused key with the provider's message", async () => {
    const { registry, fake, client } = setup();
    const valid = await registry.validate(
      fixtureExchangeProvider,
      fixtureCredentials(client),
      {},
    );
    expect(valid.ok).toBe(true);
    expect(fake.exchanges).toBe(1);
    expect(fake.apiCalls).toEqual([fake.issued[0]]);

    fake.nextErrors.push({ status: 400, body: { error: "invalid_client" } });
    const refused = await registry.validate(
      fixtureExchangeProvider,
      fixtureCredentials(client),
      {},
    );
    expect(refused).toEqual({ ok: false, message: FIXTURE_INVALID_CLIENT });

    fake.nextErrors.push({ status: 502, body: {} });
    const down = await registry.validate(
      fixtureExchangeProvider,
      fixtureCredentials(client),
      {},
    );
    expect(down.ok).toBe(false);
    expect(!down.ok && down.message).toMatch(/could not be reached/);
  });

  it("exchanges per call without a cache (candidate keys), with no retry on a 401", async () => {
    const { key, fake } = setup();
    const seen: string[] = [];
    for (let call = 0; call < 2; call += 1) {
      await callWithSignedKey({
        key,
        call: async (credentials) => {
          expect(Object.keys(credentials)).toEqual(["accessToken"]);
          seen.push(credentials.accessToken);
          return "ok";
        },
      });
    }
    expect(fake.exchanges).toBe(2);
    expect(seen).toEqual(fake.issued);

    let calls = 0;
    const error = await callWithSignedKey({
      key,
      call: async () => {
        calls += 1;
        throw Object.assign(new Error("401"), {
          name: "AccessTokenRejectedError",
        });
      },
    }).catch((caught: unknown) => caught);
    expect(calls).toBe(1);
    expect(error).toBeInstanceOf(SignedKeyRejectedError);
  });

  it("turns an exchange refused with invalid_client into a refused key (auth_failed)", async () => {
    const { key, fake } = setup();
    fake.nextErrors.push({ status: 400, body: { error: "invalid_client" } });
    let calls = 0;
    const error = await callWithSignedKey({
      key,
      call: async () => {
        calls += 1;
        return "ok";
      },
    }).catch((caught: unknown) => caught);
    expect(calls).toBe(0);
    expect(error).toBeInstanceOf(SignedKeyRejectedError);
    expect((error as Error).message).toBe(FIXTURE_INVALID_CLIENT);
  });
});

type FakeAnswer = { status: number; body: unknown } | Error;
