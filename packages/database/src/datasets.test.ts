import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  sourceDatasetSchema,
  type SourceDatasetDefinition,
  type DatasetPage,
} from "@netrics/contracts";
import { createTestDatabase, type TestDatabase } from "./test-db.js";
import { withWorkspace, hasSqlstate, type Db } from "./context.js";
import {
  ingestDatasetPage,
  previewDataset,
  pruneDatasetHistory,
  replayDatasetRefresh,
  listObservationDatasets,
  readObservationDataset,
} from "./datasets.js";
import * as schema from "./schema.js";
import * as auth from "./auth-schema.js";

let test: TestDatabase, admin: postgres.Sql, app: postgres.Sql, db: Db;
let a: string, b: string, ca: string, cb: string;
const now = new Date("2026-11-05T12:00:00Z");
function definition(
  key: string,
  mode: SourceDatasetDefinition["mode"] = "upsert",
) {
  return sourceDatasetSchema.parse({
    key,
    name: key,
    version: 1,
    keyFields: ["id"],
    grain: "one order",
    mode,
    reportingField: "day",
    fields: [
      {
        id: "id",
        name: "ID",
        type: "string",
        nullable: false,
        classification: "internal",
      },
      {
        id: "amount",
        name: "Amount",
        type: "decimal",
        nullable: false,
        classification: "internal",
      },
      {
        id: "paid",
        name: "Paid",
        type: "boolean",
        nullable: false,
        classification: "internal",
      },
      {
        id: "day",
        name: "Date",
        type: "date",
        nullable: false,
        classification: "internal",
      },
    ],
  });
}
function record(id: string, amount = "10.25", day = "2026-11-01") {
  return { values: { id, amount, paid: true, day } };
}
function page(
  def: SourceDatasetDefinition,
  overrides: Partial<DatasetPage> = {},
): DatasetPage {
  return {
    datasetKey: def.key,
    schemaVersion: def.version,
    refreshKey: "r1",
    pageKey: "p1",
    previousPageKey: null,
    complete: true,
    records: [record("one")],
    ...overrides,
  };
}
function ingest(
  def: SourceDatasetDefinition,
  p: DatasetPage,
  workspaceId = a,
  connectionId = ca,
  at = now,
) {
  return withWorkspace(db, { workspaceId }, (tx) =>
    ingestDatasetPage(tx, {
      workspaceId,
      connectionId,
      definition: def,
      page: p,
      now: at,
    }),
  );
}
function preview(
  datasetId: string,
  workspaceId = a,
  at = now,
  generationId?: string,
) {
  return withWorkspace(db, { workspaceId }, (tx) =>
    previewDataset(tx, {
      workspaceId,
      datasetId,
      now: at,
      ...(generationId ? { generationId } : {}),
    }),
  );
}

beforeAll(async () => {
  test = await createTestDatabase({ upTo: "0051_device_platform" });
  admin = postgres(test.adminUrl, { max: 1 });
  await admin`insert into connectors(id,version,manifest) values ('dataset-fixture','1.0.0','{}')`;
  const ws = (
    await admin`insert into workspaces(name) values ('A'),('B') returning id`
  ).map((r) => r.id as string);
  a = ws[0]!;
  b = ws[1]!;
  const cs = (
    await admin`insert into connections(workspace_id,connector_id,name) values (${a},'dataset-fixture','A'),(${b},'dataset-fixture','B') returning id`
  ).map((r) => r.id as string);
  ca = cs[0]!;
  cb = cs[1]!;
  await test.migrate();
  app = postgres(test.appUrl, { max: 4 });
  db = drizzle(app, { schema: { ...schema, ...auth } });
}, 60_000);
afterAll(async () => {
  await app?.end({ timeout: 5 });
  await admin?.end({ timeout: 5 });
});

describe("durable typed dataset ingestion", () => {
  it("accepts more than the old 100-page refresh ceiling when policy permits", async () => {
    const d = definition("many-pages", "snapshot");
    let result;
    for (let index = 0; index < 101; index++)
      result = await ingest(
        d,
        page(d, {
          pageKey: "p" + index,
          previousPageKey: index ? "p" + (index - 1) : null,
          records: [record("row" + index)],
          complete: index === 100,
        }),
      );
    expect(result?.generationId).toBeTruthy();
    const [generation] =
      await admin`select row_count from data_generations where id=${result!.generationId}`;
    expect(generation!.row_count).toBe(101);
  });
  it("migrates populated prior databases without altering existing connections", async () => {
    expect(
      (await admin`select name from connections order by name`).map(
        (r) => r.name,
      ),
    ).toEqual(["A", "B"]);
  });
  it("keeps staged pages invisible and atomically publishes a complete generation", async () => {
    const d = definition("atomic");
    const first = page(d, { complete: false });
    const r = await ingest(d, first);
    expect(r.generationId).toBeNull();
    expect(await preview(r.datasetId)).toBeNull();
    expect((await ingest(d, first)).replayed).toBe(true);
    await expect(
      ingest(d, page(d, { pageKey: "p2", previousPageKey: "wrong" })),
    ).rejects.toThrow("dataset_page_out_of_order");
    const end = await ingest(
      d,
      page(d, {
        pageKey: "p2",
        previousPageKey: "p1",
        records: [record("two", "999999999999999999.99")],
      }),
    );
    expect((await preview(r.datasetId))?.rows).toEqual([
      record("one").values,
      record("two", "999999999999999999.99").values,
    ]);
    expect(
      (
        await ingest(
          d,
          page(d, {
            pageKey: "p2",
            previousPageKey: "p1",
            records: [record("two", "999999999999999999.99")],
          }),
        )
      ).generationId,
    ).toBe(end.generationId);
    await expect(
      ingest(
        d,
        page(d, { records: [record("one", "11.00")], complete: false }),
      ),
    ).rejects.toThrow("dataset_page_conflict");
  });
  it("revises and deletes by source key while preserving pinned earlier generations", async () => {
    const d = definition("correction");
    const first = await ingest(d, page(d));
    await ingest(
      d,
      page(d, {
        refreshKey: "r2",
        records: [record("one", "20.00"), record("two")],
      }),
    );
    expect((await preview(first.datasetId))?.rows[0]?.amount).toBe("20.00");
    expect(
      (await preview(first.datasetId, a, now, first.generationId!))?.rows[0]
        ?.amount,
    ).toBe("10.25");
    await ingest(
      d,
      page(d, {
        refreshKey: "r3",
        records: [{ values: { id: "one" }, deleted: true }],
      }),
    );
    expect((await preview(first.datasetId))?.rows).toEqual([
      record("two").values,
    ]);
  });
  it("replaces only a completed reporting interval and retains other days", async () => {
    const d = definition("windows", "replace_window");
    const window = {
      from: "2026-11-01",
      toExclusive: "2026-11-04",
      partition: {},
    };
    const first = await ingest(
      d,
      page(d, {
        window,
        records: [record("old"), record("later", "30.00", "2026-11-03")],
      }),
    );
    const replacement = {
      from: "2026-11-01",
      toExclusive: "2026-11-02",
      partition: {},
    };
    await ingest(
      d,
      page(d, {
        refreshKey: "r2",
        window: replacement,
        complete: false,
        records: [],
      }),
    );
    expect((await preview(first.datasetId))?.rows).toHaveLength(2);
    await ingest(
      d,
      page(d, {
        refreshKey: "r2",
        window: replacement,
        pageKey: "p2",
        previousPageKey: "p1",
        records: [record("new")],
      }),
    );
    expect((await preview(first.datasetId))?.rows.map((r) => r.id)).toEqual([
      "later",
      "new",
    ]);
  });
  it("does not multiply append events and refuses conflicting identities", async () => {
    const d = definition("events", "append");
    const r = await ingest(d, page(d));
    await ingest(d, page(d, { refreshKey: "r2" }));
    expect((await preview(r.datasetId))?.rows).toHaveLength(1);
    await expect(
      ingest(
        d,
        page(d, { refreshKey: "r3", records: [record("one", "9.00")] }),
      ),
    ).rejects.toThrow("dataset_append_identity_conflict");
    expect((await preview(r.datasetId))?.rows[0]?.amount).toBe("10.25");
  });
  it("rejects conflicting source keys in a single complete refresh", async () => {
    const d = definition("conflict");
    await expect(
      ingest(d, page(d, { records: [record("one"), record("one", "2.00")] })),
    ).rejects.toThrow("dataset_record_identity_conflict");
  });
  it("keeps source schema versions immutable and requires compatible upgrades", async () => {
    const d = definition("schemas");
    await ingest(d, page(d));
    await expect(
      ingest({ ...d, name: "changed" }, page(d, { refreshKey: "r2" })),
    ).rejects.toThrow("dataset_schema_version_conflict");
    const bad = {
      ...d,
      version: 2,
      fields: d.fields.map((f) =>
        f.id === "amount" ? { ...f, type: "integer" as const } : f,
      ),
    };
    await expect(
      ingest(bad, page(bad, { refreshKey: "r2" })),
    ).rejects.toThrow();
    const next = sourceDatasetSchema.parse({
      ...d,
      version: 2,
      fields: [
        ...d.fields,
        {
          id: "label",
          name: "Label",
          type: "string",
          nullable: true,
          classification: "internal",
        },
      ],
    });
    const r = await ingest(next, page(next, { refreshKey: "r2", records: [] }));
    expect((await preview(r.datasetId))?.rows[0]?.label).toBeNull();
  });
  it("does not let an older in-progress snapshot replace newer data", async () => {
    const d = definition("snapshots", "snapshot");
    const r = await ingest(d, page(d, { complete: false }));
    await ingest(
      d,
      page(d, { refreshKey: "newer", records: [record("new")] }),
      a,
      ca,
      new Date(now.getTime() + 1000),
    );
    await expect(
      ingest(
        d,
        page(d, { pageKey: "p2", previousPageKey: "p1", records: [] }),
        a,
        ca,
        new Date(now.getTime() + 2000),
      ),
    ).rejects.toThrow("dataset_refresh_superseded");
    expect((await preview(r.datasetId))?.rows[0]?.id).toBe("new");
  });
  it("enforces workspace isolation through explicit predicates, RLS and composite FKs", async () => {
    const d = definition("private");
    const r = await ingest(d, page(d));
    const other = await ingest(d, page(d), b, cb);
    expect(await preview(r.datasetId, b)).toBeNull();
    expect(await preview(other.datasetId, a)).toBeNull();
    await expect(ingest(d, page(d), a, cb)).rejects.toThrow(
      "dataset_connection_not_found",
    );
    const empty = await db.execute(sql`select * from data_records`);
    expect(empty).toHaveLength(0);
    try {
      await withWorkspace(db, { workspaceId: a }, (tx) =>
        tx.insert(schema.dataRecords).values({
          generationId: other.generationId!,
          workspaceId: a,
          recordKey: "spoof",
          values: {},
          collectedAt: now,
          expiresAt: new Date(now.getTime() + 86400000),
        }),
      );
      expect.unreachable("cross-tenant FK should reject forged reference");
    } catch (error) {
      expect(hasSqlstate(error, "23503")).toBe(true);
    }
    for (const table of [
      "data_datasets",
      "data_schema_versions",
      "data_refreshes",
      "data_pages",
      "data_generations",
      "data_records",
    ]) {
      const rows = await withWorkspace(db, { workspaceId: a }, (tx) =>
        tx.execute(
          sql`select distinct workspace_id from ${sql.identifier(table)}`,
        ),
      );
      expect(rows.every((row) => row.workspace_id === a)).toBe(true);
    }
    expect(
      (
        await admin`select has_table_privilege('netrics_scheduler','data_records','select') as allowed`
      )[0]?.allowed,
    ).toBe(false);
  });
  it("rolls back the whole page when the workspace budget would be exceeded", async () => {
    const d = definition("quota");
    await expect(
      withWorkspace(db, { workspaceId: a }, (tx) =>
        ingestDatasetPage(tx, {
          workspaceId: a,
          connectionId: ca,
          definition: d,
          page: page(d),
          now,
          maxWorkspaceBytes: 1,
        }),
      ),
    ).rejects.toThrow("dataset_workspace_quota");
    expect(
      (
        await admin`select count(*)::int n from data_datasets where key='quota'`
      )[0]?.n,
    ).toBe(0);
  });
  it("hides database diagnostics containing source values", async () => {
    await admin.unsafe(
      `create function dataset_test_failure() returns trigger language plpgsql as $$ begin if new.values->>'id' = 'private-diagnostic-fixture' then raise exception 'raw=%',new.values; end if; return new; end $$`,
    );
    await admin.unsafe(
      `create trigger dataset_test_failure before insert on data_records for each row execute function dataset_test_failure()`,
    );
    try {
      const d = definition("diagnostic");
      await expect(
        ingest(d, page(d, { records: [record("private-diagnostic-fixture")] })),
      ).rejects.toThrow(/^dataset_storage_failed$/);
    } finally {
      await admin.unsafe("drop trigger dataset_test_failure on data_records");
      await admin.unsafe("drop function dataset_test_failure()");
    }
  });
  it("replays retained pages without a provider call or extending retention", async () => {
    const d = { ...definition("replay", "snapshot"), retentionDays: 2 };
    const original = await ingest(d, page(d));
    const later = new Date(now.getTime() + 86400000);
    const rebuilt = await withWorkspace(db, { workspaceId: a }, (tx) =>
      replayDatasetRefresh(tx, {
        workspaceId: a,
        datasetId: original.datasetId,
        sourceRefreshKey: "r1",
        newRefreshKey: "rebuild",
        now: later,
      }),
    );
    expect(rebuilt?.generationId).not.toBe(original.generationId);
    expect((await preview(original.datasetId, a, later))?.rows).toEqual([
      record("one").values,
    ]);
    const deadlines =
      await admin`select distinct expires_at from data_records where generation_id in (${original.generationId},${rebuilt!.generationId})`;
    expect(deadlines).toHaveLength(1);
    await expect(
      withWorkspace(db, { workspaceId: b }, (tx) =>
        replayDatasetRefresh(tx, {
          workspaceId: b,
          datasetId: original.datasetId,
          sourceRefreshKey: "r1",
          newRefreshKey: "steal",
          now: later,
        }),
      ),
    ).rejects.toThrow("dataset_replay_unavailable");
    await expect(
      withWorkspace(db, { workspaceId: a }, (tx) =>
        replayDatasetRefresh(tx, {
          workspaceId: a,
          datasetId: original.datasetId,
          sourceRefreshKey: "r1",
          newRefreshKey: "expired",
          now: new Date(now.getTime() + 3 * 86400000),
        }),
      ),
    ).rejects.toThrow("dataset_replay_unavailable");
  });
  it("describes legacy observations as aggregated datasets without claiming raw events", async () => {
    await admin`insert into metric_definitions(connector_id,key,name,description,kind,unit,granularity,dimensions,aggregations) values ('dataset-fixture','hits','Hits','Daily hits','delta','count','day','["country"]','["sum"]')`;
    const descriptors = await withWorkspace(db, { workspaceId: a }, (tx) =>
      listObservationDatasets(tx, a),
    );
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.aggregated).toBe(true);
    expect(descriptors[0]?.connectionId).toBe(ca);
    expect(
      descriptors[0]?.definition.fields.find((f) => f.id === "time")?.type,
    ).toBe("date");
    expect(descriptors[0]?.definition.reportingTimeZone).toBeUndefined();
    const metricId = descriptors[0]!.metricDefinitionId;
    await admin`insert into observations(workspace_id,connection_id,metric_definition_id,dimensions,source_timestamp,value) values (${a},${ca},${metricId},'{"country":"DE"}','2026-11-01T00:00:00Z',12.5)`;
    const query = {
      workspaceId: a,
      connectionId: ca,
      metricDefinitionId: metricId,
      from: new Date("2026-11-01"),
      toExclusive: new Date("2026-11-02"),
    };
    const legacy = await withWorkspace(db, { workspaceId: a }, (tx) =>
      readObservationDataset(tx, query),
    );
    expect(legacy?.rows[0]?.value).toBe(12.5);
    expect(legacy?.rows[0]?.time).toBe("2026-11-01");
    expect(
      legacy?.rows[0]?.[
        descriptors[0]!.definition.fields.find((f) => f.name === "country")!.id
      ],
    ).toBe("DE");
    expect(
      await withWorkspace(db, { workspaceId: b }, (tx) =>
        readObservationDataset(tx, query),
      ),
    ).toBeNull();
    const none = await withWorkspace(db, { workspaceId: b }, (tx) =>
      listObservationDatasets(tx, a),
    );
    expect(none).toEqual([]);
  });
  it("expires records and raw pages without exposing source data to the scheduler", async () => {
    const d = { ...definition("retention"), retentionDays: 1 };
    const r = await ingest(d, page(d));
    const future = new Date(now.getTime() + 2 * 86_400_000);
    expect(await preview(r.datasetId, a, future)).toBeNull();
    const url = new URL(test.appUrl);
    url.username = "netrics_scheduler";
    url.password = "netrics_scheduler";
    const client = postgres(url.toString(), { max: 1 });
    try {
      expect(
        await pruneDatasetHistory(
          drizzle(client, { schema: { ...schema, ...auth } }),
          future,
        ),
      ).toBeGreaterThan(0);
    } finally {
      await client.end({ timeout: 5 });
    }
    expect(await preview(r.datasetId, a, future)).toBeNull();
    expect(
      (
        await admin`select count(*)::int n from data_records where generation_id=${r.generationId}`
      )[0]?.n,
    ).toBe(0);
  });
});

it("lists more than 1,000 legacy datasets under configurable policy and scopes a single observation read", async () => {
  await admin`insert into connectors(id,version,manifest) values ('catalog-scale','1.0.0','{}')`;
  const [connection] =
    await admin`insert into connections(workspace_id,connector_id,name) values (${a},'catalog-scale','Large catalog') returning id`;
  await admin`insert into metric_definitions(connector_id,key,name,description,kind,unit,granularity,dimensions,aggregations)
    select 'catalog-scale','metric_' || n,'Metric ' || n,'Count','delta','count','day','[]','["sum"]' from generate_series(1,1005) n`;
  const rows = await withWorkspace(db, { workspaceId: a }, (tx) =>
    listObservationDatasets(tx, a, { connectionId: connection!.id }),
  );
  expect(rows).toHaveLength(1005);
  await expect(
    withWorkspace(db, { workspaceId: a }, (tx) =>
      listObservationDatasets(tx, a, {
        connectionId: connection!.id,
        limit: 1000,
      }),
    ),
  ).rejects.toThrow("dataset_catalog_limit");
  const metric = rows.at(-1)!;
  await admin`insert into observations(workspace_id,connection_id,metric_definition_id,dimensions,source_timestamp,value) values (${a},${connection!.id},${metric.metricDefinitionId},'{}','2026-11-01T00:00:00Z',7)`;
  const input = {
    workspaceId: a,
    connectionId: connection!.id,
    metricDefinitionId: metric.metricDefinitionId,
    from: new Date("2026-11-01"),
    toExclusive: new Date("2026-11-02"),
  };
  const found = await withWorkspace(db, { workspaceId: a }, (tx) =>
    readObservationDataset(tx, input),
  );
  expect(found?.rows[0]?.value).toBe(7);
  expect(
    await withWorkspace(db, { workspaceId: b }, (tx) =>
      readObservationDataset(tx, input),
    ),
  ).toBeNull();
});
