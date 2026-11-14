import postgres from "postgres";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
  type TestDatabase,
} from "./test-db.js";

const NOW = new Date("2031-03-15T12:00:00.000Z");

// Migration 0029 (#163) on security records in the previous shape: existing
// audit events, sessions and rate-limit rows survive it, and the first prune
// removes only what is past retention.

const LAST_BEFORE = "0028_metric_role";

let testDb: TestDatabase;
let adminUrl: string;

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: LAST_BEFORE });
  adminUrl = testDb.adminUrl;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

// The test applies the remaining migrations.
vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

describe("migration 0029 on stored security records", () => {
  it("keeps existing rows and prunes only those past retention", async () => {
    const owner = postgres(adminUrl, { max: 1, onnotice: () => undefined });
    try {
      await owner`
        insert into audit_events (workspace_id, action, metadata, created_at)
        values
          (null, 'auth.login', ${owner.json({ ipAddress: "203.0.113.7" })},
           '2030-01-01T00:00:00Z'),
          (null, 'auth.login', ${owner.json({ ipAddress: "203.0.113.8" })},
           '2031-01-01T00:00:00Z')`;
      await owner`
        insert into auth.user (id, name, email, updated_at)
        values ('u1', 'U', 'u@example.com', now())`;
      await owner`
        insert into auth.session
          (id, expires_at, token, created_at, updated_at, ip_address,
           user_agent, user_id)
        values
          ('expired', '2031-03-01 00:00:00', 't1', '2031-02-01 00:00:00',
           '2031-02-01 00:00:00', '203.0.113.7', 'Safari', 'u1'),
          ('live', '2031-03-20 00:00:00', 't2', '2031-03-13 00:00:00',
           '2031-03-13 00:00:00', '203.0.113.8', 'Firefox', 'u1')`;

      await testDb.migrate();

      expect(
        (await owner`select count(*)::int as n from audit_events`)[0]!.n,
      ).toBe(2);
      const [result] = await owner`
        select * from prune_security_records(
          ${NOW.toISOString()}::timestamptz, '12 months', '24 hours', 100)`;
      expect(result).toMatchObject({
        audit_events_deleted: 1,
        sessions_deleted: 1,
        session_addresses_cleared: 0,
      });
      const events = await owner`select metadata from audit_events`;
      expect(events.map((row) => row.metadata)).toEqual([
        { ipAddress: "203.0.113.8" },
      ]);
      const sessions = await owner`select id from auth.session`;
      expect(sessions.map((row) => row.id)).toEqual(["live"]);
    } finally {
      await owner.end({ timeout: 5 });
    }
  });
});
