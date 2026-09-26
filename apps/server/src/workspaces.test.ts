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
import { createTestDatabase } from "./test-db.js";

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
  return call(world.app, {
    method: "POST",
    url: `/v1/workspaces/${workspaceId}/members`,
    cookie,
    payload: { email, role },
  });
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
}, 60_000);

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
    const { member } = memberResponseSchema.parse(added.json());
    expect(member).toMatchObject({
      userId: userIds.viewer,
      email: "viewer@example.com",
      displayName: "viewer",
      role: "viewer",
    });

    // Unknown users are not auto-provisioned.
    expectError(
      await addMember(cookies.owner, w1Id, "ghost@example.com", "viewer"),
      404,
      "user_not_found",
    );

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
      "membership.added",
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
    const addedViewer = events.find(
      (e) => e.action === "membership.added" && e.target === userIds.viewer,
    );
    expect(addedViewer?.actorUserId).toBe(userIds.owner);
    expect(addedViewer?.metadata).toMatchObject({ role: "viewer" });

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
    expect(actions).toContain("membership.added");
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
