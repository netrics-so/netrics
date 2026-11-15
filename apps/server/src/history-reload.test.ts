import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  connectionDetailResponseSchema,
  connectionResponseSchema,
  historyReloadResponseSchema,
  HISTORY_RELOAD_INTERVAL_HOURS,
  sourceDatasetSchema,
  workspaceListResponseSchema,
} from "@netrics/contracts";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import { createDemoConnector, demoManifest } from "@netrics/connectors";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";
import { syncCatalog } from "./sync/catalog.js";
import { addMemberViaInvitation } from "./test-helpers.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// "Reload history" (#617): a member queues a backfill of the connector's
// whole window from the connection page. Permissions, workspace isolation,
// the busy and rate-limit refusals, and connectors without backfills.

const CONNECTOR = "history-demo";
const NO_BACKFILL = "history-demo-live";

const sales = sourceDatasetSchema.parse({
  key: "sales",
  name: "Sales rows",
  version: 2,
  keyFields: ["id"],
  grain: "one row",
  mode: "upsert",
  retentionDays: null,
  fields: [
    {
      id: "id",
      name: "ID",
      type: "string",
      nullable: false,
      classification: "internal",
    },
  ],
});

function registry(): ConnectorRegistry {
  const demo = createDemoConnector();
  const result = new ConnectorRegistry();
  const base = { ...demoManifest, translations: {} };
  result.register({
    ...demo,
    manifest: {
      ...base,
      id: CONNECTOR,
      name: "History demo",
      datasets: [sales],
    },
  });
  result.register({
    ...demo,
    manifest: {
      ...base,
      id: NO_BACKFILL,
      name: "Live only",
      supportsBackfill: false,
    },
  });
  return result;
}

type Response = Awaited<ReturnType<FastifyInstance["inject"]>>;

let app: FastifyInstance;
let db: Database;
let admin: Sql;
let owner: string;
let editor: string;
let viewer: string;
let stranger: string;
let workspaceId: string;
let otherWorkspaceId: string;
let ownerUserId: string;

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
  method: "GET" | "POST",
  url: string,
  cookie: string,
  payload?: unknown,
): Promise<Response> {
  return app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload !== undefined
      ? { payload: payload as Record<string, unknown> }
      : {}),
  });
}

async function createConnection(
  connectorId: string,
  cookie = owner,
  workspace = workspaceId,
) {
  const response = await call(
    "POST",
    `/v1/workspaces/${workspace}/connections`,
    cookie,
    { connectorId, name: `${connectorId} connection`, config: {} },
  );
  expect(response.statusCode, response.body).toBe(200);
  return connectionResponseSchema.parse(response.json()).connection.id;
}

const reloadUrl = (connectionId: string, workspace = workspaceId) =>
  `/v1/workspaces/${workspace}/connections/${connectionId}/backfill`;

function reload(connectionId: string, cookie = owner, workspace = workspaceId) {
  return call("POST", reloadUrl(connectionId, workspace), cookie);
}

async function detail(connectionId: string) {
  const response = await call(
    "GET",
    `/v1/workspaces/${workspaceId}/connections/${connectionId}`,
    owner,
  );
  expect(response.statusCode, response.body).toBe(200);
  return connectionDetailResponseSchema.parse(response.json());
}

/** Finishes every waiting backfill of the connection (no worker runs). */
async function finishBackfills(connectionId: string) {
  await admin`
    update jobs set status = 'succeeded'
    where connection_id = ${connectionId} and kind = 'connection.backfill'
      and status in ('pending', 'continuing', 'running')`;
}

async function pendingBackfills(connectionId: string) {
  const rows = await admin`
    select id from jobs
    where connection_id = ${connectionId} and kind = 'connection.backfill'
      and status = 'pending'`;
  return rows.map((row) => row.id as string);
}

async function reloadEvents(connectionId: string) {
  return admin`
    select actor_user_id, metadata from audit_events
    where target = ${connectionId}
      and action = 'connection.backfill_requested'
    order by created_at`;
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
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });
  owner = await signUp("history-owner@example.com", "Ada Owner");
  editor = await signUp("history-editor@example.com", "Eve Editor");
  viewer = await signUp("history-viewer@example.com", "Vic Viewer");
  stranger = await signUp("history-stranger@example.com", "Sam Stranger");
  expect(
    (
      await call("POST", "/v1/bootstrap", owner, {
        workspaceName: "History",
      })
    ).statusCode,
  ).toBe(200);
  workspaceId = workspaceListResponseSchema.parse(
    (await call("GET", "/v1/workspaces", owner)).json(),
  ).workspaces[0]!.id;
  for (const [email, role] of [
    ["history-editor@example.com", "editor"],
    ["history-viewer@example.com", "viewer"],
  ] as const) {
    expect(
      (await addMemberViaInvitation(app, db, owner, workspaceId, email, role))
        .statusCode,
    ).toBe(200);
  }
  const other = await call("POST", "/v1/workspaces", stranger, {
    name: "Elsewhere",
  });
  expect(other.statusCode, other.body).toBe(200);
  otherWorkspaceId = workspaceListResponseSchema
    .parse((await call("GET", "/v1/workspaces", stranger)).json())
    .workspaces.find((w) => w.name === "Elsewhere")!.id;
  const [user] = await admin`
    select id from users where email = 'history-owner@example.com'`;
  ownerUserId = user!.id as string;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin?.end({ timeout: 5 }).catch(() => undefined);
});

describe("reload history (#617)", () => {
  it("is refused while the first backfill waits, then queues one, audited with the member", async () => {
    const connectionId = await createConnection(CONNECTOR);
    const first = await detail(connectionId);
    expect(first.history).toMatchObject({
      supportsBackfill: true,
      backfillDays: demoManifest.backfillDays,
      backfill: "queued",
      reloadAvailableAt: null,
    });

    const busy = await reload(connectionId);
    expect(busy.statusCode, busy.body).toBe(409);
    expect(busy.json()).toEqual({ error: "backfill_in_progress" });

    await finishBackfills(connectionId);
    expect((await detail(connectionId)).history.backfill).toBe("idle");

    const before = Date.now();
    const queued = await reload(connectionId);
    expect(queued.statusCode, queued.body).toBe(200);
    const body = historyReloadResponseSchema.parse(queued.json());
    expect(await pendingBackfills(connectionId)).toEqual([body.jobId]);
    const available = Date.parse(body.reloadAvailableAt);
    const interval = HISTORY_RELOAD_INTERVAL_HOURS * 3_600_000;
    expect(available).toBeGreaterThanOrEqual(before + interval - 1_000);
    expect(available).toBeLessThanOrEqual(Date.now() + interval + 1_000);

    const events = await reloadEvents(connectionId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor_user_id: ownerUserId,
      metadata: {
        connectorId: CONNECTOR,
        by: "member",
        reason: "history_reload",
        jobId: body.jobId,
      },
    });

    const after = await detail(connectionId);
    expect(after.history.backfill).toBe("queued");
    expect(after.history.reloadAvailableAt).toBe(body.reloadAvailableAt);
  });

  it("allows one reload per connection per interval", async () => {
    const connectionId = await createConnection(CONNECTOR);
    await finishBackfills(connectionId);
    expect((await reload(connectionId)).statusCode).toBe(200);
    await finishBackfills(connectionId);

    const limited = await reload(connectionId);
    expect(limited.statusCode, limited.body).toBe(429);
    expect(limited.json()).toEqual({ error: "history_reload_rate_limited" });
    expect(await pendingBackfills(connectionId)).toEqual([]);
    expect(await reloadEvents(connectionId)).toHaveLength(1);

    // Another connection has its own slot.
    const other = await createConnection(CONNECTOR);
    await finishBackfills(other);
    expect((await reload(other)).statusCode).toBe(200);

    // Once the interval has passed, the next reload is accepted.
    await admin`
      update connection_state
      set history_reload_requested_at = now() - make_interval(hours => ${HISTORY_RELOAD_INTERVAL_HOURS + 1})
      where connection_id = ${connectionId}`;
    expect((await detail(connectionId)).history.reloadAvailableAt).toBeNull();
    expect((await reload(connectionId)).statusCode).toBe(200);
  });

  it("queues one backfill for two concurrent requests", async () => {
    const connectionId = await createConnection(CONNECTOR);
    await finishBackfills(connectionId);
    const answers = await Promise.all([
      reload(connectionId),
      reload(connectionId),
    ]);
    const statuses = answers.map((a) => a.statusCode).sort();
    expect(statuses[0]).toBe(200);
    expect([409, 429]).toContain(statuses[1]);
    expect(await pendingBackfills(connectionId)).toHaveLength(1);
  });

  it("needs connections:update: editors may, viewers may not", async () => {
    const connectionId = await createConnection(CONNECTOR);
    await finishBackfills(connectionId);
    const denied = await reload(connectionId, viewer);
    expect(denied.statusCode, denied.body).toBe(403);
    expect(await pendingBackfills(connectionId)).toEqual([]);
    expect((await reload(connectionId, editor)).statusCode).toBe(200);
  });

  it("keeps workspaces apart", async () => {
    const connectionId = await createConnection(CONNECTOR);
    await finishBackfills(connectionId);
    // A non-member of the workspace: it does not exist for them.
    expect((await reload(connectionId, stranger)).statusCode).toBe(404);
    // The connection through the stranger's own workspace: not found.
    const crossed = await reload(connectionId, stranger, otherWorkspaceId);
    expect(crossed.statusCode, crossed.body).toBe(404);
    expect(await pendingBackfills(connectionId)).toEqual([]);
    expect(await reloadEvents(connectionId)).toHaveLength(0);
  });

  it("is refused for a connector without backfills", async () => {
    const connectionId = await createConnection(NO_BACKFILL);
    await finishBackfills(connectionId);
    expect((await detail(connectionId)).history.supportsBackfill).toBe(false);
    const refused = await reload(connectionId);
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json()).toEqual({ error: "backfill_not_supported" });
    expect(await pendingBackfills(connectionId)).toEqual([]);
  });

  it("names the datasets whose history no backfill has read", async () => {
    const connectionId = await createConnection(CONNECTOR);
    await finishBackfills(connectionId);
    // Not recorded yet (a connection from before #617): nothing claimed.
    expect((await detail(connectionId)).history.incompleteDatasets).toEqual([]);
    // Recorded at an older schema version, as after a connector update.
    await admin`
      update connection_state set backfilled_datasets = ${admin.json({ sales: 1 })}
      where connection_id = ${connectionId}`;
    expect((await detail(connectionId)).history.incompleteDatasets).toEqual([
      { key: "sales", name: "Sales rows" },
    ]);
    await admin`
      update connection_state set backfilled_datasets = ${admin.json({ sales: 2 })}
      where connection_id = ${connectionId}`;
    expect((await detail(connectionId)).history.incompleteDatasets).toEqual([]);
  });
});
