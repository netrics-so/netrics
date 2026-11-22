import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  createRawSqlClient,
  createWorkspace,
  schema,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";
import {
  DEFAULT_DATA_POLICY,
  type DataExpression,
  type MeasureWidgetBinding,
} from "@netrics/domain";

import { createDataService, queryDataModel } from "../data/service.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "../test-db.js";
import { queryDashboardMeasure } from "./data.js";

// A measure widget grouped by a time grain (#838, ADR 0028): one row per
// day, week or month of the workspace's calendar instead of one per second.

const NOW = new Date("2026-11-22T12:00:00Z");
let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
let db: Database, owner: Sql, workspaceId: string, modelId: string;

// Berlin days: UTC+1 in November, so 23:30Z belongs to the next day.
const TAKEN = [
  "2026-11-01T22:59:59Z", // Sunday 1 November, 23:59
  "2026-11-01T23:30:00Z", // Monday 2 November, 00:30
  "2026-11-02T08:00:00Z",
  "2026-11-02T08:00:01Z",
  "2026-11-03T12:00:00Z",
  "2026-11-30T23:10:00Z", // Tuesday 1 December, 00:10
];

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = createDatabase(testDb.appUrl);
  owner = createRawSqlClient(testDb.adminUrl, { max: 1 });
  const [user] = await db
    .insert(schema.users)
    .values({ email: "grain@example.test", displayName: "Owner" })
    .returning();
  workspaceId = await createWorkspace(db, {
    name: "Grain",
    ownerUserId: user!.id,
  });
  await owner`update workspaces set time_zone = 'Europe/Berlin'
    where id = ${workspaceId}`;
  const service = createDataService(db, () => NOW);
  const actor = { workspaceId, callerId: user!.id };
  const table = await service.saveManual(actor, {
    definition: {
      key: "photos",
      name: "Photos",
      version: 1,
      mode: "snapshot",
      grain: "One row per photo",
      keyFields: ["id"],
      retentionDays: null,
      fields: [
        { id: "id", type: "integer" as const, nullable: false },
        { id: "taken_at", type: "timestamp" as const, nullable: true },
        { id: "album", type: "string" as const, nullable: false },
      ].map((field) => ({
        ...field,
        name: field.id,
        classification: "internal" as const,
      })),
    },
    records: [
      ...TAKEN.map((taken_at, id) => ({
        values: { id, taken_at, album: id % 2 ? "b" : "a" },
      })),
      { values: { id: 99, taken_at: null, album: "a" } },
    ],
  });
  const saved = await service.saveModel(actor, {
    name: "Photos",
    definition: {
      version: 1,
      datasets: [table.datasetId],
      relationships: [],
      dimensions: [
        {
          id: "taken",
          name: "Taken",
          datasetId: table.datasetId,
          fieldId: "taken_at",
        },
        {
          id: "album",
          name: "Album",
          datasetId: table.datasetId,
          fieldId: "album",
        },
      ],
      measures: [
        {
          id: "photos",
          name: "Photos",
          kind: "aggregate",
          datasetId: table.datasetId,
          aggregate: { id: "photos", name: "Photos", op: "count" },
        },
      ],
    },
  } as never);
  await service.publishModel(actor, saved.model.id, 1);
  modelId = saved.model.id as string;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await owner?.end({ timeout: 5 });
  await db?.$client.end({ timeout: 5 });
  await testDb?.drop();
});

const read = (
  binding: Partial<MeasureWidgetBinding>,
  options: { view?: "table" | "line" | "bar" | "value"; limit?: number } = {},
) =>
  withWorkspace(db, { workspaceId }, (tx) =>
    queryDashboardMeasure(
      tx,
      workspaceId,
      {
        id: "77777777-7777-4777-8777-777777777777",
        binding: {
          modelId,
          measureIds: ["photos"],
          groupBy: ["taken"],
          exclusions: [],
          ...binding,
        },
        options: { view: "table", limit: 20, ...options },
      },
      [],
      {},
      NOW,
      DEFAULT_DATA_POLICY,
    ),
  );
const rows = (data: Awaited<ReturnType<typeof read>>) =>
  data.result?.rows.map((row) => [
    row.dimensions.taken,
    row.measures.photos?.value,
  ]);

describe("a measure widget grouped by a time grain (#838)", () => {
  it("still groups a timestamp per second without a grain", async () => {
    const data = await read({});
    expect(data.error).toBeNull();
    expect(data.result?.totalRows).toBe(7);
    expect(
      data.metadata?.dimensions.find((dimension) => dimension.id === "taken")
        ?.type,
    ).toBe("timestamp");
  });

  it("returns one row per day of the workspace's calendar", async () => {
    const data = await read({ groupByGrain: { taken: "day" } });
    expect(data.error).toBeNull();
    expect(rows(data)).toEqual([
      ["2026-11-01", 1],
      ["2026-11-02", 3],
      ["2026-11-03", 1],
      ["2026-12-01", 1],
      [null, 1],
    ]);
    // Clients word, sort and chart the groups as the dates they are.
    expect(
      data.metadata?.dimensions.find((dimension) => dimension.id === "taken")
        ?.type,
    ).toBe("date");
  });

  it("groups by ISO week and by month", async () => {
    expect(rows(await read({ groupByGrain: { taken: "week" } }))).toEqual([
      ["2026-10-26", 1],
      ["2026-11-02", 4],
      ["2026-11-30", 1],
      [null, 1],
    ]);
    expect(rows(await read({ groupByGrain: { taken: "month" } }))).toEqual([
      ["2026-11-01", 5],
      ["2026-12-01", 1],
      [null, 1],
    ]);
  });

  it("applies the maximum rows to the buckets, a chart's to the latest", async () => {
    const table = await read(
      { groupByGrain: { taken: "day" } },
      { view: "table", limit: 2 },
    );
    expect(table.result?.totalRows).toBe(5);
    expect(rows(table)).toEqual([
      ["2026-11-01", 1],
      ["2026-11-02", 3],
    ]);
    // A line chart of a bucketed timestamp is a time series: its last
    // points, ascending.
    const filter: DataExpression = {
      kind: "call",
      fn: "not",
      args: [
        {
          kind: "call",
          fn: "is_null",
          args: [{ kind: "field", fieldId: "taken" }],
        },
      ],
    };
    const line = await read(
      { groupByGrain: { taken: "day" }, filter },
      { view: "line", limit: 2 },
    );
    expect(line.error).toBeNull();
    expect(rows(line)).toEqual([
      ["2026-11-03", 1],
      ["2026-12-01", 1],
    ]);
  });

  it("filters on the timestamp itself", async () => {
    const filter: DataExpression = {
      kind: "call",
      fn: "gt",
      args: [
        { kind: "field", fieldId: "taken" },
        { kind: "literal", type: "timestamp", value: "2026-11-02T08:00:00Z" },
      ],
    };
    expect(
      rows(await read({ groupByGrain: { taken: "day" }, filter })),
    ).toEqual([
      ["2026-11-02", 1],
      ["2026-11-03", 1],
      ["2026-12-01", 1],
    ]);
  });

  it("refuses a grain on a dimension that is no time, or not grouped", async () => {
    const text = await read({
      groupBy: ["album"],
      groupByGrain: { album: "day" },
    });
    expect(text.error).toBe("model_group_grain_not_temporal");
    expect(text.result).toBeNull();
    const ungrouped = await read({
      groupBy: ["album"],
      groupByGrain: { taken: "day" },
    });
    expect(ungrouped.error).toBe("dashboard_measure_grain_invalid");
  });

  it("follows the workspace's time zone, also for a remembered result", async () => {
    const query = {
      measureIds: ["photos"],
      groupBy: ["taken"],
      groupByGrain: { taken: "day" as const },
    };
    const days = async () =>
      (
        await withWorkspace(db, { workspaceId }, (tx) =>
          queryDataModel(tx, workspaceId, modelId, query, NOW, {
            ...DEFAULT_DATA_POLICY,
          }),
        )
      ).rows.map((row) => [row.dimensions.taken, row.measures.photos?.value]);
    expect((await days())[1]).toEqual(["2026-11-02", 3]);
    await owner`update workspaces set time_zone = 'UTC'
      where id = ${workspaceId}`;
    try {
      expect(await days()).toEqual([
        ["2026-11-01", 2],
        ["2026-11-02", 2],
        ["2026-11-03", 1],
        ["2026-11-30", 1],
        [null, 1],
      ]);
    } finally {
      await owner`update workspaces set time_zone = 'Europe/Berlin'
        where id = ${workspaceId}`;
    }
  });
});
