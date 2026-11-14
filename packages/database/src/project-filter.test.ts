import { and, asc, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as authSchema from "./auth-schema.js";
import { createWorkspace, withWorkspace } from "./context.js";
import { projectFilterSql, type ProjectFilter } from "./project-filter.js";
import * as schema from "./schema.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
  type TestDatabase,
} from "./test-db.js";
import { setProjectArchived } from "./workspaces.js";

let testDb: TestDatabase;
let appClient: postgres.Sql;
let db: PostgresJsDatabase<typeof schema & typeof authSchema>;
let userId: string;
let workspaceId: string;
let A: string;
let otherWorkspaceProject: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  appClient = postgres(testDb.appUrl);
  db = drizzle(appClient, { schema: { ...schema, ...authSchema } });
  const [user, otherUser] = await db
    .insert(schema.users)
    .values([
      { email: "a@example.com", displayName: "A" },
      { email: "b@example.com", displayName: "B" },
    ])
    .returning({ id: schema.users.id });
  userId = user!.id;
  workspaceId = await createWorkspace(db, { name: "W1", ownerUserId: userId });
  const otherWorkspace = await createWorkspace(db, {
    name: "W2",
    ownerUserId: otherUser!.id,
  });

  await withWorkspace(db, { workspaceId, userId }, async (tx) => {
    const [a, b] = await tx
      .insert(schema.projects)
      .values([
        { workspaceId, name: "A" },
        { workspaceId, name: "B" },
      ])
      .returning({ id: schema.projects.id });
    A = a!.id;
    await setProjectArchived(tx, {
      workspaceId,
      projectId: b!.id,
      archived: true,
      now: new Date(),
    });
    await tx.insert(schema.dashboards).values([
      { workspaceId, projectId: A, name: "a" },
      { workspaceId, projectId: b!.id, name: "b" },
      { workspaceId, name: "none" },
    ]);
  });
  await withWorkspace(
    db,
    { workspaceId: otherWorkspace, userId: otherUser!.id },
    async (tx) => {
      const [project] = await tx
        .insert(schema.projects)
        .values({ workspaceId: otherWorkspace, name: "A" })
        .returning({ id: schema.projects.id });
      otherWorkspaceProject = project!.id;
      await tx.insert(schema.dashboards).values({
        workspaceId: otherWorkspace,
        projectId: otherWorkspaceProject,
        name: "other",
      });
    },
  );
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await appClient.end({ timeout: 5 }).catch(() => undefined);
});

async function names(filter: ProjectFilter | undefined): Promise<string[]> {
  return withWorkspace(db, { workspaceId, userId }, async (tx) => {
    const rows = await tx
      .select({ name: schema.dashboards.name })
      .from(schema.dashboards)
      .where(
        and(
          eq(schema.dashboards.workspaceId, workspaceId),
          filter === undefined
            ? undefined
            : projectFilterSql(
                schema.dashboards.projectId,
                workspaceId,
                filter,
              ),
        ),
      )
      .orderBy(asc(schema.dashboards.name));
    return rows.map((row) => row.name);
  });
}

describe("projectFilterSql", () => {
  it("narrows a list to a project, to All without archived ones, or not at all", async () => {
    expect(await names(undefined)).toEqual(["a", "b", "none"]);
    expect(await names({})).toEqual(["a", "b", "none"]);
    expect(await names({ project: "all" })).toEqual(["a", "none"]);
    expect(await names({ project: A })).toEqual(["a"]);
    expect(await names({ project: A, unassigned: "include" })).toEqual([
      "a",
      "none",
    ]);
    expect(await names({ project: otherWorkspaceProject })).toEqual([]);
  });
});
