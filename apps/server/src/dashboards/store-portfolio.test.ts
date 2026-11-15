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
function prepared(
  metric: "downloads" | "proceeds" | "ratings",
  templateVersion: 1 | 2 = 1,
  locale: "en" | "de" = "en",
): DataTable {
  const tables = inputs();
  const outputs = [apple, google].map(
    (source) =>
      executePreparation(
        preparationGraphSchema.parse(
          buildStorePreparation(
            source,
            metric,
            "mapping",
            "products",
            locale,
            templateVersion,
          ),
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
    ).toThrow("model_measure_scope_required");
    // Even a single-currency selection must declare its currency scope.
    const euros = {
      kind: "call" as const,
      fn: "eq" as const,
      args: [
        { kind: "field" as const, fieldId: "app" },
        {
          kind: "literal" as const,
          type: "string" as const,
          value: google.id + ":com.example.beta",
        },
      ],
    };
    expect(() =>
      querySemanticModel(model, tables, {
        measureIds: ["proceeds"],
        groupBy: [],
        filter: euros,
      }),
    ).toThrow("model_measure_scope_required");
    expect(
      querySemanticModel(model, tables, {
        measureIds: ["proceeds"],
        groupBy: [],
        filter: {
          kind: "call",
          fn: "and",
          args: [
            euros,
            {
              kind: "call",
              fn: "eq",
              args: [
                { kind: "field", fieldId: "currency" },
                { kind: "literal", type: "string", value: "EUR" },
              ],
            },
          ],
        },
      }).rows[0]?.measures.proceeds?.value,
    ).toBe("70");
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
  it("takes Google Play ratings from the latest rating report day in version 2, with a reason where there is none", () => {
    const model = buildStoreModel("ratings", "facts", "en", 2),
      tables = new Map([["facts", prepared("ratings", 2)]]);
    validateSemanticModel(model, tables, now);
    const result = querySemanticModel(model, tables, {
      measureIds: ["rating", "rating_count", "checked", "availability"],
      groupBy: ["listing", "storefront"],
    });
    const rows = result.rows.map((row) => [
      row.dimensionLabels?.listing,
      row.dimensions.storefront,
      row.dimensionLabels?.storefront,
      row.measures.rating?.value,
      row.measures.rating_count?.value,
      row.measures.checked?.value,
      row.measures.availability?.value,
    ]);
    const today = now.slice(0, 10);
    expect(rows).toEqual(
      expect.arrayContaining([
        [
          "Apple Example · Apple App Store",
          "US",
          "US",
          "4.5",
          100,
          "2026-10-01",
          "Available",
        ],
        // The report's Total Average Rating as of its latest report day;
        // Google's report has no rating count. The listing's 4.1 is not
        // used. November not published yet is the normal report lag.
        [
          "Android Example · Google Play",
          "ALL",
          "All countries",
          "4.3333",
          null,
          "2026-10-04",
          "Available",
        ],
        [
          "Other app · Google Play",
          "ALL",
          "All countries",
          null,
          null,
          today,
          "No ratings yet",
        ],
        [
          "Third app · Google Play",
          "ALL",
          "All countries",
          null,
          null,
          today,
          "No rating report yet",
        ],
        [
          "Fourth app · Google Play",
          "ALL",
          "All countries",
          null,
          null,
          today,
          "Rating report could not be read",
        ],
        // The last value and its day stay, with why it may be outdated.
        [
          "Fifth app · Google Play",
          "ALL",
          "All countries",
          "3.75",
          null,
          "2026-10-31",
          "Rating report could not be read",
        ],
        // A selected app before its first report read still has a row.
        [
          "Sixth app · Google Play",
          "ALL",
          "All countries",
          null,
          null,
          null,
          "No rating report yet",
        ],
      ]),
    );
    expect(rows).toHaveLength(7);
    // German labels; the storefront value stays the same in every language.
    const de = querySemanticModel(
      buildStoreModel("ratings", "facts", "de", 2),
      new Map([["facts", prepared("ratings", 2, "de")]]),
      {
        measureIds: ["availability"],
        groupBy: ["listing", "storefront"],
      },
    );
    expect(
      de.rows.map((row) => row.measures.availability?.value).sort(),
    ).toEqual(
      [
        "Bewertungsbericht nicht lesbar",
        "Bewertungsbericht nicht lesbar",
        "Noch kein Bewertungsbericht",
        "Noch kein Bewertungsbericht",
        "Noch keine Bewertungen",
        "Verfügbar",
        "Verfügbar",
      ].sort(),
    );
    expect(
      new Set(
        de.rows
          .filter((row) => row.dimensions.storefront === "ALL")
          .map((row) => row.dimensionLabels?.storefront),
      ),
    ).toEqual(new Set(["Alle Länder"]));
  });
  it("reads a lost permission on the latest rating report month as the reason, keeping the last rating", () => {
    const tables = inputs();
    const status = tables.get("play-report-status")!;
    tables.set("play-report-status", {
      ...status,
      rows: status.rows.map((row) =>
        row.app_id === "com.example.epsilon" &&
        row.report_month === "2026-11-01"
          ? { ...row, availability: "permission_missing" }
          : row,
      ),
    });
    const output = executePreparation(
      preparationGraphSchema.parse(
        buildStorePreparation(
          google,
          "ratings",
          "mapping",
          "products",
          "en",
          2,
        ),
      ),
      tables,
    ).outputs.output!;
    expect(
      output.rows
        .filter((row) => row.listing_name === "Fifth app · Google Play")
        .map((row) => [row.rating, row.day, row.availability_label]),
    ).toEqual([["3.75", "2026-10-31", "No access to rating reports"]]);
  });
  it("shows the as-of day as a date, the same report day in every viewer time zone", () => {
    const model = buildStoreModel("ratings", "facts", "en", 2),
      data = prepared("ratings", 2);
    const checked = model.measures.find((measure) => measure.id === "checked")!;
    expect(checked.kind === "aggregate" && checked.aggregate.fieldId).toBe(
      "day",
    );
    expect(data.fields.find((field) => field.id === "day")?.type).toBe("date");
    const result = querySemanticModel(model, new Map([["facts", data]]), {
      measureIds: ["checked"],
      groupBy: ["listing", "storefront"],
    });
    const alpha = result.rows.find(
      (row) => row.dimensionLabels?.listing === "Android Example · Google Play",
    )!;
    // A date, not midnight UTC: west of UTC that showed the day before.
    expect(alpha.measures.checked).toMatchObject({
      value: "2026-10-04",
      type: "date",
    });
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
