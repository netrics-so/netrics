import { and, eq, sql } from "drizzle-orm";

import type { Db, Transaction } from "./context.js";
import * as schema from "./schema.js";

// OAuth records (ADR 0012) for the API and the token service (netrics_app).
// Inside withWorkspace every query also names the workspace explicitly
// (defense in depth). The callback, which does not know the workspace yet,
// goes through consume_oauth_authorization() only.

export type OAuthAuthorizationRow =
  typeof schema.oauthAuthorizations.$inferSelect;
export type ConnectionOAuthRow = typeof schema.connectionOAuth.$inferSelect;

export type OAuthAuthorizationPurpose = "connect" | "reauthorize";

export interface NewOAuthAuthorization {
  /** Chosen by the caller: the PKCE verifier envelope is bound to it. */
  id: string;
  workspaceId: string;
  userId: string;
  provider: string;
  connectorId: string;
  /** The connection to reauthorize; null for a new connection. */
  connectionId: string | null;
  purpose: OAuthAuthorizationPurpose;
  allowAccountChange: boolean;
  returnPath: string;
  /** SHA-256 of the state, never the state. */
  stateHash: string;
  nonce: string;
  codeVerifierEncrypted: Buffer;
  expiresAt: Date;
}

export async function insertOAuthAuthorization(
  tx: Transaction,
  input: NewOAuthAuthorization,
): Promise<OAuthAuthorizationRow> {
  const [row] = await tx
    .insert(schema.oauthAuthorizations)
    .values(input)
    .returning();
  if (!row) {
    throw new Error("oauth authorization insert returned no row");
  }
  return row;
}

/** What the callback learns from a consumed state. */
export interface ConsumedOAuthAuthorization {
  id: string;
  workspaceId: string;
  userId: string;
  provider: string;
  connectorId: string;
  connectionId: string | null;
  purpose: OAuthAuthorizationPurpose;
  allowAccountChange: boolean;
  returnPath: string;
  nonce: string;
  codeVerifierEncrypted: Buffer;
}

interface ConsumedRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  user_id: string;
  provider: string;
  connector_id: string;
  connection_id: string | null;
  purpose: OAuthAuthorizationPurpose;
  allow_account_change: boolean;
  return_path: string;
  nonce: string;
  code_verifier_encrypted: Buffer;
}

/**
 * Looks an authorization up by the SHA-256 of its state and consumes it in
 * one statement (SECURITY DEFINER, no tenant context needed). Returns null
 * for unknown, expired or already consumed states: a state works once.
 */
export async function consumeOAuthAuthorization(
  db: Db | Transaction,
  stateHash: string,
): Promise<ConsumedOAuthAuthorization | null> {
  const rows = await db.execute<ConsumedRow>(
    sql`select * from consume_oauth_authorization(${stateHash})`,
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    provider: row.provider,
    connectorId: row.connector_id,
    connectionId: row.connection_id,
    purpose: row.purpose,
    allowAccountChange: row.allow_account_change,
    returnPath: row.return_path,
    nonce: row.nonce,
    codeVerifierEncrypted: row.code_verifier_encrypted,
  };
}

export interface ConnectionOAuthInput {
  workspaceId: string;
  connectionId: string;
  provider: string;
  accountSub: string;
  accountEmail: string | null;
  grantedScopes: string[];
  /** Access-token envelope and its expiry; both or neither. */
  accessTokenEncrypted: Buffer | null;
  accessTokenExpiresAt: Date | null;
}

/** Creates or replaces the OAuth grant record of a connection. */
export async function upsertConnectionOAuth(
  tx: Transaction,
  input: ConnectionOAuthInput,
): Promise<ConnectionOAuthRow> {
  const {
    workspaceId: _workspaceId,
    connectionId: _connectionId,
    ...rest
  } = input;
  const [row] = await tx
    .insert(schema.connectionOAuth)
    .values(input)
    .onConflictDoUpdate({
      target: schema.connectionOAuth.connectionId,
      set: { ...rest, updatedAt: new Date() },
      // The conflicting row must be in the same workspace; RLS agrees.
      setWhere: eq(schema.connectionOAuth.workspaceId, input.workspaceId),
    })
    .returning();
  if (!row) {
    throw new Error(
      "connection oauth upsert returned no row (connection in another workspace?)",
    );
  }
  return row;
}

/** The full grant record, token envelope included: token service only. */
export async function findConnectionOAuth(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
): Promise<ConnectionOAuthRow | null> {
  const [row] = await tx
    .select()
    .from(schema.connectionOAuth)
    .where(
      and(
        eq(schema.connectionOAuth.workspaceId, workspaceId),
        eq(schema.connectionOAuth.connectionId, connectionId),
      ),
    )
    .limit(1);
  return row ?? null;
}
