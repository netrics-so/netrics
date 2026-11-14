import { arch, cpus, platform, release, totalmem } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminSetDataPolicy,
  createDatabase,
  createRawSqlClient,
  createWorkspace,
  ingestDatasetPage,
  schema,
  upsertConnectionResources,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";
import {
  sourceDatasetSchema,
  type SourceDatasetDefinition,
} from "@netrics/contracts";
import {
  DEFAULT_DATA_POLICY,
  ProcessingBudget,
  querySemanticModel,
  type DataTable,
  type PreparationGraph,
  type SemanticModelDefinition,
} from "@netrics/domain";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "../test-db.js";
import { createDataService, type DataActor } from "./service.js";

// Explicitly opt in: this is a reproducible local workload check, not a timing
// assertion or a hardware-dependent gate in the ordinary regression suite.
const enabled = process.env.NETRICS_DATA_SCALE_CHECK === "1";
const now = new Date("2026-11-05T12:00:00Z");
const rowCount = 5_001,
  appCount = 1_300;
const measurements: Array<Record<string, unknown>> = [];
async function measure<T>(
  name: string,
  work: () => T | Promise<T>,
): Promise<T> {
  const before = process.memoryUsage(),
    start = performance.now();
  const value = await work();
  const after = process.memoryUsage();
  measurements.push({
    name,
    milliseconds: Math.round((performance.now() - start) * 100) / 100,
    rssBeforeMiB: Math.round(before.rss / 1048576),
    rssAfterMiB: Math.round(after.rss / 1048576),
    heapBeforeMiB: Math.round(before.heapUsed / 1048576),
    heapAfterMiB: Math.round(after.heapUsed / 1048576),
  });
  return value;
}
let db: Database | undefined,
  admin: Sql | undefined,
  actor: DataActor,
  connectionId: string;
let sourceId: string, firstGeneration: string;
let service: ReturnType<typeof createDataService>;
const definition: SourceDatasetDefinition = sourceDatasetSchema.parse({
  key: "scale_facts",
  name: "Synthetic scale facts",
  version: 1,
  mode: "upsert",
  grain: "one synthetic source record",
  keyFields: ["id"],
  retentionDays: null,
  fields: [
    {
      id: "id",
      name: "ID",
      type: "string",
      nullable: false,
      classification: "internal",
    },
    {
      id: "app",
      name: "App",
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
      unit: "currency",
      currencyField: "currency",
      scale: 2,
    },
    {
      id: "currency",
      name: "Currency",
      type: "string",
      nullable: false,
      classification: "internal",
    },
  ],
});
const record = (index: number, amount = "0.10") => ({
  values: {
    id: "record-" + index,
    app: "app-" + (index % appCount),
    amount,
    currency: "EUR",
  },
});

beforeAll(async () => {
  if (!enabled) return;
  const test = await createTestDatabase();
  db = createDatabase(test.appUrl, { max: 2 });
  admin = createRawSqlClient(test.adminUrl, { max: 1 });
  const [user] = await db
    .insert(schema.users)
    .values({ email: "scale-check@example.test", displayName: "Scale fixture" })
    .returning();
  const workspaceId = await createWorkspace(db, {
    name: "Scale check",
    ownerUserId: user!.id,
  });
  actor = { workspaceId, callerId: user!.id };
  await admin`insert into connectors(id,version,manifest) values ('scale-fixture','1.0.0','{}')`;
  const [connection] = await withWorkspace(db, { workspaceId }, (tx) =>
    tx
      .insert(schema.connections)
      .values({
        workspaceId,
        connectorId: "scale-fixture",
        name: "Synthetic scale connection",
      })
      .returning(),
  );
  connectionId = connection!.id;
  service = createDataService(db, () => now);
}, TEST_DATABASE_SETUP_TIMEOUT_MS);
afterAll(async () => {
  if (!enabled) return;
  const [database] =
    await admin!`select current_setting('server_version') as version`;
  console.log(
    "NETRICS_DATA_SCALE_RESULT " +
      JSON.stringify({
        environment: {
          node: process.version,
          platform: platform(),
          release: release(),
          arch: arch(),
          cpu: cpus()[0]?.model,
          memoryGiB: Math.round(totalmem() / 1073741824),
          postgres: database!.version,
        },
        measurements,
      }),
  );
  await db?.$client.end({ timeout: 5 });
  await admin?.end({ timeout: 5 });
});

describe.runIf(enabled)("representative data workload validation", () => {
  it("retains all pages and app identities, publishes a joined/grouped model, and copies a correction without duplication", async () => {
    await measure("ingest_5001_records_in_6_pages", async () => {
      for (
        let offset = 0, page = 0;
        offset < rowCount;
        offset += 1000, page++
      ) {
        const result = await withWorkspace(
          db!,
          { workspaceId: actor.workspaceId },
          (tx) =>
            ingestDatasetPage(tx, {
              workspaceId: actor.workspaceId,
              connectionId,
              definition,
              page: {
                datasetKey: definition.key,
                schemaVersion: 1,
                refreshKey: "initial",
                pageKey: "page-" + page,
                previousPageKey: page ? "page-" + (page - 1) : null,
                complete: offset + 1000 >= rowCount,
                records: Array.from(
                  { length: Math.min(1000, rowCount - offset) },
                  (_, index) => record(offset + index),
                ),
              },
              now,
            }),
        );
        sourceId = result.datasetId;
        if (offset + 1000 < rowCount) expect(result.generationId).toBeNull();
        else firstGeneration = result.generationId!;
      }
    });
    await measure("upsert_and_load_1300_resource_names", async () => {
      await withWorkspace(db!, { workspaceId: actor.workspaceId }, (tx) =>
        upsertConnectionResources(tx, {
          workspaceId: actor.workspaceId,
          connectionId,
          now,
          resources: Array.from({ length: appCount }, (_, index) => ({
            id: "app-" + index,
            name: "App " + index,
            kind: "app",
          })),
        }),
      );
      const source = (await service.listSources(actor)).sources.find(
        (source) => source.id === "resources:" + connectionId,
      )!;
      expect(source.rowCount).toBe(appCount);
    });
    const graph: PreparationGraph = {
      version: 1,
      nodes: [
        { id: "facts", type: "source", datasetId: sourceId },
        { id: "apps", type: "source", datasetId: "resources:" + connectionId },
        {
          id: "join",
          type: "join",
          left: "facts",
          right: "apps",
          keys: [{ left: "app", right: "resource_id" }],
          cardinality: "many_to_one",
          mode: "left",
          rightPrefix: "resource.",
        },
        {
          id: "flag",
          type: "calculate",
          input: "join",
          fieldId: "mapped",
          name: "Mapped",
          expression: {
            kind: "call",
            fn: "not",
            args: [
              {
                kind: "call",
                fn: "is_null",
                args: [{ kind: "field", fieldId: "resource.name" }],
              },
            ],
          },
        },
        {
          id: "group",
          type: "group",
          input: "flag",
          keys: ["app", "resource.name", "currency"],
          aggregates: [
            { id: "amount", name: "Amount", op: "sum", fieldId: "amount" },
            { id: "records", name: "Records", op: "count" },
            { id: "mapped", name: "Mapped", op: "all", fieldId: "mapped" },
          ],
        },
      ],
      outputs: ["group"],
    };
    const published = await measure(
      "publish_preparation_and_model",
      async () => {
        const prep = await service.savePreparation(actor, {
          name: "Joined apps",
          graph,
        });
        await service.publishPreparation(
          actor,
          prep.preparation.id,
          prep.preparation.version,
        );
        const output = `prepared:${prep.preparation.id}:group`;
        const model: SemanticModelDefinition = {
          version: 1,
          datasets: [output],
          relationships: [],
          dimensions: [
            {
              id: "app",
              name: "App",
              datasetId: output,
              fieldId: "app",
              labelFieldId: "resource.name",
            },
          ],
          measures: [
            {
              id: "amount",
              name: "Amount",
              kind: "aggregate",
              datasetId: output,
              aggregate: {
                id: "amount",
                name: "Amount",
                op: "sum",
                fieldId: "amount",
              },
            },
            {
              id: "records",
              name: "Records",
              kind: "aggregate",
              datasetId: output,
              aggregate: {
                id: "records",
                name: "Records",
                op: "sum",
                fieldId: "records",
              },
            },
            {
              id: "mapped",
              name: "Mapped",
              kind: "aggregate",
              datasetId: output,
              aggregate: {
                id: "mapped",
                name: "Mapped",
                op: "all",
                fieldId: "mapped",
              },
            },
          ],
        };
        const saved = await service.saveModel(actor, {
          name: "Scale totals",
          definition: model,
        });
        await service.publishModel(actor, saved.model.id, saved.model.version);
        return saved.model.id;
      },
    );
    const query = { measureIds: ["amount", "records", "mapped"], groupBy: [] };
    const first = await measure(
      "first_model_query_prepared_cache_available",
      () => service.query(actor, published, query),
    );
    expect(first.rows[0]!.measures).toMatchObject({
      amount: { value: "500.1", currency: "EUR" },
      records: { value: "5001" },
      mapped: { value: true },
    });
    expect(first.provenance).toContainEqual({
      datasetId: sourceId,
      generationId: firstGeneration,
    });
    const second = await measure("repeat_model_query", () =>
      service.query(actor, published, query),
    );
    expect(second.rows).toEqual(first.rows);
    const grouped = await measure("grouped_model_query_1300_identities", () =>
      service.query(actor, published, {
        ...query,
        groupBy: ["app"],
        limit: 1000,
      }),
    );
    expect(grouped.totalRows).toBe(appCount);
    expect(grouped.rows).toHaveLength(1000);
    expect(
      grouped.rows.every((row) => row.dimensionLabels?.app?.startsWith("App ")),
    ).toBe(true);
    const lastPage = await measure(
      "grouped_model_query_remaining_300_identities",
      () =>
        service.query(actor, published, {
          ...query,
          groupBy: ["app"],
          limit: 1000,
          offset: 1000,
        }),
    );
    expect(lastPage.rows).toHaveLength(300);
    expect(
      new Set(
        [...grouped.rows, ...lastPage.rows].map((row) => row.dimensions.app),
      ).size,
    ).toBe(appCount);
    expect(lastPage.provenance).toEqual(grouped.provenance);
    const corrected = await measure(
      "single_row_upsert_copies_5001_record_generation",
      () =>
        withWorkspace(db!, { workspaceId: actor.workspaceId }, (tx) =>
          ingestDatasetPage(tx, {
            workspaceId: actor.workspaceId,
            connectionId,
            definition,
            page: {
              datasetKey: definition.key,
              schemaVersion: 1,
              refreshKey: "correction",
              pageKey: "page-0",
              previousPageKey: null,
              complete: true,
              records: [record(0, "0.30")],
            },
            now,
          }),
        ),
    );
    const after = await measure("query_after_correction", () =>
      service.query(actor, published, query),
    );
    expect(after.rows[0]!.measures.amount).toMatchObject({
      value: "500.3",
      currency: "EUR",
    });
    expect(after.provenance).toContainEqual({
      datasetId: sourceId,
      generationId: corrected.generationId,
    });
    expect(after.provenance).not.toContainEqual({
      datasetId: sourceId,
      generationId: firstGeneration,
    });
    const [storage] =
      await admin!`select (select count(*)::int from data_generations where dataset_id=${sourceId}) as generations, (select count(*)::int from data_records where generation_id in (select id from data_generations where dataset_id=${sourceId})) as retained_records, (select count(*)::int from data_pages where workspace_id=${actor.workspaceId}) as staged_pages, pg_total_relation_size('data_records')::text as records_relation_bytes, pg_total_relation_size('data_pages')::text as pages_relation_bytes, pg_total_relation_size('data_prepared_generations')::text as prepared_relation_bytes, pg_database_size(current_database())::text as database_bytes`;
    expect(storage).toMatchObject({
      generations: 2,
      retained_records: 10002,
      staged_pages: 7,
    });
    measurements.push({ name: "database_after_correction", ...storage });
    await adminSetDataPolicy(db!, actor.workspaceId, { queryRows: 1000 });
    await expect(service.query(actor, published, query)).rejects.toThrow(
      "data_source_row_limit",
    );
    await adminSetDataPolicy(db!, actor.workspaceId, { queryRows: null });
    expect((await service.query(actor, published, query)).rows).toEqual(
      after.rows,
    );
  }, 60_000);

  it("rejects the default row budget and processes more rows with explicit uncapped policy", async () => {
    const count = DEFAULT_DATA_POLICY.queryRows! + 1;
    const table: DataTable = {
      fields: [
        { id: "app", name: "App", type: "string", nullable: false },
        { id: "amount", name: "Amount", type: "decimal", nullable: false },
      ],
      rows: Array.from({ length: count }, (_, index) => ({
        app: "app-" + (index % appCount),
        amount: "0.10",
      })),
      provenance: [
        { datasetId: "synthetic", generationId: "retained-fixture" },
      ],
    };
    const model: SemanticModelDefinition = {
      version: 1,
      datasets: ["facts"],
      relationships: [],
      dimensions: [],
      measures: [
        {
          id: "amount",
          name: "Amount",
          kind: "aggregate",
          datasetId: "facts",
          aggregate: {
            id: "amount",
            name: "Amount",
            op: "sum",
            fieldId: "amount",
          },
        },
      ],
    };
    const query = { measureIds: ["amount"], groupBy: [] };
    const sources = new Map([["facts", table]]);
    expect(() => querySemanticModel(model, sources, query)).toThrow(
      "data_row_limit",
    );
    const result = await measure("uncapped_in_memory_query_100001_rows", () =>
      querySemanticModel(
        model,
        sources,
        query,
        new ProcessingBudget(null, { rows: null, outputBytes: null }),
      ),
    );
    expect(result.rows[0]!.measures.amount!.value).toBe("10000.1");
    expect(result.provenance).toEqual(table.provenance);
    expect(() =>
      querySemanticModel(
        model,
        sources,
        query,
        new ProcessingBudget(10, { rows: null }),
      ),
    ).toThrow("processing_budget_exceeded");
    measurements.push({
      name: "uncapped_query_operations",
      rows: count,
      operations: result.operations,
    });
  }, 60_000);
});
