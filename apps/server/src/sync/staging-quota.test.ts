import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminSetDataPolicy,
  connectorStageProvenance,
  createDatabase,
  createRawSqlClient,
  ingestDatasetPage,
  schema,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";
import {
  sourceDatasetSchema,
  type ConnectorManifest,
  type ConnectorRuntime,
  type DatasetPage,
  type SyncResult,
} from "@netrics/connector-sdk";
import { createGooglePlayConnector } from "@netrics/connectors";
import { createTestDatabase } from "../test-db.js";
import { createDatasetStaging } from "./staging.js";
import {
  ALPHA,
  BETA,
  fakePlay,
  TEST_BUCKET,
  TEST_NOW,
} from "../../../../packages/connectors/src/google-play/test-helpers.js";

const NOW = new Date(TEST_NOW);
let db: Database, owner: Sql;
const connector = createGooglePlayConnector({ now: () => TEST_NOW });
const retainedDefinition = sourceDatasetSchema.parse({
  key: "cache_budget_fixture",
  name: "Cache budget fixture",
  version: 1,
  mode: "snapshot",
  grain: "One retained row",
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
      id: "payload",
      name: "Payload",
      type: "string",
      nullable: false,
      classification: "internal",
    },
  ],
});
const retainedManifest: ConnectorManifest = {
  ...connector.manifest,
  datasets: [retainedDefinition],
};
const retainedPages: DatasetPage[] = [0, 1, 2].map((index) => ({
  datasetKey: retainedDefinition.key,
  schemaVersion: 1,
  refreshKey: "staging",
  pageKey: String(index),
  previousPageKey: null,
  complete: index === 2,
  records: Array.from({ length: 3 }, (_, row) => ({
    values: { id: `${index}-${row}`, payload: "retained-row-".repeat(80) },
  })),
}));
interface Fixture {
  workspaceId: string;
  connectionId: string;
}
beforeAll(async () => {
  const test = await createTestDatabase();
  db = createDatabase(test.appUrl);
  owner = createRawSqlClient(test.adminUrl, { max: 1 });
  await owner`insert into connectors(id,version,manifest) values ('google-play','0.1.0',${JSON.stringify(connector.manifest)}::jsonb) on conflict do nothing`;
}, 60000);
afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
  await owner?.end({ timeout: 5 });
});
async function fixture(workspaceId?: string): Promise<Fixture> {
  if (!workspaceId) {
    const [workspace] =
      await owner`insert into workspaces(name) values ('Cache quota fixture') returning id`;
    workspaceId = workspace!.id as string;
  }
  const [connection] =
    await owner`insert into connections(workspace_id,connector_id,name) values (${workspaceId},'google-play','Fixture') returning id`;
  return { workspaceId, connectionId: connection!.id as string };
}
function staging(f: Fixture, manifest = retainedManifest) {
  return createDatasetStaging({
    db,
    ...f,
    manifest,
    clock: () => NOW,
    signal: new AbortController().signal,
  });
}
async function bytes(f: Fixture) {
  const [row] = await owner`select
    (coalesce((select sum(octet_length(payload::text)+256) from data_pages where workspace_id=${f.workspaceId}),0)+coalesce((select sum(octet_length("values"::text)+octet_length(record_key)+128) from data_records where workspace_id=${f.workspaceId}),0))::text as raw,
    coalesce((select sum(byte_size) from data_connector_stages where workspace_id=${f.workspaceId} and expires_at>${NOW}),0)::text as cache`;
  return { raw: Number(row!.raw), cache: Number(row!.cache) };
}
async function commit(
  f: Fixture,
  manifest: ConnectorManifest,
  result: Pick<SyncResult, "datasetPages">,
  cursor: string,
) {
  return withWorkspace(db, f, async (tx) => {
    for (const page of result.datasetPages ?? []) {
      const definition = manifest.datasets!.find(
        (item) => item.key === page.datasetKey,
      )!;
      const retainedSource = page.stagingId
        ? await connectorStageProvenance(
            tx,
            { ...f, connectorId: manifest.id, clock: () => NOW },
            page,
          )
        : undefined;
      await ingestDatasetPage(tx, {
        ...f,
        definition,
        page,
        now: NOW,
        clock: () => NOW,
        ...(retainedSource ? { retainedSource } : {}),
      });
    }
    await tx
      .insert(schema.connectionState)
      .values({ ...f, cursor, pollIntervalSeconds: 60 })
      .onConflictDoUpdate({
        target: schema.connectionState.connectionId,
        set: { cursor },
      });
  });
}
async function rawState(f: Fixture) {
  const [state] = await owner`select
    (select cursor from connection_state where connection_id=${f.connectionId}) as cursor,
    (select count(*)::int from data_pages where workspace_id=${f.workspaceId}) as pages,
    (select count(*)::int from data_generations where workspace_id=${f.workspaceId}) as generations,
    (select count(*)::int from data_records where workspace_id=${f.workspaceId}) as records,
    (select jsonb_agg(jsonb_build_object('page_count',page_count,'last_page_key',last_page_key,'complete',complete) order by id) from data_refreshes where workspace_id=${f.workspaceId}) as refreshes,
    (select bool_or(has_published_data) from data_datasets where workspace_id=${f.workspaceId}) as published`;
  return state;
}

function installFile(app: string, corrected = false) {
  return new Uint8Array(
    Buffer.from(
      "\uFEFFDate,Package Name,Country,Daily User Installs,Daily Device Installs,Future metric\r\n" +
        Array.from(
          { length: 2001 },
          (_, i) =>
            `2026-10-01,${app},US,${corrected && i === 0 ? "2" : "1"},1,${i}`,
        ).join("\r\n") +
        "\r\n",
      "utf16le",
    ),
  );
}
const REQUEST = {
  mode: "backfill" as const,
  from: "2026-10-01T00:00:00.000Z",
  to: NOW.toISOString(),
  resources: [ALPHA, BETA],
};
async function importGoogle(f: Fixture, fake: ReturnType<typeof fakePlay>) {
  const store = staging(f, connector.manifest);
  const runtime: ConnectorRuntime = { ...fake.runtime, datasetStaging: store };
  let cursor: string | undefined;
  const appPages: Record<string, number> = {};
  for (let turn = 0; turn < 100; turn++) {
    const result = await createGooglePlayConnector({
      now: () => TEST_NOW,
    }).sync(
      {
        connectionId: f.connectionId,
        credentials: { accessToken: "synthetic-access-token" },
        config: { reportBucket: TEST_BUCKET },
      },
      { ...REQUEST, ...(cursor ? { cursor } : {}) },
      runtime,
    );
    for (const page of result.datasetPages ?? [])
      if (page.datasetKey === "install_rows") {
        const app = String(page.window!.partition.app_id);
        appPages[app] = (appPages[app] ?? 0) + 1;
      }
    cursor = result.nextCursor ?? REQUEST.to;
    await commit(f, connector.manifest, result, cursor);
    if (result.done) return appPages;
  }
  throw new Error("Google import did not finish");
}
async function latestValues(f: Fixture) {
  const rows =
    await owner`with latest as (select distinct on (dataset_id) id,dataset_id from data_generations where workspace_id=${f.workspaceId} order by dataset_id,sequence desc)
    select d.key,r.values from latest g join data_datasets d on d.id=g.dataset_id join data_records r on r.generation_id=g.id where d.connection_id=${f.connectionId} order by d.key,r.values::text`;
  return rows.map((row) => ({ key: row.key, values: row.values }));
}

describe("independent connector cache and retained-data budgets", () => {
  it("enforces aggregate actual cache bytes across connections, preserves admitted stages after lowering, and honors null", async () => {
    const f = await fixture(),
      sameWorkspace = await fixture(f.workspaceId),
      foreign = await fixture();
    const store = staging(f);
    const first = await store.put({
      key: "first",
      metadata: { note: "actual stored bytes" },
      pages: retainedPages,
    });
    const [actual] =
      await owner`select s.byte_size,(octet_length(s.metadata::text)+512+(select sum(octet_length(p.payload_gzip)+512) from data_connector_stage_pages p where p.stage_id=s.id))::int as measured from data_connector_stages s where s.id=${first.id}`;
    expect(actual!.byte_size).toBe(actual!.measured);
    const size = actual!.byte_size as number;
    await adminSetDataPolicy(db, f.workspaceId, {
      maxWorkspaceBytes: 1,
      maxConnectorStagingBytes: size * 2 - 1,
    });
    await expect(
      staging(sameWorkspace).put({
        key: "second",
        metadata: { note: "actual stored bytes" },
        pages: retainedPages,
      }),
    ).rejects.toThrow("dataset_stage_quota");
    expect((await bytes(f)).cache).toBe(size);
    await adminSetDataPolicy(db, f.workspaceId, {
      maxConnectorStagingBytes: 0,
    });
    expect(await store.get("first")).toEqual(first);
    expect(await store.getPage(first.id, "0")).toEqual(retainedPages[0]);
    expect(
      await store.put({
        key: "first",
        metadata: { note: "actual stored bytes" },
        pages: retainedPages,
      }),
    ).toEqual(first);
    await expect(
      store.put({ key: "disabled-new", metadata: {}, pages: retainedPages }),
    ).rejects.toThrow("dataset_stage_quota");
    await adminSetDataPolicy(db, foreign.workspaceId, {
      maxConnectorStagingBytes: size,
    });
    await expect(
      staging(foreign).put({
        key: "foreign",
        metadata: { note: "actual stored bytes" },
        pages: retainedPages,
      }),
    ).resolves.toMatchObject({ key: "foreign" });
    await expect(staging(foreign).getPage(first.id, "0")).rejects.toThrow(
      "dataset_stage_unavailable",
    );
    await adminSetDataPolicy(db, f.workspaceId, {
      maxConnectorStagingBytes: null,
    });
    await expect(
      staging(sameWorkspace).put({
        key: "second",
        metadata: { note: "actual stored bytes" },
        pages: retainedPages,
      }),
    ).resolves.toMatchObject({ key: "second" });
    expect((await bytes(f)).cache).toBe(size * 2);

    // Separate connections race on the same real workspace budget lock. The
    // rejected transaction must leave neither a header nor partial chunks.
    const racing = await fixture(),
      peer = await fixture(racing.workspaceId);
    await adminSetDataPolicy(db, racing.workspaceId, {
      maxConnectorStagingBytes: size,
    });
    const admissions = await Promise.allSettled([
      staging(racing).put({
        key: "raced-one",
        metadata: { note: "actual stored bytes" },
        pages: retainedPages,
      }),
      staging(peer).put({
        key: "raced-two",
        metadata: { note: "actual stored bytes" },
        pages: retainedPages,
      }),
    ]);
    expect(
      admissions.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      admissions.filter((result) => result.status === "rejected"),
    ).toMatchObject([{ reason: { message: "dataset_stage_quota" } }]);
    expect((await bytes(racing)).cache).toBe(size);
    const [committed] =
      await owner`select (select count(*)::int from data_connector_stages where workspace_id=${racing.workspaceId}) as headers,(select count(*)::int from data_connector_stage_pages where workspace_id=${racing.workspaceId}) as pages`;
    expect(committed).toEqual({ headers: 1, pages: retainedPages.length });
    const loser =
      admissions[0]!.status === "rejected"
        ? { f: racing, key: "raced-one" }
        : { f: peer, key: "raced-two" };
    expect(await staging(loser.f).get(loser.key)).toBeNull();
  });

  it("rolls back nonfinal and final raw quota failures together with checkpoints, then retries after only raw quota increases", async () => {
    const f = await fixture(),
      store = staging(f);
    const stage = await store.put({
      key: "raw-rollback",
      metadata: {},
      pages: retainedPages,
    });
    const refreshKey = randomUUID();
    const page = (index: number): DatasetPage => ({
      ...retainedPages[index]!,
      refreshKey,
      pageKey: String(index),
      previousPageKey: index ? String(index - 1) : null,
      stagingId: stage.id,
      stagingPageKey: String(index),
    });
    await commit(f, retainedManifest, { datasetPages: [page(0)] }, "after-0");
    const first = await rawState(f),
      firstBytes = (await bytes(f)).raw;
    await adminSetDataPolicy(db, f.workspaceId, {
      maxWorkspaceBytes: firstBytes,
    });
    await expect(
      commit(f, retainedManifest, { datasetPages: [page(1)] }, "after-1"),
    ).rejects.toThrow("dataset_workspace_quota");
    expect(await rawState(f)).toEqual(first);
    await adminSetDataPolicy(db, f.workspaceId, { maxWorkspaceBytes: 100000 });
    await commit(f, retainedManifest, { datasetPages: [page(1)] }, "after-1");
    const second = await rawState(f),
      secondBytes = (await bytes(f)).raw;
    await adminSetDataPolicy(db, f.workspaceId, {
      maxWorkspaceBytes: secondBytes,
    });
    await expect(
      commit(f, retainedManifest, { datasetPages: [page(2)] }, "after-2"),
    ).rejects.toThrow("dataset_workspace_quota");
    expect(await rawState(f)).toEqual(second);
    expect(second).toMatchObject({
      cursor: "after-1",
      pages: 2,
      generations: 0,
      records: 0,
      published: false,
    });
    await adminSetDataPolicy(db, f.workspaceId, { maxWorkspaceBytes: 100000 });
    await commit(f, retainedManifest, { datasetPages: [page(2)] }, "after-2");
    expect(await rawState(f)).toMatchObject({
      cursor: "after-2",
      pages: 3,
      generations: 1,
      records: 9,
      published: true,
    });
    expect(await store.get("raw-rollback")).toEqual(stage);
  });

  it("keeps three-page multi-app Google imports and corrections within the same raw quota with caching, disabled caching, or admission refusal", async () => {
    const alphaName = `stats/installs/installs_${ALPHA}_202610_country.csv`,
      betaName = `stats/installs/installs_${BETA}_202610_country.csv`;
    async function journey(budget: number | null, rawQuota?: number) {
      const f = await fixture(),
        fake = fakePlay();
      fake.put(alphaName, installFile(ALPHA), "100");
      fake.put(betaName, installFile(BETA), "100");
      await adminSetDataPolicy(db, f.workspaceId, {
        maxConnectorStagingBytes: budget,
        ...(rawQuota ? { maxWorkspaceBytes: rawQuota } : {}),
      });
      expect(await importGoogle(f, fake)).toMatchObject({
        [ALPHA]: 3,
        [BETA]: 3,
      });
      fake.put(alphaName, installFile(ALPHA, true), "101");
      expect(await importGoogle(f, fake)).toMatchObject({
        [ALPHA]: 3,
        [BETA]: 3,
      });
      return { f, fake, values: await latestValues(f), usage: await bytes(f) };
    }
    const calibration = await journey(null);
    const rawQuota = calibration.usage.raw + 8192;
    expect(calibration.usage.raw + calibration.usage.cache).toBeGreaterThan(
      rawQuota,
    );
    const cached = await journey(null, rawQuota),
      disabled = await journey(0, rawQuota),
      refused = await journey(1, rawQuota);
    expect(cached.usage.raw).toBeLessThanOrEqual(rawQuota);
    expect(cached.usage.raw + cached.usage.cache).toBeGreaterThan(rawQuota);
    expect(disabled.usage.cache).toBe(0);
    expect(refused.usage.cache).toBe(0);
    expect(disabled.values).toEqual(cached.values);
    expect(refused.values).toEqual(cached.values);
    const installs = cached.values.filter((row) => row.key === "install_rows");
    expect(installs).toHaveLength(4002);
    const alpha = installs.filter(
      (row) => (row.values as Record<string, unknown>).app_id === ALPHA,
    );
    expect(alpha).toHaveLength(2001);
    expect(
      alpha.reduce(
        (sum, row) =>
          sum +
          Number((row.values as Record<string, unknown>).daily_user_installs),
        0,
      ),
    ).toBe(2002);
    const media = (fake: ReturnType<typeof fakePlay>) =>
      fake.calls.filter(
        (call) =>
          call.url.searchParams.get("alt") === "media" &&
          call.url.pathname.endsWith(encodeURIComponent(alphaName)),
      ).length;
    expect(media(cached.fake)).toBe(2);
    expect(media(disabled.fake)).toBe(6);
    expect(media(refused.fake)).toBe(6);
  }, 60000);
});
