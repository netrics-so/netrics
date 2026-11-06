import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  dashboardResponseSchema,
  themeErrorResponseSchema,
  themeListResponseSchema,
  themeResponseSchema,
  workspaceResponseSchema,
} from "@netrics/contracts";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";
import { BUILTIN_THEMES, BUILTIN_THEME_KEYS } from "@netrics/domain";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";
import { addMemberViaInvitation } from "./test-helpers.js";
import { createTestDatabase } from "./test-db.js";

// Dashboard themes (#216): built-ins, custom themes with a contrast floor,
// optimistic concurrency, deletion guarded by use, and a theme per
// dashboard.

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

let app: FastifyInstance;
let db: Database;
let admin: Sql;
let owner: string;
let editor: string;
let viewer: string;
let stranger: string;
let workspaceId: string;
let strangerWorkspaceId: string;

function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  cookie: string | null,
  payload?: unknown,
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

async function signUp(email: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { name: email, email, password: "password-12345" },
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers["set-cookie"];
  const cookies = Array.isArray(header) ? header : [header];
  return cookies
    .find((c) => c?.startsWith("better-auth.session_token="))!
    .split(";")[0]!;
}

async function newWorkspace(cookie: string): Promise<string> {
  const response = await call("POST", "/v1/workspaces", cookie, {
    name: "Themes",
  });
  return workspaceResponseSchema.parse(response.json()).workspace.id;
}

const themes = (workspace = workspaceId) =>
  `/v1/workspaces/${workspace}/themes`;
const dashboards = (workspace = workspaceId) =>
  `/v1/workspaces/${workspace}/dashboards`;

const dark = BUILTIN_THEMES.netrics_dark.tokens;

function expectError(response: InjectResponse, status: number, error: string) {
  expect(response.statusCode).toBe(status);
  const body = themeErrorResponseSchema.parse(response.json());
  expect(body.error).toBe(error);
  return body;
}

async function createTheme(
  name: string,
  extra: Record<string, unknown> = {},
  cookie = editor,
  workspace = workspaceId,
) {
  const response = await call("POST", themes(workspace), cookie, {
    name,
    base: "netrics_dark",
    ...extra,
  });
  expect(response.statusCode).toBe(200);
  return themeResponseSchema.parse(response.json()).theme;
}

beforeAll(async () => {
  const testDb = await createTestDatabase();
  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "silent",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
  });
  db = createDatabase(testDb.appUrl);
  const authService = createAuthService(config, db, {
    logger: pino({ level: "silent" }),
  });
  app = await buildApp(config, { db, authService, checkDb: async () => true });
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });

  owner = await signUp("theme-owner@example.com");
  editor = await signUp("theme-editor@example.com");
  viewer = await signUp("theme-viewer@example.com");
  stranger = await signUp("theme-stranger@example.com");
  workspaceId = await newWorkspace(owner);
  for (const [email, role] of [
    ["theme-editor@example.com", "editor"],
    ["theme-viewer@example.com", "viewer"],
  ] as const) {
    const added = await addMemberViaInvitation(
      app,
      db,
      owner,
      workspaceId,
      email,
      role,
    );
    expect(added.statusCode).toBe(200);
  }
  strangerWorkspaceId = await newWorkspace(stranger);
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin.end({ timeout: 5 }).catch(() => undefined);
});

describe("themes API", () => {
  it("lists the built-ins for every member", async () => {
    const response = await call("GET", themes(), viewer);
    expect(response.statusCode).toBe(200);
    const body = themeListResponseSchema.parse(response.json());
    expect(body.builtins.map((theme) => theme.key)).toEqual([
      ...BUILTIN_THEME_KEYS,
    ]);
    expect(body.builtins[0]).toEqual(BUILTIN_THEMES.netrics_dark);
  });

  it("creates a copy of a built-in, updates it and deletes it", async () => {
    const created = await createTheme("Copy of Paper", { base: "paper" });
    expect(created).toMatchObject({
      name: "Copy of Paper",
      base: "paper",
      version: 1,
      tokens: BUILTIN_THEMES.paper.tokens,
      warnings: [],
    });

    const read = await call("GET", `${themes()}/${created.id}`, viewer);
    expect(themeResponseSchema.parse(read.json()).theme).toEqual(created);

    // Upper case is accepted and stored lowercase; 3–4.5:1 is a warning.
    const updated = await call("PUT", `${themes()}/${created.id}`, editor, {
      version: 1,
      name: "Wurfel paper",
      tokens: { ...BUILTIN_THEMES.paper.tokens, muted: "#8C8273" },
    });
    expect(updated.statusCode).toBe(200);
    const theme = themeResponseSchema.parse(updated.json()).theme;
    expect(theme.version).toBe(2);
    expect(theme.tokens.muted).toBe("#8c8273");
    expect(theme.warnings).toEqual([
      expect.objectContaining({
        foreground: "muted",
        background: "surface",
        level: "warn",
      }),
    ]);

    const removed = await call("DELETE", `${themes()}/${created.id}`, editor);
    expect(removed.statusCode).toBe(204);
    expectError(
      await call("GET", `${themes()}/${created.id}`, viewer),
      404,
      "theme_not_found",
    );

    const audit = await admin`
      select action from audit_events
      where workspace_id = ${workspaceId} and target = ${created.id}
      order by created_at, id`;
    expect(audit.map((row) => row.action)).toEqual([
      "theme.created",
      "theme.updated",
      "theme.deleted",
    ]);
  });

  it("refuses a stale version", async () => {
    const theme = await createTheme("Versioned");
    const body = { version: 1, name: "Versioned", tokens: dark };
    expect(
      (await call("PUT", `${themes()}/${theme.id}`, editor, body)).statusCode,
    ).toBe(200);
    expectError(
      await call("PUT", `${themes()}/${theme.id}`, editor, body),
      409,
      "version_conflict",
    );
  });

  it("refuses text below 3:1 and names the pairs", async () => {
    const tooLow = { ...dark, muted: "#3a404a", text: "#2a2e36" };
    const created = expectError(
      await call("POST", themes(), editor, {
        name: "Unreadable",
        base: "netrics_dark",
        tokens: tooLow,
      }),
      400,
      "contrast_too_low",
    );
    expect(
      created.contrast?.map((c) => `${c.foreground}/${c.background}`),
    ).toEqual(["text/surface", "muted/surface", "text/background"]);
    expect(created.contrast?.every((c) => c.ratio < 3)).toBe(true);

    const theme = await createTheme("Readable");
    expectError(
      await call("PUT", `${themes()}/${theme.id}`, editor, {
        version: 1,
        name: "Readable",
        tokens: { ...dark, label: dark.surface },
      }),
      400,
      "contrast_too_low",
    );
    const unchanged = await call("GET", `${themes()}/${theme.id}`, viewer);
    expect(themeResponseSchema.parse(unchanged.json()).theme.version).toBe(1);
  });

  it("refuses incomplete or unknown tokens", async () => {
    const { chartFill: _chartFill, ...missing } = dark;
    for (const tokens of [
      missing,
      { ...dark, glow: "#ffffff" },
      { ...dark, accent: "blue" },
      { ...dark, fontScale: 0.8 },
    ]) {
      expectError(
        await call("POST", themes(), editor, {
          name: "Bad",
          base: "netrics_dark",
          tokens,
        }),
        400,
        "invalid_request",
      );
    }
    expectError(
      await call("POST", themes(), editor, { name: "Bad", base: "solarized" }),
      400,
      "invalid_request",
    );
  });

  it("keeps names unique per workspace, ignoring case", async () => {
    await createTheme("Brand");
    expectError(
      await call("POST", themes(), editor, {
        name: "brand",
        base: "light",
      }),
      409,
      "theme_name_taken",
    );
    const other = await createTheme("Other brand");
    expectError(
      await call("PUT", `${themes()}/${other.id}`, editor, {
        version: 1,
        name: "BRAND",
        tokens: dark,
      }),
      409,
      "theme_name_taken",
    );
    // Another workspace may use the same name.
    await createTheme("Brand", {}, stranger, strangerWorkspaceId);
  });

  it("lets viewers read but not change themes", async () => {
    expectError(
      await call("POST", themes(), viewer, {
        name: "Nope",
        base: "netrics_dark",
      }),
      403,
      "forbidden",
    );
    const theme = await createTheme("Viewer target");
    expectError(
      await call("PUT", `${themes()}/${theme.id}`, viewer, {
        version: 1,
        name: "Nope",
        tokens: dark,
      }),
      403,
      "forbidden",
    );
    expectError(
      await call("DELETE", `${themes()}/${theme.id}`, viewer),
      403,
      "forbidden",
    );
  });
});

describe("dashboard themes", () => {
  it("defaults to netrics Dark and switches between built-in and custom", async () => {
    const created = await call("POST", dashboards(), editor, { name: "Plain" });
    expect(created.statusCode).toBe(200);
    const { dashboard } = dashboardResponseSchema.parse(created.json());
    expect(dashboard.settings).toMatchObject({
      themeBuiltin: "netrics_dark",
      themeId: null,
      accentColor: null,
    });

    const theme = await createTheme("Brand dark");
    const custom = await call(
      "PUT",
      `${dashboards()}/${dashboard.id}`,
      editor,
      {
        version: 1,
        name: "Plain",
        projectId: null,
        tiles: [],
        settings: {
          themeId: theme.id,
          accentColor: "#F5A623",
        },
      },
    );
    expect(custom.statusCode).toBe(200);
    expect(
      dashboardResponseSchema.parse(custom.json()).dashboard.settings,
    ).toMatchObject({
      themeBuiltin: null,
      themeId: theme.id,
      accentColor: "#f5a623",
    });

    // Settings without theme fields keep the theme.
    const kept = await call("PUT", `${dashboards()}/${dashboard.id}`, editor, {
      version: 2,
      name: "Renamed",
      projectId: null,
      tiles: [],
      settings: { showHeader: false },
    });
    expect(
      dashboardResponseSchema.parse(kept.json()).dashboard.settings,
    ).toMatchObject({
      themeId: theme.id,
      accentColor: "#f5a623",
    });

    const copy = await call(
      "POST",
      `${dashboards()}/${dashboard.id}/duplicate`,
      editor,
      {},
    );
    expect(
      dashboardResponseSchema.parse(copy.json()).dashboard.settings,
    ).toMatchObject({
      themeBuiltin: null,
      themeId: theme.id,
      accentColor: "#f5a623",
    });

    const builtin = await call(
      "PUT",
      `${dashboards()}/${dashboard.id}`,
      editor,
      {
        version: 3,
        name: "Renamed",
        projectId: null,
        tiles: [],
        settings: {
          themeBuiltin: "high_contrast",
          accentColor: null,
        },
      },
    );
    expect(
      dashboardResponseSchema.parse(builtin.json()).dashboard.settings,
    ).toMatchObject({
      themeBuiltin: "high_contrast",
      themeId: null,
      accentColor: null,
    });
  });

  it("refuses both or an unknown theme", async () => {
    const theme = await createTheme("Either");
    expectError(
      await call("POST", dashboards(), editor, {
        name: "Both",
        settings: {
          themeBuiltin: "light",
          themeId: theme.id,
        },
      }),
      400,
      "invalid_request",
    );
    expectError(
      await call("POST", dashboards(), editor, {
        name: "Neither",
        settings: {
          themeBuiltin: null,
          themeId: null,
        },
      }),
      400,
      "invalid_request",
    );
    expectError(
      await call("POST", dashboards(), editor, {
        name: "Unknown",
        settings: {
          themeId: "00000000-0000-4000-8000-000000000000",
        },
      }),
      404,
      "theme_not_found",
    );
  });

  it("refuses a brand accent below 3:1 on the theme surface", async () => {
    expectError(
      await call("POST", dashboards(), editor, {
        name: "Dim accent",
        settings: {
          accentColor: "#1c2129",
        },
      }),
      400,
      "contrast_too_low",
    );
    // The same accent reads well on Light.
    const light = await call("POST", dashboards(), editor, {
      name: "Dark accent on light",
      settings: {
        themeBuiltin: "light",
        accentColor: "#1c2129",
      },
    });
    expect(light.statusCode).toBe(200);
    const { dashboard } = dashboardResponseSchema.parse(light.json());
    // Switching back to a dark theme keeps the accent and is checked again.
    expectError(
      await call("PUT", `${dashboards()}/${dashboard.id}`, editor, {
        version: 1,
        name: dashboard.name,
        projectId: null,
        tiles: [],
        settings: {
          themeBuiltin: "netrics_dark",
        },
      }),
      400,
      "contrast_too_low",
    );
  });

  it("refuses to delete a theme in use and names the dashboards", async () => {
    const theme = await createTheme("In use");
    const names = ["Wurfel", "Overview"];
    const ids: string[] = [];
    for (const name of names) {
      const response = await call("POST", dashboards(), editor, {
        name,
        settings: {
          themeId: theme.id,
        },
      });
      ids.push(dashboardResponseSchema.parse(response.json()).dashboard.id);
    }
    const refused = expectError(
      await call("DELETE", `${themes()}/${theme.id}`, editor),
      409,
      "theme_in_use",
    );
    expect(refused.dashboards).toEqual([
      { id: ids[1], name: "Overview" },
      { id: ids[0], name: "Wurfel" },
    ]);

    for (const id of ids) {
      expect(
        (await call("DELETE", `${dashboards()}/${id}`, owner)).statusCode,
      ).toBe(204);
    }
    expect(
      (await call("DELETE", `${themes()}/${theme.id}`, editor)).statusCode,
    ).toBe(204);
  });
});

describe("cross-workspace isolation", () => {
  it("hides another workspace's themes", async () => {
    const foreign = await createTheme(
      "Foreign",
      {},
      stranger,
      strangerWorkspaceId,
    );
    const list = await call("GET", themes(), owner);
    expect(
      themeListResponseSchema
        .parse(list.json())
        .themes.some((theme) => theme.id === foreign.id),
    ).toBe(false);
    // Through this workspace's URL the foreign theme does not exist.
    for (const [method, payload] of [
      ["GET", undefined],
      ["PUT", { version: 1, name: "Taken over", tokens: dark }],
      ["DELETE", undefined],
    ] as const) {
      expectError(
        await call(method, `${themes()}/${foreign.id}`, owner, payload),
        404,
        "theme_not_found",
      );
    }
    // A dashboard cannot reference it.
    expectError(
      await call("POST", dashboards(), owner, {
        name: "Borrowed",
        settings: {
          themeId: foreign.id,
        },
      }),
      404,
      "theme_not_found",
    );
    // Non-members do not see the workspace at all.
    expectError(
      await call("GET", themes(strangerWorkspaceId), owner),
      404,
      "workspace_not_found",
    );
    const [row] = await admin`
      select name, version from workspace_themes where id = ${foreign.id}`;
    expect(row).toEqual({ name: "Foreign", version: 1 });
  });

  it("keeps a dashboard's theme in its workspace in the database", async () => {
    const foreign = await createTheme(
      "Foreign key",
      {},
      stranger,
      strangerWorkspaceId,
    );
    const created = await call("POST", dashboards(), owner, { name: "Mine" });
    const { dashboard } = dashboardResponseSchema.parse(created.json());
    await expect(
      admin`update dashboards
        set theme_builtin = null, theme_id = ${foreign.id}
        where id = ${dashboard.id}`,
    ).rejects.toThrow(/dashboards_theme_fk/);
  });

  it("deletes a workspace with themes in use", async () => {
    const other = await newWorkspace(stranger);
    const theme = await createTheme("Doomed", {}, stranger, other);
    const created = await call("POST", dashboards(other), stranger, {
      name: "Doomed",
      settings: {
        themeId: theme.id,
      },
    });
    expect(created.statusCode).toBe(200);
    // The product never deletes a workspace, but the database must allow it
    // (the cascade reaches dashboards and themes in one statement). The
    // last-owner guard is suspended inside this transaction only.
    await admin.begin(async (tx) => {
      await tx`alter table memberships
        disable trigger memberships_guard_last_owner`;
      await tx`delete from workspaces where id = ${other}`;
      await tx`alter table memberships
        enable trigger memberships_guard_last_owner`;
    });
    const left = await admin`
      select id from workspace_themes where workspace_id = ${other}`;
    expect(left).toHaveLength(0);
  });
});
