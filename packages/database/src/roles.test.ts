import { randomBytes } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "./index.js";
import {
  ApplicationRoleGrantsMissingError,
  DEV_ROLE_PASSWORDS,
  PrivilegedDatabaseRoleError,
  assertUnprivilegedRole,
  ensureApplicationRoles,
  findRolesWithDefaultPasswords,
  setRolePassword,
} from "./roles.js";
import {
  createTestDatabase,
  type TestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

describe("assertUnprivilegedRole", () => {
  it("accepts the application role", async () => {
    await expect(assertUnprivilegedRole(testDb.appUrl)).resolves.toMatchObject({
      role: "netrics_app",
      superuser: false,
      bypassRls: false,
    });
  });

  it("rejects a superuser connection", async () => {
    await expect(assertUnprivilegedRole(testDb.adminUrl)).rejects.toThrow(
      PrivilegedDatabaseRoleError,
    );
  });
});

describe("findRolesWithDefaultPasswords", () => {
  it("reports roles provisioned with the development passwords", async () => {
    // Test databases provision DEV_ROLE_PASSWORDS (see test-db.ts).
    expect(Object.keys(DEV_ROLE_PASSWORDS)).toHaveLength(2);
    await expect(
      findRolesWithDefaultPasswords(testDb.adminUrl),
    ).resolves.toEqual(["netrics_app", "netrics_scheduler"]);
  });
});

describe("setRolePassword", () => {
  // Roles are cluster-global and other test files log in as netrics_app
  // concurrently, so exercise the quoting on a throwaway role.
  const role = `netrics_test_role_${randomBytes(4).toString("hex")}`;
  let admin: postgres.Sql;

  beforeAll(async () => {
    admin = postgres(testDb.adminUrl, { max: 1 });
    await admin.unsafe(`CREATE ROLE ${role} NOLOGIN`);
  });

  afterAll(async () => {
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end({ timeout: 5 });
  });

  it("enables login with a password containing quotes and backslashes", async () => {
    const password = `it's "tricky" \\ ${randomBytes(8).toString("hex")}`;
    await setRolePassword(admin, role, password);

    const url = new URL(testDb.adminUrl);
    url.username = role;
    url.password = encodeURIComponent(password);
    const client = postgres(url.toString(), { max: 1, connect_timeout: 5 });
    try {
      const [row] = await client<
        { user: string }[]
      >`select current_user as user`;
      expect(row!.user).toBe(role);
    } finally {
      await client.end({ timeout: 5 });
    }
  });
});

describe("ensureApplicationRoles", () => {
  // The real roles exist on the shared test server; a throwaway name shows
  // creation without touching them.
  const role = `netrics_test_role_${randomBytes(4).toString("hex")}`;
  let admin: postgres.Sql;

  beforeAll(() => {
    admin = postgres(testDb.adminUrl, { max: 1, onnotice: () => undefined });
  });

  afterAll(async () => {
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end({ timeout: 5 });
  });

  it("creates missing roles without login, and only once", async () => {
    await expect(ensureApplicationRoles(admin, [role])).resolves.toEqual([
      role,
    ]);
    const [row] = await admin<{ login: boolean; inherit: boolean }[]>`
      select rolcanlogin as login, rolinherit as inherit
      from pg_roles where rolname = ${role}
    `;
    expect(row).toEqual({ login: false, inherit: false });
    await expect(ensureApplicationRoles(admin, [role])).resolves.toEqual([]);
  });

  it("leaves the existing application roles alone", async () => {
    await expect(ensureApplicationRoles(admin)).resolves.toEqual([]);
  });
});

describe("runMigrations on a database whose role grants are gone", () => {
  // A dump restored while the application roles did not exist loses every
  // GRANT and policy for them, while its journal says all migrations ran
  // (#642). Migrating must refuse instead of starting a broken instance.
  let restored: TestDatabase;
  let admin: postgres.Sql;

  beforeAll(async () => {
    restored = await createTestDatabase();
    admin = postgres(restored.adminUrl, { max: 1, onnotice: () => undefined });
  }, TEST_DATABASE_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await admin.end({ timeout: 5 });
    await restored.drop();
  });

  it("passes on a migrated database", async () => {
    await expect(runMigrations(restored.adminUrl)).resolves.toBeUndefined();
  });

  it("fails with restore guidance when the grants are missing", async () => {
    await admin.unsafe(
      "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM netrics_app, netrics_scheduler",
    );
    await admin.unsafe("REVOKE ALL ON SCHEMA auth FROM netrics_app");
    const error = await runMigrations(restored.adminUrl).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ApplicationRoleGrantsMissingError);
    expect((error as ApplicationRoleGrantsMissingError).missing).toEqual([
      "netrics_app cannot read public.workspaces",
      "netrics_app cannot use schema auth",
      "netrics_scheduler cannot read public.jobs",
    ]);
    expect((error as Error).message).toContain("Backup and restore");
  });
});
