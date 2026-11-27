import { describe, it, expect } from "vitest";
import {
  formulaMeasureFields,
  measureRequiredDimensions,
  missingModelMeasureScope,
  modelMeasureScope,
  probeModelMeasures,
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
  it("does not warn about a measure that rounds on purpose (#645)", () => {
    const ratio = (id: string, rounded: boolean) => {
      const divide: DataExpression = {
        kind: "call",
        fn: "divide",
        args: [field("apple-downloads"), field("play-downloads")],
      };
      return {
        id,
        name: id,
        kind: "formula" as const,
        expression: rounded
          ? ({
              kind: "call",
              fn: "round",
              args: [divide, { kind: "literal", type: "integer", value: 2 }],
            } as DataExpression)
          : divide,
      };
    };
    const query = (id: string) =>
      querySemanticModel(
        {
          ...model,
          measures: [
            ...model.measures,
            ratio("rounded", true),
            ratio("unrounded", false),
          ],
        },
        sources,
        { measureIds: [id], groupBy: ["app"] },
      );
    // App B: 3 / 7 has no finite decimal.
    const rounded = query("rounded");
    expect(rounded.rows.map((row) => row.measures.rounded?.value)).toEqual([
      "6",
      "0.43",
    ]);
    expect(rounded.warnings).not.toContain("decimal_rounded");
    expect(query("unrounded").warnings).toContain("decimal_rounded");
  });
  it("does not warn about a ROUND over a measure or an average that rounds (#680)", () => {
    const call = (
      fn: Extract<DataExpression, { kind: "call" }>["fn"],
      ...args: DataExpression[]
    ): DataExpression => ({
      kind: "call",
      fn,
      args,
    });
    const integer = (value: number): DataExpression => ({
      kind: "literal",
      type: "integer",
      value,
    });
    const formula = (id: string, expression: DataExpression) => ({
      id,
      name: id,
      kind: "formula" as const,
      expression,
    });
    const prices: DataTable = {
      fields: [
        { id: "app", name: "App", type: "string", nullable: false },
        { id: "price", name: "Price", type: "decimal", nullable: false },
      ],
      rows: [
        { app: "a", price: "1" },
        { app: "a", price: "1" },
        { app: "a", price: "2" },
        { app: "b", price: "0.5" },
      ],
    };
    const extended: SemanticModelDefinition = {
      ...model,
      datasets: [...model.datasets, "prices"],
      relationships: [
        ...model.relationships,
        {
          id: "prices-app",
          from: { datasetId: "prices", fieldId: "app" },
          to: { datasetId: "apps", fieldId: "id" },
          cardinality: "many_to_one",
        },
      ],
      measures: [
        ...model.measures,
        formula(
          "ratio",
          call("divide", field("apple-downloads"), field("play-downloads")),
        ),
        formula("rounded", call("round", field("ratio"), integer(2))),
        formula("percent", call("multiply", field("ratio"), integer(100))),
        formula("percentRounded", call("round", field("percent"), integer(1))),
        formula("ratioTo18", call("round", field("ratio"), integer(18))),
        formula("doubled", call("add", field("ratio"), field("ratio"))),
        formula("doubledRounded", call("round", field("doubled"), integer(2))),
        {
          id: "avgPrice",
          name: "Average price",
          kind: "aggregate",
          datasetId: "prices",
          aggregate: {
            id: "avgPrice",
            name: "Price",
            op: "avg",
            fieldId: "price",
          },
        },
        formula("avgRounded", call("round", field("avgPrice"), integer(2))),
      ],
    };
    const query = (...measureIds: string[]) =>
      querySemanticModel(extended, new Map([...sources, ["prices", prices]]), {
        measureIds,
        groupBy: ["app"],
      });
    // App B: 3 / 7 has no finite decimal; app A's average 4 / 3 neither.
    const rounded = query("rounded", "percentRounded", "avgRounded");
    expect(
      rounded.rows.map((row) => [
        row.measures.rounded?.value,
        row.measures.percentRounded?.value,
        row.measures.avgRounded?.value,
      ]),
    ).toEqual([
      ["6", "600", "1.33"],
      ["0.43", "42.9", "0.5"],
    ]);
    expect(rounded.warnings).not.toContain("decimal_rounded");
    // The unrounded value itself, shown or used as it is, still warns.
    for (const shown of [
      ["ratio"],
      ["rounded", "ratio"],
      ["ratio", "rounded"],
      ["percent"],
      ["avgPrice"],
      ["avgRounded", "avgPrice"],
      // Rounding to 18 places cannot discard the lost digits.
      ["ratioTo18"],
      // Two roundings in the operand are not traced to the ROUND.
      ["doubledRounded"],
    ])
      expect(query(...shown).warnings, shown.join()).toContain(
        "decimal_rounded",
      );
  });
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
  it("filters by the display name people see as well as by the stable value (#627)", () => {
    const query = (filter: DataExpression) =>
      querySemanticModel(named, sources, {
        measureIds: ["total-downloads"],
        groupBy: ["app"],
        filter,
      });
    const byLabel = query({
      kind: "call",
      fn: "eq",
      args: [field("app"), literal("App B")],
    });
    expect(
      byLabel.rows.map((row) => [
        row.dimensions.app,
        row.dimensionLabels?.app,
        row.measures["total-downloads"]?.value,
      ]),
    ).toEqual([["b", "App B", "10"]]);
    // The applied filter names the value, labelled like a value filter.
    expect(byLabel.appliedFilter).toEqual({
      kind: "call",
      fn: "eq",
      args: [field("app"), literal("b")],
    });
    expect(byLabel.filterValueLabels).toEqual([
      { dimensionId: "app", value: "b", label: "App B" },
    ]);
    // Literal first, ne and in lists resolve the same way.
    expect(
      query({
        kind: "call",
        fn: "eq",
        args: [literal("App A"), field("app")],
      }).rows.map((row) => row.dimensions.app),
    ).toEqual(["a"]);
    expect(
      query({
        kind: "call",
        fn: "ne",
        args: [field("app"), literal("App A")],
      }).rows.map((row) => row.dimensions.app),
    ).toEqual(["b"]);
    expect(
      query({
        kind: "call",
        fn: "in",
        args: [
          field("app"),
          { kind: "literal", type: "json", value: ["App A", "b"] },
        ],
      }).rows.map((row) => row.dimensions.app),
    ).toEqual(["a", "b"]);
    // Stable values keep working, and unknown text still matches nothing.
    expect(
      query({
        kind: "call",
        fn: "eq",
        args: [field("app"), literal("a")],
      }).rows.map((row) => row.dimensions.app),
    ).toEqual(["a"]);
    expect(
      query({ kind: "call", fn: "eq", args: [field("app"), literal("App C")] })
        .rows,
    ).toEqual([]);
  });
  it("prefers a stable value over a display name spelled the same", () => {
    // "b" is App A's label and App B's value: the value wins.
    const confusing = new Map(sources).set("apps", {
      ...apps,
      rows: [
        { id: "a", name: "b", country: "DE" },
        { id: "b", name: "App B", country: "FR" },
      ],
    });
    const result = querySemanticModel(named, confusing, {
      measureIds: ["total-downloads"],
      groupBy: ["app"],
      filter: { kind: "call", fn: "eq", args: [field("app"), literal("b")] },
    });
    expect(result.rows.map((row) => row.dimensions.app)).toEqual(["b"]);
  });
  it("a display name shared by several values selects all of them", () => {
    const sameNames = new Map(sources).set("apps", {
      ...apps,
      rows: apps.rows.map((row) => ({ ...row, name: "Same name" })),
    });
    const query = (fn: "eq" | "ne") =>
      querySemanticModel(named, sameNames, {
        measureIds: ["total-downloads"],
        groupBy: ["app"],
        filter: {
          kind: "call",
          fn,
          args: [field("app"), literal("Same name")],
        },
      }).rows.map((row) => row.dimensions.app);
    expect(query("eq")).toEqual(["a", "b"]);
    expect(query("ne")).toEqual([]);
  });
  it("notes filter texts that name neither a value nor a display name, with a near match", () => {
    const query = (values: string[]) =>
      querySemanticModel(named, sources, {
        measureIds: ["total-downloads"],
        groupBy: ["app"],
        filter: {
          kind: "call",
          fn: "in",
          args: [
            field("app"),
            { kind: "literal", type: "json", value: values },
          ],
        },
      });
    // Case and spacing differ: noted with a suggestion, never matched.
    const near = query(["app  b ", "App C", "a"]);
    expect(near.rows.map((row) => row.dimensions.app)).toEqual(["a"]);
    expect(near.warnings).toContain("model_filter_value_unknown");
    expect(near.filterValueNotes).toEqual([
      { dimensionId: "app", value: "app  b ", suggestion: "App B" },
      { dimensionId: "app", value: "App C" },
    ]);
    // Values and labels that match are not noted.
    const known = query(["a", "App B"]);
    expect(known.filterValueNotes).toBeUndefined();
    expect(known.warnings).not.toContain("model_filter_value_unknown");
    // Dimensions without display names are left alone.
    const plain = querySemanticModel(named, sources, {
      measureIds: ["total-downloads"],
      groupBy: [],
      filter: {
        kind: "call",
        fn: "eq",
        args: [field("country"), literal("XX")],
      },
    });
    expect(plain.filterValueNotes).toBeUndefined();
  });
  it("says how many values a shared display name stands for when one is required", () => {
    const sameNames = new Map(sources).set("apps", {
      ...apps,
      rows: apps.rows.map((row) => ({ ...row, name: "My App" })),
    });
    const scoped: SemanticModelDefinition = {
      ...named,
      measures: named.measures.map((measure) =>
        measure.id === "apple-downloads"
          ? { ...measure, requiredDimensions: ["app"] }
          : measure,
      ),
    };
    const run = (name: string) => () =>
      querySemanticModel(scoped, sameNames, {
        measureIds: ["apple-downloads"],
        groupBy: [],
        filter: { kind: "call", fn: "eq", args: [field("app"), literal(name)] },
      });
    let failure: unknown;
    try {
      run("My App")();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "model_filter_label_several_values",
      fieldId: "app",
      count: 2,
    });
    // One value by its stable ID still fixes the scope.
    expect(run("a")().rows[0]?.measures["apple-downloads"]?.value).toBe("30");
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
  it("names the grouping a query needs, through formulas and window bases", () => {
    expect(modelMeasureScope(guarded, ["total-downloads"])).toEqual(["app"]);
    expect(modelMeasureScope(guarded, ["apple-downloads"])).toEqual(["app"]);
    expect(modelMeasureScope(model, ["total-downloads"])).toEqual([]);
    const windowed: SemanticModelDefinition = {
      ...guarded,
      measures: [
        ...guarded.measures,
        {
          id: "rolling",
          name: "Rolling",
          kind: "rolling",
          baseMeasureId: "apple-downloads",
          timeDimensionId: "day",
          window: { unit: "day", length: 7 },
        },
        {
          id: "both",
          name: "Both",
          requiredDimensions: ["country", "unknown"],
          kind: "formula",
          expression: field("rolling"),
        },
      ],
    };
    // Ordered as the model lists its dimensions; unknown ids are left to the query.
    expect(modelMeasureScope(windowed, ["both", "missing"])).toEqual([
      "app",
      "country",
    ]);
  });
  it("agrees with the catalog's required dimensions that Studio binds with", () => {
    for (const ids of [
      ["apple-downloads"],
      ["total-downloads"],
      ["play-downloads"],
    ])
      expect(new Set(modelMeasureScope(guarded, ids))).toEqual(
        new Set(measureRequiredDimensions(guarded, ids)),
      );
  });
  it("leaves out what the query groups by or fixes to one value, like the query does", () => {
    const appA: DataExpression = {
      kind: "call",
      fn: "eq",
      args: [field("app"), literal("App A")],
    };
    const ask = (groupBy: string[], filter?: DataExpression) =>
      missingModelMeasureScope(guarded, {
        measureIds: ["total-downloads"],
        groupBy,
        ...(filter ? { filter } : {}),
      });
    expect(ask([])).toEqual(["app"]);
    expect(ask(["country"])).toEqual(["app"]);
    expect(ask(["app"])).toEqual([]);
    expect(ask([], appA)).toEqual([]);
    expect(ask([], { kind: "call", fn: "or", args: [appA, appA] })).toEqual([
      "app",
    ]);
    // Every query the helper accepts runs; every one it refuses fails on scope.
    expect(() => query(appA)).not.toThrow();
    expect(() => query(undefined, ["country"])).toThrow(
      "model_measure_scope_required",
    );
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

describe("formula measure fields", () => {
  const sales = {
    fields: [
      {
        id: "amount",
        name: "Amount",
        type: "decimal" as const,
        nullable: false,
        unit: "currency",
        currencyField: "cur",
      },
      { id: "cur", name: "Currency", type: "string" as const, nullable: false },
      { id: "units", name: "Units", type: "integer" as const, nullable: false },
    ],
  };
  const salesSources = new Map([["sales", sales]]);
  const sum = (id: string, name: string, fieldId: string) => ({
    id,
    name,
    kind: "aggregate" as const,
    datasetId: "sales",
    aggregate: { id, name, op: "sum" as const, fieldId },
  });
  const formula = (id: string, expression: DataExpression) => ({
    id,
    name: id,
    kind: "formula" as const,
    expression,
  });
  const salesModel = (
    measures: SemanticModelDefinition["measures"],
  ): SemanticModelDefinition => ({
    version: 1,
    datasets: ["sales"],
    relationships: [],
    dimensions: [],
    measures,
  });

  it("types measures like evaluateFormula", () => {
    const model = salesModel([
      sum("revenue", "Revenue", "amount"),
      sum("units", "Units", "units"),
      formula("draft", field("revenue")),
    ]);
    expect(formulaMeasureFields(model, salesSources, "draft")).toEqual([
      {
        id: "revenue",
        name: "Revenue",
        type: "decimal",
        nullable: true,
        unit: "currency",
        currencyField: "revenue.currency",
      },
      // Sums widen integers, as the query does.
      { id: "units", name: "Units", type: "decimal", nullable: true },
    ]);
  });

  it("excludes the measure and its dependents", () => {
    const model = salesModel([
      sum("revenue", "Revenue", "amount"),
      formula("draft", field("revenue")),
      formula("uses-draft", field("draft")),
      formula("uses-uses-draft", field("uses-draft")),
      formula("other", field("revenue")),
    ]);
    expect(
      formulaMeasureFields(model, salesSources, "draft").map((f) => f.id),
    ).toEqual(["revenue", "other"]);
  });

  it("excludes dependents through a cycle", () => {
    // A depends on B and M; B depends on A: both depend on M.
    const model = salesModel([
      sum("m", "M", "amount"),
      formula("a", {
        kind: "call",
        fn: "add",
        args: [field("b"), field("m")],
      }),
      formula("b", field("a")),
      sum("units", "Units", "units"),
    ]);
    const ids = formulaMeasureFields(model, salesSources, "m").map((f) => f.id);
    expect(ids).not.toContain("a");
    expect(ids).not.toContain("b");
    expect(ids).toEqual(["units"]);
  });

  it("reuses one probe of the model", () => {
    const model = salesModel([
      sum("revenue", "Revenue", "amount"),
      sum("broken", "Broken", "missing"),
      formula("draft", field("revenue")),
    ]);
    const probed = probeModelMeasures(model, salesSources);
    expect([...probed.keys()]).toEqual(["revenue", "draft"]);
    expect(formulaMeasureFields(model, salesSources, "draft", probed)).toEqual(
      formulaMeasureFields(model, salesSources, "draft"),
    );
    // Without sources, the given cells alone type the fields.
    expect(
      formulaMeasureFields(model, new Map(), "draft", probed).map((f) => f.id),
    ).toEqual(["revenue"]);
  });

  it("omits measures that fail to probe", () => {
    const model = salesModel([
      sum("revenue", "Revenue", "amount"),
      sum("broken", "Broken", "missing"),
      formula("uses-broken", field("broken")),
      formula("draft", field("revenue")),
    ]);
    expect(
      formulaMeasureFields(model, salesSources, "draft").map((f) => f.id),
    ).toEqual(["revenue"]);
  });
});

describe("ordering groups by a measure (#768)", () => {
  const names = (result: ReturnType<typeof querySemanticModel>) =>
    result.rows.map((row) => row.dimensions.app);
  it("orders the groups by one measure before paging them: a top N", () => {
    const query = {
      measureIds: ["apple-downloads", "play-downloads"],
      groupBy: ["app"],
    };
    // By their dimension without an order: App A, App B.
    expect(names(querySemanticModel(model, sources, query))).toEqual([
      "App A",
      "App B",
    ]);
    const top = querySemanticModel(model, sources, {
      ...query,
      limit: 1,
      orderBy: { measureId: "play-downloads", direction: "desc" },
    });
    expect(names(top)).toEqual(["App B"]);
    expect(top.rows[0]!.measures["play-downloads"]!.value).toBe("7");
    expect(top.totalRows).toBe(2);
    expect(
      names(
        querySemanticModel(model, sources, {
          ...query,
          orderBy: { measureId: "apple-downloads", direction: "asc" },
        }),
      ),
    ).toEqual(["App B", "App A"]);
    // A formula measure orders as well.
    expect(
      names(
        querySemanticModel(model, sources, {
          measureIds: ["total-downloads"],
          groupBy: ["app"],
          orderBy: { measureId: "total-downloads", direction: "desc" },
        }),
      ),
    ).toEqual(["App A", "App B"]);
  });

  it("puts groups without a value last in either direction", () => {
    const withC = new Map(sources);
    withC.set("apps", {
      ...apps,
      rows: [...apps.rows, { id: "c", name: "App C", country: "IT" }],
    });
    // App C has Play downloads only: no Apple downloads.
    withC.set("play", {
      ...play,
      rows: [...play.rows, { app: "c", downloads: 1 }],
    });
    for (const direction of ["asc", "desc"] as const)
      expect(
        names(
          querySemanticModel(model, withC, {
            measureIds: ["apple-downloads", "play-downloads"],
            groupBy: ["app"],
            orderBy: { measureId: "apple-downloads", direction },
          }),
        ).at(-1),
      ).toBe("App C");
  });

  it("keeps tied groups in their dimension order, in either direction", () => {
    const tied = new Map(sources);
    tied.set("play", {
      ...play,
      rows: [
        { app: "a", downloads: 5 },
        { app: "b", downloads: 5 },
      ],
    });
    for (const direction of ["asc", "desc"] as const)
      expect(
        names(
          querySemanticModel(model, tied, {
            measureIds: ["play-downloads"],
            groupBy: ["app"],
            orderBy: { measureId: "play-downloads", direction },
          }),
        ),
      ).toEqual(["App A", "App B"]);
  });

  it("ranks amounts within their currency, never across currencies", () => {
    const sales: DataTable = {
      fields: [
        { id: "app", name: "App", type: "string", nullable: false },
        {
          id: "amount",
          name: "Amount",
          type: "decimal",
          nullable: false,
          unit: "currency",
          currencyField: "cur",
        },
        { id: "cur", name: "Currency", type: "string", nullable: false },
      ],
      rows: [
        { app: "A", amount: "700", cur: "JPY" },
        { app: "B", amount: "9", cur: "USD" },
        { app: "C", amount: "12", cur: "USD" },
        { app: "D", amount: "8", cur: "EUR" },
      ],
      provenance: [{ datasetId: "sales", generationId: "sales-1" }],
    };
    const salesModel: SemanticModelDefinition = {
      version: 1,
      datasets: ["sales"],
      relationships: [],
      dimensions: [
        { id: "app", name: "App", datasetId: "sales", fieldId: "app" },
        { id: "cur", name: "Currency", datasetId: "sales", fieldId: "cur" },
      ],
      measures: [
        {
          id: "revenue",
          name: "Revenue",
          kind: "aggregate",
          datasetId: "sales",
          aggregate: {
            id: "revenue",
            name: "Revenue",
            op: "sum",
            fieldId: "amount",
          },
        },
      ],
    };
    const ranked = querySemanticModel(salesModel, new Map([["sales", sales]]), {
      measureIds: ["revenue"],
      groupBy: ["app", "cur"],
      orderBy: { measureId: "revenue", direction: "desc" },
    });
    // Currencies by code, amounts within each: 700 JPY never outranks USD.
    expect(ranked.rows.map((row) => row.dimensions.app)).toEqual([
      "D",
      "A",
      "C",
      "B",
    ]);
  });

  it("refuses an order by a measure the query does not ask for", () => {
    expect(() =>
      querySemanticModel(model, sources, {
        measureIds: ["apple-downloads"],
        groupBy: ["app"],
        orderBy: { measureId: "play-downloads", direction: "desc" },
      }),
    ).toThrow("model_result_order_invalid");
  });

  it("refuses an internal rank beside an order, or ties by an ungrouped dimension (#900)", () => {
    const rank = { key: "r", of: () => 0 };
    expect(() =>
      querySemanticModel(model, sources, {
        measureIds: ["apple-downloads"],
        groupBy: ["app"],
        orderBy: { measureId: "apple-downloads", direction: "desc" },
        rank,
      }),
    ).toThrow("model_result_order_invalid");
    expect(() =>
      querySemanticModel(model, sources, {
        measureIds: ["apple-downloads"],
        groupBy: ["app"],
        rank: { ...rank, tieBreak: "nope" },
      }),
    ).toThrow("model_result_order_invalid");
    expect(() =>
      querySemanticModel(model, sources, {
        measureIds: ["apple-downloads"],
        groupBy: ["app"],
        rank: { key: "r", of: () => 0.5 },
      }),
    ).toThrow("model_result_order_invalid");
  });
});
