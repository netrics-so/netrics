import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";

import * as authSchema from "./auth-schema.js";
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

/**
 * The token service's view of a grant, locked for update (ADR 0012:
 * refresh is serialized per connection). A concurrent caller waits here
 * until the holder commits and then reads the refreshed token. Also returns
 * the connection's credentials envelope (the refresh token).
 */
export async function lockConnectionOAuth(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
): Promise<{
  oauth: ConnectionOAuthRow;
  credentialsEncrypted: Buffer | null;
} | null> {
  const [oauth] = await tx
    .select()
    .from(schema.connectionOAuth)
    .where(
      and(
        eq(schema.connectionOAuth.workspaceId, workspaceId),
        eq(schema.connectionOAuth.connectionId, connectionId),
      ),
    )
    .for("update")
    .limit(1);
  if (!oauth) {
    return null;
  }
  const [connection] = await tx
    .select({ credentialsEncrypted: schema.connections.credentialsEncrypted })
    .from(schema.connections)
    .where(
      and(
        eq(schema.connections.workspaceId, workspaceId),
        eq(schema.connections.id, connectionId),
      ),
    )
    .limit(1);
  return {
    oauth,
    credentialsEncrypted: connection?.credentialsEncrypted ?? null,
  };
}

export interface OAuthTokenUpdate {
  /** The new access-token envelope and its expiry; both or neither. */
  accessTokenEncrypted: Buffer | null;
  accessTokenExpiresAt: Date | null;
  /** Scopes the provider reports for the grant, when it reports them. */
  grantedScopes?: string[];
  /** A rotated refresh token's credentials envelope, when one was issued. */
  credentialsEncrypted?: Buffer;
}

/** Stores the outcome of a refresh (or clears the cached access token). */
export async function updateConnectionOAuthTokens(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
  update: OAuthTokenUpdate,
): Promise<void> {
  await tx
    .update(schema.connectionOAuth)
    .set({
      accessTokenEncrypted: update.accessTokenEncrypted,
      accessTokenExpiresAt: update.accessTokenExpiresAt,
      ...(update.grantedScopes ? { grantedScopes: update.grantedScopes } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.connectionOAuth.workspaceId, workspaceId),
        eq(schema.connectionOAuth.connectionId, connectionId),
      ),
    );
  if (update.credentialsEncrypted) {
    await tx
      .update(schema.connections)
      .set({
        credentialsEncrypted: update.credentialsEncrypted,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.connections.workspaceId, workspaceId),
          eq(schema.connections.id, connectionId),
        ),
      );
  }
}

export type OAuthAuthReason = "invalid_grant" | "scope_missing";

/**
 * Moves a connection to needs_reauthorization (ADR 0012). The scheduler
 * skips it until a reauthorization resets the state.
 */
export async function markNeedsReauthorization(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
  reason: OAuthAuthReason,
): Promise<void> {
  await tx
    .update(schema.connectionState)
    .set({ authState: "needs_reauthorization", authReason: reason })
    .where(
      and(
        eq(schema.connectionState.workspaceId, workspaceId),
        eq(schema.connectionState.connectionId, connectionId),
      ),
    );
}

interface ReleaseRow extends Record<string, unknown> {
  shared: boolean;
}

/**
 * Disconnect (ADR 0012): takes a transaction advisory lock on
 * (provider, sub) until commit and reports whether another connection on
 * the instance, in any workspace, still holds a grant for the same account.
 * Call it inside the deleting withWorkspace transaction, before the delete;
 * revoke at the provider after commit only when it returned false. Raises
 * when the connection does not hold this grant.
 */
export async function releaseOAuthGrant(
  tx: Transaction,
  input: { provider: string; accountSub: string; connectionId: string },
): Promise<boolean> {
  const rows = await tx.execute<ReleaseRow>(
    sql`select oauth_release_grant(${input.provider}, ${input.accountSub}, ${input.connectionId}::uuid) as shared`,
  );
  return rows[0]?.shared === true;
}

/**
 * Whether any connection on the instance holds a grant of this provider
 * account (SECURITY DEFINER, migration 0024; a boolean only). The
 * non-deleting counterpart of releaseOAuthGrant, for a caller that has no
 * connection holding the grant: the callback revokes a refused grant only
 * when this is false, so it never stops another connection's access. Takes
 * the account's grant lock for the transaction; call it while holding
 * withOAuthGrantLocks for the account so the revocation that follows is
 * covered too.
 */
export async function oauthAccountHasGrant(
  db: Db | Transaction,
  provider: string,
  accountSub: string,
): Promise<boolean> {
  const [row] = await db.execute<{ has_grant: boolean }>(
    sql`select oauth_account_has_grant(${provider}, ${accountSub}) as has_grant`,
  );
  return row?.has_grant === true;
}

/**
 * Deletes consumed and expired authorization rows, at most `batch` per call
 * (scheduler role; prune_oauth_authorizations is SECURITY DEFINER, migration
 * 0024). Returns the number deleted.
 */
export async function pruneOAuthAuthorizations(
  schedulerDb: Db | Transaction,
  batch: number,
): Promise<number> {
  const [row] = await schedulerDb.execute<{ deleted: number }>(
    sql`select prune_oauth_authorizations(${batch}) as deleted`,
  );
  return row?.deleted ?? 0;
}

/** One provider account: the unit of the grant lock (ADR 0012). */
export interface OAuthGrantKey {
  provider: string;
  accountSub: string;
}

/** Deterministic lock order (provider, then sub), without duplicates. */
function lockOrder(keys: readonly OAuthGrantKey[]): OAuthGrantKey[] {
  const unique = new Map<string, OAuthGrantKey>();
  for (const key of keys) {
    unique.set(`${key.provider}\u001f${key.accountSub}`, key);
  }
  return [...unique.values()].sort((a, b) =>
    a.provider === b.provider
      ? a.accountSub < b.accountSub
        ? -1
        : a.accountSub > b.accountSub
          ? 1
          : 0
      : a.provider < b.provider
        ? -1
        : 1,
  );
}

type ReservedSql = Awaited<ReturnType<postgres.Sql["reserve"]>>;

/** A pooled database handle (createDatabase). */
type PooledDb = Db & { $client: postgres.Sql };

/**
 * A drizzle handle over one reserved connection. postgres.js gives a
 * reserved connection no begin(), so transactions are opened here with
 * BEGIN/COMMIT on that connection; nested transactions (savepoints) are not
 * needed by the callers and refused.
 */
function reservedDatabase(parent: PooledDb, reserved: ReservedSql): PooledDb {
  const client = parent.$client;
  const noSavepoints = () => {
    throw new Error(
      "withOAuthGrantLocks: nested transactions are not supported",
    );
  };
  const shim = {
    options: client.options,
    unsafe: reserved.unsafe.bind(reserved),
    savepoint: noSavepoints,
    begin: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      await reserved.unsafe("begin");
      try {
        const result = await fn({
          options: client.options,
          unsafe: reserved.unsafe.bind(reserved),
          savepoint: noSavepoints,
        });
        await reserved.unsafe("commit");
        return result;
      } catch (error) {
        await reserved.unsafe("rollback").catch(() => undefined);
        throw error;
      }
    },
  };
  return drizzle(shim as unknown as postgres.Sql, {
    schema: { ...schema, ...authSchema },
  });
}

/**
 * Runs `fn` while holding the session-level grant lock of every account in
 * `keys` (ADR 0012, "Grant lock"; the key is derived only by
 * oauth_grant_lock, migration 0024, which oauth_release_grant and
 * oauth_account_has_grant also take). The hold outlives transactions: a
 * disconnect keeps it from its shared-grant check through the revocation
 * HTTP call, and a callback from before it stores a grant until any
 * revocation of a refused or released grant is done, so no grant of the
 * account can be stored between a check and the provider's account-wide
 * revocation.
 *
 * The locks are taken on one reserved pool connection, in a deterministic
 * order (so two holders of overlapping account sets cannot deadlock), and
 * released in `finally` on that same connection before it goes back to the
 * pool. `fn` gets a database handle on that connection: transactions it
 * opens there (withWorkspace) run in the lock-holding session, where the
 * transaction-level lock of oauth_release_grant is reentrant. Using the
 * pool handle inside `fn` for the same account would wait on itself, and
 * `lockedDb` cannot nest another withOAuthGrantLocks.
 */
export async function withOAuthGrantLocks<T>(
  db: PooledDb,
  keys: readonly OAuthGrantKey[],
  fn: (lockedDb: PooledDb) => Promise<T>,
): Promise<T> {
  const ordered = lockOrder(keys);
  const reserved = await db.$client.reserve();
  const held: OAuthGrantKey[] = [];
  try {
    for (const key of ordered) {
      await reserved`select oauth_grant_lock(${key.provider}, ${key.accountSub}, 'session')`;
      held.push(key);
    }
    return await fn(reservedDatabase(db, reserved));
  } finally {
    let released = true;
    for (const key of held.reverse()) {
      try {
        await reserved`select oauth_grant_lock(${key.provider}, ${key.accountSub}, 'unlock')`;
      } catch {
        released = false;
      }
    }
    if (!released) {
      // Never hand a connection that may still hold a lock back to the pool.
      await reserved`select pg_advisory_unlock_all()`.catch(() => undefined);
    }
    reserved.release();
  }
}
