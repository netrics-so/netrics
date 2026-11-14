import postgres from "postgres";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
  type TestDatabase,
} from "./test-db.js";

// Migration 0028 (#166) on metric definitions in the previous shape: every
// existing definition becomes a "primary" metric; only the two roles are
// allowed.

const LAST_BEFORE = "0027_gsc_zero_impressions";

let testDb: TestDatabase;
let adminUrl: string;

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: LAST_BEFORE });
  adminUrl = testDb.adminUrl;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

// The test applies the remaining migrations.
vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

describe("migration 0028 on stored metric definitions", () => {
  it("makes existing definitions primary and allows only the two roles", async () => {
    const owner = postgres(adminUrl, { max: 1, onnotice: () => undefined });
    try {
      await owner`insert into connectors (id, version, manifest) values
        ('c', '1.0.0', ${owner.json({ id: "c" })})`;
      for (const key of ["c.clicks", "c.position_sum"]) {
        await owner`
          insert into metric_definitions
            (connector_id, key, name, description, kind, unit, granularity,
             dimensions, aggregations, better)
          values ('c', ${key}, ${key}, ${key}, 'delta', 'x', 'day',
                  ${owner.json(["resource"])}, ${owner.json(["sum"])}, 'lower')`;
      }

      await testDb.migrate();

      const rows = await owner`
        select key, better, role from metric_definitions order by key`;
      expect(rows.map((row) => ({ ...row }))).toEqual([
        { key: "c.clicks", better: "lower", role: "primary" },
        { key: "c.position_sum", better: "lower", role: "primary" },
      ]);
      await owner`
        update metric_definitions set role = 'helper'
        where key = 'c.position_sum'`;
      await expect(
        owner`update metric_definitions set role = 'hidden' where key = 'c.clicks'`,
      ).rejects.toThrow(/metric_definitions_role_valid/);
    } finally {
      await owner.end({ timeout: 5 });
    }
  });
});
