import postgres from "postgres";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
  type TestDatabase,
} from "./test-db.js";

// Migration 0036 (#250, ADR 0016) on data in the previous shape: existing
// users and workspaces keep no language (null follows the instance default),
// nothing else changes, and only language-shaped values are accepted.

const LAST_BEFORE = "0035_workspace_images";

let testDb: TestDatabase;
let adminUrl: string;

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: LAST_BEFORE });
  adminUrl = testDb.adminUrl;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

// The test applies the remaining migrations.
vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

describe("migration 0036 on existing users and workspaces", () => {
  it("leaves every language unset and accepts only language subtags", async () => {
    const owner = postgres(adminUrl, { max: 1, onnotice: () => undefined });
    try {
      const [user] = await owner`
        insert into users (email, display_name) values ('a@example.com', 'A')
        returning id`;
      const userId = user!.id as string;
      const [workspace] = await owner`
        insert into workspaces (name, time_zone, display_currency)
        values ('W', 'Europe/Berlin', 'EUR') returning id`;
      const workspaceId = workspace!.id as string;

      await testDb.migrate();

      const [after] = await owner`
        select u.email, u.display_name, u.locale,
               w.name, w.time_zone, w.display_currency, w.screen_locale
        from users u, workspaces w
        where u.id = ${userId} and w.id = ${workspaceId}`;
      expect({ ...after }).toEqual({
        email: "a@example.com",
        display_name: "A",
        locale: null,
        name: "W",
        time_zone: "Europe/Berlin",
        display_currency: "EUR",
        screen_locale: null,
      });

      await owner`update users set locale = 'de' where id = ${userId}`;
      await owner`update workspaces set screen_locale = 'de' where id = ${workspaceId}`;
      await expect(
        owner`update users set locale = 'de-DE' where id = ${userId}`,
      ).rejects.toThrow(/users_locale_format/);
      await expect(
        owner`update workspaces set screen_locale = 'DE' where id = ${workspaceId}`,
      ).rejects.toThrow(/workspaces_screen_locale_format/);
    } finally {
      await owner.end({ timeout: 5 });
    }
  });
});
