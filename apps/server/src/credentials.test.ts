import { randomBytes, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CredentialDecryptionError,
  createCredentialKeyring,
  decryptCredentials,
  encryptCredentials,
  redactSecrets,
} from "./credentials.js";

const keyA = randomBytes(32).toString("base64");
const keyB = randomBytes(32).toString("base64");
const ringA = createCredentialKeyring(keyA);
const ringB = createCredentialKeyring(keyB);
const binding = { workspaceId: randomUUID(), connectionId: randomUUID() };

type Envelope = {
  v: number;
  kid: string;
  iv: string;
  tag: string;
  data: string;
};

function decode(envelope: string): Envelope {
  return JSON.parse(
    Buffer.from(envelope, "base64").toString("utf8"),
  ) as Envelope;
}

function encode(envelope: Envelope): string {
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

describe("encryptCredentials / decryptCredentials", () => {
  it("round-trips a credentials JSON document", () => {
    const plaintext = JSON.stringify({
      accessToken: "tok-123",
      nested: { apiSecret: "shh" },
    });
    const envelope = encryptCredentials(plaintext, ringA, binding);
    expect(envelope).not.toContain("tok-123");
    expect(decryptCredentials(envelope, ringA, binding)).toBe(plaintext);
    expect(decode(envelope)).toMatchObject({ v: 2, kid: ringA.currentKeyId });
  });

  it("produces a fresh envelope per call (random IV)", () => {
    const plaintext = JSON.stringify({ token: "same-input" });
    const first = encryptCredentials(plaintext, ringA, binding);
    const second = encryptCredentials(plaintext, ringA, binding);
    expect(first).not.toBe(second);
    expect(decryptCredentials(first, ringA, binding)).toBe(plaintext);
    expect(decryptCredentials(second, ringA, binding)).toBe(plaintext);
  });

  it("fails with a keyring that lacks the key", () => {
    const envelope = encryptCredentials('{"token":"x"}', ringA, binding);
    expect(() => decryptCredentials(envelope, ringB, binding)).toThrow(
      /unknown key/,
    );
    // Forging the kid does not help: authentication still fails.
    const forged = encode({ ...decode(envelope), kid: ringB.currentKeyId });
    expect(() => decryptCredentials(forged, ringB, binding)).toThrow(
      CredentialDecryptionError,
    );
  });

  it("is bound to its workspace and connection", () => {
    const envelope = encryptCredentials('{"token":"x"}', ringA, binding);
    for (const other of [
      { ...binding, workspaceId: randomUUID() },
      { ...binding, connectionId: randomUUID() },
    ]) {
      expect(() => decryptCredentials(envelope, ringA, other)).toThrow(
        /bound to another connection/,
      );
    }
  });

  it("rejects truncated authentication tags", () => {
    const envelope = decode(
      encryptCredentials('{"token":"x"}', ringA, binding),
    );
    const truncated = encode({
      ...envelope,
      tag: Buffer.from(envelope.tag, "base64")
        .subarray(0, 4)
        .toString("base64"),
    });
    expect(() => decryptCredentials(truncated, ringA, binding)).toThrow(
      /truncated/,
    );
  });

  it("detects tampering when a ciphertext byte is flipped", () => {
    const envelope = decode(
      encryptCredentials('{"token":"sensitive-value"}', ringA, binding),
    );
    const data = Buffer.from(envelope.data, "base64");
    data[0] = data[0]! ^ 0xff;
    const tampered = encode({ ...envelope, data: data.toString("base64") });
    expect(() => decryptCredentials(tampered, ringA, binding)).toThrow(
      CredentialDecryptionError,
    );
  });

  it("rejects malformed and v1 envelopes", () => {
    expect(() => decryptCredentials("not-base64-json", ringA, binding)).toThrow(
      CredentialDecryptionError,
    );
    const v1 = Buffer.from(
      JSON.stringify({ v: 1, iv: "", tag: "", data: "" }),
    ).toString("base64");
    expect(() => decryptCredentials(v1, ringA, binding)).toThrow(
      /re-enter the connection credentials/,
    );
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() =>
      createCredentialKeyring(randomBytes(16).toString("base64")),
    ).toThrow(/32 bytes/);
  });
});

describe("key rotation", () => {
  it("decrypts with retired keys and encrypts with the current one", () => {
    const old = encryptCredentials('{"token":"old"}', ringA, binding);
    const rotated = createCredentialKeyring(keyB, [keyA]);
    expect(rotated.currentKeyId).toBe(ringB.currentKeyId);
    expect(decryptCredentials(old, rotated, binding)).toBe('{"token":"old"}');
    const fresh = encryptCredentials('{"token":"new"}', rotated, binding);
    expect(decode(fresh).kid).toBe(ringB.currentKeyId);
    expect(decryptCredentials(fresh, ringB, binding)).toBe('{"token":"new"}');
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
