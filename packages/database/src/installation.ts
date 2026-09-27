import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

import type { Db, Transaction } from "./context.js";
import { installationSetup, users } from "./schema.js";

type Executor = Db | Transaction;

export async function countUsers(db: Executor): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users);
  return row?.count ?? 0;
}

/**
 * Stores the hash of a fresh setup token, replacing any previous one. Only
 * meaningful while the installation has no users.
 */
export async function issueSetupToken(db: Executor, tokenHash: string) {
  await db
    .insert(installationSetup)
    .values({ id: 1, tokenHash })
    .onConflictDoUpdate({
      target: installationSetup.id,
      set: {
        tokenHash,
        issuedAt: new Date(),
        consumedAt: null,
        ownerUserId: null,
      },
    });
}

/**
 * Atomically marks the setup token as used. Returns false when the token is
 * wrong or was already consumed, so exactly one sign-up can win.
 */
export async function consumeSetupToken(
  db: Executor,
  tokenHash: string,
): Promise<boolean> {
  const rows = await db
    .update(installationSetup)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(installationSetup.tokenHash, tokenHash),
        isNull(installationSetup.consumedAt),
      ),
    )
    .returning({ id: installationSetup.id });
  return rows.length === 1;
}

/** Records the account created with the consumed setup token. */
export async function recordSetupOwner(db: Executor, userId: string) {
  await db
    .update(installationSetup)
    .set({ ownerUserId: userId })
    .where(
      and(
        isNotNull(installationSetup.consumedAt),
        isNull(installationSetup.ownerUserId),
      ),
    );
}

export async function findInstallationSetup(db: Executor) {
  const [row] = await db.select().from(installationSetup).limit(1);
  return row ?? null;
}
