import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CONNECTOR_STAGE_DRAFT_TTL_MS,
  adminSetDataPolicy,
  appendConnectorStagePages,
  commitConnectorStage,
  connectorStageDigest,
  connectorStagePageDigest,
  connectorStageProvenance,
  createDatabase,
  createRawSqlClient,
  prepareConnectorStagePages,
  pruneDatasetHistory,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";
import {
  sourceDatasetSchema,
  type ConnectorManifest,
  type DatasetPage,
} from "@netrics/connector-sdk";
import { createGooglePlayConnector } from "@netrics/connectors";
import { createTestDatabase, type TestDatabase } from "../test-db.js";
import { createDatasetStaging } from "./staging.js";

// Incremental connector staging (ADR 0024, #525): drafts written page by
// page, readable only once committed, budgeted on every append under the
// staging lock (441) instead of the ingestion lock (440).
const DAY = 86_400_000;
const NOW = new Date("2026-11-07T12:00:00.000Z");
const definition = sourceDatasetSchema.parse({
  key: "stream_fixture",
  name: "Stream fixture",
  version: 1,
  mode: "snapshot",
  grain: "One row",
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
      classification: "personal",
      retentionDays: null,
    },
  ],
});
const manifest: ConnectorManifest = {
  ...createGooglePlayConnector().manifest,
  datasets: [definition],
};
function page(index: number, salt = ""): DatasetPage {
  return {
    datasetKey: definition.key,
    schemaVersion: 1,
    refreshKey: "staging",
    pageKey: String(index),
    previousPageKey: null,
    complete: false,
    records: Array.from({ length: 20 }, (_, row) => ({
      values: {
        id: `${index}-${row}`,
        // Random content keeps compressed sizes predictable enough to budget.
        payload: salt + randomUUID() + randomUUID(),
      },
    })),
  };
}
const identity = { datasetKey: definition.key, schemaVersion: 1 };

let test: TestDatabase, db: Database, owner: Sql;
beforeAll(async () => {
  test = await createTestDatabase();
  db = createDatabase(test.appUrl);
  owner = createRawSqlClient(test.adminUrl, { max: 2 });
}, 60_000);
afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
  await owner?.end({ timeout: 5 });
});

interface Fixture {
  workspaceId: string;
  connectionId: string;
}
async function fixture(workspaceId?: string): Promise<Fixture> {
  if (!workspaceId) {
    const [w] =
      await owner`insert into workspaces(name) values ('Stream staging') returning id`;
    workspaceId = w!.id as string;
  }
  const [c] =
    await owner`insert into connections(workspace_id,connector_id,name) values (${workspaceId},'google-play','Stream') returning id`;
  return { workspaceId, connectionId: c!.id as string };
}
function staging(
  f: Fixture,
  at: () => Date = () => NOW,
  signal = new AbortController().signal,
) {
  return createDatasetStaging({ db, ...f, manifest, clock: at, signal });
}
const scope = (f: Fixture, at = NOW) => ({
  ...f,
  connectorId: manifest.id,
  clock: () => at,
});
async function stages(f: Fixture) {
  return owner`select id, key, committed_at, byte_size, expires_at, source_expires_at,
    (select count(*)::int from data_connector_stage_pages p where p.stage_id = s.id) as pages
    from data_connector_stages s where workspace_id = ${f.workspaceId} order by key, id`;
}
async function cacheBytes(f: Fixture, at = NOW) {
  const [row] =
    await owner`select coalesce(sum(byte_size),0)::int as bytes from data_connector_stages where workspace_id=${f.workspaceId} and expires_at > ${at}`;
  return row!.bytes as number;
}

describe("incremental connector staging (ADR 0024)", () => {
  it("keeps a draft unreadable until commit and stores pages compressed", async () => {
    const f = await fixture(),
      store = staging(f);
    const writer = await store.begin!({ key: "report", ...identity });
    const pages = [page(0), page(1), page(2)];
    await writer.append([pages[0]!]);
    await writer.append([pages[1]!, pages[2]!]);
    const [draft] = await stages(f);
    expect(draft).toMatchObject({ committed_at: null, pages: 3 });
    // Drafts are invisible to every reader.
    expect(await store.get("report")).toBeNull();
    await expect(store.getPage(draft!.id as string, "0")).rejects.toThrow(
      "dataset_stage_unavailable",
    );
    await expect(
      withWorkspace(db, { workspaceId: f.workspaceId }, (tx) =>
        connectorStageProvenance(tx, scope(f), {
          ...pages[0]!,
          stagingId: draft!.id as string,
          stagingPageKey: "0",
        }),
      ),
    ).rejects.toThrow("dataset_stage_unavailable");
    expect((draft!.expires_at as Date).getTime()).toBe(
      NOW.getTime() + CONNECTOR_STAGE_DRAFT_TTL_MS,
    );

    const stage = await writer.commit({ metadata: { parts: 3 } });
    expect(stage).toEqual({
      id: draft!.id,
      key: "report",
      metadata: { parts: 3 },
    });
    expect(await store.get("report")).toEqual(stage);
    expect(await store.getPage(stage.id, "1")).toEqual(pages[1]);
    const [committed] = await stages(f);
    expect(committed).toMatchObject({ committed_at: NOW });
    expect((committed!.expires_at as Date).getTime()).toBe(NOW.getTime() + DAY);
    // Stored bytes are the compressed pages plus overhead, and the header
    // digest is the one `put` would compute for the same content.
    const [stored] = await owner`select s.byte_size, s.digest,
        octet_length(s.metadata::text) + 512 + (select sum(octet_length(p.payload_gzip) + 512) from data_connector_stage_pages p where p.stage_id = s.id) as measured,
        (select bool_and(p.payload is null) from data_connector_stage_pages p where p.stage_id = s.id) as compressed
        from data_connector_stages s where s.id = ${stage.id}`;
    expect(stored!.byte_size).toBe(Number(stored!.measured));
    expect(stored!.compressed).toBe(true);
    expect(stored!.digest).toBe(connectorStageDigest({ parts: 3 }, pages));
    // Writing more after commit is refused.
    await expect(writer.append([page(3)])).rejects.toThrow(
      "dataset_stage_closed",
    );
    // put over the same content returns the committed stage; different
    // content under the live key is a conflict and leaves no draft behind.
    expect(
      await store.put({ key: "report", metadata: { parts: 3 }, pages }),
    ).toEqual(stage);
    const second = await store.begin!({ key: "report", ...identity });
    await second.append(pages);
    expect(await second.commit({ metadata: { parts: 3 } })).toEqual(stage);
    const third = await store.begin!({ key: "report", ...identity });
    await third.append([pages[0]!]);
    await expect(third.commit({ metadata: { parts: 3 } })).rejects.toThrow(
      "dataset_stage_conflict",
    );
    expect((await stages(f)).map((s) => s.id)).toEqual([stage.id]);
  });

  it("refuses an append beyond the workspace budget, counting open drafts, and keeps nothing of the refused draft", async () => {
    const f = await fixture(),
      peer = await fixture(f.workspaceId);
    const pages = [page(0), page(1)];
    const prepared = prepareConnectorStagePages(pages, definition);
    const pageBytes = prepared.reduce(
      (n, p) => n + p.payloadGzip.byteLength + 512,
      0,
    );
    // Room for the pages of one draft, not two.
    await adminSetDataPolicy(db, f.workspaceId, {
      maxConnectorStagingBytes: pageBytes + 1024,
    });
    const a = await staging(f).begin!({ key: "a", ...identity });
    const b = await staging(peer).begin!({ key: "b", ...identity });
    await a.append(pages);
    expect(await cacheBytes(f)).toBe(pageBytes);
    await expect(b.append(pages)).rejects.toThrow("dataset_stage_quota");
    // The refused draft is gone, header and pages, and its writer is closed.
    expect((await stages(f)).map((s) => s.key)).toEqual(["a"]);
    await expect(b.append([page(2)])).rejects.toThrow("dataset_stage_closed");
    // The admitted draft still commits within the budget.
    const stage = await a.commit({ metadata: {} });
    expect(await staging(f).get("a")).toEqual(stage);
    expect(await cacheBytes(f)).toBeLessThanOrEqual(pageBytes + 1024);
    // A budget of zero refuses a new draft outright.
    await adminSetDataPolicy(db, f.workspaceId, {
      maxConnectorStagingBytes: 0,
    });
    await expect(staging(f).begin!({ key: "c", ...identity })).rejects.toThrow(
      "dataset_stage_quota",
    );
  });

  it("refuses an append beyond the per-stage limit", async () => {
    const f = await fixture();
    const writer = await staging(f).begin!({ key: "large", ...identity });
    await writer.append([page(0)]);
    const [draft] = await stages(f);
    // Stand in for 128 MiB of earlier appends.
    await owner`update data_connector_stages set byte_size = ${128 * 1024 * 1024 - 600} where id = ${draft!.id}`;
    await expect(writer.append([page(1)])).rejects.toThrow(
      "dataset_stage_limit",
    );
    expect(await stages(f)).toHaveLength(0);
  });

  it("discards drafts on abort, on the call's abort signal and after their TTL, and prunes them", async () => {
    const f = await fixture(),
      store = staging(f);
    const aborted = await store.begin!({ key: "aborted", ...identity });
    await aborted.append([page(0)]);
    await aborted.abort();
    await aborted.abort();
    expect(await stages(f)).toHaveLength(0);

    const call = new AbortController();
    const revoked = staging(f, () => NOW, call.signal);
    const open = await revoked.begin!({ key: "revoked", ...identity });
    await open.append([page(0)]);
    call.abort();
    await expect(open.append([page(1)])).rejects.toThrow();
    await expect(open.commit({ metadata: {} })).rejects.toThrow();
    for (let i = 0; i < 50 && (await stages(f)).length; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await stages(f)).toHaveLength(0);

    // A draft whose call never ended cleanly: it stops counting toward the
    // budget once its TTL passes, cannot be committed, and prune removes it.
    const abandoned = await store.begin!({ key: "abandoned", ...identity });
    await abandoned.append([page(0), page(1)]);
    const bytes = await cacheBytes(f);
    expect(bytes).toBeGreaterThan(0);
    const later = new Date(NOW.getTime() + CONNECTOR_STAGE_DRAFT_TTL_MS + 1);
    expect(await cacheBytes(f, later)).toBe(0);
    const [draft] = await stages(f);
    await expect(
      withWorkspace(db, { workspaceId: f.workspaceId }, (tx) =>
        commitConnectorStage(tx, scope(f, later), draft!.id as string, {}),
      ),
    ).rejects.toThrow("dataset_stage_unavailable");
    await expect(
      withWorkspace(db, { workspaceId: f.workspaceId }, (tx) =>
        appendConnectorStagePages(
          tx,
          scope(f, later),
          draft!.id as string,
          prepareConnectorStagePages([page(2)], definition),
        ),
      ),
    ).rejects.toThrow("dataset_stage_unavailable");
    const schedulerUrl = new URL(test.adminUrl);
    schedulerUrl.username = "netrics_scheduler";
    schedulerUrl.password = "netrics_scheduler";
    const scheduler = createDatabase(schedulerUrl.toString(), { max: 1 });
    try {
      for (let i = 0; i < 10; i++)
        if ((await pruneDatasetHistory(scheduler, later)) === 0) break;
    } finally {
      await scheduler.$client.end({ timeout: 5 });
    }
    expect(await stages(f)).toHaveLength(0);
  });

  it("isolates drafts by workspace and connection", async () => {
    const f = await fixture(),
      other = await fixture(),
      sibling = await fixture(f.workspaceId);
    const writer = await staging(f).begin!({ key: "private", ...identity });
    await writer.append([page(0)]);
    const [draft] = await stages(f);
    const id = draft!.id as string;
    const prepared = prepareConnectorStagePages([page(1)], definition);
    // Explicit scope predicates: another workspace or connection cannot
    // append to or commit this draft.
    for (const foreign of [other, sibling]) {
      await expect(
        withWorkspace(db, { workspaceId: foreign.workspaceId }, (tx) =>
          appendConnectorStagePages(tx, scope(foreign), id, prepared),
        ),
      ).rejects.toThrow("dataset_stage_unavailable");
      await expect(
        withWorkspace(db, { workspaceId: foreign.workspaceId }, (tx) =>
          commitConnectorStage(tx, scope(foreign), id, {}),
        ),
      ).rejects.toThrow("dataset_stage_unavailable");
    }
    // RLS: under another workspace the rows are not even visible, whatever
    // the query's own predicates say.
    const visible = await withWorkspace(
      db,
      { workspaceId: other.workspaceId },
      (tx) =>
        tx.execute(
          sql`select (select count(*)::int from data_connector_stages where id=${id}::uuid) as headers, (select count(*)::int from data_connector_stage_pages where stage_id=${id}::uuid) as pages`,
        ),
    );
    expect([...visible]).toEqual([{ headers: 0, pages: 0 }]);
    // The application role cannot give a draft a deadline beyond one day.
    await expect(
      withWorkspace(db, { workspaceId: f.workspaceId }, (tx) =>
        tx.execute(
          sql`update data_connector_stages set expires_at = source_collected_at + interval '2 days' where id=${id}::uuid`,
        ),
      ),
    ).rejects.toThrow();
    await writer.abort();
  });

  it("appends while the ingestion lock is held, and commits only after it is released", async () => {
    const f = await fixture();
    const writer = await staging(f).begin!({ key: "locked", ...identity });
    const holder = createRawSqlClient(test.adminUrl, { max: 1 });
    try {
      await holder`select pg_advisory_lock(hashtextextended(${f.workspaceId}::uuid::text, 440))`;
      // A sync page or retention change holds 440: appends do not wait.
      await writer.append([page(0)]);
      await writer.append([page(1)]);
      let committed = false;
      const commit = writer.commit({ metadata: {} }).then((stage) => {
        committed = true;
        return stage;
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(committed).toBe(false);
      await holder`select pg_advisory_unlock(hashtextextended(${f.workspaceId}::uuid::text, 440))`;
      await expect(commit).resolves.toMatchObject({ key: "locked" });
    } finally {
      await holder.end({ timeout: 5 });
    }
  });

  it("shortens an open draft's source deadline on a racing policy change, and commit keeps it", async () => {
    const f = await fixture();
    const store = staging(f);
    const before = await store.begin!({ key: "before", ...identity });
    const racing = await store.begin!({ key: "racing", ...identity });
    await before.append([page(0)]);
    await racing.append([page(0)]);
    // The personal field's connection-retention preset (90 days).
    expect(
      (await stages(f)).map((s) => s.source_expires_at as Date | null),
    ).toEqual([
      new Date(NOW.getTime() + 90 * DAY),
      new Date(NOW.getTime() + 90 * DAY),
    ]);
    // A policy change while both drafts are open shortens their deadlines.
    await adminSetDataPolicy(db, f.workspaceId, { maxRetentionDays: 3 });
    expect(
      (await stages(f)).map((s) => s.source_expires_at as Date | null),
    ).toEqual([
      new Date(NOW.getTime() + 3 * DAY),
      new Date(NOW.getTime() + 3 * DAY),
    ]);
    // A commit racing a further change: both take the ingestion lock, and
    // whichever wins, the committed stage ends with the newer deadline.
    const [stage] = await Promise.all([
      before.commit({ metadata: {} }),
      adminSetDataPolicy(db, f.workspaceId, { maxRetentionDays: 2 }),
    ]);
    await racing.commit({ metadata: {} });
    const rows = await stages(f);
    expect(rows.map((s) => s.committed_at)).toEqual([NOW, NOW]);
    for (const row of rows) {
      expect(row.source_expires_at).toEqual(new Date(NOW.getTime() + 2 * DAY));
      expect((row.expires_at as Date).getTime()).toBe(NOW.getTime() + DAY);
    }
    // Provenance hands the shortened deadline to ingestion.
    const stored = await store.getPage(stage.id, "0");
    const accepted = await withWorkspace(
      db,
      { workspaceId: f.workspaceId },
      (tx) =>
        connectorStageProvenance(tx, scope(f), {
          ...stored,
          stagingId: stage.id,
          stagingPageKey: "0",
        }),
    );
    expect(accepted).toEqual({
      collectedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 2 * DAY),
    });
  });
});

describe("stages written before 0067", () => {
  it("keeps JSONB pages readable and marks existing stages committed", async () => {
    const legacy = await createTestDatabase({
      upTo: "0066_policy_rewrite_moved_only",
    });
    const admin = createRawSqlClient(legacy.adminUrl, { max: 1 });
    const app = createDatabase(legacy.appUrl, { max: 2 });
    try {
      const [w] =
        await admin`insert into workspaces(name) values ('Legacy staging') returning id`;
      const [c] =
        await admin`insert into connections(workspace_id,connector_id,name) values (${w!.id},'google-play','Legacy') returning id`;
      const f = {
        workspaceId: w!.id as string,
        connectionId: c!.id as string,
      };
      const stored = page(0);
      const [header] =
        await admin`insert into data_connector_stages (workspace_id, connection_id, connector_id, key, dataset_key, schema_version, metadata, digest, byte_size, source_collected_at, source_expires_at, expires_at)
          values (${f.workspaceId}, ${f.connectionId}, ${manifest.id}, 'legacy', ${definition.key}, 1, ${admin.json({ v: 1 })}, ${connectorStageDigest({ v: 1 }, [stored])}, 4096, ${NOW}, null, ${new Date(NOW.getTime() + DAY)}) returning id`;
      await admin`insert into data_connector_stage_pages (stage_id, workspace_id, page_key, payload, digest)
        values (${header!.id}, ${f.workspaceId}, '0', ${admin.json(stored as never)}, ${connectorStagePageDigest(stored)})`;
      await legacy.migrate();
      const [row] =
        await admin`select committed_at from data_connector_stages where id=${header!.id}`;
      expect(row!.committed_at).toEqual(NOW);
      const store = createDatasetStaging({
        db: app,
        ...f,
        manifest,
        clock: () => NOW,
        signal: new AbortController().signal,
      });
      expect(await store.get("legacy")).toEqual({
        id: header!.id,
        key: "legacy",
        metadata: { v: 1 },
      });
      expect(await store.getPage(header!.id as string, "0")).toEqual(stored);
      // The partial unique index still guards committed keys.
      await expect(
        admin`insert into data_connector_stages (workspace_id, connection_id, connector_id, key, dataset_key, schema_version, metadata, digest, byte_size, source_collected_at, expires_at, committed_at)
          values (${f.workspaceId}, ${f.connectionId}, ${manifest.id}, 'legacy', ${definition.key}, 1, '{}', '', 0, ${NOW}, ${NOW}, ${NOW})`,
      ).rejects.toThrow();
    } finally {
      await app.$client.end({ timeout: 5 });
      await admin.end({ timeout: 5 });
    }
  }, 60_000);
});
