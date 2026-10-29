import { and, eq } from "drizzle-orm";

import type { Transaction } from "./context.js";
import * as schema from "./schema.js";

// The cached access tokens of signed-key connections with a token exchange
// (ADR 0020 §2, #369), for the host's token store (netrics_app). Inside
// withWorkspace every query also names the workspace explicitly (defense in
// depth beside RLS).

export type ConnectionSignedKeyTokenRow =
  typeof schema.connectionSignedKeyTokens.$inferSelect;

function tokenScope(workspaceId: string, connectionId: string) {
  return and(
    eq(schema.connectionSignedKeyTokens.workspaceId, workspaceId),
    eq(schema.connectionSignedKeyTokens.connectionId, connectionId),
  );
}

/** The connection's cached token row, without locking. */
export async function findSignedKeyToken(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
): Promise<ConnectionSignedKeyTokenRow | null> {
  const [row] = await tx
    .select()
    .from(schema.connectionSignedKeyTokens)
    .where(tokenScope(workspaceId, connectionId))
    .limit(1);
  return row ?? null;
}

/**
 * The connection's token row, created empty if missing and locked for
 * update (the exchange is serialized per connection). A concurrent caller
 * waits here until the holder commits and then reads the stored token.
 * Null when the connection is not in this workspace.
 */
export async function lockSignedKeyToken(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
): Promise<ConnectionSignedKeyTokenRow | null> {
  const [connection] = await tx
    .select({ id: schema.connections.id })
    .from(schema.connections)
    .where(
      and(
        eq(schema.connections.workspaceId, workspaceId),
        eq(schema.connections.id, connectionId),
      ),
    )
    .limit(1);
  if (!connection) {
    return null;
  }
  await tx
    .insert(schema.connectionSignedKeyTokens)
    .values({ workspaceId, connectionId })
    .onConflictDoNothing({
      target: schema.connectionSignedKeyTokens.connectionId,
    });
  const [row] = await tx
    .select()
    .from(schema.connectionSignedKeyTokens)
    .where(tokenScope(workspaceId, connectionId))
    .for("update")
    .limit(1);
  return row ?? null;
}

/** Stores a token envelope and its expiry, or clears both (null). */
export async function storeSignedKeyToken(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
  token: { accessTokenEncrypted: Buffer; accessTokenExpiresAt: Date } | null,
): Promise<void> {
  await tx
    .update(schema.connectionSignedKeyTokens)
    .set({
      accessTokenEncrypted: token?.accessTokenEncrypted ?? null,
      accessTokenExpiresAt: token?.accessTokenExpiresAt ?? null,
      updatedAt: new Date(),
    })
    .where(tokenScope(workspaceId, connectionId));
}

/**
 * Deletes the connection's cached token (key replaced). Connection deletion
 * cascades on its own.
 */
export async function deleteSignedKeyToken(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
): Promise<void> {
  await tx
    .delete(schema.connectionSignedKeyTokens)
    .where(tokenScope(workspaceId, connectionId));
}
