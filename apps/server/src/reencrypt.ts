import { and, eq, isNotNull } from "drizzle-orm";

import { schema, type Database } from "@netrics/database";

import {
  decryptCredentials,
  encryptCredentials,
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

/**
 * Re-encrypts every stored credential envelope that is not on the keyring's
 * current key (#67). Runs with the owner connection (reads across
 * workspaces). Idempotent and safe to interrupt: each row is updated only if
 * it still holds the envelope that was read, so a concurrent credential
 * change is never overwritten. Reports counts, never values.
 */
export async function reencryptCredentials(
  ownerDb: Database,
  keyring: CredentialKeyring,
): Promise<ReencryptResult> {
  const rows = await ownerDb
    .select({
      id: schema.connections.id,
      workspaceId: schema.connections.workspaceId,
      credentials: schema.connections.credentialsEncrypted,
    })
    .from(schema.connections)
    .where(isNotNull(schema.connections.credentialsEncrypted));

  const result: ReencryptResult = {
    total: rows.length,
    alreadyCurrent: 0,
    reencrypted: 0,
    failed: 0,
  };
  for (const row of rows) {
    const stored = row.credentials!;
    if (envelopeKeyId(stored) === keyring.currentKeyId) {
      result.alreadyCurrent += 1;
      continue;
    }
    const binding = { workspaceId: row.workspaceId, connectionId: row.id };
    try {
      const plaintext = decryptCredentials(
        stored.toString("utf8"),
        keyring,
        binding,
      );
      const updated = await ownerDb
        .update(schema.connections)
        .set({
          credentialsEncrypted: Buffer.from(
            encryptCredentials(plaintext, keyring, binding),
            "utf8",
          ),
        })
        .where(
          and(
            eq(schema.connections.id, row.id),
            eq(schema.connections.credentialsEncrypted, stored),
          ),
        )
        .returning({ id: schema.connections.id });
      if (updated.length === 1) {
        result.reencrypted += 1;
      } else {
        // Changed concurrently (new credentials are already current).
        result.alreadyCurrent += 1;
      }
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
