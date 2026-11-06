import { describe, expect, it } from "vitest";

import { callWithSignedKey, SignedKeyRejectedError } from "./connector-auth.js";
import { appStoreConnectProvider } from "./providers/index.js";
import { SignedKeyProviders, type SignedKey } from "./registry.js";
import {
  decodeJwt,
  p256KeyPair,
  TEST_ISSUER_ID,
  TEST_KEY_ID,
} from "./test-keys.js";

// ADR 0014: a signed-key connector receives only { accessToken }, a fresh
// token per call; a provider 401/403 is the key's problem (auth_failed with
// an actionable message), with no refresh-and-retry loop.

function signedKey() {
  const pair = p256KeyPair();
  let now = Date.parse("2026-10-03T12:00:00Z");
  const registry = new SignedKeyProviders({ now: () => (now += 1000) });
  const result = registry.parse(appStoreConnectProvider, {
    issuerId: TEST_ISSUER_ID,
    keyId: TEST_KEY_ID,
    privateKey: pair.privateKeyPem,
  });
  if (!result.ok) {
    throw new Error(result.message);
  }
  return { key: result.value as SignedKey, ...pair };
}

describe("callWithSignedKey", () => {
  it("hands the connector only a freshly signed access token per call", async () => {
    const { key, publicKey, privateKeyPem } = signedKey();
    const received: Array<Record<string, unknown>> = [];
    for (let call = 0; call < 2; call += 1) {
      await callWithSignedKey({
        key,
        call: async (credentials) => {
          received.push({ ...credentials });
          return "ok";
        },
      });
    }
    expect(received).toHaveLength(2);
    for (const credentials of received) {
      expect(Object.keys(credentials)).toEqual(["accessToken"]);
      const token = String(credentials.accessToken);
      expect(decodeJwt(token, publicKey).verifies).toBe(true);
      expect(token).not.toContain(privateKeyPem.slice(30, 60));
    }
    expect(received[0]!.accessToken).not.toBe(received[1]!.accessToken);
  });

  it("turns a failed call after a 401 into the provider's revoked-key message, without retrying", async () => {
    const { key } = signedKey();
    let calls = 0;
    const statuses: number[] = [];
    const error = await callWithSignedKey({
      key,
      options: { onResponse: (status) => statuses.push(status) },
      call: async (_credentials, options) => {
        calls += 1;
        options.onResponse?.(401);
        throw new Error("provider answered 401");
      },
    }).catch((caught: unknown) => caught);
    expect(calls).toBe(1);
    expect(statuses).toEqual([401]);
    expect(error).toBeInstanceOf(SignedKeyRejectedError);
    expect((error as SignedKeyRejectedError).status).toBe(401);
    expect((error as Error).message).toBe(
      appStoreConnectProvider.authFailure.unauthorized,
    );
    expect((error as Error).message).toMatch(
      /Upload a new App Store Connect key/,
    );
  });

  it("turns a 403 into the role message", async () => {
    const { key } = signedKey();
    const error = await callWithSignedKey({
      key,
      call: async (_credentials, options) => {
        options.onResponse?.(403);
        throw new Error("forbidden");
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SignedKeyRejectedError);
    expect((error as Error).message).toMatch(/Sales or Finance role/);
  });

  it("treats a refused check result after a 401 as the key's failure", async () => {
    const { key } = signedKey();
    const error = await callWithSignedKey({
      key,
      call: async (_credentials, options) => {
        options.onResponse?.(401);
        return { ok: false };
      },
      rejected: (result) => !result.ok,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SignedKeyRejectedError);
  });

  it("treats a connector's AccessTokenRejectedError as a 401", async () => {
    const { key } = signedKey();
    const error = await callWithSignedKey({
      key,
      call: async () => {
        const rejected = new Error("token refused");
        rejected.name = "AccessTokenRejectedError";
        throw rejected;
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SignedKeyRejectedError);
    expect((error as SignedKeyRejectedError).status).toBe(401);
  });

  it("passes other failures and handled refusals through", async () => {
    const { key } = signedKey();
    const outage = new Error("provider answered 503");
    await expect(
      callWithSignedKey({
        key,
        call: async (_credentials, options) => {
          options.onResponse?.(503);
          throw outage;
        },
      }),
    ).rejects.toBe(outage);
    // A 403 the connector handled (e.g. an optional source) is no failure.
    await expect(
      callWithSignedKey({
        key,
        call: async (_credentials, options) => {
          options.onResponse?.(403);
          return { ok: true };
        },
        rejected: (result) => !result.ok,
      }),
    ).resolves.toEqual({ ok: true });
  });
});
