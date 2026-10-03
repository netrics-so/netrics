import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as authSchema from "./auth-schema.js";
import { withWorkspace } from "./context.js";
import {
  connectionHasResource,
  connectionResourcesDiscoveredAt,
  findConnectionResourceNoun,
  findResourceNames,
  listMetricResources,
  resourceNameKey,
  upsertConnectionResources,
} from "./resources.js";
import * as schema from "./schema.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

// Resource names of a connection (#194), as netrics_app under RLS.

let testDb: TestDatabase;
let admin: postgres.Sql;
let appClient: postgres.Sql;
let db: PostgresJsDatabase<typeof schema & typeof authSchema>;
let workspaceA: string;
let workspaceB: string;
let connectionA: string;
let selective: string;
let connectionB: string;

async function observe(
  workspaceId: string,
  connectionId: string,
  metricKey: string,
  dimensions: Record<string, string>,
) {
  await admin`
    insert into observations (workspace_id, connection_id, metric_definition_id,
      dimensions, source_timestamp, value)
    select ${workspaceId}, ${connectionId}, m.id, ${admin.json(dimensions)},
           '2026-09-01T00:00:00Z'::timestamptz, 1
    from metric_definitions m where m.connector_id = 'demo' and m.key = ${metricKey}`;
}

const inA = <T>(run: Parameters<typeof withWorkspace<T>>[2]) =>
  withWorkspace(db, { workspaceId: workspaceA }, run);

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = postgres(testDb.adminUrl, { max: 1 });
  appClient = postgres(testDb.appUrl, { max: 2 });
  db = drizzle(appClient, { schema: { ...schema, ...authSchema } });

  await admin`insert into connectors (id, version, manifest)
              values ('demo', '1.0.0', '{"id":"demo"}'::jsonb)`;
  await admin`
    insert into metric_definitions (connector_id, key, name, description, kind,
      unit, granularity, dimensions, aggregations)
    values
      ('demo', 'downloads', 'Downloads', 'Downloads', 'delta', 'count', 'day',
       '["resource"]', '["sum"]'),
      ('demo', 'impressions', 'Impressions', 'Impressions', 'delta', 'count',
       'day', '["resource"]', '["sum"]')`;
  const [a] =
    await admin`insert into workspaces (name) values ('A') returning id`;
  const [b] =
    await admin`insert into workspaces (name) values ('B') returning id`;
  workspaceA = a!.id as string;
  workspaceB = b!.id as string;
  const [ca] = await admin`
    insert into connections (workspace_id, connector_id, name)
    values (${workspaceA}, 'demo', 'Apps') returning id`;
  const [cs] = await admin`
    insert into connections (workspace_id, connector_id, name, config)
    values (${workspaceA}, 'demo', 'Selected apps',
            ${admin.json({ resourceSelection: ["app-1"] })}) returning id`;
  const [cb] = await admin`
    insert into connections (workspace_id, connector_id, name)
    values (${workspaceB}, 'demo', 'Other') returning id`;
  connectionA = ca!.id as string;
  selective = cs!.id as string;
  connectionB = cb!.id as string;

  await observe(workspaceA, connectionA, "downloads", { resource: "app-1" });
  await observe(workspaceA, connectionA, "downloads", { resource: "app-2" });
  // Data without a name yet, and of another metric only.
  await observe(workspaceA, connectionA, "downloads", { resource: "app-9" });
  await observe(workspaceA, connectionA, "impressions", { resource: "app-3" });
  await observe(workspaceB, connectionB, "downloads", { resource: "app-b" });
}, 60_000);

afterAll(async () => {
  await appClient.end({ timeout: 5 });
  await admin.end({ timeout: 5 });
});

describe("connection resources", () => {
  it("records discovered names and refreshes them", async () => {
    expect(
      await inA((tx) =>
        connectionResourcesDiscoveredAt(tx, workspaceA, connectionA),
      ),
    ).toBeNull();
    await inA((tx) =>
      upsertConnectionResources(tx, {
        workspaceId: workspaceA,
        connectionId: connectionA,
        resources: [
          { id: "app-1", name: "Wurfel", kind: "app" },
          { id: "app-2", name: "Old name", kind: "app" },
          { id: "app-4", name: "Quiet", kind: "app" },
        ],
        now: new Date("2026-09-01T00:00:00Z"),
      }),
    );
    await inA((tx) =>
      upsertConnectionResources(tx, {
        workspaceId: workspaceA,
        connectionId: connectionA,
        // A repeated id in one batch is one row; app-4 keeps its name.
        resources: [
          { id: "app-2", name: "Dicey", kind: "app" },
          { id: "app-2", name: "Dicey", kind: "app" },
        ],
        now: new Date("2026-09-02T00:00:00Z"),
      }),
    );
    expect(
      await inA((tx) =>
        connectionResourcesDiscoveredAt(tx, workspaceA, connectionA),
      ),
    ).toEqual(new Date("2026-09-02T00:00:00Z"));
    const names = await inA((tx) =>
      findResourceNames(tx, workspaceA, [
        { connectionId: connectionA, resourceId: "app-1" },
        { connectionId: connectionA, resourceId: "app-2" },
        { connectionId: connectionA, resourceId: "app-4" },
        { connectionId: connectionA, resourceId: "app-9" },
      ]),
    );
    expect(Object.fromEntries(names)).toEqual({
      [resourceNameKey(connectionA, "app-1")]: "Wurfel",
      [resourceNameKey(connectionA, "app-2")]: "Dicey",
      [resourceNameKey(connectionA, "app-4")]: "Quiet",
    });
  });

  it("lists a metric's resources: with data or named, named first", async () => {
    const resources = await inA((tx) =>
      listMetricResources(tx, {
        workspaceId: workspaceA,
        connectionId: connectionA,
        metricKey: "downloads",
      }),
    );
    // app-3 has data of another metric only and no name: not listed.
    expect(resources).toEqual([
      { id: "app-2", name: "Dicey" },
      { id: "app-4", name: "Quiet" },
      { id: "app-1", name: "Wurfel" },
      { id: "app-9", name: null },
    ]);
  });

  it("lists only the selected named resources of a selective connection", async () => {
    await inA((tx) =>
      upsertConnectionResources(tx, {
        workspaceId: workspaceA,
        connectionId: selective,
        resources: [
          { id: "app-1", name: "Wurfel", kind: "app" },
          { id: "app-2", name: "Dicey", kind: "app" },
        ],
        now: new Date("2026-09-01T00:00:00Z"),
      }),
    );
    expect(
      await inA((tx) =>
        listMetricResources(tx, {
          workspaceId: workspaceA,
          connectionId: selective,
          metricKey: "downloads",
        }),
      ),
    ).toEqual([{ id: "app-1", name: "Wurfel" }]);
  });

  it("knows a connection's resources by data, name or selection only", async () => {
    const has = (connectionId: string, resourceId: string) =>
      inA((tx) =>
        connectionHasResource(tx, workspaceA, connectionId, resourceId),
      );
    expect(await has(connectionA, "app-9")).toBe(true); // data
    expect(await has(connectionA, "app-4")).toBe(true); // named
    expect(await has(connectionA, "app-3")).toBe(true); // other metric's data
    expect(await has(selective, "app-1")).toBe(true); // selection and name
    expect(await has(connectionA, "app-b")).toBe(false); // another workspace
    expect(await has(connectionA, "nope")).toBe(false);
    expect(await has(connectionB, "app-b")).toBe(false); // hidden by RLS
  });

  it("keeps names in their workspace", async () => {
    // Workspace B sees none of A's names, even when asking for them.
    const names = await withWorkspace(db, { workspaceId: workspaceB }, (tx) =>
      findResourceNames(tx, workspaceA, [
        { connectionId: connectionA, resourceId: "app-1" },
      ]),
    );
    expect(names.size).toBe(0);
    await expect(
      withWorkspace(db, { workspaceId: workspaceB }, (tx) =>
        upsertConnectionResources(tx, {
          workspaceId: workspaceA,
          connectionId: connectionA,
          resources: [{ id: "app-1", name: "Hijacked", kind: "app" }],
          now: new Date(),
        }),
      ),
    ).rejects.toThrow();
    const [row] = await admin`
      select name from connection_resources
      where connection_id = ${connectionA} and resource_id = 'app-1'`;
    expect(row!.name).toBe("Wurfel");
  });

  it("goes with its connection", async () => {
    const [extra] = await admin`
      insert into connections (workspace_id, connector_id, name)
      values (${workspaceA}, 'demo', 'Short-lived') returning id`;
    const id = extra!.id as string;
    await inA((tx) =>
      upsertConnectionResources(tx, {
        workspaceId: workspaceA,
        connectionId: id,
        resources: [{ id: "x", name: "X", kind: "app" }],
        now: new Date(),
      }),
    );
    await admin`delete from connections where id = ${id}`;
    const left =
      await admin`select count(*)::int as n from connection_resources where connection_id = ${id}`;
    expect(left[0]!.n).toBe(0);
  });

  it("reads what the connector calls its resources from its manifest", async () => {
    // The test manifest names none.
    expect(
      await inA((tx) =>
        findConnectionResourceNoun(tx, workspaceA, connectionA),
      ),
    ).toBeNull();
    await admin`
      update connectors
      set manifest = manifest || ${admin.json({ resourceNoun: { singular: "app", plural: "apps" } })}
      where id = 'demo'`;
    try {
      expect(
        await inA((tx) =>
          findConnectionResourceNoun(tx, workspaceA, connectionA),
        ),
      ).toEqual({ singular: "app", plural: "apps" });
      // Another workspace's connection is not found.
      expect(
        await inA((tx) =>
          findConnectionResourceNoun(tx, workspaceA, connectionB),
        ),
      ).toBeNull();
    } finally {
      await admin`update connectors set manifest = manifest - 'resourceNoun' where id = 'demo'`;
    }
  });
});
