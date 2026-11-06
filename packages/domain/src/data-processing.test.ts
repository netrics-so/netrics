import { describe, expect, it } from "vitest";
import {
  compileRowExpression,
  exactDecimal,
  ProcessingBudget,
  type DataExpression,
  type DataField,
} from "./data-expression.js";
import {
  aggregateData,
  executePreparation,
  type DataTable,
  type PreparationGraph,
} from "./data-preparation.js";
const lit = (type: DataField["type"], value: unknown): DataExpression => ({
  kind: "literal",
  type,
  value,
});
const field = (fieldId: string): DataExpression => ({ kind: "field", fieldId });
const call = (
  fn: Extract<DataExpression, { kind: "call" }>["fn"],
  ...args: DataExpression[]
): DataExpression => ({ kind: "call", fn, args });
const fields: DataField[] = [
  { id: "amount", name: "Amount", type: "decimal", nullable: true },
  { id: "paid", name: "Paid", type: "boolean", nullable: true },
  { id: "country", name: "Country", type: "string", nullable: false },
  { id: "day", name: "Day", type: "date", nullable: false },
];
const orders: DataTable = {
  fields,
  rows: [
    { amount: "10.10", paid: true, country: "DE", day: "2026-11-01" },
    { amount: "-1.00", paid: false, country: "DE", day: "2026-11-02" },
    { amount: "2.25", paid: null, country: "FR", day: "2026-11-03" },
  ],
  provenance: [{ datasetId: "orders", generationId: "g1" }],
  expiresAt: "2026-12-01T00:00:00Z",
};
const sources = new Map([["orders", orders]]);
function run(nodes: PreparationGraph["nodes"]) {
  return executePreparation(
    {
      version: 1,
      nodes: [{ id: "source", type: "source", datasetId: "orders" }, ...nodes],
      outputs: [nodes.at(-1)?.id ?? "source"],
    },
    sources,
  ).outputs[nodes.at(-1)?.id ?? "source"]!;
}

describe("exact decimal calculations", () => {
  it("adds, subtracts and multiplies without floating-point loss", () => {
    expect(exactDecimal("add", "0.1", "0.2")).toBe("0.3");
    expect(exactDecimal("subtract", "9007199254740993.12", "0.02")).toBe(
      "9007199254740993.1",
    );
    expect(exactDecimal("multiply", "12.50", "3")).toBe("37.5");
    expect(exactDecimal("add", "-0.00", "0")).toBe("0");
  });
  it("uses half-even precision with explicit rounding and divide-by-zero warnings", () => {
    const budget = new ProcessingBudget();
    expect(exactDecimal("divide", "1", "3", budget)).toBe(
      "0.333333333333333333",
    );
    expect(budget.warnings.has("decimal_rounded")).toBe(true);
    expect(exactDecimal("divide", "1", "0", budget)).toBeNull();
    expect(budget.warnings.has("division_by_zero")).toBe(true);
    expect(() => exactDecimal("add", "1e20", "1")).toThrow("decimal_invalid");
  });
});
describe("typed row expressions", () => {
  it.each([
    [true, true, true],
    [true, false, false],
    [true, null, null],
    [false, null, false],
    [null, null, null],
  ])("implements boolean AND truth table", (left, right, result) => {
    expect(
      compileRowExpression(
        call("and", lit("boolean", left), lit("boolean", right)),
        [],
      ).evaluate({}).value,
    ).toBe(result);
  });
  it.each([
    [true, null, true],
    [false, null, null],
    [false, false, false],
    [null, null, null],
  ])("implements boolean OR truth table", (left, right, result) => {
    expect(
      compileRowExpression(
        call("or", lit("boolean", left), lit("boolean", right)),
        [],
      ).evaluate({}).value,
    ).toBe(result);
  });
  it("keeps missing distinct from zero, false and empty strings", () => {
    expect(
      compileRowExpression(
        call("eq", lit("integer", null), lit("integer", 0)),
        [],
      ).evaluate({}).value,
    ).toBeNull();
    expect(
      compileRowExpression(call("is_null", lit("boolean", false)), []).evaluate(
        {},
      ).value,
    ).toBe(false);
    expect(
      compileRowExpression(
        call("coalesce", lit("string", ""), lit("string", "fallback")),
        [],
      ).evaluate({}).value,
    ).toBe("");
  });
  it("validates both conditional branches and normalizes promoted numeric results", () => {
    const expr = compileRowExpression(
      call(
        "if",
        lit("boolean", true),
        lit("integer", 2),
        lit("decimal", "1.25"),
      ),
      [],
    );
    expect(expr.result.type).toBe("decimal");
    expect(expr.evaluate({})).toMatchObject({ type: "decimal", value: "2" });
    expect(() =>
      compileRowExpression(
        call("if", lit("boolean", true), field("missing"), lit("integer", 1)),
        fields,
      ),
    ).toThrow("expression_field_not_found");
  });
  it("does not coerce text to numbers or silently round integer casts", () => {
    expect(() =>
      compileRowExpression(
        call("add", field("amount"), lit("string", "1")),
        fields,
      ),
    ).toThrow("expression_numeric_required");
    expect(() =>
      compileRowExpression(
        call("to_integer", lit("decimal", "9007199254740991.0001")),
        [],
      ).evaluate({}),
    ).toThrow("data_cast_invalid");
    expect(() =>
      compileRowExpression(
        call("add", lit("number", 0.1), lit("decimal", "0.2")),
        [],
      ),
    ).toThrow("expression_explicit_numeric_cast_required");
  });
  it("checks currency compatibility per row rather than adding different currencies", () => {
    const f: DataField[] = [
      {
        id: "a",
        name: "A",
        type: "decimal",
        nullable: false,
        unit: "currency",
        currencyField: "ca",
      },
      {
        id: "b",
        name: "B",
        type: "decimal",
        nullable: false,
        unit: "currency",
        currencyField: "cb",
      },
      { id: "ca", name: "CA", type: "string", nullable: false },
      { id: "cb", name: "CB", type: "string", nullable: false },
    ];
    const sum = compileRowExpression(call("add", field("a"), field("b")), f);
    expect(
      sum.evaluate({ a: "1", b: "2", ca: "EUR", cb: "EUR" }),
    ).toMatchObject({ value: "3", currency: "EUR" });
    expect(() =>
      sum.evaluate({ a: "1", b: "2", ca: "EUR", cb: "USD" }),
    ).toThrow("expression_units_incompatible");
  });
  it("bounds expression work and extracts only own JSON properties", () => {
    const expression = compileRowExpression(
      call("add", lit("integer", 1), lit("integer", 2)),
      [],
    );
    expect(() => expression.evaluate({}, new ProcessingBudget(1))).toThrow(
      "processing_budget_exceeded",
    );
    const json = compileRowExpression(
      call("json_get", lit("json", { value: 2 }), lit("string", "value")),
      [],
    );
    expect(json.evaluate({}).value).toBe(2);
    expect(() =>
      compileRowExpression(
        call("json_get", lit("json", {}), lit("string", "__proto__")),
        [],
      ).evaluate({}),
    ).toThrow("expression_json_path_invalid");
  });
});
describe("reusable preparation graphs", () => {
  it("aligns appended columns by stable ID and fills missing fields with null", () => {
    const result = executePreparation(
      {
        version: 1,
        nodes: [
          { id: "a", type: "source", datasetId: "a" },
          { id: "b", type: "source", datasetId: "b" },
          { id: "combined", type: "append", inputs: ["a", "b"] },
        ],
        outputs: ["combined"],
      },
      new Map<string, DataTable>([
        [
          "a",
          {
            fields: [{ id: "a", name: "A", type: "string", nullable: false }],
            rows: [{ a: "one" }],
          },
        ],
        [
          "b",
          {
            fields: [{ id: "b", name: "B", type: "boolean", nullable: false }],
            rows: [{ b: true }],
          },
        ],
      ]),
    );
    expect(result.outputs.combined?.rows).toEqual([
      { a: "one", b: null },
      { a: null, b: true },
    ]);
    expect(result.outputs.combined?.fields.every((f) => f.nullable)).toBe(true);
  });
  it("preserves currency for calculations with a scalar on the left or a monetary literal", () => {
    const fields: DataField[] = [
      {
        id: "amount",
        name: "Amount",
        type: "decimal",
        nullable: false,
        unit: "currency",
        currencyField: "currency",
      },
      { id: "currency", name: "Currency", type: "string", nullable: false },
    ];
    const expression = call("add", lit("integer", 1), field("amount"));
    expect(
      compileRowExpression(expression, fields).evaluate({
        amount: "2",
        currency: "EUR",
      }),
    ).toMatchObject({ value: "3", unit: "currency", currency: "EUR" });
    const table = executePreparation(
      {
        version: 1,
        nodes: [
          { id: "source", type: "source", datasetId: "orders" },
          {
            id: "fee",
            type: "calculate",
            input: "source",
            fieldId: "fee",
            name: "Fee",
            expression: call(
              "add",
              {
                kind: "literal",
                type: "decimal",
                value: "1",
                unit: "currency",
                currency: "EUR",
              },
              {
                kind: "literal",
                type: "decimal",
                value: "2",
                unit: "currency",
                currency: "EUR",
              },
            ),
          },
        ],
        outputs: ["fee"],
      },
      sources,
    ).outputs.fee!;
    expect(table.fields.find((f) => f.id === "fee")?.currencyField).toBe(
      "fee.currency",
    );
    expect(table.rows[0]?.["fee.currency"]).toBe("EUR");
  });
  it("renames labels, calculates, filters and groups without modifying its source", () => {
    const before = JSON.stringify(orders);
    const result = run([
      {
        id: "rename",
        type: "rename",
        input: "source",
        names: { amount: "Income" },
      },
      {
        id: "calculated",
        type: "calculate",
        input: "rename",
        fieldId: "positive",
        name: "Positive",
        expression: call("gt", field("amount"), lit("decimal", "0")),
      },
      {
        id: "filtered",
        type: "filter",
        input: "calculated",
        expression: field("positive"),
      },
      {
        id: "grouped",
        type: "group",
        input: "filtered",
        keys: ["country"],
        aggregates: [
          { id: "total", name: "Total", op: "sum", fieldId: "amount" },
        ],
      },
    ]);
    expect(result.rows).toEqual([
      { country: "DE", total: "10.1" },
      { country: "FR", total: "2.25" },
    ]);
    expect(result.provenance).toEqual(orders.provenance);
    expect(result.expiresAt).toBe(orders.expiresAt);
    expect(JSON.stringify(orders)).toBe(before);
  });
  it("appends compatible sources and deduplicates exact normalized keys", () => {
    const result = run([
      { id: "twice", type: "append", inputs: ["source", "source"] },
      {
        id: "dedup",
        type: "deduplicate",
        input: "twice",
        keys: ["country", "day"],
        keep: "first",
      },
    ]);
    expect(result.rows).toHaveLength(3);
  });
  it("rejects missing inputs, cycles and incompatible append schemas", () => {
    expect(() =>
      run([
        {
          id: "bad",
          type: "filter",
          input: "bad",
          expression: lit("boolean", true),
        },
      ]),
    ).toThrow("preparation_cycle");
    expect(() =>
      run([
        { id: "bad", type: "select", input: "missing", fields: ["amount"] },
      ]),
    ).toThrow("preparation_input_not_found");
    expect(() =>
      run([
        {
          id: "small",
          type: "cast",
          input: "source",
          fieldId: "amount",
          to: "string",
          onError: "reject",
        },
        { id: "bad", type: "append", inputs: ["small", "source"] },
      ]),
    ).toThrow("preparation_append_schema_mismatch");
  });
  it("joins a shared dimension without fanout and makes unmatched values explicit", () => {
    const dimension: DataTable = {
      fields: [
        { id: "code", name: "Code", type: "string", nullable: false },
        { id: "name", name: "Name", type: "string", nullable: false },
      ],
      rows: [{ code: "DE", name: "Germany" }],
    };
    const graph: PreparationGraph = {
      version: 1,
      nodes: [
        { id: "orders", type: "source", datasetId: "orders" },
        { id: "countries", type: "source", datasetId: "countries" },
        {
          id: "joined",
          type: "join",
          left: "orders",
          right: "countries",
          keys: [{ left: "country", right: "code" }],
          mode: "left",
          cardinality: "many_to_one",
          rightPrefix: "country.",
        },
      ],
      outputs: ["joined"],
    };
    const joined = executePreparation(
      graph,
      new Map([...sources, ["countries", dimension]]),
    ).outputs.joined!;
    expect(joined.rows).toHaveLength(3);
    expect(joined.rows[0]?.["country.name"]).toBe("Germany");
    expect(joined.rows[2]?.["country.name"]).toBeNull();
    expect(() =>
      executePreparation(
        graph,
        new Map([
          ...sources,
          [
            "countries",
            { ...dimension, rows: [...dimension.rows, ...dimension.rows] },
          ],
        ]),
      ),
    ).toThrow("preparation_join_cardinality_violation");
  });
  it("does not let ignore-cast-errors bypass the execution budget", () => {
    const graph: PreparationGraph = {
      version: 1,
      nodes: [
        { id: "source", type: "source", datasetId: "orders" },
        {
          id: "cast",
          type: "cast",
          input: "source",
          fieldId: "country",
          to: "integer",
          onError: "null",
        },
      ],
      outputs: ["cast"],
    };
    const result = executePreparation(graph, sources);
    expect(result.rejectedRows).toBe(3);
    expect(result.outputs.cast!.rows[0]?.country).toBeNull();
    expect(() =>
      executePreparation(graph, sources, new ProcessingBudget(20)),
    ).toThrow("processing_budget_exceeded");
  });
});
describe("aggregate semantics", () => {
  it("distinguishes no data from zero and computes exact integer sums", () => {
    expect(
      aggregateData(
        { ...orders, rows: [] },
        { id: "sum", name: "Sum", op: "sum", fieldId: "amount" },
      ).value,
    ).toBeNull();
    expect(
      aggregateData(
        { ...orders, rows: [] },
        { id: "count", name: "Count", op: "count" },
      ).value,
    ).toBe(0);
    const table: DataTable = {
      fields: [{ id: "n", name: "N", type: "integer", nullable: false }],
      rows: [{ n: Number.MAX_SAFE_INTEGER }, { n: 1 }],
    };
    expect(
      aggregateData(table, { id: "sum", name: "Sum", op: "sum", fieldId: "n" })
        .value,
    ).toBe("9007199254740992");
  });
  it("rejects mixed currency totals while permitting counts", () => {
    const table: DataTable = {
      fields: [
        {
          id: "amount",
          name: "Amount",
          type: "decimal",
          nullable: false,
          unit: "currency",
          currencyField: "currency",
        },
        { id: "currency", name: "Currency", type: "string", nullable: false },
      ],
      rows: [
        { amount: "1", currency: "EUR" },
        { amount: "2", currency: "USD" },
      ],
    };
    expect(() =>
      aggregateData(table, {
        id: "sum",
        name: "Sum",
        op: "sum",
        fieldId: "amount",
      }),
    ).toThrow("aggregate_currency_mixed");
    expect(
      aggregateData(table, {
        id: "count",
        name: "Count",
        op: "count",
        fieldId: "amount",
      }).value,
    ).toBe(2);
  });
  it("requires time ordering for latest snapshots and rejects ambiguous ties", () => {
    expect(
      aggregateData(orders, {
        id: "latest",
        name: "Latest",
        op: "last",
        fieldId: "amount",
        orderBy: "day",
      }).value,
    ).toBe("2.25");
    expect(() =>
      aggregateData(orders, {
        id: "latest",
        name: "Latest",
        op: "last",
        fieldId: "amount",
      }),
    ).toThrow("aggregate_order_required");
    expect(() =>
      aggregateData(
        {
          ...orders,
          rows: [orders.rows[0]!, { ...orders.rows[0], amount: "99" }],
        },
        {
          id: "latest",
          name: "Latest",
          op: "last",
          fieldId: "amount",
          orderBy: "day",
        },
      ),
    ).toThrow("aggregate_latest_ambiguous");
  });
});

describe("typed list membership", () => {
  it("compares exact decimals and preserves null membership semantics", () => {
    const make = (value: unknown) =>
      compileRowExpression(
        call("in", field("amount"), lit("json", value)),
        fields,
      );
    expect(
      make(["9007199254740993.1"]).evaluate({ amount: "9007199254740993.10" })
        .value,
    ).toBe(true);
    expect(make(["1", null]).evaluate({ amount: "2" }).value).toBeNull();
    expect(make(["1"]).evaluate({ amount: null }).value).toBeNull();
    expect(() => make([1]).evaluate({ amount: "1" })).toThrow(
      "decimal_invalid",
    );
    expect(() => make({ one: "1" }).evaluate({ amount: "1" })).toThrow(
      "expression_list_required",
    );
  });
});

it("requires exact decimal or integer monetary literals", () => {
  expect(() =>
    compileRowExpression(
      {
        kind: "literal",
        type: "number",
        value: 0.1,
        unit: "currency",
        currency: "EUR",
      },
      [],
    ),
  ).toThrow("expression_monetary_float_unsupported");
  expect(
    compileRowExpression(
      {
        kind: "literal",
        type: "decimal",
        value: "0.1",
        unit: "currency",
        currency: "EUR",
      },
      [],
    ).evaluate({}).value,
  ).toBe("0.1");
});
