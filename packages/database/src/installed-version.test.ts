import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "./index.js";
import {
  findInstalledVersion,
  recordInstalledVersion,
} from "./installation.js";
import {
  createTestDatabase,
  type TestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

let testDb: TestDatabase;
let db: ReturnType<typeof createDatabase>;

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = createDatabase(testDb.adminUrl, { max: 1 });
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
  await testDb.drop();
});

describe("recordInstalledVersion", () => {
  it("records the release that migrated the database, replacing the last", async () => {
    await expect(findInstalledVersion(db)).resolves.toEqual({
      version: null,
      commit: null,
    });

    await recordInstalledVersion(db, {
      version: "0.2.0",
      commit: "a".repeat(40),
    });
    await recordInstalledVersion(db, {
      version: "0.3.0",
      commit: "b".repeat(40),
    });

    await expect(findInstalledVersion(db)).resolves.toEqual({
      version: "0.3.0",
      commit: "b".repeat(40),
    });
  });
});
