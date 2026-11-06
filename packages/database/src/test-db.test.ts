import { randomBytes } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withRoleCatalogLock } from "./test-db.js";

const serverUrl =
  process.env.NETRICS_TEST_ADMIN_URL ??
  "postgres://netrics:netrics@localhost:5433/postgres";

describe("withRoleCatalogLock", () => {
  // A throwaway role: the application roles are shared with other test files.
  const role = `netrics_test_role_${randomBytes(4).toString("hex")}`;
  let admin: postgres.Sql;

  beforeAll(async () => {
    admin = postgres(serverUrl, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE ROLE ${role} NOLOGIN`);
  });

  afterAll(async () => {
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end({ timeout: 5 });
  });

  it("serialises concurrent updates of one role (no tuple concurrently updated)", async () => {
    // Without the lock, parallel ALTER ROLE statements on one pg_authid row
    // fail with XX000 "tuple concurrently updated" (issue #351). The raw
    // statement has no retry, so any overlap would reject here.
    const results = await Promise.allSettled(
      Array.from({ length: 24 }, (_, index) =>
        withRoleCatalogLock((sql) =>
          sql.unsafe(`ALTER ROLE ${role} WITH LOGIN PASSWORD 'p${index}'`),
        ),
      ),
    );
    expect(results.filter((result) => result.status === "rejected")).toEqual(
      [],
    );
  });
});
