import { randomUUID } from "node:crypto";

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as authSchema from "./auth-schema.js";
import { insertConnection } from "./connections.js";
import { withWorkspace } from "./context.js";
import {
  countCustomApiConnections,
  countCustomApiDefinitions,
  customApiDatasetVersionHighWater,
  findCustomApiDefinition,
  findCustomApiDefinitionVersion,
  insertCustomApiDefinition,
  insertCustomApiDefinitionVersion,
  listCustomApiDefinitions,
  updateCustomApiDefinition,
} from "./custom-api.js";
import * as schema from "./schema.js";
import {
  createTestDatabase,
  type TestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// Custom API definitions (#803): versioned rows, optimistic new versions,
// connection counts, archive filter, and the explicit workspace predicate on
// top of RLS.

let testDb: TestDatabase;
let admin: postgres.Sql;
let appClient: postgres.Sql;
let db: PostgresJsDatabase<typeof schema & typeof authSchema>;
let workspaceA: string;
let workspaceB: string;

const inA = <T>(run: Parameters<typeof withWorkspace<T>>[2]) =>
  withWorkspace(db, { workspaceId: workspaceA }, run);
const inB = <T>(run: Parameters<typeof withWorkspace<T>>[2]) =>
  withWorkspace(db, { workspaceId: workspaceB }, run);

const SHA = "b".repeat(64);

function definitionInput(name = "Shop") {
  return {
    id: randomUUID(),
    projectId: null,
    name,
    createdBy: null,
    document: { schemaVersion: 1, name },
    documentSha256: SHA,
    schemaVersion: 1,
    datasetVersions: { daily_stats: 1 },
  };
}

function versionInput(baseVersion: number, name = "Shop") {
  return {
    baseVersion,
    name,
    createdBy: null,
    document: { schemaVersion: 1, name },
    documentSha256: SHA,
    schemaVersion: 1,
    datasetVersions: { daily_stats: 2 },
  };
}

async function connectTo(versionId: string, name: string) {
  await inA((tx) =>
    insertConnection(tx, {
      id: randomUUID(),
      workspaceId: workspaceA,
      connectorId: "custom-api",
      name,
      config: {},
      credentialsEncrypted: null,
      projectId: null,
      pollIntervalSeconds: 900,
      customApi: { definitionVersionId: versionId, environmentId: "prod" },
    }),
  );
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = postgres(testDb.adminUrl, { max: 1 });
  appClient = postgres(testDb.appUrl, { max: 4 });
  db = drizzle(appClient, { schema: { ...schema, ...authSchema } });
  const [a] =
    await admin`insert into workspaces (name) values ('A') returning id`;
  const [b] =
    await admin`insert into workspaces (name) values ('B') returning id`;
  workspaceA = a!.id as string;
  workspaceB = b!.id as string;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await admin.end({ timeout: 5 }).catch(() => undefined);
  await appClient.end({ timeout: 5 }).catch(() => undefined);
});

describe("custom API definitions", () => {
  it("creates version 1 and lists it with zero connections", async () => {
    const input = definitionInput("Created");
    const created = await inA((tx) =>
      insertCustomApiDefinition(tx, workspaceA, input),
    );
    expect(created.definition).toMatchObject({
      id: input.id,
      workspaceId: workspaceA,
      name: "Created",
      currentVersion: 1,
      archivedAt: null,
    });
    expect(created.version).toMatchObject({
      definitionId: input.id,
      version: 1,
      schemaVersion: 1,
      documentSha256: SHA,
      datasetVersions: { daily_stats: 1 },
    });
    expect(created.connectionCount).toBe(0);
    const listed = await inA((tx) =>
      listCustomApiDefinitions(tx, workspaceA, { includeArchived: false }),
    );
    const entry = listed.find((item) => item.definition.id === input.id);
    expect(entry).toMatchObject({
      connectionCount: 0,
      version: { version: 1 },
    });
  });

  it("adds version 2 only from the current base", async () => {
    const input = definitionInput("Versioned");
    await inA((tx) => insertCustomApiDefinition(tx, workspaceA, input));
    const second = await inA((tx) =>
      insertCustomApiDefinitionVersion(
        tx,
        workspaceA,
        input.id,
        versionInput(1, "Versioned v2"),
      ),
    );
    expect(second).toMatchObject({
      definition: { currentVersion: 2, name: "Versioned v2" },
      version: { version: 2, datasetVersions: { daily_stats: 2 } },
    });
    expect(
      await inA((tx) =>
        insertCustomApiDefinitionVersion(
          tx,
          workspaceA,
          input.id,
          versionInput(1),
        ),
      ),
    ).toBe("stale");
    expect(
      await inA((tx) =>
        insertCustomApiDefinitionVersion(
          tx,
          workspaceA,
          randomUUID(),
          versionInput(1),
        ),
      ),
    ).toBeNull();
    const first = await inA((tx) =>
      findCustomApiDefinitionVersion(tx, workspaceA, input.id, 1),
    );
    expect(first).toMatchObject({
      version: 1,
      datasetVersions: { daily_stats: 1 },
    });
    const found = await inA((tx) =>
      findCustomApiDefinition(tx, workspaceA, input.id),
    );
    expect(found?.version.version).toBe(2);
  });

  it("remembers the highest dataset version of every stream ever stored", async () => {
    const input = definitionInput("High water");
    await inA((tx) => insertCustomApiDefinition(tx, workspaceA, input));
    await inA((tx) =>
      insertCustomApiDefinitionVersion(tx, workspaceA, input.id, {
        ...versionInput(1),
        datasetVersions: { daily_stats: 2, removed: 4 },
      }),
    );
    await inA((tx) =>
      insertCustomApiDefinitionVersion(tx, workspaceA, input.id, {
        ...versionInput(2),
        datasetVersions: { daily_stats: 3 },
      }),
    );
    expect(
      await inA((tx) =>
        customApiDatasetVersionHighWater(tx, workspaceA, input.id),
      ),
    ).toEqual({ daily_stats: 3, removed: 4 });
    expect(
      await inB((tx) =>
        customApiDatasetVersionHighWater(tx, workspaceA, input.id),
      ),
    ).toEqual({});
  });

  it("concurrent new versions: exactly one wins", async () => {
    const input = definitionInput("Raced");
    await inA((tx) => insertCustomApiDefinition(tx, workspaceA, input));
    const results = await Promise.allSettled(
      [0, 1].map(() =>
        inA((tx) =>
          insertCustomApiDefinitionVersion(
            tx,
            workspaceA,
            input.id,
            versionInput(1),
          ),
        ),
      ),
    );
    const values = results.map((result) =>
      result.status === "fulfilled" ? result.value : result.reason,
    );
    expect(values.filter((value) => value === "stale")).toHaveLength(1);
    expect(
      values.filter(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          "version" in value &&
          value.version.version === 2,
      ),
    ).toHaveLength(1);
  });

  it("counts connections across versions", async () => {
    const input = definitionInput("Counted");
    const v1 = await inA((tx) =>
      insertCustomApiDefinition(tx, workspaceA, input),
    );
    const v2 = await inA((tx) =>
      insertCustomApiDefinitionVersion(
        tx,
        workspaceA,
        input.id,
        versionInput(1),
      ),
    );
    if (v2 === null || v2 === "stale") throw new Error("no version 2");
    const before = await inA((tx) => countCustomApiConnections(tx, workspaceA));
    await connectTo(v1.version.id, "Old");
    await connectTo(v2.version.id, "New");
    await connectTo(v2.version.id, "Newer");
    const found = await inA((tx) =>
      findCustomApiDefinition(tx, workspaceA, input.id),
    );
    expect(found?.connectionCount).toBe(3);
    const listed = await inA((tx) =>
      listCustomApiDefinitions(tx, workspaceA, { includeArchived: false }),
    );
    expect(
      listed.find((item) => item.definition.id === input.id)?.connectionCount,
    ).toBe(3);
    expect(await inA((tx) => countCustomApiConnections(tx, workspaceA))).toBe(
      before + 3,
    );
    expect(await inB((tx) => countCustomApiConnections(tx, workspaceB))).toBe(
      0,
    );
  });

  it("lists archived definitions only when asked", async () => {
    const input = definitionInput("Archived");
    await inA((tx) => insertCustomApiDefinition(tx, workspaceA, input));
    const countBefore = await inA((tx) =>
      countCustomApiDefinitions(tx, workspaceA),
    );
    const archived = await inA((tx) =>
      updateCustomApiDefinition(tx, workspaceA, input.id, {
        archivedAt: new Date(),
      }),
    );
    expect(archived?.archivedAt).toBeInstanceOf(Date);
    expect(await inA((tx) => countCustomApiDefinitions(tx, workspaceA))).toBe(
      countBefore - 1,
    );
    const active = await inA((tx) =>
      listCustomApiDefinitions(tx, workspaceA, { includeArchived: false }),
    );
    expect(active.map((item) => item.definition.id)).not.toContain(input.id);
    const all = await inA((tx) =>
      listCustomApiDefinitions(tx, workspaceA, { includeArchived: true }),
    );
    expect(all.map((item) => item.definition.id)).toContain(input.id);
  });

  it("narrows the list to a project", async () => {
    const [project] = await admin`
      insert into projects (workspace_id, name) values (${workspaceA}, 'P')
      returning id`;
    const projectId = project!.id as string;
    const input = { ...definitionInput("In project"), projectId };
    await inA((tx) => insertCustomApiDefinition(tx, workspaceA, input));
    const listed = await inA((tx) =>
      listCustomApiDefinitions(tx, workspaceA, {
        includeArchived: false,
        project: projectId,
      }),
    );
    expect(listed.map((item) => item.definition.id)).toEqual([input.id]);
    const moved = await inA((tx) =>
      updateCustomApiDefinition(tx, workspaceA, input.id, { projectId: null }),
    );
    expect(moved?.projectId).toBeNull();
  });

  it("never returns another workspace's definition even with its id", async () => {
    const input = definitionInput("Private");
    await inA((tx) => insertCustomApiDefinition(tx, workspaceA, input));
    expect(
      await inB((tx) => findCustomApiDefinition(tx, workspaceB, input.id)),
    ).toBeNull();
    expect(
      await inB((tx) => findCustomApiDefinition(tx, workspaceA, input.id)),
    ).toBeNull();
    expect(
      await inB((tx) =>
        findCustomApiDefinitionVersion(tx, workspaceB, input.id, 1),
      ),
    ).toBeNull();
    expect(
      await inB((tx) =>
        insertCustomApiDefinitionVersion(
          tx,
          workspaceB,
          input.id,
          versionInput(1),
        ),
      ),
    ).toBeNull();
    expect(
      await inB((tx) =>
        updateCustomApiDefinition(tx, workspaceB, input.id, {
          archivedAt: new Date(),
        }),
      ),
    ).toBeNull();
    expect(
      await inB((tx) =>
        listCustomApiDefinitions(tx, workspaceB, { includeArchived: true }),
      ),
    ).toEqual([]);
    // The explicit predicate holds even when RLS would allow the row.
    expect(
      await inA((tx) => findCustomApiDefinition(tx, workspaceB, input.id)),
    ).toBeNull();
  });
});
