import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  connectionDetailResponseSchema,
  connectionResponseSchema,
  errorResponseSchema,
  storedConnectionPreviewResponseSchema,
  workspaceListResponseSchema,
} from "@netrics/contracts";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import type { Connector, ConnectorRuntime } from "@netrics/connector-sdk";
import { createVercelConnector } from "@netrics/connectors";
import { createDatabase, type Database, type Job } from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { createCredentialKeyring } from "./credentials.js";
import { loadConfig } from "./env.js";
import { createJobHandlers } from "./jobs/handlers.js";
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

/** Requests the stand-in for Vercel answered. */
let providerRequests = 0;
/** Projects the token no longer sees. */
const lost = new Set<string>();

/** Vercel's project list for the token; anything else is refused. */
const provider: ConnectorRuntime = {
  signal: new AbortController().signal,
  fetch: async (raw, init) => {
    const url = new URL(raw);
    providerRequests += 1;
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
    const visible = PROJECTS.filter((project) => !lost.has(project.id));
    return answer(200, {
      projects: visible.map((project) => ({
        id: project.id,
        name: project.name,
        accountId: "team_fixture",
        webAnalytics: project.analytics
          ? { enabledAt: 1_700_000_000_000 }
          : undefined,
      })),
      pagination: { count: visible.length, next: null },
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
let schedulerDb: Database;
let keyring: ReturnType<typeof createCredentialKeyring>;
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
  const schedulerUrl = new URL(testDb.adminUrl);
  schedulerUrl.username = "netrics_scheduler";
  schedulerUrl.password = "netrics_scheduler";
  schedulerDb = createDatabase(schedulerUrl.toString());
  keyring = createCredentialKeyring(
    config.appEncryptionKey,
    config.appEncryptionKeysPrevious,
  );
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
  await schedulerDb?.$client.end({ timeout: 5 }).catch(() => undefined);
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

  it("refuses a project the token does not list", async () => {
    const unknown = await select(["prj_alpha", "prj_elsewhere"]);
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body).not.toContain(TOKEN);
    expect(unknown.body).toContain("prj_elsewhere");
    expect(await storedSelection()).toEqual(["prj_alpha"]);
  });

  it("selects a project without Web Analytics: its deployments are synced (#871)", async () => {
    const response = await select(["prj_alpha", "prj_gamma"]);
    expect(response.statusCode, response.body).toBe(200);
    expect(await storedSelection()).toEqual(["prj_alpha", "prj_gamma"]);
    expect((await names()).prj_gamma).toBe("gamma-docs");
    // A project that loses Web Analytics later stays selectable too.
    const beta = PROJECTS.find((project) => project.id === "prj_beta")!;
    beta.analytics = false;
    try {
      const kept = await select(["prj_alpha", "prj_beta"]);
      expect(kept.statusCode, kept.body).toBe(200);
    } finally {
      beta.analytics = true;
    }
    expect((await select(["prj_alpha"])).statusCode).toBe(200);
  });

  it("with no analytics project left the check still passes; an empty selection is refused (#854, #871)", async () => {
    const enabled = PROJECTS.filter((project) => project.analytics);
    for (const project of enabled) project.analytics = false;
    try {
      const listed = storedConnectionPreviewResponseSchema.parse(
        (
          await call("POST", `${connectionUrl()}/preview`, { config: {} })
        ).json(),
      );
      expect(listed.check.ok).toBe(true);
      expect(listed.selection).toEqual(["prj_alpha"]);
      // Clearing it is no way out: nothing would be collected.
      const cleared = await select([]);
      expect(cleared.statusCode, cleared.body).toBe(400);
      expect(errorResponseSchema.parse(cleared.json()).error).toBe(
        "resource_selection_empty",
      );
      expect((await select(["prj_alpha", "prj_beta"])).statusCode).toBe(200);
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

describe("the synced projects are shown, and at least one is required (#854)", () => {
  async function detail() {
    const response = await call("GET", connectionUrl());
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain(TOKEN);
    return connectionDetailResponseSchema.parse(response.json());
  }
  /** Writes a selection as an earlier version could store it. */
  async function storeSelection(selection: string[]) {
    await owner`
      update connections
      set config = jsonb_set(config, '{resourceSelection}', ${owner.json(selection)})
      where id = ${connectionId}`;
  }
  /** One incremental sync of the connection, as the worker runs it. */
  const sync = () =>
    createJobHandlers({ registry: registry(), credentialKeyring: keyring })[
      "connection.sync"
    ]!({
      job: {
        id: crypto.randomUUID(),
        kind: "connection.sync",
        workspaceId,
        connectionId,
        attempts: 0,
        payload: {},
      } as unknown as Job,
      appDb: db,
      schedulerDb,
      logger: pino({ level: "silent" }),
    });

  it("the detail response carries the selection: names where known, IDs otherwise", async () => {
    // prj_alpha and prj_beta were named when they were selected.
    expect((await detail()).resourceSelection).toEqual([
      { id: "prj_alpha", name: "alpha-site" },
    ]);
    // A project no discovery has named yet comes after the named ones.
    await storeSelection(["prj_alpha", "prj_beta", "prj_0_unnamed"]);
    const shown = await detail();
    expect(shown.resourceSelection).toEqual([
      { id: "prj_alpha", name: "alpha-site" },
      { id: "prj_beta", name: "beta-site" },
      { id: "prj_0_unnamed", name: null },
    ]);
    // The selection stays out of the echoed config.
    expect(shown.connection.config).not.toHaveProperty("resourceSelection");
    await storeSelection(["prj_alpha"]);
  });

  it("a stored name that only repeats the ID is no name", async () => {
    // A discovery that could not resolve a title stores the ID (#623).
    await owner`
      insert into connection_resources
        (connection_id, workspace_id, resource_id, name, kind)
      values (${connectionId}, ${workspaceId}, 'aaa.placeholder',
        'aaa.placeholder', 'project')`;
    await storeSelection(["aaa.placeholder", "prj_alpha", "prj_beta"]);
    try {
      // Unnamed, so after the named ones, although its ID sorts first.
      expect((await detail()).resourceSelection).toEqual([
        { id: "prj_alpha", name: "alpha-site" },
        { id: "prj_beta", name: "beta-site" },
        { id: "aaa.placeholder", name: null },
      ]);
    } finally {
      await storeSelection(["prj_alpha"]);
      await owner`
        delete from connection_resources
        where connection_id = ${connectionId}
          and resource_id = 'aaa.placeholder'`;
    }
  });

  it("every role that may read the connection gets the selection", async () => {
    const [member] = await owner`
      select m.user_id from memberships m
      where m.workspace_id = ${workspaceId}`;
    // Another owner keeps the workspace while this one changes roles.
    const [other] = await owner`
      select id from users where email = 'projects-outsider@example.com'`;
    await owner`
      insert into memberships (workspace_id, user_id, role)
      values (${workspaceId}, ${other!.id}, 'owner')`;
    try {
      for (const role of ["owner", "admin", "editor", "viewer"]) {
        await owner`
          update memberships set role = ${role}
          where workspace_id = ${workspaceId} and user_id = ${member!.user_id}`;
        expect((await detail()).resourceSelection, role).toEqual([
          { id: "prj_alpha", name: "alpha-site" },
        ]);
      }
      // A viewer reads it and cannot change it.
      expect((await select(["prj_beta"])).statusCode).toBe(403);
      expect(await storedSelection()).toEqual(["prj_alpha"]);
    } finally {
      await owner`
        update memberships set role = 'owner'
        where workspace_id = ${workspaceId} and user_id = ${member!.user_id}`;
      await owner`
        delete from memberships
        where workspace_id = ${workspaceId} and user_id = ${other!.id}`;
    }
  });

  it("a selection far beyond the SQL parameter limit still reads", async () => {
    // Nothing caps a stored selection's length: the names are looked up
    // with the IDs as one parameter, not one each (65,535 at most).
    const many = [
      "prj_alpha",
      ...Array.from({ length: 70_000 }, (_, index) => `prj_many_${index}`),
    ];
    await storeSelection(many);
    try {
      const shown = (await detail()).resourceSelection!;
      expect(shown).toHaveLength(many.length);
      expect(shown[0]).toEqual({ id: "prj_alpha", name: "alpha-site" });
      expect(shown.filter((resource) => resource.name !== null)).toHaveLength(
        1,
      );
    } finally {
      await storeSelection(["prj_alpha"]);
    }
  });

  it("no stored selection reads as all projects", async () => {
    expect((await select(null)).statusCode).toBe(200);
    expect((await detail()).resourceSelection).toBeNull();
    expect((await select(["prj_alpha"])).statusCode).toBe(200);
  });

  it("refuses to save an empty selection, with a code", async () => {
    const before = await backfillJobs();
    const response = await select([]);
    expect(response.statusCode, response.body).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error).toBe(
      "resource_selection_empty",
    );
    expect(await storedSelection()).toEqual(["prj_alpha"]);
    expect(await backfillJobs()).toBe(before);
    // With other changes in the same request too: nothing is saved.
    const renamed = await call("PATCH", connectionUrl(), {
      name: "Renamed",
      resources: [],
    });
    expect(renamed.statusCode).toBe(400);
    expect((await detail()).connection.name).toBe("Websites");
  });

  it("refuses a new connection with an empty selection", async () => {
    const [before] = await owner`
      select count(*)::int as count from connections
      where workspace_id = ${workspaceId}`;
    const created = await call(
      "POST",
      `/v1/workspaces/${workspaceId}/connections`,
      {
        connectorId: "vercel",
        name: "Nothing",
        config: {},
        credentials: { token: TOKEN },
        resources: [],
      },
    );
    expect(created.statusCode, created.body).toBe(400);
    expect(errorResponseSchema.parse(created.json()).error).toBe(
      "resource_selection_empty",
    );
    const [after] = await owner`
      select count(*)::int as count from connections
      where workspace_id = ${workspaceId}`;
    expect(after!.count).toBe(before!.count);
  });

  it("a connection that already stores an empty selection reads fine and syncs nothing", async () => {
    // Saved before a project was required: it is not migrated.
    await storeSelection([]);
    try {
      const shown = await detail();
      expect(shown.resourceSelection).toEqual([]);
      // The project list still loads, with the empty selection to change.
      const listed = storedConnectionPreviewResponseSchema.parse(
        (
          await call("POST", `${connectionUrl()}/preview`, { config: {} })
        ).json(),
      );
      expect(listed.check.ok).toBe(true);
      expect(listed.selection).toEqual([]);
      // Its other settings still save, and the selection stays.
      const renamed = await call("PATCH", connectionUrl(), {
        name: "Websites (paused)",
      });
      expect(renamed.statusCode, renamed.body).toBe(200);
      expect(await storedSelection()).toEqual([]);
      // A sync succeeds and asks no project for anything: the stand-in
      // refuses every request but the project list.
      const [observations] = await owner`
        select count(*)::int as count from observations
        where connection_id = ${connectionId}`;
      providerRequests = 0;
      await sync();
      const [run] = await owner`
        select status, observations_written from sync_runs
        where connection_id = ${connectionId}
        order by started_at desc limit 1`;
      expect(run).toMatchObject({ status: "succeeded" });
      expect(run!.observations_written).toBe(0);
      expect(providerRequests).toBeLessThanOrEqual(2);
      const [after] = await owner`
        select count(*)::int as count from observations
        where connection_id = ${connectionId}`;
      expect(after!.count).toBe(observations!.count);
      // Saving it again is refused like any empty selection.
      expect((await select([])).statusCode).toBe(400);
    } finally {
      await call("PATCH", connectionUrl(), { name: "Websites" });
    }
    // Repaired by choosing a project.
    const repaired = await select(["prj_alpha"]);
    expect(repaired.statusCode, repaired.body).toBe(200);
    expect((await detail()).resourceSelection).toEqual([
      { id: "prj_alpha", name: "alpha-site" },
    ]);
  });
});

describe("a token that lost its selected project (#888 review)", () => {
  it("still offers the projects it reads in the picker", async () => {
    await owner`
      update connections
      set config = config || ${owner.json({ resourceSelection: ["prj_alpha"] })}
      where id = ${connectionId}`;
    lost.add("prj_alpha");
    try {
      const response = await call("POST", `${connectionUrl()}/preview`, {
        config: {},
      });
      expect(response.statusCode, response.body).toBe(200);
      const preview = storedConnectionPreviewResponseSchema.parse(
        response.json(),
      );
      expect(preview.check.ok).toBe(true);
      expect(preview.selection).toEqual(["prj_alpha"]);
      expect(preview.resources.map((resource) => resource.id)).toContain(
        "prj_beta",
      );
    } finally {
      lost.clear();
    }
  });
});
