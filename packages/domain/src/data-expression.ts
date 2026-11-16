/** Portable, bounded expressions shared by data preparation and model measures. */
export const DATA_EXECUTION_VERSION = 4;
export const DATA_TYPES = [
  "string",
  "boolean",
  "integer",
  "number",
  "decimal",
  "date",
  "timestamp",
  "json",
] as const;
export type DataType =
  | "string"
  | "boolean"
  | "integer"
  | "number"
  | "decimal"
  | "date"
  | "timestamp"
  | "json";
export interface DataField {
  id: string;
  name: string;
  type: DataType;
  nullable: boolean;
  unit?: string;
  currencyField?: string;
  scale?: number;
}
export type DataRow = Record<string, unknown>;
export const DATA_FUNCTIONS = [
  "add",
  "subtract",
  "multiply",
  "divide",
  "negate",
  "abs",
  "round",
  "eq",
  "in",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "and",
  "or",
  "not",
  "if",
  "coalesce",
  "is_null",
  "concat",
  "lower",
  "upper",
  "trim",
  "contains",
  "starts_with",
  "length",
  "to_string",
  "to_decimal",
  "to_integer",
  "to_number",
  "to_boolean",
  "to_date",
  "to_timestamp",
  "to_json",
  "year",
  "month",
  "json_get",
] as const;
export type DataFunction = (typeof DATA_FUNCTIONS)[number];
export type DataExpression =
  | { kind: "field"; fieldId: string }
  | {
      kind: "literal";
      type: DataType;
      value: unknown;
      unit?: string;
      currency?: string;
    }
  | { kind: "call"; fn: DataFunction; args: DataExpression[] };
export interface DataCell {
  value: unknown;
  type: DataType;
  unit?: string;
  currency?: string;
  scalar?: boolean;
}
export interface ExpressionType {
  type: DataType;
  nullable: boolean;
  unit?: string;
  currencyField?: string;
  currency?: string;
  scalar?: boolean;
  nullLiteral?: boolean;
}
export const PROCESSING_LIMITS = {
  rows: 100_000,
  fields: 100,
  nodes: 200,
  depth: 16,
  steps: 100,
  operations: 5_000_000,
  cellBytes: 65_536,
  outputBytes: 134_217_728,
} as const;
export class DataProcessingError extends Error {
  constructor(
    public readonly code: string,
    public readonly fieldId?: string,
    /** Id of the preparation step (PreparationNode.id) whose work failed. */
    public readonly nodeId?: string,
    /** How many values the failure concerns, where the message names it. */
    public readonly count?: number,
  ) {
    super(fieldId ? `${code}: ${fieldId}` : code);
    this.name = "DataProcessingError";
  }
}
export function dataFail(
  code: string,
  fieldId?: string,
  nodeId?: string,
): never {
  throw new DataProcessingError(code, fieldId, nodeId);
}
/** Failures of the whole run's operation budget, never of one step. */
const GRAPH_LEVEL_CODES: ReadonlySet<string> = new Set([
  "processing_budget_exceeded",
  "processing_budget_invalid",
]);
/** `error` attributed to `nodeId`, unless it is not a DataProcessingError, is a whole-run budget failure, or a deeper step already claimed it (then `error` itself). */
export function attributeDataError(error: unknown, nodeId: string): unknown {
  if (
    !(error instanceof DataProcessingError) ||
    error.nodeId !== undefined ||
    GRAPH_LEVEL_CODES.has(error.code)
  )
    return error;
  return new DataProcessingError(error.code, error.fieldId, nodeId);
}
export class ProcessingBudget {
  operations = 0;
  readonly warnings = new Set<string>();
  /** Results rounded to the supported 18 decimal places so far. */
  decimalRoundings = 0;
  /**
   * Decimal cells of this run that may differ from the exact result: a
   * bound on the difference, and how many roundings it accounts for. A
   * ROUND whose operand stays within one rounding step drops the warning
   * (#645); a rounding the bound misses leaves the warning in place.
   */
  readonly decimalErrors = new WeakMap<
    object,
    { error: bigint; roundings: number }
  >();
  /**
   * Measure results whose one rounding was taken back (`deferRounding`):
   * whoever shows or uses the value warns, unless a ROUND discards the lost
   * digits (#680).
   */
  readonly deferredRoundings = new WeakMap<
    object,
    { error: bigint; roundings: number }
  >();
  readonly maximum: number;
  readonly maxRows: number;
  readonly maxOutputBytes: number;
  constructor(
    maximum: number | null = PROCESSING_LIMITS.operations,
    limits: {
      rows?: number | null;
      outputBytes?: number | null;
    } = {},
  ) {
    this.maximum = maximum ?? Infinity;
    this.maxRows =
      limits.rows === null ? Infinity : (limits.rows ?? PROCESSING_LIMITS.rows);
    this.maxOutputBytes =
      limits.outputBytes === null
        ? Infinity
        : (limits.outputBytes ?? PROCESSING_LIMITS.outputBytes);
    if (
      [this.maximum, this.maxRows, this.maxOutputBytes].some(
        (value) =>
          value !== Infinity && (!Number.isSafeInteger(value) || value < 1),
      )
    )
      dataFail("processing_budget_invalid");
  }
  tick(amount = 1) {
    this.operations += amount;
    if (this.operations > this.maximum) dataFail("processing_budget_exceeded");
  }
}
interface Decimal {
  units: bigint;
  scale: number;
}
const decimalPattern = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
function decimal(value: unknown): Decimal {
  if (
    typeof value !== "string" ||
    !decimalPattern.test(value) ||
    value.replace(/[-.]/g, "").length > 38 ||
    (value.split(".")[1]?.length ?? 0) > 18
  )
    dataFail("decimal_invalid");
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  return {
    units: BigInt((negative ? "-" : "") + whole + fraction),
    scale: fraction.length,
  };
}
function power(scale: number) {
  return 10n ** BigInt(scale);
}
function halfEven(
  numerator: bigint,
  denominator: bigint,
): { units: bigint; rounded: boolean } {
  if (denominator === 0n) dataFail("division_by_zero");
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator,
    d = denominator < 0n ? -denominator : denominator;
  let q = n / d;
  const remainder = n % d;
  if (remainder * 2n > d || (remainder * 2n === d && q % 2n !== 0n)) q++;
  return { units: negative ? -q : q, rounded: remainder !== 0n };
}
/**
 * Error bounds of decimal results are counted in units of 10^-40, rounded
 * up: a bound that grows a little only warns more, and its size stays fixed
 * however long the calculation (#645).
 */
const BOUND_SCALE = 40;
const BOUND_ONE = 10n ** BigInt(BOUND_SCALE);
/** Half a unit in the 18th place: the most a half-even rounding there moves. */
const HALF_ULP = 5n * 10n ** BigInt(BOUND_SCALE - 19);
const ceilDiv = (n: bigint, d: bigint) => (n + d - 1n) / d;
const magnitude = (d: Decimal): bigint => (d.units < 0n ? -d.units : d.units);
/** |x| · bound, in bound units, rounded up. */
const scaleBound = (x: Decimal, bound: bigint): bigint =>
  bound === 0n ? 0n : ceilDiv(magnitude(x) * bound, power(x.scale));

/** Precision lost that nobody asked for: beyond the supported 18 places. */
function implicitlyRounded(budget: ProcessingBudget) {
  budget.warnings.add("decimal_rounded");
  budget.decimalRoundings++;
}
/** Where a measure's evaluation started, for `deferRounding`. */
export interface RoundingMark {
  roundings: number;
  warned: boolean;
}
export function roundingMark(budget: ProcessingBudget): RoundingMark {
  return {
    roundings: budget.decimalRoundings,
    warned: budget.warnings.has("decimal_rounded"),
  };
}
/**
 * A measure result `result` (computed as `cell` since `mark`) whose only
 * rounding is covered by `cell`'s error bound does not warn by itself: the
 * warning moves to whoever shows or uses it (`useDeferredRounding`, or a
 * formula reading it), so a ROUND in another measure can discard the lost
 * digits (#680).
 */
export function deferRounding(
  budget: ProcessingBudget,
  mark: RoundingMark,
  cell: DataCell,
  result: object,
) {
  const bound = budget.decimalErrors.get(cell);
  if (
    !bound ||
    cell.type !== "decimal" ||
    typeof cell.value !== "string" ||
    budget.decimalRoundings - mark.roundings !== bound.roundings
  )
    return;
  budget.decimalRoundings = mark.roundings;
  if (!mark.warned) budget.warnings.delete("decimal_rounded");
  budget.deferredRoundings.set(result, bound);
}
/** `result` is shown or used as it is: its deferred rounding warns now. */
export function useDeferredRounding(budget: ProcessingBudget, result: object) {
  if (budget.deferredRoundings.has(result)) implicitlyRounded(budget);
}
/** `to` shows the value of `from` unchanged: it keeps the deferral. */
export function carryDeferredRounding(
  budget: ProcessingBudget,
  from: object,
  to: object,
) {
  const bound = budget.deferredRoundings.get(from);
  if (bound) budget.deferredRoundings.set(to, bound);
}
/** A quotient rounded once at 18 places from exact operands (AVG, #680). */
export function roundedOnce(budget: ProcessingBudget, cell: DataCell) {
  budget.decimalErrors.set(cell, { error: HALF_ULP, roundings: 1 });
}
/** An explicit ROUND to `maximumScale` places warns of nothing. */
function decimalText(
  input: Decimal,
  budget: ProcessingBudget,
  maximumScale = 18,
  explicit = false,
): string {
  let { units, scale } = input;
  if (scale > maximumScale) {
    const rounded = halfEven(units, power(scale - maximumScale));
    units = rounded.units;
    if (rounded.rounded && !explicit) implicitlyRounded(budget);
    scale = maximumScale;
  }
  while (scale > 0 && units % 10n === 0n) {
    units /= 10n;
    scale--;
  }
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString();
  if (digits.length > 38) dataFail("decimal_precision_exceeded");
  if (!scale) return (negative ? "-" : "") + digits;
  const padded = digits.padStart(scale + 1, "0");
  return (
    (negative ? "-" : "") + padded.slice(0, -scale) + "." + padded.slice(-scale)
  );
}
export function exactDecimal(
  op: "add" | "subtract" | "multiply" | "divide",
  left: string,
  right: string,
  budget = new ProcessingBudget(),
): string | null {
  const a = decimal(left),
    b = decimal(right);
  const scale = Math.max(a.scale, b.scale);
  switch (op) {
    case "add":
      return decimalText(
        {
          units:
            a.units * power(scale - a.scale) + b.units * power(scale - b.scale),
          scale,
        },
        budget,
      );
    case "subtract":
      return decimalText(
        {
          units:
            a.units * power(scale - a.scale) - b.units * power(scale - b.scale),
          scale,
        },
        budget,
      );
    case "multiply":
      return decimalText(
        { units: a.units * b.units, scale: a.scale + b.scale },
        budget,
      );
    case "divide": {
      if (b.units === 0n) {
        budget.warnings.add("division_by_zero");
        return null;
      }
      const result = halfEven(
        a.units * power(b.scale + 18),
        b.units * power(a.scale),
      );
      if (result.rounded) implicitlyRounded(budget);
      return decimalText({ units: result.units, scale: 18 }, budget);
    }
  }
}
/** Type errors of one call that a column operand causes. */
const OPERAND_TYPE_CODES: ReadonlySet<string> = new Set([
  "expression_numeric_required",
  "expression_explicit_numeric_cast_required",
  "expression_type_mismatch",
  "expression_units_incompatible",
  "expression_json_not_comparable",
  "expression_date_required",
]);
/**
 * A type error of a call, naming the column operand that causes it (#629):
 * for a number requirement only a column that is not a number; for other
 * type errors only the one column operand of a call with one or two
 * operands. Branches of `if` and `coalesce` that do not match have no
 * single cause, so they name none. Errors that name a column already, or
 * whose cause is not one column, stay as they are.
 */
function withOperandField(
  error: unknown,
  fn: string,
  args: readonly DataExpression[],
  types: readonly ExpressionType[],
): unknown {
  if (
    !(error instanceof DataProcessingError) ||
    error.fieldId !== undefined ||
    !OPERAND_TYPE_CODES.has(error.code) ||
    fn === "if" ||
    fn === "coalesce"
  )
    return error;
  const columns = args.flatMap((arg, index) =>
    arg.kind === "field" ? [{ fieldId: arg.fieldId, type: types[index]! }] : [],
  );
  const operand =
    error.code === "expression_numeric_required"
      ? columns.find((column) => !numeric(column.type.type))
      : columns.length === 1 && args.length <= 2
        ? columns[0]
        : undefined;
  return operand
    ? new DataProcessingError(error.code, operand.fieldId, error.nodeId)
    : error;
}
function numeric(type: DataType) {
  return ["integer", "decimal", "number"].includes(type);
}
function numericType(a: DataType, b: DataType): DataType {
  if (!numeric(a) || !numeric(b))
    return dataFail("expression_numeric_required");
  if (
    (a === "decimal" && b === "number") ||
    (a === "number" && b === "decimal")
  )
    return dataFail("expression_explicit_numeric_cast_required");
  return a === "decimal" || b === "decimal"
    ? "decimal"
    : a === "number" || b === "number"
      ? "number"
      : "integer";
}
function contextualNumericType(
  a: Pick<ExpressionType, "type" | "scalar">,
  b: Pick<ExpressionType, "type" | "scalar">,
): DataType {
  if (
    (a.type === "number" && !a.scalar && b.type === "decimal" && b.scalar) ||
    (b.type === "number" && !b.scalar && a.type === "decimal" && a.scalar)
  )
    return "number";
  return numericType(a.type, b.type);
}
export function compareDataValues(
  type: DataType,
  left: unknown,
  right: unknown,
): number {
  if (left === undefined || right === undefined) dataFail("data_value_missing");
  if (left === null || right === null) dataFail("expression_null_comparison");
  if (type === "decimal") {
    const a = decimal(left),
      b = decimal(right),
      scale = Math.max(a.scale, b.scale);
    const x = a.units * power(scale - a.scale),
      y = b.units * power(scale - b.scale);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (type === "timestamp") {
    const key = (value: unknown) =>
      String(value).replace(
        /(?:\.([0-9]+))?Z$/,
        (_m, f: string | undefined) => "." + (f ?? "").padEnd(9, "0") + "Z",
      );
    const a = key(left),
      b = key(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (type === "json") return dataFail("expression_json_not_comparable");
  return left < right ? -1 : left > right ? 1 : 0;
}
export function validateDataValue(
  type: DataType,
  value: unknown,
  nullable: boolean,
): void {
  if (!DATA_TYPES.includes(type)) dataFail("data_type_invalid");
  if (value === null) {
    if (!nullable) dataFail("data_null_not_allowed");
    return;
  }
  if (type === "decimal") {
    decimal(value);
    return;
  }
  if (type === "integer") {
    if (typeof value !== "number" || !Number.isSafeInteger(value))
      dataFail("data_integer_invalid");
    return;
  }
  if (type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value))
      dataFail("data_number_invalid");
    return;
  }
  if (type === "boolean") {
    if (typeof value !== "boolean") dataFail("data_boolean_invalid");
    return;
  }
  if (type === "json") {
    const stack: Array<[unknown, number]> = [[value, 0]];
    let nodes = 0;
    while (stack.length) {
      const [v, depth] = stack.pop()!;
      if (++nodes > 10000 || depth > 8) dataFail("data_json_limit");
      if (
        v === null ||
        typeof v === "string" ||
        typeof v === "boolean" ||
        (typeof v === "number" && Number.isFinite(v))
      )
        continue;
      if (
        typeof v !== "object" ||
        (!Array.isArray(v) &&
          Object.getPrototypeOf(v) !== Object.prototype &&
          Object.getPrototypeOf(v) !== null)
      )
        dataFail("data_json_invalid");
      for (const item of Object.values(v)) stack.push([item, depth + 1]);
    }
    return;
  }
  if (typeof value !== "string") dataFail("data_string_required");
  if (new TextEncoder().encode(value).length > PROCESSING_LIMITS.cellBytes)
    dataFail("data_cell_limit");
  if (
    type === "date" &&
    (!/^\d{4}-\d\d-\d\d$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value)
  )
    dataFail("data_date_invalid");
  if (type === "timestamp") {
    const match = /^(\d{4}-\d\d-\d\d)T\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.exec(
      value,
    );
    if (!match || !Number.isFinite(Date.parse(value)))
      dataFail("data_timestamp_invalid");
    validateDataValue("date", match[1], false);
  }
}
function toDecimal(value: unknown, type: DataType): string {
  if (type === "decimal") return String(value);
  if (type === "integer") return String(value);
  return dataFail("expression_explicit_numeric_cast_required");
}
function sameUnit(a: DataCell, b: DataCell) {
  if (
    (a.unit !== b.unit || a.currency !== b.currency) &&
    !a.scalar &&
    !b.scalar
  )
    dataFail("expression_units_incompatible");
}
function mergedType(a: ExpressionType, b: ExpressionType): ExpressionType {
  if (a.nullLiteral) return { ...b, nullable: true };
  if (b.nullLiteral) return { ...a, nullable: true };
  const type = a.type === b.type ? a.type : contextualNumericType(a, b);
  if (a.unit !== b.unit && !a.scalar && !b.scalar)
    dataFail("expression_units_incompatible");
  if (a.currencyField !== b.currencyField && !a.scalar && !b.scalar)
    dataFail("expression_currency_context_ambiguous");
  return {
    type,
    nullable: a.nullable || b.nullable,
    ...((a.unit ?? b.unit) ? { unit: a.unit ?? b.unit } : {}),
    ...((a.currency ?? b.currency)
      ? { currency: a.currency ?? b.currency }
      : {}),
    ...(a.scalar && b.scalar ? { scalar: true } : {}),
    ...(a.currencyField
      ? { currencyField: a.currencyField }
      : b.currencyField
        ? { currencyField: b.currencyField }
        : {}),
  };
}
export interface CompiledExpression {
  result: ExpressionType;
  /**
   * `sources`: the measure result each field's value was taken from, so a
   * rounding deferred on it (`deferRounding`) warns when read, or is traced
   * to a ROUND that discards it (#680).
   */
  evaluate(
    row: DataRow,
    budget?: ProcessingBudget,
    sources?: Readonly<Record<string, object>>,
  ): DataCell;
}

/** Steps an error bound passes through on its way to ROUND (and IF branches). */
const BOUND_STEPS: ReadonlySet<string> = new Set([
  "add",
  "subtract",
  "multiply",
  "divide",
  "coalesce",
  "negate",
  "abs",
  "to_decimal",
]);
/** `to` keeps the error bound of `from` (the same decimal, or its sign changed). */
function carry(budget: ProcessingBudget, from: DataCell, to: DataCell) {
  const bound = budget.decimalErrors.get(from);
  // A decimal made a number (an IF next to a number column) is no longer
  // the value the bound describes.
  if (bound && to.type === "decimal" && typeof to.value === "string")
    budget.decimalErrors.set(to, bound);
  return to;
}

/**
 * The error bound of `cell = x fn y` from the operands' bounds (an operand
 * without one is exact) and this operation's own `roundings` (at most half
 * a unit in the 18th place). A quotient whose divisor may be zero within
 * its bound, or a value rounded more than once, gets none: its roundings
 * stay unaccounted for, and a ROUND of it keeps the warning. Exact
 * arithmetic of exact operands returns before any work.
 */
function boundError(
  budget: ProcessingBudget,
  cell: DataCell,
  fn: "add" | "subtract" | "multiply" | "divide",
  xText: string,
  yText: string,
  a: DataCell,
  b: DataCell,
  roundings: number,
) {
  const ba = budget.decimalErrors.get(a),
    bb = budget.decimalErrors.get(b);
  // Only one rounding is traced to ROUND: a value rounded again on its way
  // keeps its warning.
  if ((ba?.roundings ?? 0) + (bb?.roundings ?? 0) + roundings !== 1) return;
  const ea = ba?.error ?? 0n,
    eb = bb?.error ?? 0n;
  let error: bigint;
  if (fn === "add" || fn === "subtract" || (ea === 0n && eb === 0n))
    error = ea + eb;
  else {
    const x = decimal(xText),
      y = decimal(yText);
    if (fn === "multiply")
      error =
        scaleBound(x, eb) + scaleBound(y, ea) + ceilDiv(ea * eb, BOUND_ONE);
    else {
      // |x/y - X/Y| <= (|x|·eb + |y|·ea) / (|y|·(|y| - eb)), when |y| > eb.
      const uy = magnitude(y);
      const margin = uy * BOUND_ONE - eb * power(y.scale);
      if (margin <= 0n) return;
      const top = scaleBound(x, eb) + scaleBound(y, ea);
      error = ceilDiv(top * power(2 * y.scale) * BOUND_ONE, uy * margin);
    }
  }
  error += HALF_ULP * BigInt(roundings);
  budget.decimalErrors.set(cell, { error, roundings: 1 });
}

/** Compile once, before reading rows. Never eval user code or interpolate SQL. */
export function compileRowExpression(
  expression: DataExpression,
  fields: readonly DataField[],
  /**
   * `traceResult`: the result records an error bound, as an operand of a
   * ROUND does, so the caller can defer its rounding (`deferRounding`).
   */
  options: { traceResult?: boolean } = {},
): CompiledExpression {
  const byId = new Map(fields.map((f) => [f.id, f]));
  let nodes = 0;
  let sources: Readonly<Record<string, object>> | undefined;
  type Node = {
    result: ExpressionType;
    run: (row: DataRow, budget: ProcessingBudget) => DataCell;
  };
  /**
   * `traced`: the node feeds a ROUND through steps that carry an error
   * bound, so its decimal results record one (#645). Elsewhere nothing is
   * recorded and nothing is paid for it.
   */
  const compile = (
    expr: DataExpression,
    depth: number,
    traced = false,
  ): Node => {
    if (++nodes > PROCESSING_LIMITS.nodes || depth > PROCESSING_LIMITS.depth)
      dataFail("expression_complexity_limit");
    if (!expr || typeof expr !== "object") dataFail("expression_invalid");
    if (expr.kind === "field") {
      const field = byId.get(expr.fieldId);
      if (!field) dataFail("expression_field_not_found", expr.fieldId);
      return {
        result: {
          type: field.type,
          nullable: field.nullable,
          ...(field.unit ? { unit: field.unit } : {}),
          ...(field.currencyField
            ? { currencyField: field.currencyField }
            : {}),
        },
        run: (row, budget) => {
          budget.tick();
          if (!Object.hasOwn(row, field.id))
            dataFail("data_field_missing", field.id);
          const value = row[field.id];
          validateDataValue(field.type, value, field.nullable);
          const currency = field.currencyField
            ? row[field.currencyField]
            : undefined;
          if (
            value !== null &&
            field.currencyField &&
            (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency))
          )
            dataFail("data_currency_invalid");
          const cell: DataCell = {
            value,
            type: field.type,
            ...(field.unit ? { unit: field.unit } : {}),
            ...(typeof currency === "string" ? { currency } : {}),
          };
          // A measure whose rounding was deferred: reading it is where the
          // precision is lost, unless a ROUND above discards it (#680).
          const source = sources?.[field.id];
          const bound = source && budget.deferredRoundings.get(source);
          if (bound && typeof value === "string") {
            implicitlyRounded(budget);
            if (traced) budget.decimalErrors.set(cell, bound);
          }
          return cell;
        },
      };
    }
    if (expr.kind === "literal") {
      if (
        expr.type === "number" &&
        (expr.currency ||
          expr.unit === "currency" ||
          expr.unit === "currency_minor")
      )
        dataFail("expression_monetary_float_unsupported");
      validateDataValue(expr.type, expr.value, true);
      if (expr.currency && (!/^[A-Z]{3}$/.test(expr.currency) || !expr.unit))
        dataFail("expression_literal_unit_invalid");
      return {
        result: {
          type: expr.type,
          nullable: expr.value === null,
          ...(expr.value === null ? { nullLiteral: true } : {}),
          ...(numeric(expr.type) && !expr.unit ? { scalar: true } : {}),
          ...(expr.currency ? { currency: expr.currency } : {}),
          ...(expr.unit ? { unit: expr.unit } : {}),
        },
        run: (_row, budget) => {
          budget.tick();
          return {
            value: expr.value,
            ...(numeric(expr.type) && !expr.unit ? { scalar: true } : {}),
            type: expr.type,
            ...(expr.unit ? { unit: expr.unit } : {}),
            ...(expr.currency ? { currency: expr.currency } : {}),
          };
        },
      };
    }
    if (
      expr.kind !== "call" ||
      !Array.isArray(expr.args) ||
      expr.args.length > 20
    )
      dataFail("expression_invalid");
    const fn = expr.fn;
    const args = expr.args.map((arg, index) =>
      compile(
        arg,
        depth + 1,
        fn === "round"
          ? index === 0
          : traced && (BOUND_STEPS.has(fn) || (fn === "if" && index > 0)),
      ),
    );
    const types = args.map((arg) => arg.result);
    const arity = (min: number, max = min) => {
      if (args.length < min || args.length > max)
        dataFail("expression_arity_invalid");
    };
    // The operand at `index` must have `type`; a column operand is named.
    const required = (index: number, type: DataType) => {
      const arg = expr.args[index];
      if (types[index]?.type !== type)
        dataFail(
          "expression_type_mismatch",
          arg?.kind === "field" ? arg.fieldId : undefined,
        );
    };
    let result: ExpressionType = {
      type: "boolean",
      nullable: types.some((t) => t.nullable),
    };
    try {
      if (["add", "subtract", "multiply", "divide"].includes(fn)) {
        arity(2);
        const a = types[0]!,
          b = types[1]!;
        let type = a.nullLiteral
          ? b.type
          : b.nullLiteral
            ? a.type
            : contextualNumericType(a, b);
        if (!numeric(type)) dataFail("expression_numeric_required");
        if (fn === "divide" && type === "integer") type = "decimal";
        if (
          ["add", "subtract"].includes(fn) &&
          a.unit !== b.unit &&
          !a.scalar &&
          !b.scalar
        )
          dataFail("expression_units_incompatible");
        const unit = ["add", "subtract"].includes(fn)
          ? (a.unit ?? b.unit)
          : fn === "divide" && a.unit === b.unit
            ? undefined
            : a.unit && b.unit
              ? `${a.unit}${fn === "divide" ? "/" : "*"}${b.unit}`
              : fn === "divide" && b.unit
                ? "1/" + b.unit
                : (a.unit ?? b.unit);
        result = {
          type,
          nullable: result.nullable || fn === "divide",
          ...(unit ? { unit } : {}),
          ...(unit && (a.currency ?? b.currency)
            ? { currency: a.currency ?? b.currency }
            : {}),
          ...(a.scalar && b.scalar ? { scalar: true } : {}),
          ...(unit && (a.currencyField ?? b.currencyField)
            ? { currencyField: a.currencyField ?? b.currencyField }
            : {}),
        };
      } else if (["eq", "ne", "lt", "lte", "gt", "gte"].includes(fn)) {
        arity(2);
        if (
          types[0]!.type !== types[1]!.type &&
          !types[0]!.nullLiteral &&
          !types[1]!.nullLiteral
        )
          contextualNumericType(types[0]!, types[1]!);
        if (types.some((t) => t.type === "json" && !t.nullLiteral))
          dataFail("expression_json_not_comparable");
        if (
          types[0]!.unit !== types[1]!.unit &&
          !types[0]!.scalar &&
          !types[1]!.scalar
        )
          dataFail("expression_units_incompatible");
      } else if (fn === "in") {
        arity(2);
        required(1, "json");
        if (types[0]!.type === "json")
          dataFail("expression_json_not_comparable");
        result = { type: "boolean", nullable: true };
      } else if (fn === "and" || fn === "or") {
        arity(2);
        required(0, "boolean");
        required(1, "boolean");
      } else if (fn === "not") {
        arity(1);
        required(0, "boolean");
      } else if (fn === "is_null") {
        arity(1);
        result = { type: "boolean", nullable: false };
      } else if (fn === "if") {
        arity(3);
        required(0, "boolean");
        result = mergedType(types[1]!, types[2]!);
      } else if (fn === "coalesce") {
        arity(2, 20);
        result = types.reduce(mergedType);
        result.nullable = types.every((t) => t.nullable);
      } else if (fn === "negate" || fn === "abs" || fn === "round") {
        arity(fn === "round" ? 2 : 1);
        if (!numeric(types[0]!.type)) dataFail("expression_numeric_required");
        if (fn === "round") required(1, "integer");
        result = { ...types[0]! };
      } else if (
        [
          "concat",
          "lower",
          "upper",
          "trim",
          "contains",
          "starts_with",
          "length",
        ].includes(fn)
      ) {
        arity(
          ["concat", "contains", "starts_with"].includes(fn) ? 2 : 1,
          fn === "concat"
            ? 20
            : ["contains", "starts_with"].includes(fn)
              ? 2
              : 1,
        );
        types.forEach((_t, index) => required(index, "string"));
        result = {
          type:
            fn === "length"
              ? "integer"
              : ["contains", "starts_with"].includes(fn)
                ? "boolean"
                : "string",
          nullable: result.nullable,
        };
      } else if (
        [
          "to_string",
          "to_decimal",
          "to_integer",
          "to_number",
          "to_boolean",
          "to_date",
          "to_timestamp",
          "to_json",
        ].includes(fn)
      ) {
        arity(1);
        result = {
          type: fn.slice(3) as DataType,
          nullable: types[0]!.nullable,
        };
      } else if (fn === "year" || fn === "month") {
        arity(1);
        if (!["date", "timestamp"].includes(types[0]!.type))
          dataFail("expression_date_required");
        result = { type: "integer", nullable: types[0]!.nullable };
      } else if (fn === "json_get") {
        arity(2);
        required(0, "json");
        required(1, "string");
        result = { type: "json", nullable: true };
      } else dataFail("expression_function_unknown");
    } catch (error) {
      throw withOperandField(error, fn, expr.args, types);
    }
    return {
      result,
      run: (row, budget) => {
        budget.tick();
        const roundings = budget.decimalRoundings,
          warned = fn === "round" && budget.warnings.has("decimal_rounded");
        const at = (index: number) => args[index]!.run(row, budget);
        const promote = (cell: DataCell): DataCell => ({
          ...cell,
          type: result.type,
          ...(result.unit ? { unit: result.unit } : {}),
          ...((cell.currency ??
          result.currency ??
          (result.currencyField ? row[result.currencyField] : undefined))
            ? {
                currency: String(
                  cell.currency ??
                    result.currency ??
                    row[result.currencyField!],
                ),
              }
            : {}),
          value:
            cell.value === null
              ? null
              : result.type === "decimal" && cell.type === "integer"
                ? String(cell.value)
                : result.type === "number" &&
                    cell.type === "decimal" &&
                    cell.scalar
                  ? Number(cell.value)
                  : cell.value,
        });
        // The chosen value keeps its error bound.
        const chosen = (cell: DataCell) =>
          traced ? carry(budget, cell, promote(cell)) : promote(cell);
        if (fn === "if") return chosen(at(at(0).value === true ? 1 : 2));
        if (fn === "coalesce") {
          for (const arg of args) {
            const cell = arg.run(row, budget);
            if (cell.value !== null) return chosen(cell);
          }
          return {
            value: null,
            type: result.type,
            ...(result.scalar ? { scalar: true } : {}),
            ...(result.unit ? { unit: result.unit } : {}),
          };
        }
        const a = at(0);
        if (fn === "is_null")
          return { value: a.value === null, type: "boolean" };
        if (fn === "and" && a.value === false)
          return { value: false, type: "boolean" };
        if (fn === "or" && a.value === true)
          return { value: true, type: "boolean" };
        const cells = [a, ...args.slice(1).map((arg) => arg.run(row, budget))];
        const b = cells[1];
        const out = (value: unknown): DataCell => {
          validateDataValue(result.type, value, true);
          if (typeof value === "string")
            budget.tick(Math.ceil(value.length / 256));
          return {
            value,
            type: result.type,
            ...(result.scalar ? { scalar: true } : {}),
            ...(result.unit ? { unit: result.unit } : {}),
            ...(result.unit && (a.currency ?? b?.currency)
              ? { currency: a.currency ?? b?.currency }
              : {}),
          };
        };
        if (fn === "and")
          return out(
            a.value === false || b!.value === false
              ? false
              : a.value === null || b!.value === null
                ? null
                : true,
          );
        if (fn === "or")
          return out(
            a.value === true || b!.value === true
              ? true
              : a.value === null || b!.value === null
                ? null
                : false,
          );
        if (cells.some((c) => c.value === null)) return out(null);
        if (fn === "in") {
          if (!Array.isArray(b!.value)) dataFail("expression_list_required");
          let missing = false,
            matched = false;
          for (const candidate of b!.value) {
            budget.tick();
            if (candidate === null) {
              missing = true;
              continue;
            }
            validateDataValue(a.type, candidate, false);
            if (compareDataValues(a.type, a.value, candidate) === 0)
              matched = true;
          }
          return out(matched ? true : missing ? null : false);
        }
        if (["add", "subtract", "multiply", "divide"].includes(fn)) {
          if (["add", "subtract"].includes(fn)) sameUnit(a, b!);
          if (fn === "multiply" && a.currency && b?.currency)
            dataFail("expression_monetary_product_unsupported");
          if (
            fn === "divide" &&
            a.currency &&
            b?.currency &&
            a.currency !== b.currency
          )
            dataFail("expression_units_incompatible");
          if (result.type === "decimal") {
            const before = budget.decimalRoundings;
            const x = toDecimal(a.value, a.type),
              y = toDecimal(b!.value, b!.type);
            const value = exactDecimal(
              fn as "add" | "subtract" | "multiply" | "divide",
              x,
              y,
              budget,
            );
            const cell = out(value);
            if (traced && value !== null)
              boundError(
                budget,
                cell,
                fn as "add" | "subtract" | "multiply" | "divide",
                x,
                y,
                a,
                b!,
                budget.decimalRoundings - before,
              );
            return cell;
          }
          const x = Number(a.value),
            y = Number(b!.value);
          if (fn === "divide" && y === 0) {
            budget.warnings.add("division_by_zero");
            return out(null);
          }
          return out(
            fn === "add"
              ? x + y
              : fn === "subtract"
                ? x - y
                : fn === "multiply"
                  ? x * y
                  : x / y,
          );
        }
        if (["eq", "ne", "lt", "lte", "gt", "gte"].includes(fn)) {
          sameUnit(a, b!);
          const type =
            a.type === b!.type ? a.type : contextualNumericType(a, b!);
          const order = compareDataValues(
            type,
            type === "decimal"
              ? toDecimal(a.value, a.type)
              : type === "number"
                ? Number(a.value)
                : a.value,
            type === "decimal"
              ? toDecimal(b!.value, b!.type)
              : type === "number"
                ? Number(b!.value)
                : b!.value,
          );
          return out(
            fn === "eq"
              ? order === 0
              : fn === "ne"
                ? order !== 0
                : fn === "lt"
                  ? order < 0
                  : fn === "lte"
                    ? order <= 0
                    : fn === "gt"
                      ? order > 0
                      : order >= 0,
          );
        }
        if (fn === "not") return out(!a.value);
        if (fn === "negate" || fn === "abs") {
          if (a.type === "decimal") {
            const d = decimal(a.value);
            // ||x| - |X|| <= |x - X|: the bound carries over.
            return carry(
              budget,
              a,
              out(
                decimalText(
                  {
                    units:
                      fn === "negate"
                        ? -d.units
                        : d.units < 0n
                          ? -d.units
                          : d.units,
                    scale: d.scale,
                  },
                  budget,
                ),
              ),
            );
          }
          return out(
            fn === "negate"
              ? -(a.value as number)
              : Math.abs(a.value as number),
          );
        }
        if (fn === "round") {
          const scale = b!.value as number;
          if (scale < 0 || scale > 18)
            dataFail("expression_round_scale_invalid");
          if (a.type === "decimal") {
            const text = decimalText(decimal(a.value), budget, scale, true);
            // ROUND(DIVIDE(a, b), 2): when every value the exact operand
            // can have (within the bound of the roundings before) rounds to
            // the same result, nothing was lost that the formula did not
            // ask to lose (#645). Near a halfway point they may not.
            const bound = budget.decimalErrors.get(a);
            if (
              bound &&
              budget.decimalRoundings - roundings === bound.roundings
            ) {
              const x = decimal(a.value);
              const at40 = x.units * power(BOUND_SCALE - x.scale);
              const step = power(BOUND_SCALE - scale);
              if (
                halfEven(at40 - bound.error, step).units ===
                halfEven(at40 + bound.error, step).units
              ) {
                budget.decimalRoundings = roundings;
                if (!warned) budget.warnings.delete("decimal_rounded");
              }
            }
            return out(text);
          }
          return out(
            Math.round((a.value as number) * 10 ** scale) / 10 ** scale,
          );
        }
        if (fn === "concat") return out(cells.map((c) => c.value).join(""));
        if (fn === "lower") return out((a.value as string).toLowerCase());
        if (fn === "upper") return out((a.value as string).toUpperCase());
        if (fn === "trim") return out((a.value as string).trim());
        if (fn === "contains")
          return out((a.value as string).includes(b!.value as string));
        if (fn === "starts_with")
          return out((a.value as string).startsWith(b!.value as string));
        if (fn === "length") return out([...(a.value as string)].length);
        if (fn === "year") return out(Number((a.value as string).slice(0, 4)));
        if (fn === "month") return out(Number((a.value as string).slice(5, 7)));
        if (fn === "json_get") {
          const key = b!.value as string;
          if (["__proto__", "constructor", "prototype"].includes(key))
            dataFail("expression_json_path_invalid");
          return out(
            typeof a.value === "object" &&
              a.value !== null &&
              Object.hasOwn(a.value, key)
              ? (a.value as DataRow)[key]
              : null,
          );
        }
        if (fn === "to_string")
          return out(
            typeof a.value === "object"
              ? JSON.stringify(a.value)
              : String(a.value),
          );
        if (fn === "to_decimal") {
          if (a.type === "number")
            budget.warnings.add("number_converted_to_decimal");
          const text = String(a.value);
          decimal(text);
          return traced ? carry(budget, a, out(text)) : out(text);
        }
        if (fn === "to_number" || fn === "to_integer") {
          if (typeof a.value !== "number" && typeof a.value !== "string")
            dataFail("data_cast_invalid");
          if (
            typeof a.value === "string" &&
            (!a.value.length || !/^[-]?[0-9]+(?:\.[0-9]+)?$/.test(a.value))
          )
            dataFail("data_cast_invalid");
          if (fn === "to_integer" && a.type === "decimal") {
            const d = decimal(a.value);
            if (d.units % power(d.scale) !== 0n) dataFail("data_cast_invalid");
          }
          const number = Number(a.value);
          if (
            !Number.isFinite(number) ||
            (fn === "to_integer" && !Number.isSafeInteger(number))
          )
            dataFail("data_cast_invalid");
          if (a.type === "decimal")
            budget.warnings.add("decimal_converted_to_number");
          return out(number);
        }
        if (fn === "to_boolean") {
          if (a.value === true || a.value === "true" || a.value === 1)
            return out(true);
          if (a.value === false || a.value === "false" || a.value === 0)
            return out(false);
          return dataFail("data_cast_invalid");
        }
        if (fn === "to_json") {
          if (a.type === "json") return out(a.value);
          if (typeof a.value !== "string") dataFail("data_cast_invalid");
          try {
            return out(JSON.parse(a.value));
          } catch {
            return dataFail("data_cast_invalid");
          }
        }
        if (fn === "to_timestamp") {
          if (typeof a.value !== "string") dataFail("data_cast_invalid");
          const at = a.type === "date" ? a.value + "T00:00:00Z" : a.value;
          validateDataValue("timestamp", at, false);
          return out(at);
        }
        if (fn === "to_date") {
          if (typeof a.value !== "string") dataFail("data_cast_invalid");
          const date = a.type === "timestamp" ? a.value.slice(0, 10) : a.value;
          validateDataValue("date", date, false);
          return out(date);
        }
        return dataFail("expression_function_unknown");
      },
    };
  };
  const compiled = compile(expression, 0, options.traceResult);
  return {
    result: compiled.result,
    evaluate: (row, budget = new ProcessingBudget(), from) => {
      const outer = sources;
      sources = from;
      try {
        return compiled.run(row, budget);
      } finally {
        sources = outer;
      }
    },
  };
}
