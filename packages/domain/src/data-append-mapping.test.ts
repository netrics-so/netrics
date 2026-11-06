import { describe, expect, it } from "vitest";
import {
  aggregateData,
  executePreparation,
  type DataTable,
  type PreparationGraph,
  type PreparationNode,
} from "./data-preparation.js";

const left: DataTable = {
  fields: [
    { id: "left_id", name: "Campaign ID", type: "string", nullable: false },
    { id: "left_name", name: "Campaign name", type: "string", nullable: false },
    { id: "left_flag", name: "Verified", type: "boolean", nullable: false },
  ],
  rows: [
    { left_id: "a", left_name: "Alpha", left_flag: false },
    { left_id: "b", left_name: "Beta", left_flag: true },
  ],
  provenance: [{ datasetId: "left", generationId: "left-v1" }],
  expiresAt: "2026-12-01T00:00:00Z",
};
const right: DataTable = {
  fields: [
    { id: "right_id", name: "Campaign ID", type: "string", nullable: false },
    {
      id: "right_name",
      name: "Campaign name",
      type: "string",
      nullable: false,
    },
    {
      id: "ignored",
      name: "Provider detail",
      type: "integer",
      nullable: false,
    },
  ],
  rows: [
    { right_id: "a", right_name: "Alpha", ignored: 0 },
    { right_id: "c", right_name: "Gamma", ignored: 1 },
  ],
  provenance: [{ datasetId: "right", generationId: "right-v2" }],
  expiresAt: "2026-11-15T00:00:00Z",
  pendingSources: ["late-provider"],
};
const mapping = {
  left: { left_id: "id", left_name: "name", left_flag: "verified" },
  right: { right_id: "id", right_name: "name" },
};
function graph(
  columnMappings?: Extract<
    PreparationNode,
    { type: "append" }
  >["columnMappings"],
  dedupe = false,
): PreparationGraph {
  return {
    version: 1,
    nodes: [
      { id: "left", type: "source", datasetId: "left" },
      { id: "right", type: "source", datasetId: "right" },
      {
        id: "combined",
        type: "append",
        inputs: ["left", "right"],
        ...(columnMappings ? { columnMappings } : {}),
      },
      ...(dedupe
        ? [
            {
              id: "unique",
              type: "deduplicate" as const,
              input: "combined",
              keys: ["id"],
              keep: "first" as const,
            },
          ]
        : []),
    ],
    outputs: [dedupe ? "unique" : "combined"],
  };
}
const sources = () =>
  new Map([
    ["left", structuredClone(left)],
    ["right", structuredClone(right)],
  ]);

describe("explicit append column mappings", () => {
  it("aligns independently created IDs, projects only confirmed columns, and supports normal deduplication", () => {
    const result = executePreparation(graph(mapping, true), sources()).outputs
      .unique!;
    expect(
      result.fields.map((field) => [
        field.id,
        field.name,
        field.type,
        field.nullable,
      ]),
    ).toEqual([
      ["id", "Campaign ID", "string", false],
      ["name", "Campaign name", "string", false],
      ["verified", "Verified", "boolean", true],
    ]);
    expect(result.rows).toEqual([
      { id: "a", name: "Alpha", verified: false },
      { id: "b", name: "Beta", verified: true },
      { id: "c", name: "Gamma", verified: null },
    ]);
    expect(result.provenance).toEqual([
      ...left.provenance!,
      ...right.provenance!,
    ]);
    expect(result.expiresAt).toBe(right.expiresAt);
    expect(result.pendingSources).toEqual(["late-provider"]);
  });
  it("does not infer matching columns from display names when mappings are omitted", () => {
    const result = executePreparation(graph(), sources()).outputs.combined!;
    expect(result.fields.map((field) => field.id)).toEqual([
      "left_id",
      "left_name",
      "left_flag",
      "right_id",
      "right_name",
      "ignored",
    ]);
    expect(result.rows[0]).toMatchObject({
      left_id: "a",
      right_id: null,
      ignored: null,
    });
    expect(result.rows[2]).toMatchObject({
      left_id: null,
      left_flag: null,
      right_id: "a",
      ignored: 0,
    });
  });
  it("keeps unmapped inputs unchanged and preserves input objects", () => {
    const input = sources(),
      before = structuredClone([...input]);
    const result = executePreparation(
      graph({ right: { right_id: "left_id", right_name: "left_name" } }),
      input,
    ).outputs.combined!;
    expect(result.rows[2]).toEqual({
      left_id: "a",
      left_name: "Alpha",
      left_flag: null,
    });
    expect([...input]).toEqual(before);
  });
  it("rewrites exact-money currency companions without weakening types, units or scale", () => {
    const money = (prefix: string, amount: string): DataTable => ({
      fields: [
        {
          id: prefix + "amount",
          name: "Proceeds",
          type: "decimal",
          nullable: false,
          unit: "currency",
          currencyField: prefix + "currency",
          scale: 2,
        },
        {
          id: prefix + "currency",
          name: "Currency",
          type: "string",
          nullable: false,
        },
      ],
      rows: [{ [prefix + "amount"]: amount, [prefix + "currency"]: "EUR" }],
    });
    const result = executePreparation(
      graph({
        left: { a_amount: "amount", a_currency: "currency" },
        right: { b_amount: "amount", b_currency: "currency" },
      }),
      new Map([
        ["left", money("a_", "9007199254740993.12")],
        ["right", money("b_", "0.10")],
      ]),
    ).outputs.combined!;
    expect(result.fields[0]).toMatchObject({
      id: "amount",
      name: "Proceeds",
      type: "decimal",
      nullable: false,
      unit: "currency",
      currencyField: "currency",
      scale: 2,
    });
    expect(result.rows[0]!.amount).toBe("9007199254740993.12");
    expect(
      aggregateData(result, {
        id: "sum",
        name: "Sum",
        op: "sum",
        fieldId: "amount",
      }),
    ).toMatchObject({
      value: "9007199254740993.22",
      currency: "EUR",
      unit: "currency",
    });
    expect(() =>
      executePreparation(
        graph({ left: { a_amount: "amount" } }),
        new Map([
          ["left", money("a_", "1.00")],
          ["right", money("b_", "2.00")],
        ]),
      ),
    ).toThrow("preparation_currency_field_required");
    const mixed = money("b_", "0.10");
    mixed.rows[0]!.b_currency = "USD";
    const currencies = executePreparation(
      graph({
        left: { a_amount: "amount", a_currency: "currency" },
        right: { b_amount: "amount", b_currency: "currency" },
      }),
      new Map([
        ["left", money("a_", "1.00")],
        ["right", mixed],
      ]),
    ).outputs.combined!;
    expect(currencies.rows.map((row) => row.currency)).toEqual(["EUR", "USD"]);
    expect(() =>
      aggregateData(currencies, {
        id: "sum",
        name: "Sum",
        op: "sum",
        fieldId: "amount",
      }),
    ).toThrow("aggregate_currency_mixed");
    expect(() =>
      executePreparation(
        graph({
          left: { a_amount: "amount", a_currency: "currency_a" },
          right: { b_amount: "amount", b_currency: "currency_b" },
        }),
        new Map([
          ["left", money("a_", "1.00")],
          ["right", money("b_", "2.00")],
        ]),
      ),
    ).toThrow("preparation_append_schema_mismatch");
  });
  it("rejects unknown inputs or fields, duplicate targets and empty projections", () => {
    const twice = graph();
    const append = twice.nodes[2]!;
    if (append.type !== "append") throw new Error("fixture");
    append.inputs = ["left", "left"];
    expect(() => executePreparation(twice, sources())).toThrow(
      "preparation_append_inputs_duplicate",
    );
    expect(() =>
      executePreparation(graph({ missing: { left_id: "id" } }), sources()),
    ).toThrow("preparation_append_mapping_input_invalid");
    expect(() =>
      executePreparation(graph({ left: { missing: "id" } }), sources()),
    ).toThrow("data_field_not_found");
    expect(() =>
      executePreparation(
        graph({ left: { left_id: "id", left_name: "id" } }),
        sources(),
      ),
    ).toThrow("data_schema_invalid");
    expect(() => executePreparation(graph({ left: {} }), sources())).toThrow(
      "data_schema_invalid",
    );
  });
  it.each(["__proto__", "prototype", "constructor", "Upper", "has space", ""])(
    "rejects invalid/reserved target ID %j",
    (target) => {
      expect(() =>
        executePreparation(graph({ left: { left_id: target } }), sources()),
      ).toThrow("data_field_invalid");
    },
  );
  it("still rejects conflicting types and units after columns align", () => {
    const typeMismatch = sources();
    typeMismatch.set("right", {
      fields: [
        { id: "value", name: "Value", type: "integer", nullable: false },
      ],
      rows: [{ value: 1 }],
    });
    expect(() =>
      executePreparation(
        graph({ left: { left_id: "id" }, right: { value: "id" } }),
        typeMismatch,
      ),
    ).toThrow("preparation_append_schema_mismatch");
    const unitMismatch = new Map([
      [
        "left",
        {
          fields: [
            {
              id: "a",
              name: "Value",
              type: "decimal" as const,
              nullable: false,
              unit: "stars",
            },
          ],
          rows: [{ a: "1" }],
        },
      ],
      [
        "right",
        {
          fields: [
            {
              id: "b",
              name: "Value",
              type: "decimal" as const,
              nullable: false,
              unit: "downloads",
            },
          ],
          rows: [{ b: "1" }],
        },
      ],
    ]);
    expect(() =>
      executePreparation(
        graph({ left: { a: "value" }, right: { b: "value" } }),
        unitMismatch,
      ),
    ).toThrow("preparation_append_schema_mismatch");
  });
});
