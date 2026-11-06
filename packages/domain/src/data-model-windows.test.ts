import { describe, expect, it } from "vitest";
import {
  measureRequiredDimensions,
  querySemanticModel,
  validateSemanticModel,
  type ModelMeasure,
  type ModelQuery,
  type SemanticModelDefinition,
} from "./data-model.js";
import {
  addCivilDays,
  measureIsPercentChange,
  measureLookbackDays,
  measurePerDateDimensions,
  modelQueryTimeRange,
  offsetInterval,
  rollingWindowStart,
  shiftCivilMonths,
} from "./data-model-windows.js";
import { semanticModelFieldReferences } from "./data-field-references.js";
import { formatDataFormula, parseDataFormula } from "./data-formula.js";
import type { DataTable } from "./data-preparation.js";
import type { DataExpression, DataRow } from "./data-expression.js";

const NOW = "2026-11-01T00:00:00.000Z";
const field = (fieldId: string): DataExpression => ({ kind: "field", fieldId });
const day = (value: string): DataExpression => ({
  kind: "literal",
  type: "date",
  value,
});
const call = (
  fn: Extract<DataExpression, { kind: "call" }>["fn"],
  ...args: DataExpression[]
): DataExpression => ({ kind: "call", fn, args });
const between = (from: string, to: string) =>
  call(
    "and",
    call("gte", field("date"), day(from)),
    call("lte", field("date"), day(to)),
  );
const appIs = (app: string) =>
  call("eq", field("app"), { kind: "literal", type: "string", value: app });

function dates(from: string, to: string): string[] {
  const result: string[] = [];
  for (let d = from; d <= to; d = addCivilDays(d, 1)) result.push(d);
  return result;
}

// App a reports every day, app b every other day; c and the historical rows
// cover zero, missing-input and leap-year cases.
const recent = dates("2026-09-20", "2026-10-10");
const baseRows: DataRow[] = [
  ...recent.flatMap((date, i) => [
    {
      date,
      app: "a",
      amount: String(i + 1),
      currency: "EUR",
      units: i + 1,
      user: `u${i % 3}`,
    },
    ...(i % 2 === 0
      ? [
          {
            date,
            app: "b",
            amount: "10",
            currency: "EUR",
            units: 10,
            user: "ub",
          },
        ]
      : []),
  ]),
  ...(
    [
      ["2026-10-03", 0],
      ["2026-10-04", 5],
      ["2026-10-05", 2],
      ["2026-10-05", null],
      ["2026-10-06", 4],
    ] as const
  ).map(([date, units]) => ({
    date,
    app: "c",
    amount: "1",
    currency: "EUR",
    units,
    user: "uc",
  })),
  ...(
    [
      ["2023-02-28", 1],
      ["2024-02-28", 2],
      ["2024-02-29", 3],
      ["2024-03-31", 4],
      ["2025-02-28", 5],
      ["2025-03-31", 6],
    ] as const
  ).map(([date, units]) => ({
    date,
    app: "h",
    amount: String(units),
    currency: "EUR",
    units,
    user: "uh",
  })),
].map((row) => ({ at: null, ...row }));

const sales = (rows: DataRow[] = baseRows): DataTable => ({
  fields: [
    { id: "date", name: "Date", type: "date", nullable: false },
    { id: "at", name: "At", type: "timestamp", nullable: true },
    { id: "app", name: "App", type: "string", nullable: false },
    {
      id: "amount",
      name: "Amount",
      type: "decimal",
      nullable: false,
      currencyField: "currency",
    },
    { id: "currency", name: "Currency", type: "string", nullable: false },
    { id: "units", name: "Units", type: "integer", nullable: true },
    { id: "user", name: "User", type: "string", nullable: false },
  ],
  rows,
  provenance: [{ datasetId: "sales", generationId: "sales-1" }],
});
const sources = (rows?: DataRow[]) => new Map([["sales", sales(rows)]]);

const aggregate = (
  id: string,
  op: "sum" | "avg" | "distinct_count",
  fieldId: string,
): ModelMeasure => ({
  id,
  name: id,
  kind: "aggregate",
  datasetId: "sales",
  aggregate: { id, name: id, op, fieldId },
});
const rolling = (
  id: string,
  base: string,
  unit: "day" | "week" | "month",
  length: number,
  timeDimensionId = "date",
): ModelMeasure => ({
  id,
  name: id,
  kind: "rolling",
  baseMeasureId: base,
  timeDimensionId,
  window: { unit, length },
});
const offset = (
  id: string,
  base: string,
  unit: "day" | "week" | "month" | "year" | "range",
  output: "value" | "change" | "percent_change" = "value",
  length = 1,
  timeDimensionId = "date",
): ModelMeasure => ({
  id,
  name: id,
  kind: "period_offset",
  baseMeasureId: base,
  timeDimensionId,
  offset: { unit, length },
  output,
});

const measures: ModelMeasure[] = [
  aggregate("revenue", "sum", "amount"),
  aggregate("units", "sum", "units"),
  aggregate("users", "distinct_count", "user"),
  aggregate("avgUnits", "avg", "units"),
  rolling("rev7", "revenue", "day", 7),
  rolling("units7", "units", "day", 7),
  rolling("users7", "users", "day", 7),
  rolling("avg7", "avgUnits", "day", 7),
  rolling("units1", "units", "day", 1),
  rolling("unitsMonth", "units", "month", 1),
  offset("prevRange", "units", "range"),
  offset("prevMonth", "units", "month"),
  offset("prevYear", "units", "year"),
  offset("changeDay", "units", "day", "change"),
  offset("pctDay", "units", "day", "percent_change"),
  offset("revChangeDay", "revenue", "day", "change"),
];
const model = (extra: ModelMeasure[] = []): SemanticModelDefinition => ({
  version: 1,
  datasets: ["sales"],
  relationships: [],
  dimensions: [
    {
      id: "date",
      name: "Date",
      datasetId: "sales",
      fieldId: "date",
      timeAlignment: "reporting_date",
    },
    {
      id: "shipped",
      name: "Shipped",
      datasetId: "sales",
      fieldId: "date",
      timeAlignment: "reporting_date",
    },
    {
      id: "at",
      name: "At",
      datasetId: "sales",
      fieldId: "at",
      timeAlignment: "instant",
    },
    { id: "app", name: "App", datasetId: "sales", fieldId: "app" },
  ],
  measures: [...measures, ...extra],
});
const run = (
  query: Omit<ModelQuery, "now">,
  options: { rows?: DataRow[]; extra?: ModelMeasure[] } = {},
) =>
  querySemanticModel(model(options.extra), sources(options.rows), {
    now: NOW,
    ...query,
  });
const byDate = (result: ReturnType<typeof run>) =>
  new Map(result.rows.map((row) => [row.dimensions.date as string, row]));

/** Reference: re-aggregate the raw rows of [from, to] directly. */
function rowsBetween(from: string, to: string, app?: string) {
  return baseRows.filter(
    (row) =>
      (row.date as string) >= from &&
      (row.date as string) <= to &&
      (app === undefined || row.app === app),
  );
}
const sumUnits = (from: string, to: string, app?: string) =>
  String(
    rowsBetween(from, to, app).reduce(
      (total, row) => total + ((row.units as number | null) ?? 0),
      0,
    ),
  );

describe("rolling and period-offset measures", () => {
  it("1. loads lookback rows before the range but outputs only the range", () => {
    const result = run({
      measureIds: ["rev7", "units7"],
      groupBy: ["date"],
      filter: between("2026-10-01", "2026-10-31"),
    });
    const rows = byDate(result);
    // 10-01's window is 09-25..10-01, all of it before the range but one day.
    const expected = rowsBetween("2026-09-25", "2026-10-01").reduce(
      (total, row) => total + Number(row.amount),
      0,
    );
    expect(rows.get("2026-10-01")?.measures.rev7).toEqual({
      value: String(expected),
      type: "decimal",
      currency: "EUR",
      status: "ok",
    });
    expect(rows.get("2026-10-01")?.measures.units7!.value).toBe(
      sumUnits("2026-09-25", "2026-10-01"),
    );
    expect([...rows.keys()]).toEqual(dates("2026-10-01", "2026-10-10"));
    expect(result.totalRows).toBe(10);
    expect(result.appliedFilter).toEqual(between("2026-10-01", "2026-10-31"));

    const last = run({
      measureIds: ["units7"],
      groupBy: ["date"],
      filter: between("2026-10-01", "2026-10-31"),
      window: "last",
      limit: 3,
    });
    expect(last.rows.map((row) => row.dimensions.date)).toEqual([
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
    ]);
    expect(last.totalRows).toBe(10);
    expect(last.rows[0]?.measures.units7!.value).toBe(
      sumUnits("2026-10-02", "2026-10-08"),
    );
  });

  it("2. treats gt/lt as exclusive edges, length 1 as the base, and rejects or-filters on the date", () => {
    const exclusive = run({
      measureIds: ["units", "units1"],
      groupBy: ["date"],
      filter: call(
        "and",
        call("gt", field("date"), day("2026-09-30")),
        // Literal on the left: 10-05 > date.
        call("gt", day("2026-10-05"), field("date")),
      ),
    });
    expect(exclusive.rows.map((row) => row.dimensions.date)).toEqual(
      dates("2026-10-01", "2026-10-04"),
    );
    for (const row of exclusive.rows) {
      expect(row.measures.units1).toEqual(row.measures.units);
      expect(row.measures.units1!.value).toBe(
        sumUnits(row.dimensions.date as string, row.dimensions.date as string),
      );
    }
    for (const filter of [
      call(
        "or",
        call("eq", field("date"), day("2026-10-01")),
        call("eq", field("date"), day("2026-10-02")),
      ),
      call("not", call("lt", field("date"), day("2026-10-01"))),
      call("is_null", field("date")),
      call("in", field("date"), {
        kind: "literal",
        type: "json",
        value: ["2026-10-01", "2026-10-02"],
      }),
    ])
      expect(() =>
        run({ measureIds: ["units7"], groupBy: ["date"], filter }),
      ).toThrow("model_window_time_filter_unsupported");
    // Single-value `in` (a dashboard values filter) is a closed range.
    expect(
      run({
        measureIds: ["units7"],
        groupBy: ["date"],
        filter: call("in", field("date"), {
          kind: "literal",
          type: "json",
          value: ["2026-10-03"],
        }),
      }).rows.map((row) => row.dimensions.date),
    ).toEqual(["2026-10-03"]);
  });

  it("3. re-aggregates raw rows instead of combining daily results", () => {
    const result = byDate(
      run({
        measureIds: ["avg7", "users7", "avgUnits", "users"],
        groupBy: ["date"],
        filter: call("and", between("2026-09-20", "2026-10-10"), appIs("a")),
      }),
    );
    const both = run({
      measureIds: ["avg7", "users7", "avgUnits", "users"],
      groupBy: ["date"],
      filter: call(
        "and",
        between("2026-10-01", "2026-10-31"),
        call("in", field("app"), {
          kind: "literal",
          type: "json",
          value: ["a", "b"],
        }),
      ),
    });
    const at = byDate(both).get("2026-10-07")!;
    const raw = dates("2026-10-01", "2026-10-07").flatMap((date) =>
      rowsBetween(date, date).filter(
        (row) => row.app === "a" || row.app === "b",
      ),
    );
    const rawAvg =
      raw.reduce((total, row) => total + (row.units as number), 0) / raw.length;
    expect(Number(at.measures.avg7!.value)).toBeCloseTo(rawAvg, 12);
    const dailyAvgs = dates("2026-10-01", "2026-10-07").map((date) =>
      Number(byDate(both).get(date)!.measures.avgUnits!.value),
    );
    const avgOfAvgs =
      dailyAvgs.reduce((total, value) => total + value, 0) / dailyAvgs.length;
    expect(
      Math.abs(Number(at.measures.avg7!.value) - avgOfAvgs),
    ).toBeGreaterThan(0.1);
    // u0, u1, u2 and ub: 4 distinct users, not the sum of daily counts.
    expect(at.measures.users7!.value).toBe(4);
    const dailyUsers = dates("2026-10-01", "2026-10-07").reduce(
      (total, date) =>
        total + (byDate(both).get(date)!.measures.users!.value as number),
      0,
    );
    expect(dailyUsers).toBeGreaterThan(4);
    // App a alone: one row per day, so the rolling avg is the mean of 7 rows.
    expect(Number(result.get("2026-10-07")!.measures.avg7!.value)).toBeCloseTo(
      (12 + 13 + 14 + 15 + 16 + 17 + 18) / 7,
      12,
    );
  });

  it("4. caps month and year offsets at month ends", () => {
    expect(shiftCivilMonths("2024-03-31", -1)).toBe("2024-02-29");
    expect(shiftCivilMonths("2025-03-31", -1)).toBe("2025-02-28");
    expect(shiftCivilMonths("2024-02-29", -12)).toBe("2023-02-28");
    // Several dates can map to the same capped date.
    expect(shiftCivilMonths("2025-03-29", -1)).toBe("2025-02-28");
    expect(rollingWindowStart("2024-03-31", { unit: "month", length: 1 })).toBe(
      "2024-03-01",
    );
    expect(rollingWindowStart("2026-10-07", { unit: "week", length: 1 })).toBe(
      "2026-10-01",
    );
    expect(
      offsetInterval(
        "2026-10-01",
        "2026-10-31",
        { unit: "month", length: 1 },
        31,
      ),
    ).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(
      offsetInterval(
        "2025-02-28",
        "2025-02-28",
        { unit: "month", length: 1 },
        1,
      ),
    ).toEqual({ from: "2025-01-28", to: "2025-01-28" });

    const cases = [
      ["2024-03-31", "prevMonth", "2024-02-29", "3"],
      ["2025-03-31", "prevMonth", "2025-02-28", "5"],
      ["2024-02-29", "prevYear", "2023-02-28", "1"],
    ] as const;
    for (const [date, measure, compared, value] of cases) {
      const row = run({
        measureIds: [measure],
        groupBy: ["date"],
        filter: call("eq", field("date"), day(date)),
      }).rows[0]!;
      expect(row.measures[measure]).toEqual({
        value,
        type: "decimal",
        status: "ok",
        comparedTo: { from: compared, to: compared },
      });
    }
    const month = run({
      measureIds: ["unitsMonth"],
      groupBy: ["date"],
      filter: call("eq", field("date"), day("2024-03-31")),
    });
    // 02-29 lies outside the window 03-01..03-31.
    expect(month.rows[0]?.measures.unitsMonth!.value).toBe("4");
  });

  it("5. compares ungrouped ranges with the previous range and month", () => {
    const result = run({
      measureIds: ["units", "prevRange", "prevMonth"],
      groupBy: [],
      filter: between("2026-10-01", "2026-10-31"),
    });
    expect(result.rows).toHaveLength(1);
    const cells = result.rows[0]!.measures;
    expect(cells.units!.value).toBe(sumUnits("2026-10-01", "2026-10-31"));
    expect(cells.prevRange).toMatchObject({
      value: sumUnits("2026-08-31", "2026-09-30"),
      comparedTo: { from: "2026-08-31", to: "2026-09-30" },
    });
    expect(cells.prevMonth).toMatchObject({
      value: sumUnits("2026-09-01", "2026-09-30"),
      comparedTo: { from: "2026-09-01", to: "2026-09-30" },
    });
    expect(cells.units).not.toHaveProperty("comparedTo");
  });

  it("6. propagates null, zero and partial previous values into change outputs", () => {
    const result = run({
      measureIds: ["units", "changeDay", "pctDay"],
      groupBy: ["date", "app"],
      filter: call("and", between("2026-10-03", "2026-10-06"), appIs("c")),
    });
    const at = (date: string) =>
      result.rows.find((row) => row.dimensions.date === date)!.measures;
    // 10-02 has no row for c: no previous value.
    expect(at("2026-10-03").changeDay).toMatchObject({
      value: null,
      status: "missing",
    });
    expect(at("2026-10-04").changeDay).toMatchObject({
      value: "5",
      type: "decimal",
      status: "ok",
    });
    // Previous is zero: no percentage, with a warning.
    expect(at("2026-10-04").pctDay).toMatchObject({
      value: null,
      type: "decimal",
      status: "missing",
    });
    expect(result.warnings).toContain("division_by_zero");
    expect(at("2026-10-05").pctDay).toMatchObject({
      value: "-0.6",
      status: "partial",
    });
    // Previous (10-05) has a missing input: partial.
    expect(at("2026-10-06").changeDay).toMatchObject({
      value: "2",
      status: "partial",
    });
    expect(at("2026-10-06").pctDay).toMatchObject({
      value: "1",
      status: "partial",
      comparedTo: { from: "2026-10-05", to: "2026-10-05" },
    });
    expect(at("2026-10-06").pctDay).not.toHaveProperty("currency");
  });

  it("7. never mixes currencies", () => {
    const rows = [
      ...baseRows,
      {
        at: null,
        date: "2026-10-08",
        app: "d",
        amount: "5",
        currency: "USD",
        units: 1,
        user: "ud",
      },
      {
        at: null,
        date: "2026-10-09",
        app: "d",
        amount: "3",
        currency: "EUR",
        units: 1,
        user: "ud",
      },
    ];
    const query = {
      groupBy: ["date", "app"],
      filter: call("and", between("2026-10-01", "2026-10-31"), appIs("d")),
    };
    expect(() => run({ ...query, measureIds: ["rev7"] }, { rows })).toThrow(
      "aggregate_currency_mixed",
    );
    expect(() =>
      run({ ...query, measureIds: ["revChangeDay"] }, { rows }),
    ).toThrow("model_window_currency_mismatch");
    // Same currency: the change keeps the base currency.
    expect(
      run(
        {
          measureIds: ["revChangeDay"],
          groupBy: ["date"],
          filter: call("and", between("2026-10-02", "2026-10-02"), appIs("a")),
        },
        { rows },
      ).rows[0]?.measures.revChangeDay,
    ).toEqual({
      value: "1",
      type: "decimal",
      currency: "EUR",
      status: "ok",
      comparedTo: { from: "2026-10-01", to: "2026-10-01" },
    });
  });

  it("8. validates windowed definitions and queries", () => {
    const grouped = {
      groupBy: ["date"],
      filter: between("2026-10-01", "2026-10-31"),
    };
    const fails = (extra: ModelMeasure[], code: string, query = grouped) => {
      expect(() =>
        run({ ...query, measureIds: [extra[0]!.id] }, { extra }),
      ).toThrow(code);
      expect(() =>
        validateSemanticModel(
          { ...model(extra), measures: [...measures, ...extra] },
          sources(),
          NOW,
        ),
      ).toThrow(code);
    };
    for (const [unit, length] of [
      ["day", 0],
      ["day", 367],
      ["week", 54],
      ["month", 13],
      ["day", 1.5],
    ] as const)
      fails(
        [rolling("bad", "units", unit, length)],
        "model_window_length_invalid",
      );
    fails(
      [offset("bad", "units", "year", "value", 2)],
      "model_window_length_invalid",
    );
    fails(
      [offset("bad", "units", "range", "value", 2)],
      "model_window_length_invalid",
    );
    fails(
      [
        {
          ...offset("bad", "units", "day"),
          output: "ratio",
        } as unknown as ModelMeasure,
      ],
      "model_window_output_invalid",
    );
    fails(
      [
        rolling("bad7", "bad", "day", 7),
        {
          id: "bad",
          name: "bad",
          kind: "formula",
          expression: call("add", field("units"), field("units")),
        },
      ],
      "model_window_base_aggregate_required",
    );
    fails(
      [rolling("bad", "rev7", "day", 7)],
      "model_window_base_aggregate_required",
    );
    fails(
      [rolling("bad", "units", "day", 7, "app")],
      "model_window_date_dimension_required",
    );
    fails(
      [rolling("bad", "units", "day", 7, "at")],
      "model_window_date_dimension_required",
    );
    fails(
      [rolling("bad", "units", "day", 7, "missing")],
      "model_dimension_not_found",
    );
    fails([offset("bad", "missing", "day")], "model_measure_not_found");
    // Cycle through baseMeasureId.
    fails(
      [offset("loopA", "loopB", "day"), offset("loopB", "loopA", "day")],
      "model_measure_cycle",
    );
    // Nested offsets add up: 365 + 366 + 366 > 800 days.
    fails(
      [
        offset("bad", "yearAgo", "year"),
        offset("yearAgo", "rolling366", "year"),
        rolling("rolling366", "units", "day", 366),
      ],
      "model_window_lookback_limit",
    );
    expect(
      measureLookbackDays(
        model([
          offset("yearAgo", "rolling366", "year"),
          rolling("rolling366", "units", "day", 366),
        ]),
        ["yearAgo", "units7", "units"],
      ),
    ).toEqual(new Map([["date", 365 + 366]]));
    const conflict = [
      {
        id: "bad",
        name: "bad",
        kind: "formula",
        expression: call("add", field("units7"), field("shipped7")),
      } as ModelMeasure,
      rolling("shipped7", "units", "day", 7, "shipped"),
    ];
    fails(conflict, "model_window_time_dimension_conflict");

    // Query-level checks.
    expect(() =>
      run({
        measureIds: ["units7"],
        groupBy: [],
        filter: between("2026-10-01", "2026-10-31"),
      }),
    ).toThrow("model_window_time_grouping_required");
    expect(() =>
      run({
        measureIds: ["changeDay"],
        groupBy: ["app"],
        filter: between("2026-10-01", "2026-10-31"),
      }),
    ).toThrow("model_window_time_grouping_required");
    expect(() =>
      run({
        measureIds: ["prevMonth"],
        groupBy: [],
        filter: call("gte", field("date"), day("2026-10-01")),
      }),
    ).toThrow("model_window_time_range_required");
    expect(() => run({ measureIds: ["prevRange"], groupBy: ["date"] })).toThrow(
      "model_window_time_range_required",
    );
    // Grouped rolling over an open range is fine.
    expect(
      run({ measureIds: ["units7"], groupBy: ["date"] }).totalRows,
    ).toBeGreaterThan(20);
    // A query-dependent range lookback is bounded too.
    expect(() =>
      run({
        measureIds: ["prevRange"],
        groupBy: [],
        filter: between("2024-01-01", "2026-10-31"),
      }),
    ).toThrow("model_window_lookback_limit");
    expect(() => validateSemanticModel(model(), sources(), NOW)).not.toThrow();
  });

  it("9. marks windows reaching before retained history partial", () => {
    const result = run({
      measureIds: ["units", "units7", "changeDay"],
      groupBy: ["date"],
      filter: call("eq", field("date"), day("2023-02-28")),
    });
    expect(result.rows[0]?.measures.units).toMatchObject({
      value: "1",
      status: "ok",
    });
    expect(result.rows[0]?.measures.units7).toMatchObject({
      value: "1",
      status: "partial",
    });
    // The previous day has no rows and precedes the history: partial, not missing.
    expect(result.rows[0]?.measures.changeDay).toMatchObject({
      value: null,
      status: "partial",
    });
    expect(result.warnings).toContain("model_window_history_incomplete");
    // A gap inside retained history is simply missing.
    const gap = run({
      measureIds: ["changeDay"],
      groupBy: ["date"],
      filter: call("eq", field("date"), day("2026-09-20")),
    });
    expect(gap.rows[0]?.measures.changeDay!.status).toBe("missing");
    expect(gap.warnings).not.toContain("model_window_history_incomplete");
  });

  it("reads retained history per dataset, whatever the grouping or filter", () => {
    // App c's first row is 2026-10-03, years after the dataset's first. A
    // later first row is not missing history: rows record activity, not
    // coverage, so the window is complete however the query slices it.
    const status = (query: Omit<ModelQuery, "now">) => {
      const result = run(query);
      return {
        cells: result.rows.map((row) => [
          row.measures.units7!.value,
          row.measures.units7!.status,
        ]),
        warned: result.warnings.includes("model_window_history_incomplete"),
      };
    };
    const expected = {
      cells: [[sumUnits("2026-09-27", "2026-10-03", "c"), "ok"]],
      warned: false,
    };
    const onDate = call("eq", field("date"), day("2026-10-03"));
    expect(
      status({
        measureIds: ["units7"],
        groupBy: ["app", "date"],
        filter: call("and", onDate, appIs("c")),
      }),
    ).toEqual(expected);
    expect(
      status({
        measureIds: ["units7"],
        groupBy: ["date"],
        filter: call("and", onDate, appIs("c")),
      }),
    ).toEqual(expected);
  });

  it("outputs only dates with rows, so windows never add rows or pages", () => {
    // App b reports every other day; its empty days get no row, as without
    // the rolling measure, although a 7-day sum is defined there.
    const query = (measureIds: string[]) =>
      run({
        measureIds,
        groupBy: ["date"],
        filter: call("and", between("2026-10-01", "2026-10-06"), appIs("b")),
      });
    const plain = query(["units"]),
      windowed = query(["units", "units7"]);
    expect(windowed.rows.map((row) => row.dimensions.date)).toEqual([
      "2026-10-02",
      "2026-10-04",
      "2026-10-06",
    ]);
    expect(windowed.totalRows).toBe(plain.totalRows);
    expect(windowed.rows.map((row) => row.measures.units)).toEqual(
      plain.rows.map((row) => row.measures.units),
    );
  });

  it("10. picks up late corrections dated before the range", () => {
    const query = {
      measureIds: ["units7"],
      groupBy: ["date"],
      filter: call("and", between("2026-10-01", "2026-10-10"), appIs("a")),
    };
    const before = byDate(run(query));
    const corrected = baseRows.map((row) =>
      row.date === "2026-09-28" && row.app === "a"
        ? { ...row, units: (row.units as number) + 100 }
        : row,
    );
    const after = byDate(run(query, { rows: corrected }));
    for (const date of dates("2026-10-01", "2026-10-10")) {
      const delta =
        Number(after.get(date)!.measures.units7!.value) -
        Number(before.get(date)!.measures.units7!.value);
      expect(delta).toBe(date <= "2026-10-04" ? 100 : 0);
    }
  });

  it("partitions windows by the other grouped dimensions", () => {
    const result = run({
      measureIds: ["units7"],
      groupBy: ["app", "date"],
      filter: between("2026-10-06", "2026-10-07"),
    });
    const at = Object.fromEntries(
      result.rows.map((row) => [
        `${row.dimensions.app} ${row.dimensions.date}`,
        row.measures.units7!.value,
      ]),
    );
    // Apps without a row on a date get no output row for it.
    expect(at).toEqual({
      "a 2026-10-06": sumUnits("2026-09-30", "2026-10-06", "a"),
      "a 2026-10-07": sumUnits("2026-10-01", "2026-10-07", "a"),
      "b 2026-10-06": sumUnits("2026-09-30", "2026-10-06", "b"),
      "c 2026-10-06": sumUnits("2026-09-30", "2026-10-06", "c"),
    });
  });

  it("describes the grain and references of windowed measures", () => {
    expect(measureRequiredDimensions(model(), ["units7"])).toEqual(["date"]);
    expect(measureRequiredDimensions(model(), ["prevMonth"])).toEqual([]);
    expect(measureRequiredDimensions(model(), ["changeDay"])).toEqual(["date"]);
    // Only windows need the date grouped; an ordinary date grain does not.
    const grained = model([
      { ...aggregate("daily", "sum", "units"), requiredDimensions: ["date"] },
      offset("prevYear7", "units7", "year"),
    ]);
    expect(measureRequiredDimensions(grained, ["daily"])).toEqual(["date"]);
    expect(measurePerDateDimensions(grained, ["daily", "prevMonth"])).toEqual(
      [],
    );
    expect(measurePerDateDimensions(grained, ["prevYear7"])).toEqual(["date"]);
    expect(measurePerDateDimensions(grained, ["changeDay", "units"])).toEqual([
      "date",
    ]);
    expect(semanticModelFieldReferences(model()).get("sales")).toEqual(
      new Set(["date", "at", "app", "amount", "units", "user"]),
    );
    expect(() =>
      semanticModelFieldReferences(model([offset("bad", "missing", "day")])),
    ).toThrow("model_measure_not_found");
  });

  it("marks change ratios through value offsets of them", () => {
    const chained = model([
      offset("pctLastYear", "pctDay", "year"),
      offset("pctTwoYears", "pctLastYear", "year"),
      offset("pctChangeDay", "pctDay", "day", "change"),
      offset("loop", "loop", "year"),
    ]);
    const percent = (id: string) => measureIsPercentChange(chained, id);
    expect(percent("pctDay")).toBe(true);
    expect(percent("pctLastYear")).toBe(true);
    expect(percent("pctTwoYears")).toBe(true);
    // The difference of two ratios is in points, not a ratio itself.
    expect(percent("pctChangeDay")).toBe(false);
    for (const id of ["units", "prevYear", "changeDay", "units7", "loop"])
      expect(percent(id)).toBe(false);
    expect(percent("missing")).toBe(false);
  });

  it("splits the time range from the residual filter", () => {
    const residual = appIs("a");
    expect(
      modelQueryTimeRange(
        call(
          "and",
          call("and", call("gte", field("date"), day("2026-10-01")), residual),
          call("lt", field("date"), day("2026-11-01")),
        ),
        "date",
      ),
    ).toEqual({
      range: { from: "2026-10-01", to: "2026-10-31" },
      residual,
    });
    expect(modelQueryTimeRange(undefined, "date")).toEqual({
      range: { from: null, to: null },
    });
    expect(
      modelQueryTimeRange(
        call(
          "and",
          call("gte", field("date"), day("2026-10-01")),
          call("gte", field("date"), day("2026-10-05")),
        ),
        "date",
      ).range,
    ).toEqual({ from: "2026-10-05", to: null });
  });

  it("reads date bounds typed as formula text", () => {
    const fields = [{ id: "date", name: "Day" }];
    const typed = parseDataFormula(
      '[Day] >= TO_DATE("2026-10-01") AND TO_DATE("2026-10-31") >= [Day]',
      fields,
    );
    expect(modelQueryTimeRange(typed, "date")).toEqual({
      range: { from: "2026-10-01", to: "2026-10-31" },
    });
    const formatted = parseDataFormula(
      formatDataFormula(call("lt", field("date"), day("2026-11-01")), fields),
      fields,
    );
    expect(modelQueryTimeRange(formatted, "date").range).toEqual({
      from: null,
      to: "2026-10-31",
    });
    expect(() =>
      modelQueryTimeRange(
        parseDataFormula('[Day] >= TO_DATE("2026-13-01")', fields),
        "date",
      ),
    ).toThrow();
    expect(() =>
      modelQueryTimeRange(
        parseDataFormula("[Day] >= TO_DATE([Day])", fields),
        "date",
      ),
    ).toThrow("model_window_time_filter_unsupported");
  });

  it("keeps queries without windowed measures on the existing path", () => {
    // The date filter may use any form when no windowed measure is requested.
    const result = run({
      measureIds: ["units"],
      groupBy: [],
      filter: call(
        "or",
        call("eq", field("date"), day("2026-10-01")),
        call("eq", field("date"), day("2026-10-02")),
      ),
    });
    expect(result.rows[0]?.measures.units!.value).toBe(
      sumUnits("2026-10-01", "2026-10-02"),
    );
  });
});

describe("windowed measure validation and edge cases", () => {
  const lastApp: ModelMeasure = {
    id: "lastApp",
    name: "lastApp",
    kind: "aggregate",
    datasetId: "sales",
    aggregate: { id: "lastApp", name: "lastApp", op: "max", fieldId: "app" },
  };
  const formula = (id: string, expression: DataExpression): ModelMeasure => ({
    id,
    name: id,
    kind: "formula",
    expression,
  });

  it("type-checks formulas over windowed measures at publish", () => {
    const extra = [
      lastApp,
      formula("bad", call("add", field("rev7"), field("lastApp"))),
    ];
    expect(() =>
      run(
        {
          measureIds: ["bad"],
          groupBy: ["date"],
          filter: between("2026-10-01", "2026-10-31"),
        },
        { extra },
      ),
    ).toThrow("expression_numeric_required");
    expect(() => validateSemanticModel(model(extra), sources(), NOW)).toThrow(
      "expression_numeric_required",
    );
    // A formula over an offset's output, and an offset of a bad formula.
    expect(() =>
      validateSemanticModel(
        model([
          lastApp,
          formula("bad", call("add", field("pctDay"), field("lastApp"))),
        ]),
        sources(),
        NOW,
      ),
    ).toThrow("expression_numeric_required");
    expect(() =>
      validateSemanticModel(
        model([
          lastApp,
          formula("bad", call("add", field("units"), field("lastApp"))),
          offset("prevBad", "bad", "range"),
        ]),
        sources(),
        NOW,
      ),
    ).toThrow("expression_numeric_required");
    // Valid formulas over windowed measures still publish.
    expect(() =>
      validateSemanticModel(
        model([
          formula("ratio", call("divide", field("units7"), field("users7"))),
          formula("pctPlus", call("add", field("pctDay"), field("pctDay"))),
        ]),
        sources(),
        NOW,
      ),
    ).not.toThrow();
  });

  it("refuses change outputs over non-numeric bases at publish", () => {
    for (const output of ["change", "percent_change"] as const)
      expect(() =>
        validateSemanticModel(
          model([lastApp, offset("bad", "lastApp", "range", output)]),
          sources(),
          NOW,
        ),
      ).toThrow("model_window_output_invalid");
    // The value of an earlier period is fine for any base type.
    expect(() =>
      validateSemanticModel(
        model([lastApp, offset("prevApp", "lastApp", "range")]),
        sources(),
        NOW,
      ),
    ).not.toThrow();
  });

  it("keeps the undated group for measures without a window", () => {
    const rows = [
      ...baseRows,
      { ...baseRows[0]!, date: null, units: 7, app: "z" },
      { ...baseRows[0]!, date: null, units: 3, app: "z" },
    ];
    const table = sales(rows);
    const undated = new Map([
      [
        "sales",
        {
          ...table,
          fields: table.fields.map((f) =>
            f.id === "date" ? { ...f, nullable: true } : f,
          ),
        },
      ],
    ]);
    const extra = [
      formula("double", call("add", field("units"), field("units"))),
      formula("withRolling", call("add", field("units"), field("units7"))),
    ];
    const query = (measureIds: string[]) =>
      querySemanticModel(model(extra), undated, {
        now: NOW,
        measureIds,
        groupBy: ["date"],
      });
    const plain = query(["units", "double"]),
      mixed = query(["units", "double", "units7", "withRolling"]);
    expect(mixed.totalRows).toBe(plain.totalRows);
    expect(mixed.rows.map((row) => row.dimensions)).toEqual(
      plain.rows.map((row) => row.dimensions),
    );
    for (const [index, row] of mixed.rows.entries()) {
      expect(row.measures.units).toEqual(plain.rows[index]!.measures.units);
      expect(row.measures.double).toEqual(plain.rows[index]!.measures.double);
    }
    const last = mixed.rows.at(-1)!;
    expect(last.dimensions.date).toBeNull();
    expect(last.measures.units).toMatchObject({ value: "10", status: "ok" });
    expect(last.measures.units7).toMatchObject({
      value: null,
      type: "decimal",
      status: "missing",
    });
    expect(last.measures.withRolling).toMatchObject({
      value: null,
      status: "missing",
    });
    // A date bound excludes undated rows for every measure alike.
    expect(
      querySemanticModel(model(extra), undated, {
        now: NOW,
        measureIds: ["units", "units7"],
        groupBy: ["date"],
        filter: call("gte", field("date"), day("2026-10-01")),
      }).rows.some((row) => row.dimensions.date === null),
    ).toBe(false);
  });

  it("returns no rows for a reversed date range", () => {
    const reversed = between("2026-10-31", "2026-10-01");
    for (const query of [
      { measureIds: ["prevRange", "units"], groupBy: [] },
      { measureIds: ["prevMonth"], groupBy: [] },
      { measureIds: ["units7", "prevRange"], groupBy: ["date"] },
      { measureIds: ["units7"], groupBy: ["date", "app"] },
    ]) {
      const result = run({ ...query, filter: reversed });
      expect(result.rows).toEqual([]);
      expect(result.totalRows).toBe(0);
    }
  });

  it("does not warn about rounding a percent change", () => {
    // 10-01 → 10-02 for app a: 1/12 is not a finite decimal.
    const result = run({
      measureIds: ["pctDay"],
      groupBy: ["date", "app"],
      filter: call("and", between("2026-10-02", "2026-10-02"), appIs("a")),
    });
    expect(result.rows[0]!.measures.pctDay).toMatchObject({
      value: "0.083333333333333333",
      status: "ok",
    });
    expect(result.warnings).not.toContain("decimal_rounded");
  });
});
