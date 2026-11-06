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
  it("marks aggregates and dependent formulas partial when reported values are missing", () => {
    const incomplete: DataTable = {
      ...apple,
      fields: apple.fields.map((field) =>
        field.id === "downloads" ? { ...field, nullable: true } : field,
      ),
      rows: [
        { app: "a", downloads: 10 },
        { app: "a", downloads: null },
        { app: "b", downloads: 0 },
      ],
    };
    const inputs = new Map(sources).set("apple", incomplete);
    const result = querySemanticModel(model, inputs, {
      measureIds: ["apple-downloads", "total-downloads"],
      groupBy: ["app"],
    });
    expect(result.rows[0]?.measures).toMatchObject({
      "apple-downloads": { value: "10", status: "partial" },
      "total-downloads": { value: "15", status: "partial" },
    });
    expect(result.rows[1]?.measures).toMatchObject({
      "apple-downloads": { value: "0", status: "ok" },
      "total-downloads": { value: "7", status: "ok" },
    });
    expect(result.warnings).toContain("aggregate_missing_inputs");
    const explicit: SemanticModelDefinition = {
      ...model,
      measures: model.measures.map((measure) =>
        measure.id === "apple-downloads" && measure.kind === "aggregate"
          ? {
              ...measure,
              aggregate: {
                ...measure.aggregate,
                filter: {
                  kind: "call",
                  fn: "not",
                  args: [
                    { kind: "call", fn: "is_null", args: [field("downloads")] },
                  ],
                },
              },
            }
          : measure,
      ),
    };
    expect(
      querySemanticModel(explicit, inputs, {
        measureIds: ["apple-downloads"],
        groupBy: ["app"],
      }).rows[0]?.measures["apple-downloads"]?.status,
    ).toBe("ok");
  });
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

it("pages deterministic groups without a permanent result-count ceiling", () => {
  const expanded: DataTable = {
    fields: apps.fields,
    rows: Array.from({ length: 1200 }, (_, index) => ({
      id: `app-${index}`,
      name: `App ${String(index).padStart(4, "0")}`,
      country: "DE",
    })),
  };
  const fact: DataTable = {
    fields: apple.fields,
    rows: expanded.rows.map((row) => ({ app: row.id, downloads: 1 })),
  };
  const inputs = new Map(sources)
    .set("apps", expanded)
    .set("apple", fact)
    .set("play", { ...play, rows: [] });
  const query = {
    measureIds: ["apple-downloads"],
    groupBy: ["app"],
    limit: 2,
    offset: 1100,
  };
  const result = querySemanticModel(model, inputs, query);
  expect(result.totalRows).toBe(1200);
  expect(result.rows.map((row) => row.dimensions.app)).toEqual([
    "App 1100",
    "App 1101",
  ]);
  expect(
    result.rows.map((row) => row.measures["apple-downloads"]?.value),
  ).toEqual(["1", "1"]);
  expect(
    querySemanticModel(model, inputs, { ...query, offset: 1200 }).rows,
  ).toEqual([]);
});

it("pages from the end in ascending order for a last window", () => {
  const expanded: DataTable = {
    fields: apps.fields,
    rows: Array.from({ length: 30 }, (_, index) => ({
      id: `app-${index}`,
      name: `App ${String(index).padStart(2, "0")}`,
      country: "DE",
    })),
  };
  const inputs = new Map(sources)
    .set("apps", expanded)
    .set("apple", {
      fields: apple.fields,
      rows: expanded.rows.map((row) => ({ app: row.id, downloads: 1 })),
    })
    .set("play", { ...play, rows: [] });
  const query = {
    measureIds: ["apple-downloads"],
    groupBy: ["app"],
    limit: 3,
    window: "last" as const,
  };
  const latest = querySemanticModel(model, inputs, query);
  expect(latest.rows.map((row) => row.dimensions.app)).toEqual([
    "App 27",
    "App 28",
    "App 29",
  ]);
  expect([latest.totalRows, latest.offset]).toEqual([30, 27]);
  const earlier = querySemanticModel(model, inputs, { ...query, offset: 28 });
  expect(earlier.rows.map((row) => row.dimensions.app)).toEqual([
    "App 00",
    "App 01",
  ]);
  expect(earlier.offset).toBe(0);
  expect(
    querySemanticModel(model, inputs, { ...query, offset: 30 }).rows,
  ).toEqual([]);
});

describe("dimension display names", () => {
  const named: SemanticModelDefinition = {
    ...model,
    dimensions: model.dimensions.map((dimension) =>
      dimension.id === "app"
        ? { ...dimension, fieldId: "id", labelFieldId: "name" }
        : dimension,
    ),
  };
  it("groups and filters by stable identity while returning a separate display name", () => {
    const result = querySemanticModel(named, sources, {
      measureIds: ["total-downloads"],
      groupBy: ["app"],
    });
    expect(
      result.rows.map((row) => [
        row.dimensions.app,
        row.dimensionLabels?.app,
        row.measures["total-downloads"]?.value,
      ]),
    ).toEqual([
      ["a", "App A", "35"],
      ["b", "App B", "10"],
    ]);
    const selected = querySemanticModel(named, sources, {
      measureIds: ["total-downloads"],
      groupBy: ["app"],
      filter: { kind: "call", fn: "eq", args: [field("app"), literal("b")] },
    });
    expect(selected.rows[0]?.dimensions.app).toBe("b");
    expect(selected.rows[0]?.dimensionLabels?.app).toBe("App B");
  });
  it("never merges distinct identities merely because their display names match", () => {
    const sameNames = new Map(sources).set("apps", {
      ...apps,
      rows: apps.rows.map((row) => ({ ...row, name: "Same name" })),
    });
    const result = querySemanticModel(named, sameNames, {
      measureIds: ["total-downloads"],
      groupBy: ["app"],
    });
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((row) => row.dimensionLabels?.app)).toEqual([
      "Same name",
      "Same name",
    ]);
  });
  it("rejects incompatible display columns and conflicting names for one identity", () => {
    const wrong = {
      ...named,
      dimensions: [{ ...named.dimensions[0]!, labelFieldId: "missing" }],
    };
    expect(() =>
      querySemanticModel(wrong, sources, {
        measureIds: ["total-downloads"],
        groupBy: ["app"],
      }),
    ).toThrow("model_dimension_label_invalid");
    const direct: SemanticModelDefinition = {
      version: 1,
      datasets: ["apps"],
      relationships: [],
      dimensions: [named.dimensions[0]!],
      measures: [
        {
          id: "count",
          name: "Count",
          kind: "aggregate",
          datasetId: "apps",
          aggregate: { id: "count", name: "Count", op: "count" },
        },
      ],
    };
    const conflicting = new Map([
      [
        "apps",
        {
          ...apps,
          rows: [apps.rows[0]!, { ...apps.rows[0]!, name: "Different" }],
        },
      ],
    ]);
    expect(() =>
      querySemanticModel(direct, conflicting, {
        measureIds: ["count"],
        groupBy: ["app"],
      }),
    ).toThrow("model_dimension_label_conflict");
  });
});

describe("required measure dimensions", () => {
  const guarded: SemanticModelDefinition = {
    ...model,
    measures: model.measures.map((measure) =>
      measure.id === "apple-downloads"
        ? { ...measure, requiredDimensions: ["app"] }
        : measure,
    ),
  };
  const query = (filter?: DataExpression, groupBy: string[] = []) =>
    querySemanticModel(guarded, sources, {
      measureIds: ["total-downloads"],
      groupBy,
      ...(filter ? { filter } : {}),
    });
  it("applies aggregate grain requirements through dependent formulas", () => {
    expect(() => query()).toThrow("model_measure_scope_required");
    expect(query(undefined, ["app"]).rows).toHaveLength(2);
    for (const filter of [
      { kind: "call", fn: "eq", args: [field("app"), literal("App A")] },
      { kind: "call", fn: "eq", args: [literal("App A"), field("app")] },
      {
        kind: "call",
        fn: "in",
        args: [
          field("app"),
          { kind: "literal", type: "json", value: ["App A"] },
        ],
      },
    ] as DataExpression[]) {
      expect(query(filter).rows[0]?.measures["total-downloads"]?.value).toBe(
        "35",
      );
      expect(
        query({
          kind: "call",
          fn: "and",
          args: [
            filter,
            { kind: "call", fn: "eq", args: [field("country"), literal("DE")] },
          ],
        }).rows,
      ).toHaveLength(1);
    }
  });
  it("refuses a multi-value or disjunctive filter as a single fixed grain", () => {
    const a: DataExpression = {
      kind: "call",
      fn: "eq",
      args: [field("app"), literal("App A")],
    };
    const b: DataExpression = {
      kind: "call",
      fn: "eq",
      args: [field("app"), literal("App B")],
    };
    expect(() => query({ kind: "call", fn: "or", args: [a, b] })).toThrow(
      "model_measure_scope_required",
    );
    expect(() =>
      query({
        kind: "call",
        fn: "in",
        args: [
          field("app"),
          { kind: "literal", type: "json", value: ["App A", "App B"] },
        ],
      }),
    ).toThrow("model_measure_scope_required");
  });
});

it("keeps pending counts and boolean aggregates unknown until a known value decides them", () => {
  const definition: SemanticModelDefinition = {
    version: 1,
    datasets: ["flags"],
    relationships: [],
    dimensions: [],
    measures: (["count", "any", "all"] as const).map((op) => ({
      id: op,
      name: op,
      kind: "aggregate",
      datasetId: "flags",
      aggregate: {
        id: op,
        name: op,
        op,
        ...(op === "count" ? {} : { fieldId: "flag" }),
      },
    })),
  };
  const query = (values: boolean[]) =>
    querySemanticModel(
      definition,
      new Map([
        [
          "flags",
          {
            fields: [
              { id: "flag", name: "Flag", type: "boolean", nullable: false },
            ],
            rows: values.map((flag) => ({ flag })),
            pendingSources: ["waiting"],
          },
        ],
      ]),
      { measureIds: ["count", "any", "all"], groupBy: [] },
    );
  const empty = query([]);
  expect(
    Object.values(empty.rows[0]!.measures).map((cell) => cell.value),
  ).toEqual([null, null, null]);
  expect(empty.pendingSources).toEqual(["waiting"]);
  expect(query([true]).rows[0]!.measures).toMatchObject({
    count: { value: 1, status: "partial" },
    any: { value: true, status: "partial" },
    all: { value: null, status: "missing" },
  });
  expect(query([false]).rows[0]!.measures).toMatchObject({
    any: { value: null, status: "missing" },
    all: { value: false, status: "partial" },
  });
});
