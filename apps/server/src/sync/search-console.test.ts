import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, LookupFunction } from "node:net";

import { ConnectorRegistry } from "@netrics/connector-runtime";
import type {
  Connector,
  ConnectorRuntime,
  ConnectionContext,
} from "@netrics/connector-sdk";
import {
  createSearchConsoleConnector,
  searchConsoleManifest,
} from "@netrics/connectors";
import {
  createDatabase,
  createRawSqlClient,
  createWorkspace,
  enqueueJob,
  schema,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createCredentialKeyring } from "../credentials.js";
import { createJobHandlers } from "../jobs/handlers.js";
import { OAuthProviders } from "../oauth/config.js";
import {
  capturingLogger,
  seedOAuthConnection,
  startTestOAuthProvider,
  TEST_CLIENT_ID,
  TEST_CLIENT_SECRET,
  TEST_PROVIDER_EGRESS,
  type TestOAuthProvider,
} from "../oauth/test-provider.js";
import { createOAuthTokenService } from "../oauth/tokens.js";
import type { OAuthProviderDefinition } from "../oauth/providers/types.js";
import { runSchedulerTick } from "../scheduler.js";
import { Secret } from "../secret.js";
import { createTestDatabase, type TestDatabase } from "../test-db.js";
import { createWorker, type WorkerHandle } from "../worker.js";
import { syncCatalog } from "./catalog.js";

vi.setConfig({ testTimeout: 20_000 });

// The Google Search Console connector (#134) in the sync engine with the
// token service (#133), offline: the shared fixture provider plays Google's
// token endpoint (under the provider id "google"), and a fake Search Console
// API on 127.0.0.1 answers under searchconsole.googleapis.com, accepting only
// access tokens the fixture provider issued and still considers live.

const [STRATEGY] = searchConsoleManifest.authStrategies;
const WEBMASTERS_READONLY_SCOPE =
  STRATEGY?.strategy === "oauth2" ? STRATEGY.scopes[0]! : "";
const KEYRING = createCredentialKeyring(randomBytes(32).toString("base64"));
const CONNECTOR_ID = "google-search-console";
const SITE = "sc-domain:example.com";
const API_HOST = "searchconsole.googleapis.com";
const DAY = { clicks: 12, impressions: 340, ctr: 12 / 340, position: 4.5 };

let provider: TestOAuthProvider;

// ─── Fake Search Console API ────────────────────────────────────────────────

interface ApiCall {
  method: string;
  path: string;
  token: string | undefined;
  status: number;
}

let api: Server;
let apiPort: number;
const apiCalls: ApiCall[] = [];
/** The next answers to these kinds of calls are 401 (count). */
const rejectNext = { sites: 0, syncQuery: 0 };

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function datesBetween(start: string, end: string): string[] {
  const dates: string[] = [];
  for (
    let ms = Date.parse(`${start}T00:00:00Z`);
    ms <= Date.parse(`${end}T00:00:00Z`);
    ms += 86_400_000
  ) {
    dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  return dates;
}

async function answerApi(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";
  const authorization = request.headers.authorization;
  const token = /^Bearer (.+)$/.exec(authorization ?? "")?.[1];
  const body = await readBody(request);
  const send = (status: number, payload: unknown) => {
    apiCalls.push({ method, path: url.pathname, token, status });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  };
  const unauthenticated = {
    error: {
      code: 401,
      message: "Request had invalid authentication credentials.",
      status: "UNAUTHENTICATED",
    },
  };
  // A live token of the fixture provider, as Google would check it.
  const live = await provider.handle(
    "GET",
    "/api/resource",
    new URLSearchParams(),
    authorization,
  );
  if (live.status !== 200) {
    send(401, unauthenticated);
    return;
  }

  if (method === "GET" && url.pathname === "/webmasters/v3/sites") {
    if (rejectNext.sites > 0) {
      rejectNext.sites -= 1;
      send(401, unauthenticated);
      return;
    }
    send(200, {
      siteEntry: [{ siteUrl: SITE, permissionLevel: "siteOwner" }],
    });
    return;
  }
  const query =
    /^\/webmasters\/v3\/sites\/([^/]+)\/searchAnalytics\/query$/.exec(
      url.pathname,
    );
  if (method === "POST" && query && decodeURIComponent(query[1]!) === SITE) {
    const input = JSON.parse(body) as {
      startDate: string;
      endDate: string;
      dimensions?: string[];
    };
    const syncPage = input.dimensions?.[0] === "date";
    if (syncPage && rejectNext.syncQuery > 0) {
      rejectNext.syncQuery -= 1;
      send(401, unauthenticated);
      return;
    }
    const rows = syncPage
      ? datesBetween(input.startDate, input.endDate).map((date) => ({
          keys: [date],
          ...DAY,
        }))
      : [DAY];
    send(200, { rows, responseAggregationType: "byProperty" });
    return;
  }
  send(404, { error: { code: 404, status: "NOT_FOUND" } });
}

/** Resolves every name to the fake API (only the connector's runtime). */
const toLocalhost: LookupFunction = (_hostname, options, callback) => {
  const entry = { address: "127.0.0.1", family: 4 };
  if (options.all) {
    (callback as unknown as (e: null, a: (typeof entry)[]) => void)(null, [
      entry,
    ]);
  } else {
    callback(null, entry.address, entry.family);
  }
};

/**
 * The real connector, its runtime.fetch pointed at the fake API: same host
 * (the egress allowlist still applies), plain http on the fake's port.
 */
const received: Array<Record<string, unknown>> = [];
function towardsFakeApi(connector: Connector): Connector {
  const rewrite = (runtime: ConnectorRuntime): ConnectorRuntime => ({
    ...runtime,
    fetch: (url, init) =>
      runtime.fetch(
        url.replace(`https://${API_HOST}/`, `http://${API_HOST}:${apiPort}/`),
        init,
      ),
  });
  const record = (context: ConnectionContext) => {
    received.push({ ...context.credentials });
  };
  return {
    manifest: connector.manifest,
    check: (context, runtime) => {
      record(context);
      return connector.check(context, rewrite(runtime));
    },
    discover: (context, runtime) =>
      connector.discover(context, rewrite(runtime)),
    sync: (context, request, runtime) => {
      record(context);
      return connector.sync(context, request, rewrite(runtime));
    },
  };
}

// ─── Harness ────────────────────────────────────────────────────────────────

let testDb: TestDatabase;
let appDb: Database;
let schedulerDb: Database;
let schedulerRaw: Sql;
let worker: WorkerHandle;
let workspaceId: string;
const logs: string[] = [];
let subCounter = 0;

function schedulerUrlOf(db: TestDatabase): string {
  const url = new URL(db.adminUrl);
  url.username = "netrics_scheduler";
  url.password = "netrics_scheduler";
  return url.toString();
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A Search Console connection as the authorization flow leaves it. */
async function seed(
  options: { expired?: boolean; setupPending?: boolean } = {},
) {
  subCounter += 1;
  const sub = `gsc-sub-${subCounter}`;
  const refreshToken = provider.grant({
    sub,
    scopes: [WEBMASTERS_READONLY_SCOPE],
  });
  const connectionId = await seedOAuthConnection(appDb, KEYRING, {
    workspaceId,
    connectorId: CONNECTOR_ID,
    provider: "google",
    refreshToken,
    sub,
    grantedScopes: [WEBMASTERS_READONLY_SCOPE],
    ...(options.expired
      ? {
          accessToken: {
            value: `expired-at-${randomBytes(8).toString("hex")}`,
            expiresAt: new Date(Date.now() - 1000),
          },
        }
      : {}),
  });
  await withWorkspace(appDb, { workspaceId }, async (tx) => {
    await tx
      .update(schema.connections)
      .set(
        options.setupPending
          ? { setupPending: true, config: {} }
          : { setupPending: false, config: { siteUrl: SITE } },
      )
      .where(eq(schema.connections.id, connectionId));
    // Keep the scheduler away from it unless a test asks.
    await tx
      .update(schema.connectionState)
      .set({ nextDueAt: new Date(Date.now() + 3600_000) })
      .where(eq(schema.connectionState.connectionId, connectionId));
  });
  return { sub, connectionId };
}

async function runJob(connectionId: string, kind = "connection.sync") {
  const jobId = await withWorkspace(appDb, { workspaceId }, (tx) =>
    enqueueJob(tx, { kind, workspaceId, connectionId }),
  );
  await waitFor(async () => {
    const [row] = await schedulerRaw<{ status: string }[]>`
      select status from jobs where id = ${jobId}`;
    return ["succeeded", "failed", "dead"].includes(row!.status);
  });
  const [row] = await schedulerRaw<
    { status: string; last_error: string | null }[]
  >`select status, last_error from jobs where id = ${jobId}`;
  return row!;
}

async function stateOf(connectionId: string) {
  return withWorkspace(appDb, { workspaceId }, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.connectionState)
      .where(eq(schema.connectionState.connectionId, connectionId));
    return row!;
  });
}

async function clicksOf(connectionId: string) {
  return withWorkspace(appDb, { workspaceId }, (tx) =>
    tx
      .select({
        value: schema.observations.value,
        dimensions: schema.observations.dimensions,
        sourceTimestamp: schema.observations.sourceTimestamp,
      })
      .from(schema.observations)
      .innerJoin(
        schema.metricDefinitions,
        eq(schema.metricDefinitions.id, schema.observations.metricDefinitionId),
      )
      .where(
        and(
          eq(schema.observations.workspaceId, workspaceId),
          eq(schema.observations.connectionId, connectionId),
          eq(schema.metricDefinitions.key, `${CONNECTOR_ID}.clicks`),
        ),
      ),
  );
}

async function runCount(connectionId: string): Promise<number> {
  const rows = await withWorkspace(appDb, { workspaceId }, (tx) =>
    tx.execute<{ count: number }>(
      sql`select count(*)::int as count from sync_runs
          where connection_id = ${connectionId}::uuid`,
    ),
  );
  return rows[0]!.count;
}

beforeAll(async () => {
  provider = await startTestOAuthProvider();
  api = createServer((request, response) => {
    answerApi(request, response).catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  apiPort = (api.address() as AddressInfo).port;

  testDb = await createTestDatabase();
  appDb = createDatabase(testDb.appUrl);
  schedulerDb = createDatabase(schedulerUrlOf(testDb));
  schedulerRaw = createRawSqlClient(schedulerUrlOf(testDb), { max: 2 });

  const registry = new ConnectorRegistry();
  registry.register(towardsFakeApi(createSearchConsoleConnector()));
  const owner = createDatabase(testDb.adminUrl, { max: 1 });
  await syncCatalog(owner, registry);
  await owner.$client.end({ timeout: 5 });

  const [user] = await appDb
    .insert(schema.users)
    .values({ email: "gsc-engine@example.com", displayName: "GSC" })
    .returning({ id: schema.users.id });
  workspaceId = await createWorkspace(appDb, {
    name: "Search Console engine",
    ownerUserId: user!.id,
  });

  // Google, as far as the token service is concerned: the fixture's token
  // endpoint under the provider id the connector's manifest names.
  const google: OAuthProviderDefinition = {
    ...provider.definition,
    id: "google",
    name: "Google",
  };
  const providers = new OAuthProviders(
    [
      {
        definition: google,
        clientId: TEST_CLIENT_ID,
        clientSecret: new Secret(TEST_CLIENT_SECRET),
        redirectUri: "http://localhost:3000/oauth/google/callback",
      },
    ],
    new Map([["google", google]]),
  );
  const logger = capturingLogger(logs);
  worker = createWorker({
    schedulerDb,
    appDb,
    handlers: createJobHandlers({
      registry,
      credentialKeyring: KEYRING,
      oauthTokens: createOAuthTokenService({
        db: appDb,
        credentialKeyring: KEYRING,
        providers,
        logger,
        egress: TEST_PROVIDER_EGRESS,
      }),
      executeOptions: {
        egress: { ...TEST_PROVIDER_EGRESS, lookup: toLocalhost },
      },
    }),
    pollMs: 25,
    heartbeatMs: 50,
    logger,
  });
  await worker.start();
}, 60_000);

afterAll(async () => {
  await worker?.stop().catch(() => undefined);
  await schedulerRaw?.end({ timeout: 5 }).catch(() => undefined);
  await provider?.close();
  await new Promise<void>((resolve) => {
    if (!api) return resolve();
    api.closeAllConnections();
    api.close(() => resolve());
  });
});

describe("Google Search Console in the sync engine", () => {
  it("syncs an OAuth connection with a property into observations", async () => {
    const { connectionId } = await seed();
    received.length = 0;
    apiCalls.length = 0;
    expect((await runJob(connectionId)).status).toBe("succeeded");

    // check (sites + property probe) and one sync page, all with one token
    for (const credentials of received) {
      expect(Object.keys(credentials)).toEqual(["accessToken"]);
    }
    expect(apiCalls.map((call) => call.status)).toEqual([200, 200, 200]);
    expect(apiCalls[0]).toMatchObject({
      method: "GET",
      path: "/webmasters/v3/sites",
    });
    expect(new Set(apiCalls.map((call) => call.token)).size).toBe(1);
    expect(apiCalls[0]!.token).toBe(provider.accessTokens.at(-1));

    const clicks = await clicksOf(connectionId);
    expect(clicks.length).toBeGreaterThanOrEqual(1);
    for (const row of clicks) {
      expect(row.value).toBe(DAY.clicks);
      expect(row.dimensions).toEqual({ resource: SITE });
      expect(row.sourceTimestamp.toISOString()).toMatch(/T00:00:00\.000Z$/);
    }
    expect(await stateOf(connectionId)).toMatchObject({
      authState: "ok",
      consecutiveFailures: 0,
    });
    expect((await stateOf(connectionId)).lastSuccessAt).not.toBeNull();
  });

  it("refreshes an expired access token once before calling Google", async () => {
    const { connectionId } = await seed({ expired: true });
    apiCalls.length = 0;
    const before = provider.refreshRequests;
    expect((await runJob(connectionId)).status).toBe("succeeded");
    expect(provider.refreshRequests - before).toBe(1);
    const fresh = provider.accessTokens.at(-1);
    expect(apiCalls.length).toBeGreaterThan(0);
    for (const call of apiCalls) {
      expect(call).toMatchObject({ status: 200, token: fresh });
    }
    expect((await clicksOf(connectionId)).length).toBeGreaterThanOrEqual(1);
  });

  it("refreshes exactly once and retries the check after a 401", async () => {
    const { connectionId } = await seed();
    expect((await runJob(connectionId)).status).toBe("succeeded");
    const before = provider.refreshRequests;
    apiCalls.length = 0;
    rejectNext.sites = 1; // Google refuses the cached token once
    expect((await runJob(connectionId)).status).toBe("succeeded");
    expect(provider.refreshRequests - before).toBe(1);
    const [rejected, ...rest] = apiCalls;
    expect(rejected).toMatchObject({ status: 401 });
    expect(rest.length).toBeGreaterThan(0);
    for (const call of rest) {
      expect(call.status).toBe(200);
      expect(call.token).not.toBe(rejected!.token);
      expect(call.token).toBe(provider.accessTokens.at(-1));
    }
  });

  it("refreshes exactly once and retries a sync page after a 401", async () => {
    const { connectionId } = await seed();
    expect((await runJob(connectionId)).status).toBe("succeeded");
    const before = provider.refreshRequests;
    apiCalls.length = 0;
    rejectNext.syncQuery = 1;
    expect((await runJob(connectionId)).status).toBe("succeeded");
    expect(provider.refreshRequests - before).toBe(1);
    const statuses = apiCalls.map((call) => call.status);
    // sites, property probe, rejected page, retried page
    expect(statuses).toEqual([200, 200, 401, 200]);
    expect(apiCalls[2]!.token).toBe(apiCalls[0]!.token);
    expect(apiCalls[3]!.token).not.toBe(apiCalls[2]!.token);
    expect(apiCalls[3]!.token).toBe(provider.accessTokens.at(-1));
  });

  it("does not sync a connection whose setup is pending", async () => {
    const { connectionId } = await seed({ expired: true, setupPending: true });
    await withWorkspace(appDb, { workspaceId }, (tx) =>
      tx
        .update(schema.connectionState)
        .set({ nextDueAt: null })
        .where(eq(schema.connectionState.connectionId, connectionId)),
    );
    const tick = await runSchedulerTick(schedulerDb, new Date());
    expect(tick.ran).toBe(true);
    const [queued] = await schedulerRaw<{ count: number }[]>`
      select count(*)::int as count from jobs
      where connection_id = ${connectionId}::uuid`;
    expect(queued!.count).toBe(0);

    // A job that reaches it anyway does nothing: no token, no Google call.
    apiCalls.length = 0;
    received.length = 0;
    const before = provider.refreshRequests;
    expect((await runJob(connectionId)).status).toBe("succeeded");
    expect(apiCalls).toEqual([]);
    expect(received).toEqual([]);
    expect(provider.refreshRequests).toBe(before);
    expect(await runCount(connectionId)).toBe(0);
    expect(await clicksOf(connectionId)).toEqual([]);
  });

  it("keeps token material out of logs", () => {
    const secrets = [TEST_CLIENT_SECRET, ...provider.accessTokens];
    const haystack = logs.join("\n");
    for (const secret of secrets) {
      expect(haystack).not.toContain(secret);
    }
  });
});
