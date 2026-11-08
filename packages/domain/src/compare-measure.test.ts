import { describe, expect, it } from "vitest";
import { compareChange, ratioOf, type CompareFormat } from "./compare.js";
import {
  COMPARE_MEASURE_IDS,
  COMPARE_DATE_DIMENSION,
  COMPARE_PREPARATION_OUTPUT,
  compareMeasureFilter,
  compareMeasureOffset,
  compareMeasureWindows,
  compileCompareMeasure,
  type CompareMeasureInput,
  type CompareMeasureSide,
} from "./compare-measure.js";
import type { DataExpression } from "./data-expression.js";
import { querySemanticModel } from "./data-model.js";
import {
  civilDaysInclusive,
  offsetInterval,
  windowNeedsTimeGrouping,
} from "./data-model-windows.js";
import { executePreparation, type DataTable } from "./data-preparation.js";
import {
  PERIODS,
  addDays,
  aggregateBuckets,
  resolvePeriod,
  type Aggregation,
  type Period,
} from "./metrics.js";

const RESOURCE = "dimension.resource";
const CURRENCY = "dimension.currency";
const side = (
  overrides: Partial<CompareMeasureSide> = {},
): CompareMeasureSide => ({
  datasetId: "observation:a:downloads",
  name: "Downloads",
  kind: "delta",
  granularity: "day",
  unit: "count",
  aggregation: "sum",
  dimensions: {},
  dimensionFields: { resource: RESOURCE },
  currencyFieldId: null,
  ...overrides,
});
const input = (
  overrides: Partial<CompareMeasureInput> = {},
): CompareMeasureInput => ({
  name: "Conversion",
  period: "last_7_days",
  format: "percent",
  numerator: side(),
  denominator: side({ datasetId: "observation:b:visitors", name: "Visitors" }),
  currency: null,
  ...overrides,
});

/** Every date of 2023–2029: three leap days and every month end. */
function* days(): Generator<string> {
  for (let date = "2023-01-01"; date <= "2029-12-31"; date = addDays(date, 1))
    yield date;
}

describe("compare periods as model offsets (#506)", () => {
  // The widget's previous window for daily metrics is `previousDates`
  // (metrics query, selection by date); a range-filtered measure compares
  // with `offsetInterval` over the period's dates.
  const previousByOffset = (
    period: Period,
    date: string,
    offset: Parameters<typeof offsetInterval>[2],
  ) => {
    const window = resolvePeriod(period, new Date(`${date}T12:00:00Z`), "UTC");
    return {
      expected: window.previousDates,
      actual: offsetInterval(
        window.dates.from,
        window.dates.to,
        offset,
        civilDaysInclusive(window.dates.from, window.dates.to),
      ),
    };
  };

  it("is exact for today and the last 7, 30 and 90 days on every date", () => {
    const supported = PERIODS.filter((p) => compareMeasureOffset(p) !== null);
    expect(supported).toEqual([
      "today",
      "last_7_days",
      "last_30_days",
      "last_90_days",
    ]);
    for (const date of days())
      for (const period of supported) {
        const { expected, actual } = previousByOffset(
          period,
          date,
          compareMeasureOffset(period)!,
        );
        expect(actual, `${period} on ${date}`).toEqual(expected);
      }
  });

  it("gives today's `day 1` the same dates, but only per date", () => {
    for (const date of ["2024-02-29", "2026-03-29", "2026-11-07"]) {
      const { expected, actual } = previousByOffset("today", date, {
        unit: "day",
        length: 1,
      });
      expect(actual).toEqual(expected);
    }
    expect(
      windowNeedsTimeGrouping({
        id: "x",
        name: "x",
        kind: "period_offset",
        baseMeasureId: "y",
        timeDimensionId: "date",
        offset: { unit: "day", length: 1 },
        output: "value",
      }),
    ).toBe(true);
  });

  it("has no exact offset for this week: `week 1` is per date, `range` shifts by the days so far", () => {
    expect(
      windowNeedsTimeGrouping({
        id: "x",
        name: "x",
        kind: "period_offset",
        baseMeasureId: "y",
        timeDimensionId: "date",
        offset: { unit: "week", length: 1 },
        output: "value",
      }),
    ).toBe(true);
    // Wednesday 4 November 2026: Monday to Wednesday against the same days
    // a week before, not the three days before.
    const { expected, actual } = previousByOffset("this_week", "2026-11-04", {
      unit: "range",
      length: 1,
    });
    expect(expected).toEqual({ from: "2026-10-26", to: "2026-10-28" });
    expect(actual).toEqual({ from: "2026-10-30", to: "2026-11-01" });
  });

  it("has no exact offset for this month: `month 1` differs on the last day of a shorter month", () => {
    const mismatches: string[] = [];
    for (const date of days()) {
      const { expected, actual } = previousByOffset("this_month", date, {
        unit: "month",
        length: 1,
      });
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        mismatches.push(date);
    }
    expect(mismatches).toContain("2026-04-30");
    expect(mismatches).toContain("2026-02-28");
    expect(mismatches.length).toBeGreaterThan(30);
    expect(
      previousByOffset("this_month", "2026-04-30", {
        unit: "month",
        length: 1,
      }),
    ).toEqual({
      expected: { from: "2026-03-01", to: "2026-03-30" },
      actual: { from: "2026-03-01", to: "2026-03-31" },
    });
  });

  it.each(["this_year", "last_12_months"] as const)(
    "has no exact offset for %s: `year 1` differs on 28 February after a leap year",
    (period) => {
      const mismatches: string[] = [];
      for (const date of days()) {
        const { expected, actual } = previousByOffset(period, date, {
          unit: "year",
          length: 1,
        });
        if (JSON.stringify(actual) !== JSON.stringify(expected))
          mismatches.push(date);
      }
      expect(mismatches).toEqual(["2025-02-28", "2029-02-28"]);
      expect(
        previousByOffset(period, "2025-02-28", { unit: "year", length: 1 })
          .actual.to,
      ).toBe("2024-02-29");
    },
  );

  it("has no exact offset for this quarter", () => {
    // 1 April – 31 May against 1 January – 2 March (61 days), not a
    // calendar quarter back (to 28 February) nor 61 days back.
    const date = "2026-05-31";
    expect(
      previousByOffset("this_quarter", date, { unit: "month", length: 3 }),
    ).toEqual({
      expected: { from: "2026-01-01", to: "2026-03-02" },
      actual: { from: "2026-01-01", to: "2026-02-28" },
    });
    expect(
      previousByOffset("this_quarter", date, { unit: "range", length: 1 })
        .actual,
    ).toEqual({ from: "2026-01-30", to: "2026-03-31" });
  });
});

describe("compileCompareMeasure refusals (#506)", () => {
  it.each(["min", "max", "last"] as const)(
    "refuses %s over day totals",
    (aggregation) => {
      expect(
        compileCompareMeasure(
          input({ numerator: side({ kind: "gauge", aggregation }) }),
        ),
      ).toEqual({ ok: false, error: "compare_aggregation_unsupported" });
      expect(
        compileCompareMeasure(
          input({ denominator: side({ kind: "gauge", aggregation }) }),
        ),
      ).toEqual({ ok: false, error: "compare_aggregation_unsupported" });
    },
  );

  it("refuses per-currency amounts without a pinned currency", () => {
    const proceeds = side({
      name: "Proceeds",
      unit: "currency_minor",
      dimensionFields: { resource: RESOURCE, currency: CURRENCY },
      currencyFieldId: CURRENCY,
    });
    expect(
      compileCompareMeasure(input({ numerator: proceeds, format: "ratio" })),
    ).toEqual({ ok: false, error: "compare_currency_unpinned" });
    expect(
      compileCompareMeasure(
        input({ numerator: proceeds, format: "ratio", currency: "EUR" }),
      ).ok,
    ).toBe(true);
    expect(
      compileCompareMeasure(
        input({
          numerator: { ...proceeds, dimensions: { currency: "USD" } },
          format: "ratio",
        }),
      ).ok,
    ).toBe(true);
  });

  it.each(["hour", "instant"] as const)(
    "refuses %s granularity, also for today",
    (granularity) => {
      for (const period of ["today", "last_7_days"] as const)
        expect(
          compileCompareMeasure(
            input({ period, denominator: side({ granularity }) }),
          ),
        ).toEqual({ ok: false, error: "compare_granularity_unsupported" });
    },
  );

  it("compiles every period into the same model (#507)", () => {
    // A bound widget queries `ratio` over its own windows, so no period is
    // refused and the model does not depend on one.
    const compiled = PERIODS.map((period) =>
      compileCompareMeasure(input({ period })),
    );
    for (const result of compiled) if (!result.ok) throw new Error("refused");
    const models = compiled.map((result) =>
      JSON.stringify(result.ok && result.model("prepared:p:compare")),
    );
    expect(new Set(models).size).toBe(1);
  });

  it("windows a bound widget by the widget's own dates (#507)", () => {
    // Month starts and ends (with every leap day and 28 February) of
    // 2023–2029: where #506 found offsets and the widget's windows differ.
    const edges = [...days()].filter((date) => {
      const day = Number(date.slice(8));
      return day === 1 || day >= 28;
    });
    for (const date of edges)
      for (const period of PERIODS) {
        const now = new Date(`${date}T12:00:00Z`);
        const window = resolvePeriod(period, now, "Europe/Berlin");
        expect(compareMeasureWindows(period, now, "Europe/Berlin")).toEqual({
          current: window.dates,
          previous: window.previousDates,
        });
      }
    expect(
      compareMeasureFilter("date", { from: "2025-04-01", to: "2025-04-30" }),
    ).toEqual({
      kind: "call",
      fn: "and",
      args: [
        {
          kind: "call",
          fn: "gte",
          args: [
            { kind: "field", fieldId: "date" },
            { kind: "literal", type: "date", value: "2025-04-01" },
          ],
        },
        {
          kind: "call",
          fn: "lte",
          args: [
            { kind: "field", fieldId: "date" },
            { kind: "literal", type: "date", value: "2025-04-30" },
          ],
        },
      ],
    });
  });

  it("refuses a filter on a dimension the dataset does not have", () => {
    expect(
      compileCompareMeasure(
        input({ numerator: side({ dimensions: { territory: "DE" } }) }),
      ),
    ).toEqual({ ok: false, error: "compare_dimension_unknown" });
  });

  it("refuses units that cannot form the ratio", () => {
    const proceeds = side({
      unit: "currency_minor",
      dimensions: { currency: "EUR" },
      dimensionFields: { currency: CURRENCY },
      currencyFieldId: CURRENCY,
    });
    expect(compileCompareMeasure(input({ numerator: proceeds }))).toEqual({
      ok: false,
      error: "compare_units_incompatible",
    });
  });
});

// ---------------------------------------------------------------------------
// The compiled measure against the widget's arithmetic, without a database.

interface Point {
  series: string;
  date: string;
  value: number;
  resource: string;
  currency?: string;
}
const observationTable = (
  points: readonly Point[],
  currency: boolean,
): DataTable => ({
  aggregated: true,
  fields: [
    { id: "series", name: "Series", type: "string", nullable: false },
    { id: "time", name: "Time", type: "date", nullable: false },
    currency
      ? {
          id: "value",
          name: "Value",
          type: "integer",
          nullable: false,
          unit: "currency_minor",
          currencyField: CURRENCY,
        }
      : { id: "value", name: "Value", type: "number", nullable: false },
    { id: RESOURCE, name: "resource", type: "string", nullable: true },
    ...(currency
      ? [
          {
            id: CURRENCY,
            name: "currency",
            type: "string" as const,
            nullable: false,
          },
        ]
      : []),
  ],
  rows: points.map((p) => ({
    series: p.series,
    time: p.date,
    value: p.value,
    [RESOURCE]: p.resource,
    ...(currency ? { [CURRENCY]: p.currency ?? "EUR" } : {}),
  })),
});
/** The widget's side: day totals (`@>` filters), then the aggregation. */
const widgetSide = (
  points: readonly Point[],
  filter: Record<string, string>,
  aggregation: Aggregation,
  dates: { from: string; to: string },
) => {
  const totals = new Map<string, number>();
  for (const p of points)
    if (
      p.date >= dates.from &&
      p.date <= dates.to &&
      Object.entries(filter).every(
        ([k, v]) => (k === "resource" ? p.resource : p.currency) === v,
      )
    )
      totals.set(p.date, (totals.get(p.date) ?? 0) + p.value);
  return aggregateBuckets(
    aggregation,
    [...totals].map(([bucket, value]) => ({ bucket, value })),
  );
};
const between = (from: string, to: string): DataExpression => ({
  kind: "call",
  fn: "and",
  args: [
    {
      kind: "call",
      fn: "gte",
      args: [
        { kind: "field", fieldId: COMPARE_DATE_DIMENSION },
        { kind: "literal", type: "date", value: from },
      ],
    },
    {
      kind: "call",
      fn: "lte",
      args: [
        { kind: "field", fieldId: COMPARE_DATE_DIMENSION },
        { kind: "literal", type: "date", value: to },
      ],
    },
  ],
});

/** Half of a surrogate pair without its other half. */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("compileCompareMeasure names (#515)", () => {
  const names = (overrides: Partial<CompareMeasureInput>) => {
    const compiled = compileCompareMeasure(
      input({
        numerator: side({ kind: "gauge", aggregation: "avg" }),
        ...overrides,
      }),
    );
    if (!compiled.ok) throw new Error(compiled.error);
    const model = compiled.model("prepared:p:compare");
    return {
      side: compiled.preparation.nodes.find(
        (node) => node.id === "numerator_tag",
      ),
      date: model.dimensions.map((dimension) => dimension.name),
      measures: Object.fromEntries(
        model.measures.map((measure) => [measure.id, measure.name]),
      ),
    };
  };

  it("names the generated parts in English without a locale", () => {
    const english = names({});
    expect(english.side).toMatchObject({ name: "Compare side" });
    expect(english.date).toEqual(["Date"]);
    expect(english.measures).toMatchObject({
      numerator_days: "Downloads · days",
      ratio: "Conversion",
      ratio_previous: "Conversion · previous period",
      ratio_change: "Conversion · change (pt)",
    });
    expect(names({ format: "ratio" }).measures.ratio_change).toBe(
      "Conversion · change",
    );
    expect(names({ locale: "en" })).toEqual(english);
  });

  it("names them in German for a German author, keeping the author's own names", () => {
    const german = names({ locale: "de" });
    expect(german.side).toMatchObject({ name: "Vergleichsseite" });
    expect(german.date).toEqual(["Datum"]);
    expect(german.measures).toMatchObject({
      numerator: "Downloads",
      numerator_days: "Downloads · Tage",
      ratio: "Conversion",
      ratio_previous: "Conversion · vorheriger Zeitraum",
      ratio_change: "Conversion · Veränderung (Pp.)",
    });
    expect(names({ locale: "de", format: "ratio" }).measures.ratio_change).toBe(
      "Conversion · Veränderung",
    );
  });

  it.each(["en", "de"] as const)(
    "keeps every generated name within 100 characters for the longest names in %s",
    (locale) => {
      const long = (letter: string) => letter.repeat(100);
      for (const format of ["percent", "ratio"] as const) {
        const result = names({
          locale,
          format,
          name: long("R"),
          numerator: side({
            kind: "gauge",
            aggregation: "avg",
            name: long("N"),
          }),
        });
        const all = [
          result.side?.type === "calculate" ? result.side.name : "",
          ...result.date,
          ...Object.values(result.measures),
        ];
        for (const name of all) expect(name.length).toBeLessThanOrEqual(100);
        // Shortened names keep their suffix, so they stay told apart.
        expect(result.measures.ratio_previous).toMatch(
          locale === "de" ? / · vorheriger Zeitraum$/ : / · previous period$/,
        );
        expect(result.measures.numerator_days).toMatch(
          locale === "de" ? / · Tage$/ : / · days$/,
        );
      }
    },
  );

  it.each(["en", "de"] as const)(
    "never splits a character when it shortens a name in %s",
    (locale) => {
      // An emoji is two UTF-16 units; every cut point lands on its middle
      // for one of these lengths. A lone surrogate is refused by JSONB.
      for (let prefix = 70; prefix <= 100; prefix++) {
        const named = (letter: string) =>
          letter.repeat(prefix) + "🚀".repeat(5);
        const result = names({
          locale,
          name: named("R"),
          numerator: side({
            kind: "gauge",
            aggregation: "avg",
            name: named("N"),
          }),
          denominator: side({
            datasetId: "observation:b:visitors",
            name: named("V"),
          }),
        });
        for (const name of Object.values(result.measures)) {
          expect(name, name).not.toMatch(LONE_SURROGATE);
          expect(name.length).toBeLessThanOrEqual(100);
        }
      }
    },
  );
});

describe("compiled compare measures match the widget (#506)", () => {
  const today = "2026-11-07";
  const series = (
    name: string,
    resource: string,
    value: (day: number) => number | null,
    currency?: string,
  ): Point[] => {
    const points: Point[] = [];
    for (let day = 0; day < 200; day++) {
      const v = value(day);
      if (v !== null)
        points.push({
          series: name,
          date: addDays(today, -day),
          value: v,
          resource,
          ...(currency ? { currency } : {}),
        });
    }
    return points;
  };
  const visits = [
    ...series("a", "app-1", (d) => 100 + ((d * 7) % 23)),
    ...series("b", "app-2", (d) => (d % 5 === 0 ? null : 40 + (d % 9))),
  ];
  const signups = [
    ...series("a", "app-1", (d) => (d % 4 === 0 ? null : 3 + (d % 6))),
    ...series("b", "app-2", (d) => (d % 3 === 0 ? 0 : 1 + (d % 2))),
  ];
  const proceeds = [
    ...series("e", "app-1", (d) => 990 * (1 + (d % 3)), "EUR"),
    ...series("u", "app-1", (d) => 1290 * (1 + (d % 2)), "USD"),
  ];
  const tables = new Map<string, DataTable>([
    ["observation:c:visits", observationTable(visits, false)],
    ["observation:c:signups", observationTable(signups, false)],
    ["observation:c:proceeds", observationTable(proceeds, true)],
  ]);
  const points: Record<string, Point[]> = {
    "observation:c:visits": visits,
    "observation:c:signups": signups,
    "observation:c:proceeds": proceeds,
  };
  const visitSide = (o: Partial<CompareMeasureSide> = {}) =>
    side({ datasetId: "observation:c:visits", name: "Visits", ...o });
  const signupSide = (o: Partial<CompareMeasureSide> = {}) =>
    side({ datasetId: "observation:c:signups", name: "Signups", ...o });
  const proceedsSide = side({
    datasetId: "observation:c:proceeds",
    name: "Proceeds",
    unit: "currency_minor",
    dimensionFields: { resource: RESOURCE, currency: CURRENCY },
    currencyFieldId: CURRENCY,
  });

  const cases: Array<
    [string, CompareMeasureSide, CompareMeasureSide, CompareFormat]
  > = [
    ["sum / sum", signupSide(), visitSide(), "percent"],
    [
      "sum / sum of one resource",
      signupSide({ dimensions: { resource: "app-2" } }),
      visitSide({ dimensions: { resource: "app-2" } }),
      "ratio",
    ],
    [
      "avg / avg",
      signupSide({ aggregation: "avg" }),
      visitSide({ aggregation: "avg" }),
      "ratio",
    ],
    [
      "gauge avg / sum",
      visitSide({ kind: "gauge", aggregation: "avg" }),
      signupSide(),
      "ratio",
    ],
    ["pinned amount / count", proceedsSide, signupSide(), "ratio"],
  ];
  it.each(cases)("%s", (_name, numerator, denominator, format) => {
    for (const period of [
      "today",
      "last_7_days",
      "last_30_days",
      "last_90_days",
    ] as const) {
      const compiled = compileCompareMeasure({
        name: "Ratio",
        period,
        format,
        numerator,
        denominator,
        currency: "EUR",
      });
      if (!compiled.ok) throw new Error(compiled.error);
      const prepared = executePreparation(compiled.preparation, tables).outputs[
        COMPARE_PREPARATION_OUTPUT
      ]!;
      const model = compiled.model("prepared:p:compare");
      const window = resolvePeriod(
        period,
        new Date(`${today}T15:00:00Z`),
        "Europe/Berlin",
      );
      const result = querySemanticModel(
        model,
        new Map([["prepared:p:compare", prepared]]),
        {
          measureIds: Object.values(COMPARE_MEASURE_IDS),
          groupBy: [],
          filter: between(window.dates.from, window.dates.to),
          now: `${today}T15:00:00.000Z`,
        },
      ).rows[0]!.measures;
      const widget = (
        s: CompareMeasureSide,
        dates: { from: string; to: string },
      ) =>
        widgetSide(
          points[s.datasetId]!,
          s.unit === "currency_minor"
            ? { currency: "EUR", ...s.dimensions }
            : s.dimensions,
          s.aggregation,
          dates,
        );
      const a = widget(numerator, window.dates);
      const b = widget(denominator, window.dates);
      const ratio = ratioOf(a, b);
      const previous = ratioOf(
        widget(numerator, window.previousDates),
        widget(denominator, window.previousDates),
      );
      const change = compareChange({
        value: ratio,
        previousValue: previous,
        format,
      });
      const number = (cell: { value: unknown }) =>
        cell.value === null ? null : Number(cell.value);
      const close = (actual: number | null, expected: number | null) => {
        if (expected === null) expect(actual).toBeNull();
        else expect(actual).toBeCloseTo(expected, 9);
      };
      close(number(result[COMPARE_MEASURE_IDS.numerator]!), a);
      close(number(result[COMPARE_MEASURE_IDS.denominator]!), b);
      close(number(result[COMPARE_MEASURE_IDS.ratio]!), ratio);
      close(number(result[COMPARE_MEASURE_IDS.previous]!), previous);
      close(number(result[COMPARE_MEASURE_IDS.change]!), change?.value ?? null);
      expect(result[COMPARE_MEASURE_IDS.previous]!.comparedTo).toEqual(
        window.previousDates,
      );
      // An amount per unit keeps the numerator's currency (compareRatioUnit).
      for (const id of [
        COMPARE_MEASURE_IDS.ratio,
        COMPARE_MEASURE_IDS.previous,
      ])
        if (numerator.unit === "currency_minor")
          expect({
            unit: result[id]!.unit,
            currency: result[id]!.currency,
          }).toEqual({ unit: "currency_minor", currency: "EUR" });
        else expect(result[id]!.currency).toBeUndefined();
    }
  });
});
