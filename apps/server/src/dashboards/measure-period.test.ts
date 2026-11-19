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
import { DEFAULT_DATA_POLICY } from "@netrics/domain";

import { createDataService } from "../data/service.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "../test-db.js";
import { queryDashboardMeasure } from "./data.js";

// A measure widget's own period (#784): the workspace's days on the model's
// reporting-date dimension, whatever the filters say.

// 07:00 UTC on Nov 19 is still Nov 18 in Los Angeles.
const NOW = new Date("2026-11-19T07:00:00Z");
let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
let db: Database, owner: Sql, workspaceId: string;
let dated: string, undated: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = createDatabase(testDb.appUrl);
  owner = createRawSqlClient(testDb.adminUrl, { max: 1 });
  const [user] = await db
    .insert(schema.users)
    .values({ email: "period@example.test", displayName: "Owner" })
    .returning();
  workspaceId = await createWorkspace(db, {
    name: "Period",
    ownerUserId: user!.id,
  });
  await owner`update workspaces set time_zone = 'America/Los_Angeles'
    where id = ${workspaceId}`;
  const service = createDataService(db, () => NOW);
  const actor = { workspaceId, callerId: user!.id };
  const table = await service.saveManual(actor, {
    definition: {
      key: "installs_by_day",
      name: "Installs",
      version: 1,
      mode: "snapshot",
      grain: "One row per day",
      keyFields: ["day"],
      retentionDays: null,
      fields: [
        { id: "day", type: "date" as const },
        { id: "app", type: "string" as const },
        { id: "installs", type: "integer" as const },
      ].map((field) => ({
        ...field,
        name: field.id,
        nullable: false,
        classification: "internal" as const,
      })),
    },
    records: [
      { values: { day: "2026-11-17", app: "a", installs: 3 } },
      { values: { day: "2026-11-18", app: "a", installs: 5 } },
      { values: { day: "2026-11-19", app: "a", installs: 7 } },
    ],
  });
  const model = async (timeAlignment?: "reporting_date") => {
    const saved = await service.saveModel(actor, {
      name: timeAlignment ? "Dated" : "Undated",
      definition: {
        version: 1,
        datasets: [table.datasetId],
        relationships: [],
        // Without a reporting date: only the app.
        dimensions: timeAlignment
          ? [
              {
                id: "day",
                name: "Day",
                datasetId: table.datasetId,
                fieldId: "day",
                timeAlignment,
              },
            ]
          : [
              {
                id: "app",
                name: "App",
                datasetId: table.datasetId,
                fieldId: "app",
              },
            ],
        measures: [
          {
            id: "installs",
            name: "Installs",
            kind: "aggregate",
            datasetId: table.datasetId,
            aggregate: {
              id: "installs",
              name: "Installs",
              op: "sum",
              fieldId: "installs",
            },
          },
        ],
      },
    } as never);
    await service.publishModel(actor, saved.model.id, 1);
    return saved.model.id as string;
  };
  dated = await model("reporting_date");
  undated = await model();
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await owner?.end({ timeout: 5 });
  await db?.$client.end({ timeout: 5 });
  await testDb?.drop();
});

const read = (modelId: string, period?: "today" | "last_7_days") =>
  withWorkspace(db, { workspaceId }, (tx) =>
    queryDashboardMeasure(
      tx,
      workspaceId,
      {
        id: "77777777-7777-4777-8777-777777777777",
        binding: {
          modelId,
          measureIds: ["installs"],
          groupBy: [],
          exclusions: [],
        },
        options: { view: "value", limit: 20, ...(period ? { period } : {}) },
      },
      [],
      {},
      NOW,
      DEFAULT_DATA_POLICY,
    ),
  );
const value = async (modelId: string, period?: "today" | "last_7_days") =>
  Number(
    (await read(modelId, period)).result?.rows[0]?.measures.installs?.value,
  );

describe("a measure widget's own period (#784)", () => {
  it("reads the workspace's days, not UTC's", async () => {
    // Today in Los Angeles is Nov 18 (UTC already has Nov 19).
    expect(await value(dated, "today")).toBe(5);
    // The last 7 days end on Nov 18 too: Nov 19 is tomorrow there.
    expect(await value(dated, "last_7_days")).toBe(8);
    // Without a period, every day.
    expect(await value(dated)).toBe(15);
  });

  it("refuses a period on a model without a reporting date", async () => {
    const data = await read(undated, "today");
    expect(data.error).toBe("dashboard_measure_period_unsupported");
    expect(data.result).toBeNull();
  });
});
