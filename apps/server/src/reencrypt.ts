import { and, eq, isNotNull } from "drizzle-orm";

import { schema, type Database } from "@netrics/database";

import {
  decryptCredentials,
  decryptOAuthAccessToken,
  encryptCredentials,
  encryptOAuthAccessToken,
  type CredentialKeyring,
} from "./credentials.js";

export interface ReencryptResult {
  total: number;
  alreadyCurrent: number;
  reencrypted: number;
  failed: number;
}

function envelopeKeyId(stored: Buffer): string | null {
  try {
    const envelope = JSON.parse(
      Buffer.from(stored.toString("utf8"), "base64").toString("utf8"),
    ) as { kid?: unknown };
    return typeof envelope.kid === "string" ? envelope.kid : null;
  } catch {
    return null;
  }
}

interface StoredEnvelope {
  stored: Buffer;
  open(keyring: CredentialKeyring): string;
  seal(plaintext: string, keyring: CredentialKeyring): string;
  /** Writes the new envelope if the row still holds `stored`. */
  replace(envelope: Buffer): Promise<boolean>;
}

/**
 * Re-encrypts every stored envelope that is not on the keyring's current
 * key (#67): connection credentials and cached OAuth access tokens (ADR
 * 0012). Runs with the owner connection (reads across workspaces).
 * Idempotent and safe to interrupt: each row is updated only if it still
 * holds the envelope that was read, so a concurrent change is never
 * overwritten. Reports counts, never values. (PKCE verifiers of OAuth
 * authorizations live ten minutes and are not rotated.)
 */
export async function reencryptCredentials(
  ownerDb: Database,
  keyring: CredentialKeyring,
): Promise<ReencryptResult> {
  const credentials = await ownerDb
    .select({
      id: schema.connections.id,
      workspaceId: schema.connections.workspaceId,
      stored: schema.connections.credentialsEncrypted,
    })
    .from(schema.connections)
    .where(isNotNull(schema.connections.credentialsEncrypted));
  const accessTokens = await ownerDb
    .select({
      id: schema.connectionOAuth.connectionId,
      workspaceId: schema.connectionOAuth.workspaceId,
      stored: schema.connectionOAuth.accessTokenEncrypted,
    })
    .from(schema.connectionOAuth)
    .where(isNotNull(schema.connectionOAuth.accessTokenEncrypted));

  const envelopes: StoredEnvelope[] = [
    ...credentials.map((row): StoredEnvelope => {
      const binding = { workspaceId: row.workspaceId, connectionId: row.id };
      const stored = row.stored!;
      return {
        stored,
        open: (ring) =>
          decryptCredentials(stored.toString("utf8"), ring, binding),
        seal: (plaintext, ring) => encryptCredentials(plaintext, ring, binding),
        replace: async (envelope) =>
          (
            await ownerDb
              .update(schema.connections)
              .set({ credentialsEncrypted: envelope })
              .where(
                and(
                  eq(schema.connections.id, row.id),
                  eq(schema.connections.credentialsEncrypted, stored),
                ),
              )
              .returning({ id: schema.connections.id })
          ).length === 1,
      };
    }),
    ...accessTokens.map((row): StoredEnvelope => {
      const binding = { workspaceId: row.workspaceId, connectionId: row.id };
      const stored = row.stored!;
      return {
        stored,
        open: (ring) =>
          decryptOAuthAccessToken(stored.toString("utf8"), ring, binding),
        seal: (plaintext, ring) =>
          encryptOAuthAccessToken(plaintext, ring, binding),
        replace: async (envelope) =>
          (
            await ownerDb
              .update(schema.connectionOAuth)
              .set({ accessTokenEncrypted: envelope })
              .where(
                and(
                  eq(schema.connectionOAuth.connectionId, row.id),
                  eq(schema.connectionOAuth.accessTokenEncrypted, stored),
                ),
              )
              .returning({ id: schema.connectionOAuth.connectionId })
          ).length === 1,
      };
    }),
  ];

  const result: ReencryptResult = {
    total: envelopes.length,
    alreadyCurrent: 0,
    reencrypted: 0,
    failed: 0,
  };
  for (const envelope of envelopes) {
    if (envelopeKeyId(envelope.stored) === keyring.currentKeyId) {
      result.alreadyCurrent += 1;
      continue;
    }
    try {
      const plaintext = envelope.open(keyring);
      const replaced = await envelope.replace(
        Buffer.from(envelope.seal(plaintext, keyring), "utf8"),
      );
      if (replaced) {
        result.reencrypted += 1;
      } else {
        // Changed concurrently (new envelopes are already current).
        result.alreadyCurrent += 1;
      }
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
