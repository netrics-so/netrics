import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createWorkspace, withWorkspace } from "./context.js";
import { runMigrations } from "./index.js";
import * as authSchema from "./auth-schema.js";
import * as schema from "./schema.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

function errorChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
}

// drizzle wraps driver errors ("Failed query: ..."); the PostgreSQL message
// lives in the cause chain.
async function expectDbError(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(errorChain(error)).toMatch(pattern);
    return;
  }
  expect.unreachable("expected the query to fail");
}

let testDb: TestDatabase;
let appClient: postgres.Sql;
let db: PostgresJsDatabase<typeof schema & typeof authSchema>;

let ownerA: string;
let ownerB: string;
let workspaceA: string;
let workspaceB: string;
let metricId: string;
let connectionA: string;
let connectionB: string;

const sourceTime = new Date("2026-01-01T00:00:00Z");

function observationRows(connectionId: string, workspaceId: string) {
  return [
    {
      workspaceId,
      connectionId,
      metricDefinitionId: metricId,
      sourceTimestamp: sourceTime,
      value: 1,
      sourceIdentity: "series-1:2026-01-01",
    },
    {
      workspaceId,
      connectionId,
      metricDefinitionId: metricId,
      sourceTimestamp: new Date("2026-01-01T01:00:00Z"),
      value: 2,
      sourceIdentity: "series-1:2026-01-01T01",
    },
  ];
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  appClient = postgres(testDb.appUrl);
  db = drizzle(appClient, { schema: { ...schema, ...authSchema } });

  const [userA, userB] = await db
    .insert(schema.users)
    .values([
      { email: "conn-a@example.com", displayName: "Owner A" },
      { email: "conn-b@example.com", displayName: "Owner B" },
    ])
    .returning({ id: schema.users.id });
  ownerA = userA!.id;
  ownerB = userB!.id;

  workspaceA = await createWorkspace(db, {
    name: "Workspace A",
    ownerUserId: ownerA,
  });
  workspaceB = await createWorkspace(db, {
    name: "Workspace B",
    ownerUserId: ownerB,
  });

  // Installation-level catalog rows (no RLS).
  await db.insert(schema.connectors).values({
    id: "demo",
    version: "1.0.0",
    manifest: { id: "demo" },
  });
  const [metric] = await db
    .insert(schema.metricDefinitions)
    .values({
      connectorId: "demo",
      key: "requests",
      name: "Requests",
      description: "Request count",
      kind: "counter",
      unit: "count",
      dimensions: ["route"],
      aggregations: ["sum"],
    })
    .returning({ id: schema.metricDefinitions.id });
  metricId = metric!.id;

  connectionA = await withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
    tx
      .insert(schema.connections)
      .values({ workspaceId: workspaceA, connectorId: "demo", name: "A conn" })
      .returning({ id: schema.connections.id })
      .then((rows) => rows[0]!.id),
  );
  connectionB = await withWorkspace(db, { workspaceId: workspaceB }, (tx) =>
    tx
      .insert(schema.connections)
      .values({ workspaceId: workspaceB, connectorId: "demo", name: "B conn" })
      .returning({ id: schema.connections.id })
      .then((rows) => rows[0]!.id),
  );

  await withWorkspace(db, { workspaceId: workspaceA }, async (tx) => {
    await tx.insert(schema.connectionState).values({
      connectionId: connectionA,
      workspaceId: workspaceA,
      nextDueAt: new Date("2026-01-02T00:00:00Z"),
    });
    await tx
      .insert(schema.observations)
      .values(observationRows(connectionA, workspaceA));
    await tx.insert(schema.syncRuns).values({
      workspaceId: workspaceA,
      connectionId: connectionA,
      mode: "incremental",
      requestedFrom: sourceTime,
      requestedTo: new Date("2026-01-02T00:00:00Z"),
      attempt: 1,
      status: "succeeded",
      startedAt: sourceTime,
      finishedAt: new Date("2026-01-01T00:01:00Z"),
      observationsWritten: 2,
    });
  });
  await withWorkspace(db, { workspaceId: workspaceB }, async (tx) => {
    await tx.insert(schema.connectionState).values({
      connectionId: connectionB,
      workspaceId: workspaceB,
    });
    await tx
      .insert(schema.observations)
      .values(observationRows(connectionB, workspaceB));
  });
}, 30_000);

afterAll(async () => {
  await appClient.end({ timeout: 5 }).catch(() => undefined);
});

describe("tenant RLS on the connector/metrics tables", () => {
  it("scopes every tenant table to the current workspace", async () => {
    await withWorkspace(db, { workspaceId: workspaceA }, async (tx) => {
      const connections = await tx.select().from(schema.connections);
      expect(connections.map((c) => c.id)).toEqual([connectionA]);

      const states = await tx.select().from(schema.connectionState);
      expect(states.map((s) => s.connectionId)).toEqual([connectionA]);

      const observations = await tx.select().from(schema.observations);
      expect(observations).toHaveLength(2);
      expect(observations.every((o) => o.workspaceId === workspaceA)).toBe(
        true,
      );

      const syncRuns = await tx.select().from(schema.syncRuns);
      expect(syncRuns).toHaveLength(1);
      expect(syncRuns[0]!.connectionId).toBe(connectionA);
    });

    await withWorkspace(db, { workspaceId: workspaceB }, async (tx) => {
      expect(await tx.select().from(schema.syncRuns)).toHaveLength(0);
      const observations = await tx.select().from(schema.observations);
      expect(observations.every((o) => o.connectionId === connectionB)).toBe(
        true,
      );
    });
  });

  it("returns zero rows on tenant tables with no context at all", async () => {
    expect(await db.select().from(schema.connections)).toHaveLength(0);
    expect(await db.select().from(schema.connectionState)).toHaveLength(0);
    expect(await db.select().from(schema.observations)).toHaveLength(0);
    expect(await db.select().from(schema.syncRuns)).toHaveLength(0);
  });

  it("rejects inserts carrying a foreign workspace_id", async () => {
    await expectDbError(
      withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
        tx.insert(schema.connections).values({
          workspaceId: workspaceB,
          connectorId: "demo",
          name: "smuggled",
        }),
      ),
      /row-level security/,
    );
    await expectDbError(
      withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
        tx.insert(schema.connectionState).values({
          connectionId: connectionA,
          workspaceId: workspaceB,
        }),
      ),
      /row-level security/,
    );
    await expectDbError(
      withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
        tx.insert(schema.observations).values({
          workspaceId: workspaceB,
          connectionId: connectionA,
          metricDefinitionId: metricId,
          sourceTimestamp: sourceTime,
          value: 9,
          sourceIdentity: "smuggled",
        }),
      ),
      /row-level security/,
    );
  });

  it("keeps installation-level catalogs visible without a tenant context", async () => {
    const connectors = await db.select().from(schema.connectors);
    expect(connectors.map((c) => c.id)).toEqual(["demo"]);
    const metrics = await db.select().from(schema.metricDefinitions);
    expect(metrics.map((m) => m.key)).toEqual(["requests"]);
  });

  it("defaults auth_state and consecutive_failures on connection_state", async () => {
    await withWorkspace(db, { workspaceId: workspaceA }, async (tx) => {
      const states = await tx.select().from(schema.connectionState);
      expect(states[0]!.authState).toBe("ok");
      expect(states[0]!.consecutiveFailures).toBe(0);
    });
  });
});

describe("observation idempotent ingestion", () => {
  it("ON CONFLICT (connection_id, source_identity) DO NOTHING dedupes re-ingestion", async () => {
    const rows = observationRows(connectionA, workspaceA).map((row, index) => ({
      ...row,
      sourceIdentity: `replay:${index}`,
      value: 100 + index,
    }));

    await withWorkspace(db, { workspaceId: workspaceA }, async (tx) => {
      await tx.insert(schema.observations).values(rows);
      const [beforeRow] = await tx.execute<{ count: string }>(
        sql`select count(*)::text as count from observations where connection_id = ${connectionA}`,
      );
      expect(Number(beforeRow!.count)).toBe(4);

      // Re-ingest the exact same source identities with different values:
      // the unique key makes every row a no-op.
      await tx
        .insert(schema.observations)
        .values(rows.map((row) => ({ ...row, value: -1 })))
        .onConflictDoNothing({
          target: [
            schema.observations.connectionId,
            schema.observations.sourceIdentity,
          ],
        });
      const [afterRow] = await tx.execute<{ count: string }>(
        sql`select count(*)::text as count from observations where connection_id = ${connectionA}`,
      );
      expect(Number(afterRow!.count)).toBe(4);

      const replayed = await tx
        .select()
        .from(schema.observations)
        .where(sql`source_identity like 'replay:%'`);
      expect(replayed.map((row) => row.value).sort()).toEqual([100, 101]);
    });
  });
});

describe("migration idempotency", () => {
  it("applies the full migration chain twice on the same database", async () => {
    await expect(runMigrations(testDb.adminUrl)).resolves.toBeUndefined();
  });
});
