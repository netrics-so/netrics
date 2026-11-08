/**
 * A compare widget compiled into a reusable measure (#506, part of #499).
 *
 * The two sides of a compare are two observation datasets. They share one
 * date through a generated, editable preparation built from ordinary 11C
 * steps: each side is scoped by its dimension filters (`filter`), tagged
 * with its role (`calculate`), and both are `append`ed into one dataset.
 * The model aggregates each side filtered by its tag, divides them like
 * `ratioOf`, and compares the ratio with the previous period through a
 * `period_offset` measure, as `compareChange` does. The model engine is
 * unchanged: anything it cannot express exactly is refused with a typed
 * error instead of approximated.
 */
import {
  compareRatioUnit,
  compareUnitsProblem,
  type CompareFormat,
} from "./compare.js";
import {
  CURRENCY_DIMENSION,
  amountCurrency,
  isPerCurrencyUnit,
} from "./currency.js";
import type { DataExpression } from "./data-expression.js";
import type { ModelMeasure, SemanticModelDefinition } from "./data-model.js";
import type { PreparationGraph, PreparationNode } from "./data-preparation.js";
import { DEFAULT_LOCALE, type Locale } from "./i18n/locale.js";
import { sharedTranslator } from "./i18n/shared/index.js";
import {
  resolvePeriod,
  type Aggregation,
  type DateRange,
  type Granularity,
  type MetricKind,
  type Period,
} from "./metrics.js";

/** The longest name a model, measure or preparation field may have. */
const MAX_NAME_LENGTH = 100;

/** Why a compare widget cannot be saved as a measure. */
export const COMPARE_MEASURE_REFUSALS = [
  /** min, max and last are formed over day totals, which a model cannot. */
  "compare_aggregation_unsupported",
  /** A per-currency amount that only a display currency or the largest
   *  currency would fix; the author can pin one source currency. */
  "compare_currency_unpinned",
  /** Only daily metrics: hourly and instant ones (also hourly today). */
  "compare_granularity_unsupported",
  /** A side's metric or observation dataset is not available. */
  "compare_source_unavailable",
  /** A dimension filter the side's dataset does not have. */
  "compare_dimension_unknown",
  /** The units cannot form this ratio (ADR 0019 section 10). */
  "compare_units_incompatible",
] as const;
export type CompareMeasureRefusal = (typeof COMPARE_MEASURE_REFUSALS)[number];

/** The stable ids of what the compiler generates. */
export const COMPARE_MEASURE_IDS = {
  numerator: "numerator",
  denominator: "denominator",
  ratio: "ratio",
  /** The ratio over the previous period. */
  previous: "ratio_previous",
  /** Relative change (`ratio`) or percentage points (`percent`). */
  change: "ratio_change",
} as const;
/** The preparation's output and the model's date dimension. */
export const COMPARE_PREPARATION_OUTPUT = "compare";
export const COMPARE_DATE_DIMENSION = "date";
/** The tag column the preparation adds to each side's rows. */
export const COMPARE_SIDE_FIELD = "compare_side";

type Side = "numerator" | "denominator";
const SIDES: readonly Side[] = ["numerator", "denominator"];

/**
 * The offset that reproduces a period's previous window over the period's
 * own dates, or null when none does exactly (#506; checked day by day in
 * compare-measure.test.ts):
 * - today and the last 7, 30 and 90 days: the dates just before, as long
 *   as the range (`range`). `day 1` gives the same for today, but day and
 *   week offsets are only defined per date, so `range` keeps every period
 *   one ungrouped query.
 * - this week: `week 1` is only defined per date; `range` shifts by the
 *   days so far, not by a week.
 * - this month: `month 1` compares a whole previous month on the last day
 *   of a shorter month (30 April → 1–31 March), the widget the same days
 *   (1–30 March).
 * - this year and the last 12 months: `year 1` does the same on 28
 *   February after a leap year (→ 29 February).
 * - this quarter: its days so far and the calendar offset differ.
 *
 * The compiled model's `ratio_previous` and `ratio_change` therefore always
 * use `range`: the same number of days just before the queried range, so
 * the model does not depend on a period. A compare widget bound to the
 * model (#507) does not read them; it queries `ratio` over its period's
 * current and previous windows (`compareMeasureWindows`), which is exact
 * for every period.
 */
export function compareMeasureOffset(
  period: Period,
): typeof COMPARE_MEASURE_OFFSET | null {
  switch (period) {
    case "today":
    case "last_7_days":
    case "last_30_days":
    case "last_90_days":
      return COMPARE_MEASURE_OFFSET;
    default:
      return null;
  }
}

/** The offset of `ratio_previous` and `ratio_change`. */
const COMPARE_MEASURE_OFFSET = { unit: "range", length: 1 } as const;

/**
 * A compare widget's binding to the measures a compare was compiled into
 * (#507): the published model, its date dimension, and the measures the
 * widget reads instead of its own two metric queries. The widget keeps its
 * period, format and layout.
 */
export interface CompareMeasureBinding {
  modelId: string;
  /** The date dimension the period's windows are closed ranges on. */
  dateDimensionId: string;
  measureIds: { numerator: string; denominator: string; ratio: string };
}

/**
 * The closed date ranges a bound compare widget queries: its period's
 * current window and the previous one, exactly the dates the widget's
 * metric queries read for a daily metric (`resolvePeriod`).
 */
export function compareMeasureWindows(
  period: Period,
  now: Date,
  timeZone: string,
): { current: DateRange; previous: DateRange } {
  const window = resolvePeriod(period, now, timeZone);
  return { current: window.dates, previous: window.previousDates };
}

/** `from <= date <= to` on the binding's date dimension. */
export function compareMeasureFilter(
  dateDimensionId: string,
  range: DateRange,
): DataExpression {
  const bound = (fn: "gte" | "lte", value: string): DataExpression =>
    call(fn, field(dateDimensionId), { kind: "literal", type: "date", value });
  return call("and", bound("gte", range.from), bound("lte", range.to));
}

/** One side of a compare as its observation dataset describes it. */
export interface CompareMeasureSide {
  /** `observation:<connectionId>:<metricDefinitionId>`. */
  datasetId: string;
  /** The metric's name; the side's measure is named after it. */
  name: string;
  kind: MetricKind;
  granularity: Granularity;
  unit: string;
  aggregation: Aggregation;
  /** The side's dimension filters by dimension key ("resource"). */
  dimensions: Readonly<Record<string, string>>;
  /** The dataset's field for each of the metric's dimension keys. */
  dimensionFields: Readonly<Record<string, string>>;
  /** The value field's currency field, for amounts per currency. */
  currencyFieldId: string | null;
}

export interface CompareMeasureInput {
  /** The ratio's name ("Conversion"). */
  name: string;
  period: Period;
  format: CompareFormat;
  numerator: CompareMeasureSide;
  denominator: CompareMeasureSide;
  /** One source currency for per-currency sides without a filter. */
  currency: string | null;
  /**
   * The author's language for the generated field, dimension and measure
   * names (#515); English when absent. They are stored, so authors can
   * rename them later.
   */
  locale?: Locale;
}

export type CompareMeasureCompilation =
  | {
      ok: true;
      /** Scopes, tags and appends both sides; its output is `compare`. */
      preparation: PreparationGraph;
      /** The draft model over the published preparation's output. */
      model: (preparedDatasetId: string) => SemanticModelDefinition;
    }
  | { ok: false; error: CompareMeasureRefusal };

const field = (fieldId: string): DataExpression => ({ kind: "field", fieldId });
const text = (value: string): DataExpression => ({
  kind: "literal",
  type: "string",
  value,
});
const call = (
  fn: Extract<DataExpression, { kind: "call" }>["fn"],
  ...args: DataExpression[]
): DataExpression => ({ kind: "call", fn, args });

function allOf(parts: DataExpression[]): DataExpression {
  return parts.reduce((all, part) => call("and", all, part));
}

/**
 * The preparation and model of a compare widget, or why it cannot be
 * one. A side's number is the widget's: `sum` adds the side's values over
 * the dates (a daily metric has one value per series and date, so the
 * widget's per-day combination is a sum for every kind); `avg` divides
 * that by the dates with a value, as the widget averages day totals.
 */
export function compileCompareMeasure(
  input: CompareMeasureInput,
): CompareMeasureCompilation {
  const fail = (error: CompareMeasureRefusal) =>
    ({ ok: false, error }) as const;
  const sides = { numerator: input.numerator, denominator: input.denominator };
  const t = sharedTranslator(input.locale ?? DEFAULT_LOCALE);
  // A generated name ("… · previous period") within the 100 characters a
  // name may have: the author's part is shortened, never the suffix, which
  // is longer in some languages (#515).
  type Suffixed =
    | "compareMeasure.days"
    | "compareMeasure.previous"
    | "compareMeasure.change"
    | "compareMeasure.changePoints";
  const suffixed = (key: Suffixed, name: string) =>
    t(key, {
      name: name.slice(0, MAX_NAME_LENGTH - t(key, { name: "" }).length),
    });
  if (SIDES.some((side) => sides[side].granularity !== "day"))
    return fail("compare_granularity_unsupported");
  const offset = COMPARE_MEASURE_OFFSET;
  if (
    SIDES.some(
      (side) =>
        sides[side].aggregation !== "sum" && sides[side].aggregation !== "avg",
    )
  )
    return fail("compare_aggregation_unsupported");
  // A per-currency amount without a currency filter is converted into a
  // display currency, or read in its largest currency: neither is a model
  // measure. A pinned currency stands in for the filter.
  const filters = {} as Record<Side, Record<string, string>>;
  for (const side of SIDES) {
    const { unit, dimensions } = sides[side];
    if (isPerCurrencyUnit(unit) && dimensions[CURRENCY_DIMENSION] === undefined)
      if (input.currency === null) return fail("compare_currency_unpinned");
      else
        filters[side] = { ...dimensions, [CURRENCY_DIMENSION]: input.currency };
    else filters[side] = { ...dimensions };
    if (
      Object.keys(filters[side]).some(
        (key) => !Object.hasOwn(sides[side].dimensionFields, key),
      )
    )
      return fail("compare_dimension_unknown");
  }
  if (
    compareUnitsProblem({
      numerator: { unit: input.numerator.unit, dimensions: filters.numerator },
      denominator: {
        unit: input.denominator.unit,
        dimensions: filters.denominator,
      },
      displayCurrency: null,
      format: input.format,
    }) !== null
  )
    return fail("compare_units_incompatible");

  const nodes: PreparationNode[] = [];
  const columnMappings: Record<string, Record<string, string>> = {};
  for (const side of SIDES) {
    const source = sides[side];
    nodes.push({
      id: `${side}_source`,
      type: "source",
      datasetId: source.datasetId,
    });
    let last = `${side}_source`;
    const scope = Object.entries(filters[side])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) =>
        call("eq", field(source.dimensionFields[key]!), text(value)),
      );
    if (scope.length) {
      nodes.push({
        id: `${side}_scope`,
        type: "filter",
        input: last,
        expression: allOf(scope),
      });
      last = `${side}_scope`;
    }
    nodes.push({
      id: `${side}_tag`,
      type: "calculate",
      input: last,
      fieldId: COMPARE_SIDE_FIELD,
      name: t("compareMeasure.side"),
      expression: text(side),
    });
    columnMappings[`${side}_tag`] = {
      time: COMPARE_DATE_DIMENSION,
      [COMPARE_SIDE_FIELD]: COMPARE_SIDE_FIELD,
      value: `${side}_value`,
      ...(source.currencyFieldId
        ? { [source.currencyFieldId]: `${side}_currency` }
        : {}),
    };
  }
  nodes.push({
    id: COMPARE_PREPARATION_OUTPUT,
    type: "append",
    inputs: SIDES.map((side) => `${side}_tag`),
    columnMappings,
  });
  const preparation: PreparationGraph = {
    version: 1,
    nodes,
    outputs: [COMPARE_PREPARATION_OUTPUT],
  };

  // The ratio has the widget's unit (`compareRatioUnit` over the queried
  // units, "EUR_minor" for an amount in euros): an amount per unit keeps
  // the numerator's unit and currency, anything else is unitless. Operands
  // that must not carry a unit are cast to plain values, decimals when
  // either side is an amount per currency (integers summed as decimals),
  // numbers otherwise.
  const queriedUnit = (side: Side) => {
    const currency = amountCurrency(
      sides[side].unit,
      filters[side][CURRENCY_DIMENSION],
    );
    return currency === null ? sides[side].unit : `${currency}_minor`;
  };
  const amountPerUnit =
    compareRatioUnit(queriedUnit("numerator"), queriedUnit("denominator")) !==
    null;
  const decimals = SIDES.some((side) => sides[side].currencyFieldId !== null);
  const operand = (side: Side) =>
    amountPerUnit && side === "numerator"
      ? field(COMPARE_MEASURE_IDS[side])
      : call(
          decimals ? "to_decimal" : "to_number",
          field(COMPARE_MEASURE_IDS[side]),
        );
  const model = (datasetId: string): SemanticModelDefinition => {
    const measures: ModelMeasure[] = [];
    for (const side of SIDES) {
      const id = COMPARE_MEASURE_IDS[side];
      const tagged = call("eq", field(COMPARE_SIDE_FIELD), text(side));
      const sum = (measureId: string): ModelMeasure => ({
        id: measureId,
        name: sides[side].name.slice(0, 100),
        kind: "aggregate",
        datasetId,
        aggregate: {
          id: measureId,
          name: sides[side].name.slice(0, 100),
          op: "sum",
          fieldId: `${side}_value`,
          filter: tagged,
        },
      });
      if (sides[side].aggregation === "sum") {
        measures.push(sum(id));
        continue;
      }
      measures.push(sum(`${id}_total`), {
        id: `${id}_days`,
        name: suffixed("compareMeasure.days", sides[side].name.slice(0, 90)),
        kind: "aggregate",
        datasetId,
        aggregate: {
          id: `${id}_days`,
          name: suffixed("compareMeasure.days", sides[side].name.slice(0, 90)),
          op: "distinct_count",
          fieldId: COMPARE_DATE_DIMENSION,
          filter: tagged,
        },
      });
      measures.push({
        id,
        name: sides[side].name.slice(0, 100),
        kind: "formula",
        expression: call("divide", field(`${id}_total`), field(`${id}_days`)),
      });
    }
    const name = input.name.slice(0, 80);
    measures.push(
      {
        id: COMPARE_MEASURE_IDS.ratio,
        name,
        kind: "formula",
        expression: call(
          "divide",
          operand("numerator"),
          operand("denominator"),
        ),
      },
      {
        id: COMPARE_MEASURE_IDS.previous,
        name: suffixed("compareMeasure.previous", name),
        kind: "period_offset",
        baseMeasureId: COMPARE_MEASURE_IDS.ratio,
        timeDimensionId: COMPARE_DATE_DIMENSION,
        offset,
        output: "value",
      },
      input.format === "ratio"
        ? {
            id: COMPARE_MEASURE_IDS.change,
            name: suffixed("compareMeasure.change", name),
            kind: "period_offset",
            baseMeasureId: COMPARE_MEASURE_IDS.ratio,
            timeDimensionId: COMPARE_DATE_DIMENSION,
            offset,
            output: "percent_change",
          }
        : {
            id: COMPARE_MEASURE_IDS.change,
            name: suffixed("compareMeasure.changePoints", name),
            kind: "formula",
            expression: call(
              "multiply",
              call(
                "subtract",
                field(COMPARE_MEASURE_IDS.ratio),
                field(COMPARE_MEASURE_IDS.previous),
              ),
              { kind: "literal", type: "integer", value: 100 },
            ),
          },
    );
    return {
      version: 1,
      datasets: [datasetId],
      relationships: [],
      dimensions: [
        {
          id: COMPARE_DATE_DIMENSION,
          name: t("compareMeasure.date"),
          datasetId,
          fieldId: COMPARE_DATE_DIMENSION,
          timeAlignment: "reporting_date",
        },
      ],
      measures,
    };
  };
  return { ok: true, preparation, model };
}
