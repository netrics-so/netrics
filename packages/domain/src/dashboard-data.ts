import { currencyExponent } from "./currency.js";
import {
  compareDataValues,
  exactDecimal,
  dataFail,
  validateDataValue,
  type DataExpression,
  type DataType,
} from "./data-expression.js";
import type { ModelQuery } from "./data-model.js";

export type DashboardFilterType = Exclude<DataType, "json">;
export type DashboardFilterValue =
  | { kind: "values"; values: unknown[] }
  | { kind: "range"; from: unknown | null; to: unknown | null }
  | null;
export interface DashboardDataFilter {
  id: string;
  name: string;
  type: DashboardFilterType;
  mode: "values" | "range";
  mappings: Array<{ modelId: string; dimensionId: string }>;
  defaultValue: DashboardFilterValue;
  /** Fixed scopes are conjoined with viewer choices, never replaced by them. */
  fixedValue?: DashboardFilterValue;
}
export interface DashboardFilterExclusion {
  filterId: string;
  reason: string;
}
export interface MeasureWidgetBinding {
  modelId: string;
  measureIds: string[];
  groupBy: string[];
  filter?: DataExpression;
  exclusions: DashboardFilterExclusion[];
}
export const DASHBOARD_MEASURE_VIEWS = [
  "value",
  "table",
  "bar",
  "line",
] as const;
export type DashboardMeasureView = (typeof DASHBOARD_MEASURE_VIEWS)[number];

const field = (fieldId: string): DataExpression => ({ kind: "field", fieldId });
const literal = (
  type: DashboardFilterType,
  value: unknown,
): DataExpression => ({
  kind: "literal",
  type,
  value,
});
function combine(
  fn: "and" | "or",
  parts: DataExpression[],
): DataExpression | undefined {
  if (!parts.length) return undefined;
  if (parts.length === 1) return parts[0];
  const middle = Math.ceil(parts.length / 2);
  return {
    kind: "call",
    fn,
    args: [
      combine(fn, parts.slice(0, middle))!,
      combine(fn, parts.slice(middle))!,
    ],
  };
}
function predicate(
  filter: DashboardDataFilter,
  dimensionId: string,
  value: DashboardFilterValue,
): DataExpression | undefined {
  if (value === null) return undefined;
  if (value.kind !== filter.mode)
    dataFail("dashboard_filter_value_invalid", filter.id);
  const comparison = (
    fn: "eq" | "gte" | "lte",
    raw: unknown,
  ): DataExpression => {
    validateDataValue(filter.type, raw, false);
    return {
      kind: "call",
      fn,
      args: [field(dimensionId), literal(filter.type, raw)],
    };
  };
  if (value.kind === "values") {
    if (!value.values.length) return undefined;
    for (const raw of value.values) validateDataValue(filter.type, raw, true);
    const nonnull = value.values.filter((raw) => raw !== null);
    const parts: DataExpression[] = nonnull.length
      ? [
          {
            kind: "call",
            fn: "in",
            args: [
              field(dimensionId),
              { kind: "literal", type: "json", value: nonnull },
            ],
          },
        ]
      : [];
    if (value.values.includes(null))
      parts.push({ kind: "call", fn: "is_null", args: [field(dimensionId)] });
    return combine("or", parts);
  }
  if (filter.type === "boolean")
    dataFail("dashboard_filter_range_invalid", filter.id);
  const parts: DataExpression[] = [];
  if (value.from !== null) parts.push(comparison("gte", value.from));
  if (value.to !== null) parts.push(comparison("lte", value.to));
  if (
    value.from !== null &&
    value.to !== null &&
    compareDataValues(filter.type, value.from, value.to) > 0
  )
    dataFail("dashboard_filter_range_invalid", filter.id);
  return combine("and", parts);
}

/** No filter disappears silently. Unmapped widgets must declare an exclusion. */
export function dashboardModelQuery(
  filters: readonly DashboardDataFilter[],
  values: Readonly<Record<string, DashboardFilterValue>>,
  binding: MeasureWidgetBinding,
  limit = 1000,
  window: ModelQuery["window"] = "first",
): Omit<ModelQuery, "now"> {
  const ids = new Set(filters.map((filter) => filter.id));
  if (ids.size !== filters.length) dataFail("dashboard_filter_ids_not_unique");
  if (Object.keys(values).some((id) => !ids.has(id)))
    dataFail("dashboard_filter_unknown");
  const exclusions = new Set<string>();
  for (const exclusion of binding.exclusions) {
    if (
      !ids.has(exclusion.filterId) ||
      exclusions.has(exclusion.filterId) ||
      !exclusion.reason.trim()
    )
      dataFail("dashboard_filter_exclusion_invalid", exclusion.filterId);
    exclusions.add(exclusion.filterId);
  }
  const parts: DataExpression[] = binding.filter ? [binding.filter] : [];
  for (const filter of filters) {
    const mappings = filter.mappings.filter(
      (mapping) => mapping.modelId === binding.modelId,
    );
    if (mappings.length > 1)
      dataFail("dashboard_filter_mapping_ambiguous", filter.id);
    if (exclusions.has(filter.id)) {
      if (filter.fixedValue !== undefined && filter.fixedValue !== null)
        dataFail("dashboard_filter_fixed_scope_required", filter.id);
      continue;
    }
    const mapping = mappings[0];
    if (!mapping) dataFail("dashboard_filter_not_applicable", filter.id);
    // Validate defaults too, so switching back to reset can never reveal a broken filter.
    predicate(filter, mapping.dimensionId, filter.defaultValue);
    const chosen = Object.hasOwn(values, filter.id)
      ? values[filter.id]!
      : filter.defaultValue;
    const selected = predicate(filter, mapping.dimensionId, chosen);
    if (selected) parts.push(selected);
    if (filter.fixedValue !== undefined) {
      const fixed = predicate(filter, mapping.dimensionId, filter.fixedValue);
      if (fixed) parts.push(fixed);
    }
  }
  const filter = combine("and", parts);
  return {
    measureIds: binding.measureIds,
    groupBy: binding.groupBy,
    limit,
    ...(window === "last" ? { window } : {}),
    ...(filter ? { filter } : {}),
  };
}

/** Time-ordered charts show the most recent `limit` points (still ascending);
 * tables and categorical charts show the first page of the ordered groups. */
export function measureViewWindow(
  view: DashboardMeasureView,
  groupByType: DataType | undefined,
): NonNullable<ModelQuery["window"]> {
  return (view === "line" || view === "bar") &&
    (groupByType === "date" || groupByType === "timestamp")
    ? "last"
    : "first";
}

export function validateMeasureView(
  view: DashboardMeasureView,
  binding: MeasureWidgetBinding,
): void {
  if (
    !binding.measureIds.length ||
    !new Set(binding.measureIds).size ||
    new Set(binding.measureIds).size !== binding.measureIds.length ||
    new Set(binding.groupBy).size !== binding.groupBy.length
  )
    dataFail("dashboard_measure_binding_invalid");
  if (
    view === "value" &&
    (binding.measureIds.length !== 1 || binding.groupBy.length !== 0)
  )
    dataFail("dashboard_measure_value_grain_invalid");
  if (
    (view === "bar" || view === "line") &&
    (binding.measureIds.length !== 1 || binding.groupBy.length !== 1)
  )
    dataFail("dashboard_measure_chart_grain_invalid");
}

/** Exact presentation amount, without ever converting a decimal to a float. */
export function displayMeasureAmount(
  value: unknown,
  unit: string | undefined,
  currency: string | undefined,
): unknown {
  if (
    value === null ||
    value === undefined ||
    unit !== "currency_minor" ||
    !currency
  )
    return value;
  const exponent = currencyExponent(currency);
  return exactDecimal("divide", String(value), String(10 ** exponent));
}
