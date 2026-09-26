import path from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import * as authSchema from "./auth-schema.js";
import * as schema from "./schema.js";

export * as authSchema from "./auth-schema.js";
export * as schema from "./schema.js";
export {
  BOOTSTRAP_CONFLICT_SQLSTATE,
  bootstrapWorkspace,
  createWorkspace,
  createWorkspaceInTransaction,
  hasSqlstate,
  isDuplicateMembershipError,
  isLastOwnerError,
  withUserContext,
  withWorkspace,
} from "./context.js";
export type {
  Db,
  Transaction,
  UserContext,
  WorkspaceContext,
} from "./context.js";
export {
  findUserByAuthUserId,
  findUserByEmail,
  findUserById,
  listMembershipsForUser,
  provisionDomainUser,
} from "./users.js";
export type { DomainUser, MembershipInfo } from "./users.js";
export {
  addMembership,
  createProject,
  createWorkspaceWithOwner,
  deleteMembership,
  deleteProject,
  findMembership,
  findProject,
  findWorkspace,
  insertAuditEvent,
  insertInstallationAuditEvent,
  listAuditEvents,
  listMembers,
  listProjects,
  renameProject,
  renameWorkspace,
  setActiveProject,
  updateMembershipRole,
} from "./workspaces.js";
export type {
  AuditEvent,
  AuditEventInput,
  MemberDetails,
  Membership,
  Project,
  Workspace,
} from "./workspaces.js";

export type Database = ReturnType<typeof createDatabase>;

// SQL migrations ship inside this package so standalone production images can
// migrate without drizzle-kit (a dev dependency).
export const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "drizzle",
);

export type { Sql } from "postgres";

/** Raw postgres.js client for tests/tooling that need untyped SQL access. */
export function createRawSqlClient(
  databaseUrl: string,
  options: postgres.Options<Record<string, never>> = {},
) {
  return postgres(databaseUrl, options);
}

export async function runMigrations(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
}

export function createDatabase(databaseUrl: string) {
  const client = postgres(databaseUrl);
  // The drizzle instance carries the domain tables and the generated
  // better-auth tables (schema "auth") so the server auth adapter can share
  // one connection.
  return drizzle(client, { schema: { ...schema, ...authSchema } });
}

export async function checkDatabaseConnection(
  databaseUrl: string,
  timeoutMs = 2000,
): Promise<boolean> {
  const client = postgres(databaseUrl, {
    max: 1,
    connect_timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
    idle_timeout: 1,
  });
  try {
    await client`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await client.end({ timeout: 0 }).catch(() => undefined);
  }
}
