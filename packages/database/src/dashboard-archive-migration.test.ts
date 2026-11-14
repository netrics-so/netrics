import { readFileSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { migrationsFolder } from "./index.js";
import {
  createTestDatabase,
  type TestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// Archived dashboards (template updates, 11E) on data in the previous shape:
// every existing dashboard stays unarchived. Found by its name, not its
// number, so a renumbering on merge does not touch this test.

const TAG_SUFFIX = "_dashboard_archive";

function lastBefore(): string {
  const journal = JSON.parse(
    readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };
  const at = journal.entries.findIndex((entry) =>
    entry.tag.endsWith(TAG_SUFFIX),
  );
  expect(at).toBeGreaterThan(0);
  return journal.entries[at - 1]!.tag;
}

let testDb: TestDatabase;
let owner: postgres.Sql;
let dashboardId: string;

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: lastBefore() });
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => undefined });
  const [workspace] = await owner`
    insert into workspaces (name) values ('W') returning id`;
  const [dashboard] = await owner`
    insert into dashboards (workspace_id, name)
    values (${workspace!.id as string}, 'Portfolio') returning id`;
  dashboardId = dashboard!.id as string;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

// The test applies the remaining migrations.
vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

afterAll(async () => {
  await owner?.end({ timeout: 5 }).catch(() => undefined);
  await testDb?.drop();
});

describe("the dashboard archive migration", () => {
  it("keeps every dashboard unarchived", async () => {
    await testDb.migrate();
    const [row] = await owner`
      select name, archived_at from dashboards where id = ${dashboardId}`;
    expect(row).toEqual({ name: "Portfolio", archived_at: null });
  });
});
