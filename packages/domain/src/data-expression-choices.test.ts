import { describe, expect, it } from "vitest";
import type { DataField, DataType } from "./data-expression.js";
import {
  arithmeticOperators,
  comparisonLiteralType,
  comparisonOperators,
  comparisonRightFields,
  expressionResultType,
  operandFields,
  reconcileComparison,
  visualProblem,
} from "./data-expression-choices.js";
import type {
  DataLiteral,
  VisualModel,
  VisualOperand,
} from "./data-expression-visual.js";

const f = {
  text: { id: "country", name: "Country", type: "string", nullable: true },
  amount: {
    id: "amount",
    name: "Amount",
    type: "decimal",
    nullable: true,
    unit: "currency",
    currencyField: "cur",
  },
  day: { id: "day", name: "Day", type: "date", nullable: false },
  meta: { id: "meta", name: "Meta", type: "json", nullable: true },
  plain: { id: "plain", name: "Plain", type: "decimal", nullable: true },
  count: { id: "count", name: "Count", type: "integer", nullable: false },
  cur: { id: "cur", name: "Currency", type: "string", nullable: true },
} satisfies Record<string, DataField>;
const all: DataField[] = Object.values(f);
const field = (fieldId: string): VisualOperand => ({ kind: "field", fieldId });
const lit = (type: DataType, value: unknown): DataLiteral => ({
  kind: "literal",
  type,
  value,
});
const modelReferencing = (fieldId: string): VisualModel => ({
  kind: "condition",
  join: "and",
  items: [
    {
      kind: "comparison",
      fieldId,
      operator: "eq",
      negated: false,
      right: { kind: "literal", literal: lit("string", "x") },
    },
  ],
});

describe("type-aware builder choices", () => {
  it("offers text operators only for text", () => {
    expect(comparisonOperators(f.text, all)).toEqual([
      "eq",
      "ne",
      "lt",
      "lte",
      "gt",
      "gte",
      "in",
      "contains",
      "starts_with",
      "is_null",
    ]);
    expect(comparisonOperators(f.day, all)).not.toContain("contains");
    expect(comparisonOperators(f.day, all)).toContain("gte");
    expect(comparisonOperators(f.meta, all)).toEqual(["is_null"]);
  });

  it("offers only same-unit fields to compare", () => {
    const ids = comparisonRightFields(f.amount, "gt", all).map((x) => x.id);
    expect(ids).not.toContain("day");
    expect(ids).not.toContain("plain");
    expect(ids).toContain("amount");
    expect(comparisonRightFields(f.amount, "is_null", all)).toEqual([]);
    expect(comparisonRightFields(f.text, "in", all).map((x) => x.id)).toEqual([
      "meta",
    ]);
  });

  it("types the value input after the field and operator", () => {
    expect(comparisonLiteralType(f.amount, "gt")).toBe("decimal");
    expect(comparisonLiteralType(f.day, "in")).toBe("date");
    expect(comparisonLiteralType(f.text, "contains")).toBe("string");
    expect(comparisonLiteralType(f.text, "is_null")).toBeNull();
    expect(comparisonLiteralType(f.meta, "eq")).toBeNull();
  });

  it("offers arithmetic the checker accepts", () => {
    expect(arithmeticOperators(field("day"), field("amount"), all)).toEqual([]);
    expect(arithmeticOperators(field("amount"), field("plain"), all)).toEqual([
      "multiply",
      "divide",
    ]);
    expect(
      arithmeticOperators(
        field("amount"),
        { kind: "literal", literal: lit("integer", 2) },
        all,
      ),
    ).toEqual(["add", "subtract", "multiply", "divide"]);
    expect(arithmeticOperators(field(""), field("count"), all)).toEqual([
      "add",
      "subtract",
      "multiply",
      "divide",
    ]);
  });

  it("offers operand fields by role", () => {
    const ids = (fields: DataField[]) => fields.map((x) => x.id);
    expect(ids(operandFields(field("amount"), all, "arithmetic"))).toEqual([
      "amount",
      "plain",
      "count",
    ]);
    expect(ids(operandFields(null, all, "arithmetic"))).toEqual([
      "amount",
      "plain",
      "count",
    ]);
    expect(ids(operandFields(field("day"), all, "branch"))).toEqual(["day"]);
    expect(ids(operandFields(field("count"), all, "fallback"))).toEqual([
      "plain",
      "count",
    ]);
    expect(ids(operandFields(null, all, "fallback"))).toEqual(ids(all));
  });

  it("reconcileComparison drops a value the new field cannot take", () => {
    const row = {
      kind: "comparison",
      fieldId: "day",
      operator: "contains",
      negated: false,
      right: { kind: "literal", literal: lit("string", "DE") },
    } as const;
    expect(reconcileComparison(row, all)).toEqual({
      ...row,
      operator: "eq",
      right: undefined,
    });
  });

  it("reconcileComparison keeps what still fits and leaves missing fields alone", () => {
    const row = {
      kind: "comparison",
      fieldId: "country",
      operator: "starts_with",
      negated: true,
      right: { kind: "literal", literal: lit("string", "D") },
    } as const;
    expect(reconcileComparison(row, all)).toEqual(row);
    const gone = { ...row, fieldId: "gone" };
    expect(reconcileComparison(gone, all)).toEqual(gone);
    const list = {
      kind: "comparison",
      fieldId: "day",
      operator: "in",
      negated: false,
      right: { kind: "literal", literal: lit("json", ["DE"]) },
    } as const;
    expect(reconcileComparison(list, all)).toEqual({
      ...list,
      right: undefined,
    });
  });

  it("reports the checker's code and field", () => {
    expect(visualProblem(modelReferencing("gone"), all, "condition")).toEqual({
      code: "expression_field_not_found",
      fieldId: "gone",
    });
    expect(visualProblem(modelReferencing("country"), all, "condition")).toBe(
      null,
    );
    expect(
      visualProblem(
        { kind: "value", value: { kind: "field", fieldId: "" } },
        all,
        "calculation",
      ),
    ).toEqual({ code: "builder_incomplete" });
    expect(
      visualProblem(
        {
          kind: "value",
          value: {
            kind: "arithmetic",
            operator: "add",
            left: field("day"),
            right: field("count"),
          },
        },
        all,
        "calculation",
      ),
    ).toEqual({ code: "expression_numeric_required" });
  });

  it("reads the result type from the checker", () => {
    expect(
      expressionResultType(
        {
          kind: "call",
          fn: "divide",
          args: [
            { kind: "field", fieldId: "count" },
            { kind: "literal", type: "integer", value: 2 },
          ],
        },
        all,
      ),
    ).toMatchObject({ type: "decimal", nullable: true });
    expect(
      expressionResultType({ kind: "field", fieldId: "gone" }, all),
    ).toBeNull();
  });
});
