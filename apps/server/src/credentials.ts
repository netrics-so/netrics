import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import { z } from "zod";

// Envelope format v2: AES-256-GCM with a random 12-byte IV and a 16-byte tag,
// stored as base64 of the JSON { v, kid, iv, tag, data } in
// connections.credentials_encrypted (bytea).
//
// - The associated data binds the ciphertext to its workspace and connection,
//   so an envelope copied onto another row fails authentication.
// - kid names the key that encrypted it (a fingerprint, never the key), so
//   the keyring can decrypt with retired keys during a rotation.
const ENVELOPE_VERSION = 2;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const keySchema = z
  .base64()
  .refine((value) => Buffer.from(value, "base64").length === 32, {
    message: "encryption key must be base64-encoded and decode to 32 bytes",
  });

const envelopeSchema = z.object({
  v: z.literal(ENVELOPE_VERSION),
  kid: z.string().min(1),
  iv: z.base64(),
  tag: z.base64(),
  data: z.base64(),
});

// redactSecrets lives in the connector runtime (the credential boundary) so
// connector-facing code and server code share one implementation.
export { redactSecrets } from "@netrics/connector-runtime";

export class CredentialDecryptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CredentialDecryptionError";
  }
}

/** The row an envelope belongs to; authenticated as associated data. */
export interface CredentialBinding {
  workspaceId: string;
  connectionId: string;
}

export interface CredentialKeyring {
  /** Key id used for new envelopes. */
  readonly currentKeyId: string;
  /** Key ids this keyring can decrypt (current first). */
  readonly keyIds: readonly string[];
  key(keyId: string): Buffer | undefined;
}

/** Stable, non-secret identifier of a key: 16 hex chars of its SHA-256. */
export function credentialKeyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/**
 * Builds the keyring from the current key and any retired keys that may still
 * protect stored envelopes (APP_ENCRYPTION_KEY, APP_ENCRYPTION_KEYS_PREVIOUS).
 */
export function createCredentialKeyring(
  currentKey: string,
  previousKeys: readonly string[] = [],
): CredentialKeyring {
  const keys = new Map<string, Buffer>();
  for (const encoded of [currentKey, ...previousKeys]) {
    const key = Buffer.from(keySchema.parse(encoded), "base64");
    keys.set(credentialKeyId(key), key);
  }
  const currentKeyId = credentialKeyId(
    Buffer.from(keySchema.parse(currentKey), "base64"),
  );
  return {
    currentKeyId,
    keyIds: [...keys.keys()],
    key: (keyId) => keys.get(keyId),
  };
}

function associatedData({ workspaceId, connectionId }: CredentialBinding) {
  return Buffer.from(
    `netrics:credentials:v${ENVELOPE_VERSION}|${workspaceId}|${connectionId}`,
    "utf8",
  );
}

/**
 * Encrypts a credentials JSON string for one connection with the keyring's
 * current key. Returns the base64-encoded envelope JSON for the bytea column.
 */
export function encryptCredentials(
  plaintextJson: string,
  keyring: CredentialKeyring,
  binding: CredentialBinding,
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(
    "aes-256-gcm",
    keyring.key(keyring.currentKeyId)!,
    iv,
    { authTagLength: TAG_BYTES },
  );
  cipher.setAAD(associatedData(binding));
  const data = Buffer.concat([
    cipher.update(plaintextJson, "utf8"),
    cipher.final(),
  ]);
  const envelope = {
    v: ENVELOPE_VERSION,
    kid: keyring.currentKeyId,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

/**
 * Decrypts an envelope produced by encryptCredentials for the same binding.
 * Throws CredentialDecryptionError on malformed or unknown-version
 * envelopes, unknown keys, truncated tags, tampering, or a binding mismatch.
 */
export function decryptCredentials(
  envelope: string,
  keyring: CredentialKeyring,
  binding: CredentialBinding,
): string {
  let parsed: z.infer<typeof envelopeSchema>;
  try {
    parsed = envelopeSchema.parse(
      JSON.parse(Buffer.from(envelope, "base64").toString("utf8")),
    );
  } catch (error) {
    throw new CredentialDecryptionError(
      "malformed or unsupported credential envelope; re-enter the connection credentials",
      { cause: error },
    );
  }
  const key = keyring.key(parsed.kid);
  if (!key) {
    throw new CredentialDecryptionError(
      `credential envelope uses unknown key ${parsed.kid}; add the retired key to APP_ENCRYPTION_KEYS_PREVIOUS`,
    );
  }
  const tag = Buffer.from(parsed.tag, "base64");
  if (tag.length !== TAG_BYTES) {
    throw new CredentialDecryptionError(
      "credential envelope has a truncated authentication tag",
    );
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(parsed.iv, "base64"),
      { authTagLength: TAG_BYTES },
    );
    decipher.setAAD(associatedData(binding));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(parsed.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    throw new CredentialDecryptionError(
      "credential envelope failed authentication (wrong key, tampered, or bound to another connection)",
      { cause: error },
    );
  }
}
