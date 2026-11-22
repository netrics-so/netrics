import { sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import * as authSchema from "./auth-schema.js";
import * as schema from "./schema.js";

// The application database handle always carries the domain tables plus the
// generated better-auth tables (schema "auth"); see createDatabase().
export type Db = PostgresJsDatabase<typeof schema & typeof authSchema>;

export type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface WorkspaceContext {
  workspaceId: string;
  userId?: string;
}

export interface UserContext {
  userId: string;
}

// Defense in depth: the values land in a set_config parameter (already safe),
// but rejecting non-UUIDs here also catches context-wiring bugs early.
const uuidSchema = z.uuid();

/**
 * Runs `fn` inside a transaction scoped to a workspace (and optionally the
 * acting user). The RLS policies read app.workspace_id / app.user_id, which
 * set_config(..., true) keeps transaction-local.
 */
export async function withWorkspace<T>(
  db: Pick<Db, "transaction">,
  ctx: WorkspaceContext,
  fn: (tx: Transaction) => Promise<T>,
  options?: {
    isolationLevel?: "read committed" | "repeatable read" | "serializable";
    accessMode?: "read only" | "read write";
    /**
     * Table locks taken first, before set_config (a SELECT) takes the
     * snapshot of a repeatable read or serializable transaction: a lock
     * taken after the snapshot still leaves the transaction overlapping the
     * one it waited for, so SSI sees them as concurrent. A lock not granted
     * within `timeoutMs` fails with 55P03 (lock_not_available); the timeout
     * covers only the lock, not the rest of the transaction.
     */
    lockTables?: TableLocks;
    /**
     * How the transaction stands to a deletion of the workspace (#839;
     * workspace_fence, migration 0094). Default "live": it takes the fence
     * and fails with WorkspaceDeletedError when the workspace is deleted, so
     * no work that started before a deletion writes after it. "any" takes
     * the fence but also runs for a deleted workspace: only its purge.
     * "none" takes no fence: only the transaction that calls
     * delete_workspace(), which takes it exclusively itself.
     */
    fence?: "live" | "any" | "none";
  },
): Promise<T> {
  const workspaceId = uuidSchema.parse(ctx.workspaceId);
  const userId = ctx.userId ? uuidSchema.parse(ctx.userId) : undefined;
  const { lockTables, isolationLevel, accessMode } = options ?? {};
  const fence = options?.fence ?? "live";
  // drizzle sends a config without values as an invalid bare SET TRANSACTION.
  const config =
    isolationLevel || accessMode
      ? {
          ...(isolationLevel ? { isolationLevel } : {}),
          ...(accessMode ? { accessMode } : {}),
        }
      : undefined;
  return db.transaction(async (tx) => {
    if (lockTables) await lockTablesFirst(tx, lockTables);
    if (fence === "none") {
      await tx.execute(
        sql`select set_config('app.workspace_id', ${workspaceId}, true)`,
      );
    } else {
      // One statement: the tenant context and the fence, the transaction's
      // first lock for the workspace. Under repeatable read or serializable
      // the fence answers from this transaction's snapshot, which may
      // predate a deletion the lock just waited for; there it also locks
      // the workspace row, which fails (40001) on a row changed since the
      // snapshot. Read-only transactions cannot lock rows and write
      // nothing; they read their snapshot.
      const lockRow =
        fence === "live" &&
        isolationLevel !== undefined &&
        isolationLevel !== "read committed" &&
        accessMode !== "read only";
      const [row] = await tx.execute<{ state: WorkspaceState }>(
        sql`select set_config('app.workspace_id', ${workspaceId}, true),
              workspace_fence(${workspaceId}::uuid, ${lockRow}) as state`,
      );
      // A workspace that is gone altogether (purged, or never there) is
      // refused like a deleted one: nothing can be written for it, and a
      // request that resolved its access before the purge gets the same
      // answer as one that came before it.
      if (fence === "live" && row?.state !== "live") {
        throw new WorkspaceDeletedError(workspaceId);
      }
    }
    if (userId) {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    }
    return fn(tx);
  }, config);
}

/** What workspace_fence() says about a workspace. */
export type WorkspaceState = "live" | "deleted" | "missing";

/** SQLSTATE the database raises for work on a deleted workspace (0094). */
export const WORKSPACE_DELETED_SQLSTATE = "WS001";

/**
 * A transaction was asked to act for a deleted workspace (#839). The API
 * answers it like an unknown workspace; a job ends without retries.
 */
export class WorkspaceDeletedError extends Error {
  readonly code = WORKSPACE_DELETED_SQLSTATE;
  constructor(readonly workspaceId: string) {
    super(`workspace ${workspaceId} is deleted`);
    this.name = "WorkspaceDeletedError";
  }
}

/**
 * Whether an error (or one it wraps) says the workspace is deleted: the
 * fence in withWorkspace, or the database's own refusal.
 */
export function isWorkspaceDeleted(error: unknown): boolean {
  return hasSqlstate(error, WORKSPACE_DELETED_SQLSTATE);
}

/**
 * For a catch that turns unknown errors into something else (a result, a
 * redacted error, a log line): called first, it lets "the workspace is
 * deleted" through as it is, so the API still answers it like an unknown
 * workspace and a job still ends. A test scans the server for catches
 * without it (workspace-gone-catches.test.ts).
 */
export function rethrowWorkspaceGone(error: unknown): void {
  if (isWorkspaceDeleted(error)) throw error;
}

/**
 * The state of a workspace under the fence, for a caller that has no tenant
 * transaction yet (access resolution): the fence is held until `tx` ends.
 */
export async function workspaceState(
  tx: Db | Transaction,
  workspaceId: string,
): Promise<WorkspaceState> {
  const [row] = await tx.execute<{ state: WorkspaceState }>(
    sql`select workspace_fence(${uuidSchema.parse(workspaceId)}::uuid) as state`,
  );
  return row?.state ?? "missing";
}

/** Lock modes withWorkspace takes before the snapshot. */
export type TableLockMode = "share update exclusive" | "share row exclusive";

export interface TableLocks {
  tables: PgTable[];
  mode: TableLockMode;
  /** Upper bound of the wait for the locks (lock_timeout). */
  timeoutMs?: number;
}

const TABLE_LOCK_MODES: Record<TableLockMode, SQL> = {
  "share update exclusive": sql.raw("share update exclusive"),
  "share row exclusive": sql.raw("share row exclusive"),
};

/** SET and LOCK are utility statements: neither takes a snapshot. */
async function lockTablesFirst(tx: Transaction, locks: TableLocks) {
  const timeout = locks.timeoutMs;
  if (timeout !== undefined) {
    if (!Number.isInteger(timeout) || timeout <= 0)
      throw new Error("lock timeout must be a positive integer");
    await tx.execute(sql.raw(`set local lock_timeout = '${timeout}ms'`));
  }
  await tx.execute(
    sql`lock table ${sql.join(
      locks.tables.map((table) => sql`${table}`),
      sql`, `,
    )} in ${TABLE_LOCK_MODES[locks.mode]} mode`,
  );
  if (timeout !== undefined)
    await tx.execute(sql`set local lock_timeout to default`);
}

/**
 * Runs `fn` with only a user context — used for pre-tenant operations such as
 * discovering which workspaces the user belongs to (memberships_select allows
 * user_id = app.user_id).
 */
export async function withUserContext<T>(
  db: Db,
  ctx: UserContext,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const userId = uuidSchema.parse(ctx.userId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}

/**
 * Creates a workspace plus its owner membership via the SECURITY DEFINER
 * create_workspace() SQL function (the only path allowed to insert a
 * workspace without an existing tenant context). Returns the workspace id.
 * Takes an existing transaction so callers can append more work (e.g. audit
 * rows); the function adopts the new workspace as the transaction's tenant
 * context.
 */
export async function createWorkspaceInTransaction(
  tx: Transaction,
  input: { name: string; ownerUserId: string; timeZone?: string },
): Promise<string> {
  const name = z.string().min(1).parse(input.name);
  const ownerUserId = uuidSchema.parse(input.ownerUserId);
  const timeZone = z
    .string()
    .min(1)
    .parse(input.timeZone ?? "UTC");
  const rows = await tx.execute<{ id: string }>(
    sql`select create_workspace(${name}, ${ownerUserId}::uuid, ${timeZone}) as id`,
  );
  const row = rows[0];
  if (!row) {
    throw new Error("create_workspace returned no row");
  }
  return row.id;
}

export async function createWorkspace(
  db: Db,
  input: { name: string; ownerUserId: string },
): Promise<string> {
  return db.transaction((tx) => createWorkspaceInTransaction(tx, input));
}

/** SQLSTATE raised by bootstrap_workspace() once a workspace already exists. */
export const BOOTSTRAP_CONFLICT_SQLSTATE = "23505";

/**
 * First-owner bootstrap: creates the installation's first workspace with the
 * caller as owner via the SECURITY DEFINER bootstrap_workspace() SQL function.
 * The function takes an advisory lock and refuses (SQLSTATE 23505, message
 * "workspace_already_exists") once any workspace exists.
 */
export async function bootstrapWorkspace(
  db: Db,
  input: { name: string; ownerUserId: string },
): Promise<string> {
  const name = z.string().min(1).parse(input.name);
  const ownerUserId = uuidSchema.parse(input.ownerUserId);
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: string }>(
      sql`select bootstrap_workspace(${name}, ${ownerUserId}::uuid) as id`,
    );
    const row = rows[0];
    if (!row) {
      throw new Error("bootstrap_workspace returned no row");
    }
    return row.id;
  });
}

/** Walks the cause chain looking for a PostgreSQL error with the given SQLSTATE. */
export function hasSqlstate(error: unknown, sqlstate: string): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if ((current as { code?: string }).code === sqlstate) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * Codes for a database session that ended under a request (#538): postgres.js
 * reports a closed or destroyed connection, PostgreSQL an administrator,
 * crash or startup shutdown of the backend.
 */
const LOST_CONNECTION_CODES = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "57P01",
  "57P02",
  "57P03",
]);

/**
 * Whether an error (or one it wraps, as drizzle does) means the database
 * connection was lost: transient, so the request may be retried.
 */
export function isLostConnection(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && LOST_CONNECTION_CODES.has(code))
      return true;
    current = current.cause;
  }
  return false;
}

/** Walks the cause chain looking for a PostgreSQL error matching a predicate. */
function findPgError(
  error: unknown,
  match: (code: string | undefined, message: string) => boolean,
): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (match((current as { code?: string }).code, current.message)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * The last-owner trigger (guard_last_workspace_owner) raises a plain
 * EXCEPTION (SQLSTATE P0001); the message is what identifies it.
 */
export function isLastOwnerError(error: unknown): boolean {
  return findPgError(
    error,
    (code, message) => code === "P0001" && message.includes("last owner"),
  );
}

/** Unique violation on memberships(workspace_id, user_id) = already a member. */
export function isDuplicateMembershipError(error: unknown): boolean {
  return findPgError(
    error,
    (code, message) =>
      code === "23505" &&
      message.includes("memberships_workspace_id_user_id_unique"),
  );
}

/** Unique violation on a workspace's goal names (#335). */
export function isDuplicateGoalNameError(error: unknown): boolean {
  return findPgError(
    error,
    (code, message) =>
      code === "23505" && message.includes("goals_name_unique"),
  );
}

/** Unique violation on a workspace's theme names (#216). */
export function isDuplicateThemeNameError(error: unknown): boolean {
  return findPgError(
    error,
    (code, message) =>
      code === "23505" && message.includes("workspace_themes_name_unique"),
  );
}
