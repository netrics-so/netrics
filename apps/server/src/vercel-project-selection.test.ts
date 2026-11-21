import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  connectionResponseSchema,
  storedConnectionPreviewResponseSchema,
  workspaceListResponseSchema,
} from "@netrics/contracts";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import type { Connector, ConnectorRuntime } from "@netrics/connector-sdk";
import { createVercelConnector } from "@netrics/connectors";
import { createDatabase, type Database } from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";
import { syncCatalog } from "./sync/catalog.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// The synced projects of a Vercel connection can be changed after
// connecting (#782): the stored token lists the projects, the selection is
// saved on its own, deselected projects keep their data and newly selected
// ones are named right away. Offline: the real connector reads a stand-in
// for Vercel's project list.

const TOKEN = "vercel-test-token-0123456789";
const PROJECTS = [
  { id: "prj_alpha", name: "alpha-site", analytics: true },
  { id: "prj_beta", name: "beta-site", analytics: true },
  { id: "prj_gamma", name: "gamma-docs", analytics: false },
];

/** Vercel's project list for the token; anything else is refused. */
const provider: ConnectorRuntime = {
  signal: new AbortController().signal,
  fetch: async (raw, init) => {
    const url = new URL(raw);
    const answer = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      return {
        status,
        headers: { "content-type": "application/json" },
        text: () => text,
        json: () => JSON.parse(text) as unknown,
        bytes: () => new TextEncoder().encode(text),
      };
    };
    if (url.hostname !== "api.vercel.com" || url.pathname !== "/v10/projects")
      throw new Error(`unexpected request to ${url.pathname}`);
    if (init?.headers?.authorization !== `Bearer ${TOKEN}`)
      return answer(403, {
        error: { code: "forbidden", message: "Not authorized" },
      });
    return answer(200, {
      projects: PROJECTS.map((project) => ({
        id: project.id,
        name: project.name,
        accountId: "team_fixture",
        webAnalytics: project.analytics
          ? { enabledAt: 1_700_000_000_000 }
          : undefined,
      })),
      pagination: { count: PROJECTS.length, next: null },
    });
  },
} as ConnectorRuntime;

function registry(): ConnectorRegistry {
  const vercel = createVercelConnector();
  const offline: Connector = {
    manifest: vercel.manifest,
    check: (context) => vercel.check(context, provider),
    discover: (context) => vercel.discover!(context, provider),
    sync: (context, request) => vercel.sync(context, request, provider),
  };
  const result = new ConnectorRegistry();
  result.register(offline);
  return result;
}

let app: FastifyInstance;
let db: Database;
let owner: postgres.Sql;
let cookie: string;
let outsider: string;
let workspaceId: string;
let connectionId: string;

async function signUp(email: string, name: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { name, email, password: "password-12345" },
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers["set-cookie"];
  const cookies = Array.isArray(header) ? header : [header];
  return cookies
    .find((c) => c?.startsWith("better-auth.session_token="))!
    .split(";")[0]!;
}

function call(
  method: "GET" | "POST" | "PATCH",
  url: string,
  payload?: unknown,
  as: string = cookie,
) {
  return app.inject({
    method,
    url,
    headers: { cookie: as },
    ...(payload !== undefined
      ? { payload: payload as Record<string, unknown> }
      : {}),
  });
}

const connectionUrl = () =>
  `/v1/workspaces/${workspaceId}/connections/${connectionId}`;

async function select(resources: string[] | null) {
  return call("PATCH", connectionUrl(), { resources });
}

async function storedSelection(): Promise<unknown> {
  const [row] = await owner`
    select config -> 'resourceSelection' as selection
    from connections where id = ${connectionId}`;
  return row!.selection;
}

async function names(): Promise<Record<string, string>> {
  const rows = await owner`
    select resource_id, name from connection_resources
    where connection_id = ${connectionId} order by resource_id`;
  return Object.fromEntries(rows.map((row) => [row.resource_id, row.name]));
}

async function backfillJobs(): Promise<number> {
  const [row] = await owner`
    select count(*)::int as count from jobs
    where connection_id = ${connectionId} and kind = 'connection.backfill'`;
  return row!.count as number;
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
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => {} });
  const catalogOwner = createDatabase(testDb.adminUrl, { max: 1 });
  await syncCatalog(catalogOwner, registry());
  await catalogOwner.$client.end({ timeout: 5 });
  const authService = createAuthService(config, db, {
    logger: pino({ level: "silent" }),
  });
  app = await buildApp(config, {
    db,
    authService,
    registry: registry(),
    checkDb: async () => true,
  });
  cookie = await signUp("projects-owner@example.com", "Ada Owner");
  expect(
    (await call("POST", "/v1/bootstrap", { workspaceName: "Sites" }))
      .statusCode,
  ).toBe(200);
  workspaceId = workspaceListResponseSchema.parse(
    (await call("GET", "/v1/workspaces")).json(),
  ).workspaces[0]!.id;
  const created = await call(
    "POST",
    `/v1/workspaces/${workspaceId}/connections`,
    {
      connectorId: "vercel",
      name: "Websites",
      config: {},
      credentials: { token: TOKEN },
      resources: ["prj_alpha"],
    },
  );
  expect(created.statusCode, created.body).toBe(200);
  connectionId = connectionResponseSchema.parse(created.json()).connection.id;
  // Another account with its own workspace.
  outsider = await signUp("projects-outsider@example.com", "Otto Other");
  expect(
    (await call("POST", "/v1/workspaces", { name: "Elsewhere" }, outsider))
      .statusCode,
  ).toBe(200);
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await owner?.end({ timeout: 5 }).catch(() => undefined);
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
});

describe("Vercel project selection after connecting (#782)", () => {
  it("lists the token's projects with the stored token and the selection", async () => {
    const response = await call("POST", `${connectionUrl()}/preview`, {
      config: {},
    });
    expect(response.statusCode, response.body).toBe(200);
    const preview = storedConnectionPreviewResponseSchema.parse(
      response.json(),
    );
    expect(preview.check.ok).toBe(true);
    expect(preview.selection).toEqual(["prj_alpha"]);
    expect(preview.resources).toMatchObject([
      { id: "prj_alpha", name: "alpha-site" },
      { id: "prj_beta", name: "beta-site" },
      { id: "prj_gamma", name: "gamma-docs" },
    ]);
    expect(response.body).not.toContain(TOKEN);
  });

  it("adds a project: saved, named at once, history queued, no token in the answer", async () => {
    expect(await names()).toEqual({});
    const before = await backfillJobs();
    const response = await select(["prj_beta", "prj_alpha"]);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain(TOKEN);
    expect(await storedSelection()).toEqual(["prj_alpha", "prj_beta"]);
    // The names of what the account lists, before any sync has run.
    expect(await names()).toMatchObject({
      prj_alpha: "alpha-site",
      prj_beta: "beta-site",
    });
    // The new project's history comes with the normal backfill.
    expect(await backfillJobs()).toBeGreaterThanOrEqual(Math.max(before, 1));
    const [audit] = await owner`
      select metadata from audit_events
      where target = ${connectionId} and action = 'connection.updated'
      order by created_at desc limit 1`;
    expect(audit!.metadata).toMatchObject({ backfillRequested: true });
  });

  it("the provisional names leave the engine's daily discovery due", async () => {
    const [row] = await owner`
      select max(discovered_at) as at from connection_resources
      where connection_id = ${connectionId}`;
    expect(new Date(row!.at as string).getTime()).toBe(0);
  });

  it("removes a project without deleting what it collected", async () => {
    const [metric] = await owner`
      select id from metric_definitions
      where connector_id = 'vercel' and key = 'vercel.visitors'`;
    await owner`
      insert into observations
        (workspace_id, connection_id, metric_definition_id, dimensions,
         source_timestamp, value)
      values (${workspaceId}, ${connectionId}, ${metric!.id},
        ${owner.json({ resource: "prj_alpha" })}, '2026-01-01T00:00:00Z', 7)`;
    const response = await select(["prj_beta"]);
    expect(response.statusCode, response.body).toBe(200);
    expect(await storedSelection()).toEqual(["prj_beta"]);
    const [kept] = await owner`
      select count(*)::int as count from observations
      where connection_id = ${connectionId}
        and dimensions ->> 'resource' = 'prj_alpha'`;
    expect(kept!.count).toBe(1);
    // Its name stays for the data that is kept.
    expect((await names()).prj_alpha).toBe("alpha-site");
  });

  it("follows all projects again with null", async () => {
    const response = await select(null);
    expect(response.statusCode, response.body).toBe(200);
    expect(await storedSelection()).toBeNull();
    expect((await select(["prj_alpha"])).statusCode).toBe(200);
  });

  it("refuses a project the token does not list, or one without Web Analytics", async () => {
    const unknown = await select(["prj_alpha", "prj_elsewhere"]);
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body).not.toContain(TOKEN);
    const disabled = await select(["prj_alpha", "prj_gamma"]);
    expect(disabled.statusCode).toBe(400);
    expect(disabled.body).toContain("Web Analytics is not enabled");
    expect(await storedSelection()).toEqual(["prj_alpha"]);
  });

  it("repairs a selection whose project lost Web Analytics: without it saves, with it is refused", async () => {
    // Web Analytics is turned off on a synced project after connecting.
    await select(["prj_alpha", "prj_beta"]);
    const beta = PROJECTS.find((project) => project.id === "prj_beta")!;
    beta.analytics = false;
    try {
      // The list is still served, with the stored selection to edit.
      const listed = storedConnectionPreviewResponseSchema.parse(
        (
          await call("POST", `${connectionUrl()}/preview`, { config: {} })
        ).json(),
      );
      expect(listed.check.ok).toBe(true);
      expect(listed.selection).toEqual(["prj_alpha", "prj_beta"]);
      expect(listed.resources.map((resource) => resource.id)).toContain(
        "prj_beta",
      );
      // The check on save sees the NEW selection, not the stored one.
      const kept = await select(["prj_alpha", "prj_beta"]);
      expect(kept.statusCode).toBe(400);
      expect(kept.body).toContain("Web Analytics is not enabled");
      const repaired = await select(["prj_alpha"]);
      expect(repaired.statusCode, repaired.body).toBe(200);
      expect(await storedSelection()).toEqual(["prj_alpha"]);
    } finally {
      beta.analytics = true;
    }
  });

  it("with no analytics project left the check refuses, and the selection can still be cleared", async () => {
    const enabled = PROJECTS.filter((project) => project.analytics);
    for (const project of enabled) project.analytics = false;
    try {
      const listed = storedConnectionPreviewResponseSchema.parse(
        (
          await call("POST", `${connectionUrl()}/preview`, { config: {} })
        ).json(),
      );
      expect(listed.check.ok).toBe(false);
      expect(listed.selection).toEqual(["prj_alpha"]);
      const cleared = await select([]);
      expect(cleared.statusCode, cleared.body).toBe(200);
      expect(await storedSelection()).toEqual([]);
    } finally {
      for (const project of enabled) project.analytics = true;
    }
    expect((await select(["prj_alpha"])).statusCode).toBe(200);
  });

  it("is closed to other workspaces", async () => {
    const other = workspaceListResponseSchema.parse(
      (await call("GET", "/v1/workspaces", undefined, outsider)).json(),
    ).workspaces[0]!.id;
    // Through the outsider's own workspace, and through this one.
    for (const workspace of [other, workspaceId]) {
      const base = `/v1/workspaces/${workspace}/connections/${connectionId}`;
      const changed = await call(
        "PATCH",
        base,
        { resources: ["prj_beta"] },
        outsider,
      );
      expect([403, 404]).toContain(changed.statusCode);
      const listed = await call(
        "POST",
        `${base}/preview`,
        { config: {} },
        outsider,
      );
      expect([403, 404]).toContain(listed.statusCode);
    }
    expect(await storedSelection()).toEqual(["prj_alpha"]);
  });
});
