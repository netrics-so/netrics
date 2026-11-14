import { createDatabase } from "@netrics/database";
import {
  createTestDatabase as createMigratedDatabase,
  type TestDatabase,
} from "@netrics/database/testing";

import { createDefaultRegistry } from "./connectors.js";
import { syncCatalog } from "./sync/catalog.js";

export type { TestDatabase };
export {
  TEST_DATABASE_DROP_TIMEOUT_MS,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "@netrics/database/testing";

/**
 * A migrated test database with the default connector catalog written as
 * the owner, like `migrate` does (see @netrics/database/testing).
 */
export function createTestDatabase(
  options: { upTo?: string } = {},
): Promise<TestDatabase> {
  return createMigratedDatabase({
    ...options,
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
