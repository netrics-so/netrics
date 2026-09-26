import { sql } from "drizzle-orm";
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
  db: Db,
  ctx: WorkspaceContext,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const workspaceId = uuidSchema.parse(ctx.workspaceId);
  const userId = ctx.userId ? uuidSchema.parse(ctx.userId) : undefined;
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.workspace_id', ${workspaceId}, true)`,
    );
    if (userId) {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    }
    return fn(tx);
  });
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
 */
export async function createWorkspace(
  db: Db,
  input: { name: string; ownerUserId: string },
): Promise<string> {
  const name = z.string().min(1).parse(input.name);
  const ownerUserId = uuidSchema.parse(input.ownerUserId);
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: string }>(
      sql`select create_workspace(${name}, ${ownerUserId}::uuid) as id`,
    );
    const row = rows[0];
    if (!row) {
      throw new Error("create_workspace returned no row");
    }
    return row.id;
  });
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
