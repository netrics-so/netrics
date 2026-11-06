import { and, count, eq, gt, sql } from "drizzle-orm";

import type { Db, Transaction } from "./context.js";
import * as schema from "./schema.js";

// Pending generated keys of signed-key providers (ADR 0020 §3, #371), for
// netrics_app inside withWorkspace with the caller as app.user_id. RLS
// checks the workspace and the user; every query names both again (defense
// in depth). The envelope is opaque here; the server seals and opens it.

export type SignedKeyPendingKeyRow =
  typeof schema.signedKeyPendingKeys.$inferSelect;

/** Who may use a pending key: its workspace and the user who generated it. */
export interface PendingKeyOwner {
  workspaceId: string;
  userId: string;
}

function ownedBy(owner: PendingKeyOwner) {
  return and(
    eq(schema.signedKeyPendingKeys.workspaceId, owner.workspaceId),
    eq(schema.signedKeyPendingKeys.userId, owner.userId),
  );
}

/**
 * Stores a pending key. The id is chosen by the caller, because the
 * envelope is sealed to it before the row exists.
 */
export async function insertPendingKey(
  tx: Transaction,
  input: PendingKeyOwner & {
    id: string;
    provider: string;
    privateKeyEncrypted: Buffer;
    expiresAt: Date;
  },
): Promise<SignedKeyPendingKeyRow> {
  const [row] = await tx
    .insert(schema.signedKeyPendingKeys)
    .values(input)
    .returning();
  return row!;
}

/** How many unexpired pending keys the user holds in the workspace. */
export async function countActivePendingKeys(
  tx: Transaction,
  owner: PendingKeyOwner,
  now: Date,
): Promise<number> {
  const [row] = await tx
    .select({ value: count() })
    .from(schema.signedKeyPendingKeys)
    .where(and(ownedBy(owner), gt(schema.signedKeyPendingKeys.expiresAt, now)));
  return row?.value ?? 0;
}

/**
 * The user's unexpired pending key of `provider` with this id, or null:
 * another workspace's, another user's, another provider's, an expired or a
 * used key all read as missing.
 */
export async function findPendingKey(
  tx: Transaction,
  owner: PendingKeyOwner,
  id: string,
  provider: string,
  now: Date,
): Promise<SignedKeyPendingKeyRow | null> {
  const [row] = await tx
    .select()
    .from(schema.signedKeyPendingKeys)
    .where(
      and(
        ownedBy(owner),
        eq(schema.signedKeyPendingKeys.id, id),
        eq(schema.signedKeyPendingKeys.provider, provider),
        gt(schema.signedKeyPendingKeys.expiresAt, now),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Deletes the pending key as it moves into a connection's envelope, in the
 * connection's transaction. False when it is no longer there (used by a
 * concurrent request, or expired): the caller then stores nothing.
 */
export async function consumePendingKey(
  tx: Transaction,
  owner: PendingKeyOwner,
  id: string,
  provider: string,
  now: Date,
): Promise<boolean> {
  const deleted = await tx
    .delete(schema.signedKeyPendingKeys)
    .where(
      and(
        ownedBy(owner),
        eq(schema.signedKeyPendingKeys.id, id),
        eq(schema.signedKeyPendingKeys.provider, provider),
        gt(schema.signedKeyPendingKeys.expiresAt, now),
      ),
    )
    .returning({ id: schema.signedKeyPendingKeys.id });
  return deleted.length === 1;
}

/**
 * Deletes expired pending keys across workspaces, at most `batch` per call
 * (scheduler role; prune_signed_key_pending_keys is SECURITY DEFINER,
 * migration 0049). Returns the number deleted.
 */
export async function prunePendingKeys(
  schedulerDb: Db | Transaction,
  batch: number,
): Promise<number> {
  const [row] = await schedulerDb.execute<{ deleted: number }>(
    sql`select prune_signed_key_pending_keys(${batch}) as deleted`,
  );
  return row?.deleted ?? 0;
}
