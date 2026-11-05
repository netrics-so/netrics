import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDatabase,
  createRawSqlClient,
  withWorkspace,
  schema,
  connectorStageProvenance,
  ingestDatasetPage,
  pruneDatasetHistory,
  adminSetDataPolicy,
  type Database,
  type Sql,
} from "@netrics/database";
import {
  sourceDatasetSchema,
  type ConnectorManifest,
  type ConnectorRuntime,
  type DatasetPage,
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

let schedulerDb: Database;
let db: Database,
  owner: Sql,
  workspaceId: string,
  otherId: string,
  connectionId: string,
  otherConnectionId: string;
const now = new Date(TEST_NOW);
beforeAll(async () => {
  const test = await createTestDatabase({
    upTo: "0057_store_template_installs",
  });
  owner = createRawSqlClient(test.adminUrl, { max: 1 });
  const connector = createGooglePlayConnector();
  await owner`insert into connectors(id,version,manifest) values ('google-play','0.1.0',${JSON.stringify(connector.manifest)}::jsonb) on conflict do nothing`;
  const [a, b] =
    await owner`insert into workspaces(name) values ('Report staging'),('Other') returning id`;
  workspaceId = a!.id as string;
  otherId = b!.id as string;
  const [ca, cb] =
    await owner`insert into connections(workspace_id,connector_id,name) values (${workspaceId},'google-play','Existing'),(${otherId},'google-play','Foreign') returning id`;
  connectionId = ca!.id as string;
  otherConnectionId = cb!.id as string;
  const before = await owner`select * from connections order by id`;
  await test.migrate();
  expect(await owner`select * from connections order by id`).toEqual(before);
  db = createDatabase(test.appUrl);
  const schedulerUrl = new URL(test.adminUrl);
  schedulerUrl.username = "netrics_scheduler";
  schedulerUrl.password = "netrics_scheduler";
  schedulerDb = createDatabase(schedulerUrl.toString());
}, 60000);
afterAll(async () => {
  await schedulerDb?.$client.end({ timeout: 5 });
  await db?.$client.end({ timeout: 5 });
  await owner?.end({ timeout: 5 });
});
function staging(
  manifest: ConnectorManifest,
  at = now,
  signal = new AbortController().signal,
  workspace = workspaceId,
  connection = connectionId,
) {
  return createDatasetStaging({
    db,
    manifest,
    now: at,
    signal,
    workspaceId: workspace,
    connectionId: connection,
  });
}
function installFile(count: number, correction = false) {
  return new Uint8Array(
    Buffer.from(
      "\uFEFFDate,Package Name,Country,Daily User Installs,Daily Device Installs,Future metric\r\n" +
        Array.from(
          { length: count },
          (_, i) =>
            `2026-10-01,${ALPHA},US,${correction && i === 0 ? "2" : "1"},1,${i}`,
        ).join("\r\n") +
        "\r\n",
      "utf16le",
    ),
  );
}
const context = () => ({
  connectionId,
  credentials: { accessToken: "synthetic-access-token" },
  config: { reportBucket: TEST_BUCKET },
});
const request = {
  mode: "backfill" as const,
  from: "2026-10-01T00:00:00.000Z",
  to: now.toISOString(),
  resources: [ALPHA, BETA],
};
function mediaCalls(fake: ReturnType<typeof fakePlay>, name: string) {
  return fake.calls.filter(
    (c) =>
      c.url.searchParams.get("alt") === "media" &&
      c.url.pathname.endsWith(encodeURIComponent(name)),
  );
}
async function firstRaw(runtime: ConnectorRuntime) {
  let cursor: string | undefined;
  for (let i = 0; i < 30; i++) {
    const page = await createGooglePlayConnector({ now: () => TEST_NOW }).sync(
      context(),
      { ...request, cursor },
      runtime,
    );
    if (page.datasetPages?.some((p) => p.datasetKey === "install_rows"))
      return page;
    if (page.done) throw new Error("No raw fixture page");
    cursor = page.nextCursor;
  }
  throw new Error("Fixture did not reach raw report");
}

describe("durable parsed Google Play report staging", () => {
  it("downloads and parses larger pinned reports once across restarted connector instances and app/page turns", async () => {
    const fake = fakePlay();
    const name = `stats/installs/installs_${ALPHA}_202610_country.csv`;
    const bytes = installFile(20_001);
    fake.put(name, bytes, "100");
    const manifest = createGooglePlayConnector().manifest;
    const store = staging(manifest);
    const read = vi.spyOn(store, "getPage");
    const runtime: ConnectorRuntime = {
      ...fake.runtime,
      datasetStaging: store,
    };
    let cursor: string | undefined;
    let installs = 0,
      earnings = 0,
      pages = 0;
    const started = performance.now();
    const before = process.memoryUsage().rss;
    for (let turn = 0; turn < 100; turn++) {
      // A new connector object on every turn rules out an in-process report cache.
      const result = await createGooglePlayConnector({
        now: () => TEST_NOW,
      }).sync(context(), { ...request, cursor }, runtime);
      for (const page of result.datasetPages ?? []) {
        if (page.stagingId) {
          const provenance = await withWorkspace(db, { workspaceId }, (tx) =>
            connectorStageProvenance(
              tx,
              { workspaceId, connectionId, connectorId: manifest.id, now },
              page,
            ),
          );
          expect(provenance).toEqual({ collectedAt: now, expiresAt: null });
          pages++;
        }
        if (
          page.datasetKey === "install_rows" &&
          page.window?.partition.app_id === ALPHA
        )
          installs += page.records.length;
        if (page.datasetKey === "earning_rows") earnings += page.records.length;
      }
      if (result.done) break;
      cursor = result.nextCursor;
      if (turn === 99) throw new Error("Import did not finish");
    }
    expect(installs).toBe(20_001);
    expect(earnings).toBe(8);
    for (const object of fake.objects.values())
      expect(mediaCalls(fake, object.name)).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(pages);
    const headers = await withWorkspace(db, { workspaceId }, (tx) =>
      tx.select().from(schema.dataConnectorStages),
    );
    expect(headers.length).toBeGreaterThan(0);
    expect(
      headers.every((h) => h.expiresAt.getTime() <= TEST_NOW + 86_400_000),
    ).toBe(true);
    expect(JSON.stringify(headers)).not.toContain("synthetic-access-token");
    console.info(
      "NETRICS_GOOGLE_STAGE_RESULT",
      JSON.stringify({
        providerBytes: bytes.byteLength,
        rows: installs,
        parsedPages: pages,
        mediaDownloads: fake.calls.filter(
          (c) => c.url.searchParams.get("alt") === "media",
        ).length,
        elapsedMs: Math.round(performance.now() - started),
        rssBefore: before,
        rssAfter: process.memoryUsage().rss,
        stagedBytes: headers.reduce((n, h) => n + h.byteSize, 0),
      }),
    );
  }, 60_000);

  it("restarts corrected or expired pending stages and re-authorizes cached object reads", async () => {
    const fake = fakePlay();
    const name = `stats/installs/installs_${ALPHA}_202610_country.csv`;
    fake.put(name, installFile(1001), "200");
    const connector = createGooglePlayConnector({ now: () => TEST_NOW });
    let runtime: ConnectorRuntime = {
      ...fake.runtime,
      datasetStaging: staging(connector.manifest),
    };
    const first = await firstRaw(runtime);
    fake.put(name, installFile(1001, true), "201");
    const corrected = await connector.sync(
      context(),
      { ...request, cursor: first.nextCursor },
      runtime,
    );
    expect(corrected.datasetPages?.[0]).toMatchObject({
      pageKey: "0",
      previousPageKey: null,
      complete: false,
    });
    expect(corrected.datasetPages?.[0]?.refreshKey).not.toBe(
      first.datasetPages?.[0]?.refreshKey,
    );
    const correctedId = corrected.datasetPages?.[0]?.stagingId;
    runtime = {
      ...fake.runtime,
      datasetStaging: staging(
        connector.manifest,
        new Date(TEST_NOW + 86_400_001),
      ),
    };
    const expired = await connector.sync(
      context(),
      { ...request, cursor: corrected.nextCursor },
      runtime,
    );
    expect(expired.datasetPages?.[0]).toMatchObject({
      pageKey: "0",
      previousPageKey: null,
      complete: false,
    });
    expect(expired.datasetPages?.[0]?.stagingId).not.toBe(correctedId);
    fake.privateStatus.set(name, 403);
    const forbidden = await connector.sync(
      context(),
      { ...request, cursor: expired.nextCursor },
      runtime,
    );
    expect(forbidden.datasetPages?.map((p) => p.datasetKey)).toEqual([
      "report_status",
    ]);
    expect(forbidden.datasetPages?.[0]?.records[0]?.values.availability).toBe(
      "permission_missing",
    );
    expect(
      mediaCalls(fake, name).map((c) => c.url.searchParams.get("generation")),
    ).toEqual(["200", "201", "201"]);
  });
});

const retainedDefinition = sourceDatasetSchema.parse({
  key: "retained",
  name: "Retained",
  version: 1,
  mode: "snapshot",
  grain: "one record",
  keyFields: ["id"],
  retentionDays: 2,
  fields: [
    {
      id: "id",
      name: "ID",
      type: "string",
      nullable: false,
      classification: "personal",
      retentionDays: 2,
    },
  ],
});
function retainedManifest(): ConnectorManifest {
  return {
    ...createGooglePlayConnector().manifest,
    datasets: [retainedDefinition],
  };
}
function retainedPage(): DatasetPage {
  return {
    datasetKey: "retained",
    schemaVersion: 1,
    refreshKey: "staging",
    pageKey: "0",
    previousPageKey: null,
    complete: true,
    records: [{ values: { id: "synthetic-record" } }],
  };
}

describe("host staging storage boundaries", () => {
  it("keeps metadata digests independent of database collation", async () => {
    const store = staging(retainedManifest());
    const value = {
      key: randomUUID(),
      metadata: {},
      pages: ["Z", "a", "_", ":"].map((pageKey) => ({
        ...retainedPage(),
        pageKey,
      })),
    };
    const stored = await store.put(value);
    expect(await store.get(value.key)).toEqual(stored);
    const foreignConnection = staging(
      retainedManifest(),
      now,
      new AbortController().signal,
      workspaceId,
      otherConnectionId,
    );
    await expect(
      foreignConnection.put({
        key: randomUUID(),
        metadata: {},
        pages: [retainedPage()],
      }),
    ).rejects.toThrow("dataset_connection_not_found");
  });

  it("preserves collection deadlines on resumed ingestion and rejects foreign, altered, deleted or expired inputs", async () => {
    const manifest = retainedManifest(),
      store = staging(manifest);
    const value = {
      key: randomUUID(),
      metadata: { version: 1 },
      pages: [retainedPage()],
    };
    const stage = await store.put(value);
    expect(await store.put(value)).toEqual(stage);
    await expect(
      store.put({ ...value, metadata: { version: 2 } }),
    ).rejects.toThrow("dataset_stage_conflict");
    const resumedAt = new Date(TEST_NOW + 3600_000);
    const page: DatasetPage = {
      ...retainedPage(),
      refreshKey: randomUUID(),
      stagingId: stage.id,
      stagingPageKey: "0",
    };
    const ingested = await withWorkspace(db, { workspaceId }, async (tx) => {
      const retainedSource = await connectorStageProvenance(
        tx,
        { workspaceId, connectionId, connectorId: manifest.id, now: resumedAt },
        page,
      );
      expect(retainedSource).toEqual({
        collectedAt: now,
        expiresAt: new Date(TEST_NOW + 2 * 86_400_000),
      });
      return ingestDatasetPage(tx, {
        workspaceId,
        connectionId,
        definition: retainedDefinition,
        page,
        now: resumedAt,
        retainedSource,
      });
    });
    const [row] =
      await owner`select collected_at,expires_at from data_records where generation_id=${ingested.generationId!}`;
    expect(row).toMatchObject({
      collected_at: now,
      expires_at: new Date(TEST_NOW + 2 * 86_400_000),
    });
    await expect(
      withWorkspace(db, { workspaceId }, (tx) =>
        connectorStageProvenance(
          tx,
          { workspaceId, connectionId, connectorId: manifest.id, now },
          { ...page, records: [{ values: { id: "altered" } }] },
        ),
      ),
    ).rejects.toThrow("dataset_stage_reference_invalid");
    const foreign = staging(
      manifest,
      now,
      new AbortController().signal,
      otherId,
      otherConnectionId,
    );
    expect(await foreign.get(value.key)).toBeNull();
    await expect(foreign.getPage(stage.id, "0")).rejects.toThrow(
      "dataset_stage_unavailable",
    );
    await expect(
      staging(manifest, new Date(TEST_NOW + 86_400_001)).getPage(stage.id, "0"),
    ).rejects.toThrow("dataset_stage_unavailable");
    await owner`delete from data_connector_stages where id=${stage.id}`;
    await expect(store.getPage(stage.id, "0")).rejects.toThrow(
      "dataset_stage_unavailable",
    );
  });

  it("enforces immutable RLS storage, detects corruption, honors quota and aborts writes without partial stages", async () => {
    const manifest = retainedManifest(),
      store = staging(manifest);
    const stage = await store.put({
      key: randomUUID(),
      metadata: {},
      pages: [retainedPage()],
    });
    await expect(
      withWorkspace(db, { workspaceId }, (tx) =>
        tx.execute(
          sql`update data_connector_stages set metadata='{}'::jsonb where id=${stage.id}::uuid`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      withWorkspace(db, { workspaceId }, (tx) =>
        tx.execute(
          sql`update data_connector_stage_pages set payload='{}'::jsonb where stage_id=${stage.id}::uuid`,
        ),
      ),
    ).rejects.toThrow();
    await owner`update data_connector_stage_pages set payload='{}' where stage_id=${stage.id}`;
    await expect(store.getPage(stage.id, "0")).rejects.toThrow(
      "dataset_stage_integrity",
    );
    await adminSetDataPolicy(db, workspaceId, { maxWorkspaceBytes: 1 });
    const quotaKey = randomUUID();
    await expect(
      store.put({ key: quotaKey, metadata: {}, pages: [retainedPage()] }),
    ).rejects.toThrow("dataset_workspace_quota");
    expect(await store.get(quotaKey)).toBeNull();
    await adminSetDataPolicy(db, workspaceId, {});
    const controller = new AbortController();
    controller.abort();
    await expect(
      staging(manifest, now, controller.signal).put({
        key: "aborted",
        metadata: {},
        pages: [retainedPage()],
      }),
    ).rejects.toThrow();
    expect(await store.get("aborted")).toBeNull();
    const during = new AbortController();
    const pending = staging(manifest, now, during.signal).put({
      key: "aborted-during-write",
      metadata: {},
      pages: [retainedPage()],
    });
    during.abort();
    await expect(pending).rejects.toThrow();
    expect(await store.get("aborted-during-write")).toBeNull();
  });

  it("irreversibly shortens existing staged retention and prunes chunks in bounded scheduler batches", async () => {
    const at = new Date(TEST_NOW - 2 * 86_400_000);
    const store = staging(retainedManifest(), at);
    const stage = await store.put({
      key: randomUUID(),
      metadata: {},
      pages: [retainedPage()],
    });
    await adminSetDataPolicy(db, workspaceId, { maxRetentionDays: 1 });
    await adminSetDataPolicy(db, workspaceId, { maxRetentionDays: null });
    const [row] =
      await owner`select source_expires_at from data_connector_stages where id=${stage.id}`;
    expect(row!.source_expires_at).toEqual(new Date(at.getTime() + 86_400_000));
    await expect(
      schedulerDb.select().from(schema.dataConnectorStages),
    ).rejects.toThrow();
    expect(await pruneDatasetHistory(schedulerDb, now, 1)).toBeGreaterThan(0);
    for (let i = 0; i < 100; i++) {
      if ((await pruneDatasetHistory(schedulerDb, now, 1)) === 0) break;
    }
    expect(
      await owner`select id from data_connector_stages where id=${stage.id}`,
    ).toHaveLength(0);
    expect(
      await owner`select stage_id from data_connector_stage_pages where stage_id=${stage.id}`,
    ).toHaveLength(0);
  });
});
