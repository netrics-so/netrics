import { randomBytes, randomUUID } from "node:crypto";

import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  errorResponseSchema,
  workspaceListResponseSchema,
  workspaceResponseSchema,
} from "@netrics/contracts";
import type { Connector, ConnectorManifest } from "@netrics/connector-sdk";
import { createDemoConnector, demoManifest } from "@netrics/connectors";
import {
  completeJob,
  createDatabase,
  createRawSqlClient,
  enqueueWorkspacePurges,
  failJob,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { createConnectionService } from "./connections/service.js";
import { createDefaultRegistry } from "./connectors.js";
import { createCredentialKeyring } from "./credentials.js";
import { loadConfig } from "./env.js";
import { createJobHandlers } from "./jobs/handlers.js";
import {
  capturingLogger,
  seedOAuthConnection,
  startTestOAuthProvider,
  TEST_PROVIDER_EGRESS,
  TEST_PROVIDER_ID,
  testOAuthProviders,
  type TestOAuthProvider,
} from "./oauth/test-provider.js";
import { createOAuthTokenService } from "./oauth/tokens.js";
import { syncCatalog } from "./sync/catalog.js";
import { TEST_DATABASE_SETUP_TIMEOUT_MS } from "./test-db.js";
import { addMemberViaInvitation } from "./test-helpers.js";
import { createItemsFixture, type ItemsFixture } from "./test-items.js";
import { createWorker } from "./worker.js";

// #839: an owner deletes a workspace. The request ends every way into it
// (members, invitations, screens, jobs) and records who did it; the
// `workspace.purge` job then removes its data, revoking OAuth grants no
// other workspace uses, and finally the workspace itself. Another workspace
// is never touched.

const KEYRING = createCredentialKeyring(randomBytes(32).toString("base64"));
const SCOPE = "https://example.test/auth/readonly";
const CONNECTOR_ID = "oauth-workspace-delete";
const NAME = "Items";

let fixture: ItemsFixture;
let provider: TestOAuthProvider;
let admin: Sql;
let schedulerDb: Database;
let handlers: ReturnType<typeof createJobHandlers>;
const logs: string[] = [];

/** The workspace that is deleted, and the one that stays. */
let doomed: string;
let kept: string;
let keptOwner: string;
let adminCookie: string;
let editorCookie: string;
let viewerCookie: string;
let strangerCookie: string;
let screenToken: string;
let ownSub: string;
let sharedSub: string;
let keptConnection: string;
let runningJob: string;

function oauthConnector(): Connector {
  const manifest: ConnectorManifest = {
    ...demoManifest,
    id: CONNECTOR_ID,
    sdkVersion: "^0.2.1",
    authStrategies: [
      { strategy: "oauth2", provider: TEST_PROVIDER_ID, scopes: [SCOPE] },
    ],
  };
  return { ...createDemoConnector(), manifest };
}

function schedulerUrlOf(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.username = "netrics_scheduler";
  url.password = "netrics_scheduler";
  return url.toString();
}

const requestDelete = (workspaceId: string, cookie: string, name: string) =>
  fixture.app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspaceId}/delete`,
    headers: { cookie },
    payload: { name },
  });

function expectError(
  response: Awaited<ReturnType<typeof requestDelete>>,
  status: number,
  error: string,
) {
  expect(response.statusCode, response.body).toBe(status);
  expect(errorResponseSchema.parse(response.json()).error).toBe(error);
}

/** Every table with a workspace_id column. */
async function tenantTables(): Promise<string[]> {
  const rows = await admin<{ table_name: string }[]>`
    select c.table_name from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and c.column_name = 'workspace_id'
      and t.table_type = 'BASE TABLE'
    order by c.table_name`;
  return rows.map((row) => row.table_name);
}

/** Rows per tenant table of one workspace (tables without rows left out). */
async function rowsOf(workspaceId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of await tenantTables()) {
    const [row] = await admin<{ count: number }[]>`
      select count(*)::int as count from ${admin(table)}
      where workspace_id = ${workspaceId}`;
    if (row!.count > 0) counts[table] = row!.count;
  }
  return counts;
}

async function workspaceRow(workspaceId: string) {
  const [row] = await admin`
    select name, deleted_at from workspaces where id = ${workspaceId}`;
  return row;
}

const purgeJobs = (workspaceId: string) =>
  admin<{ id: string; status: string; last_error: string | null }[]>`
    select id, status, last_error from jobs
    where kind = 'workspace.purge'
      and payload ->> 'purge_workspace_id' = ${workspaceId}
    order by created_at`;

/** Runs a worker until no purge job waits or runs. */
const runPurges = () =>
  runWorkerUntilIdle(
    "kind = 'workspace.purge' and status in ('pending', 'running', 'continuing')",
  );

/** Runs a worker until no job matches `live` (a fixed SQL condition). */
async function runWorkerUntilIdle(live: string): Promise<void> {
  const worker = createWorker({
    schedulerDb,
    appDb: fixture.db,
    handlers,
    pollMs: 20,
    heartbeatMs: 50,
    logger: pino({ level: "silent" }),
  });
  await worker.start();
  try {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const [row] = await admin<{ live: number }[]>`
        select count(*)::int as live from jobs where ${admin.unsafe(live)}`;
      if (row!.live === 0) return;
      if (Date.now() > deadline) throw new Error("jobs did not finish");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    await worker.stop();
  }
}

async function oauthConnection(workspaceId: string, sub: string) {
  return seedOAuthConnection(fixture.db, KEYRING, {
    workspaceId,
    connectorId: CONNECTOR_ID,
    refreshToken: provider.grant({ sub, scopes: [SCOPE] }),
    sub,
    grantedScopes: [SCOPE],
  });
}

async function createWorkspaceAs(cookie: string, name: string) {
  const created = await fixture.app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { cookie },
    payload: { name },
  });
  expect(created.statusCode, created.body).toBe(200);
  return workspaceResponseSchema.parse(created.json()).workspace.id;
}

const listed = async (cookie: string) =>
  workspaceListResponseSchema
    .parse(
      (
        await fixture.app.inject({
          method: "GET",
          url: "/v1/workspaces",
          headers: { cookie },
        })
      ).json(),
    )
    .workspaces.map((workspace) => workspace.id);

const screenStatus = async (token: string) =>
  (
    await fixture.app.inject({
      method: "GET",
      url: "/v1/device/dashboard",
      headers: { authorization: `Bearer ${token}` },
    })
  ).statusCode;

beforeAll(async () => {
  provider = await startTestOAuthProvider();
  fixture = await createItemsFixture("wsdelete");
  admin = fixture.admin;
  doomed = fixture.workspaceId;
  // The owner's other workspace: an owner's only workspace is not deleted
  // (#855, "the owner's only workspace" below).
  await createWorkspaceAs(fixture.owner, "Owner spare");

  const registry = createDefaultRegistry();
  registry.register(oauthConnector());
  const owner = createDatabase(fixture.testDb.adminUrl, { max: 1 });
  await syncCatalog(owner, registry);
  await owner.$client.end({ timeout: 5 });

  schedulerDb = createDatabase(schedulerUrlOf(fixture.testDb.adminUrl));
  const providers = testOAuthProviders(provider);
  const oauthTokens = createOAuthTokenService({
    db: fixture.db,
    credentialKeyring: KEYRING,
    providers,
    logger: capturingLogger(logs),
    egress: TEST_PROVIDER_EGRESS,
  });
  const connections = createConnectionService({
    db: fixture.db,
    registry,
    credentialKeyring: KEYRING,
    oauthProviders: providers,
    oauthTokens,
  });
  handlers = createJobHandlers({
    registry,
    credentialKeyring: KEYRING,
    oauthTokens,
    purgeConnection: (workspaceId, connectionId) =>
      connections.removeForPurge(workspaceId, connectionId),
  });

  // The deleted workspace: the fixture's manual dataset, model and records,
  // plus the demo connection and dashboard, a project, images, a screen,
  // members, an open invitation and OAuth connections.
  const demo = await fixture.call("POST", "/demo");
  expect(demo.statusCode, demo.body).toBe(200);
  expect(demo.json().demoDashboardId).not.toBeNull();
  // The demo connection's backfill, so the workspace holds observations.
  await runWorkerUntilIdle(
    "kind = 'connection.backfill' and status in ('pending', 'running', 'continuing')",
  );
  expect(
    (await fixture.call("POST", "/projects", { name: "Project" })).statusCode,
  ).toBe(200);
  // A theme of its own and a goal on the demo connection.
  const theme = await fixture.call("POST", "/themes", {
    name: "Doomed theme",
    base: "paper",
  });
  expect(theme.statusCode, theme.body).toBe(200);
  const [demoConnection] = await admin<{ id: string }[]>`
    select id from connections where workspace_id = ${doomed}`;
  const goal = await fixture.call("POST", "/goals", {
    name: "Doomed goal",
    connectionId: demoConnection!.id,
    metricKey: "demo.signups",
    period: "this_month",
    target: 15_000,
  });
  expect(goal.statusCode, goal.body).toBe(200);
  await fixture.storeImage("https://img.example/photos/doomed.png");
  screenToken = (
    await fixture.pairScreen(demo.json().demoDashboardId as string)
  ).token;
  // A pairing that waits for approval when the workspace goes.
  adminCookie = await fixture.signUp("wsdelete-admin@example.com");
  editorCookie = await fixture.signUp("wsdelete-editor@example.com");
  viewerCookie = await fixture.signUp("wsdelete-viewer@example.com");
  strangerCookie = await fixture.signUp("wsdelete-stranger@example.com");
  for (const role of ["admin", "editor", "viewer"] as const) {
    const invited = await addMemberViaInvitation(
      fixture.app,
      fixture.db,
      fixture.owner,
      doomed,
      `wsdelete-${role}@example.com`,
      role,
    );
    expect(invited.statusCode, invited.body).toBe(200);
  }
  expect(
    (
      await fixture.call("POST", "/invitations", {
        email: "wsdelete-invited@example.com",
        role: "viewer",
      })
    ).statusCode,
  ).toBe(200);
  ownSub = "wsdelete-own";
  sharedSub = "wsdelete-shared";
  const ownConnection = await oauthConnection(doomed, ownSub);
  const waiting = await oauthConnection(doomed, sharedSub);
  // A sync that waits, and (below) one that is running, when the workspace
  // is deleted.
  await admin`
    insert into jobs (kind, workspace_id, connection_id, payload)
    values ('connection.sync', ${doomed}, ${waiting},
      ${admin.json({ workspace_id: doomed, connection_id: waiting })})`;
  const [job] = await admin<{ id: string }[]>`
    insert into jobs (kind, workspace_id, connection_id, payload, status,
      locked_by, locked_at)
    values ('connection.sync', ${doomed}, ${ownConnection},
      ${admin.json({ workspace_id: doomed, connection_id: ownConnection })},
      'running', 'worker:test', now())
    returning id`;
  runningJob = job!.id;
  await admin`
    update connection_state set next_due_at = now()
    where workspace_id = ${doomed}`;

  // The workspace that stays: another owner's, with a connection on the
  // shared OAuth account, an image and a screen.
  keptOwner = strangerCookie;
  kept = await createWorkspaceAs(keptOwner, "Kept");
  keptConnection = await oauthConnection(kept, sharedSub);
  await fixture.storeImage("https://img.example/photos/kept.png", kept);
}, TEST_DATABASE_SETUP_TIMEOUT_MS * 2);

afterAll(async () => {
  await schedulerDb?.$client.end({ timeout: 5 }).catch(() => undefined);
  await fixture?.close();
  await provider?.close();
});

describe("the schema", () => {
  it("removes every tenant table with its workspace (cascade from workspaces)", async () => {
    // A table with a workspace_id column must lose its rows when the
    // workspace row goes: a cascading foreign key to workspaces, or to a
    // table that has one. A new table without one fails here.
    const edges = await admin<{ child: string; parent: string }[]>`
      select c.conrelid::regclass::text as child,
             c.confrelid::regclass::text as parent
      from pg_constraint c
      where c.contype = 'f' and c.confdeltype = 'c'
        and c.connamespace = 'public'::regnamespace`;
    const cascades = new Set(["workspaces"]);
    for (let grew = true; grew;) {
      grew = false;
      for (const { child, parent } of edges) {
        if (cascades.has(parent) && !cascades.has(child)) {
          cascades.add(child);
          grew = true;
        }
      }
    }
    const tables = await tenantTables();
    expect(tables.length).toBeGreaterThan(40);
    expect(tables.filter((table) => !cascades.has(table))).toEqual([]);
  });
});

describe("deleting a workspace", () => {
  it("is refused for everyone but an owner, and without the workspace's name", async () => {
    const before = await rowsOf(doomed);
    expectError(
      await requestDelete(doomed, adminCookie, NAME),
      403,
      "forbidden",
    );
    expectError(
      await requestDelete(doomed, editorCookie, NAME),
      403,
      "forbidden",
    );
    expectError(
      await requestDelete(doomed, viewerCookie, NAME),
      403,
      "forbidden",
    );
    // Another workspace's owner: like any unknown workspace.
    expectError(
      await requestDelete(doomed, strangerCookie, NAME),
      404,
      "workspace_not_found",
    );
    expect(
      (
        await fixture.app.inject({
          method: "POST",
          url: `/v1/workspaces/${doomed}/delete`,
          payload: { name: NAME },
        })
      ).statusCode,
    ).toBe(401);
    // A workspace that never was, or is purged, and an id that is none:
    // the same answer, to the owner of another workspace too.
    for (const id of [randomUUID(), "not-a-uuid"]) {
      for (const cookie of [fixture.owner, strangerCookie]) {
        expectError(
          await requestDelete(id, cookie, NAME),
          404,
          "workspace_not_found",
        );
      }
    }
    for (const name of ["", "items", "Item", "Kept", `${NAME}!`]) {
      expectError(
        await requestDelete(doomed, fixture.owner, name),
        400,
        "workspace_name_mismatch",
      );
    }
    expectError(
      await fixture.app.inject({
        method: "POST",
        url: `/v1/workspaces/${doomed}/delete`,
        headers: { cookie: fixture.owner },
        payload: {},
      }),
      400,
      "invalid_request",
    );
    expect((await workspaceRow(doomed))!.deleted_at).toBeNull();
    expect(await rowsOf(doomed)).toEqual(before);
    expect(await purgeJobs(doomed)).toEqual([]);
  });

  it("the database refuses a non-owner and a wrong name on its own", async () => {
    // delete_workspace() acts on the transaction's context only and checks
    // role and name itself, whatever the API checked.
    const as = async (email: string | null, name: string) => {
      const [user] = email
        ? await admin<{ id: string }[]>`
            select id from users where email = ${email}`
        : [undefined];
      const app = createRawSqlClient(fixture.testDb.appUrl, { max: 1 });
      try {
        return await app.begin(async (tx) => {
          await tx`select set_config('app.workspace_id', ${doomed}, true)`;
          if (user)
            await tx`select set_config('app.user_id', ${user.id}, true)`;
          const [row] = await tx<{ outcome: string }[]>`
            select delete_workspace(${name}) as outcome`;
          return row!.outcome;
        });
      } finally {
        await app.end({ timeout: 5 });
      }
    };
    expect(await as("wsdelete-admin@example.com", NAME)).toBe("forbidden");
    expect(await as("wsdelete-stranger@example.com", NAME)).toBe("not_found");
    expect(await as(null, NAME)).toBe("not_found");
    expect(await as("wsdelete-owner@example.com", "Other")).toBe(
      "name_mismatch",
    );
    expect((await workspaceRow(doomed))!.deleted_at).toBeNull();
  });

  it("ends all access at once and leaves the data to the purge", async () => {
    const before = await rowsOf(doomed);
    // What the workspace holds, so "gone afterwards" means something.
    for (const table of [
      "memberships",
      "invitations",
      "projects",
      "connections",
      "connection_state",
      "connection_oauth",
      "observations",
      "dashboards",
      "dashboard_slides",
      "dashboard_widgets",
      "devices",
      "principal_tokens",
      "workspace_images",
      "workspace_themes",
      "goals",
      "custom_api_item_images",
      "data_datasets",
      "data_records",
      "data_models",
      "data_model_releases",
      "jobs",
      "audit_events",
    ]) {
      expect(before[table] ?? 0, table).toBeGreaterThan(0);
    }
    expect(await screenStatus(screenToken)).toBe(200);

    // The name as typed, with space around it.
    const response = await requestDelete(doomed, fixture.owner, `  ${NAME} `);
    expect(response.statusCode, response.body).toBe(204);

    // No account reaches it: owner and members get the answers of an
    // unknown workspace.
    for (const cookie of [fixture.owner, adminCookie, viewerCookie]) {
      expect(await listed(cookie)).not.toContain(doomed);
      for (const path of ["", "/dashboards", "/connections", "/members"]) {
        const read = await fixture.app.inject({
          method: "GET",
          url: `/v1/workspaces/${doomed}${path}`,
          headers: { cookie },
        });
        expect(read.statusCode, path).toBe(404);
      }
    }
    // A second request finds nothing to delete.
    expectError(
      await requestDelete(doomed, fixture.owner, NAME),
      404,
      "workspace_not_found",
    );

    const after = await rowsOf(doomed);
    expect(after.memberships).toBeUndefined();
    expect(after.invitations).toBeUndefined();
    expect(after.device_pairings).toBeUndefined();
    expect(after.oauth_authorizations).toBeUndefined();
    // The data waits for the purge.
    expect(after.observations).toBe(before.observations);
    expect(after.data_records).toBe(before.data_records);
    expect((await workspaceRow(doomed))!.deleted_at).not.toBeNull();

    // The screen is revoked like a removed screen: 401 on its next request.
    expect(await screenStatus(screenToken)).toBe(401);
    const [devices] = await admin<{ live: number }[]>`
      select count(*)::int as live from devices
      where workspace_id = ${doomed} and revoked_at is null`;
    expect(devices!.live).toBe(0);
    const [tokens] = await admin<{ live: number }[]>`
      select count(*)::int as live from principal_tokens
      where workspace_id = ${doomed} and revoked_at is null`;
    expect(tokens!.live).toBe(0);

    // No job of it runs again, and the scheduler plans none.
    const jobs = await admin<{ status: string; last_error: string }[]>`
      select status, last_error from jobs where workspace_id = ${doomed}`;
    // The waiting and the running sync ended; the finished backfill stays
    // as it was.
    expect(jobs.map((job) => job.status).sort()).toEqual([
      "failed",
      "failed",
      "succeeded",
    ]);
    const [stopped] = await admin`
      select status, locked_by, last_error from jobs where id = ${runningJob}`;
    expect(stopped).toEqual({
      status: "failed",
      locked_by: null,
      last_error: "workspace deleted",
    });
    // The worker that still runs it can neither complete nor retry it.
    expect(await completeJob(schedulerDb, runningJob, "worker:test")).toBe(
      false,
    );
    expect(
      await failJob(schedulerDb, runningJob, "worker:test", "late", {
        retryable: true,
      }),
    ).toBeNull();
    const [due] = await admin<{ due: number }[]>`
      select count(*)::int as due from connection_state
      where workspace_id = ${doomed} and next_due_at is not null`;
    expect(due!.due).toBe(0);

    // Who deleted what, outside the workspace's own audit log.
    const [owner] = await admin<{ id: string }[]>`
      select id from users where email = 'wsdelete-owner@example.com'`;
    const events = await admin`
      select workspace_id, actor_user_id, target, metadata from audit_events
      where action = 'workspace.deleted'`;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      workspace_id: null,
      actor_user_id: owner!.id,
      target: doomed,
      metadata: { name: NAME, members: 4, screens: 1 },
    });
    expect(Object.keys(events[0]!.metadata as object).sort()).toEqual([
      "connections",
      "dashboards",
      "members",
      "name",
      "screens",
    ]);

    // One purge waits; the scheduler's sweep adds no second one.
    expect((await purgeJobs(doomed)).map((job) => job.status)).toEqual([
      "pending",
    ]);
    expect(await enqueueWorkspacePurges(schedulerDb)).toBe(0);
  });

  it("the purge removes everything, revokes its own grants, and leaves the other workspace alone", async () => {
    const keptBefore = await rowsOf(kept);
    const revokedBefore = provider.revocations.length;
    await runPurges();

    expect((await purgeJobs(doomed)).map((job) => job.status)).toEqual([
      "succeeded",
    ]);
    expect(await workspaceRow(doomed)).toBeUndefined();
    // Per table, and so for the stored images (rows of workspace_images).
    expect(await rowsOf(doomed)).toEqual({});
    const [images] = await admin<{ count: number }[]>`
      select count(*)::int as count from workspace_images
      where workspace_id = ${doomed}`;
    expect(images!.count).toBe(0);

    // The grant only this workspace used is revoked at the provider; the
    // one the other workspace's connection shares is kept.
    expect(provider.revocations.length - revokedBefore).toBe(1);
    expect(provider.isRevoked(ownSub)).toBe(true);
    expect(provider.isRevoked(sharedSub)).toBe(false);

    expect(await rowsOf(kept)).toEqual(keptBefore);
    expect(keptBefore.connections).toBe(1);
    expect(keptBefore.workspace_images).toBe(1);
    const [connection] = await admin`
      select id from connections where id = ${keptConnection}`;
    expect(connection).toBeDefined();
    expect(await listed(keptOwner)).toEqual([kept]);

    // Both audit events outlive the workspace.
    const events = await admin<{ action: string; metadata: unknown }[]>`
      select action, metadata from audit_events
      where workspace_id is null and target = ${doomed}
      order by created_at`;
    expect(events.map((event) => event.action)).toEqual([
      "workspace.deleted",
      "workspace.purged",
    ]);
    expect(events[1]!.metadata).toEqual({
      connections: 3,
      oauthGrants: { revoked: 1, failed: 0, kept: 1 },
    });

    // No token in what was logged about the revocation.
    for (const line of logs) {
      expect(line).not.toMatch(/refresh[-_]?token["']?\s*[:=]\s*["'][^"']+/i);
    }
  });

  it("a deleted and a purged workspace answer every role like an unknown one", async () => {
    // `doomed` is purged by now; another is deleted and not purged.
    const waiting = await createWorkspaceAs(fixture.owner, "Waiting");
    const invited = await addMemberViaInvitation(
      fixture.app,
      fixture.db,
      fixture.owner,
      waiting,
      "wsdelete-admin@example.com",
      "admin",
    );
    expect(invited.statusCode, invited.body).toBe(200);
    expectError(
      await requestDelete(waiting, adminCookie, "Waiting"),
      403,
      "forbidden",
    );
    expect(
      (await requestDelete(waiting, fixture.owner, "Waiting")).statusCode,
    ).toBe(204);
    expect(await workspaceRow(waiting)).toMatchObject({
      deleted_at: expect.any(Date),
    });
    expect(await workspaceRow(doomed)).toBeUndefined();
    for (const [id, name] of [
      [waiting, "Waiting"],
      [doomed, NAME],
    ] as const) {
      for (const cookie of [
        fixture.owner,
        adminCookie,
        editorCookie,
        viewerCookie,
        strangerCookie,
      ]) {
        expectError(
          await requestDelete(id, cookie, name),
          404,
          "workspace_not_found",
        );
      }
    }
  });

  it("a purge that runs again finds nothing to do", async () => {
    await admin`
      insert into jobs (kind, payload)
      values ('workspace.purge', ${admin.json({
        workspace_id: null,
        connection_id: null,
        purge_workspace_id: doomed,
      })})`;
    const revokedBefore = provider.revocations.length;
    await runPurges();
    expect((await purgeJobs(doomed)).map((job) => job.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    expect(provider.revocations.length).toBe(revokedBefore);
    expect((await workspaceRow(kept))!.deleted_at).toBeNull();
  });

  it("never purges a workspace that is not deleted", async () => {
    const before = await rowsOf(kept);
    await admin`
      insert into jobs (kind, payload)
      values ('workspace.purge', ${admin.json({
        workspace_id: null,
        connection_id: null,
        purge_workspace_id: kept,
      })})`;
    await runPurges();
    const [job] = await purgeJobs(kept);
    expect(job).toMatchObject({ status: "dead" });
    expect(job!.last_error).toContain("not deleted");
    expect(await rowsOf(kept)).toEqual(before);
    expect(provider.isRevoked(sharedSub)).toBe(false);
  });

  it("resumes after a purge that stopped half way, and after its job is lost", async () => {
    const cookie = await fixture.signUp("wsdelete-second@example.com");
    const second = await createWorkspaceAs(cookie, "Second");
    const spare = await createWorkspaceAs(cookie, "Second spare");
    const sub = "wsdelete-second";
    await oauthConnection(second, sub);
    await oauthConnection(second, `${sub}-b`);
    await fixture.storeImage("https://img.example/photos/second.png", second);
    expect((await requestDelete(second, cookie, "Second")).statusCode).toBe(
      204,
    );
    // The worker stopped after the first connection: one is gone, the job
    // ran out of attempts.
    const [first] = await admin<{ id: string }[]>`
      select id from connections where workspace_id = ${second} limit 1`;
    await admin`delete from connections where id = ${first!.id}`;
    await admin`
      update jobs set status = 'dead'
      where kind = 'workspace.purge'
        and payload ->> 'purge_workspace_id' = ${second}`;
    // Deleted, and still unreachable while nothing purges it.
    expect(await listed(cookie)).toEqual([spare]);
    expect(await workspaceRow(second)).toBeDefined();

    expect(await enqueueWorkspacePurges(schedulerDb)).toBe(1);
    expect(await enqueueWorkspacePurges(schedulerDb)).toBe(0);
    await runPurges();
    expect((await purgeJobs(second)).map((job) => job.status)).toEqual([
      "dead",
      "succeeded",
    ]);
    expect(await workspaceRow(second)).toBeUndefined();
    expect(await rowsOf(second)).toEqual({});
  });

  it("keeps the last owner of a workspace that is not deleted", async () => {
    await expect(
      admin`delete from memberships where workspace_id = ${kept}`,
    ).rejects.toThrow(/last owner/);
  });
});

// #855: an owner cannot delete their only workspace. "Only" counts the
// deleting user's memberships, in any role, in workspaces that are not
// deleted; nobody else's.
describe("the owner's only workspace", () => {
  const deletedEvents = async (workspaceId: string) => {
    const [row] = await admin<{ count: number }[]>`
      select count(*)::int as count from audit_events
      where action = 'workspace.deleted' and target = ${workspaceId}`;
    return row!.count;
  };

  /** delete_workspace() itself, as the application role. */
  const inDatabase = async (
    workspaceId: string,
    email: string,
    name: string,
    isolation = "read committed",
  ) => {
    const [user] = await admin<{ id: string }[]>`
      select id from users where email = ${email}`;
    const app = createRawSqlClient(fixture.testDb.appUrl, { max: 1 });
    try {
      return await app.begin(`isolation level ${isolation}`, async (tx) => {
        await tx`select set_config('app.workspace_id', ${workspaceId}, true),
          set_config('app.user_id', ${user!.id}, true)`;
        const [row] = await tx<{ outcome: string }[]>`
          select delete_workspace(${name}) as outcome`;
        return row!.outcome;
      });
    } finally {
      await app.end({ timeout: 5 });
    }
  };

  it("is refused, by the API and by the database on its own, and nothing changes", async () => {
    const cookie = await fixture.signUp("wsdelete-only@example.com");
    const only = await createWorkspaceAs(cookie, "Only");
    const before = await rowsOf(only);

    expectError(
      await requestDelete(only, cookie, "Only"),
      409,
      "workspace_last",
    );
    // Whatever name was typed: there is nothing to confirm.
    expectError(
      await requestDelete(only, cookie, "Else"),
      409,
      "workspace_last",
    );
    await expect(
      inDatabase(only, "wsdelete-only@example.com", "Only"),
    ).rejects.toMatchObject({ code: "WS002" });

    expect(await workspaceRow(only)).toMatchObject({ deleted_at: null });
    expect(await rowsOf(only)).toEqual(before);
    expect(await purgeJobs(only)).toEqual([]);
    expect(await deletedEvents(only)).toBe(0);
    expect(await listed(cookie)).toEqual([only]);
    // Still a working workspace.
    const read = await fixture.app.inject({
      method: "GET",
      url: `/v1/workspaces/${only}`,
      headers: { cookie },
    });
    expect(read.statusCode).toBe(200);
  });

  it("can be deleted once the owner has a second workspace; the one left is then the only one", async () => {
    const cookie = await fixture.signUp("wsdelete-two@example.com");
    const first = await createWorkspaceAs(cookie, "First");
    expectError(
      await requestDelete(first, cookie, "First"),
      409,
      "workspace_last",
    );
    const second = await createWorkspaceAs(cookie, "Second of two");
    expect((await requestDelete(first, cookie, "First")).statusCode).toBe(204);
    expect(await listed(cookie)).toEqual([second]);

    // The deleted one still exists, waiting for its purge (no worker runs
    // here), and does not count as a second workspace.
    expect((await workspaceRow(first))!.deleted_at).not.toBeNull();
    expectError(
      await requestDelete(second, cookie, "Second of two"),
      409,
      "workspace_last",
    );
    await expect(
      inDatabase(second, "wsdelete-two@example.com", "Second of two"),
    ).rejects.toMatchObject({ code: "WS002" });
    // Not even with a membership of the deleted workspace put back behind
    // the deletion's back (the trigger of 0094 is off for this one row).
    const [user] = await admin<{ id: string }[]>`
      select id from users where email = 'wsdelete-two@example.com'`;
    await admin.begin(async (tx) => {
      await tx`alter table memberships
        disable trigger memberships_refuse_deleted_workspace`;
      await tx`insert into memberships (workspace_id, user_id, role)
        values (${first}, ${user!.id}, 'owner')`;
      await tx`alter table memberships
        enable trigger memberships_refuse_deleted_workspace`;
    });
    expectError(
      await requestDelete(second, cookie, "Second of two"),
      409,
      "workspace_last",
    );
    expect((await workspaceRow(second))!.deleted_at).toBeNull();
    await admin`delete from memberships where workspace_id = ${first}`;

    await runPurges();
    expect(await workspaceRow(first)).toBeUndefined();
    expect(await workspaceRow(second)).toMatchObject({ deleted_at: null });
  });

  it("a membership in someone else's workspace counts, whatever the role", async () => {
    const email = "wsdelete-guest@example.com";
    const cookie = await fixture.signUp(email);
    const own = await createWorkspaceAs(cookie, "Own");
    expectError(await requestDelete(own, cookie, "Own"), 409, "workspace_last");
    const invited = await addMemberViaInvitation(
      fixture.app,
      fixture.db,
      keptOwner,
      kept,
      email,
      "viewer",
    );
    expect(invited.statusCode, invited.body).toBe(200);
    expect((await requestDelete(own, cookie, "Own")).statusCode).toBe(204);
    expect(await listed(cookie)).toEqual([kept]);
  });

  it("does not protect other members: they are left without a workspace and can start a new one", async () => {
    const ownerCookie = await fixture.signUp("wsdelete-host@example.com");
    const shared = await createWorkspaceAs(ownerCookie, "Shared");
    const other = await createWorkspaceAs(ownerCookie, "Host other");
    const email = "wsdelete-member@example.com";
    const memberCookie = await fixture.signUp(email);
    const invited = await addMemberViaInvitation(
      fixture.app,
      fixture.db,
      ownerCookie,
      shared,
      email,
      "admin",
    );
    expect(invited.statusCode, invited.body).toBe(200);
    expect(await listed(memberCookie)).toEqual([shared]);

    expect(
      (await requestDelete(shared, ownerCookie, "Shared")).statusCode,
    ).toBe(204);
    expect(await listed(ownerCookie)).toEqual([other]);
    expect(await listed(memberCookie)).toEqual([]);
    const me = await fixture.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie: memberCookie },
    });
    expect(me.statusCode).toBe(200);
    const next = await createWorkspaceAs(memberCookie, "Shared");
    expect(await listed(memberCookie)).toEqual([next]);
  });

  it("the database refuses a transaction whose snapshot could predate another deletion", async () => {
    const email = "wsdelete-snapshot@example.com";
    const cookie = await fixture.signUp(email);
    const first = await createWorkspaceAs(cookie, "Snapshot one");
    await createWorkspaceAs(cookie, "Snapshot two");
    for (const isolation of ["repeatable read", "serializable"]) {
      await expect(
        inDatabase(first, email, "Snapshot one", isolation),
      ).rejects.toMatchObject({ code: "0A000" });
    }
    expect((await workspaceRow(first))!.deleted_at).toBeNull();
    expect(await inDatabase(first, email, "Snapshot one")).toBe("deleted");
  });

  it.each(["repeatable read", "serializable"])(
    "the API deletes and refuses as usual when the role's default isolation is %s",
    async (isolation) => {
      // An installation may set default_transaction_isolation for the
      // application role or the database: the route must not inherit it
      // into delete_workspace(), which needs read committed.
      const email = `wsdelete-default-${isolation.replace(" ", "-")}@example.com`;
      const cookie = await fixture.signUp(email);
      const first = await createWorkspaceAs(cookie, "Default one");
      const second = await createWorkspaceAs(cookie, "Default two");
      await admin.unsafe(
        `alter role netrics_app in database "${fixture.testDb.name}"
           set default_transaction_isolation = '${isolation}'`,
      );
      // New connections, which start with the role's default.
      const db = createDatabase(fixture.testDb.appUrl);
      const config = loadConfig({
        DATABASE_URL: fixture.testDb.appUrl,
        LOG_LEVEL: "silent",
        BETTER_AUTH_URL: "http://localhost:3001",
        WEB_ORIGIN: "http://localhost:3000",
      });
      const app = await buildApp(config, {
        db,
        authService: createAuthService(config, db, {
          logger: pino({ level: "silent" }),
        }),
        checkDb: async () => true,
      });
      const remove = (workspaceId: string, name: string) =>
        app.inject({
          method: "POST",
          url: `/v1/workspaces/${workspaceId}/delete`,
          headers: { cookie },
          payload: { name },
        });
      try {
        const [inherited] = await db.$client<{ level: string }[]>`
          show transaction_isolation`;
        expect(Object.values(inherited!)[0]).toBe(isolation);
        const deleted = await remove(first, "Default one");
        expect(deleted.statusCode, deleted.body).toBe(204);
        expectError(await remove(second, "Default two"), 409, "workspace_last");
        expect((await workspaceRow(first))!.deleted_at).not.toBeNull();
        expect((await workspaceRow(second))!.deleted_at).toBeNull();
      } finally {
        await app.close();
        await db.$client.end({ timeout: 5 });
        await admin.unsafe(
          `alter role netrics_app in database "${fixture.testDb.name}"
             reset default_transaction_isolation`,
        );
      }
    },
  );
});
