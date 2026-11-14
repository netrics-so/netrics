/**
 * The visual builder's view of a `DataExpression`. UI state only: the stored
 * definition stays the expression, and for every representable expression
 * `fromVisual(toVisual(e))` is structurally equal to `e`.
 */
import {
  dataFail,
  type DataExpression,
  type DataFunction,
} from "./data-expression.js";

export type DataLiteral = Extract<DataExpression, { kind: "literal" }>;
export type VisualOperand =
  | { kind: "field"; fieldId: string } // "" = not chosen yet
  | { kind: "literal"; literal: DataLiteral };
export const VISUAL_COMPARISONS = [
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
] as const;
export type VisualComparisonOperator = (typeof VISUAL_COMPARISONS)[number];
export interface VisualComparison {
  kind: "comparison";
  fieldId: string; // "" = not chosen yet
  operator: VisualComparisonOperator;
  negated: boolean; // wrapped in not(...)
  right?: VisualOperand; // absent only for is_null (or while incomplete)
}
export interface VisualGroup {
  kind: "group";
  join: "and" | "or";
  rows: VisualComparison[];
}
export interface VisualCondition {
  kind: "condition";
  join: "and" | "or";
  items: Array<VisualComparison | VisualGroup>;
}
export const VISUAL_ARITHMETIC = [
  "add",
  "subtract",
  "multiply",
  "divide",
] as const;
export type VisualArithmeticOperator = (typeof VISUAL_ARITHMETIC)[number];
export type VisualValue =
  | VisualOperand
  | {
      kind: "arithmetic";
      operator: VisualArithmeticOperator;
      left: VisualOperand;
      right: VisualOperand;
    };
export type VisualWrap =
  | { fn: "round"; digits: number }
  | { fn: "abs" }
  | { fn: "coalesce"; fallback: VisualOperand };
export type VisualCalculation =
  | { kind: "value"; value: VisualValue; wrap?: VisualWrap }
  | {
      kind: "if";
      condition: VisualCondition;
      then: VisualValue;
      else: VisualValue;
    }
  | { kind: "boolean"; condition: VisualCondition };
export type VisualModel = VisualCondition | VisualCalculation;
export type VisualTarget = "condition" | "calculation";
export type NotVisualReason =
  "function" | "nesting" | "operand" | "literal" | "negation" | "arity";
export type ToVisualResult =
  | { representable: true; model: VisualModel }
  | { representable: false; reason: NotVisualReason };

type Call = Extract<DataExpression, { kind: "call" }>;
type ArithmeticValue = Extract<VisualValue, { kind: "arithmetic" }>;

/** Thrown inside the reader; carries why an expression is outside the subset. */
class NotVisual {
  constructor(readonly reason: NotVisualReason) {}
}
const refuse = (reason: NotVisualReason): never => {
  throw new NotVisual(reason);
};

const comparisons: readonly string[] = VISUAL_COMPARISONS;
const arithmetic: readonly string[] = VISUAL_ARITHMETIC;
/** Functions the builder shows somewhere: inside an operand they mean nesting. */
const visualFunctions = new Set<string>([
  ...VISUAL_COMPARISONS,
  ...VISUAL_ARITHMETIC,
  "and",
  "or",
  "not",
  "if",
  "round",
  "abs",
  "coalesce",
]);
const scalarLiteralTypes: Record<string, string> = {
  string: "string",
  boolean: "boolean",
  integer: "number",
  number: "number",
  decimal: "string",
  date: "string",
  timestamp: "string",
};

const isCall = (e: DataExpression, fn: string): e is Call =>
  e.kind === "call" && e.fn === fn;
const isJoin = (e: DataExpression): e is Call =>
  isCall(e, "and") || isCall(e, "or");

function arity(e: Call, count: number) {
  if (!Array.isArray(e.args) || e.args.length !== count) refuse("arity");
}

/** A literal the builder can show and edit: non-null and of a typed input. */
function readLiteral(e: DataLiteral, list: boolean): DataLiteral {
  if (list) {
    if (
      e.type !== "json" ||
      !Array.isArray(e.value) ||
      !e.value.every(
        (item) =>
          (typeof item === "string" ||
            typeof item === "boolean" ||
            typeof item === "number") &&
          item !== null,
      )
    )
      refuse("literal");
    return e;
  }
  const valueType = scalarLiteralTypes[e.type];
  if (!valueType || e.value === null || typeof e.value !== valueType)
    refuse("literal");
  return e;
}

function readOperand(e: DataExpression, list = false): VisualOperand {
  if (e.kind === "field") return { kind: "field", fieldId: e.fieldId };
  if (e.kind === "literal")
    return { kind: "literal", literal: readLiteral(e, list) };
  return refuse(visualFunctions.has(e.fn) ? "nesting" : "function");
}

function readComparison(e: DataExpression): VisualComparison {
  if (e.kind !== "call") return refuse("operand");
  if (e.fn === "not") {
    arity(e, 1);
    const inner = e.args[0]!;
    if (inner.kind !== "call" || !comparisons.includes(inner.fn))
      refuse("negation");
    return { ...readComparison(inner), negated: true };
  }
  if (!comparisons.includes(e.fn))
    return refuse(e.fn === "and" || e.fn === "or" ? "nesting" : "function");
  const operator = e.fn as VisualComparisonOperator;
  arity(e, operator === "is_null" ? 1 : 2);
  const left = e.args[0]!;
  if (left.kind !== "field") refuse("operand");
  const row: VisualComparison = {
    kind: "comparison",
    fieldId: (left as { fieldId: string }).fieldId,
    operator,
    negated: false,
  };
  if (operator === "is_null") return row;
  const right = e.args[1]!;
  if (right.kind === "call") refuse("operand");
  row.right = readOperand(right, operator === "in");
  return row;
}

/** The left spine of a binary and/or chain, leftmost first. */
function spine(e: Call): DataExpression[] {
  const items: DataExpression[] = [];
  let node: DataExpression = e;
  while (isCall(node, e.fn)) {
    arity(node, 2);
    items.unshift(node.args[1]!);
    node = node.args[0]!;
  }
  items.unshift(node);
  return items;
}

function readGroup(e: Call): VisualGroup {
  return {
    kind: "group",
    join: e.fn as "and" | "or",
    rows: spine(e).map((leaf) => {
      if (isJoin(leaf)) refuse("nesting");
      return readComparison(leaf);
    }),
  };
}

function readCondition(e: DataExpression): VisualCondition {
  if (!isJoin(e))
    return { kind: "condition", join: "and", items: [readComparison(e)] };
  return {
    kind: "condition",
    join: e.fn as "and" | "or",
    items: spine(e).map((item) =>
      isJoin(item) ? readGroup(item) : readComparison(item),
    ),
  };
}

function readValue(e: DataExpression): VisualValue {
  if (e.kind !== "call" || !arithmetic.includes(e.fn)) return readOperand(e);
  arity(e, 2);
  return {
    kind: "arithmetic",
    operator: e.fn as VisualArithmeticOperator,
    left: readOperand(e.args[0]!),
    right: readOperand(e.args[1]!),
  };
}

function readCalculation(e: DataExpression): VisualCalculation {
  if (e.kind !== "call") return { kind: "value", value: readOperand(e) };
  if (e.fn === "if") {
    arity(e, 3);
    return {
      kind: "if",
      condition: readCondition(e.args[0]!),
      then: readValue(e.args[1]!),
      else: readValue(e.args[2]!),
    };
  }
  if (
    e.fn === "and" ||
    e.fn === "or" ||
    e.fn === "not" ||
    comparisons.includes(e.fn)
  )
    return { kind: "boolean", condition: readCondition(e) };
  if (e.fn === "round") {
    arity(e, 2);
    const value = readValue(e.args[0]!);
    const digits = e.args[1]!;
    if (
      digits.kind !== "literal" ||
      digits.type !== "integer" ||
      digits.unit !== undefined ||
      digits.currency !== undefined ||
      !Number.isSafeInteger(digits.value)
    )
      refuse("operand");
    return {
      kind: "value",
      value,
      wrap: { fn: "round", digits: (digits as DataLiteral).value as number },
    };
  }
  if (e.fn === "abs") {
    arity(e, 1);
    return { kind: "value", value: readValue(e.args[0]!), wrap: { fn: "abs" } };
  }
  if (e.fn === "coalesce") {
    arity(e, 2);
    return {
      kind: "value",
      value: readValue(e.args[0]!),
      wrap: { fn: "coalesce", fallback: readOperand(e.args[1]!) },
    };
  }
  if (arithmetic.includes(e.fn)) return { kind: "value", value: readValue(e) };
  return refuse("function");
}

/** The visual model of an expression, or why the builder cannot show it. */
export function toVisual(
  expression: DataExpression,
  target: VisualTarget,
): ToVisualResult {
  try {
    if (target === "condition") {
      if (
        expression.kind !== "call" ||
        !["and", "or", "not", ...comparisons].includes(expression.fn)
      )
        refuse("function");
      return { representable: true, model: readCondition(expression) };
    }
    return { representable: true, model: readCalculation(expression) };
  } catch (error) {
    if (error instanceof NotVisual)
      return { representable: false, reason: error.reason };
    throw error;
  }
}

const incomplete = (): never => dataFail("builder_incomplete");
const node = (fn: DataFunction, args: DataExpression[]): DataExpression => ({
  kind: "call",
  fn,
  args,
});

function writeOperand(operand: VisualOperand | undefined): DataExpression {
  if (!operand) return incomplete();
  if (operand.kind === "field") {
    if (!operand.fieldId) incomplete();
    return { kind: "field", fieldId: operand.fieldId };
  }
  const literal = operand.literal;
  if (literal.value === null || literal.value === undefined) incomplete();
  return { ...literal };
}

function writeComparison(row: VisualComparison): DataExpression {
  if (!row.fieldId) incomplete();
  const left: DataExpression = { kind: "field", fieldId: row.fieldId };
  const expression = node(
    row.operator,
    row.operator === "is_null" ? [left] : [left, writeOperand(row.right)],
  );
  return row.negated ? node("not", [expression]) : expression;
}

function chain(join: "and" | "or", items: DataExpression[]): DataExpression {
  if (!items.length) return incomplete();
  return items.reduce((left, right) => node(join, [left, right]));
}

function writeCondition(condition: VisualCondition): DataExpression {
  return chain(
    condition.join,
    condition.items.map((item) =>
      item.kind === "group"
        ? chain(item.join, item.rows.map(writeComparison))
        : writeComparison(item),
    ),
  );
}

function writeValue(value: VisualValue): DataExpression {
  if (value.kind !== "arithmetic") return writeOperand(value);
  const { operator, left, right } = value as ArithmeticValue;
  return node(operator, [writeOperand(left), writeOperand(right)]);
}

/** The expression a complete model stands for; throws `builder_incomplete`. */
export function fromVisual(model: VisualModel): DataExpression {
  switch (model.kind) {
    case "condition":
      return writeCondition(model);
    case "boolean":
      return writeCondition(model.condition);
    case "if":
      return node("if", [
        writeCondition(model.condition),
        writeValue(model.then),
        writeValue(model.else),
      ]);
    case "value": {
      const value = writeValue(model.value);
      const wrap = model.wrap;
      if (!wrap) return value;
      if (wrap.fn === "abs") return node("abs", [value]);
      if (wrap.fn === "coalesce")
        return node("coalesce", [value, writeOperand(wrap.fallback)]);
      if (!Number.isSafeInteger(wrap.digits)) incomplete();
      return node("round", [
        value,
        { kind: "literal", type: "integer", value: wrap.digits },
      ]);
    }
  }
}

/** Whether every field, value and choice of the model is filled in. */
export function visualModelComplete(model: VisualModel): boolean {
  try {
    fromVisual(model);
    return true;
  } catch {
    return false;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ":" +
            canonicalJson((value as Record<string, unknown>)[key]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "undefined";
}

/** Structural equality of two expressions (absent key = key set to undefined). */
export function sameDataExpression(
  a: DataExpression,
  b: DataExpression,
): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "field") return a.fieldId === (b as typeof a).fieldId;
  if (a.kind === "literal") {
    const other = b as typeof a;
    return (
      a.type === other.type &&
      a.unit === other.unit &&
      a.currency === other.currency &&
      canonicalJson(a.value) === canonicalJson(other.value)
    );
  }
  const other = b as typeof a;
  return (
    a.fn === other.fn &&
    a.args.length === other.args.length &&
    a.args.every((arg, index) => sameDataExpression(arg, other.args[index]!))
  );
}

/** A starting model with nothing chosen yet (incomplete by design). */
export function emptyVisualModel(target: VisualTarget): VisualModel {
  return target === "condition"
    ? {
        kind: "condition",
        join: "and",
        items: [
          { kind: "comparison", fieldId: "", operator: "eq", negated: false },
        ],
      }
    : { kind: "value", value: { kind: "field", fieldId: "" } };
}
