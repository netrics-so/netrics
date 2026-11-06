import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  sourceDatasetSchema,
  type DatasetPage,
  type SourceDatasetDefinition,
} from "@netrics/contracts";

import * as auth from "./auth-schema.js";
import {
  findConnectionRetention,
  setConnectionRetention,
} from "./connection-retention.js";
import { withWorkspace, type Db } from "./context.js";
import { adminSetDataPolicy } from "./data-policy.js";
import { storeConnectorStage } from "./connector-staging.js";
import { ingestDatasetPage } from "./datasets.js";
import * as schema from "./schema.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

const DAY = 86_400_000;

/** A dataset with one personal field the connector keeps until deleted. */
function personalDataset(key = "earnings"): SourceDatasetDefinition {
  return sourceDatasetSchema.parse({
    key,
    name: key,
    version: 1,
    keyFields: ["id"],
    grain: "one row",
    mode: "upsert",
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
        id: "buyer",
        name: "Buyer",
        type: "string",
        nullable: false,
        classification: "personal",
        retentionDays: null,
      },
    ],
  });
}

function page(
  definition: SourceDatasetDefinition,
  refreshKey: string,
  ids: string[],
): DatasetPage {
  return {
    datasetKey: definition.key,
    schemaVersion: definition.version,
    refreshKey,
    pageKey: "p1",
    previousPageKey: null,
    complete: true,
    records: ids.map((id) => ({ values: { id, buyer: `buyer-${id}` } })),
  };
}

function connect(test: TestDatabase) {
  const client = postgres(test.appUrl, { max: 2 });
  return { client, db: drizzle(client, { schema: { ...schema, ...auth } }) };
}

function ingest(
  db: Db,
  workspaceId: string,
  connectionId: string,
  definition: SourceDatasetDefinition,
  p: DatasetPage,
  now: Date,
) {
  return withWorkspace(db, { workspaceId }, (tx) =>
    ingestDatasetPage(tx, {
      workspaceId,
      connectionId,
      definition,
      page: p,
      now,
    }),
  );
}

async function deadlines(admin: postgres.Sql, connectionId: string) {
  const rows = await admin`
    select r.values->>'id' as id, r.collected_at, r.expires_at
    from data_records r
    join data_generations g on g.id = r.generation_id
    join data_datasets d on d.id = g.dataset_id
    where d.connection_id = ${connectionId}
      and g.sequence = (select max(sequence) from data_generations where dataset_id = d.id)
    order by 1`;
  return Object.fromEntries(
    rows.map((row) => [
      row.id as string,
      {
        collectedAt: row.collected_at as Date,
        expiresAt: row.expires_at as Date | null,
      },
    ]),
  );
}

describe("existing connections (migration 0061)", () => {
  let test: TestDatabase, admin: postgres.Sql;
  let workspaceId: string, withData: string, withoutData: string;

  beforeAll(async () => {
    test = await createTestDatabase({
      upTo: "0060_superseded_generation_release",
    });
    admin = postgres(test.adminUrl, { max: 1 });
    const [ws] =
      await admin`insert into workspaces(name) values ('Before') returning id`;
    workspaceId = ws!.id as string;
    await admin`insert into connectors(id,version,manifest) values ('retention-fixture','1.0.0','{}')`;
    const rows = await admin`
      insert into connections(workspace_id,connector_id,name)
      values (${workspaceId},'retention-fixture','With data'),
             (${workspaceId},'retention-fixture','Without data')
      returning id`;
    withData = rows[0]!.id as string;
    withoutData = rows[1]!.id as string;
    // Registered datasets in the shape the engine stores them: a personal
    // field kept until deleted, and a dataset declaring 45 days.
    const short = { ...personalDataset("short"), retentionDays: 45 };
    for (const definition of [personalDataset("earnings"), short]) {
      const [dataset] = await admin`
        insert into data_datasets(workspace_id,connection_id,key,name)
        values (${workspaceId},${withData},${definition.key},${definition.name})
        returning id`;
      await admin`
        insert into data_schema_versions(dataset_id,workspace_id,version,definition)
        values (${dataset!.id as string},${workspaceId},1,${admin.json(definition)})`;
    }
    await test.migrate();
  }, 60_000);

  afterAll(async () => {
    await admin?.end({ timeout: 5 });
  });

  it("records the current effective retention without cutting personal data to 90 days", async () => {
    const rows = await admin`
      select id, retention_choice, retention_fallback, retention_basis,
             retention_chosen_by, retention_chosen_at
      from connections order by name`;
    const byId = new Map(rows.map((row) => [row.id as string, row]));
    const migrated = byId.get(withData)!;
    expect(migrated.retention_choice).toEqual({ earnings: null, short: 45 });
    expect(migrated.retention_fallback).toBe("connector");
    expect(migrated.retention_basis).toBe("migrated");
    expect(migrated.retention_chosen_by).toBeNull();
    expect(migrated.retention_chosen_at).toBeInstanceOf(Date);
    const empty = byId.get(withoutData)!;
    expect(empty.retention_choice).toEqual({});
    expect(empty.retention_fallback).toBe("connector");
    expect(empty.retention_basis).toBe("migrated");
  });

  it("keeps ingesting existing connections with the connector default and presets new ones", async () => {
    const { client, db } = connect(test);
    try {
      const now = new Date();
      // A dataset the migrated connection had not registered yet.
      const later = personalDataset("later");
      await ingest(
        db,
        workspaceId,
        withoutData,
        later,
        page(later, "r1", ["a"]),
        now,
      );
      expect((await deadlines(admin, withoutData)).a!.expiresAt).toBeNull();

      const [created] = await admin`
        insert into connections(workspace_id,connector_id,name)
        values (${workspaceId},'retention-fixture','New') returning id`;
      const fresh = created!.id as string;
      const record = await withWorkspace(db, { workspaceId }, (tx) =>
        findConnectionRetention(tx, workspaceId, fresh),
      );
      expect(record).toMatchObject({
        choice: {},
        fallback: "preset",
        basis: "preset",
        chosenAt: null,
        chosenBy: null,
      });
      await ingest(
        db,
        workspaceId,
        fresh,
        later,
        page(later, "r1", ["a"]),
        now,
      );
      expect((await deadlines(admin, fresh)).a!.expiresAt).toEqual(
        new Date(now.getTime() + 90 * DAY),
      );
    } finally {
      await client.end({ timeout: 5 });
    }
  });
});

describe("choosing a connection's retention", () => {
  let test: TestDatabase, admin: postgres.Sql, client: postgres.Sql, db: Db;
  let a: string, b: string, userId: string;

  beforeAll(async () => {
    test = await createTestDatabase();
    admin = postgres(test.adminUrl, { max: 1 });
    const ws = await admin`
      insert into workspaces(name) values ('A'),('B') returning id`;
    a = ws[0]!.id as string;
    b = ws[1]!.id as string;
    const [user] = await admin`
      insert into users(email,display_name) values ('ada@example.com','Ada') returning id`;
    userId = user!.id as string;
    await admin`insert into connectors(id,version,manifest) values ('retention-fixture','1.0.0','{}')`;
    ({ client, db } = connect(test));
  }, 60_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await admin?.end({ timeout: 5 });
  });

  async function connection(workspaceId: string): Promise<string> {
    const [row] = await admin`
      insert into connections(workspace_id,connector_id,name)
      values (${workspaceId},'retention-fixture','C') returning id`;
    return row!.id as string;
  }

  function choose(
    workspaceId: string,
    connectionId: string,
    days: Record<string, number | null>,
    effective = days,
    context = workspaceId,
  ) {
    return withWorkspace(db, { workspaceId: context }, (tx) =>
      setConnectionRetention(tx, {
        workspaceId,
        connectionId,
        choice: days,
        chosenBy: userId,
        effective,
      }),
    );
  }

  it("shortens stored deadlines at once and never revives expired data", async () => {
    const connectionId = await connection(a);
    const definition = personalDataset();
    const now = Date.now();
    const old = new Date(now - 20 * DAY);
    await ingest(
      db,
      a,
      connectionId,
      definition,
      page(definition, "r1", ["old"]),
      old,
    );
    const current = new Date(now - 1000);
    await ingest(
      db,
      a,
      connectionId,
      definition,
      page(definition, "r2", ["new"]),
      current,
    );
    let rows = await deadlines(admin, connectionId);
    expect(rows.old!.expiresAt).toEqual(new Date(old.getTime() + 90 * DAY));
    expect(rows.new!.expiresAt).toEqual(new Date(current.getTime() + 90 * DAY));

    expect(await choose(a, connectionId, { earnings: 10 })).toBe(true);
    rows = await deadlines(admin, connectionId);
    expect(rows.old!.expiresAt).toEqual(new Date(old.getTime() + 10 * DAY));
    expect(rows.new!.expiresAt).toEqual(new Date(current.getTime() + 10 * DAY));
    const [generation] = await admin`
      select g.expires_at from data_generations g
      join data_datasets d on d.id = g.dataset_id
      where d.connection_id = ${connectionId} order by g.sequence desc limit 1`;
    expect((generation!.expires_at as Date).getTime()).toBeLessThanOrEqual(
      now + 10 * DAY + 5000,
    );

    // Until deleted: the unexpired record is kept, the expired one is not revived.
    expect(await choose(a, connectionId, { earnings: null })).toBe(true);
    rows = await deadlines(admin, connectionId);
    expect(rows.old!.expiresAt).toEqual(new Date(old.getTime() + 10 * DAY));
    expect(rows.new!.expiresAt).toBeNull();

    const record = await withWorkspace(db, { workspaceId: a }, (tx) =>
      findConnectionRetention(tx, a, connectionId),
    );
    expect(record).toMatchObject({
      choice: { earnings: null },
      basis: "chosen",
      chosenBy: { id: userId, name: "Ada" },
    });
    expect(record!.chosenAt).toBeInstanceOf(Date);
  });

  it("uses the choice for later ingestion", async () => {
    const connectionId = await connection(a);
    const definition = personalDataset();
    expect(await choose(a, connectionId, { earnings: 400 })).toBe(true);
    const now = new Date();
    await ingest(
      db,
      a,
      connectionId,
      definition,
      page(definition, "r1", ["x"]),
      now,
    );
    expect((await deadlines(admin, connectionId)).x!.expiresAt).toEqual(
      new Date(now.getTime() + 400 * DAY),
    );
  });

  it("lets the workspace maximum win over a longer choice", async () => {
    const workspace = (
      await admin`insert into workspaces(name) values ('Capped') returning id`
    )[0]!.id as string;
    const connectionId = await connection(workspace);
    const definition = personalDataset();
    const now = new Date();
    await ingest(
      db,
      workspace,
      connectionId,
      definition,
      page(definition, "r1", ["x"]),
      now,
    );
    await withWorkspace(db, { workspaceId: workspace }, (tx) =>
      adminSetDataPolicy(tx, workspace, { maxRetentionDays: 5 }),
    );
    // Even an uncapped value from the caller is capped in the database.
    expect(await choose(workspace, connectionId, { earnings: null })).toBe(
      true,
    );
    expect((await deadlines(admin, connectionId)).x!.expiresAt).toEqual(
      new Date(now.getTime() + 5 * DAY),
    );
    const later = new Date(now.getTime() + 1000);
    await ingest(
      db,
      workspace,
      connectionId,
      definition,
      page(definition, "r2", ["y"]),
      later,
    );
    expect((await deadlines(admin, connectionId)).y!.expiresAt).toEqual(
      new Date(later.getTime() + 5 * DAY),
    );
  });

  it("waits for an in-flight ingestion so its records get the new deadline", async () => {
    const connectionId = await connection(a);
    const definition = personalDataset();
    expect(await choose(a, connectionId, { earnings: null })).toBe(true);
    const collected = new Date();
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let ingested!: () => void;
    const pageIngested = new Promise<void>((resolve) => (ingested = resolve));
    // A sync page that has read "until deleted" and written its records,
    // but not committed yet.
    const sync = withWorkspace(db, { workspaceId: a }, async (tx) => {
      await ingestDatasetPage(tx, {
        workspaceId: a,
        connectionId,
        definition,
        page: page(definition, "r1", ["x"]),
        now: collected,
      });
      ingested();
      await released;
    });
    await pageIngested;
    const shortened = choose(a, connectionId, { earnings: 1 });
    // The update must not finish (and miss the page) while the page is open.
    const finishedFirst = await Promise.race([
      shortened.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    release();
    await sync;
    expect(await shortened).toBe(true);
    expect((await deadlines(admin, connectionId)).x!.expiresAt).toEqual(
      new Date(collected.getTime() + DAY),
    );
    expect(finishedFirst).toBe(false);
  });

  it("counts days as fixed 24 hours, like ingestion, whatever the session time zone", async () => {
    const connectionId = await connection(a);
    const definition = personalDataset();
    // Berlin leaves summer time on 2026-10-25: a calendar day there is 25 hours.
    const collected = new Date("2026-10-24T12:00:00Z");
    await ingest(
      db,
      a,
      connectionId,
      definition,
      page(definition, "r1", ["x"]),
      collected,
    );
    const berlin = postgres(test.appUrl, {
      max: 1,
      connection: { TimeZone: "Europe/Berlin" },
    });
    try {
      const local = drizzle(berlin, { schema: { ...schema, ...auth } });
      await withWorkspace(local, { workspaceId: a }, (tx) =>
        setConnectionRetention(tx, {
          workspaceId: a,
          connectionId,
          choice: { earnings: 30 },
          chosenBy: userId,
          effective: { earnings: 30 },
        }),
      );
    } finally {
      await berlin.end({ timeout: 5 });
    }
    expect((await deadlines(admin, connectionId)).x!.expiresAt).toEqual(
      new Date(collected.getTime() + 30 * DAY),
    );
  });

  it("applies to staged reports of datasets not registered yet", async () => {
    const connectionId = await connection(a);
    const definition = personalDataset();
    // An initial sync has staged a report but not ingested the dataset.
    await withWorkspace(db, { workspaceId: a }, (tx) =>
      storeConnectorStage(
        tx,
        { workspaceId: a, connectionId, connectorId: "retention-fixture" },
        {
          key: "report-1",
          metadata: { object: "earnings.csv" },
          pages: [page(definition, "r1", ["x"])],
        },
        definition,
      ),
    );
    const stage = async () =>
      (
        await admin`
          select source_collected_at, source_expires_at, expires_at
          from data_connector_stages where connection_id = ${connectionId}`
      )[0]!;
    const before = await stage();
    expect(before.source_expires_at).toEqual(
      new Date((before.source_collected_at as Date).getTime() + 90 * DAY),
    );
    expect(await choose(a, connectionId, { earnings: null })).toBe(true);
    const kept = await stage();
    expect(kept.source_expires_at).toBeNull();
    // The cache lifetime itself is never extended.
    expect(kept.expires_at).toEqual(before.expires_at);
    expect(await choose(a, connectionId, { earnings: 2 })).toBe(true);
    expect((await stage()).source_expires_at).toEqual(
      new Date((before.source_collected_at as Date).getTime() + 2 * DAY),
    );
  });

  it("cannot read or change another workspace's connection", async () => {
    const connectionId = await connection(a);
    const definition = personalDataset();
    const now = new Date();
    await ingest(
      db,
      a,
      connectionId,
      definition,
      page(definition, "r1", ["x"]),
      now,
    );
    const before = await deadlines(admin, connectionId);

    // Workspace B's context naming A's connection: RLS hides the row.
    expect(await choose(a, connectionId, { earnings: 1 }, undefined, b)).toBe(
      false,
    );
    expect(
      await withWorkspace(db, { workspaceId: b }, (tx) =>
        findConnectionRetention(tx, a, connectionId),
      ),
    ).toBeNull();
    // The definer function refuses a workspace other than the current one,
    // and a connection outside the named workspace.
    await expect(
      withWorkspace(db, { workspaceId: b }, (tx) =>
        tx.execute(
          sql`select apply_connection_retention(${a}::uuid, ${connectionId}::uuid, '{"earnings":1}'::jsonb, now())`,
        ),
      ),
    ).rejects.toThrow();
    const [refused] = await withWorkspace(db, { workspaceId: b }, (tx) =>
      tx.execute<{ applied: boolean }>(
        sql`select apply_connection_retention(${b}::uuid, ${connectionId}::uuid, '{"earnings":1}'::jsonb, now()) as applied`,
      ),
    );
    expect(refused!.applied).toBe(false);
    expect(await deadlines(admin, connectionId)).toEqual(before);
  });
});
