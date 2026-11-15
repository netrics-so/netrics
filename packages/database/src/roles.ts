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
 * Creates the application roles (NOLOGIN, without privileges) when they do
 * not exist yet. Migration 0001 creates them too, but only once: a database
 * restored into a fresh PostgreSQL server carries a migration journal that
 * says 0001 already ran, while roles are cluster-global and not part of a
 * database dump (#642). Creating them before migrating keeps migrate from
 * failing on such a server. Same race handling as migration 0001.
 */
export async function ensureApplicationRoles(
  sql: postgres.Sql,
  roles: readonly string[] = APPLICATION_ROLES,
): Promise<string[]> {
  const created: string[] = [];
  for (const role of roles) {
    const [row] = await sql<{ statement: string; exists: boolean }[]>`
      select
        format('CREATE ROLE %I NOLOGIN NOINHERIT', ${role}::text) as statement,
        exists (select 1 from pg_roles where rolname = ${role}) as exists
    `;
    if (row!.exists) {
      continue;
    }
    try {
      await sql.unsafe(row!.statement);
      created.push(role);
    } catch (error) {
      // Another migration on the same server created it first.
      if (!isDuplicateRole(error)) {
        throw error;
      }
    }
  }
  return created;
}

function isDuplicateRole(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "42710" || error.code === "23505")
  );
}

export class ApplicationRoleGrantsMissingError extends Error {
  constructor(readonly missing: string[]) {
    super(
      "The application roles lack their privileges on this database " +
        `(${missing.join("; ")}). This happens when a backup is restored ` +
        "before the roles exist: pg_restore then skips every GRANT and " +
        "policy for them. The roles exist now, so run the same pg_restore " +
        "again and start once more (deploy/compose/README.md, " +
        '"Backup and restore").',
    );
    this.name = "ApplicationRoleGrantsMissingError";
  }
}

/**
 * Fails when any of a few anchor privileges that migrations grant the
 * application roles is missing. Restoring a dump while the roles are missing
 * drops all of their grants and policies at once, which these anchors
 * detect; the application would otherwise start and fail on every query.
 */
export async function assertApplicationRoleGrants(
  sql: postgres.Sql,
): Promise<void> {
  const [row] = await sql<
    {
      app_connect: boolean;
      scheduler_connect: boolean;
      app_tables: boolean;
      app_auth: boolean;
      app_policies: boolean;
      scheduler_tables: boolean;
    }[]
  >`
    select
      has_database_privilege('netrics_app', current_database(), 'CONNECT') as app_connect,
      has_database_privilege('netrics_scheduler', current_database(), 'CONNECT') as scheduler_connect,
      has_table_privilege('netrics_app', 'public.workspaces', 'SELECT') as app_tables,
      has_schema_privilege('netrics_app', 'auth', 'USAGE') as app_auth,
      exists (
        select 1 from pg_policies where 'netrics_app' = any(roles)
      ) as app_policies,
      has_table_privilege('netrics_scheduler', 'public.jobs', 'SELECT') as scheduler_tables
  `;
  const missing: string[] = [];
  if (!row!.app_connect) {
    missing.push("netrics_app cannot connect to this database");
  }
  if (!row!.scheduler_connect) {
    missing.push("netrics_scheduler cannot connect to this database");
  }
  if (!row!.app_tables) {
    missing.push("netrics_app cannot read public.workspaces");
  }
  if (!row!.app_auth) {
    missing.push("netrics_app cannot use schema auth");
  }
  if (!row!.app_policies) {
    missing.push("no row-level security policy names netrics_app");
  }
  if (!row!.scheduler_tables) {
    missing.push("netrics_scheduler cannot read public.jobs");
  }
  if (missing.length > 0) {
    throw new ApplicationRoleGrantsMissingError(missing);
  }
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
