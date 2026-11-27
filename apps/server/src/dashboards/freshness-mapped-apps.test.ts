import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Transaction } from "@netrics/database";
import { DEFAULT_DATA_POLICY } from "@netrics/domain";

import { createScopeMappingCache, mappedProductApps } from "./freshness.js";

// A product's apps across several mapping tables (#923): a merged table
// can hold more apps than a call takes arguments, so they are appended
// one by one, not spread.

describe("mappedProductApps", () => {
  it("merges a product's apps of several large mapping tables", async () => {
    const product = "product:" + randomUUID();
    const tables = [randomUUID(), randomUUID()];
    const cache = createScopeMappingCache();
    cache.policy = { ...DEFAULT_DATA_POLICY };
    const count = 500_000;
    for (const [index, table] of tables.entries()) {
      cache.isMapping.set(table, true);
      cache.products.set(
        table,
        new Map([
          [
            product,
            Array.from({ length: count }, (_, n) => `${table}:${index}-${n}`),
          ],
        ]),
      );
    }
    // Everything is read already: the transaction is never used.
    const apps = await mappedProductApps(
      {} as Transaction,
      randomUUID(),
      new Set(tables),
      { now: new Date("2026-11-24T12:00:00.000Z"), cache },
    );
    expect(apps.get(product)).toHaveLength(2 * count);
  });
});
