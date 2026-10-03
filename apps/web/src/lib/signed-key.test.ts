import { describe, expect, it } from "vitest";

import type { ConnectorAuthStrategy } from "@netrics/contracts";

import {
  emptyKeyValues,
  fieldOfMessage,
  keyCredentials,
  keyFieldHint,
  keyIdFromFileName,
  keyRemovedQuery,
  latestReportingDay,
  missingKeyField,
  parseKeyRemoved,
  privateKeyHint,
  signedKeyStrategyOf,
} from "./signed-key";

// The App Store Connect strategy as GET /v1/connectors presents it (#170).
const ASC: ConnectorAuthStrategy = {
  strategy: "signed-key",
  provider: "app-store-connect",
  providerName: "App Store Connect",
  fields: [
    {
      key: "issuerId",
      label: "Issuer ID",
      description: "Above the list of team keys.",
      input: "text",
      secret: false,
      maxBytes: 64,
    },
    {
      key: "keyId",
      label: "Key ID",
      description: "In the key's row.",
      input: "text",
      secret: false,
      maxBytes: 32,
    },
    {
      key: "privateKey",
      label: "Private key",
      description: "The .p8 file.",
      input: "file",
      secret: true,
      maxBytes: 4096,
    },
  ],
};
const strategy = signedKeyStrategyOf({ authStrategies: [ASC] })!;

// Shaped like a .p8 file; not a real key (the server parses keys).
const P8 =
  "-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg\n-----END PRIVATE KEY-----\n";

describe("signed-key strategy", () => {
  it("is found only for connectors that have one with fields", () => {
    expect(strategy.provider).toBe("app-store-connect");
    expect(
      signedKeyStrategyOf({ authStrategies: [{ strategy: "token" }] }),
    ).toBeNull();
    expect(
      signedKeyStrategyOf({
        authStrategies: [{ strategy: "signed-key", provider: "acme" }],
      }),
    ).toBeNull();
    expect(signedKeyStrategyOf(undefined)).toBeNull();
  });

  it("sends every field trimmed, with the key ID upper-cased and the key as given", () => {
    const values = {
      issuerId: "  57246542-96fe-1a63-e053-0824d011072a ",
      keyId: "2x9r4hxf34",
      privateKey: P8,
    };
    expect(keyCredentials(strategy, values)).toEqual({
      issuerId: "57246542-96fe-1a63-e053-0824d011072a",
      keyId: "2X9R4HXF34",
      privateKey: P8,
    });
    expect(missingKeyField(strategy, values)).toBeNull();
    expect(missingKeyField(strategy, emptyKeyValues(strategy))?.key).toBe(
      "issuerId",
    );
    expect(
      missingKeyField(strategy, { ...values, privateKey: "  " })?.key,
    ).toBe("privateKey");
  });
});

describe("format hints", () => {
  it("explains a malformed issuer ID or key ID, and accepts good ones", () => {
    const hint = (key: string, value: string) =>
      keyFieldHint("app-store-connect", key, value);
    expect(hint("issuerId", "57246542-96fe-1a63-e053-0824d011072a")).toBeNull();
    expect(hint("issuerId", "57246542")).toMatch(/UUID/);
    expect(hint("keyId", "2X9R4HXF34")).toBeNull();
    expect(hint("keyId", "2x9r4hxf34")).toBeNull();
    expect(hint("keyId", "2X9R4")).toMatch(/10 letters and digits/);
    expect(hint("keyId", "")).toBeNull();
    expect(keyFieldHint("acme", "keyId", "x")).toBeNull();
  });

  it("reads the key ID from Apple's file name", () => {
    expect(keyIdFromFileName("AuthKey_2X9R4HXF34.p8")).toBe("2X9R4HXF34");
    expect(keyIdFromFileName("AuthKey_2x9r4hxf34 (1).p8")).toBe("2X9R4HXF34");
    expect(keyIdFromFileName("key.p8")).toBeNull();
    expect(keyIdFromFileName("AuthKey_2X9R4HXF34.pem")).toBeNull();
  });

  it("names what was chosen instead of a .p8 private key", () => {
    expect(privateKeyHint(P8, 4096)).toBeNull();
    expect(privateKeyHint("", 4096)).toBeNull();
    expect(privateKeyHint("x".repeat(5000), 4096)).toMatch(/larger than 4 KiB/);
    expect(privateKeyHint("-----BEGIN CERTIFICATE-----\nMII…", 4096)).toMatch(
      /certificate/,
    );
    expect(
      privateKeyHint("-----BEGIN RSA PRIVATE KEY-----\nMII…", 4096),
    ).toMatch(/RSA/);
    expect(privateKeyHint("-----BEGIN PUBLIC KEY-----\nMF…", 4096)).toMatch(
      /public key/,
    );
    expect(privateKeyHint("hello", 4096)).toMatch(/BEGIN PRIVATE KEY/);
  });
});

describe("server messages", () => {
  const config = [{ key: "vendorNumber", label: "Vendor number" }];
  const of = (message: string) =>
    fieldOfMessage(message, strategy.fields, config);

  it("go next to the field they are about", () => {
    expect(
      of(
        "Issuer ID must be a UUID such as 57246542-96fe-1a63-e053-0824d011072a. Copy it from above the list of team keys.",
      ),
    ).toBe("issuerId");
    expect(
      of("Key ID must be 10 uppercase letters and digits, such as 2X9R4HXF34."),
    ).toBe("keyId");
    expect(
      of(
        "Private key: This is an RSA private key. The API key is an EC (P-256) key in a .p8 file.",
      ),
    ).toBe("privateKey");
    expect(of("Private key is required.")).toBe("privateKey");
    expect(
      of(
        "App Store Connect does not know vendor number 86000001 for this key's team. Copy the vendor number from Payments and Financial Reports, under your legal entity name.",
      ),
    ).toBe("vendorNumber");
  });

  it("about the key as a whole stay with the form", () => {
    for (const message of [
      "App Store Connect refused the key: the issuer ID, key ID and private key do not belong together, or the key was revoked. Check the three values, or create a new team key and upload it.",
      "This key cannot read sales reports. It needs the Sales or Finance role; Admin also works, but grants more than netrics needs. Create a team key with the Sales role and upload it.",
      "App Store Connect requires an agreement that is missing or has expired. The Account Holder must accept the latest agreements in App Store Connect (Business), then try again.",
      "App Store Connect's hourly request limit for this key is used up. Try again in an hour.",
    ]) {
      expect(of(message), message).toBeNull();
    }
  });
});

describe("connection page", () => {
  it("shows the newest reporting day", () => {
    expect(latestReportingDay([])).toBeNull();
    expect(
      latestReportingDay([
        { sourceTimestamp: "2026-09-30T00:00:00.000Z" },
        { sourceTimestamp: "2026-10-01T00:00:00.000Z" },
        { sourceTimestamp: "2026-09-29T00:00:00.000Z" },
      ]),
    ).toBe("2026-10-01");
    // Review metrics (#190) run through today: they do not count.
    expect(
      latestReportingDay([
        {
          sourceTimestamp: "2026-09-30T00:00:00.000Z",
          metricKey: "app_store_connect.downloads",
        },
        {
          sourceTimestamp: "2026-10-03T00:00:00.000Z",
          metricKey: "app_store_connect.reviews",
        },
      ]),
    ).toBe("2026-09-30");
  });

  it("round-trips the deleted key's provider through the query, and nothing else", () => {
    const query = Object.fromEntries(
      new URLSearchParams(keyRemovedQuery("app-store-connect")),
    );
    expect(parseKeyRemoved(query)).toBe("app-store-connect");
    expect(parseKeyRemoved({ keyRemoved: "<script>" })).toBeNull();
    expect(parseKeyRemoved({ keyRemoved: ["a", "b"] })).toBeNull();
    expect(parseKeyRemoved({})).toBeNull();
  });
});
