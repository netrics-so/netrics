import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  activeProjectResponseSchema,
  auditEventListResponseSchema,
  errorResponseSchema,
  meResponseSchema,
  memberListResponseSchema,
  memberResponseSchema,
  projectListResponseSchema,
  projectResponseSchema,
  workspaceListResponseSchema,
  workspaceResponseSchema,
  type WorkspaceRole,
} from "@netrics/contracts";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";
import { addMemberViaInvitation } from "./test-helpers.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

interface World {
  app: FastifyInstance;
  admin: Sql;
  db: Database;
  close: () => Promise<void>;
}

async function createWorld(): Promise<World> {
  const testDb = await createTestDatabase();
  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "silent",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
  });
  const db = createDatabase(testDb.appUrl);
  const authService = createAuthService(config, db, {
    logger: pino({ level: "silent" }),
  });
  const app = await buildApp(config, {
    db,
    authService,
    checkDb: async () => true,
  });
  const admin = createRawSqlClient(testDb.adminUrl, { max: 1 });
  return {
    app,
    admin,
    db,
    close: async () => {
      await app.close();
      await db.$client.end({ timeout: 5 }).catch(() => undefined);
      await admin.end({ timeout: 5 }).catch(() => undefined);
    },
  };
}

function sessionCookie(response: InjectResponse): string {
  const header = response.headers["set-cookie"];
  const cookies = Array.isArray(header) ? header : [header];
  const session = cookies.find((c) =>
    c?.startsWith("better-auth.session_token="),
  );
  if (!session) {
    throw new Error("expected a session cookie in the response");
  }
  return session.split(";")[0]!;
}

async function signUpUser(
  app: FastifyInstance,
  email: string,
  name: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { name, email, password: "password-12345" },
  });
  expect(response.statusCode).toBe(200);
  return sessionCookie(response);
}

interface Call {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  cookie?: string;
  payload?: unknown;
}

function call(
  app: FastifyInstance,
  { method, url, cookie, payload }: Call,
): Promise<InjectResponse> {
  const options: InjectOptions = {
    method,
    url,
    headers: cookie ? { cookie } : {},
    ...(payload !== undefined
      ? { payload: payload as Record<string, unknown> }
      : {}),
  };
  return app.inject(options);
}

function expectError(response: InjectResponse, code: number, error: string) {
  expect(response.statusCode).toBe(code);
  expect(errorResponseSchema.parse(response.json())).toEqual({ error });
}

// Shared scenario state, built up by the describes in order.
type UserKey =
  "owner" | "viewer" | "editor" | "admin" | "owner2" | "outsider" | "second";
let world: World;
const cookies = {} as Record<UserKey, string>;
const userIds = {} as Record<UserKey, string>;
let w1Id: string;
let w2Id: string;
let p1Id: string;
let p2Id: string;

async function domainUserId(cookie: string): Promise<string> {
  const me = await call(world.app, { method: "GET", url: "/v1/me", cookie });
  return meResponseSchema.parse(me.json()).user.id;
}

async function addMember(
  cookie: string,
  workspaceId: string,
  email: string,
  role: WorkspaceRole,
) {
  return addMemberViaInvitation(
    world.app,
    world.db,
    cookie,
    workspaceId,
    email,
    role,
  );
}

async function createProject(
  cookie: string,
  workspaceId: string,
  name: string,
) {
  return call(world.app, {
    method: "POST",
    url: `/v1/workspaces/${workspaceId}/projects`,
    cookie,
    payload: { name },
  });
}

beforeAll(async () => {
  world = await createWorld();
  for (const [key, email] of [
    ["owner", "owner@example.com"],
    ["viewer", "viewer@example.com"],
    ["editor", "editor@example.com"],
    ["admin", "admin@example.com"],
    ["owner2", "owner2@example.com"],
    ["outsider", "outsider@example.com"],
    ["second", "second@example.com"],
  ] as const) {
    cookies[key] = await signUpUser(world.app, email, key);
    userIds[key] = await domainUserId(cookies[key]);
  }
  const bootstrapped = await call(world.app, {
    method: "POST",
    url: "/v1/bootstrap",
    cookie: cookies.owner,
    payload: { workspaceName: "Acme" },
  });
  expect(bootstrapped.statusCode).toBe(200);
  const workspaces = workspaceListResponseSchema.parse(
    (
      await call(world.app, {
        method: "GET",
        url: "/v1/workspaces",
        cookie: cookies.owner,
      })
    ).json(),
  );
  w1Id = workspaces.workspaces[0]!.id;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await world.close();
});

describe("happy path", () => {
  it("requires a session", async () => {
    expectError(
      await call(world.app, { method: "GET", url: "/v1/workspaces" }),
      401,
      "unauthorized",
    );
    expectError(
      await call(world.app, {
        method: "POST",
        url: "/v1/workspaces",
        payload: { name: "X" },
      }),
      401,
      "unauthorized",
    );
  });

  it("owner creates a project, adds a viewer, viewer gets scoped access", async () => {
    const created = await createProject(cookies.owner, w1Id, "Website");
    expect(created.statusCode).toBe(200);
    p1Id = projectResponseSchema.parse(created.json()).project.id;

    const added = await addMember(
      cookies.owner,
      w1Id,
      "viewer@example.com",
      "viewer",
    );
    expect(added.statusCode).toBe(200);
    const afterInvite = await call(world.app, {
      method: "GET",
      url: `/v1/workspaces/${w1Id}/members`,
      cookie: cookies.owner,
    });
    expect(
      memberListResponseSchema
        .parse(afterInvite.json())
        .members.find((m) => m.email === "viewer@example.com"),
    ).toMatchObject({
      userId: userIds.viewer,
      displayName: "viewer",
      role: "viewer",
    });

    // Inviting an address without an account answers exactly like any other
    // invitation: account existence is never revealed.
    const ghost = await call(world.app, {
      method: "POST",
      url: `/v1/workspaces/${w1Id}/invitations`,
      cookie: cookies.owner,
      payload: { email: "ghost@example.com", role: "viewer" },
    });
    expect(ghost.statusCode).toBe(200);

    // Duplicate membership is a conflict.
    expectError(
      await addMember(cookies.owner, w1Id, "viewer@example.com", "editor"),
      409,
      "membership_exists",
    );

    const list = await call(world.app, {
      method: "GET",
      url: "/v1/workspaces",
      cookie: cookies.viewer,
    });
    expect(list.statusCode).toBe(200);
    expect(workspaceListResponseSchema.parse(list.json()).workspaces).toEqual([
      { id: w1Id, name: "Acme", role: "viewer", activeProjectId: null },
    ]);

    // Viewers cannot create projects.
    expectError(
      await createProject(cookies.viewer, w1Id, "Nope"),
      403,
      "forbidden",
    );

    // Any member can select an active project of the workspace.
    const active = await call(world.app, {
      method: "PATCH",
      url: `/v1/workspaces/${w1Id}/active-project`,
      cookie: cookies.viewer,
      payload: { projectId: p1Id },
    });
    expect(active.statusCode).toBe(200);
    expect(activeProjectResponseSchema.parse(active.json())).toEqual({
      activeProjectId: p1Id,
    });

    const relisted = workspaceListResponseSchema.parse(
      (
        await call(world.app, {
          method: "GET",
          url: "/v1/workspaces",
          cookie: cookies.viewer,
        })
      ).json(),
    );
    expect(relisted.workspaces[0]!.activeProjectId).toBe(p1Id);

    const members = await call(world.app, {
      method: "GET",
      url: `/v1/workspaces/${w1Id}/members`,
      cookie: cookies.owner,
    });
    expect(members.statusCode).toBe(200);
    const parsed = memberListResponseSchema.parse(members.json());
    expect(parsed.members).toHaveLength(2);
    expect(parsed.members.map((m) => m.role).sort()).toEqual([
      "owner",
      "viewer",
    ]);
  });

  it("returns workspace details to any member", async () => {
    const response = await call(world.app, {
      method: "GET",
      url: `/v1/workspaces/${w1Id}`,
      cookie: cookies.viewer,
    });
    expect(response.statusCode).toBe(200);
    expect(
      workspaceResponseSchema.parse(response.json()).workspace,
    ).toMatchObject({ id: w1Id, name: "Acme" });
  });
});

describe("role matrix over the API", () => {
  let editorProjectId: string;

  it("setup: owner adds an editor and an admin", async () => {
    expect(
      (await addMember(cookies.owner, w1Id, "editor@example.com", "editor"))
        .statusCode,
    ).toBe(200);
    expect(
      (await addMember(cookies.owner, w1Id, "admin@example.com", "admin"))
        .statusCode,
    ).toBe(200);
  });

  it("editor: can create and rename projects, nothing more", async () => {
    const created = await createProject(cookies.editor, w1Id, "Editor Project");
    expect(created.statusCode).toBe(200);
    editorProjectId = projectResponseSchema.parse(created.json()).project.id;

    const renamed = await call(world.app, {
      method: "PATCH",
      url: `/v1/workspaces/${w1Id}/projects/${editorProjectId}`,
      cookie: cookies.editor,
      payload: { name: "Editor Project v2" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(projectResponseSchema.parse(renamed.json()).project.name).toBe(
      "Editor Project v2",
    );

    expectError(
      await call(world.app, {
        method: "DELETE",
        url: `/v1/workspaces/${w1Id}/projects/${editorProjectId}`,
        cookie: cookies.editor,
      }),
      403,
      "forbidden",
    );
    expectError(
      await call(world.app, {
        method: "PATCH",
        url: `/v1/workspaces/${w1Id}`,
        cookie: cookies.editor,
        payload: { name: "Hijack" },
      }),
      403,
      "forbidden",
    );
    expectError(
      await addMember(cookies.editor, w1Id, "owner2@example.com", "viewer"),
      403,
      "forbidden",
    );
    expectError(
      await call(world.app, {
        method: "GET",
        url: `/v1/workspaces/${w1Id}/audit-events`,
        cookie: cookies.editor,
      }),
      403,
      "forbidden",
    );
    // Read access is fine.
    expect(
      (
        await call(world.app, {
          method: "GET",
          url: `/v1/workspaces/${w1Id}/projects`,
          cookie: cookies.editor,
        })
      ).statusCode,
    ).toBe(200);
  });

  it("viewer: read-only", async () => {
    expect(
      (
        await call(world.app, {
          method: "GET",
          url: `/v1/workspaces/${w1Id}/members`,
          cookie: cookies.viewer,
        })
      ).statusCode,
    ).toBe(200);
    expectError(
      await call(world.app, {
        method: "PATCH",
        url: `/v1/workspaces/${w1Id}/projects/${editorProjectId}`,
        cookie: cookies.viewer,
        payload: { name: "Hijack" },
      }),
      403,
      "forbidden",
    );
    expectError(
      await call(world.app, {
        method: "DELETE",
        url: `/v1/workspaces/${w1Id}/projects/${p1Id}`,
        cookie: cookies.viewer,
      }),
      403,
      "forbidden",
    );
    expectError(
      await call(world.app, {
        method: "DELETE",
        url: `/v1/workspaces/${w1Id}/members/${userIds.editor}`,
        cookie: cookies.viewer,
      }),
      403,
      "forbidden",
    );
    expectError(
      await call(world.app, {
        method: "GET",
        url: `/v1/workspaces/${w1Id}/audit-events`,
        cookie: cookies.viewer,
      }),
      403,
      "forbidden",
    );
  });

  it("admin: manages workspace, projects and non-owner members", async () => {
    expect(
      (
        await call(world.app, {
          method: "PATCH",
          url: `/v1/workspaces/${w1Id}`,
          cookie: cookies.admin,
          payload: { name: "Acme Renamed" },
        })
      ).statusCode,
    ).toBe(200);

    // Admins may manage admin/editor/viewer rows.
    expect(
      (
        await call(world.app, {
          method: "PATCH",
          url: `/v1/workspaces/${w1Id}/members/${userIds.editor}`,
          cookie: cookies.admin,
          payload: { role: "viewer" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call(world.app, {
          method: "PATCH",
          url: `/v1/workspaces/${w1Id}/members/${userIds.editor}`,
          cookie: cookies.admin,
          payload: { role: "editor" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call(world.app, {
          method: "DELETE",
          url: `/v1/workspaces/${w1Id}/members/${userIds.editor}`,
          cookie: cookies.admin,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await addMember(cookies.admin, w1Id, "editor@example.com", "editor"))
        .statusCode,
    ).toBe(200);

    // Admins may create and delete projects.
    const created = await createProject(cookies.admin, w1Id, "Admin Project");
    expect(created.statusCode).toBe(200);
    const adminProjectId = projectResponseSchema.parse(created.json()).project
      .id;
    expect(
      (
        await call(world.app, {
          method: "DELETE",
          url: `/v1/workspaces/${w1Id}/projects/${adminProjectId}`,
          cookie: cookies.admin,
        })
      ).statusCode,
    ).toBe(204);

    // Admins may read the audit log.
    expect(
      (
        await call(world.app, {
          method: "GET",
          url: `/v1/workspaces/${w1Id}/audit-events`,
          cookie: cookies.admin,
        })
      ).statusCode,
    ).toBe(200);
  });

  it("admin: cannot grant owner or touch an owner's membership", async () => {
    expectError(
      await addMember(cookies.admin, w1Id, "owner2@example.com", "owner"),
      403,
      "forbidden",
    );
    expectError(
      await call(world.app, {
        method: "PATCH",
        url: `/v1/workspaces/${w1Id}/members/${userIds.editor}`,
        cookie: cookies.admin,
        payload: { role: "owner" },
      }),
      403,
      "forbidden",
    );
    expectError(
      await call(world.app, {
        method: "PATCH",
        url: `/v1/workspaces/${w1Id}/members/${userIds.owner}`,
        cookie: cookies.admin,
        payload: { role: "viewer" },
      }),
      403,
      "forbidden",
    );
    expectError(
      await call(world.app, {
        method: "DELETE",
        url: `/v1/workspaces/${w1Id}/members/${userIds.owner}`,
        cookie: cookies.admin,
      }),
      403,
      "forbidden",
    );
  });

  it("owner: can grant and revoke the owner role", async () => {
    const added = await addMember(
      cookies.owner,
      w1Id,
      "owner2@example.com",
      "owner",
    );
    expect(added.statusCode).toBe(200);

    const demoted = await call(world.app, {
      method: "PATCH",
      url: `/v1/workspaces/${w1Id}/members/${userIds.owner2}`,
      cookie: cookies.owner,
      payload: { role: "admin" },
    });
    expect(demoted.statusCode).toBe(200);
    expect(memberResponseSchema.parse(demoted.json()).member.role).toBe(
      "admin",
    );

    expect(
      (
        await call(world.app, {
          method: "DELETE",
          url: `/v1/workspaces/${w1Id}/members/${userIds.owner2}`,
          cookie: cookies.owner,
        })
      ).statusCode,
    ).toBe(204);
  });

  it("rejects unknown members and invalid input", async () => {
    expectError(
      await call(world.app, {
        method: "PATCH",
        url: `/v1/workspaces/${w1Id}/members/${userIds.owner2}`,
        cookie: cookies.owner,
        payload: { role: "viewer" },
      }),
      404,
      "member_not_found",
    );
    expectError(
      await call(world.app, {
        method: "DELETE",
        url: `/v1/workspaces/${w1Id}/members/not-a-uuid`,
        cookie: cookies.owner,
      }),
      404,
      "member_not_found",
    );
    expectError(
      await call(world.app, {
        method: "PATCH",
        url: `/v1/workspaces/${w1Id}`,
        cookie: cookies.owner,
        payload: { name: "" },
      }),
      400,
      "invalid_request",
    );
    expectError(
      await createProject(cookies.owner, w1Id, ""),
      400,
      "invalid_request",
    );
  });
});

describe("cross-workspace isolation", () => {
  beforeAll(async () => {
    const created = await call(world.app, {
      method: "POST",
      url: "/v1/workspaces",
      cookie: cookies.outsider,
      payload: { name: "Other Corp" },
    });
    expect(created.statusCode).toBe(200);
    w2Id = workspaceResponseSchema.parse(created.json()).workspace.id;
    const project = await createProject(cookies.outsider, w2Id, "Secret");
    expect(project.statusCode).toBe(200);
    p2Id = projectResponseSchema.parse(project.json()).project.id;
  });

  it("POST /v1/workspaces creates a workspace with the caller as owner", async () => {
    const list = workspaceListResponseSchema.parse(
      (
        await call(world.app, {
          method: "GET",
          url: "/v1/workspaces",
          cookie: cookies.outsider,
        })
      ).json(),
    );
    expect(list.workspaces).toEqual([
      { id: w2Id, name: "Other Corp", role: "owner", activeProjectId: null },
    ]);
  });

  it("non-members get 404 (not 403) for every workspace route", async () => {
    for (const req of [
      { method: "GET", url: `/v1/workspaces/${w1Id}` },
      { method: "GET", url: `/v1/workspaces/${w1Id}/members` },
      { method: "GET", url: `/v1/workspaces/${w1Id}/projects` },
      { method: "GET", url: `/v1/workspaces/${w1Id}/audit-events` },
      {
        method: "POST",
        url: `/v1/workspaces/${w1Id}/projects`,
        payload: { name: "x" },
      },
      {
        method: "PATCH",
        url: `/v1/workspaces/${w1Id}`,
        payload: { name: "x" },
      },
      {
        method: "PATCH",
        url: `/v1/workspaces/${w1Id}/active-project`,
        payload: { projectId: p2Id },
      },
    ] as const) {
      expectError(
        await call(world.app, { ...req, cookie: cookies.outsider }),
        404,
        "workspace_not_found",
      );
    }
    expectError(
      await call(world.app, {
        method: "GET",
        url: "/v1/workspaces/not-a-uuid",
        cookie: cookies.outsider,
      }),
      404,
      "workspace_not_found",
    );
  });

  it("project ids are invisible across workspaces", async () => {
    // The outsider's project does not exist inside Acme's tenant context.
    expectError(
      await call(world.app, {
        method: "PATCH",
        url: `/v1/workspaces/${w1Id}/active-project`,
        cookie: cookies.owner,
        payload: { projectId: p2Id },
      }),
      404,
      "project_not_found",
    );
    expectError(
      await call(world.app, {
        method: "PATCH",
        url: `/v1/workspaces/${w2Id}/projects/${p1Id}`,
        cookie: cookies.outsider,
        payload: { name: "x" },
      }),
      404,
      "project_not_found",
    );

    const w1Projects = projectListResponseSchema.parse(
      (
        await call(world.app, {
          method: "GET",
          url: `/v1/workspaces/${w1Id}/projects`,
          cookie: cookies.owner,
        })
      ).json(),
    );
    expect(w1Projects.projects.map((p) => p.id)).not.toContain(p2Id);
    const w2Projects = projectListResponseSchema.parse(
      (
        await call(world.app, {
          method: "GET",
          url: `/v1/workspaces/${w2Id}/projects`,
          cookie: cookies.outsider,
        })
      ).json(),
    );
    expect(w2Projects.projects.map((p) => p.id)).not.toContain(p1Id);
  });
});

describe("active project selection", () => {
  it("clears with null and rejects foreign or invalid projects", async () => {
    const cleared = await call(world.app, {
      method: "PATCH",
      url: `/v1/workspaces/${w1Id}/active-project`,
      cookie: cookies.viewer,
      payload: { projectId: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(activeProjectResponseSchema.parse(cleared.json())).toEqual({
      activeProjectId: null,
    });
    const list = workspaceListResponseSchema.parse(
      (
        await call(world.app, {
          method: "GET",
          url: "/v1/workspaces",
          cookie: cookies.viewer,
        })
      ).json(),
    );
    expect(list.workspaces[0]!.activeProjectId).toBeNull();

    expectError(
      await call(world.app, {
        method: "PATCH",
        url: `/v1/workspaces/${w1Id}/active-project`,
        cookie: cookies.viewer,
        payload: { projectId: "not-a-uuid" },
      }),
      400,
      "invalid_request",
    );
    expectError(
      await call(world.app, {
        method: "PATCH",
        url: `/v1/workspaces/${w1Id}/active-project`,
        cookie: cookies.viewer,
        payload: { projectId: crypto.randomUUID() },
      }),
      404,
      "project_not_found",
    );
  });
});

describe("archived projects", () => {
  const post = (path: string, cookie: string) =>
    call(world.app, {
      method: "POST",
      url: `/v1/workspaces/${w1Id}${path}`,
      cookie,
    });
  const patch = (path: string, cookie: string, payload: unknown) =>
    call(world.app, {
      method: "PATCH",
      url: `/v1/workspaces/${w1Id}${path}`,
      cookie,
      payload,
    });
  const activeOf = async (cookie: string) =>
    workspaceListResponseSchema
      .parse(
        (
          await call(world.app, {
            method: "GET",
            url: "/v1/workspaces",
            cookie,
          })
        ).json(),
      )
      .workspaces.find((w) => w.id === w1Id)?.activeProjectId;
  const newProject = async (name: string) =>
    projectResponseSchema.parse(
      (await createProject(cookies.owner, w1Id, name)).json(),
    ).project.id;
  const auditActions = async () =>
    auditEventListResponseSchema
      .parse(
        (
          await call(world.app, {
            method: "GET",
            url: `/v1/workspaces/${w1Id}/audit-events`,
            cookie: cookies.owner,
          })
        ).json(),
      )
      .events.map((e) => ({
        action: e.action,
        target: e.target,
        metadata: e.metadata,
      }));

  it("archives and unarchives a project; editors may, viewers may not", async () => {
    const p = await newProject("Archivable");
    expectError(
      await post(`/projects/${p}/archive`, cookies.viewer),
      403,
      "forbidden",
    );
    const archived = projectResponseSchema.parse(
      (await post(`/projects/${p}/archive`, cookies.editor)).json(),
    );
    expect(archived.project.archivedAt).not.toBeNull();
    // Idempotent: archiving again keeps the first archivedAt.
    const again = projectResponseSchema.parse(
      (await post(`/projects/${p}/archive`, cookies.editor)).json(),
    );
    expect(again.project.archivedAt).toBe(archived.project.archivedAt);
    // Archived projects stay in the list; clients filter.
    const listed = projectListResponseSchema.parse(
      (
        await call(world.app, {
          method: "GET",
          url: `/v1/workspaces/${w1Id}/projects`,
          cookie: cookies.viewer,
        })
      ).json(),
    );
    expect(listed.projects.find((x) => x.id === p)?.archivedAt).toBe(
      archived.project.archivedAt,
    );
    const unarchived = await post(`/projects/${p}/unarchive`, cookies.editor);
    expect(unarchived.statusCode).toBe(200);
    expect(
      projectResponseSchema.parse(unarchived.json()).project.archivedAt,
    ).toBeNull();
    expectError(
      await post(`/projects/${crypto.randomUUID()}/archive`, cookies.editor),
      404,
      "project_not_found",
    );
    expectError(
      await post(`/projects/nope/unarchive`, cookies.editor),
      404,
      "project_not_found",
    );
    const events = await auditActions();
    expect(events).toContainEqual({
      action: "project.archived",
      target: p,
      metadata: { name: "Archivable" },
    });
    expect(events).toContainEqual({
      action: "project.unarchived",
      target: p,
      metadata: { name: "Archivable" },
    });
    // Only state flips are audited: the repeated archive above and an
    // unarchive of an unarchived project write nothing.
    expect(
      (await post(`/projects/${p}/unarchive`, cookies.editor)).statusCode,
    ).toBe(200);
    const flips = (await auditActions()).filter((e) => e.target === p);
    expect(flips.map((e) => e.action)).toEqual([
      "project.unarchived",
      "project.archived",
      "project.created",
    ]);
  });

  it("archiving ends the active project for good; un-archiving does not switch back (#641)", async () => {
    const p = await newProject("Active then archived");
    for (const cookie of [cookies.owner, cookies.editor]) {
      expect(
        (await patch("/active-project", cookie, { projectId: p })).statusCode,
      ).toBe(200);
    }
    await post(`/projects/${p}/archive`, cookies.owner);
    expect(await activeOf(cookies.owner)).toBeNull();
    // The stored choice is cleared, not only read back as "All".
    const stored = await world.admin`
      select count(*)::int as n from memberships
      where workspace_id = ${w1Id} and active_project_id = ${p}`;
    expect(stored[0]?.n).toBe(0);
    await post(`/projects/${p}/unarchive`, cookies.owner);
    expect(await activeOf(cookies.owner)).toBeNull();
    expect(await activeOf(cookies.editor)).toBeNull();
  });

  it("un-archiving clears an active project stored before the rule (#641)", async () => {
    const p = await newProject("Archived earlier");
    await patch("/active-project", cookies.owner, { projectId: p });
    // A pointer left behind by an archive before #641.
    await world.admin`update projects set archived_at = now() where id = ${p}`;
    expect(await activeOf(cookies.owner)).toBeNull();
    await post(`/projects/${p}/unarchive`, cookies.owner);
    expect(await activeOf(cookies.owner)).toBeNull();
  });

  it("refuses an archived project as active project", async () => {
    const archived = await newProject("Already archived");
    await post(`/projects/${archived}/archive`, cookies.owner);
    expectError(
      await patch("/active-project", cookies.owner, { projectId: archived }),
      409,
      "project_archived",
    );
    expect(await activeOf(cookies.owner)).toBeNull();
  });

  it("hard delete is unchanged", async () => {
    const p = await newProject("Deleted");
    const [dashboard] = await world.admin`
      insert into dashboards (workspace_id, project_id, name)
      values (${w1Id}, ${p}, 'In deleted') returning id`;
    const [model] = await world.admin`
      insert into data_models (workspace_id, project_id, name, definition)
      values (${w1Id}, ${p}, 'Model in deleted', ${world.admin.json({})})
      returning id`;
    await post(`/projects/${p}/archive`, cookies.owner);
    const deleted = await call(world.app, {
      method: "DELETE",
      url: `/v1/workspaces/${w1Id}/projects/${p}`,
      cookie: cookies.owner,
    });
    expect(deleted.statusCode).toBe(204);
    const [d] = await world.admin`
      select project_id from dashboards where id = ${dashboard!.id as string}`;
    const [m] = await world.admin`
      select project_id from data_models where id = ${model!.id as string}`;
    expect(d!.project_id).toBeNull();
    expect(m!.project_id).toBeNull();
    expect(await auditActions()).toContainEqual({
      action: "project.deleted",
      target: p,
      metadata: { name: "Deleted" },
    });
  });
});

describe("last owner protection", () => {
  it("the sole owner cannot leave or be demoted", async () => {
    expectError(
      await call(world.app, {
        method: "DELETE",
        url: `/v1/workspaces/${w2Id}/members/${userIds.outsider}`,
        cookie: cookies.outsider,
      }),
      409,
      "last_owner",
    );
    expectError(
      await call(world.app, {
        method: "PATCH",
        url: `/v1/workspaces/${w2Id}/members/${userIds.outsider}`,
        cookie: cookies.outsider,
        payload: { role: "viewer" },
      }),
      409,
      "last_owner",
    );
  });

  it("works once a second owner exists", async () => {
    expect(
      (await addMember(cookies.outsider, w2Id, "second@example.com", "owner"))
        .statusCode,
    ).toBe(200);

    expect(
      (
        await call(world.app, {
          method: "DELETE",
          url: `/v1/workspaces/${w2Id}/members/${userIds.outsider}`,
          cookie: cookies.outsider,
        })
      ).statusCode,
    ).toBe(204);

    // The departed owner's membership is really gone.
    expectError(
      await call(world.app, {
        method: "GET",
        url: `/v1/workspaces/${w2Id}`,
        cookie: cookies.outsider,
      }),
      404,
      "workspace_not_found",
    );
  });
});

describe("audit events", () => {
  it("lists workspace events newest-first with the acting user", async () => {
    const response = await call(world.app, {
      method: "GET",
      url: `/v1/workspaces/${w1Id}/audit-events`,
      cookie: cookies.owner,
    });
    expect(response.statusCode).toBe(200);
    const { events } = auditEventListResponseSchema.parse(response.json());

    const actions = new Set(events.map((e) => e.action));
    for (const action of [
      "workspace.bootstrap",
      "workspace.renamed",
      "invitation.created",
      "invitation.accepted",
      "membership.role_changed",
      "membership.removed",
      "project.created",
      "project.renamed",
      "project.deleted",
    ]) {
      expect(actions, action).toContain(action);
    }

    const created = events.find(
      (e) => e.action === "project.created" && e.target === p1Id,
    );
    expect(created?.actorUserId).toBe(userIds.owner);
    const invitedViewer = events.find(
      (e) =>
        e.action === "invitation.created" &&
        e.metadata.email === "viewer@example.com",
    );
    expect(invitedViewer?.actorUserId).toBe(userIds.owner);
    expect(invitedViewer?.metadata).toMatchObject({ role: "viewer" });
    const acceptedViewer = events.find(
      (e) =>
        e.action === "invitation.accepted" &&
        e.metadata.email === "viewer@example.com",
    );
    expect(acceptedViewer?.actorUserId).toBe(userIds.viewer);

    const timestamps = events.map((e) => Date.parse(e.createdAt));
    const sorted = [...timestamps].sort((a, b) => b - a);
    expect(timestamps).toEqual(sorted);

    // Installation-level auth.login events never leak into a workspace log.
    expect(actions.has("auth.login")).toBe(false);
  });

  it("denies the audit log to viewers", async () => {
    expectError(
      await call(world.app, {
        method: "GET",
        url: `/v1/workspaces/${w1Id}/audit-events`,
        cookie: cookies.viewer,
      }),
      403,
      "forbidden",
    );
  });

  it("scopes audit rows to their workspace", async () => {
    const response = await call(world.app, {
      method: "GET",
      url: `/v1/workspaces/${w2Id}/audit-events`,
      cookie: cookies.second,
    });
    expect(response.statusCode).toBe(200);
    const { events } = auditEventListResponseSchema.parse(response.json());
    const actions = new Set(events.map((e) => e.action));
    expect(actions).toContain("workspace.created");
    expect(actions).toContain("invitation.accepted");
    expect(actions).toContain("membership.removed");
    expect(actions).toContain("project.created");
    expect(actions.has("workspace.bootstrap")).toBe(false);
    expect(actions.has("workspace.renamed")).toBe(false);
    const created = events.find((e) => e.action === "workspace.created");
    expect(created?.actorUserId).toBe(userIds.outsider);
  });

  it("writes installation-level auth.login rows on sign-in", async () => {
    const before = await world.admin`
      select count(*)::int as count from audit_events where action = 'auth.login'
    `;
    const signIn = await world.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: "owner@example.com", password: "password-12345" },
    });
    expect(signIn.statusCode).toBe(200);
    const after = await world.admin`
      select workspace_id, actor_user_id, metadata from audit_events
      where action = 'auth.login' order by created_at desc
    `;
    expect(after.length).toBe(before[0]!.count + 1);
    expect(after[0]!.workspace_id).toBeNull();
    expect(after[0]!.actor_user_id).toBe(userIds.owner);
  });
});

describe("self removal", () => {
  it("a viewer can leave a workspace", async () => {
    expect(
      (
        await call(world.app, {
          method: "DELETE",
          url: `/v1/workspaces/${w1Id}/members/${userIds.viewer}`,
          cookie: cookies.viewer,
        })
      ).statusCode,
    ).toBe(204);

    const list = workspaceListResponseSchema.parse(
      (
        await call(world.app, {
          method: "GET",
          url: "/v1/workspaces",
          cookie: cookies.viewer,
        })
      ).json(),
    );
    expect(list.workspaces).toEqual([]);
    expectError(
      await call(world.app, {
        method: "GET",
        url: `/v1/workspaces/${w1Id}`,
        cookie: cookies.viewer,
      }),
      404,
      "workspace_not_found",
    );
  });
});

// #736: a new workspace counts its data days in the creator's zone, which
// the web app sends from the browser. A zone the server does not know (an
// old or unusual browser) must not block creating the workspace: UTC.
describe("time zone at creation", () => {
  const create = async (payload: Record<string, unknown>) => {
    const created = await call(world.app, {
      method: "POST",
      url: "/v1/workspaces",
      cookie: cookies.outsider,
      payload,
    });
    expect(created.statusCode).toBe(200);
    const { id } = workspaceResponseSchema.parse(created.json()).workspace;
    const detail = await call(world.app, {
      method: "GET",
      url: `/v1/workspaces/${id}`,
      cookie: cookies.outsider,
    });
    return workspaceResponseSchema.parse(detail.json()).workspace.timeZone;
  };

  it("stores the zone the creator's browser sent", async () => {
    expect(await create({ name: "Berlin", timeZone: "Europe/Berlin" })).toBe(
      "Europe/Berlin",
    );
  });

  it("falls back to UTC for an unknown zone or none", async () => {
    expect(await create({ name: "Mars", timeZone: "Mars/Olympus" })).toBe(
      "UTC",
    );
    expect(await create({ name: "Blank", timeZone: "" })).toBe("UTC");
    expect(await create({ name: "None" })).toBe("UTC");
  });
});
