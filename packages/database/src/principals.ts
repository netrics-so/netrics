import { and, desc, eq, isNull, sql } from "drizzle-orm";

import type { Db, Transaction } from "./context.js";
import { principalTokens, users } from "./schema.js";

type Executor = Db | Transaction;

export type PrincipalKind = "service" | "device";

export interface TokenPrincipal {
  tokenId: string;
  kind: PrincipalKind;
  name: string;
  scopes: string[];
  workspaceId: string | null;
}

/**
 * Resolves a bearer token (by hash) to its principal, or null when unknown,
 * revoked or expired. Runs as the application role through a SECURITY
 * DEFINER function: the role itself has no access to principal_tokens.
 */
export async function resolvePrincipalToken(
  db: Executor,
  tokenHash: string,
): Promise<TokenPrincipal | null> {
  const rows = await db.execute<{
    id: string;
    kind: PrincipalKind;
    name: string;
    scopes: string[];
    workspace_id: string | null;
  }>(sql`select * from resolve_principal_token(${tokenHash})`);
  const row = rows[0];
  return row
    ? {
        tokenId: row.id,
        kind: row.kind,
        name: row.name,
        scopes: row.scopes,
        workspaceId: row.workspace_id,
      }
    : null;
}

export async function isInstanceAdmin(
  db: Executor,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ admin: users.isInstanceAdmin })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.admin === true;
}

export interface AdminWorkspace {
  id: string;
  name: string;
  createdAt: Date;
  memberCount: number;
}

/** Cross-workspace listing for the admin API; callers authorize first. */
export async function adminListWorkspaces(
  db: Executor,
): Promise<AdminWorkspace[]> {
  const rows = await db.execute<{
    id: string;
    name: string;
    created_at: string | Date;
    member_count: string | number;
  }>(sql`select * from admin_list_workspaces()`);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: new Date(row.created_at),
    memberCount: Number(row.member_count),
  }));
}

// ---------------------------------------------------------------------------
// Operator functions: run with the owner role (DATABASE_MIGRATION_URL) from
// the server image's admin CLI. The application role cannot call these.
// ---------------------------------------------------------------------------

export async function createServiceToken(
  ownerDb: Executor,
  input: {
    name: string;
    tokenHash: string;
    scopes: string[];
    expiresAt: Date | null;
  },
): Promise<{ id: string }> {
  const [row] = await ownerDb
    .insert(principalTokens)
    .values({
      kind: "service",
      name: input.name,
      tokenHash: input.tokenHash,
      scopes: input.scopes,
      expiresAt: input.expiresAt,
    })
    .returning({ id: principalTokens.id });
  return row!;
}

export async function listPrincipalTokens(ownerDb: Executor) {
  return ownerDb
    .select({
      id: principalTokens.id,
      kind: principalTokens.kind,
      name: principalTokens.name,
      scopes: principalTokens.scopes,
      workspaceId: principalTokens.workspaceId,
      createdAt: principalTokens.createdAt,
      expiresAt: principalTokens.expiresAt,
      lastUsedAt: principalTokens.lastUsedAt,
      revokedAt: principalTokens.revokedAt,
    })
    .from(principalTokens)
    .orderBy(desc(principalTokens.createdAt));
}

export async function revokePrincipalToken(
  ownerDb: Executor,
  tokenId: string,
): Promise<boolean> {
  const rows = await ownerDb
    .update(principalTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(principalTokens.id, tokenId), isNull(principalTokens.revokedAt)),
    )
    .returning({ id: principalTokens.id });
  return rows.length === 1;
}
