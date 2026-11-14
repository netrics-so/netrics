/**
 * What the visual builder offers, decided by the engine's type checker: each
 * choice is kept iff a candidate expression using it compiles with
 * `compileRowExpression`. No type rules are restated here.
 */
import {
  compileRowExpression,
  DataProcessingError,
  validateDataValue,
  type DataExpression,
  type DataField,
  type DataType,
  type ExpressionType,
} from "./data-expression.js";
import {
  fromVisual,
  VISUAL_ARITHMETIC,
  VISUAL_COMPARISONS,
  visualModelComplete,
  type DataLiteral,
  type VisualArithmeticOperator,
  type VisualComparison,
  type VisualComparisonOperator,
  type VisualCondition,
  type VisualModel,
  type VisualOperand,
  type VisualTarget,
} from "./data-expression-visual.js";

/** Stand-in right-hand values for trial comparisons, by the field's type. */
const SAMPLE_VALUES: Partial<Record<DataType, unknown>> = {
  string: "",
  boolean: true,
  integer: 0,
  number: 0,
  decimal: "0",
  date: "2000-01-01",
  timestamp: "2000-01-01T00:00:00Z",
};
const EMPTY_LIST: DataLiteral = { kind: "literal", type: "json", value: [] };
const SCALAR_ZERO: DataLiteral = { kind: "literal", type: "integer", value: 0 };
const TRUE: DataLiteral = { kind: "literal", type: "boolean", value: true };

const ref = (fieldId: string): DataExpression => ({ kind: "field", fieldId });
const call = (
  fn: Extract<DataExpression, { kind: "call" }>["fn"],
  args: DataExpression[],
): DataExpression => ({ kind: "call", fn, args });

/** The result type the checker gives the expression, or null if it refuses. */
export function expressionResultType(
  expression: DataExpression,
  fields: readonly DataField[],
): ExpressionType | null {
  try {
    return compileRowExpression(expression, fields).result;
  } catch {
    return null;
  }
}

const compiles = (expression: DataExpression, fields: readonly DataField[]) =>
  expressionResultType(expression, fields) !== null;
const isCondition = (
  expression: DataExpression,
  fields: readonly DataField[],
) => expressionResultType(expression, fields)?.type === "boolean";

/** The field list with `field` in it, so a trial can reference it. */
function including(field: DataField, fields: readonly DataField[]) {
  return fields.some((f) => f.id === field.id) ? fields : [...fields, field];
}

function operandExpression(operand: VisualOperand): DataExpression | null {
  if (operand.kind === "field")
    return operand.fieldId ? ref(operand.fieldId) : null;
  return operand.literal.value === null || operand.literal.value === undefined
    ? null
    : operand.literal;
}

function sampleRight(
  field: DataField,
  operator: VisualComparisonOperator,
): DataExpression | null {
  if (operator === "in") return EMPTY_LIST;
  if (!(field.type in SAMPLE_VALUES)) return null;
  return {
    kind: "literal",
    type: field.type,
    value: SAMPLE_VALUES[field.type],
  };
}

function comparison(
  field: DataField,
  operator: VisualComparisonOperator,
  right: DataExpression | null,
): DataExpression {
  return call(
    operator,
    operator === "is_null" ? [ref(field.id)] : [ref(field.id), right!],
  );
}

/** Operators the checker accepts with this field on the left. */
export function comparisonOperators(
  field: DataField,
  fields: readonly DataField[],
): VisualComparisonOperator[] {
  const scope = including(field, fields);
  return VISUAL_COMPARISONS.filter((operator) => {
    const right = sampleRight(field, operator);
    if (operator !== "is_null" && !right) return false;
    return isCondition(comparison(field, operator, right), scope);
  });
}

/** Fields that may stand on the right of `field <operator> …`. */
export function comparisonRightFields(
  field: DataField,
  operator: VisualComparisonOperator,
  fields: readonly DataField[],
): DataField[] {
  if (operator === "is_null") return [];
  const scope = including(field, fields);
  return fields.filter((candidate) =>
    isCondition(comparison(field, operator, ref(candidate.id)), scope),
  );
}

/** The type of the value input; for `in` the type of each list item. */
export function comparisonLiteralType(
  field: DataField,
  operator: VisualComparisonOperator,
): DataType | null {
  if (operator === "is_null" || field.type === "json") return null;
  return field.type;
}

/** Arithmetic operators the checker accepts for the two operands. */
export function arithmeticOperators(
  left: VisualOperand,
  right: VisualOperand,
  fields: readonly DataField[],
): VisualArithmeticOperator[] {
  // An operand not chosen yet stands for any field that could fill it.
  const options = (operand: VisualOperand) => {
    const expression = operandExpression(operand);
    return expression ? [expression] : fields.map((f) => ref(f.id));
  };
  const lefts = options(left),
    rights = options(right);
  return VISUAL_ARITHMETIC.filter((operator) =>
    lefts.some((a) =>
      rights.some((b) => compiles(call(operator, [a, b]), fields)),
    ),
  );
}

/** Fields that fit an operand slot next to `other` (null: not chosen yet). */
export function operandFields(
  other: VisualOperand | null,
  fields: readonly DataField[],
  role: "arithmetic" | "branch" | "fallback",
): DataField[] {
  const known = other ? operandExpression(other) : null;
  return fields.filter((candidate) => {
    const self = ref(candidate.id);
    if (role === "arithmetic") {
      const partner = known ?? SCALAR_ZERO;
      return VISUAL_ARITHMETIC.some(
        (operator) =>
          compiles(call(operator, [self, partner]), fields) ||
          compiles(call(operator, [partner, self]), fields),
      );
    }
    if (role === "branch")
      return compiles(call("if", [TRUE, self, known ?? self]), fields);
    return compiles(call("coalesce", [known ?? self, self]), fields);
  });
}

/** Why a list literal does not fit the field, as the engine would say at run time. */
function listItemProblem(
  field: DataField,
  right: DataExpression,
): DataProcessingError | null {
  if (right.kind !== "literal" || !Array.isArray(right.value)) return null;
  try {
    for (const item of right.value) validateDataValue(field.type, item, false);
    return null;
  } catch (error) {
    if (error instanceof DataProcessingError) return error;
    throw error;
  }
}

/**
 * After the field changed: keep the operator if still offered (else the first
 * offered one) and the value only if the whole comparison still checks. A row
 * whose field is missing is left as it is, so it can be shown and kept.
 */
export function reconcileComparison(
  row: VisualComparison,
  fields: readonly DataField[],
): VisualComparison {
  const field = fields.find((f) => f.id === row.fieldId);
  if (!field) return row;
  const offered = comparisonOperators(field, fields);
  const operator = offered.includes(row.operator)
    ? row.operator
    : (offered[0] ?? "is_null");
  const { right, ...rest } = row;
  const value =
    right && operator !== "is_null" ? operandExpression(right) : null;
  const keep =
    value !== null &&
    isCondition(comparison(field, operator, value), fields) &&
    !(operator === "in" && listItemProblem(field, value));
  return keep ? { ...rest, operator, right } : { ...rest, operator };
}

function conditionRows(condition: VisualCondition): VisualComparison[] {
  return condition.items.flatMap((item) =>
    item.kind === "group" ? item.rows : [item],
  );
}

function modelRows(model: VisualModel): VisualComparison[] {
  if (model.kind === "condition") return conditionRows(model);
  if (model.kind === "if" || model.kind === "boolean")
    return conditionRows(model.condition);
  return [];
}

/** The first problem saving the model would hit, or null when it checks. */
export function visualProblem(
  model: VisualModel,
  fields: readonly DataField[],
  target: VisualTarget,
): { code: string; fieldId?: string } | null {
  if (!visualModelComplete(model)) return { code: "builder_incomplete" };
  const expression = fromVisual(model);
  let result: ExpressionType;
  try {
    result = compileRowExpression(expression, fields).result;
  } catch (error) {
    if (!(error instanceof DataProcessingError)) throw error;
    return error.fieldId
      ? { code: error.code, fieldId: error.fieldId }
      : { code: error.code };
  }
  for (const row of modelRows(model)) {
    const field = fields.find((f) => f.id === row.fieldId);
    const right = row.right ? operandExpression(row.right) : null;
    const problem =
      field && row.operator === "in" && right
        ? listItemProblem(field, right)
        : null;
    if (problem) return { code: problem.code, fieldId: row.fieldId };
  }
  if (target === "condition" && result.type !== "boolean")
    return { code: "expression_type_mismatch" };
  return null;
}
