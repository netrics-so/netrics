import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as authSchema from "./auth-schema.js";
import { withWorkspace } from "./context.js";
import {
  findDashboard,
  insertDashboard,
  listDashboards,
  replaceDashboard,
  type TileInput,
} from "./dashboards.js";
import * as schema from "./schema.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

let testDb: TestDatabase;
let admin: postgres.Sql;
let appClient: postgres.Sql;
let db: PostgresJsDatabase<typeof schema & typeof authSchema>;
let workspaceA: string;
let workspaceB: string;
let connectionA: string;
let connectionB: string;

function tile(connectionId: string, overrides: Partial<TileInput> = {}) {
  return {
    connectionId,
    metricKey: "visits",
    aggregation: "sum",
    period: "last_7_days",
    dimensions: {},
    title: null,
    ...overrides,
  };
}

function errorChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
}

async function expectDbError(promise: Promise<unknown>, pattern: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect(errorChain(error)).toMatch(pattern);
    return;
  }
  expect.unreachable("expected the query to fail");
}

const inA = <T>(run: Parameters<typeof withWorkspace<T>>[2]) =>
  withWorkspace(db, { workspaceId: workspaceA }, run);
const inB = <T>(run: Parameters<typeof withWorkspace<T>>[2]) =>
  withWorkspace(db, { workspaceId: workspaceB }, run);

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = postgres(testDb.adminUrl, { max: 1 });
  appClient = postgres(testDb.appUrl, { max: 2 });
  db = drizzle(appClient, { schema: { ...schema, ...authSchema } });
  await admin`insert into connectors (id, version, manifest)
              values ('demo', '1.0.0', '{"id":"demo"}'::jsonb)`;
  const [a] =
    await admin`insert into workspaces (name) values ('A') returning id`;
  const [b] =
    await admin`insert into workspaces (name) values ('B') returning id`;
  workspaceA = a!.id as string;
  workspaceB = b!.id as string;
  const [ca] =
    await admin`insert into connections (workspace_id, connector_id, name)
                           values (${workspaceA}, 'demo', 'A') returning id`;
  const [cb] =
    await admin`insert into connections (workspace_id, connector_id, name)
                           values (${workspaceB}, 'demo', 'B') returning id`;
  connectionA = ca!.id as string;
  connectionB = cb!.id as string;
}, 30_000);

afterAll(async () => {
  await admin.end({ timeout: 5 }).catch(() => undefined);
  await appClient.end({ timeout: 5 }).catch(() => undefined);
});

describe("dashboards", () => {
  it("stores ordered tiles and keeps them to their workspace", async () => {
    const created = await inA((tx) =>
      insertDashboard(tx, workspaceA, {
        name: "Overview",
        projectId: null,
        tiles: [
          tile(connectionA),
          tile(connectionA, { metricKey: "b", period: "today" }),
        ],
      }),
    );
    expect(created.version).toBe(1);
    expect(created.tiles.map((t) => [t.position, t.metricKey])).toEqual([
      [0, "visits"],
      [1, "b"],
    ]);

    // Invisible from workspace B, by RLS and by the explicit predicate.
    expect(await inB((tx) => listDashboards(tx, workspaceB))).toEqual([]);
    expect(
      await inB((tx) => findDashboard(tx, workspaceA, created.id)),
    ).toBeNull();
    expect(
      await inB((tx) => findDashboard(tx, workspaceB, created.id)),
    ).toBeNull();
    const [summary] = await inA((tx) => listDashboards(tx, workspaceA));
    expect(summary).toMatchObject({ name: "Overview", tileCount: 2 });
  });

  it("rejects a tile that points at another workspace's connection", async () => {
    await expectDbError(
      inA((tx) =>
        insertDashboard(tx, workspaceA, {
          name: "Sneaky",
          projectId: null,
          tiles: [tile(connectionB)],
        }),
      ),
      /dashboard_tiles_connection_fk/,
    );
  });

  it("refuses to create a dashboard in another workspace under RLS", async () => {
    await expectDbError(
      inA((tx) =>
        insertDashboard(tx, workspaceB, {
          name: "Foreign",
          projectId: null,
          tiles: [],
        }),
      ),
      /row-level security/,
    );
  });

  it("replaces name and tiles when the version matches, else conflicts", async () => {
    const created = await inA((tx) =>
      insertDashboard(tx, workspaceA, {
        name: "Draft",
        projectId: null,
        tiles: [tile(connectionA)],
      }),
    );
    const first = await inA((tx) =>
      replaceDashboard(tx, workspaceA, created.id, 1, {
        name: "Final",
        projectId: null,
        tiles: [
          tile(connectionA, { metricKey: "x" }),
          tile(connectionA, { metricKey: "y" }),
        ],
      }),
    );
    expect(first.status === "ok" && first.dashboard).toMatchObject({
      name: "Final",
      version: 2,
      tiles: [{ metricKey: "x" }, { metricKey: "y" }],
    });

    // A writer still holding version 1 must not overwrite version 2.
    const stale = await inA((tx) =>
      replaceDashboard(tx, workspaceA, created.id, 1, {
        name: "Stale",
        projectId: null,
        tiles: [],
      }),
    );
    expect(stale).toEqual({ status: "version_conflict", currentVersion: 2 });
    const current = await inA((tx) =>
      findDashboard(tx, workspaceA, created.id),
    );
    expect(current).toMatchObject({ name: "Final", version: 2 });
    expect(current?.tiles).toHaveLength(2);

    // Another workspace cannot even see it.
    expect(
      await inB((tx) =>
        replaceDashboard(tx, workspaceB, created.id, 2, {
          name: "Hijack",
          projectId: null,
          tiles: [],
        }),
      ),
    ).toEqual({ status: "not_found" });
  });

  it("drops a deleted connection's tiles", async () => {
    const [extra] =
      await admin`insert into connections (workspace_id, connector_id, name)
                                values (${workspaceA}, 'demo', 'Temp') returning id`;
    const created = await inA((tx) =>
      insertDashboard(tx, workspaceA, {
        name: "Temp",
        projectId: null,
        tiles: [tile(connectionA), tile(extra!.id as string)],
      }),
    );
    await admin`delete from connections where id = ${extra!.id}`;
    const after = await inA((tx) => findDashboard(tx, workspaceA, created.id));
    expect(after?.tiles.map((t) => t.connectionId)).toEqual([connectionA]);
  });
});
