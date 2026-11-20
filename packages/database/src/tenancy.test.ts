import { and, eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createWorkspace, withUserContext, withWorkspace } from "./context.js";
import * as authSchema from "./auth-schema.js";
import * as schema from "./schema.js";
import { listMembershipsForUser } from "./users.js";
import { setActiveProject, setProjectArchived } from "./workspaces.js";
import {
  createTestDatabase,
  type TestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

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

let u1: string;
let u2: string;
let u3: string;
let workspaceA: string;
let workspaceB: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  appClient = postgres(testDb.appUrl);
  db = drizzle(appClient, { schema: { ...schema, ...authSchema } });

  const [user1, user2, user3] = await db
    .insert(schema.users)
    .values([
      { email: "u1@example.com", displayName: "User One" },
      { email: "u2@example.com", displayName: "User Two" },
      { email: "u3@example.com", displayName: "User Three" },
    ])
    .returning({ id: schema.users.id });
  u1 = user1!.id;
  u2 = user2!.id;
  u3 = user3!.id;

  workspaceA = await createWorkspace(db, {
    name: "Workspace A",
    ownerUserId: u1,
  });
  workspaceB = await createWorkspace(db, {
    name: "Workspace B",
    ownerUserId: u2,
  });

  // A's owner adds U2 as a viewer of A (regular tenant-context insert).
  await withWorkspace(db, { workspaceId: workspaceA, userId: u1 }, (tx) =>
    tx
      .insert(schema.memberships)
      .values({ workspaceId: workspaceA, userId: u2, role: "viewer" }),
  );
  await withWorkspace(db, { workspaceId: workspaceA, userId: u1 }, (tx) =>
    tx
      .insert(schema.projects)
      .values({ workspaceId: workspaceA, name: "Project A1" }),
  );
  await withWorkspace(db, { workspaceId: workspaceB, userId: u2 }, (tx) =>
    tx
      .insert(schema.projects)
      .values({ workspaceId: workspaceB, name: "Project B1" }),
  );

  await db.insert(schema.auditEvents).values({ action: "installation.boot" });
  await withWorkspace(db, { workspaceId: workspaceA, userId: u1 }, (tx) =>
    tx.insert(schema.auditEvents).values({
      workspaceId: workspaceA,
      actorUserId: u1,
      action: "project.created",
    }),
  );
  await withWorkspace(db, { workspaceId: workspaceB, userId: u2 }, (tx) =>
    tx.insert(schema.auditEvents).values({
      workspaceId: workspaceB,
      actorUserId: u2,
      action: "project.created",
    }),
  );
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await appClient.end({ timeout: 5 }).catch(() => undefined);
});

describe("workspace-scoped visibility", () => {
  it("sees only workspace A inside withWorkspace(A)", async () => {
    await withWorkspace(
      db,
      { workspaceId: workspaceA, userId: u1 },
      async (tx) => {
        const workspaces = await tx.select().from(schema.workspaces);
        expect(workspaces.map((w) => w.id)).toEqual([workspaceA]);

        const projects = await tx.select().from(schema.projects);
        expect(projects.map((p) => p.name)).toEqual(["Project A1"]);

        const memberships = await tx.select().from(schema.memberships);
        // A's rows plus U1's own rows elsewhere; never U2's B membership.
        expect(
          memberships.every(
            (m) => m.workspaceId === workspaceA || m.userId === u1,
          ),
        ).toBeTruthy();
        expect(
          memberships.some(
            (m) => m.workspaceId === workspaceB && m.userId === u2,
          ),
        ).toBeFalsy();
      },
    );
  });

  it("sees only workspace B (plus his own rows) inside withWorkspace(B)", async () => {
    await withWorkspace(
      db,
      { workspaceId: workspaceB, userId: u2 },
      async (tx) => {
        const workspaces = await tx.select().from(schema.workspaces);
        expect(workspaces.map((w) => w.id)).toEqual([workspaceB]);

        const projects = await tx.select().from(schema.projects);
        expect(projects.map((p) => p.name)).toEqual(["Project B1"]);

        // The own-user policy path also surfaces U2's viewer row in A;
        // crucially, none of U1's memberships (or B rows of others) appear.
        const memberships = await tx.select().from(schema.memberships);
        expect(
          memberships.every(
            (m) => m.workspaceId === workspaceB || m.userId === u2,
          ),
        ).toBeTruthy();
        expect(memberships.some((m) => m.userId === u1)).toBeFalsy();
        expect(memberships).toHaveLength(2);
      },
    );
  });

  it("returns zero rows on tenant tables with no context at all", async () => {
    expect(await db.select().from(schema.workspaces)).toHaveLength(0);
    expect(await db.select().from(schema.projects)).toHaveLength(0);
    expect(await db.select().from(schema.memberships)).toHaveLength(0);
  });

  it("rejects inserting a project into another workspace", async () => {
    await expectDbError(
      withWorkspace(db, { workspaceId: workspaceA, userId: u1 }, (tx) =>
        tx
          .insert(schema.projects)
          .values({ workspaceId: workspaceB, name: "smuggle" }),
      ),
      /row-level security/,
    );
  });
});

describe("custom API item image tables (#809)", () => {
  it("refuse rows for another workspace and show none without context", async () => {
    await expectDbError(
      withWorkspace(db, { workspaceId: workspaceA, userId: u1 }, (tx) =>
        tx.insert(schema.customApiItemImages).values({
          workspaceId: workspaceB,
          urlSha256: "a".repeat(64),
          imageId: crypto.randomUUID(),
          lastSeenAt: new Date(),
        }),
      ),
      /row-level security/,
    );
    await expectDbError(
      withWorkspace(db, { workspaceId: workspaceA, userId: u1 }, (tx) =>
        tx.insert(schema.customApiStreamImages).values({
          workspaceId: workspaceB,
          connectionId: crypto.randomUUID(),
          streamKey: "photos",
          checkedAt: new Date(),
          stored: 0,
          unchanged: 0,
          skipped: 0,
        }),
      ),
      /row-level security/,
    );
    expect(await db.select().from(schema.customApiItemImages)).toHaveLength(0);
    expect(await db.select().from(schema.customApiStreamImages)).toHaveLength(
      0,
    );
  });
});

describe("user context (workspace discovery)", () => {
  it("shows U2 exactly his own memberships across both workspaces", async () => {
    const memberships = await withUserContext(db, { userId: u2 }, (tx) =>
      tx.select().from(schema.memberships),
    );
    expect(memberships).toHaveLength(2);
    expect(memberships.every((m) => m.userId === u2)).toBeTruthy();
    expect(memberships.map((m) => m.role).sort()).toEqual(["owner", "viewer"]);
  });
});

describe("effective active project", () => {
  it("archiving clears the stored active project; unarchiving keeps All (#641)", async () => {
    const projectId = await withWorkspace(
      db,
      { workspaceId: workspaceA, userId: u1 },
      async (tx) => {
        const [project] = await tx
          .insert(schema.projects)
          .values({ workspaceId: workspaceA, name: "Archivable" })
          .returning({ id: schema.projects.id });
        await setActiveProject(tx, {
          workspaceId: workspaceA,
          userId: u1,
          projectId: project!.id,
        });
        return project!.id;
      },
    );
    const activeIn = async (): Promise<string | null | undefined> =>
      (await listMembershipsForUser(db, u1)).find(
        (m) => m.workspaceId === workspaceA,
      )?.activeProjectId;
    const archive = (archived: boolean) =>
      withWorkspace(db, { workspaceId: workspaceA, userId: u1 }, (tx) =>
        setProjectArchived(tx, {
          workspaceId: workspaceA,
          projectId,
          archived,
          now: new Date(),
        }),
      );

    expect(await activeIn()).toBe(projectId);
    const archived = await archive(true);
    expect(archived?.archivedAt).toBeInstanceOf(Date);
    expect(await activeIn()).toBeNull();
    // The stored choice is cleared, so unarchiving does not restore it.
    const stored = await withWorkspace(
      db,
      { workspaceId: workspaceA, userId: u1 },
      (tx) =>
        tx
          .select({ id: schema.memberships.activeProjectId })
          .from(schema.memberships)
          .where(
            and(
              eq(schema.memberships.workspaceId, workspaceA),
              eq(schema.memberships.userId, u1),
            ),
          ),
    );
    expect(stored[0]?.id).toBeNull();
    expect((await archive(false))?.archivedAt).toBeNull();
    expect(await activeIn()).toBeNull();
    // Another workspace's caller cannot archive it.
    expect(
      await withWorkspace(db, { workspaceId: workspaceB, userId: u2 }, (tx) =>
        setProjectArchived(tx, {
          workspaceId: workspaceB,
          projectId,
          archived: true,
          now: new Date(),
        }),
      ),
    ).toBeNull();
  });
});

describe("raw app-role connection (no helpers)", () => {
  it("binds RLS to the role itself", async () => {
    const raw = postgres(testDb.appUrl, { max: 1 });
    try {
      expect(await raw`select * from workspaces`).toHaveLength(0);

      await raw`select set_config('app.workspace_id', ${workspaceA}, false)`;
      const visible = await raw`select * from workspaces`;
      expect(visible.map((row) => row.id)).toEqual([workspaceA]);
      const memberships = await raw`select * from memberships`;
      expect(
        memberships.every((row) => row.workspace_id === workspaceA),
      ).toBeTruthy();
    } finally {
      await raw.end({ timeout: 5 }).catch(() => undefined);
    }
  });
});

describe("last-owner guard", () => {
  it("forbids removing or demoting the last owner", async () => {
    const workspaceC = await createWorkspace(db, {
      name: "Workspace C",
      ownerUserId: u1,
    });

    await expectDbError(
      withWorkspace(db, { workspaceId: workspaceC, userId: u1 }, (tx) =>
        tx
          .delete(schema.memberships)
          .where(
            and(
              eq(schema.memberships.workspaceId, workspaceC),
              eq(schema.memberships.userId, u1),
            ),
          ),
      ),
      /last owner/,
    );

    // A second owner makes deleting the first one legal.
    await withWorkspace(db, { workspaceId: workspaceC, userId: u1 }, (tx) =>
      tx
        .insert(schema.memberships)
        .values({ workspaceId: workspaceC, userId: u3, role: "owner" }),
    );
    await withWorkspace(db, { workspaceId: workspaceC, userId: u1 }, (tx) =>
      tx
        .delete(schema.memberships)
        .where(
          and(
            eq(schema.memberships.workspaceId, workspaceC),
            eq(schema.memberships.userId, u1),
          ),
        ),
    );

    // Demoting the remaining owner is forbidden again.
    await expectDbError(
      withWorkspace(db, { workspaceId: workspaceC, userId: u3 }, (tx) =>
        tx
          .update(schema.memberships)
          .set({ role: "admin" })
          .where(
            and(
              eq(schema.memberships.workspaceId, workspaceC),
              eq(schema.memberships.userId, u3),
            ),
          ),
      ),
      /last owner/,
    );
  });
});

describe("audit_events", () => {
  it("is append-only and workspace-scoped on reads", async () => {
    await withWorkspace(
      db,
      { workspaceId: workspaceA, userId: u1 },
      async (tx) => {
        const events = await tx.select().from(schema.auditEvents);
        expect(events).toHaveLength(1);
        expect(events[0]!.workspaceId).toBe(workspaceA);
      },
    );

    // Installation-level events (NULL workspace) are invisible to tenants.
    await withWorkspace(
      db,
      { workspaceId: workspaceB, userId: u2 },
      async (tx) => {
        const events = await tx.select().from(schema.auditEvents);
        expect(events).toHaveLength(1);
        expect(events[0]!.workspaceId).toBe(workspaceB);
      },
    );

    // Writes are limited to the context workspace or installation level.
    await expect(
      withWorkspace(db, { workspaceId: workspaceA, userId: u1 }, (tx) =>
        tx
          .insert(schema.auditEvents)
          .values({ workspaceId: workspaceB, action: "forged" }),
      ),
    ).rejects.toThrow();

    const raw = postgres(testDb.appUrl, { max: 1 });
    try {
      await expect(
        raw`update audit_events set action = 'tampered'`,
      ).rejects.toThrow(/permission denied/);
      await expect(raw`delete from audit_events`).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await raw.end({ timeout: 5 }).catch(() => undefined);
    }
  });
});

describe("workspace-creation abuse guard", () => {
  it("has no no-context path to insert memberships into an existing workspace", async () => {
    // With only a user context, U3 cannot make himself owner of workspace A.
    await expectDbError(
      withUserContext(db, { userId: u3 }, (tx) =>
        tx
          .insert(schema.memberships)
          .values({ workspaceId: workspaceA, userId: u3, role: "owner" }),
      ),
      /row-level security/,
    );

    // create_workspace always mints a fresh workspace; it cannot target an
    // existing one (there is no workspace-id parameter to abuse).
    const workspaceD = await createWorkspace(db, {
      name: "Workspace D",
      ownerUserId: u3,
    });
    expect(workspaceD).not.toBe(workspaceA);
    await withWorkspace(
      db,
      { workspaceId: workspaceA, userId: u1 },
      async (tx) => {
        const memberships = await tx.select().from(schema.memberships);
        const inA = memberships.filter((m) => m.workspaceId === workspaceA);
        expect(inA.map((m) => m.userId).sort()).toEqual([u1, u2].sort());
        expect(inA.find((m) => m.userId === u1)!.role).toBe("owner");
      },
    );
    await withWorkspace(
      db,
      { workspaceId: workspaceD, userId: u3 },
      async (tx) => {
        const memberships = await tx.select().from(schema.memberships);
        // D's rows plus U3's own rows from other workspaces (own-user path).
        expect(
          memberships.every(
            (m) => m.workspaceId === workspaceD || m.userId === u3,
          ),
        ).toBeTruthy();
        const inD = memberships.filter((m) => m.workspaceId === workspaceD);
        expect(inD.map((m) => [m.userId, m.role])).toEqual([[u3, "owner"]]);
      },
    );
  });
});

describe("withWorkspace transaction options", () => {
  it("sends no bare SET TRANSACTION for options without values", async () => {
    const isolation = await withWorkspace(
      db,
      { workspaceId: workspaceA },
      async (tx) =>
        (
          await tx.execute<{ level: string }>(
            sql`select current_setting('transaction_isolation') as level`,
          )
        )[0]!.level,
      { isolationLevel: undefined, accessMode: undefined },
    );
    expect(isolation).toBe("read committed");
  });

  it("takes table locks first, with the timeout bounding only the lock", async () => {
    const result = await withWorkspace(
      db,
      { workspaceId: workspaceA },
      async (tx) =>
        (
          await tx.execute<{ mode: string; timeout: string }>(
            sql`select (select mode from pg_locks where pid = pg_backend_pid()
                  and relation = 'data_template_installs'::regclass) as mode,
                current_setting('lock_timeout') as timeout`,
          )
        )[0]!,
      {
        isolationLevel: "serializable",
        lockTables: {
          tables: [schema.dataTemplateInstalls],
          mode: "share update exclusive",
          timeoutMs: 1_000,
        },
      },
    );
    expect(result).toEqual({ mode: "ShareUpdateExclusiveLock", timeout: "0" });
  });
});
