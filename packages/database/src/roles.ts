import postgres from "postgres";

/** The login roles the application connects as (created by migrations). */
export const APPLICATION_ROLES = ["netrics_app", "netrics_scheduler"] as const;
export type ApplicationRole = (typeof APPLICATION_ROLES)[number];

export type RolePasswords = Partial<Record<ApplicationRole, string>>;

/**
 * Well-known development passwords. Local setups and tests provision them;
 * production refuses to run with them (see assertNoDefaultRolePasswords).
 */
export const DEV_ROLE_PASSWORDS: Record<ApplicationRole, string> = {
  netrics_app: "netrics_app",
  netrics_scheduler: "netrics_scheduler",
};

/**
 * Enables LOGIN with the given password for one role. DDL cannot take bind
 * parameters, so the server quotes identifier and literal via format().
 */
export async function setRolePassword(
  sql: postgres.Sql,
  role: string,
  password: string,
): Promise<void> {
  const [row] = await sql<{ statement: string }[]>`
    select format('ALTER ROLE %I WITH LOGIN PASSWORD %L', ${role}::text, ${password}::text) as statement
  `;
  // Roles are cluster-global: migrations of several databases on one server
  // (parallel test files, multi-database installations) can alter the same
  // role at once and lose with "tuple concurrently updated". Retry briefly.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await sql.unsafe(row!.statement);
      return;
    } catch (error) {
      if (!isConcurrentCatalogUpdate(error) || attempt >= 10) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
    }
  }
}

function isConcurrentCatalogUpdate(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "XX000" &&
    error.message.includes("tuple concurrently updated")
  );
}

/**
 * Sets LOGIN and the given password on each application role. Migrations
 * create the roles without credentials; this is the only place passwords are
 * assigned. Must run as a role allowed to alter them (owner/superuser or
 * CREATEROLE). Roles without a supplied password are left untouched.
 */
export async function provisionRolePasswords(
  sql: postgres.Sql,
  passwords: RolePasswords,
): Promise<ApplicationRole[]> {
  const provisioned: ApplicationRole[] = [];
  for (const role of APPLICATION_ROLES) {
    const password = passwords[role];
    if (password === undefined) {
      continue;
    }
    await setRolePassword(sql, role, password);
    provisioned.push(role);
  }
  return provisioned;
}

/**
 * Returns the application roles that still accept their public development
 * password on the server behind `databaseUrl`. Used by production migrations
 * to refuse installations running with credentials published in this
 * repository.
 */
export async function findRolesWithDefaultPasswords(
  databaseUrl: string,
): Promise<ApplicationRole[]> {
  const exposed: ApplicationRole[] = [];
  for (const role of APPLICATION_ROLES) {
    const url = new URL(databaseUrl);
    url.username = role;
    url.password = DEV_ROLE_PASSWORDS[role];
    const client = postgres(url.toString(), {
      max: 1,
      connect_timeout: 5,
      idle_timeout: 1,
      onnotice: () => undefined,
    });
    try {
      await client`select 1`;
      exposed.push(role);
    } catch {
      // Rejected login is the expected, safe outcome.
    } finally {
      await client.end({ timeout: 1 }).catch(() => undefined);
    }
  }
  return exposed;
}

export interface RolePrivileges {
  role: string;
  superuser: boolean;
  bypassRls: boolean;
}

export async function inspectCurrentRole(
  databaseUrl: string,
): Promise<RolePrivileges> {
  const client = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    const [row] = await client<
      { role: string; superuser: boolean; bypass_rls: boolean }[]
    >`
      select rolname as role, rolsuper as superuser, rolbypassrls as bypass_rls
      from pg_roles where rolname = current_user
    `;
    return {
      role: row!.role,
      superuser: row!.superuser,
      bypassRls: row!.bypass_rls,
    };
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
}

export class PrivilegedDatabaseRoleError extends Error {
  constructor(privileges: RolePrivileges) {
    const reason = privileges.superuser
      ? "a superuser"
      : "allowed to bypass RLS";
    super(
      `Database role "${privileges.role}" is ${reason}. Row-level security ` +
        "would not isolate workspaces. Connect as the unprivileged " +
        "application role (netrics_app / netrics_scheduler) instead.",
    );
    this.name = "PrivilegedDatabaseRoleError";
  }
}

/**
 * Throws when the connection's role is a superuser or has BYPASSRLS — in
 * either case PostgreSQL skips row-level security, even FORCE RLS.
 */
export async function assertUnprivilegedRole(
  databaseUrl: string,
): Promise<RolePrivileges> {
  const privileges = await inspectCurrentRole(databaseUrl);
  if (privileges.superuser || privileges.bypassRls) {
    throw new PrivilegedDatabaseRoleError(privileges);
  }
  return privileges;
}
