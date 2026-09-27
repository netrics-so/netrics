import { randomBytes } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEV_ROLE_PASSWORDS,
  PrivilegedDatabaseRoleError,
  assertUnprivilegedRole,
  findRolesWithDefaultPasswords,
  setRolePassword,
} from "./roles.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});

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
