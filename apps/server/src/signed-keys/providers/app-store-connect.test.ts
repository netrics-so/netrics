import { generateKeyPairSync } from "node:crypto";

import {
  AGREEMENTS_MESSAGE,
  KEY_MISMATCH_MESSAGE,
  ROLE_MESSAGE,
  appStoreConnectManifest,
  vendorNumberMessage,
} from "@netrics/connectors";
import { describe, expect, it } from "vitest";

import { SignedKeyProviders } from "../registry.js";
import { createFakeAsc, type FakeAscTeam } from "../test-app-store-connect.js";
import {
  decodeJwt,
  p256KeyPair,
  pemBody,
  TEST_ISSUER_ID,
  TEST_KEY_ID,
} from "../test-keys.js";
import {
  RATE_LIMITED_MESSAGE,
  appStoreConnectProvider,
} from "./app-store-connect.js";

// The App Store Connect provider's probes (#171): the key, role and vendor
// number are checked against the API with freshly signed tokens before
// anything is stored.

const VENDOR = "85012345";

function team(overrides: Partial<FakeAscTeam> = {}): FakeAscTeam {
  return {
    issuerId: TEST_ISSUER_ID,
    keyId: TEST_KEY_ID,
    key: p256KeyPair(),
    apps: [{ id: "1000000001", name: "Example", bundleId: "com.example" }],
    vendorNumbers: [VENDOR],
    ...overrides,
  };
}

function setup(teams: FakeAscTeam[]) {
  const asc = createFakeAsc(teams);
  /** Every bearer token the probes sent. */
  const tokens: string[] = [];
  const providers = new SignedKeyProviders({
    definitions: new Map([
      [appStoreConnectProvider.id, appStoreConnectProvider],
    ]),
    http: () => (url, init) => {
      tokens.push(init?.headers?.authorization?.slice("Bearer ".length) ?? "");
      return asc.fetch(url, init);
    },
  });
  const validate = (
    member: FakeAscTeam,
    config: Record<string, unknown> = { vendorNumber: VENDOR },
  ) =>
    providers.validate(
      appStoreConnectProvider,
      {
        issuerId: member.issuerId,
        keyId: member.keyId,
        privateKey: member.key.privateKeyPem,
      },
      config,
    );
  return { asc, tokens, validate };
}

function messageOf(result: { ok: boolean; message?: string }): string {
  return result.ok ? "" : (result.message ?? "");
}

describe("App Store Connect validation probes", () => {
  it("reads the apps, then the latest daily sales report, with a fresh token each", async () => {
    const member = team();
    const { asc, tokens, validate } = setup([member]);
    const result = await validate(member);
    expect(result.ok).toBe(true);
    expect(asc.requests.map((request) => request.url.pathname)).toEqual([
      "/v1/apps",
      "/v1/salesReports",
    ]);
    expect(asc.requests[0]!.url.searchParams.get("limit")).toBe("1");
    expect(Object.fromEntries(asc.requests[1]!.url.searchParams)).toMatchObject(
      {
        "filter[frequency]": "DAILY",
        "filter[reportType]": "SALES",
        "filter[reportSubType]": "SUMMARY",
        "filter[vendorNumber]": VENDOR,
        "filter[reportDate]": expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      },
    );
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe("");
    for (const token of tokens) {
      expect(decodeJwt(token, member.key.publicKey)).toMatchObject({
        verifies: true,
        header: { kid: TEST_KEY_ID },
        claims: { iss: TEST_ISSUER_ID, aud: "appstoreconnect-v1" },
      });
    }
  });

  it("401: the IDs and key do not belong together, or the key was revoked", async () => {
    const member = team();
    // Apple knows this issuer with another key.
    const { asc, validate } = setup([{ ...member, key: p256KeyPair() }]);
    const result = await validate(member);
    expect(messageOf(result)).toBe(KEY_MISMATCH_MESSAGE);
    expect(asc.requests).toHaveLength(1);

    const revoked = team({ revoked: true });
    expect(messageOf(await setup([revoked]).validate(revoked))).toBe(
      KEY_MISMATCH_MESSAGE,
    );
  });

  it("403 on the sales report names the role the key needs", async () => {
    const member = team({ role: "developer" });
    const result = await setup([member]).validate(member);
    expect(messageOf(result)).toBe(ROLE_MESSAGE);
    expect(ROLE_MESSAGE).toMatch(/Sales or Finance role/);
  });

  it("a vendor number the team does not have is named as wrong", async () => {
    const member = team();
    const result = await setup([member]).validate(member, {
      vendorNumber: "86999999",
    });
    expect(messageOf(result)).toBe(vendorNumberMessage("86999999"));
  });

  it("a day without sales (404) passes", async () => {
    // The fake answers every report with Apple's 404 "no sales".
    const member = team();
    expect((await setup([member]).validate(member)).ok).toBe(true);
  });

  it("a rate limit asks to try again later; a server error says Apple could not be reached", async () => {
    const member = team();
    const limited = setup([member]);
    limited.asc.failures.push(429);
    expect(messageOf(await limited.validate(member))).toBe(
      RATE_LIMITED_MESSAGE,
    );
    const down = setup([member]);
    down.asc.failures.push(200, 503);
    expect(messageOf(await down.validate(member))).toBe(
      "App Store Connect could not be reached to check the key. Try again in a few minutes.",
    );
  });

  it("never returns a token or key material in a message", async () => {
    const member = team();
    const cases: Array<[FakeAscTeam, string, number[]]> = [
      [{ ...member, key: p256KeyPair() }, VENDOR, []],
      [{ ...member, role: "developer" }, VENDOR, []],
      [member, "86999999", []],
      [member, VENDOR, [429]],
      [member, VENDOR, [200, 500]],
    ];
    for (const [known, vendorNumber, failures] of cases) {
      const { asc, tokens, validate } = setup([known]);
      asc.failures.push(...failures);
      const message = messageOf(await validate(member, { vendorNumber }));
      expect(tokens.length).toBeGreaterThan(0);
      expect(message).not.toBe("");
      expect(message).not.toMatch(/ey[A-Za-z0-9_-]{10,}\./);
      expect(message).not.toContain(
        pemBody(member.key.privateKeyPem).slice(0, 24),
      );
      for (const token of tokens) expect(message).not.toContain(token);
    }
    expect(AGREEMENTS_MESSAGE).toMatch(/agreement/);
  });

  it("does not reach Apple with a key that fails the format checks", async () => {
    const member = team();
    const { asc } = setup([member]);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString();
    const providers = new SignedKeyProviders({
      http: () => (url, init) => asc.fetch(url, init),
    });
    const result = await providers.validate(
      appStoreConnectProvider,
      { issuerId: TEST_ISSUER_ID, keyId: TEST_KEY_ID, privateKey: rsa },
      { vendorNumber: VENDOR },
    );
    expect(result.ok).toBe(false);
    expect(asc.requests).toHaveLength(0);
  });

  it("probes only the hosts the connector may reach", () => {
    expect(appStoreConnectProvider.serverDomains).toEqual(
      appStoreConnectManifest.outboundDomains,
    );
    expect(appStoreConnectProvider.probes.map((probe) => probe.name)).toEqual([
      "apps",
      "sales-report",
    ]);
  });
});
