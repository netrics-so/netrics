/**
 * Memoised choices of the visual builder for one field list. The domain's
 * choice functions trial-compile candidates (up to 4·n² compiles for
 * arithmetic), so each answer is computed once per field list and input.
 */
import {
  arithmeticOperators,
  comparisonOperators,
  comparisonRightFields,
  operandFields,
  type DataField,
  type VisualArithmeticOperator,
  type VisualComparisonOperator,
  type VisualOperand,
} from "@netrics/domain";

export interface BuilderChoices {
  fields: readonly DataField[];
  field(fieldId: string): DataField | undefined;
  /** Fields with at least one offered comparison operator. */
  comparable(): DataField[];
  operators(field: DataField): VisualComparisonOperator[];
  rightFields(
    field: DataField,
    operator: VisualComparisonOperator,
  ): DataField[];
  arithmetic(
    left: VisualOperand,
    right: VisualOperand,
  ): VisualArithmeticOperator[];
  operandFields(
    other: VisualOperand | null,
    role: "arithmetic" | "branch" | "fallback",
  ): DataField[];
}

function memo<T>(cache: Map<string, T>, key: string, compute: () => T): T {
  if (!cache.has(key)) cache.set(key, compute());
  return cache.get(key)!;
}

/** Operands are cached by what the checker sees: the field or the literal. */
const operandKey = (operand: VisualOperand | null) =>
  operand === null
    ? "-"
    : operand.kind === "field"
      ? "f:" + operand.fieldId
      : "l:" +
        JSON.stringify([
          operand.literal.type,
          operand.literal.value,
          operand.literal.unit,
          operand.literal.currency,
        ]);

export function builderChoices(fields: readonly DataField[]): BuilderChoices {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const operators = new Map<string, VisualComparisonOperator[]>();
  const right = new Map<string, DataField[]>();
  const arithmetic = new Map<string, VisualArithmeticOperator[]>();
  const operands = new Map<string, DataField[]>();
  let comparable: DataField[] | undefined;
  const choices: BuilderChoices = {
    fields,
    field: (fieldId) => byId.get(fieldId),
    comparable: () =>
      (comparable ??= fields.filter(
        (field) => choices.operators(field).length > 0,
      )),
    operators: (field) =>
      memo(operators, field.id, () => comparisonOperators(field, fields)),
    rightFields: (field, operator) =>
      memo(right, field.id + "\u0000" + operator, () =>
        comparisonRightFields(field, operator, fields),
      ),
    arithmetic: (left, rightOperand) =>
      memo(
        arithmetic,
        operandKey(left) + "\u0000" + operandKey(rightOperand),
        () => arithmeticOperators(left, rightOperand, fields),
      ),
    operandFields: (other, role) =>
      memo(operands, role + "\u0000" + operandKey(other), () =>
        operandFields(other, fields, role),
      ),
  };
  return choices;
}
