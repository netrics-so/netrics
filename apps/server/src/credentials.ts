import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { z } from "zod";

// Envelope format v1: AES-256-GCM, random 12-byte IV, JSON
// { v, iv, tag, data } with base64 fields, stored base64-encoded in
// connections.credentials_encrypted (bytea). credentials_key_version tracks
// the key (always 1 until rotation lands in a later slice).
const ENVELOPE_VERSION = 1;
const IV_BYTES = 12;

const keySchema = z
  .base64()
  .refine((value) => Buffer.from(value, "base64").length === 32, {
    message: "encryption key must be base64-encoded and decode to 32 bytes",
  });

const envelopeSchema = z.object({
  v: z.literal(ENVELOPE_VERSION),
  iv: z.base64(),
  tag: z.base64(),
  data: z.base64(),
});

export class CredentialDecryptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CredentialDecryptionError";
  }
}

function decodeKey(key: string): Buffer {
  return Buffer.from(keySchema.parse(key), "base64");
}

/**
 * Encrypts a credentials JSON string into the v1 envelope. Returns the
 * base64-encoded envelope JSON, ready to store in the bytea column.
 */
export function encryptCredentials(plaintextJson: string, key: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", decodeKey(key), iv);
  const data = Buffer.concat([
    cipher.update(plaintextJson, "utf8"),
    cipher.final(),
  ]);
  const envelope = {
    v: ENVELOPE_VERSION,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

/**
 * Decrypts an envelope produced by encryptCredentials back into the original
 * credentials JSON string. Throws CredentialDecryptionError on malformed
 * envelopes, wrong keys, or tampering (GCM tag mismatch).
 */
export function decryptCredentials(envelope: string, key: string): string {
  let parsed: z.infer<typeof envelopeSchema>;
  try {
    parsed = envelopeSchema.parse(
      JSON.parse(Buffer.from(envelope, "base64").toString("utf8")),
    );
  } catch (error) {
    throw new CredentialDecryptionError("malformed credential envelope", {
      cause: error,
    });
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      decodeKey(key),
      Buffer.from(parsed.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(parsed.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    throw new CredentialDecryptionError(
      "credential envelope failed authentication (wrong key or tampered)",
      { cause: error },
    );
  }
}

const SECRET_KEY_PATTERN = /secret|token|password|credential|key/i;
const REDACTED = "[redacted]";

/**
 * Deep-clones `input`, replacing the value of any object key that looks like
 * it carries a secret (secret/token/password/credential/key) with
 * "[redacted]". For log and error paths: credentials must never appear in
 * either. Circular references are replaced with "[circular]".
 */
export function redactSecrets(input: unknown): unknown {
  const seen = new WeakSet<object>();
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      if (seen.has(value)) {
        return "[circular]";
      }
      seen.add(value);
      return value.map(walk);
    }
    if (value !== null && typeof value === "object") {
      if (seen.has(value)) {
        return "[circular]";
      }
      seen.add(value);
      return Object.fromEntries(
        Object.entries(value).map(([entryKey, entryValue]) => [
          entryKey,
          SECRET_KEY_PATTERN.test(entryKey) ? REDACTED : walk(entryValue),
        ]),
      );
    }
    return value;
  };
  return walk(input);
}
