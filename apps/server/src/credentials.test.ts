import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CredentialDecryptionError,
  decryptCredentials,
  encryptCredentials,
  redactSecrets,
} from "./credentials.js";

const keyA = randomBytes(32).toString("base64");
const keyB = randomBytes(32).toString("base64");

describe("encryptCredentials / decryptCredentials", () => {
  it("round-trips a credentials JSON document", () => {
    const plaintext = JSON.stringify({
      accessToken: "tok-123",
      nested: { apiSecret: "shh" },
    });
    const envelope = encryptCredentials(plaintext, keyA);
    expect(envelope).not.toContain("tok-123");
    expect(decryptCredentials(envelope, keyA)).toBe(plaintext);
  });

  it("produces a fresh envelope per call (random IV)", () => {
    const plaintext = JSON.stringify({ token: "same-input" });
    const first = encryptCredentials(plaintext, keyA);
    const second = encryptCredentials(plaintext, keyA);
    expect(first).not.toBe(second);
    expect(decryptCredentials(first, keyA)).toBe(plaintext);
    expect(decryptCredentials(second, keyA)).toBe(plaintext);
  });

  it("fails with the wrong key", () => {
    const envelope = encryptCredentials(JSON.stringify({ token: "x" }), keyA);
    expect(() => decryptCredentials(envelope, keyB)).toThrow(
      CredentialDecryptionError,
    );
  });

  it("detects tampering when a ciphertext byte is flipped", () => {
    const envelope = encryptCredentials(
      JSON.stringify({ token: "sensitive-value" }),
      keyA,
    );
    const decoded = JSON.parse(
      Buffer.from(envelope, "base64").toString("utf8"),
    ) as { data: string };
    const data = Buffer.from(decoded.data, "base64");
    data[0] = data[0]! ^ 0xff;
    decoded.data = data.toString("base64");
    const tampered = Buffer.from(JSON.stringify(decoded), "utf8").toString(
      "base64",
    );
    expect(() => decryptCredentials(tampered, keyA)).toThrow(
      CredentialDecryptionError,
    );
  });

  it("rejects malformed envelopes", () => {
    expect(() => decryptCredentials("not-base64-json", keyA)).toThrow(
      CredentialDecryptionError,
    );
    expect(() =>
      decryptCredentials(
        Buffer.from(
          JSON.stringify({ v: 2, iv: "", tag: "", data: "" }),
        ).toString("base64"),
        keyA,
      ),
    ).toThrow(CredentialDecryptionError);
  });

  it("rejects keys that are not 32 bytes", () => {
    const shortKey = randomBytes(16).toString("base64");
    expect(() =>
      encryptCredentials(JSON.stringify({ token: "x" }), shortKey),
    ).toThrow(/32 bytes/);
  });
});

describe("redactSecrets", () => {
  it("redacts secret-looking keys at any depth", () => {
    const input = {
      connection: {
        name: "demo",
        credentials: { apiToken: "tok", password: "pw" },
        config: { region: "eu", clientSecret: "s3", api_key: "k" },
      },
      attempts: [{ headers: { Authorization: "Bearer abc" }, body: "keep" }],
    };
    expect(redactSecrets(input)).toEqual({
      connection: {
        name: "demo",
        credentials: "[redacted]",
        config: {
          region: "eu",
          clientSecret: "[redacted]",
          api_key: "[redacted]",
        },
      },
      attempts: [{ headers: { Authorization: "Bearer abc" }, body: "keep" }],
    });
  });

  it("does not mutate the input and keeps non-secret values by reference semantics", () => {
    const input = { password: "pw", nested: { token: "t", ok: 1 } };
    const clone = redactSecrets(input) as typeof input;
    expect(input.password).toBe("pw");
    expect(input.nested.token).toBe("t");
    expect(clone).not.toBe(input);
    expect(clone.nested).not.toBe(input.nested);
  });

  it("passes through primitives", () => {
    expect(redactSecrets("string")).toBe("string");
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(undefined)).toBeUndefined();
  });

  it("handles circular references without crashing", () => {
    const input: Record<string, unknown> = { token: "t" };
    input.self = input;
    const clone = redactSecrets(input) as Record<string, unknown>;
    expect(clone.token).toBe("[redacted]");
    expect(clone.self).toBe("[circular]");
  });
});
