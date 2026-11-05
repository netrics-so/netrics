import { describe, expect, it } from "vitest";
import {
  createDashboardRequestSchema,
  preparationGraphSchema,
} from "@netrics/contracts";
import {
  executePreparation,
  querySemanticModel,
  validateSemanticModel,
  type DataTable,
} from "@netrics/domain";
import {
  buildStoreDashboard,
  buildStoreAppend,
  buildStoreModel,
  buildStorePreparation,
} from "./store-portfolio.js";

import { now, apple, google, inputs } from "./test-helpers.js";
function prepared(metric: "downloads" | "proceeds" | "ratings"): DataTable {
  const tables = inputs();
  const outputs = [apple, google].map(
    (source) =>
      executePreparation(
        preparationGraphSchema.parse(
          buildStorePreparation(source, metric, "mapping", "products", "en"),
        ),
        tables,
      ).outputs.output!,
  );
  const graph = buildStoreAppend(["apple", "google"]);
  return executePreparation(
    graph,
    new Map([
      ["apple", outputs[0]!],
      ["google", outputs[1]!],
    ]),
  ).outputs[graph.outputs[0]!]!;
}

describe("editable store portfolio definitions", () => {
  it("keeps download definitions separate and exposes missing install values as partial", () => {
    const data = prepared("downloads"),
      model = buildStoreModel("downloads", "facts", "en");
    const tables = new Map([["facts", data]]);
    validateSemanticModel(model, tables, now);
    const result = querySemanticModel(model, tables, {
      measureIds: ["downloads"],
      groupBy: ["app", "store"],
    });
    expect(
      result.rows.map((row) => [
        row.dimensions.app,
        row.dimensions.store,
        row.dimensionLabels?.app,
        row.measures.downloads?.value,
        row.measures.downloads?.status,
      ]),
    ).toEqual([
      [google.id + ":com.example.beta", "google", "Other app", "4", "ok"],
      ["confirmed-product", "apple", "Example app", "10", "ok"],
      ["confirmed-product", "google", "Example app", "10", "partial"],
    ]);
    expect(() =>
      querySemanticModel(model, tables, {
        measureIds: ["downloads"],
        groupBy: ["app"],
      }),
    ).toThrow("model_measure_scope_required");
  });
  it("calculates exact signed proceeds, keeps currencies separate and leaves account adjustments unallocated", () => {
    const data = prepared("proceeds"),
      model = buildStoreModel("proceeds", "facts", "en"),
      tables = new Map([["facts", data]]);
    const result = querySemanticModel(model, tables, {
      measureIds: ["proceeds"],
      groupBy: ["app", "currency"],
    });
    expect(
      result.rows.map((row) => [
        row.dimensions.app,
        row.measures.proceeds?.value,
        row.measures.proceeds?.currency,
      ]),
    ).toEqual([
      [google.id + ":__unmapped", "-1", "USD"],
      [google.id + ":com.example.beta", "70", "EUR"],
      ["confirmed-product", "6.2", "USD"],
    ]);
    expect(() =>
      querySemanticModel(model, tables, {
        measureIds: ["proceeds"],
        groupBy: [],
      }),
    ).toThrow("aggregate_currency_mixed");
  });
  it("keeps ratings per underlying listing even when the customer confirms one shared product", () => {
    const data = prepared("ratings"),
      model = buildStoreModel("ratings", "facts", "en"),
      tables = new Map([["facts", data]]);
    validateSemanticModel(model, tables, now);
    expect(() =>
      querySemanticModel(model, tables, {
        measureIds: ["rating"],
        groupBy: ["app"],
      }),
    ).toThrow("model_measure_scope_required");
    const result = querySemanticModel(model, tables, {
      measureIds: ["rating", "rating_count", "availability"],
      groupBy: ["listing", "storefront"],
    });
    expect(
      result.rows.map((row) => [
        row.dimensionLabels?.listing,
        row.measures.rating?.value,
        row.measures.rating_count?.value,
        row.measures.availability?.value,
      ]),
    ).toEqual([
      ["Apple Example · Apple App Store", "4.5", 100, "Available"],
      ["Android Example · Google Play", "4.1", 50, "Available"],
    ]);
  });
  it("creates normal editable widgets with compatible filters and a fixed per-app scope", () => {
    const models = {
      downloads: "11111111-1111-4111-8111-111111111111",
      proceeds: "22222222-2222-4222-8222-222222222222",
      ratings: "33333333-3333-4333-8333-333333333333",
    };
    const dashboard = createDashboardRequestSchema.parse(
      buildStoreDashboard("Example", models, "de", "confirmed-product"),
    );
    expect(dashboard.settings?.dataFilters?.[0]?.fixedValue).toEqual({
      kind: "values",
      values: ["confirmed-product"],
    });
    expect(
      dashboard.slides?.[0]?.widgets?.map((widget) => widget.type),
    ).toEqual(["measure", "measure", "measure"]);
    expect(dashboard.name).toBe("Example");
  });
});
