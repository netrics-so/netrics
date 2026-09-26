/**
 * Adversarial cross-workspace suite — the hostile twin of workspaces.test.ts.
 *
 * Where workspaces.test.ts proves that documented behavior works, this file
 * tries to break tenant isolation on purpose: identifier probing (existence
 * oracles), malformed and injection-shaped ids, role-escalation attempts,
 * session tampering/replay, and audit-log cross-reads. Two workspaces are
 * pitted against each other: W1 (owner A, editor B, admin ADM) and W2
 * (owner C), plus OUTSIDER with no memberships and D with a third workspace
 * W3 used only for member-add probes.
 *
 * Known accepted trade-off (recorded in ADR 0005 and the milestone 02 doc):
 * POST /members resolves the invitee by email against the installation-level
 * users table, so a workspace admin can distinguish "no such account" (404
 * user_not_found) from "account exists" (200). User accounts are not
 * workspace-owned, and invitations are out of scope until milestone 14, so
 * this existence oracle is deliberate for now and must be revisited when
 * invitation flows land.
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  auditEventListResponseSchema,
  errorResponseSchema,
  meResponseSchema,
  workspaceListResponseSchema,
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

type UserKey = "a" | "b" | "adm" | "c" | "d" | "outsider";
let world: World;
const cookies = {} as Record<UserKey, string>;
const userIds = {} as Record<UserKey, string>;
let w1Id: string;
let w2Id: string;
let w3Id: string;
let p1Id: string;
let p2Id: string;

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

beforeAll(async () => {
  world = await createWorld();
  for (const key of ["a", "b", "adm", "c", "d", "outsider"] as const) {
    cookies[key] = await signUpUser(
      world.app,
      `${key}@example.com`,
      `user-${key}`,
    );
    const me = await call(world.app, {
      method: "GET",
      url: "/v1/me",
      cookie: cookies[key],
    });
    userIds[key] = meResponseSchema.parse(me.json()).user.id;
  }

  // W1 via bootstrap (owner A), with one project and editor/admin members.
  const bootstrapped = await call(world.app, {
    method: "POST",
    url: "/v1/bootstrap",
    cookie: cookies.a,
    payload: { workspaceName: "W1" },
  });
  expect(bootstrapped.statusCode).toBe(200);
  w1Id = workspaceListResponseSchema.parse(
    (
      await call(world.app, {
        method: "GET",
        url: "/v1/workspaces",
        cookie: cookies.a,
      })
    ).json(),
  ).workspaces[0]!.id;

  const project = await call(world.app, {
    method: "POST",
    url: `/v1/workspaces/${w1Id}/projects`,
    cookie: cookies.a,
    payload: { name: "P1" },
  });
  expect(project.statusCode).toBe(200);
  p1Id = (project.json() as { project: { id: string } }).project.id;
  expect(
    (await addMember(cookies.a, w1Id, "b@example.com", "editor")).statusCode,
  ).toBe(200);
  expect(
    (await addMember(cookies.a, w1Id, "adm@example.com", "admin")).statusCode,
  ).toBe(200);

  // W2 (owner C) with one project; W3 (owner D) left empty for probes.
  for (const [key, name] of [
    ["c", "W2"],
    ["d", "W3"],
  ] as const) {
    const created = await call(world.app, {
      method: "POST",
      url: "/v1/workspaces",
      cookie: cookies[key],
      payload: { name },
    });
    expect(created.statusCode).toBe(200);
    const id = (created.json() as { workspace: { id: string } }).workspace.id;
    if (key === "c") {
      w2Id = id;
    } else {
      w3Id = id;
    }
  }
  const p2 = await call(world.app, {
    method: "POST",
    url: `/v1/workspaces/${w2Id}/projects`,
    cookie: cookies.c,
    payload: { name: "P2" },
  });
  expect(p2.statusCode).toBe(200);
  p2Id = (p2.json() as { project: { id: string } }).project.id;
}, 60_000);

afterAll(async () => {
  await world.close();
});

describe("identifier probing: no workspace existence oracle", () => {
  // Every workspace-scoped route, with real foreign sub-resource ids where
  // the URL has one. For a non-member (C targeting W1) each response must be
  // byte-identical to the same request against a random non-existent uuid.
  const routes = (): Array<
    Omit<Call, "cookie" | "url"> & { path: (wid: string) => string }
  > => [
    { method: "GET", path: (w) => `/v1/workspaces/${w}` },
    {
      method: "PATCH",
      path: (w) => `/v1/workspaces/${w}`,
      payload: { name: "probe" },
    },
    { method: "GET", path: (w) => `/v1/workspaces/${w}/members` },
    {
      method: "POST",
      path: (w) => `/v1/workspaces/${w}/members`,
      payload: { email: "outsider@example.com", role: "viewer" },
    },
    {
      method: "PATCH",
      path: (w) => `/v1/workspaces/${w}/members/${userIds.a}`,
      payload: { role: "viewer" },
    },
    {
      method: "DELETE",
      path: (w) => `/v1/workspaces/${w}/members/${userIds.a}`,
    },
    { method: "GET", path: (w) => `/v1/workspaces/${w}/projects` },
    {
      method: "POST",
      path: (w) => `/v1/workspaces/${w}/projects`,
      payload: { name: "probe" },
    },
    {
      method: "PATCH",
      path: (w) => `/v1/workspaces/${w}/projects/${p1Id}`,
      payload: { name: "probe" },
    },
    { method: "DELETE", path: (w) => `/v1/workspaces/${w}/projects/${p1Id}` },
    { method: "GET", path: (w) => `/v1/workspaces/${w}/audit-events` },
    {
      method: "PATCH",
      path: (w) => `/v1/workspaces/${w}/active-project`,
      payload: { projectId: p1Id },
    },
  ];

  it("a real foreign workspace id is indistinguishable from a random uuid", async () => {
    for (const route of routes()) {
      const real = await call(world.app, {
        method: route.method,
        url: route.path(w1Id),
        cookie: cookies.c,
        ...(route.payload !== undefined ? { payload: route.payload } : {}),
      });
      const ghost = await call(world.app, {
        method: route.method,
        url: route.path(randomUUID()),
        cookie: cookies.c,
        ...(route.payload !== undefined ? { payload: route.payload } : {}),
      });
      expect(real.statusCode, `${route.method} ${route.path("<wid>")}`).toBe(
        404,
      );
      expect(ghost.statusCode).toBe(404);
      expect(real.json()).toEqual({ error: "workspace_not_found" });
      expect(real.json()).toEqual(ghost.json());
      expect(real.headers["content-type"]).toBe(ghost.headers["content-type"]);
    }
  });
});

describe("identifier probing: no sub-resource existence oracle", () => {
  // A is a member of W1 and probes W2's real ids from inside W1: a project
  // or user that exists only in another workspace must answer exactly like a
  // random uuid.
  it("W2's project id is indistinguishable from a random uuid inside W1", async () => {
    for (const method of ["PATCH", "DELETE"] as const) {
      for (const projectId of [p2Id, randomUUID()]) {
        const response = await call(world.app, {
          method,
          url: `/v1/workspaces/${w1Id}/projects/${projectId}`,
          cookie: cookies.a,
          ...(method === "PATCH" ? { payload: { name: "probe" } } : {}),
        });
        expectError(response, 404, "project_not_found");
      }
    }
    for (const projectId of [p2Id, randomUUID()]) {
      const response = await call(world.app, {
        method: "PATCH",
        url: `/v1/workspaces/${w1Id}/active-project`,
        cookie: cookies.a,
        payload: { projectId },
      });
      expectError(response, 404, "project_not_found");
    }
  });

  it("a user who is not a W1 member is indistinguishable from a random uuid", async () => {
    for (const target of [userIds.c, randomUUID()]) {
      expectError(
        await call(world.app, {
          method: "PATCH",
          url: `/v1/workspaces/${w1Id}/members/${target}`,
          cookie: cookies.a,
          payload: { role: "viewer" },
        }),
        404,
        "member_not_found",
      );
      expectError(
        await call(world.app, {
          method: "DELETE",
          url: `/v1/workspaces/${w1Id}/members/${target}`,
          cookie: cookies.a,
        }),
        404,
        "member_not_found",
      );
    }
  });
});

describe("malformed identifiers", () => {
  const nasty = [
    "not-a-uuid",
    "' OR '1'='1",
    "1; DROP TABLE workspaces; --",
    "null%00byte",
    "..%2f..%2fworkspaces",
    "x".repeat(500),
  ];

  it("never 500s and never leaks data for workspace-id position", async () => {
    for (const raw of nasty) {
      for (const cookie of [cookies.a, cookies.c]) {
        const response = await call(world.app, {
          method: "GET",
          url: `/v1/workspaces/${encodeURIComponent(raw)}`,
          cookie,
        });
        // Oversized segments may be rejected as 414 by the router; anything
        // below 500 without data is acceptable.
        expect(response.statusCode, raw).toBeLessThan(500);
        if (response.statusCode === 404) {
          expectError(response, 404, "workspace_not_found");
        }
        expect(response.body).not.toContain(w1Id);
      }
    }
    // Trailing-slash / empty-segment URL: routing-level 404 is fine, 500 is not.
    const empty = await call(world.app, {
      method: "GET",
      url: "/v1/workspaces/",
      cookie: cookies.c,
    });
    expect(empty.statusCode).toBeLessThan(500);
    expect(JSON.stringify(empty.json())).not.toContain(w1Id);
  });

  it("never 500s for member and project id positions", async () => {
    for (const raw of nasty) {
      const id = encodeURIComponent(raw);
      for (const [kind, path] of [
        ["member", `/v1/workspaces/${w1Id}/members/${id}`],
        ["project", `/v1/workspaces/${w1Id}/projects/${id}`],
      ] as const) {
        const response = await call(world.app, {
          method: "DELETE",
          url: path,
          cookie: cookies.a,
        });
        expect(response.statusCode, `${kind} ${raw}`).toBeLessThan(500);
        if (response.statusCode === 404) {
          expectError(response, 404, `${kind}_not_found`);
        }
      }
    }
  });
});

describe("count and list oracles", () => {
  it("workspace lists contain only the caller's own memberships", async () => {
    const list = workspaceListResponseSchema.parse(
      (
        await call(world.app, {
          method: "GET",
          url: "/v1/workspaces",
          cookie: cookies.c,
        })
      ).json(),
    );
    expect(list.workspaces).toEqual([
      { id: w2Id, name: "W2", role: "owner", activeProjectId: null },
    ]);
  });

  it("responses to C never mention W1 identifiers (and vice versa)", async () => {
    const asC = await call(world.app, {
      method: "GET",
      url: "/v1/me",
      cookie: cookies.c,
    });
    const meC = meResponseSchema.parse(asC.json());
    expect(meC.memberships.map((m) => m.workspaceId)).toEqual([w2Id]);
    for (const leaked of [w1Id, p1Id]) {
      expect(asC.body).not.toContain(leaked);
    }

    const asA = await call(world.app, {
      method: "GET",
      url: "/v1/me",
      cookie: cookies.a,
    });
    for (const leaked of [w2Id, w3Id, p2Id]) {
      expect(asA.body).not.toContain(leaked);
    }
  });
});

describe("member-add user existence oracle (accepted trade-off)", () => {
  // See the file header and ADR 0005: users are installation-level, so a
  // workspace admin can probe account existence by email until invitation
  // flows land in milestone 14. These tests pin the behavior as-is.
  it("unknown email → 404 user_not_found, existing email → 200", async () => {
    expectError(
      await addMember(cookies.d, w3Id, "ghost@example.com", "viewer"),
      404,
      "user_not_found",
    );
    const added = await addMember(cookies.d, w3Id, "b@example.com", "viewer");
    expect(added.statusCode).toBe(200);
  });
});

describe("role escalation attempts", () => {
  it("editor cannot reach owner/admin actions or self-promote", async () => {
    const forbidden: Array<Omit<Call, "cookie">> = [
      {
        method: "PATCH",
        url: `/v1/workspaces/${w1Id}`,
        payload: { name: "Hijack" },
      },
      {
        method: "POST",
        url: `/v1/workspaces/${w1Id}/members`,
        payload: { email: "outsider@example.com", role: "viewer" },
      },
      {
        method: "PATCH",
        url: `/v1/workspaces/${w1Id}/members/${userIds.adm}`,
        payload: { role: "viewer" },
      },
      {
        method: "DELETE",
        url: `/v1/workspaces/${w1Id}/members/${userIds.adm}`,
      },
      { method: "DELETE", url: `/v1/workspaces/${w1Id}/projects/${p1Id}` },
      { method: "GET", url: `/v1/workspaces/${w1Id}/audit-events` },
      {
        method: "PATCH",
        url: `/v1/workspaces/${w1Id}/members/${userIds.b}`,
        payload: { role: "admin" },
      },
      {
        method: "PATCH",
        url: `/v1/workspaces/${w1Id}/members/${userIds.b}`,
        payload: { role: "owner" },
      },
    ];
    for (const req of forbidden) {
      expectError(
        await call(world.app, { ...req, cookie: cookies.b }),
        403,
        "forbidden",
      );
    }
  });

  it("admin cannot grant, change, or remove the owner role", async () => {
    const forbidden: Array<Omit<Call, "cookie">> = [
      {
        method: "POST",
        url: `/v1/workspaces/${w1Id}/members`,
        payload: { email: "outsider@example.com", role: "owner" },
      },
      {
        method: "PATCH",
        url: `/v1/workspaces/${w1Id}/members/${userIds.a}`,
        payload: { role: "viewer" },
      },
      { method: "DELETE", url: `/v1/workspaces/${w1Id}/members/${userIds.a}` },
      {
        method: "PATCH",
        url: `/v1/workspaces/${w1Id}/members/${userIds.adm}`,
        payload: { role: "owner" },
      },
    ];
    for (const req of forbidden) {
      expectError(
        await call(world.app, { ...req, cookie: cookies.adm }),
        403,
        "forbidden",
      );
    }
  });
});

describe("non-member with a valid session", () => {
  it("a stolen-looking session without membership only ever sees 404/empty", async () => {
    for (const req of [
      { method: "GET", url: `/v1/workspaces/${w1Id}` },
      { method: "GET", url: `/v1/workspaces/${w2Id}` },
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
        url: `/v1/workspaces/${w1Id}/active-project`,
        payload: { projectId: p1Id },
      },
    ] as const) {
      expectError(
        await call(world.app, { ...req, cookie: cookies.outsider }),
        404,
        "workspace_not_found",
      );
    }
    const list = workspaceListResponseSchema.parse(
      (
        await call(world.app, {
          method: "GET",
          url: "/v1/workspaces",
          cookie: cookies.outsider,
        })
      ).json(),
    );
    expect(list.workspaces).toEqual([]);
  });

  it("A's valid session presented against W2 yields 404, not data", async () => {
    expectError(
      await call(world.app, {
        method: "GET",
        url: `/v1/workspaces/${w2Id}`,
        cookie: cookies.a,
      }),
      404,
      "workspace_not_found",
    );
    expectError(
      await call(world.app, {
        method: "PATCH",
        url: `/v1/workspaces/${w2Id}`,
        cookie: cookies.a,
        payload: { name: "Hijack" },
      }),
      404,
      "workspace_not_found",
    );
  });

  it("a member cannot select another workspace's project as active", async () => {
    expectError(
      await call(world.app, {
        method: "PATCH",
        url: `/v1/workspaces/${w2Id}/active-project`,
        cookie: cookies.c,
        payload: { projectId: p1Id },
      }),
      404,
      "project_not_found",
    );
    const list = workspaceListResponseSchema.parse(
      (
        await call(world.app, {
          method: "GET",
          url: "/v1/workspaces",
          cookie: cookies.c,
        })
      ).json(),
    );
    expect(list.workspaces[0]!.activeProjectId).toBeNull();
  });
});

describe("session attacks", () => {
  it("a revoked session fails everywhere the old cookie is replayed", async () => {
    const cookie = await signUpUser(
      world.app,
      "revokee@example.com",
      "revokee",
    );
    expect(
      (await call(world.app, { method: "GET", url: "/v1/me", cookie }))
        .statusCode,
    ).toBe(200);

    const signOut = await call(world.app, {
      method: "POST",
      url: "/api/auth/sign-out",
      cookie,
    });
    expect(signOut.statusCode).toBe(200);

    for (const url of ["/v1/me", "/v1/workspaces"]) {
      expectError(
        await call(world.app, { method: "GET", url, cookie }),
        401,
        "unauthorized",
      );
    }
    const getSession = await call(world.app, {
      method: "GET",
      url: "/api/auth/get-session",
      cookie,
    });
    expect(getSession.statusCode).toBe(200);
    expect(getSession.body).toBe("null");
  });

  it("tampered or forged session cookies are rejected", async () => {
    const valid = cookies.a;
    const value = valid.split("=")[1]!;
    const flip = (s: string, at: number) =>
      s.slice(0, at) + (s[at] === "a" ? "b" : "a") + s.slice(at + 1);
    const forged = [
      // Token portion mutated (session lookup miss).
      `better-auth.session_token=${flip(value, 1)}`,
      // Signature portion mutated (signature mismatch).
      `better-auth.session_token=${flip(value, value.length - 2)}`,
      "better-auth.session_token=forged-token-value",
      "better-auth.session_token=",
    ];
    for (const cookie of forged) {
      for (const url of [
        "/v1/me",
        "/v1/workspaces",
        `/v1/workspaces/${w1Id}`,
      ]) {
        expectError(
          await call(world.app, { method: "GET", url, cookie }),
          401,
          "unauthorized",
        );
      }
    }
  });
});

describe("audit isolation", () => {
  it("workspace audit logs never contain each other's events", async () => {
    // Distinctive marker actions in each workspace.
    expect(
      (
        await call(world.app, {
          method: "PATCH",
          url: `/v1/workspaces/${w1Id}`,
          cookie: cookies.a,
          payload: { name: "W1-marker-alpha" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call(world.app, {
          method: "PATCH",
          url: `/v1/workspaces/${w2Id}`,
          cookie: cookies.c,
          payload: { name: "W2-marker-beta" },
        })
      ).statusCode,
    ).toBe(200);

    const w1Events = auditEventListResponseSchema.parse(
      (
        await call(world.app, {
          method: "GET",
          url: `/v1/workspaces/${w1Id}/audit-events`,
          cookie: cookies.a,
        })
      ).json(),
    ).events;
    const w2Events = auditEventListResponseSchema.parse(
      (
        await call(world.app, {
          method: "GET",
          url: `/v1/workspaces/${w2Id}/audit-events`,
          cookie: cookies.c,
        })
      ).json(),
    ).events;

    const w1Names = new Set(w1Events.map((e) => JSON.stringify(e.metadata)));
    const w2Names = new Set(w2Events.map((e) => JSON.stringify(e.metadata)));
    expect([...w1Names].join()).toContain("W1-marker-alpha");
    expect([...w1Names].join()).not.toContain("W2-marker-beta");
    expect([...w2Names].join()).toContain("W2-marker-beta");
    expect([...w2Names].join()).not.toContain("W1-marker-alpha");

    const w1Ids = new Set(w1Events.map((e) => e.id));
    expect(w2Events.some((e) => w1Ids.has(e.id))).toBe(false);
  });

  it("installation-level auth.login rows are unreachable via tenant routes", async () => {
    const rows = await world.admin`
      select count(*)::int as count from audit_events
      where action = 'auth.login' and workspace_id is null
    `;
    expect(rows[0]!.count).toBeGreaterThan(0);

    for (const [workspaceId, cookie] of [
      [w1Id, cookies.a],
      [w2Id, cookies.c],
    ] as const) {
      const { events } = auditEventListResponseSchema.parse(
        (
          await call(world.app, {
            method: "GET",
            url: `/v1/workspaces/${workspaceId}/audit-events`,
            cookie,
          })
        ).json(),
      );
      expect(events.some((e) => e.action === "auth.login")).toBe(false);
    }
  });
});
