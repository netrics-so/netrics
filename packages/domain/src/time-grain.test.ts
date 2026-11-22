import { describe, expect, it } from "vitest";
import {
  modelMeasureFixedGrainDimensions,
  modelMeasureScope,
  querySemanticModel,
  type ModelQuery,
  type SemanticModelDefinition,
} from "./data-model.js";
import { type DataTable } from "./data-preparation.js";
import {
  DataProcessingError,
  ProcessingBudget,
  validateDataValue,
  type DataExpression,
} from "./data-expression.js";
import { civilDate } from "./metrics.js";
import { grainStart, timeGrainBucket } from "./time-grain.js";

const items = (taken: Array<string | null>): DataTable => ({
  fields: [
    { id: "id", name: "ID", type: "integer", nullable: false },
    { id: "taken_at", name: "Taken", type: "timestamp", nullable: true },
    { id: "day", name: "Day", type: "date", nullable: true },
    { id: "kind", name: "Kind", type: "string", nullable: false },
  ],
  rows: taken.map((taken_at, id) => ({
    id,
    taken_at,
    day: taken_at?.slice(0, 10) ?? null,
    kind: id % 2 ? "odd" : "even",
  })),
  provenance: [{ datasetId: "items", generationId: "items-1" }],
});
const model: SemanticModelDefinition = {
  version: 1,
  datasets: ["items"],
  relationships: [],
  dimensions: [
    { id: "taken", name: "Taken", datasetId: "items", fieldId: "taken_at" },
    {
      id: "day",
      name: "Day",
      datasetId: "items",
      fieldId: "day",
      timeAlignment: "reporting_date",
    },
    { id: "kind", name: "Kind", datasetId: "items", fieldId: "kind" },
  ],
  measures: [
    {
      id: "count",
      name: "Items",
      kind: "aggregate",
      datasetId: "items",
      aggregate: { id: "count", name: "Items", op: "count" },
    },
    {
      id: "perTime",
      name: "Items at a time",
      kind: "aggregate",
      datasetId: "items",
      requiredDimensions: ["taken"],
      aggregate: { id: "perTime", name: "Items", op: "count" },
    },
    {
      id: "rolling",
      name: "Items, 7 days",
      kind: "rolling",
      baseMeasureId: "count",
      timeDimensionId: "day",
      window: { unit: "day", length: 7 },
    },
  ],
};
const run = (
  taken: Array<string | null>,
  query: Partial<ModelQuery> & Pick<ModelQuery, "groupBy">,
) =>
  querySemanticModel(model, new Map([["items", items(taken)]]), {
    measureIds: ["count"],
    now: "2026-11-22T00:00:00Z",
    ...query,
  });
const groups = (
  result: ReturnType<typeof run>,
  id = "taken",
): Array<[unknown, unknown]> =>
  result.rows.map((row) => [row.dimensions[id], row.measures.count!.value]);
const code = (action: () => unknown) => {
  try {
    action();
  } catch (error) {
    if (error instanceof DataProcessingError) return error.code;
    throw error;
  }
  return null;
};

describe("grouping a timestamp by a time grain (#838)", () => {
  it("groups per second without a grain, as before", () => {
    const result = run(["2026-11-02T08:00:00Z", "2026-11-02T08:00:01Z"], {
      groupBy: ["taken"],
    });
    expect(groups(result)).toEqual([
      ["2026-11-02T08:00:00Z", 1],
      ["2026-11-02T08:00:01Z", 1],
    ]);
  });

  it("returns one group per day, valued by its date", () => {
    const result = run(
      [
        "2026-11-02T08:00:00Z",
        "2026-11-02T08:00:01.250Z",
        "2026-11-02T23:59:59Z",
        "2026-11-03T00:00:00Z",
      ],
      { groupBy: ["taken"], groupByGrain: { taken: "day" } },
    );
    expect(groups(result)).toEqual([
      ["2026-11-02", 3],
      ["2026-11-03", 1],
    ]);
    expect(result.totalRows).toBe(2);
  });

  it("reads days in the query's time zone", () => {
    // 23:30 UTC is already the next day in Berlin and still the previous
    // one in New York.
    const taken = ["2026-11-02T23:30:00Z", "2026-11-03T03:30:00Z"];
    const at = (timeZone: string) =>
      groups(
        run(taken, {
          groupBy: ["taken"],
          groupByGrain: { taken: "day" },
          timeZone,
        }),
      );
    expect(at("UTC")).toEqual([
      ["2026-11-02", 1],
      ["2026-11-03", 1],
    ]);
    expect(at("Europe/Berlin")).toEqual([["2026-11-03", 2]]);
    expect(at("America/New_York")).toEqual([["2026-11-02", 2]]);
  });

  it("keeps a 23-hour and a 25-hour day one day each", () => {
    // Berlin: 29 March 2026 has 23 hours (22:00Z to 21:00Z), 25 October
    // 2026 has 25 (22:00Z to 23:00Z).
    const result = run(
      [
        "2026-03-28T22:59:59Z", // 28 March, 23:59 CET
        "2026-03-28T23:00:00Z", // 29 March, 00:00 CET
        "2026-03-29T00:59:59Z", // 29 March, 01:59 CET
        "2026-03-29T01:00:00Z", // 29 March, 03:00 CEST
        "2026-03-29T21:59:59Z", // 29 March, 23:59 CEST
        "2026-03-29T22:00:00Z", // 30 March, 00:00 CEST
        "2026-10-24T22:00:00Z", // 25 October, 00:00 CEST
        "2026-10-25T00:30:00Z", // 25 October, 02:30 CEST
        "2026-10-25T01:30:00Z", // 25 October, 02:30 CET (the repeated hour)
        "2026-10-25T22:59:59Z", // 25 October, 23:59 CET
        "2026-10-25T23:00:00Z", // 26 October, 00:00 CET
      ],
      {
        groupBy: ["taken"],
        groupByGrain: { taken: "day" },
        timeZone: "Europe/Berlin",
      },
    );
    expect(groups(result)).toEqual([
      ["2026-03-28", 1],
      ["2026-03-29", 4],
      ["2026-03-30", 1],
      ["2026-10-25", 4],
      ["2026-10-26", 1],
    ]);
  });

  it("reads days in a zone whose offset is no whole hour", () => {
    // Kathmandu is UTC+05:45: its day starts at 18:15Z.
    const result = run(
      ["2026-11-02T18:14:59Z", "2026-11-02T18:15:00Z", "2026-11-03T18:14:59Z"],
      {
        groupBy: ["taken"],
        groupByGrain: { taken: "day" },
        timeZone: "Asia/Kathmandu",
      },
    );
    expect(groups(result)).toEqual([
      ["2026-11-02", 1],
      ["2026-11-03", 2],
    ]);
  });

  it("starts weeks on Monday and months on their first day", () => {
    const taken = [
      "2026-10-31T12:00:00Z", // Saturday
      "2026-11-01T12:00:00Z", // Sunday: still the week of 26 October
      "2026-11-02T12:00:00Z", // Monday
      "2026-11-08T23:59:59Z", // Sunday
      "2026-11-09T00:00:00Z", // Monday
    ];
    expect(
      groups(
        run(taken, { groupBy: ["taken"], groupByGrain: { taken: "week" } }),
      ),
    ).toEqual([
      ["2026-10-26", 2],
      ["2026-11-02", 2],
      ["2026-11-09", 1],
    ]);
    expect(
      groups(
        run(taken, { groupBy: ["taken"], groupByGrain: { taken: "month" } }),
      ),
    ).toEqual([
      ["2026-10-01", 1],
      ["2026-11-01", 4],
    ]);
    // A week or month is the zone's too: Sunday 23:30Z is Monday in Berlin.
    expect(
      groups(
        run(["2026-11-01T23:30:00Z", "2026-11-30T23:30:00Z"], {
          groupBy: ["taken"],
          groupByGrain: { taken: "week" },
          timeZone: "Europe/Berlin",
        }),
      ),
    ).toEqual([
      ["2026-11-02", 1],
      ["2026-11-30", 1],
    ]);
    expect(
      groups(
        run(["2026-11-30T23:30:00Z"], {
          groupBy: ["taken"],
          groupByGrain: { taken: "month" },
          timeZone: "Europe/Berlin",
        }),
      ),
    ).toEqual([["2026-12-01", 1]]);
  });

  it("keeps missing times one group, after the dated ones", () => {
    const result = run(
      [null, "2026-11-03T10:00:00Z", null, "2026-11-02T10:00:00Z"],
      { groupBy: ["taken"], groupByGrain: { taken: "day" } },
    );
    expect(groups(result)).toEqual([
      ["2026-11-02", 1],
      ["2026-11-03", 1],
      [null, 2],
    ]);
  });

  it("orders, limits and pages the buckets, not the rows", () => {
    const taken = Array.from({ length: 40 }, (_, index) => {
      const day = String(1 + (index % 10)).padStart(2, "0");
      const second = String(index).padStart(2, "0");
      return `2026-11-${day}T10:00:${second}Z`;
    });
    const first = run(taken, {
      groupBy: ["taken"],
      groupByGrain: { taken: "day" },
      limit: 3,
    });
    expect(first.totalRows).toBe(10);
    expect(groups(first)).toEqual([
      ["2026-11-01", 4],
      ["2026-11-02", 4],
      ["2026-11-03", 4],
    ]);
    // A chart's latest points: the last buckets, still ascending.
    const last = run(taken, {
      groupBy: ["taken"],
      groupByGrain: { taken: "day" },
      limit: 2,
      window: "last",
    });
    expect(groups(last)).toEqual([
      ["2026-11-09", 4],
      ["2026-11-10", 4],
    ]);
    // A table's top N ranks the buckets' values.
    const top = run([...taken, "2026-11-05T12:00:00Z"], {
      groupBy: ["taken"],
      groupByGrain: { taken: "day" },
      limit: 1,
      orderBy: { measureId: "count", direction: "desc" },
    });
    expect(groups(top)).toEqual([["2026-11-05", 5]]);
  });

  it("filters on the dimension's own values, before bucketing", () => {
    const filter: DataExpression = {
      kind: "call",
      fn: "gte",
      args: [
        { kind: "field", fieldId: "taken" },
        { kind: "literal", type: "timestamp", value: "2026-11-02T12:00:00Z" },
      ],
    };
    const result = run(
      [
        "2026-11-02T08:00:00Z",
        "2026-11-02T12:00:00Z",
        "2026-11-02T18:00:00Z",
        "2026-11-03T09:00:00Z",
      ],
      { groupBy: ["taken"], groupByGrain: { taken: "day" }, filter },
    );
    expect(groups(result)).toEqual([
      ["2026-11-02", 2],
      ["2026-11-03", 1],
    ]);
  });

  it("combines a bucket with other dimensions", () => {
    const result = run(
      ["2026-11-02T08:00:00Z", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"],
      { groupBy: ["taken", "kind"], groupByGrain: { taken: "day" } },
    );
    expect(
      result.rows.map((row) => [
        row.dimensions.taken,
        row.dimensions.kind,
        row.measures.count!.value,
      ]),
    ).toEqual([
      ["2026-11-02", "even", 2],
      ["2026-11-02", "odd", 1],
    ]);
  });

  it("groups a date dimension by week and month; its day is itself", () => {
    const taken = [
      "2026-11-01T23:30:00Z",
      "2026-11-02T10:00:00Z",
      "2026-12-01T10:00:00Z",
    ];
    // A reporting date is never shifted by a zone.
    const by = (grain: "day" | "week" | "month") =>
      groups(
        run(taken, {
          groupBy: ["day"],
          groupByGrain: { day: grain },
          timeZone: "Europe/Berlin",
        }),
        "day",
      );
    expect(by("day")).toEqual([
      ["2026-11-01", 1],
      ["2026-11-02", 1],
      ["2026-12-01", 1],
    ]);
    expect(by("week")).toEqual([
      ["2026-10-26", 1],
      ["2026-11-02", 1],
      ["2026-11-30", 1],
    ]);
    expect(by("month")).toEqual([
      ["2026-11-01", 2],
      ["2026-12-01", 1],
    ]);
  });

  it("refuses a grain that names no grouped time dimension", () => {
    const taken = ["2026-11-02T08:00:00Z"];
    expect(
      code(() =>
        run(taken, { groupBy: ["kind"], groupByGrain: { kind: "day" } }),
      ),
    ).toBe("model_group_grain_not_temporal");
    expect(
      code(() =>
        run(taken, { groupBy: ["kind"], groupByGrain: { taken: "day" } }),
      ),
    ).toBe("model_group_grain_not_grouped");
    expect(
      code(() =>
        run(taken, {
          groupBy: ["taken"],
          groupByGrain: { taken: "hour" as "day" },
        }),
      ),
    ).toBe("model_group_grain_invalid");
    expect(
      code(() =>
        run(taken, {
          groupBy: ["taken"],
          groupByGrain: { taken: "day" },
          timeZone: "Mars/Olympus",
        }),
      ),
    ).toBe("model_time_zone_invalid");
  });

  it("does not let a bucket stand for a measure's required dimension", () => {
    const taken = ["2026-11-02T08:00:00Z", "2026-11-02T09:00:00Z"];
    expect(
      run(taken, { groupBy: ["taken"], measureIds: ["perTime"] }).rows,
    ).toHaveLength(2);
    expect(
      code(() =>
        run(taken, {
          groupBy: ["taken"],
          groupByGrain: { taken: "day" },
          measureIds: ["perTime"],
        }),
      ),
    ).toBe("model_measure_scope_required");
  });

  it("lists the dimensions the measures are read per value of", () => {
    expect(modelMeasureFixedGrainDimensions(model, ["count"])).toEqual([]);
    expect(modelMeasureFixedGrainDimensions(model, ["perTime"])).toEqual([
      "taken",
    ]);
    expect(modelMeasureFixedGrainDimensions(model, ["rolling"])).toEqual([
      "day",
    ]);
    expect(
      modelMeasureFixedGrainDimensions(model, ["count", "rolling", "perTime"]),
    ).toEqual(["taken", "day"]);
    // A comparison with the previous month needs no grouping by its date,
    // but is still read per value of it.
    const compared: SemanticModelDefinition = {
      ...model,
      measures: [
        ...model.measures,
        {
          id: "previous",
          name: "Previous month",
          kind: "period_offset",
          baseMeasureId: "count",
          timeDimensionId: "day",
          offset: { unit: "month", length: 1 },
          output: "value",
        },
      ],
    };
    expect(modelMeasureScope(compared, ["previous"])).toEqual([]);
    expect(modelMeasureFixedGrainDimensions(compared, ["previous"])).toEqual([
      "day",
    ]);
  });

  it("refuses a grain on the date a windowed measure is read per", () => {
    const taken = ["2026-11-02T08:00:00Z"];
    const range: DataExpression = {
      kind: "call",
      fn: "and",
      args: [
        {
          kind: "call",
          fn: "gte",
          args: [
            { kind: "field", fieldId: "day" },
            { kind: "literal", type: "date", value: "2026-11-01" },
          ],
        },
        {
          kind: "call",
          fn: "lte",
          args: [
            { kind: "field", fieldId: "day" },
            { kind: "literal", type: "date", value: "2026-11-07" },
          ],
        },
      ],
    };
    expect(
      code(() =>
        run(taken, {
          groupBy: ["day"],
          groupByGrain: { day: "week" },
          measureIds: ["rolling"],
          filter: range,
        }),
      ),
    ).toBe("model_group_grain_window_unsupported");
    // Its own day is no bucket.
    expect(
      run(taken, {
        groupBy: ["day"],
        groupByGrain: { day: "day" },
        measureIds: ["rolling"],
        filter: range,
      }).rows.length,
    ).toBeGreaterThan(0);
  });

  it("groups early years in a zone, and fails an invalid value as data (review of #852)", () => {
    for (const grain of ["day", "week", "month"] as const)
      expect(
        groups(
          run(["0500-11-02T08:00:00Z", "0001-01-01T00:00:00Z", null], {
            groupBy: ["taken"],
            groupByGrain: { taken: grain },
            timeZone: "Europe/Berlin",
          }),
        ),
      ).toEqual([
        ["0001-01-01", 1],
        [grain === "day" ? "0500-11-02" : "0500-11-01", 1],
        [null, 1],
      ]);
    // What a table would never hold: the table's own validation answers.
    for (const value of ["soon", "2026-13-45T99:00:00Z"])
      expect(
        code(() =>
          run([value], {
            groupBy: ["taken"],
            groupByGrain: { taken: "week" },
            timeZone: "Europe/Berlin",
          }),
        ),
      ).toMatch(/^data_/);
  });
});

describe("what bucketing costs (review 3 of #852)", () => {
  // Every row its own day at midnight UTC, so grouping per day forms the
  // groups grouping per instant does: the only difference in operations is
  // the bucketing itself, one per bucketed value.
  const day = (date: string) => `${date}T00:00:00Z`;
  const two: SemanticModelDefinition = {
    ...model,
    dimensions: [
      ...model.dimensions,
      { id: "seen", name: "Seen", datasetId: "items", fieldId: "taken_at" },
    ],
    measures: [
      ...model.measures,
      {
        id: "previous",
        name: "Previous month",
        kind: "period_offset",
        baseMeasureId: "count",
        timeDimensionId: "day",
        offset: { unit: "month", length: 1 },
        output: "value",
      },
    ],
  };
  const operations = (
    taken: string[],
    query: Partial<ModelQuery> & Pick<ModelQuery, "groupBy">,
  ) =>
    querySemanticModel(two, new Map([["items", items(taken)]]), {
      measureIds: ["count"],
      now: "2026-11-22T00:00:00Z",
      ...query,
    }).operations;
  /** Operations the grains add to the same query without them. */
  const added = (
    taken: string[],
    query: Partial<ModelQuery> & Pick<ModelQuery, "groupBy">,
    groupByGrain: NonNullable<ModelQuery["groupByGrain"]>,
  ) => operations(taken, { ...query, groupByGrain }) - operations(taken, query);
  const range = (from: string, to: string): DataExpression => ({
    kind: "call",
    fn: "and",
    args: [
      {
        kind: "call",
        fn: "gte",
        args: [
          { kind: "field", fieldId: "day" },
          { kind: "literal", type: "date", value: from },
        ],
      },
      {
        kind: "call",
        fn: "lte",
        args: [
          { kind: "field", fieldId: "day" },
          { kind: "literal", type: "date", value: to },
        ],
      },
    ],
  });
  const far = Array.from({ length: 300 }, (_, index) =>
    day(new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10)),
  );
  const later = ["2026-11-20", "2026-11-21"].map(day);
  const shown = ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"].map(
    day,
  );

  it("buckets only the rows a filter keeps", () => {
    const filter: DataExpression = {
      kind: "call",
      fn: "gte",
      args: [
        { kind: "field", fieldId: "taken" },
        { kind: "literal", type: "timestamp", value: day("2026-11-10") },
      ],
    };
    expect(
      added(
        [...far, ...shown],
        { groupBy: ["taken"], filter },
        { taken: "day" },
      ),
    ).toBe(shown.length);
  });

  it("buckets once per row for each bucketed dimension", () => {
    expect(
      added(
        [...far, ...shown],
        { groupBy: ["taken", "seen"] },
        { taken: "day", seen: "day" },
      ),
    ).toBe(2 * (far.length + shown.length));
    expect(
      added(
        [...far, ...shown],
        { groupBy: ["taken", "seen"] },
        { seen: "day" },
      ),
    ).toBe(far.length + shown.length);
    // A missing value has no bucket to compute.
    expect(
      querySemanticModel(two, new Map([["items", items([null, null])]]), {
        measureIds: ["count"],
        groupBy: ["taken"],
        groupByGrain: { taken: "day" },
      }).operations,
    ).toBe(
      querySemanticModel(two, new Map([["items", items([null, null])]]), {
        measureIds: ["count"],
        groupBy: ["taken"],
      }).operations,
    );
  });

  it("buckets only the rows inside a rolling window's bounds, once", () => {
    // Shown: 10 to 13 November; the 7-day window also reads 4 to 9.
    const lookback = ["2026-11-04", "2026-11-09"].map(day);
    const query = {
      measureIds: ["rolling"],
      groupBy: ["day", "taken"],
      filter: range("2026-11-10", "2026-11-13"),
    };
    expect(
      added([...far, ...lookback, ...shown, ...later], query, { taken: "day" }),
    ).toBe(lookback.length + shown.length);
    // Rows outside the bounds cost the same with and without a grain.
    expect(
      added([...far, ...lookback, ...shown, ...later], query, { taken: "day" }),
    ).toBe(added([...lookback, ...shown], query, { taken: "day" }));
  });

  it("buckets only the rows a comparison with an earlier period reads", () => {
    // 10 to 13 November against 10 to 13 October.
    const before = ["2026-10-10", "2026-10-13"].map(day);
    const between = ["2026-10-20", "2026-11-01"].map(day);
    const query = {
      measureIds: ["previous"],
      groupBy: ["taken"],
      filter: range("2026-11-10", "2026-11-13"),
    };
    const all = [...far, ...before, ...between, ...shown, ...later];
    const inBounds = before.length + between.length + shown.length;
    expect(added(all, query, { taken: "day" })).toBe(inBounds);
    expect(
      added(
        all,
        { ...query, groupBy: ["taken", "seen"] },
        {
          taken: "day",
          seen: "week",
        },
      ),
    ).toBe(
      added(
        [...before, ...between, ...shown],
        { ...query, groupBy: ["taken", "seen"] },
        {
          taken: "day",
          seen: "week",
        },
      ),
    );
  });
});

describe("a bucketed query costs what the same data in dates costs (review 4 of #852)", () => {
  // The same rows twice: `at` as the instant, and already as its UTC day.
  // Grouping the instants per day must cost what grouping the days costs,
  // plus one operation per kept row for its bucket.
  const DAYS = ["2026-11-02", "2026-11-03", "2026-11-04"];
  const PER_DAY = 200;
  const instants = DAYS.flatMap((date) =>
    Array.from({ length: PER_DAY }, (_, index) => {
      const minute = String(Math.floor(index / 60)).padStart(2, "0");
      const second = String(index % 60).padStart(2, "0");
      return `${date}T10:${minute}:${second}Z`;
    }),
  );
  const tableOf = (
    type: "timestamp" | "date",
    values: readonly string[] = instants,
  ): DataTable => ({
    fields: [
      { id: "at", name: "At", type, nullable: false },
      { id: "label", name: "Label", type: "string", nullable: false },
      { id: "day", name: "Day", type: "date", nullable: false },
      { id: "n", name: "N", type: "integer", nullable: false },
    ],
    rows: values.map((value, index) => ({
      at: type === "date" ? value.slice(0, 10) : value,
      // One name per day, as a label of a date must be.
      label: `Day ${value.slice(8, 10)}`,
      day: value.slice(0, 10),
      n: index % 7,
    })),
    provenance: [{ datasetId: "items", generationId: "items-1" }],
  });
  const modelOf = (labelled: boolean): SemanticModelDefinition => ({
    version: 1,
    datasets: ["items"],
    relationships: [],
    dimensions: [
      {
        id: "at",
        name: "At",
        datasetId: "items",
        fieldId: "at",
        timeAlignment: "reporting_date",
        ...(labelled ? { labelFieldId: "label" } : {}),
      },
      {
        id: "day",
        name: "Day",
        datasetId: "items",
        fieldId: "day",
        timeAlignment: "reporting_date",
      },
    ],
    measures: [
      {
        id: "count",
        name: "Items",
        kind: "aggregate",
        datasetId: "items",
        aggregate: { id: "count", name: "Items", op: "count" },
      },
      {
        id: "sum",
        name: "Sum",
        kind: "aggregate",
        datasetId: "items",
        aggregate: { id: "sum", name: "Sum", op: "sum", fieldId: "n" },
      },
      {
        id: "rolling",
        name: "Items, 2 days",
        kind: "rolling",
        baseMeasureId: "count",
        timeDimensionId: "day",
        window: { unit: "day", length: 2 },
      },
    ],
  });
  type Query = Partial<ModelQuery> & Pick<ModelQuery, "groupBy">;
  const bucketed = (
    query: Query,
    labelled = false,
    budget?: ProcessingBudget,
  ) =>
    querySemanticModel(
      modelOf(labelled),
      new Map([["items", tableOf("timestamp")]]),
      {
        measureIds: ["count"],
        now: "2026-11-22T00:00:00Z",
        groupByGrain: { at: "day" },
        ...query,
      },
      budget,
    );
  const asDates = (query: Query, labelled = false) =>
    querySemanticModel(
      modelOf(labelled),
      new Map([["items", tableOf("date")]]),
      {
        measureIds: ["count"],
        now: "2026-11-22T00:00:00Z",
        ...query,
      },
    );
  const rowsOf = (result: ReturnType<typeof bucketed>) =>
    result.rows.map((row) => ({
      dimensions: row.dimensions,
      measures: Object.fromEntries(
        Object.entries(row.measures).map(([id, cell]) => [id, cell.value]),
      ),
    }));
  /** Same rows; the bucketed query costs `kept` operations more. */
  const same = (query: Query, kept: number, dateQuery: Query = query) => {
    const a = bucketed(query),
      b = asDates(dateQuery);
    expect(rowsOf(a)).toEqual(rowsOf(b));
    expect(a.totalRows).toBe(b.totalRows);
    expect(a.operations - b.operations).toBe(kept);
  };
  const compare = (
    fn: "gte" | "eq",
    type: "timestamp" | "date",
    value: string,
  ): DataExpression => ({
    kind: "call",
    fn,
    args: [
      { kind: "field", fieldId: "at" },
      { kind: "literal", type, value },
    ],
  });
  const all = instants.length;

  it("grouping, ordering and the first rows", () => {
    same({ groupBy: ["at"] }, all);
    same({ groupBy: ["at"], limit: 2 }, all);
    same({ groupBy: ["at", "day"], measureIds: ["count", "sum"] }, all);
  });

  it("a chart's latest buckets and a later page", () => {
    same({ groupBy: ["at"], limit: 2, window: "last" }, all);
    same({ groupBy: ["at"], limit: 1, offset: 2 }, all);
    expect(bucketed({ groupBy: ["at"], limit: 1, offset: 2 }).totalRows).toBe(
      DAYS.length,
    );
  });

  it("a table's top buckets by a measure", () => {
    same(
      {
        groupBy: ["at"],
        measureIds: ["count", "sum"],
        limit: 2,
        orderBy: { measureId: "sum", direction: "desc" },
      },
      all,
    );
  });

  it("a filter on the bucketed dimension", () => {
    // From 3 November on: the instants of two days.
    same(
      {
        groupBy: ["at"],
        filter: compare("gte", "timestamp", "2026-11-03T00:00:00Z"),
      },
      2 * PER_DAY,
      { groupBy: ["at"], filter: compare("gte", "date", "2026-11-03") },
    );
  });

  it("a rolling window over another date", () => {
    const filter: DataExpression = {
      kind: "call",
      fn: "and",
      args: [
        {
          kind: "call",
          fn: "gte",
          args: [
            { kind: "field", fieldId: "day" },
            { kind: "literal", type: "date", value: "2026-11-03" },
          ],
        },
        {
          kind: "call",
          fn: "lte",
          args: [
            { kind: "field", fieldId: "day" },
            { kind: "literal", type: "date", value: "2026-11-03" },
          ],
        },
      ],
    };
    // 3 November shown, 2 November read as lookback, 4 November outside.
    same(
      { groupBy: ["day", "at"], measureIds: ["rolling"], filter },
      2 * PER_DAY,
    );
  });

  it("a label field costs nothing where no label is shown or asked for", () => {
    const plain = bucketed({ groupBy: ["at"] });
    const labelled = bucketed({ groupBy: ["at"] }, true);
    expect(rowsOf(labelled)).toEqual(rowsOf(plain));
    expect(labelled.rows.some((row) => row.dimensionLabels)).toBe(false);
    expect(labelled.operations).toBe(plain.operations);
    // The same grouping in dates shows its labels, and pays for them.
    const dates = asDates({ groupBy: ["at"] }, true);
    expect(dates.rows[0]!.dimensionLabels).toEqual({ at: "Day 02" });
    expect(dates.operations - asDates({ groupBy: ["at"] }).operations).toBe(
      all,
    );
    // Another labelled dimension next to the bucketed one keeps its labels.
    const both = querySemanticModel(
      {
        ...modelOf(true),
        dimensions: [
          ...modelOf(true).dimensions,
          {
            id: "seen",
            name: "Seen",
            datasetId: "items",
            fieldId: "day",
            timeAlignment: "reporting_date",
            labelFieldId: "label",
          },
        ],
      },
      new Map([["items", tableOf("timestamp")]]),
      {
        measureIds: ["count"],
        groupBy: ["at", "seen"],
        groupByGrain: { at: "day" },
      },
    );
    expect(both.rows[0]!.dimensionLabels).toEqual({ seen: "Day 02" });
  });

  it("a filter on a labelled bucketed dimension still names its values", () => {
    const instant = instants[0]!;
    const result = bucketed(
      { groupBy: ["at"], filter: compare("eq", "timestamp", instant) },
      true,
    );
    expect(rowsOf(result)).toEqual([
      { dimensions: { at: "2026-11-02" }, measures: { count: 1 } },
    ]);
    expect(result.filterValueLabels).toEqual([
      { dimensionId: "at", value: instant, label: "Day 02" },
    ]);
    // What the filter's labels cost, and one bucket for the one kept row.
    const dates = asDates(
      { groupBy: ["at"], filter: compare("eq", "date", "2026-11-02") },
      true,
    );
    const unlabelled = asDates({
      groupBy: ["at"],
      filter: compare("eq", "date", "2026-11-02"),
    });
    const labelCost = dates.operations - unlabelled.operations;
    expect(
      result.operations -
        bucketed({
          groupBy: ["at"],
          filter: compare("eq", "timestamp", instant),
        }).operations,
    ).toBe(labelCost);
  });

  it("10,000 instants of one day are one row within a 65,000 budget, labelled or not", () => {
    const day = Array.from({ length: 10_000 }, (_, index) => {
      const hour = String(Math.floor(index / 3600)).padStart(2, "0");
      const minute = String(Math.floor(index / 60) % 60).padStart(2, "0");
      const second = String(index % 60).padStart(2, "0");
      return `2026-11-02T${hour}:${minute}:${second}Z`;
    });
    const table = (labelled: boolean): DataTable => ({
      fields: [
        { id: "at", name: "At", type: "timestamp", nullable: false },
        ...(labelled
          ? [
              {
                id: "label",
                name: "Label",
                type: "string" as const,
                nullable: false,
              },
            ]
          : []),
      ],
      rows: day.map((at) => (labelled ? { at, label: at } : { at })),
    });
    for (const labelled of [false, true]) {
      const result = querySemanticModel(
        {
          version: 1,
          datasets: ["items"],
          relationships: [],
          dimensions: [
            {
              id: "at",
              name: "At",
              datasetId: "items",
              fieldId: "at",
              ...(labelled ? { labelFieldId: "label" } : {}),
            },
          ],
          measures: [modelOf(false).measures[0]!],
        },
        new Map([["items", table(labelled)]]),
        { measureIds: ["count"], groupBy: ["at"], groupByGrain: { at: "day" } },
        new ProcessingBudget(65_000),
      );
      expect(rowsOf(result), String(labelled)).toEqual([
        { dimensions: { at: "2026-11-02" }, measures: { count: 10_000 } },
      ]);
    }
  });
});

describe("time grain buckets", () => {
  it("names a bucket by its first day", () => {
    expect(grainStart("2026-11-22", "day")).toBe("2026-11-22");
    expect(grainStart("2026-11-22", "week")).toBe("2026-11-16");
    expect(grainStart("2026-11-16", "week")).toBe("2026-11-16");
    expect(grainStart("2027-01-01", "week")).toBe("2026-12-28");
    expect(grainStart("2024-02-29", "month")).toBe("2024-02-01");
    // Years before 100 stay what they are.
    expect(grainStart("0001-01-03", "week")).toBe("0001-01-01");
  });

  it("keeps a source's zero time and the last day on their UTC day", () => {
    const west = timeGrainBucket("timestamp", "day", "America/New_York");
    expect(west("0001-01-01T00:00:00Z")).toBe("0001-01-01");
    const east = timeGrainBucket("timestamp", "day", "Pacific/Kiritimati");
    expect(east("9999-12-31T23:00:00Z")).toBe("9999-12-31");
    expect(east("9999-12-29T23:00:00Z")).toBe("9999-12-30");
    expect(east("2026-11-02T10:00:00.123456789Z")).toBe("2026-11-03");
  });

  it("agrees with the zone for every instant around midnights and clock changes", () => {
    // Zones with whole-hour, half-hour and 45-minute offsets, and one whose
    // clocks changed a minute past midnight (St. John's until 2006).
    const cases: Array<[string, string]> = [
      ["Europe/Berlin", "2026-03-28T20:00:00Z"],
      ["Europe/Berlin", "2026-10-24T20:00:00Z"],
      ["Asia/Kathmandu", "2026-11-02T17:00:00Z"],
      ["Asia/Kolkata", "2026-11-02T17:00:00Z"],
      ["Australia/Lord_Howe", "2026-04-04T12:00:00Z"],
      ["America/St_Johns", "2005-10-30T01:00:00Z"],
      ["Asia/Beirut", "2021-10-30T19:00:00Z"],
    ];
    for (const [timeZone, from] of cases) {
      const bucket = timeGrainBucket("timestamp", "day", timeZone);
      const start = Date.parse(from);
      for (let second = 0; second < 6 * 3600; second += 7) {
        const instant = new Date(start + second * 1000);
        expect(
          bucket(instant.toISOString().slice(0, 19) + "Z"),
          `${timeZone} ${instant.toISOString()}`,
        ).toBe(civilDate(instant, timeZone));
      }
    }
  });

  it("gives every parseable instant a well-formed bucket (review of #852)", () => {
    // The reported case: a three-digit year in a zone other than UTC.
    const berlin = (grain: "day" | "week" | "month") =>
      timeGrainBucket("timestamp", grain, "Europe/Berlin");
    expect(berlin("day")("0500-11-02T08:00:00Z")).toBe("0500-11-02");
    expect(berlin("month")("0500-11-02T08:00:00Z")).toBe("0500-11-01");
    // 2 November 500 is a Tuesday.
    expect(berlin("week")("0500-11-02T08:00:00Z")).toBe("0500-11-01");

    const zones = [
      "UTC",
      "Europe/Berlin",
      "America/New_York",
      "Asia/Kathmandu",
      "Pacific/Kiritimati",
      "Pacific/Pago_Pago",
      "Australia/Lord_Howe",
      "Etc/GMT-14",
      "Etc/GMT+12",
    ];
    const years = [
      0, 1, 2, 50, 99, 100, 101, 500, 999, 1000, 1582, 1883, 1900, 1969, 1970,
      2026, 2038, 5000, 9998, 9999,
    ];
    const times = ["01-01T00:00:00Z", "06-15T12:34:56.789Z", "12-31T23:59:59Z"];
    for (const timeZone of zones)
      for (const grain of ["day", "week", "month"] as const) {
        const bucket = timeGrainBucket("timestamp", grain, timeZone);
        const day = timeGrainBucket("timestamp", "day", timeZone);
        for (const year of years)
          for (const time of times) {
            const value = `${String(year).padStart(4, "0")}-${time}`;
            const where = `${timeZone} ${grain} ${value}`;
            const result = bucket(value);
            expect(result, where).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(
              new Date(result + "T00:00:00Z").toISOString().slice(0, 10),
              where,
            ).toBe(result);
            // The bucket starts on or before the instant's own day there.
            expect(result <= day(value), where).toBe(true);
          }
      }
    // Dates too, down to the first one a date can be.
    for (const grain of ["day", "week", "month"] as const) {
      const bucket = timeGrainBucket("date", grain, "Europe/Berlin");
      for (const date of [
        "0000-01-01",
        "0000-01-03",
        "0001-01-01",
        "0999-12-31",
        "9999-12-31",
      ]) {
        expect(bucket(date), `${grain} ${date}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(bucket(date) <= date, `${grain} ${date}`).toBe(true);
      }
    }
    // The week holding the first day is cut at it.
    expect(grainStart("0000-01-01", "week")).toBe("0000-01-01");
    expect(grainStart("0000-01-03", "week")).toBe("0000-01-03");
    expect(grainStart("0000-01-09", "week")).toBe("0000-01-03");
  });

  it("refuses what is no date or timestamp with a data error, never a crash", () => {
    const failure = (action: () => unknown) => {
      try {
        action();
      } catch (error) {
        return error instanceof DataProcessingError ? error.code : error;
      }
      return null;
    };
    for (const timeZone of ["UTC", "Europe/Berlin"])
      for (const grain of ["day", "week", "month"] as const) {
        const bucket = timeGrainBucket("timestamp", grain, timeZone);
        for (const value of ["", "soon", "2026-13-45T99:00:00Z", "2026-11-02"])
          expect(
            failure(() => bucket(value as string)),
            String(value),
          ).toBe("data_timestamp_invalid");
        // What is no text at all fails as it does in a table.
        for (const value of [7, {}])
          expect(failure(() => bucket(value as string))).toBe(
            "data_string_required",
          );
        const date = timeGrainBucket("date", grain, timeZone);
        for (const value of ["", "soon", "2026-02-30", "2026-11-02T08:00:00Z"])
          expect(
            failure(() => date(value as string)),
            String(value),
          ).toBe("data_date_invalid");
        expect(failure(() => date(7 as unknown as string))).toBe(
          "data_string_required",
        );
      }
  });

  it("buckets every spelling of an instant alike, UTC being a zone like others (review 2 of #852)", () => {
    // to_timestamp keeps "24:00:00", the first instant of the next day:
    // Sunday 1 November 24:00 is Monday 2 November.
    for (const timeZone of ["UTC", "Etc/UTC", "Africa/Abidjan"]) {
      const of = (grain: "day" | "week" | "month", value: string) =>
        timeGrainBucket("timestamp", grain, timeZone)(value);
      expect(of("day", "2026-11-01T24:00:00Z"), timeZone).toBe("2026-11-02");
      expect(of("week", "2026-11-01T24:00:00Z"), timeZone).toBe("2026-11-02");
      expect(of("month", "2026-11-30T24:00:00Z"), timeZone).toBe("2026-12-01");
      expect(of("day", "2026-12-31T24:00:00.000Z"), timeZone).toBe(
        "2027-01-01",
      );
    }
    // Every form the timestamp type accepts (validateDataValue): whole
    // seconds, one to nine fraction digits, and hour 24.
    const forms = (day: string) => [
      `${day}T00:00:00Z`,
      `${day}T12:34:56Z`,
      `${day}T23:59:59Z`,
      `${day}T23:59:59.9Z`,
      `${day}T23:59:59.999Z`,
      `${day}T23:59:59.999999999Z`,
      `${day}T24:00:00Z`,
      `${day}T24:00:00.0Z`,
      `${day}T24:00:00.000000000Z`,
    ];
    const days = [
      "0001-01-01",
      "0099-12-31",
      "0100-01-01",
      "1999-12-31",
      "2024-02-29",
      "2026-11-01",
      "2026-11-30",
      "9999-12-30",
      "9999-12-31",
    ];
    for (const grain of ["day", "week", "month"] as const) {
      const zones = ["UTC", "Etc/UTC", "Etc/GMT"].map(
        (timeZone) =>
          [timeZone, timeGrainBucket("timestamp", grain, timeZone)] as const,
      );
      for (const day of days)
        for (const value of forms(day)) {
          validateDataValue("timestamp", value, false);
          const results = zones.map(([, bucket]) => bucket(value));
          expect(new Set(results).size, `${grain} ${value} ${results}`).toBe(1);
          // And as the instant says, whatever its spelling.
          const instant = new Date(
            Math.min(
              Date.parse(value.slice(0, 19) + "Z"),
              Date.parse("9999-12-31T23:59:59Z"),
            ),
          );
          expect(results[0], `${grain} ${value}`).toBe(
            grainStart(instant.toISOString().slice(0, 10), grain),
          );
        }
    }
  });

  it("reads the zone's day up to the last and from the first day a date can be (review 2 of #852)", () => {
    // Fixed offsets (named zones had local mean time in the year 100):
    // the most positive, UTC+14, and UTC−11.
    const east = timeGrainBucket("timestamp", "day", "Etc/GMT-14");
    const west = timeGrainBucket("timestamp", "day", "Etc/GMT+11");
    // The last representable day is a day like any other in the zone.
    expect(east("9999-12-30T09:59:59Z")).toBe("9999-12-30");
    expect(east("9999-12-30T10:00:00Z")).toBe("9999-12-31");
    expect(east("9999-12-30T23:00:00Z")).toBe("9999-12-31");
    expect(east("9999-12-31T09:59:59Z")).toBe("9999-12-31");
    // Past it in the zone (already the year 10000 there): the last day.
    expect(east("9999-12-31T10:00:00Z")).toBe("9999-12-31");
    expect(east("9999-12-31T23:59:59Z")).toBe("9999-12-31");
    expect(east("9999-12-31T24:00:00Z")).toBe("9999-12-31");
    expect(west("9999-12-31T10:59:59Z")).toBe("9999-12-30");
    expect(west("9999-12-31T11:00:00Z")).toBe("9999-12-31");
    expect(west("9999-12-31T24:00:00Z")).toBe("9999-12-31");
    // Before the year 100 an instant is its UTC day; from then on the zone's.
    expect(east("0099-12-31T23:59:59Z")).toBe("0099-12-31");
    expect(east("0099-12-31T24:00:00Z")).toBe("0100-01-01");
    expect(east("0100-01-01T00:00:00Z")).toBe("0100-01-01");
    expect(east("0100-01-01T10:00:00Z")).toBe("0100-01-02");
    expect(west("0099-12-31T23:59:59Z")).toBe("0099-12-31");
    expect(west("0100-01-01T00:00:00Z")).toBe("0099-12-31");
    expect(west("0100-01-01T10:59:59Z")).toBe("0099-12-31");
    expect(west("0100-01-01T11:00:00Z")).toBe("0100-01-01");
    // Buckets never go back as instants go on, across both edges.
    for (const bucket of [east, west]) {
      let previous = "";
      for (const value of [
        "0099-12-30T12:00:00Z",
        "0099-12-31T23:59:59Z",
        "0100-01-01T00:00:00Z",
        "0100-01-01T12:00:00Z",
        "0100-01-02T12:00:00Z",
        "9999-12-29T12:00:00Z",
        "9999-12-30T12:00:00Z",
        "9999-12-31T12:00:00Z",
        "9999-12-31T24:00:00Z",
      ]) {
        const day = bucket(value);
        expect(day >= previous, `${value}: ${day} after ${previous}`).toBe(
          true,
        );
        previous = day;
      }
    }
  });

  it("accepts exactly the timestamps and dates a table can hold (review 3 of #852)", () => {
    const valid = (type: "date" | "timestamp", value: unknown) => {
      try {
        validateDataValue(type, value, false);
        return true;
      } catch {
        return false;
      }
    };
    const timestamps: unknown[] = [
      "2026-11-02T08:00:00Z",
      "2026-11-02T08:00:00.1Z",
      "2026-11-02T08:00:00.123456789Z",
      "2026-11-02T24:00:00Z",
      "2026-11-02T24:00:00.000Z",
      "0000-01-01T00:00:00Z",
      "9999-12-31T24:00:00Z",
      // Not timestamps, though cutting their fraction would make them one.
      "2026-11-02T24:00:00.1Z",
      "2026-11-02T24:00:00.000000001Z",
      "2026-11-02T08:00:00.Z",
      "2026-11-02T08:00:00.1234567890Z",
      "2026-11-02T08:00:00.1.2Z",
      "2026-11-02T08:00:00:00Z",
      "2026-11-02T08:00:00..Z",
      "2026-11-02T08:00:00",
      "2026-11-02T08:00:00z",
      "2026-11-02T08:00:00+05:30",
      "2026-11-02T08:00Z",
      "2026-11-02T24:00:01Z",
      "2026-11-02T25:00:00Z",
      "2026-11-02T08:60:00Z",
      "2026-11-02T23:59:60Z",
      "2026-02-30T08:00:00Z",
      "2026-13-01T08:00:00Z",
      "2026-11-02 08:00:00Z",
      " 2026-11-02T08:00:00Z",
      "2026-11-02T08:00:00Z\n",
      "2026-11-02",
      "soon",
      "",
      7,
      null,
      {},
    ];
    const dates: unknown[] = [
      "2026-11-02",
      "0000-01-01",
      "9999-12-31",
      "2024-02-29",
      "2026-02-29",
      "2026-11-31",
      "2026-00-10",
      "2026-11-2",
      "2026-11-02T08:00:00Z",
      "2026-11-02\n",
      "soon",
      "",
      7,
      null,
    ];
    expect(timestamps.filter((value) => valid("timestamp", value)).length).toBe(
      7,
    );
    for (const timeZone of ["UTC", "Europe/Berlin", "Etc/GMT-14"])
      for (const grain of ["day", "week", "month"] as const) {
        for (const [type, values] of [
          ["timestamp", timestamps],
          ["date", dates],
        ] as const) {
          const bucket = timeGrainBucket(type, grain, timeZone);
          for (const value of values) {
            let result: unknown;
            try {
              result = bucket(value as string);
            } catch (error) {
              // A data error, never anything else.
              expect(error, String(value)).toBeInstanceOf(DataProcessingError);
              result = undefined;
            }
            const where = `${type} ${timeZone} ${grain} ${JSON.stringify(value)}`;
            expect(result !== undefined, where).toBe(valid(type, value));
            if (result !== undefined)
              expect(result, where).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          }
        }
      }
  });
});
