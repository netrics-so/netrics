/**
 * Rolling-window and period-offset measures (ADR 0022 §4, #486).
 *
 * Windows are recomputed from the base aggregate's rows, never by combining
 * already aggregated daily results. Anchors are civil dates of a
 * `reporting_date` dimension; no timezone is ever applied.
 */
import {
  dataFail,
  exactDecimal,
  ProcessingBudget,
  PROCESSING_LIMITS,
  validateDataValue,
  type DataCell,
  type DataExpression,
} from "./data-expression.js";
import type { ModelMeasure, SemanticModelDefinition } from "./data-model.js";

export type ModelWindowUnit = "day" | "week" | "month";
export type ModelOffsetUnit = "day" | "week" | "month" | "year" | "range";
/** Length bounds per unit, and the total lookback a query may need. */
export const MODEL_WINDOW_LIMITS = {
  day: 366,
  week: 53,
  month: 12,
  year: 1,
  range: 1,
  lookbackDays: 800,
} as const;
/** Inclusive civil dates; null is unbounded. */
export interface ModelDateInterval {
  from: string | null;
  to: string | null;
}

/** Measure IDs (formula scope) or dimension IDs (filter scope) of an AST. */
export function expressionReferences(expression: DataExpression): Set<string> {
  const result = new Set<string>(),
    stack: Array<[DataExpression, number]> = [[expression, 0]];
  let nodes = 0;
  while (stack.length) {
    const [item, depth] = stack.pop()!;
    if (++nodes > PROCESSING_LIMITS.nodes || depth > PROCESSING_LIMITS.depth)
      dataFail("expression_complexity_limit");
    if (item.kind === "field") result.add(item.fieldId);
    else if (item.kind === "call") {
      if (item.args.length > 20) dataFail("expression_arity_invalid");
      for (const arg of item.args) stack.push([arg, depth + 1]);
    } else if (item.kind !== "literal") dataFail("expression_invalid");
  }
  return result;
}

/** Measures a measure reads directly. */
export function measureDependencies(measure: ModelMeasure): string[] {
  switch (measure.kind) {
    case "aggregate":
      return [];
    case "formula":
      return [...expressionReferences(measure.expression)];
    case "rolling":
    case "period_offset":
      return [measure.baseMeasureId];
  }
}

export type WindowedMeasure = Extract<
  ModelMeasure,
  { kind: "rolling" | "period_offset" }
>;

export function isWindowedMeasure(
  measure: ModelMeasure,
): measure is WindowedMeasure {
  return measure.kind === "rolling" || measure.kind === "period_offset";
}

/** Structural checks that do not need the model's data. */
export function validateWindowDefinition(measure: WindowedMeasure): void {
  if (
    typeof measure.baseMeasureId !== "string" ||
    typeof measure.timeDimensionId !== "string"
  )
    dataFail("model_measure_not_found", measure.id);
  const { unit, length } =
    measure.kind === "rolling" ? measure.window : measure.offset;
  const units: readonly string[] =
    measure.kind === "rolling"
      ? ["day", "week", "month"]
      : ["day", "week", "month", "year", "range"];
  if (
    !units.includes(unit) ||
    !Number.isInteger(length) ||
    length < 1 ||
    length > MODEL_WINDOW_LIMITS[unit as ModelOffsetUnit]
  )
    dataFail("model_window_length_invalid", measure.id);
  if (
    measure.kind === "period_offset" &&
    !["value", "change", "percent_change"].includes(measure.output)
  )
    dataFail("model_window_output_invalid", measure.id);
}

/** Whether the measure can only be evaluated at a single date. */
export function windowNeedsTimeGrouping(measure: WindowedMeasure): boolean {
  return (
    measure.kind === "rolling" ||
    measure.offset.unit === "day" ||
    measure.offset.unit === "week"
  );
}

// Civil-date arithmetic on YYYY-MM-DD strings (UTC calendar, no timezone).
const DAY_MS = 86_400_000;
function civilParts(date: string): [number, number, number] {
  const [year, month, day] = date.split("-").map(Number);
  return [year!, month!, day!];
}
function civilUtc(date: string): number {
  const [year, month, day] = civilParts(date);
  return Date.UTC(year, month - 1, day);
}
function civilIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
export function addCivilDays(date: string, days: number): string {
  return civilIso(civilUtc(date) + days * DAY_MS);
}
/** Inclusive day count of [from, to]. */
export function civilDaysInclusive(from: string, to: string): number {
  return Math.round((civilUtc(to) - civilUtc(from)) / DAY_MS) + 1;
}
/**
 * The same day `months` months later (negative: earlier), capped at the end
 * of the target month: 2024-03-31 −1 → 2024-02-29, 2024-02-29 −12 →
 * 2023-02-28. Several dates can map to the same capped date.
 */
export function shiftCivilMonths(date: string, months: number): string {
  const [year, month, day] = civilParts(date);
  const first = new Date(Date.UTC(year, month - 1 + months, 1));
  const y = first.getUTCFullYear(),
    m = first.getUTCMonth() + 1;
  return civilIso(Date.UTC(y, m - 1, Math.min(day, daysInMonth(y, m))));
}
function isMonthEnd(date: string): boolean {
  const [year, month, day] = civilParts(date);
  return day === daysInMonth(year, month);
}
function monthEnd(date: string): string {
  const [year, month] = civilParts(date);
  return civilIso(Date.UTC(year, month, 0));
}

/** First date of the rolling window that ends on `date` (inclusive). */
export function rollingWindowStart(
  date: string,
  window: { unit: ModelWindowUnit; length: number },
): string {
  switch (window.unit) {
    case "day":
      return addCivilDays(date, -(window.length - 1));
    case "week":
      return addCivilDays(date, -(7 * window.length - 1));
    case "month":
      return addCivilDays(shiftCivilMonths(date, -window.length), 1);
  }
}

/**
 * The compared interval. A single date maps to a single date. For a longer
 * interval whose end is a month end, month and year offsets end on the
 * shifted month's end (Oct 1–31 −1 month → Sep 1–30). `range` shifts by the
 * length of the query's closed range.
 */
export function offsetInterval(
  from: string,
  to: string,
  offset: { unit: ModelOffsetUnit; length: number },
  rangeDays: number,
): { from: string; to: string } {
  switch (offset.unit) {
    case "day":
    case "week":
    case "range": {
      const days =
        offset.length *
        (offset.unit === "day" ? 1 : offset.unit === "week" ? 7 : rangeDays);
      return { from: addCivilDays(from, -days), to: addCivilDays(to, -days) };
    }
    case "month":
    case "year": {
      const months = offset.length * (offset.unit === "year" ? 12 : 1);
      const shiftedTo = shiftCivilMonths(to, -months);
      return {
        from: shiftCivilMonths(from, -months),
        to: from !== to && isMonthEnd(to) ? monthEnd(shiftedTo) : shiftedTo,
      };
    }
  }
}

/** Upper bound of the days a window or offset reaches before its anchor. */
function ownLookback(measure: WindowedMeasure, rangeDays: number): number {
  if (measure.kind === "rolling") {
    const { unit, length } = measure.window;
    return unit === "day"
      ? length - 1
      : unit === "week"
        ? 7 * length - 1
        : 31 * length;
  }
  const { unit, length } = measure.offset;
  return (
    length *
    (unit === "day"
      ? 1
      : unit === "week"
        ? 7
        : unit === "month"
          ? 31
          : unit === "year"
            ? 366
            : rangeDays)
  );
}

/**
 * Days of history before the requested range that the measures need, per
 * time dimension (nested offsets add up). Rows dated in
 * [from − lookback, to] are enough to evaluate them; a future SQL pushdown
 * must widen its time predicate by exactly this. `range` offsets depend on
 * the query: pass the closed range's length in days (omitted, they count 0,
 * which is only the model-level part of the bound).
 */
export function measureLookbackDays(
  model: SemanticModelDefinition,
  ids: string[],
  rangeDays = 0,
): Map<string, number> {
  const measures = new Map(model.measures.map((m) => [m.id, m]));
  const done = new Map<string, { dimension?: string; days: number }>(),
    visiting = new Set<string>();
  const merge = (
    a: { dimension?: string; days: number },
    b: { dimension?: string; days: number },
  ) => {
    if (a.dimension && b.dimension && a.dimension !== b.dimension)
      dataFail("model_window_time_dimension_conflict");
    return {
      ...((a.dimension ?? b.dimension)
        ? { dimension: a.dimension ?? b.dimension }
        : {}),
      days: Math.max(a.days, b.days),
    };
  };
  const result = new Map<string, number>();
  const visit = (id: string): { dimension?: string; days: number } => {
    const cached = done.get(id);
    if (cached) return cached;
    if (visiting.has(id)) dataFail("model_measure_cycle");
    const measure = measures.get(id);
    if (!measure) dataFail("model_measure_not_found", id);
    visiting.add(id);
    let value: { dimension?: string; days: number } = { days: 0 };
    if (isWindowedMeasure(measure)) validateWindowDefinition(measure);
    for (const dependency of measureDependencies(measure))
      value = merge(value, visit(dependency));
    if (isWindowedMeasure(measure)) {
      value = merge(value, { dimension: measure.timeDimensionId, days: 0 });
      value = {
        ...value,
        days: value.days + ownLookback(measure, rangeDays),
      };
      if (value.days > MODEL_WINDOW_LIMITS.lookbackDays)
        dataFail("model_window_lookback_limit", id);
    }
    visiting.delete(id);
    done.set(id, value);
    if (value.dimension)
      result.set(
        value.dimension,
        Math.max(result.get(value.dimension) ?? 0, value.days),
      );
    return value;
  };
  ids.forEach(visit);
  return result;
}

type Bound = { lower?: string; upper?: string };
const FLIPPED = { gte: "lte", gt: "lt", lte: "gte", lt: "gt", eq: "eq" };

function timeBound(
  expression: DataExpression,
  dimensionId: string,
): Bound | undefined {
  if (expression.kind !== "call" || expression.args.length !== 2) return;
  const [a, b] = expression.args;
  const isTime = (e?: DataExpression) =>
    e?.kind === "field" && e.fieldId === dimensionId;
  if (expression.fn === "in") {
    if (
      !isTime(a) ||
      b?.kind !== "literal" ||
      b.type !== "json" ||
      !Array.isArray(b.value) ||
      b.value.length !== 1 ||
      typeof b.value[0] !== "string"
    )
      return;
    validateDataValue("date", b.value[0], false);
    return { lower: b.value[0], upper: b.value[0] };
  }
  if (!["gte", "gt", "lte", "lt", "eq"].includes(expression.fn)) return;
  let fn = expression.fn as keyof typeof FLIPPED,
    literal: DataExpression | undefined;
  if (isTime(a)) literal = b;
  else if (isTime(b)) {
    literal = a;
    fn = FLIPPED[fn] as keyof typeof FLIPPED;
  }
  if (
    literal?.kind !== "literal" ||
    literal.type !== "date" ||
    typeof literal.value !== "string"
  )
    return;
  const value = literal.value;
  validateDataValue("date", value, false);
  switch (fn) {
    case "eq":
      return { lower: value, upper: value };
    case "gte":
      return { lower: value };
    case "gt":
      return { lower: addCivilDays(value, 1) };
    case "lte":
      return { upper: value };
    case "lt":
      return { upper: addCivilDays(value, -1) };
  }
}

/** A result's value without its status or comparison. */
export function windowCell(result: DataCell): DataCell {
  return {
    value: result.value,
    type: result.type,
    ...(result.unit ? { unit: result.unit } : {}),
    ...(result.currency ? { currency: result.currency } : {}),
    ...(result.scalar ? { scalar: result.scalar } : {}),
  };
}

/**
 * current − previous in the base's type, unit and currency, or
 * (current − previous) / |previous| as a unitless ratio (decimal; number for
 * a number base). Null when either side is null or previous is zero.
 */
export function windowChange(
  measureId: string,
  output: "change" | "percent_change",
  current: DataCell,
  previous: DataCell,
  budget = new ProcessingBudget(),
): DataCell {
  const type = current.type;
  if (
    !["integer", "number", "decimal"].includes(type) ||
    previous.type !== type
  )
    dataFail("model_window_output_invalid", measureId);
  if (
    current.currency &&
    previous.currency &&
    current.currency !== previous.currency
  )
    dataFail("model_window_currency_mismatch", measureId);
  const a = current.value,
    b = previous.value;
  if (output === "change") {
    const unit = current.unit ?? previous.unit,
      currency = current.currency ?? previous.currency;
    let value: unknown = null;
    if (a !== null && b !== null)
      value =
        type === "decimal"
          ? exactDecimal("subtract", String(a), String(b), budget)
          : (a as number) - (b as number);
    validateDataValue(type, value, true);
    return {
      value,
      type,
      ...(unit ? { unit } : {}),
      ...(currency ? { currency } : {}),
    };
  }
  const resultType = type === "number" ? "number" : "decimal";
  let value: unknown = null;
  if (a !== null && b !== null) {
    if (type === "number") {
      if (b === 0) budget.warnings.add("division_by_zero");
      else value = ((a as number) - (b as number)) / Math.abs(b as number);
    } else {
      const delta = exactDecimal("subtract", String(a), String(b), budget)!;
      value = exactDecimal(
        "divide",
        delta,
        String(b).replace(/^-/, ""),
        budget,
      );
    }
  }
  validateDataValue(resultType, value, true);
  return { value, type: resultType };
}

function combineAnd(parts: DataExpression[]): DataExpression {
  if (parts.length === 1) return parts[0]!;
  const middle = Math.ceil(parts.length / 2);
  return {
    kind: "call",
    fn: "and",
    args: [combineAnd(parts.slice(0, middle)), combineAnd(parts.slice(middle))],
  };
}

/**
 * Split a query filter into the closed or open date range on the time
 * dimension and the residual predicate. Only top-level AND conjuncts may
 * reference the time dimension, as gte/gt/lte/lt/eq or single-value `in`
 * against date literals; gt/lt become inclusive bounds ±1 day.
 */
export function modelQueryTimeRange(
  filter: DataExpression | undefined,
  dimensionId: string,
): { range: ModelDateInterval; residual?: DataExpression } {
  let from: string | null = null,
    to: string | null = null;
  const residual: DataExpression[] = [];
  if (filter) {
    // Bounded by expressionReferences' node and depth limits.
    expressionReferences(filter);
    const stack: DataExpression[] = [filter];
    while (stack.length) {
      const item = stack.pop()!;
      if (item.kind === "call" && item.fn === "and") {
        for (let i = item.args.length - 1; i >= 0; i--)
          stack.push(item.args[i]!);
        continue;
      }
      if (!expressionReferences(item).has(dimensionId)) {
        residual.push(item);
        continue;
      }
      const bound = timeBound(item, dimensionId);
      if (!bound) dataFail("model_window_time_filter_unsupported", dimensionId);
      if (bound.lower !== undefined && (from === null || bound.lower > from))
        from = bound.lower;
      if (bound.upper !== undefined && (to === null || bound.upper < to))
        to = bound.upper;
    }
  }
  return {
    range: { from, to },
    ...(residual.length ? { residual: combineAnd(residual) } : {}),
  };
}
