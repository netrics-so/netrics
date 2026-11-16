import { readFileSync } from "node:fs";
import path from "node:path";

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as authSchema from "./auth-schema.js";
import { withWorkspace } from "./context.js";
import {
  listConnectionFreshness,
  recordConnectionFreshness,
  type ConnectionFreshnessInput,
} from "./freshness.js";
import { migrationsFolder } from "./index.js";
import * as schema from "./schema.js";
import {
  createTestDatabase,
  type TestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// connection_freshness (ADR 0025 §4, #702) as netrics_app under RLS.

const T1 = new Date("2031-03-15T09:00:00.000Z");
const T2 = new Date("2031-03-15T15:00:00.000Z");
const T3 = new Date("2031-03-15T21:00:00.000Z");

let testDb: TestDatabase;
let admin: postgres.Sql;
let appClient: postgres.Sql;
let db: PostgresJsDatabase<typeof schema & typeof authSchema>;
let workspaceA: string;
let workspaceB: string;
let connectionA: string;
let connectionB: string;

const sales = (
  dataThrough: string | null,
  extra: Partial<ConnectionFreshnessInput> = {},
): ConnectionFreshnessInput => ({
  stream: "sales",
  resource: "",
  dataThrough,
  timeZone: dataThrough ? "America/Los_Angeles" : null,
  expectedFrom: null,
  nextExpectedAt: null,
  ...extra,
});

const record = (
  entries: ConnectionFreshnessInput[],
  checkedAt: Date,
  workspaceId = workspaceA,
  connectionId = connectionA,
) =>
  withWorkspace(db, { workspaceId }, (tx) =>
    recordConnectionFreshness(tx, {
      workspaceId,
      connectionId,
      entries,
      checkedAt,
    }),
  );

const list = (workspaceId = workspaceA, connectionId = connectionA) =>
  withWorkspace(db, { workspaceId }, (tx) =>
    listConnectionFreshness(tx, workspaceId, connectionId),
  );

async function connection(workspaceId: string): Promise<string> {
  const [row] = await admin`
    insert into connections (workspace_id, connector_id, name)
    values (${workspaceId}, 'acme', 'Acme') returning id`;
  return row!.id as string;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = postgres(testDb.adminUrl, { max: 1, onnotice: () => undefined });
  appClient = postgres(testDb.appUrl, { max: 2 });
  db = drizzle(appClient, { schema: { ...schema, ...authSchema } });
  await admin`insert into connectors (id, version, manifest)
              values ('acme', '1.0.0', '{"id":"acme"}'::jsonb)`;
  const [a] =
    await admin`insert into workspaces (name) values ('A') returning id`;
  const [b] =
    await admin`insert into workspaces (name) values ('B') returning id`;
  workspaceA = a!.id as string;
  workspaceB = b!.id as string;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await appClient?.end({ timeout: 5 });
  await admin?.end({ timeout: 5 });
});

beforeEach(async () => {
  await admin`delete from connections`;
  connectionA = await connection(workspaceA);
  connectionB = await connection(workspaceB);
});

describe("recordConnectionFreshness", () => {
  it("stores one row per stream and resource", async () => {
    await record(
      [
        sales("2031-03-13", {
          expectedFrom: new Date("2031-03-15T18:00:00.000Z"),
          nextExpectedAt: new Date("2031-03-15T20:00:00.000Z"),
        }),
        sales("2031-03-12", { resource: "app-1" }),
        {
          stream: "reviews",
          resource: "",
          dataThrough: null,
          timeZone: null,
          expectedFrom: null,
          nextExpectedAt: null,
        },
      ],
      T1,
    );
    const rows = await list();
    expect(
      rows.map((row) => [row.stream, row.resource, row.dataThrough]),
    ).toEqual([
      ["reviews", "", null],
      ["sales", "", "2031-03-13"],
      ["sales", "app-1", "2031-03-12"],
    ]);
    const [, connectionRow] = rows;
    expect(connectionRow).toMatchObject({
      workspaceId: workspaceA,
      timeZone: "America/Los_Angeles",
      expectedFrom: new Date("2031-03-15T18:00:00.000Z"),
      nextExpectedAt: new Date("2031-03-15T20:00:00.000Z"),
      checkedAt: T1,
      advancedAt: T1,
    });
    expect(rows[0]).toMatchObject({ checkedAt: T1, advancedAt: null });
  });

  it("moves data_through forward with every field and advanced_at", async () => {
    await record([sales("2031-03-13")], T1);
    await record(
      [
        sales("2031-03-14", {
          nextExpectedAt: new Date("2031-03-16T20:00:00.000Z"),
        }),
      ],
      T2,
    );
    expect(await list()).toEqual([
      expect.objectContaining({
        dataThrough: "2031-03-14",
        nextExpectedAt: new Date("2031-03-16T20:00:00.000Z"),
        checkedAt: T2,
        advancedAt: T2,
      }),
    ]);
  });

  it("never moves data_through back: only checked_at follows", async () => {
    const next = new Date("2031-03-15T20:00:00.000Z");
    await record([sales("2031-03-14", { nextExpectedAt: next })], T1);
    await record(
      [
        sales("2031-03-12", {
          timeZone: "UTC",
          nextExpectedAt: new Date("2031-03-13T20:00:00.000Z"),
        }),
      ],
      T2,
    );
    await record([sales(null)], T3);
    expect(await list()).toEqual([
      expect.objectContaining({
        dataThrough: "2031-03-14",
        timeZone: "America/Los_Angeles",
        nextExpectedAt: next,
        checkedAt: T3,
        advancedAt: T1,
      }),
    ]);
  });

  it("keeps advanced_at but takes new expected times for the same day", async () => {
    await record([sales("2031-03-14")], T1);
    const later = new Date("2031-03-15T22:00:00.000Z");
    await record([sales("2031-03-14", { nextExpectedAt: later })], T2);
    expect(await list()).toEqual([
      expect.objectContaining({
        nextExpectedAt: later,
        checkedAt: T2,
        advancedAt: T1,
      }),
    ]);
  });

  it("leaves rows the run did not report (a partial run)", async () => {
    await record(
      [sales("2031-03-13"), sales("2031-03-13", { resource: "app-1" })],
      T1,
    );
    await record([sales("2031-03-14")], T2);
    const rows = await list();
    expect(rows.map((row) => [row.resource, row.checkedAt])).toEqual([
      ["", T2],
      ["app-1", T1],
    ]);
  });
});

describe("tenancy", () => {
  it("shows a workspace only its own rows", async () => {
    await record([sales("2031-03-13")], T1);
    await record([sales("2031-03-10")], T1, workspaceB, connectionB);
    expect(await list(workspaceA, connectionB)).toEqual([]);
    expect(
      await withWorkspace(db, { workspaceId: workspaceB }, (tx) =>
        tx.select().from(schema.connectionFreshness),
      ),
    ).toEqual([expect.objectContaining({ connectionId: connectionB })]);
    expect(await db.select().from(schema.connectionFreshness)).toEqual([]);
  });

  it("refuses writing rows into another workspace", async () => {
    await expect(
      withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
        recordConnectionFreshness(tx, {
          workspaceId: workspaceB,
          connectionId: connectionB,
          entries: [sales("2031-03-13")],
          checkedAt: T1,
        }),
      ),
    ).rejects.toThrow();
    expect(
      await admin`select count(*)::int as n from connection_freshness`,
    ).toEqual([{ n: 0 }]);
  });

  it("refuses a row of one workspace's connection under another workspace", async () => {
    // The composite key pins the row to the connection's workspace.
    await expect(
      admin`insert into connection_freshness
              (workspace_id, connection_id, stream, checked_at)
            values (${workspaceB}, ${connectionA}, 'sales', now())`,
    ).rejects.toThrow(/connection_freshness_connection_fk/);
  });

  it("deletes the rows with the connection", async () => {
    await record([sales("2031-03-13")], T1);
    await admin`delete from connections where id = ${connectionA}`;
    expect(
      await admin`select count(*)::int as n from connection_freshness`,
    ).toEqual([{ n: 0 }]);
  });

  it("checks the zone goes with the date and the expected order", async () => {
    await expect(
      admin`insert into connection_freshness
              (workspace_id, connection_id, stream, data_through, checked_at)
            values (${workspaceA}, ${connectionA}, 'sales', '2031-03-13', now())`,
    ).rejects.toThrow(/connection_freshness_zone_with_date/);
    await expect(
      admin`insert into connection_freshness
              (workspace_id, connection_id, stream, expected_from, checked_at)
            values (${workspaceA}, ${connectionA}, 'sales', now(), now())`,
    ).rejects.toThrow(/connection_freshness_expected_order/);
  });
});

describe("migration", () => {
  it("adds an empty table under forced RLS to a database with connections", async () => {
    const journal = JSON.parse(
      readFileSync(
        path.join(migrationsFolder, "meta", "_journal.json"),
        "utf8",
      ),
    ) as { entries: Array<{ tag: string }> };
    const index = journal.entries.findIndex((entry) =>
      entry.tag.endsWith("_connection_freshness"),
    );
    expect(index).toBeGreaterThan(0);
    const previous = await createTestDatabase({
      upTo: journal.entries[index - 1]!.tag,
    });
    const owner = postgres(previous.adminUrl, {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await owner`insert into connectors (id, version, manifest)
                  values ('c', '1.0.0', '{"id":"c"}'::jsonb)`;
      const [workspace] =
        await owner`insert into workspaces (name) values ('W') returning id`;
      await owner`insert into connections (workspace_id, connector_id, name)
                  values (${workspace!.id as string}, 'c', 'C')`;
      await owner`insert into connection_state (connection_id, workspace_id, next_due_at)
                  select id, workspace_id, now() from connections`;
      await previous.migrate();
      const [{ count }] = (await owner`
        select count(*)::int as count from connection_state`) as unknown as [
        { count: number },
      ];
      expect(count).toBe(1);
      const [table] = await owner`
        select relrowsecurity, relforcerowsecurity from pg_class
        where relname = 'connection_freshness'`;
      expect(table).toEqual({
        relrowsecurity: true,
        relforcerowsecurity: true,
      });
      // The scheduler keeps reading connection_state only (ADR 0025 §5).
      const [grant] = await owner`
        select has_table_privilege('netrics_scheduler', 'connection_freshness', 'select') as scheduler,
               has_table_privilege('netrics_app', 'connection_freshness', 'insert, update, delete') as app`;
      expect(grant).toEqual({ scheduler: false, app: true });
    } finally {
      await owner.end({ timeout: 5 });
    }
  }, 60_000);
});
