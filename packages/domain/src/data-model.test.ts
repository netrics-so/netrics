import { describe, it, expect } from "vitest";
import {
  querySemanticModel,
  type SemanticModelDefinition,
} from "./data-model.js";
import { type DataTable } from "./data-preparation.js";
import { type DataExpression } from "./data-expression.js";
const field = (fieldId: string): DataExpression => ({ kind: "field", fieldId });
const literal = (value: string): DataExpression => ({
  kind: "literal",
  type: "string",
  value,
});
const apps: DataTable = {
  fields: [
    { id: "id", name: "ID", type: "string", nullable: false },
    { id: "name", name: "Name", type: "string", nullable: false },
    { id: "country", name: "Country", type: "string", nullable: false },
  ],
  rows: [
    { id: "a", name: "App A", country: "DE" },
    { id: "b", name: "App B", country: "FR" },
  ],
  provenance: [{ datasetId: "apps", generationId: "apps-1" }],
};
const apple: DataTable = {
  fields: [
    { id: "app", name: "App", type: "string", nullable: false },
    { id: "downloads", name: "Downloads", type: "integer", nullable: false },
  ],
  rows: [
    { app: "a", downloads: 10 },
    { app: "a", downloads: 20 },
    { app: "b", downloads: 3 },
  ],
  provenance: [{ datasetId: "apple", generationId: "apple-1" }],
};
const play: DataTable = {
  fields: [...apple.fields],
  rows: [
    { app: "a", downloads: 5 },
    { app: "b", downloads: 7 },
  ],
  provenance: [{ datasetId: "play", generationId: "play-1" }],
};
const sources = new Map([
  ["apps", apps],
  ["apple", apple],
  ["play", play],
]);
const model: SemanticModelDefinition = {
  version: 1,
  datasets: ["apps", "apple", "play"],
  relationships: [
    {
      id: "apple-app",
      from: { datasetId: "apple", fieldId: "app" },
      to: { datasetId: "apps", fieldId: "id" },
      cardinality: "many_to_one",
    },
    {
      id: "play-app",
      from: { datasetId: "play", fieldId: "app" },
      to: { datasetId: "apps", fieldId: "id" },
      cardinality: "many_to_one",
    },
  ],
  dimensions: [
    { id: "app", name: "App", datasetId: "apps", fieldId: "name" },
    { id: "country", name: "Country", datasetId: "apps", fieldId: "country" },
  ],
  measures: [
    {
      id: "apple-downloads",
      name: "Apple downloads",
      kind: "aggregate",
      datasetId: "apple",
      aggregate: {
        id: "apple-downloads",
        name: "Downloads",
        op: "sum",
        fieldId: "downloads",
      },
    },
    {
      id: "play-downloads",
      name: "Play downloads",
      kind: "aggregate",
      datasetId: "play",
      aggregate: {
        id: "play-downloads",
        name: "Downloads",
        op: "sum",
        fieldId: "downloads",
      },
    },
    {
      id: "total-downloads",
      name: "Downloads",
      kind: "formula",
      expression: {
        kind: "call",
        fn: "add",
        args: [field("apple-downloads"), field("play-downloads")],
      },
    },
  ],
};

describe("shared semantic query context", () => {
  it("aggregates each fact before combining and applies dimensions across sources", () => {
    const result = querySemanticModel(model, sources, {
      measureIds: ["total-downloads"],
      groupBy: ["app"],
    });
    expect(
      result.rows.map((row) => [
        row.dimensions.app,
        row.measures["total-downloads"]?.value,
      ]),
    ).toEqual([
      ["App A", "35"],
      ["App B", "10"],
    ]);
    // A fact-to-fact join would multiply Apple A by its Play rows, or vice versa.
    expect(
      querySemanticModel(model, sources, {
        measureIds: ["total-downloads"],
        groupBy: [],
      }).rows[0]?.measures["total-downloads"]?.value,
    ).toBe("45");
  });
  it("applies one country predicate to all operands of a calculation", () => {
    const filter: DataExpression = {
      kind: "call",
      fn: "eq",
      args: [field("country"), literal("DE")],
    };
    const result = querySemanticModel(model, sources, {
      measureIds: ["apple-downloads", "play-downloads", "total-downloads"],
      groupBy: [],
      filter,
    });
    expect(
      Object.values(result.rows[0]!.measures).map((cell) => cell.value),
    ).toEqual(["30", "5", "35"]);
    expect(result.appliedFilter).toEqual(filter);
  });
  it("refuses an unsupported dimension rather than ignoring its filter", () => {
    const unrelated: DataTable = {
      fields: [
        { id: "value", name: "Value", type: "integer", nullable: false },
      ],
      rows: [{ value: 100 }],
    };
    const changed: SemanticModelDefinition = {
      ...model,
      datasets: [...model.datasets, "unrelated"],
      measures: [
        ...model.measures,
        {
          id: "unrelated",
          name: "Unrelated",
          kind: "aggregate",
          datasetId: "unrelated",
          aggregate: { id: "n", name: "N", op: "sum", fieldId: "value" },
        },
      ],
    };
    expect(() =>
      querySemanticModel(
        changed,
        new Map([...sources, ["unrelated", unrelated]]),
        { measureIds: ["unrelated"], groupBy: ["app"] },
      ),
    ).toThrow("model_dimension_incompatible");
  });
  it("does not infer matches for unmapped entities", () => {
    const result = querySemanticModel(
      model,
      new Map([
        ...sources,
        [
          "apple",
          { ...apple, rows: [...apple.rows, { app: "unknown", downloads: 8 }] },
        ],
      ]),
      { measureIds: ["apple-downloads"], groupBy: ["app"] },
    );
    expect(
      result.rows.find((row) => row.dimensions.app === null)?.measures[
        "apple-downloads"
      ]?.value,
    ).toBe("8");
  });
  it("rejects duplicate dimension keys and ambiguous relationship paths", () => {
    expect(() =>
      querySemanticModel(
        model,
        new Map([
          ...sources,
          ["apps", { ...apps, rows: [...apps.rows, apps.rows[0]!] }],
        ]),
        { measureIds: ["apple-downloads"], groupBy: [] },
      ),
    ).toThrow("model_relationship_cardinality_violation");
    expect(() =>
      querySemanticModel(
        model,
        new Map([
          ...sources,
          ["apps", { ...apps, rows: [...apps.rows, apps.rows[0]!] }],
        ]),
        { measureIds: ["apple-downloads"], groupBy: ["app"] },
      ),
    ).toThrow("model_relationship_cardinality_violation");
    expect(() =>
      querySemanticModel(
        {
          ...model,
          relationships: [
            ...model.relationships,
            { ...model.relationships[0]!, id: "duplicate-path" },
          ],
        },
        sources,
        { measureIds: ["apple-downloads"], groupBy: ["app"] },
      ),
    ).toThrow("model_filter_path_ambiguous");
  });
  it("rejects cyclic measure definitions before trying to calculate", () => {
    expect(() =>
      querySemanticModel(
        {
          ...model,
          measures: [
            { id: "a", name: "A", kind: "formula", expression: field("b") },
            { id: "b", name: "B", kind: "formula", expression: field("a") },
          ],
        },
        sources,
        { measureIds: ["a"], groupBy: [] },
      ),
    ).toThrow("model_measure_cycle");
  });
  it("preserves missing versus zero in cross-source results", () => {
    const result = querySemanticModel(
      model,
      new Map([...sources, ["play", { ...play, rows: [] }]]),
      { measureIds: ["total-downloads"], groupBy: [] },
    );
    expect(result.rows[0]?.measures["total-downloads"]?.value).toBeNull();
    expect(result.rows[0]?.measures["total-downloads"]?.status).toBe("missing");
  });
  it("lets numeric thresholds inherit their measure unit", () => {
    const typed: DataTable = {
      fields: [
        {
          id: "rating",
          name: "Rating",
          type: "decimal",
          nullable: false,
          unit: "stars",
        },
      ],
      rows: [{ rating: "3.5" }],
    };
    const single: SemanticModelDefinition = {
      version: 1,
      datasets: ["ratings"],
      relationships: [],
      dimensions: [],
      measures: [
        {
          id: "rating",
          name: "Rating",
          kind: "aggregate",
          datasetId: "ratings",
          aggregate: {
            id: "rating",
            name: "Rating",
            op: "avg",
            fieldId: "rating",
          },
        },
        {
          id: "attention",
          name: "Needs attention",
          kind: "formula",
          expression: {
            kind: "call",
            fn: "lt",
            args: [
              field("rating"),
              { kind: "literal", type: "decimal", value: "4" },
            ],
          },
        },
      ],
    };
    expect(
      querySemanticModel(single, new Map([["ratings", typed]]), {
        measureIds: ["attention"],
        groupBy: [],
      }).rows[0]?.measures.attention?.value,
    ).toBe(true);
  });
});
