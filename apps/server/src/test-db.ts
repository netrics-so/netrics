import { createDatabase } from "@netrics/database";
import {
  createTestDatabase as createMigratedDatabase,
  type TestDatabase,
} from "@netrics/database/testing";

import { createDefaultRegistry } from "./connectors.js";
import { syncCatalog } from "./sync/catalog.js";

export type { TestDatabase };

/**
 * A migrated test database with the default connector catalog written as
 * the owner, like `migrate` does (see @netrics/database/testing).
 */
export function createTestDatabase(): Promise<TestDatabase> {
  return createMigratedDatabase({
    seed: async (adminUrl) => {
      const owner = createDatabase(adminUrl, { max: 1 });
      try {
        await syncCatalog(owner, createDefaultRegistry());
      } finally {
        await owner.$client.end({ timeout: 5 }).catch(() => undefined);
      }
    },
  });
}
