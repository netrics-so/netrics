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
/**
 * A paired screen's fixed scope (#500): per shared dashboard filter, the
 * values or range the screen may show. Conjoined with the filter's saved
 * choice and its dashboard-wide fixed scope, like `fixedValue`; it can only
 * narrow what the screen shows, never widen it.
 */
export type DeviceFilterScope = Readonly<
  Record<string, Exclude<DashboardFilterValue, null>>
>;
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
  /** Declared chart-to-filter interaction: selecting a category, point or
   * row value sets this shared filter (ADR 0022). Viewer-side only; the
   * server evaluates the resulting choice like any other. */
  interaction?: MeasureWidgetInteraction;
}
export interface MeasureWidgetInteraction {
  filterId: string;
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

/**
 * Checks a screen's fixed scope against the dashboard's filters: every
 * entry names a filter, matches its mode and type, and restricts something.
 * An entry that would not restrict (an empty list, an open range) is refused
 * rather than read as "everything".
 */
export function validateDeviceFilterScope(
  filters: readonly DashboardDataFilter[],
  scope: DeviceFilterScope,
): void {
  for (const [filterId, value] of Object.entries(scope)) {
    const filter = filters.find((filter) => filter.id === filterId);
    if (!filter) dataFail("device_scope_filter_unknown", filterId);
    let restricts: DataExpression | undefined;
    try {
      restricts = predicate(filter, filter.id, value);
    } catch {
      dataFail("device_scope_value_invalid", filterId);
    }
    if (!restricts) dataFail("device_scope_value_invalid", filterId);
  }
}

/**
 * No filter disappears silently. Unmapped widgets must declare an exclusion.
 * `scope` is a paired screen's fixed scope: like a fixed value it is
 * conjoined with every choice and can never be excluded, and a scope the
 * dashboard's filters no longer support fails instead of being dropped.
 */
export function dashboardModelQuery(
  filters: readonly DashboardDataFilter[],
  values: Readonly<Record<string, DashboardFilterValue>>,
  binding: MeasureWidgetBinding,
  limit = 1000,
  window: ModelQuery["window"] = "first",
  scope: DeviceFilterScope = {},
): Omit<ModelQuery, "now"> {
  const ids = new Set(filters.map((filter) => filter.id));
  if (ids.size !== filters.length) dataFail("dashboard_filter_ids_not_unique");
  if (Object.keys(values).some((id) => !ids.has(id)))
    dataFail("dashboard_filter_unknown");
  validateDeviceFilterScope(filters, scope);
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
    const screen = Object.hasOwn(scope, filter.id)
      ? scope[filter.id]
      : undefined;
    if (exclusions.has(filter.id)) {
      if (filter.fixedValue !== undefined && filter.fixedValue !== null)
        dataFail("dashboard_filter_fixed_scope_required", filter.id);
      if (screen) dataFail("device_scope_not_applicable", filter.id);
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
    if (screen) parts.push(predicate(filter, mapping.dimensionId, screen)!);
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

/**
 * The grouping dimension a declared interaction reads its value from: the
 * dimension the filter maps to for this widget's model. Every unsupported
 * combination fails with its own code instead of a click doing nothing.
 */
export function measureInteractionDimension(
  filters: readonly DashboardDataFilter[],
  binding: MeasureWidgetBinding,
  view: DashboardMeasureView,
): string {
  const filterId = binding.interaction?.filterId;
  if (filterId === undefined) dataFail("dashboard_interaction_missing");
  if (view === "value")
    dataFail("dashboard_interaction_view_unsupported", filterId);
  const filter = filters.find((filter) => filter.id === filterId);
  if (!filter) dataFail("dashboard_interaction_filter_unknown", filterId);
  if (binding.exclusions.some((exclusion) => exclusion.filterId === filterId))
    dataFail("dashboard_interaction_filter_excluded", filterId);
  const mappings = filter.mappings.filter(
    (mapping) => mapping.modelId === binding.modelId,
  );
  if (
    mappings.length !== 1 ||
    !binding.groupBy.includes(mappings[0]!.dimensionId)
  )
    dataFail("dashboard_interaction_dimension_not_grouped", filterId);
  return mappings[0]!.dimensionId;
}

/** The filter choice a click on `value` makes, or null when the value cannot
 * be chosen (a missing value has no range). */
export function measureInteractionValue(
  filter: DashboardDataFilter,
  value: unknown,
): Exclude<DashboardFilterValue, null> | null {
  if (value === undefined) return null;
  if (filter.mode === "values") return { kind: "values", values: [value] };
  return value === null ? null : { kind: "range", from: value, to: value };
}

/** Whether the current choice is what clicking `value` sets, compared by the
 * filter's type as filters are evaluated ("1.0" = "1.00", equal instants at
 * different fractional precision). Missing values only match missing ones. */
export function measureInteractionSelected(
  filter: DashboardDataFilter,
  current: DashboardFilterValue,
  value: unknown,
): boolean {
  if (value === undefined || current === null || current.kind !== filter.mode)
    return false;
  const same = (chosen: unknown) => {
    if (chosen === null || value === null) return chosen === value;
    try {
      return compareDataValues(filter.type, chosen, value) === 0;
    } catch {
      return false;
    }
  };
  return current.kind === "values"
    ? current.values.length === 1 && same(current.values[0])
    : value !== null &&
        current.from !== null &&
        current.to !== null &&
        same(current.from) &&
        same(current.to);
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

/**
 * Fraction digits a value of a measure unit is shown with (#619): an average
 * rating reads as 4.29 rather than every digit of 4.2857…; the stored and
 * exported value stays exact. Units not listed show every digit.
 */
export const MEASURE_UNIT_FRACTION_DIGITS: Readonly<Record<string, number>> = {
  stars: 2,
};

/**
 * A decimal string rounded to at most `digits` fraction digits, half away
 * from zero, trailing zeros dropped; computed on the digits, never through a
 * float. Text that is no plain decimal is returned unchanged.
 */
export function roundDecimalText(raw: string, digits: number): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) return raw;
  const [, sign = "", whole = "0", given = ""] = match;
  const fraction = given.padEnd(digits + 1, "0");
  const scaled =
    BigInt(whole + fraction.slice(0, digits)) +
    (fraction.charCodeAt(digits) >= 53 /* "5" */ ? 1n : 0n);
  const text = scaled.toString().padStart(digits + 1, "0");
  const integer = text.slice(0, text.length - digits);
  const rest = text.slice(text.length - digits).replace(/0+$/, "");
  const result = `${integer}${rest ? `.${rest}` : ""}`;
  return sign && /[1-9]/.test(result) ? `-${result}` : result;
}

/**
 * A date or timestamp value as people read it (#619): a calendar day
 * ("YYYY-MM-DD") in the locale's medium date style, the same day in every
 * time zone; a timestamp adds the time of day in `timeZone` (the viewer's
 * when omitted). Null when the value is no valid date of that type.
 */
export function formatDataDate(
  value: unknown,
  type: string,
  locale: string,
  timeZone?: string,
): string | null {
  if (typeof value !== "string") return null;
  if (type === "date") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    const date = new Date(
      Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
    );
    if (date.toISOString().slice(0, 10) !== value) return null;
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeZone: "UTC",
    }).format(date);
  }
  if (type === "timestamp") {
    const time = Date.parse(value);
    if (!Number.isFinite(time) || !/^\d{4}-\d{2}-\d{2}T/.test(value))
      return null;
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timeZone ? { timeZone } : {}),
    }).format(new Date(time));
  }
  return null;
}
