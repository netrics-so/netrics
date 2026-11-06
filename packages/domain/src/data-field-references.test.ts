import { describe, expect, it } from "vitest";
import {
  preparationFieldReferences,
  semanticModelFieldReferences,
} from "./data-field-references.js";
import {
  executePreparation,
  type DataTable,
  type PreparationGraph,
  type PreparationNode,
} from "./data-preparation.js";
import {
  ProcessingBudget,
  type DataExpression,
  type DataField,
} from "./data-expression.js";
import type { SemanticModelDefinition } from "./data-model.js";

const field = (fieldId: string): DataExpression => ({ kind: "field", fieldId });
const literal = (type: DataField["type"], value: unknown): DataExpression => ({
  kind: "literal",
  type,
  value,
});
const call = (
  fn: Extract<DataExpression, { kind: "call" }>["fn"],
  ...args: DataExpression[]
): DataExpression => ({ kind: "call", fn, args });
const table = (fields: Array<[string, DataField["type"]]>): DataTable => ({
  fields: fields.map(([id, type]) => ({ id, name: id, type, nullable: false })),
  rows: [],
});
const a = table([
  ["id", "string"],
  ["amount", "decimal"],
  ["paid", "boolean"],
  ["country", "string"],
  ["day", "date"],
  ["label", "string"],
  ["unused", "string"],
]);
const b = table([
  ["bid", "string"],
  ["value", "decimal"],
  ["name", "string"],
]);
const sources = new Map([
  ["a", a],
  ["b", b],
]);
const graph = (
  nodes: PreparationNode[],
  output = nodes.at(-1)!.id,
): PreparationGraph => ({ version: 1, nodes, outputs: [output] });
const summary = (references: Map<string, Set<string>>) =>
  Object.fromEntries(
    [...references]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, fields]) => [id, [...fields].sort()]),
  );
const refs = (recipe: PreparationGraph, fields: string[], inputs = sources) =>
  summary(
    preparationFieldReferences(
      recipe,
      inputs,
      recipe.outputs[0]!,
      new Set(fields),
    ),
  );

describe("semantic model field references", () => {
  const model: SemanticModelDefinition = {
    version: 1,
    datasets: ["a", "b", "presence"],
    relationships: [
      {
        id: "mapping",
        from: { datasetId: "a", fieldId: "id" },
        to: { datasetId: "b", fieldId: "bid" },
        cardinality: "many_to_one",
      },
    ],
    dimensions: [
      {
        id: "market",
        name: "Market",
        datasetId: "a",
        fieldId: "country",
        labelFieldId: "label",
      },
    ],
    measures: [
      {
        id: "latest",
        name: "Latest",
        kind: "aggregate",
        datasetId: "a",
        aggregate: {
          id: "latest",
          name: "Latest",
          op: "last",
          fieldId: "amount",
          orderBy: "day",
          filter: field("paid"),
        },
      },
      {
        id: "rows",
        name: "Rows",
        kind: "aggregate",
        datasetId: "presence",
        aggregate: { id: "rows", name: "Rows", op: "count" },
      },
      {
        id: "known",
        name: "Known",
        kind: "aggregate",
        datasetId: "b",
        aggregate: {
          id: "known",
          name: "Known",
          op: "count",
          fieldId: "value",
        },
      },
      {
        id: "sum",
        name: "Sum",
        kind: "aggregate",
        datasetId: "a",
        aggregate: {
          id: "sum",
          name: "Sum",
          op: "sum",
          fieldId: "amount",
          orderBy: "unused",
        },
      },
      {
        id: "ratio",
        name: "Ratio",
        kind: "formula",
        expression: call("divide", field("latest"), field("known")),
        requiredDimensions: ["market"],
      },
    ],
  };
  it("includes all declarations, labels, relationship keys, aggregate predicates and LAST order without treating measure IDs as columns", () => {
    expect(summary(semanticModelFieldReferences(model))).toEqual({
      a: ["amount", "country", "day", "id", "label", "paid"],
      b: ["bid", "value"],
      presence: [],
    });
  });
  it("uses canonical measure-cycle detection and bounds aggregate predicate ASTs", () => {
    expect(() =>
      semanticModelFieldReferences({
        ...model,
        measures: [
          { id: "one", name: "One", kind: "formula", expression: field("two") },
          { id: "two", name: "Two", kind: "formula", expression: field("one") },
        ],
      }),
    ).toThrow("model_measure_cycle");
    let expression = field("paid");
    for (let i = 0; i < 18; i++) expression = call("not", expression);
    expect(() =>
      semanticModelFieldReferences({
        ...model,
        measures: [
          {
            id: "count",
            name: "Count",
            kind: "aggregate",
            datasetId: "a",
            aggregate: {
              id: "count",
              name: "Count",
              op: "count",
              filter: expression,
            },
          },
        ],
      }),
    ).toThrow("expression_complexity_limit");
  });
});

describe("preparation field origins and row dependencies", () => {
  it("retains required origins through calculations, casts, replacements and renames while dropping an unused projected-out field", () => {
    const recipe = graph([
      { id: "source", type: "source", datasetId: "a" },
      {
        id: "calculate",
        type: "calculate",
        input: "source",
        fieldId: "twice",
        name: "Twice",
        expression: call("multiply", field("amount"), literal("decimal", "2")),
      },
      {
        id: "cast",
        type: "cast",
        input: "calculate",
        fieldId: "id",
        to: "integer",
        onError: "null",
      },
      {
        id: "replace",
        type: "replace",
        input: "cast",
        fieldId: "paid",
        from: false,
        to: true,
      },
      {
        id: "rename",
        type: "rename",
        input: "replace",
        names: { twice: "New label" },
      },
      {
        id: "filter",
        type: "filter",
        input: "rename",
        expression: field("paid"),
      },
      {
        id: "dedupe",
        type: "deduplicate",
        input: "filter",
        keys: ["id"],
        keep: "last",
      },
      { id: "select", type: "select", input: "dedupe", fields: ["twice"] },
    ]);
    expect(refs(recipe, ["twice"])).toEqual({ a: ["amount", "id", "paid"] });
    expect(refs(recipe, [])).toEqual({ a: ["id", "paid"] });
  });
  it("keeps the original CAST input dependency even when the result's type is fixed", () => {
    const recipe = graph([
      { id: "source", type: "source", datasetId: "a" },
      {
        id: "cast",
        type: "cast",
        input: "source",
        fieldId: "id",
        to: "integer",
        onError: "reject",
      },
      { id: "select", type: "select", input: "cast", fields: ["id"] },
    ]);
    expect(refs(recipe, ["id"])).toEqual({ a: ["id"] });
    expect(refs(recipe, [])).toEqual({ a: [] });
  });
  it("tracks JSON extraction and text/date predicates in the same AST scope", () => {
    const input = table([
      ["blob", "json"],
      ["day", "date"],
      ["label", "string"],
    ]);
    const recipe = graph([
      { id: "source", type: "source", datasetId: "json" },
      {
        id: "extract",
        type: "calculate",
        input: "source",
        fieldId: "entry",
        name: "Entry",
        expression: call("json_get", field("blob"), literal("string", "value")),
      },
      {
        id: "filter",
        type: "filter",
        input: "extract",
        expression: call(
          "and",
          call("eq", call("year", field("day")), literal("integer", 2026)),
          call("contains", field("label"), literal("string", "Launch")),
        ),
      },
    ]);
    expect(refs(recipe, ["entry"], new Map([["json", input]]))).toEqual({
      json: ["blob", "day", "label"],
    });
  });
  it.each(["left", "inner"] as const)(
    "tracks both %s join keys even when only a left value or row count is used",
    (mode) => {
      const recipe = graph([
        { id: "left", type: "source", datasetId: "a" },
        { id: "right", type: "source", datasetId: "b" },
        {
          id: "join",
          type: "join",
          left: "left",
          right: "right",
          keys: [{ left: "id", right: "bid" }],
          mode,
          cardinality: "many_to_one",
          rightPrefix: "dim.",
        },
      ]);
      expect(refs(recipe, ["amount"])).toEqual({
        a: ["amount", "id"],
        b: ["bid"],
      });
      expect(refs(recipe, ["dim.name"])).toEqual({
        a: ["id"],
        b: ["bid", "name"],
      });
      expect(refs(recipe, [])).toEqual({ a: ["id"], b: ["bid"] });
    },
  );
  it("matches explicit append columns back to independent source IDs", () => {
    const recipe = graph([
      { id: "a", type: "source", datasetId: "a" },
      { id: "b", type: "source", datasetId: "b" },
      { id: "a_cols", type: "select", input: "a", fields: ["id", "amount"] },
      { id: "b_cols", type: "select", input: "b", fields: ["bid", "value"] },
      {
        id: "append",
        type: "append",
        inputs: ["a_cols", "b_cols"],
        columnMappings: { b_cols: { bid: "id", value: "amount" } },
      },
    ]);
    expect(refs(recipe, ["amount"])).toEqual({ a: ["amount"], b: ["value"] });
    expect(refs(recipe, [])).toEqual({ a: [], b: [] });
    const union = {
      ...recipe,
      nodes: recipe.nodes.map((node) =>
        node.type === "append" ? { ...node, columnMappings: undefined } : node,
      ),
    };
    expect(refs(union, ["amount"])).toEqual({ a: ["amount"], b: [] });
  });
  it("matches canonical append behavior for an inherited mapping name", () => {
    const recipe = graph([
      { id: "constructor", type: "source", datasetId: "a" },
      { id: "other", type: "source", datasetId: "b" },
      {
        id: "append",
        type: "append",
        inputs: ["constructor", "other"],
        columnMappings: { other: { bid: "id", value: "amount" } },
      },
    ]);
    expect(refs(recipe, ["amount"])).toEqual({ a: ["amount"], b: ["value"] });
  });
  it("keeps grouping grain separate from aggregate operands, filters and LAST order", () => {
    const recipe = graph([
      { id: "source", type: "source", datasetId: "a" },
      {
        id: "group",
        type: "group",
        input: "source",
        keys: ["country"],
        aggregates: [
          { id: "n", name: "Rows", op: "count" },
          {
            id: "sum",
            name: "Sum",
            op: "sum",
            fieldId: "amount",
            filter: field("paid"),
            orderBy: "unused",
          },
          {
            id: "latest",
            name: "Latest",
            op: "last",
            fieldId: "amount",
            orderBy: "day",
          },
        ],
      },
    ]);
    expect(refs(recipe, [])).toEqual({ a: ["country"] });
    expect(refs(recipe, ["n"])).toEqual({ a: ["country"] });
    expect(refs(recipe, ["sum"])).toEqual({ a: ["amount", "country", "paid"] });
    expect(refs(recipe, ["latest"])).toEqual({
      a: ["amount", "country", "day"],
    });
  });
  it("tracks generated money companions through calculations and grouping", () => {
    const money = table([
      ["amount", "decimal"],
      ["currency", "string"],
      ["unused", "string"],
    ]);
    money.fields[0] = {
      ...money.fields[0]!,
      unit: "currency",
      currencyField: "currency",
      scale: 2,
    };
    const input = new Map([["money", money]]);
    const calculated = graph([
      { id: "source", type: "source", datasetId: "money" },
      {
        id: "calculate",
        type: "calculate",
        input: "source",
        fieldId: "twice",
        name: "Twice",
        expression: call("multiply", field("amount"), literal("decimal", "2")),
      },
    ]);
    expect(refs(calculated, ["twice.currency"], input)).toEqual({
      money: ["amount", "currency"],
    });
    const grouped = graph([
      ...calculated.nodes,
      {
        id: "group",
        type: "group",
        input: "calculate",
        keys: [],
        aggregates: [
          { id: "total", name: "Total", op: "sum", fieldId: "twice" },
        ],
      },
    ]);
    expect(refs(grouped, ["total.currency"], input)).toEqual({
      money: ["amount", "currency"],
    });
  });
  it("maps money values and currency companions across independently authored append columns", () => {
    const left = table([
      ["amount", "decimal"],
      ["currency", "string"],
    ]);
    left.fields[0] = {
      ...left.fields[0]!,
      unit: "currency",
      currencyField: "currency",
      scale: 2,
    };
    const right = table([
      ["revenue", "decimal"],
      ["ccy", "string"],
    ]);
    right.fields[0] = {
      ...right.fields[0]!,
      unit: "currency",
      currencyField: "ccy",
      scale: 2,
    };
    const recipe = graph([
      { id: "left", type: "source", datasetId: "left" },
      { id: "right", type: "source", datasetId: "right" },
      {
        id: "append",
        type: "append",
        inputs: ["left", "right"],
        columnMappings: { right: { revenue: "amount", ccy: "currency" } },
      },
    ]);
    const input = new Map([
      ["left", left],
      ["right", right],
    ]);
    expect(refs(recipe, ["amount"], input)).toEqual({
      left: ["amount", "currency"],
      right: ["ccy", "revenue"],
    });
    expect(refs(recipe, ["currency"], input)).toEqual({
      left: ["currency"],
      right: ["ccy"],
    });
    expect(refs(recipe, [], input)).toEqual({ left: [], right: [] });
  });
  it("does not mistake an existing .currency-named column or aggregate for a generated companion", () => {
    const input = table([
      ["amount", "decimal"],
      ["scalar.currency", "string"],
    ]);
    const calculated = graph([
      { id: "source", type: "source", datasetId: "input" },
      {
        id: "calculate",
        type: "calculate",
        input: "source",
        fieldId: "scalar",
        name: "Scalar",
        expression: literal("decimal", "1"),
      },
    ]);
    expect(
      refs(calculated, ["scalar.currency"], new Map([["input", input]])),
    ).toEqual({ input: ["scalar.currency"] });
    const grouped = graph([
      { id: "source", type: "source", datasetId: "input" },
      {
        id: "group",
        type: "group",
        input: "source",
        keys: [],
        aggregates: [
          { id: "n.currency", name: "Value", op: "sum", fieldId: "amount" },
          { id: "n", name: "Rows", op: "count" },
        ],
      },
    ]);
    expect(refs(grouped, ["n.currency"], new Map([["input", input]]))).toEqual({
      input: ["amount"],
    });
  });
  it("does not interpret source values, and preserves exact execution results when observing schemas", () => {
    const exact = "12345678901234567890.123456789012345678";
    const input: DataTable = {
      fields: [
        { id: "amount", name: "Amount", type: "decimal", nullable: false },
      ],
      rows: [{ amount: exact }],
    };
    const inputs = new Map([["exact", input]]);
    const recipe = graph([
      { id: "source", type: "source", datasetId: "exact" },
      {
        id: "calculate",
        type: "calculate",
        input: "source",
        fieldId: "same",
        name: "Same",
        expression: call("multiply", field("amount"), literal("decimal", "1")),
      },
    ]);
    const plain = executePreparation(recipe, inputs);
    const observed: string[] = [];
    const result = executePreparation(
      recipe,
      inputs,
      new ProcessingBudget(),
      (node) => observed.push(node.id),
    );
    expect(result).toEqual(plain);
    expect(result.outputs.calculate!.rows[0]!.same).toBe(exact);
    expect(observed).toEqual(["source", "calculate"]);
    const inaccessible = {
      ...input,
      rows: [
        {
          get amount(): never {
            throw new Error("values must not be read");
          },
        },
      ],
    };
    expect(refs(recipe, ["same"], new Map([["exact", inaccessible]]))).toEqual({
      exact: ["amount"],
    });
    expect(input.rows[0]!.amount).toBe(exact);
  });
  it("uses canonical graph/AST guards and charges the supplied budget", () => {
    expect(() =>
      refs(
        graph([
          { id: "cycle", type: "select", input: "cycle", fields: ["id"] },
        ]),
        [],
      ),
    ).toThrow("preparation_cycle");
    const recipe = graph([{ id: "source", type: "source", datasetId: "a" }]);
    expect(() =>
      preparationFieldReferences(
        recipe,
        sources,
        "source",
        new Set(["missing"]),
      ),
    ).toThrow("data_field_not_found");
    expect(() =>
      preparationFieldReferences(
        recipe,
        sources,
        "source",
        new Set(["id"]),
        new ProcessingBudget(2),
      ),
    ).toThrow("processing_budget_exceeded");
    let expression = field("paid");
    for (let i = 0; i < 18; i++) expression = call("not", expression);
    expect(() =>
      refs(
        graph([
          ...recipe.nodes,
          { id: "filter", type: "filter", input: "source", expression },
        ]),
        [],
      ),
    ).toThrow("expression_complexity_limit");
  });
});
