import { describe, expect, it } from "vitest";
import { preparationGraphSchema } from "@netrics/contracts";
import { executePreparation, type DataTable } from "@netrics/domain";
import { buildStorePreparation } from "./store-portfolio.js";
import { storeMetrics } from "./store-template.js";
import { resolveStoreProducts } from "./store-template-products.js";
import { apple, google, inputs } from "./test-helpers.js";

// The app identity (#708) resolves products exactly as the template's
// preparations do: product_id = mapping.product_id ?? app_key, and the
// name from Products, else the app's resource name, else its id. Both run
// here on the same tables, as the customer may have edited them.

const sources = [apple, google];

/** Each prepared row's app key with its product id and name. */
function prepared(tables: Map<string, DataTable>) {
  const rows: { appKey: string; productId: string; name: string }[] = [];
  for (const source of sources)
    for (const metric of storeMetrics) {
      const output = executePreparation(
        preparationGraphSchema.parse(
          buildStorePreparation(source, metric, "mapping", "products", "en", 3),
        ),
        tables,
      ).outputs.output!;
      for (const row of output.rows)
        rows.push({
          appKey: String(row.app_key),
          productId: String(row.product_id),
          name: String(row.product_name),
        });
    }
  return rows;
}

function resolved(tables: Map<string, DataTable>) {
  return resolveStoreProducts({
    products: tables.get("products")!.rows,
    mapping: tables.get("mapping")!.rows,
    connectors: new Map(
      sources.map((source) => [source.id, source.connectorId]),
    ),
    apps: sources.flatMap((source) =>
      tables.get(`resources:${source.id}`)!.rows.map((row) => ({
        connectionId: source.id,
        appId: String(row.resource_id),
        name: String(row.name),
        connectorId: source.connectorId,
      })),
    ),
    // The apps of the synced source rows, as readStoreProducts reads them.
    dataApps: sources.flatMap((source) =>
      Object.values(source.datasets).flatMap((datasetId) =>
        (tables.get(datasetId)?.rows ?? []).map((row) => ({
          connectionId: source.id,
          appId: String(row.app_id),
        })),
      ),
    ),
  });
}

const variants: Record<string, (tables: Map<string, DataTable>) => void> = {
  "as installed": () => {},
  "an unlinked app named in Products": (tables) => {
    tables.get("products")!.rows.push({
      product_id: google.id + ":com.example.beta",
      product_name: "Beta renamed",
    });
  },
  // A package Play reports earnings for that discovery never listed.
  "an earnings-only Play package": (tables) => {
    const earnings = tables.get("play-earnings")!;
    earnings.rows.push({
      ...earnings.rows[0]!,
      app_id: "com.example.reported",
    });
  },
  "a linked product's Products row removed": (tables) => {
    const products = tables.get("products")!;
    products.rows = products.rows.filter(
      (row) => row.product_id !== "confirmed-product",
    );
  },
};

describe("app identity and the preparations", () => {
  for (const [name, edit] of Object.entries(variants))
    it(`agree on every app's product: ${name}`, () => {
      const tables = inputs();
      edit(tables);
      const rows = prepared(tables).filter(
        (row) => !row.appKey.endsWith(":__unmapped"),
      );
      expect(rows.length).toBeGreaterThan(0);
      const products = resolved(tables);
      const named = new Set(
        tables.get("products")!.rows.map((row) => String(row.product_id)),
      );
      for (const row of rows) {
        const product = products.find((candidate) =>
          candidate.apps.some(
            (app) => app.connectionId + ":" + app.appId === row.appKey,
          ),
        );
        expect(product?.productId, row.appKey).toBe(row.productId);
        // A product without a Products row names each of its rows after
        // the row's own app; the identity takes its first app's name.
        if (named.has(row.productId) || product!.apps.length === 1)
          expect(product!.name, row.appKey).toBe(row.name);
        else
          expect(
            rows
              .filter((other) => other.productId === row.productId)
              .map((other) => other.name),
          ).toContain(product!.name);
      }
    });
});
