import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminSetDataPolicy,
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";
import { sourceDatasetSchema } from "@netrics/contracts";
import {
  DEFAULT_DATA_POLICY,
  type DataPolicy,
  type SemanticModelDefinition,
} from "@netrics/domain";
import { createTestDatabase } from "../test-db.js";
import {
  createDataService,
  type DataActor,
  type DataModelQuery,
} from "./service.js";

const NOW = new Date("2026-11-05T12:00:00Z");
const query = { measureIds: ["amount"], groupBy: ["id"], limit: 1 };
const definition = sourceDatasetSchema.parse({
  key: "numbers",
  name: "Numbers",
  version: 1,
  mode: "snapshot",
  grain: "One number",
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
      id: "amount",
      name: "Amount",
      type: "decimal",
      nullable: false,
      classification: "internal",
    },
  ],
});
let db: Database, admin: Sql, callerId: string;
beforeAll(async () => {
  const test = await createTestDatabase();
  db = createDatabase(test.appUrl);
  admin = createRawSqlClient(test.adminUrl, { max: 1 });
  const [user] =
    await admin`insert into users(email,display_name) values ('pagination@example.com','Owner') returning id`;
  callerId = user!.id as string;
  await admin`insert into connectors(id,version,manifest) values ('pagination-fixture','1.0.0','{}')`;
}, 60_000);
afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
  await admin?.end({ timeout: 5 });
});

async function fixture(nested = false, defaults: Partial<DataPolicy> = {}) {
  const [workspace] =
    await admin`insert into workspaces(name) values ('Pagination') returning id`;
  const actor: DataActor = { workspaceId: workspace!.id as string, callerId };
  let now = NOW;
  const service = createDataService(db, () => now, {
    ...DEFAULT_DATA_POLICY,
    ...defaults,
  });
  const records = ["a", "b", "c", "d"].map((id, index) => ({
    values: { id, amount: String(index + 1) },
  }));
  const source = await service.saveManual(actor, { definition, records });
  let datasetId = source.datasetId;
  for (let i = 0; i < (nested ? 2 : 0); i++) {
    const prep = await service.savePreparation(actor, {
      name: "Pass through " + i,
      graph: {
        version: 1,
        nodes: [{ id: "source", type: "source", datasetId }],
        outputs: ["source"],
      },
    });
    await service.publishPreparation(actor, prep.preparation.id, 1);
    datasetId = "prepared:" + prep.preparation.id + ":source";
  }
  const modelDefinition: SemanticModelDefinition = {
    version: 1,
    datasets: [datasetId],
    relationships: [],
    dimensions: [{ id: "id", name: "ID", datasetId, fieldId: "id" }],
    measures: [
      {
        id: "amount",
        name: "Amount",
        kind: "aggregate",
        datasetId,
        aggregate: {
          id: "amount",
          name: "Amount",
          op: "sum",
          fieldId: "amount",
        },
      },
    ],
  };
  const { model } = await service.saveModel(actor, {
    name: "Numbers",
    definition: modelDefinition,
  });
  await service.publishModel(actor, model.id, 1);
  return {
    actor,
    service,
    source,
    records,
    model,
    modelDefinition,
    advance: (milliseconds: number) => {
      now = new Date(NOW.getTime() + milliseconds);
    },
    read: (input: DataModelQuery = { ...query, pinPages: true }) =>
      service.query(actor, model.id, input),
  };
}

describe("immutable semantic result pagination", () => {
  it("retains the original release and complete source vector across corrections, new sessions and publication", async () => {
    const f = await fixture();
    const first = await f.read();
    expect(first.nextPageToken).toBeDefined();
    expect(first.rows[0]).toMatchObject({
      dimensions: { id: "a" },
      measures: { amount: { value: "1" } },
    });
    await f.service.saveManual(
      f.actor,
      {
        definition,
        generationId: f.source.generationId,
        records: [
          { values: { id: "aa", amount: "99" } },
          ...f.records.map((record) => ({
            values: { ...record.values, amount: "90" },
          })),
        ],
      },
      f.source.datasetId,
    );
    const updated = await f.service.saveModel(
      f.actor,
      {
        name: "New definition",
        version: 1,
        definition: {
          ...f.modelDefinition,
          measures: [
            {
              ...f.modelDefinition.measures[0]!,
              kind: "aggregate",
              datasetId: f.source.datasetId,
              aggregate: {
                id: "amount",
                name: "Count",
                op: "count",
                fieldId: "amount",
              },
            },
          ],
        },
      },
      f.model.id,
    );
    await f.service.publishModel(f.actor, f.model.id, updated.model.version);
    const current = await f.read({ ...query, offset: 1, pinPages: true });
    expect(current.releaseId).not.toBe(first.releaseId);
    expect(current.rows[0]).toMatchObject({
      dimensions: { id: "aa" },
      measures: { amount: { value: 1 } },
    });
    const second = await f.read({ ...query, pageToken: first.nextPageToken! });
    expect(second).toMatchObject({
      releaseId: first.releaseId,
      provenance: first.provenance,
      totalRows: 4,
      offset: 1,
      stale: false,
    });
    expect(second.rows[0]).toMatchObject({
      dimensions: { id: "b" },
      measures: { amount: { value: "2" } },
    });
    const replay = await f.read({ ...query, pageToken: first.nextPageToken! });
    expect(replay.rows).toEqual(second.rows);
    const third = await f.read({ ...query, pageToken: second.nextPageToken! });
    const last = await f.read({ ...query, pageToken: third.nextPageToken! });
    expect(last.rows[0]?.dimensions.id).toBe("d");
    expect(last.nextPageToken).toBeUndefined();
    expect(last.provenance).toEqual(first.provenance);
  });

  it("requires opt-in and does not allocate page sessions for repeated truncated dashboard-style queries", async () => {
    const f = await fixture();
    for (let i = 0; i < 8; i++) {
      const result = await f.read(query);
      expect(result.totalRows).toBe(4);
      expect(result.nextPageToken).toBeUndefined();
    }
    const cached =
      await admin`select query_key from data_model_query_snapshots where workspace_id=${f.actor.workspaceId}`;
    expect(cached).toHaveLength(1);
    expect(cached[0]!.query_key).not.toMatch(/^page:/);
    expect((await f.read({ ...query, offset: 2 })).rows[0]?.dimensions.id).toBe(
      "c",
    );
  });

  it("binds query, page size, scope, model and workspace, and rejects malformed or conflicting continuations", async () => {
    const f = await fixture();
    const first = await f.read();
    const pageToken = first.nextPageToken!;
    for (const changed of [
      { ...query, limit: 2 },
      { ...query, groupBy: [] },
      { ...query, measureIds: ["different"] },
      {
        ...query,
        filter: { kind: "literal", type: "boolean", value: true } as const,
      },
    ])
      await expect(f.read({ ...changed, pageToken })).rejects.toThrow(
        "data_page_unavailable",
      );
    await expect(f.read({ ...query, pageToken, offset: 1 })).rejects.toThrow(
      "data_page_offset_conflict",
    );
    await expect(f.read({ ...query, pageToken: "bogus" })).rejects.toThrow(
      "data_page_invalid",
    );
    await expect(
      f.service.query(f.actor, f.model.id, { ...query, pageToken }, true),
    ).rejects.toThrow("data_page_preview_unsupported");
    await expect(
      f.service.previewModel(f.actor, f.modelDefinition, {
        ...query,
        pinPages: true,
      }),
    ).rejects.toThrow("data_page_preview_unsupported");
    const other = await fixture();
    await expect(
      other.service.query(other.actor, f.model.id, { ...query, pageToken }),
    ).rejects.toThrow("data_model_not_found");
    const another = await f.service.saveModel(f.actor, {
      name: "Another",
      definition: f.modelDefinition,
    });
    await f.service.publishModel(f.actor, another.model.id, 1);
    await expect(
      f.service.query(f.actor, another.model.id, { ...query, pageToken }),
    ).rejects.toThrow("data_page_unavailable");
    const guessed = pageToken.split(":");
    guessed[1] = randomUUID();
    await expect(
      f.read({ ...query, pageToken: guessed.join(":") }),
    ).rejects.toThrow("data_page_unavailable");
  });

  it("pins nested prepared outputs and fails if their immutable cache is removed", async () => {
    const f = await fixture(true);
    const first = await f.read();
    expect(
      first.provenance.filter((p) => p.datasetId.startsWith("prepared:")),
    ).toHaveLength(2);
    await f.service.saveManual(
      f.actor,
      {
        definition,
        generationId: f.source.generationId,
        records: f.records.map((record) => ({
          values: { ...record.values, amount: "500" },
        })),
      },
      f.source.datasetId,
    );
    // A fresh query builds different caches; it cannot overwrite the session's identities.
    await f.read(query);
    const second = await f.read({ ...query, pageToken: first.nextPageToken! });
    expect(second.rows[0]?.measures.amount?.value).toBe("2");
    expect(second.provenance).toEqual(first.provenance);
    const cached = first.provenance.find((p) =>
      p.datasetId.startsWith("prepared:"),
    )!;
    await admin`delete from data_prepared_generations where id=${cached.generationId}`;
    await expect(
      f.read({ ...query, pageToken: first.nextPageToken! }),
    ).rejects.toThrow("data_page_unavailable");
  });

  it("rebuilds expired matching prepared caches while keeping old page sessions unavailable", async () => {
    const f = await fixture(true, { preparedCacheSeconds: 5 });
    const sibling = await f.service.savePreparation(f.actor, {
      name: "Unused preparation",
      graph: {
        version: 1,
        nodes: [
          { id: "source", type: "source", datasetId: f.source.datasetId },
        ],
        outputs: ["source"],
      },
    });
    await f.service.publishPreparation(f.actor, sibling.preparation.id, 1);
    const siblingCache =
      await admin`select id from data_prepared_generations where preparation_id=${sibling.preparation.id}`;
    const first = await f.read();
    expect(first.pageExpiresAt).toBe(
      new Date(NOW.getTime() + 5_000).toISOString(),
    );
    const oldPrepared = first.provenance.filter((p) =>
      p.datasetId.startsWith("prepared:"),
    );
    f.advance(6_000);
    await expect(
      f.read({ ...query, pageToken: first.nextPageToken! }),
    ).rejects.toThrow("data_page_unavailable");
    const rebuilt = await f.read(query);
    expect(rebuilt.rows).toEqual(first.rows);
    expect(rebuilt.provenance).toContainEqual({
      datasetId: f.source.datasetId,
      generationId: f.source.generationId,
    });
    for (const old of oldPrepared)
      expect(rebuilt.provenance).not.toContainEqual(old);
    expect(
      await admin`select id from data_prepared_generations where preparation_id=${sibling.preparation.id}`,
    ).toEqual(siblingCache);
    const pinned = await f.read();
    expect(pinned.nextPageToken).toBeDefined();
    expect(pinned.pageExpiresAt).toBe(
      new Date(NOW.getTime() + 11_000).toISOString(),
    );
    await expect(
      f.read({ ...query, pageToken: first.nextPageToken! }),
    ).rejects.toThrow("data_page_unavailable");
  });

  it("does not issue immutable tokens for unretained prepared outputs when cache capacity can later change", async () => {
    const f = await fixture(true, { maxPreparedBytes: 1 });
    const first = await f.read();
    expect(first.rows).toHaveLength(1);
    expect(
      first.provenance.some((p) => p.datasetId.startsWith("prepared:")),
    ).toBe(false);
    expect(first.warnings).toContain("prepared_cache_capacity_reached");
    expect(first.warnings).toContain("immutable_pagination_unavailable");
    expect(first.nextPageToken).toBeUndefined();
    expect(
      await admin`select id from data_prepared_generations where workspace_id=${f.actor.workspaceId}`,
    ).toHaveLength(0);
    await adminSetDataPolicy(db, f.actor.workspaceId, {
      maxPreparedBytes: null,
    });
    const retained = await f.read();
    expect(retained.rows).toEqual(first.rows);
    expect(
      retained.provenance.filter((p) => p.datasetId.startsWith("prepared:")),
    ).toHaveLength(2);
    expect(retained.nextPageToken).toBeDefined();
    const second = await f.read({
      ...query,
      pageToken: retained.nextPageToken!,
    });
    expect(second.provenance).toEqual(retained.provenance);
    expect(second.rows[0]?.dimensions.id).toBe("b");
  });

  it("rejects continuations when non-retained resource names or legacy observations change", async () => {
    for (const kind of ["resources", "observations"] as const) {
      const f = await fixture();
      const [connection] =
        await admin`insert into connections(workspace_id,connector_id,name) values (${f.actor.workspaceId},'pagination-fixture','Adapter') returning id`;
      const connectionId = connection!.id as string;
      let datasetId: string, idField: string, valueField: string;
      if (kind === "resources") {
        for (const id of ["a", "b", "c"])
          await admin`insert into connection_resources(workspace_id,connection_id,resource_id,name,kind) values (${f.actor.workspaceId},${connectionId},${id},${"App " + id},'app')`;
        datasetId = "resources:" + connectionId;
        idField = "resource_id";
        valueField = "resource_id";
      } else {
        const [metric] =
          await admin`insert into metric_definitions(connector_id,key,name,description,kind,unit,granularity,dimensions,aggregations) values ('pagination-fixture',${"number_" + randomUUID()},'Number','','delta','count','day','[]','["sum"]') returning id`;
        const metricId = metric!.id as string;
        for (const day of [1, 2, 3])
          await admin`insert into observations(workspace_id,connection_id,metric_definition_id,source_timestamp,value) values (${f.actor.workspaceId},${connectionId},${metricId},${new Date(NOW.getTime() - day * 86_400_000)},${day})`;
        datasetId = "observation:" + connectionId + ":" + metricId;
        idField = "time";
        valueField = "value";
      }
      const model = await f.service.saveModel(f.actor, {
        name: "Adapter",
        definition: {
          version: 1,
          datasets: [datasetId],
          relationships: [],
          dimensions: [
            {
              id: "id",
              name: "ID",
              datasetId,
              fieldId: idField,
              ...(kind === "observations"
                ? { timeAlignment: "reporting_date" as const }
                : {}),
            },
          ],
          measures: [
            {
              id: "amount",
              name: "Amount",
              kind: "aggregate",
              datasetId,
              aggregate: {
                id: "amount",
                name: "Amount",
                op: kind === "resources" ? "count" : "sum",
                fieldId: valueField,
              },
            },
          ],
        },
      });
      await f.service.publishModel(f.actor, model.model.id, 1);
      const first = await f.service.query(f.actor, model.model.id, {
        ...query,
        pinPages: true,
      });
      const second = await f.service.query(f.actor, model.model.id, {
        ...query,
        pageToken: first.nextPageToken!,
      });
      expect(second.provenance).toEqual(first.provenance);
      if (kind === "resources")
        await admin`update connection_resources set name='Changed' where connection_id=${connectionId} and resource_id='c'`;
      else
        await admin`update observations set value=42 where connection_id=${connectionId}`;
      await expect(
        f.service.query(f.actor, model.model.id, {
          ...query,
          pageToken: first.nextPageToken!,
        }),
      ).rejects.toThrow("data_page_unavailable");
    }
  });

  it("never substitutes current data after retained rows expire or sources are removed", async () => {
    const f = await fixture();
    const first = await f.read();
    await f.service.saveManual(
      f.actor,
      { definition, generationId: f.source.generationId, records: f.records },
      f.source.datasetId,
    );
    await admin`update data_records set expires_at=${NOW} where generation_id=${f.source.generationId} and record_key=(select min(record_key) from data_records where generation_id=${f.source.generationId})`;
    await expect(
      f.read({ ...query, pageToken: first.nextPageToken! }),
    ).rejects.toThrow("data_page_unavailable");
    await admin`delete from data_datasets where id=${f.source.datasetId}`;
    await expect(
      f.read({ ...query, pageToken: first.nextPageToken! }),
    ).rejects.toThrow("data_page_unavailable");
    await expect(f.read()).rejects.toThrow("data_source_not_found");
  });

  it("does not renew expiry and obeys shortened or disabled snapshot policies", async () => {
    const f = await fixture();
    await adminSetDataPolicy(db, f.actor.workspaceId, {
      querySnapshotSeconds: 60,
    });
    const first = await f.read();
    expect(first.pageExpiresAt).toBe(
      new Date(NOW.getTime() + 60_000).toISOString(),
    );
    f.advance(30_000);
    const second = await f.read({ ...query, pageToken: first.nextPageToken! });
    expect(second.pageExpiresAt).toBe(first.pageExpiresAt);
    await adminSetDataPolicy(db, f.actor.workspaceId, {
      querySnapshotSeconds: 20,
    });
    await expect(
      f.read({ ...query, pageToken: first.nextPageToken! }),
    ).rejects.toThrow("data_page_unavailable");
    await adminSetDataPolicy(db, f.actor.workspaceId, {
      querySnapshotSeconds: 60,
    });
    f.advance(61_000);
    await expect(
      f.read({ ...query, pageToken: first.nextPageToken! }),
    ).rejects.toThrow("data_page_unavailable");
    f.advance(0);
    await adminSetDataPolicy(db, f.actor.workspaceId, {
      querySnapshotCount: 0,
    });
    await expect(
      f.read({ ...query, pageToken: first.nextPageToken! }),
    ).rejects.toThrow("data_page_unavailable");
    const disabled = await f.read();
    expect(disabled.nextPageToken).toBeUndefined();
    expect(disabled.warnings).toContain("immutable_pagination_unavailable");
  });

  it("bounds page-session count without evicting or mutating an existing session", async () => {
    const f = await fixture();
    await adminSetDataPolicy(db, f.actor.workspaceId, {
      querySnapshotCount: 1,
    });
    const first = await f.read();
    expect(first.nextPageToken).toBeDefined();
    const denied = await f.read();
    expect(denied.nextPageToken).toBeUndefined();
    expect(denied.warnings).toContain("immutable_pagination_unavailable");
    const stored =
      await admin`select query_key from data_model_query_snapshots where workspace_id=${f.actor.workspaceId} and query_key like 'page:%'`;
    expect(stored).toHaveLength(1);
    expect(
      (await f.read({ ...query, pageToken: first.nextPageToken! })).rows[0]
        ?.dimensions.id,
    ).toBe("b");
    await admin`delete from data_model_query_snapshots where workspace_id=${f.actor.workspaceId}`;
    await expect(
      f.read({ ...query, pageToken: first.nextPageToken! }),
    ).rejects.toThrow("data_page_unavailable");
  });

  it("keeps last-valid snapshot capacity for ordinary queries when page sessions are full", async () => {
    const f = await fixture();
    await adminSetDataPolicy(db, f.actor.workspaceId, {
      querySnapshotCount: 2,
    });
    // Two distinct pinned queries fill session capacity.
    expect((await f.read()).nextPageToken).toBeDefined();
    expect(
      (await f.read({ ...query, limit: 2, pinPages: true })).nextPageToken,
    ).toBeDefined();
    const denied = await f.read({ ...query, limit: 3, pinPages: true });
    expect(denied.nextPageToken).toBeUndefined();
    expect(denied.warnings).toContain("immutable_pagination_unavailable");
    const [counts] =
      await admin`select count(*) filter (where query_key like 'page:%')::int as sessions, count(*) filter (where query_key not like 'page:%')::int as snapshots from data_model_query_snapshots where workspace_id=${f.actor.workspaceId}`;
    expect(counts!.sessions).toBe(2);
    // Ordinary snapshots stay admitted up to their own capacity.
    expect(counts!.snapshots).toBe(2);
  });

  it("clamps very long snapshot lifetimes instead of failing", async () => {
    const f = await fixture();
    await adminSetDataPolicy(db, f.actor.workspaceId, {
      querySnapshotSeconds: Number.MAX_SAFE_INTEGER,
    });
    const first = await f.read();
    expect(first.pageExpiresAt).toBe("9999-12-31T23:59:59.000Z");
    expect(
      (await f.read({ ...query, pageToken: first.nextPageToken! })).rows[0]
        ?.dimensions.id,
    ).toBe("b");
  });

  it("cannot restore access after retention policy removes the retained inputs", async () => {
    const f = await fixture();
    const first = await f.read();
    await adminSetDataPolicy(db, f.actor.workspaceId, { maxRetentionDays: 1 });
    await adminSetDataPolicy(db, f.actor.workspaceId, {});
    await expect(
      f.read({ ...query, pageToken: first.nextPageToken! }),
    ).rejects.toThrow("data_page_unavailable");
    const uncached = createDataService(db, () => NOW, {
      ...DEFAULT_DATA_POLICY,
      querySnapshotSeconds: 0,
    });
    expect(
      (await uncached.query(f.actor, f.model.id, { ...query, pinPages: true }))
        .nextPageToken,
    ).toBeUndefined();
  });

  it("reclaims expired session capacity immediately and preserves another workspace's active session", async () => {
    const f = await fixture();
    await adminSetDataPolicy(db, f.actor.workspaceId, {
      querySnapshotCount: 1,
      querySnapshotSeconds: 10,
    });
    const first = await f.read();
    f.advance(5_000);
    const continued = await f.read({
      ...query,
      pageToken: first.nextPageToken!,
    });
    expect(continued.pageExpiresAt).toBe(first.pageExpiresAt);
    const denied = await f.read();
    expect(denied.nextPageToken).toBeUndefined();
    f.advance(11_000);
    const replacement = await f.read();
    expect(replacement.nextPageToken).toBeDefined();
    expect(replacement.nextPageToken).not.toBe(first.nextPageToken);
    expect(replacement.pageExpiresAt).toBe(
      new Date(NOW.getTime() + 21_000).toISOString(),
    );
    await expect(
      f.read({ ...query, pageToken: first.nextPageToken! }),
    ).rejects.toThrow("data_page_unavailable");
    const stored =
      await admin`select query_key from data_model_query_snapshots where workspace_id=${f.actor.workspaceId} and query_key like 'page:%'`;
    expect(stored).toHaveLength(1);
    const other = await fixture();
    const active = await other.read();
    f.advance(22_000);
    await f.read();
    expect(
      (await other.read({ ...query, pageToken: active.nextPageToken! })).rows[0]
        ?.dimensions.id,
    ).toBe("b");
  });

  it("reclaims capacity using the shortened current lifetime without extending existing deadlines", async () => {
    const f = await fixture();
    await adminSetDataPolicy(db, f.actor.workspaceId, {
      querySnapshotCount: 1,
      querySnapshotSeconds: 60,
    });
    const first = await f.read();
    await adminSetDataPolicy(db, f.actor.workspaceId, {
      querySnapshotCount: 1,
      querySnapshotSeconds: 5,
    });
    f.advance(6_000);
    const replacement = await f.read();
    expect(replacement.nextPageToken).toBeDefined();
    expect(replacement.pageExpiresAt).toBe(
      new Date(NOW.getTime() + 11_000).toISOString(),
    );
    await expect(
      f.read({ ...query, pageToken: first.nextPageToken! }),
    ).rejects.toThrow("data_page_unavailable");
    f.advance(7_000);
    const second = await f.read({
      ...query,
      pageToken: replacement.nextPageToken!,
    });
    expect(second.pageExpiresAt).toBe(replacement.pageExpiresAt);
  });

  it("applies disabled and shortened snapshot policy to last-valid fallback too", async () => {
    const f = await fixture();
    const mappingDefinition = sourceDatasetSchema.parse({
      ...definition,
      key: "mapping",
      fields: [
        definition.fields[0]!,
        { ...definition.fields[0]!, id: "match", name: "Match" },
      ],
    });
    const mapping = await f.service.saveManual(f.actor, {
      definition: mappingDefinition,
      records: ["a", "b", "c", "d"].map((id) => ({
        values: { id, match: id },
      })),
    });
    const model = await f.service.saveModel(f.actor, {
      name: "Mapped",
      definition: {
        ...f.modelDefinition,
        datasets: [f.source.datasetId, mapping.datasetId],
        relationships: [
          {
            id: "mapping",
            from: { datasetId: f.source.datasetId, fieldId: "id" },
            to: { datasetId: mapping.datasetId, fieldId: "match" },
            cardinality: "many_to_one",
          },
        ],
        dimensions: [
          {
            id: "id",
            name: "ID",
            datasetId: mapping.datasetId,
            fieldId: "match",
          },
        ],
      },
    });
    await f.service.publishModel(f.actor, model.model.id, 1);
    await f.service.query(f.actor, model.model.id, query);
    await f.service.saveManual(
      f.actor,
      {
        definition: mappingDefinition,
        generationId: mapping.generationId,
        records: [
          { values: { id: "one", match: "a" } },
          { values: { id: "two", match: "a" } },
        ],
      },
      mapping.datasetId,
    );
    f.advance(30_000);
    expect((await f.service.query(f.actor, model.model.id, query)).stale).toBe(
      true,
    );
    await adminSetDataPolicy(db, f.actor.workspaceId, {
      querySnapshotSeconds: 20,
    });
    await expect(
      f.service.query(f.actor, model.model.id, query),
    ).rejects.toThrow("model_relationship_cardinality_violation");
    await adminSetDataPolicy(db, f.actor.workspaceId, {
      querySnapshotCount: 0,
    });
    await expect(
      f.service.query(f.actor, model.model.id, query),
    ).rejects.toThrow("model_relationship_cardinality_violation");
    await adminSetDataPolicy(db, f.actor.workspaceId, {
      querySnapshotSeconds: 0,
    });
    await expect(
      f.service.query(f.actor, model.model.id, query),
    ).rejects.toThrow("model_relationship_cardinality_violation");
  });

  it("refuses to create an immutable session while a model input is still pending", async () => {
    const f = await fixture();
    const pending = await f.service.saveManualPage(f.actor, {
      definition: { ...definition, key: "pending" },
      generationId: null,
      refreshId: randomUUID(),
      page: 0,
      complete: false,
      records: [],
    });
    const model = await f.service.saveModel(f.actor, {
      name: "Pending input",
      definition: {
        ...f.modelDefinition,
        datasets: [f.source.datasetId, pending.datasetId],
      },
    });
    await f.service.publishModel(f.actor, model.model.id, 1);
    const result = await f.service.query(f.actor, model.model.id, {
      ...query,
      pinPages: true,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.nextPageToken).toBeUndefined();
    expect(result.warnings).toContain("immutable_pagination_unavailable");
  });
});
