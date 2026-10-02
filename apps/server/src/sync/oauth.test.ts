import { randomBytes } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20_000 });

import type {
  ConnectionContext,
  Connector,
  ConnectorManifest,
  ConnectorRuntime,
} from "@netrics/connector-sdk";
import {
  createDatabase,
  createRawSqlClient,
  createWorkspace,
  enqueueJob,
  resetConnectionAuth,
  schema,
  upsertConnectionOAuth,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";

import { createDefaultRegistry } from "../connectors.js";
import { createCredentialKeyring } from "../credentials.js";
import { createJobHandlers } from "../jobs/handlers.js";
import {
  capturingLogger,
  seedOAuthConnection,
  startTestOAuthProvider,
  TEST_CLIENT_SECRET,
  TEST_PROVIDER_EGRESS,
  TEST_PROVIDER_ID,
  testOAuthProviders,
  type TestOAuthProvider,
} from "../oauth/test-provider.js";
import {
  createOAuthTokenService,
  sealOAuthCredentials,
} from "../oauth/tokens.js";
import { runSchedulerTick } from "../scheduler.js";
import { createTestDatabase, type TestDatabase } from "../test-db.js";
import { createWorker, type WorkerHandle } from "../worker.js";
import { syncCatalog } from "./catalog.js";

// ADR 0012 in the sync engine, #133: an oauth2 connector receives only
// { accessToken }, a provider 401 refreshes once and retries, invalid_grant
// and scope_missing end in needs_reauthorization (which the scheduler skips
// until a reauthorization), and no token material reaches logs, sync runs
// or job errors.

const KEYRING = createCredentialKeyring(randomBytes(32).toString("base64"));
const SCOPE = "https://example.test/auth/readonly";

let provider: TestOAuthProvider;
/** How many sync calls of oauth-named-rejection throw before working. */
let rejectByName = 0;
/** Credentials every connector call received, in order. */
const received: Array<Record<string, unknown>> = [];

async function callApi(
  context: ConnectionContext,
  runtime: ConnectorRuntime,
): Promise<number> {
  received.push({ ...context.credentials });
  const response = await runtime.fetch(`${provider.origin}/api/resource`, {
    headers: {
      authorization: `Bearer ${String(context.credentials.accessToken)}`,
    },
  });
  return response.status;
}

function manifest(id: string, scopes: string[]): ConnectorManifest {
  return {
    id,
    version: "0.1.0",
    sdkVersion: "^0.2.1",
    name: id,
    description: `OAuth fixture connector ${id}.`,
    authStrategies: [
      { strategy: "oauth2", provider: TEST_PROVIDER_ID, scopes },
    ],
    configSchema: {},
    metrics: [
      {
        key: `${id}.hits`,
        name: "Hits",
        description: "Fixture hits.",
        kind: "delta",
        unit: "count",
        granularity: "day",
        dimensions: [],
        aggregations: ["sum"],
      },
    ],
    minRefreshIntervalSeconds: 300,
    supportsBackfill: true,
    backfillDays: 3,
    outboundDomains: ["127.0.0.1"],
  };
}

function oauthConnector(id: string, scopes: string[]): Connector {
  return {
    manifest: manifest(id, scopes),
    async check(context, runtime) {
      const status = await callApi(context, runtime);
      return status === 200
        ? { ok: true }
        : { ok: false, message: `provider answered ${status}` };
    },
    async discover() {
      return [];
    },
    async sync(context, request, runtime) {
      const status = await callApi(context, runtime);
      if (status !== 200) {
        throw new Error(
          `provider answered ${status} for token ${String(context.credentials.accessToken)}`,
        );
      }
      return {
        observations: [
          {
            metricKey: `${id}.hits`,
            sourceTimestamp: new Date(
              Date.parse(request.to) - (Date.parse(request.to) % 86_400_000),
            ).toISOString(),
            value: 1,
            dimensions: {},
          },
        ],
        done: true,
      };
    },
  };
}

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
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function seed(
  connectorId: string,
  options: { grantedScopes?: string[]; expired?: boolean } = {},
) {
  subCounter += 1;
  const sub = `engine-sub-${subCounter}`;
  const refreshToken = provider.grant({ sub, scopes: [SCOPE] });
  const connectionId = await seedOAuthConnection(appDb, KEYRING, {
    workspaceId,
    connectorId,
    refreshToken,
    sub,
    grantedScopes: options.grantedScopes ?? [SCOPE],
    ...(options.expired
      ? {
          accessToken: {
            value: `expired-at-${randomBytes(8).toString("hex")}`,
            expiresAt: new Date(Date.now() - 1000),
          },
        }
      : {}),
  });
  // Keep the scheduler away from it unless a test asks.
  await withWorkspace(appDb, { workspaceId }, (tx) =>
    tx
      .update(schema.connectionState)
      .set({ nextDueAt: new Date(Date.now() + 3600_000) })
      .where(eq(schema.connectionState.connectionId, connectionId)),
  );
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
  >`
    select status, last_error from jobs where id = ${jobId}`;
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

async function runsOf(connectionId: string) {
  return withWorkspace(appDb, { workspaceId }, (tx) =>
    tx.execute<{
      status: string;
      error_class: string | null;
      error_message: string | null;
    }>(
      sql`select status, error_class, error_message from sync_runs
          where connection_id = ${connectionId}::uuid order by started_at, id`,
    ),
  );
}

beforeAll(async () => {
  provider = await startTestOAuthProvider();
  testDb = await createTestDatabase();
  appDb = createDatabase(testDb.appUrl);
  schedulerDb = createDatabase(schedulerUrlOf(testDb));
  schedulerRaw = createRawSqlClient(schedulerUrlOf(testDb), { max: 2 });

  const registry = createDefaultRegistry();
  registry.register(oauthConnector("oauth-fixture", [SCOPE]));
  registry.register({
    ...oauthConnector("oauth-leaky", [SCOPE]),
    async sync(context) {
      throw new Error(
        `provider rejected ${String(context.credentials.accessToken)}`,
      );
    },
  });
  // Signals a refused token by name only, without a 401 on runtime.fetch
  // (the Search Console connector's convention, #134).
  registry.register({
    ...oauthConnector("oauth-named-rejection", [SCOPE]),
    async sync(context, request, runtime) {
      received.push({ ...context.credentials });
      if (rejectByName > 0) {
        rejectByName -= 1;
        const error = new Error("Search Console answered 401");
        error.name = "AccessTokenRejectedError";
        throw error;
      }
      return oauthConnector("oauth-named-rejection", [SCOPE]).sync(
        context,
        request,
        runtime,
      );
    },
  });
  registry.register(
    oauthConnector("oauth-upgraded", [SCOPE, "https://example.test/auth/more"]),
  );
  const owner = createDatabase(testDb.adminUrl, { max: 1 });
  await syncCatalog(owner, registry);
  await owner.$client.end({ timeout: 5 });

  const [user] = await appDb
    .insert(schema.users)
    .values({ email: "oauth-engine@example.com", displayName: "Engine" })
    .returning({ id: schema.users.id });
  workspaceId = await createWorkspace(appDb, {
    name: "OAuth engine",
    ownerUserId: user!.id,
  });

  const logger = capturingLogger(logs);
  const egress = TEST_PROVIDER_EGRESS;
  worker = createWorker({
    schedulerDb,
    appDb,
    handlers: createJobHandlers({
      registry,
      credentialKeyring: KEYRING,
      oauthTokens: createOAuthTokenService({
        db: appDb,
        credentialKeyring: KEYRING,
        providers: testOAuthProviders(provider),
        logger,
        egress,
      }),
      executeOptions: { egress },
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
});

describe("oauth2 connectors in the sync engine", () => {
  it("hands the connector only { accessToken } and refreshes a stale token", async () => {
    const { connectionId } = await seed("oauth-fixture", { expired: true });
    received.length = 0;
    const before = provider.refreshRequests;
    expect((await runJob(connectionId)).status).toBe("succeeded");
    expect(provider.refreshRequests - before).toBe(1);
    expect(received.length).toBeGreaterThanOrEqual(2); // check + one page
    for (const credentials of received) {
      expect(Object.keys(credentials)).toEqual(["accessToken"]);
      expect(credentials.accessToken).toBe(provider.accessTokens.at(-1));
    }
    expect(await stateOf(connectionId)).toMatchObject({
      authState: "ok",
      authReason: null,
    });
  });

  it("refreshes once more after a provider 401 and retries the call", async () => {
    const { connectionId } = await seed("oauth-fixture");
    // Warm the cache with a valid token.
    expect((await runJob(connectionId)).status).toBe("succeeded");
    const before = provider.refreshRequests;
    received.length = 0;
    provider.rejectNextApiCalls = 1; // the cached token is refused once
    expect((await runJob(connectionId)).status).toBe("succeeded");
    expect(provider.refreshRequests - before).toBe(1);
    const [first, second] = received;
    expect(first!.accessToken).not.toBe(second!.accessToken);
  });

  it("refreshes once more when the connector throws AccessTokenRejectedError", async () => {
    const { connectionId } = await seed("oauth-named-rejection");
    expect((await runJob(connectionId)).status).toBe("succeeded");
    const before = provider.refreshRequests;
    rejectByName = 1;
    received.length = 0;
    expect((await runJob(connectionId)).status).toBe("succeeded");
    expect(provider.refreshRequests - before).toBe(1);
    // check, rejected sync page, retried sync page
    const tokens = received.map((credentials) => credentials.accessToken);
    expect(tokens).toHaveLength(4);
    expect(tokens[1]).toBe(tokens[0]);
    expect(tokens.at(-1)).not.toBe(tokens[1]);
  });

  it("ends in needs_reauthorization on invalid_grant; the scheduler skips it until reauthorization", async () => {
    const { connectionId, sub } = await seed("oauth-fixture", {
      expired: true,
    });
    provider.revokeAccount(sub);
    const job = await runJob(connectionId);
    expect(job.status).toBe("failed");
    expect(job.last_error).toBe(
      "oauth authorization needs to be renewed (invalid_grant)",
    );
    expect(await stateOf(connectionId)).toMatchObject({
      authState: "needs_reauthorization",
      authReason: "invalid_grant",
    });
    expect((await runsOf(connectionId)).at(-1)).toMatchObject({
      status: "failed",
      error_class: "auth",
    });

    // Due, but not planned.
    await withWorkspace(appDb, { workspaceId }, (tx) =>
      tx
        .update(schema.connectionState)
        .set({ nextDueAt: new Date(Date.now() - 1000) })
        .where(eq(schema.connectionState.connectionId, connectionId)),
    );
    const skipped = await runSchedulerTick(schedulerDb);
    expect(skipped.skippedNeedsReauthorization).toBeGreaterThanOrEqual(1);
    const pending = () =>
      schedulerRaw<{ count: number }[]>`
        select count(*)::int as count from jobs
        where connection_id = ${connectionId} and status = 'pending'`;
    expect((await pending())[0]!.count).toBe(0);

    // Reauthorization, as the callback stores it (#132): a new grant, the
    // refresh token, and the state back to ok.
    const refreshToken = provider.grant({ sub, scopes: [SCOPE] });
    await withWorkspace(appDb, { workspaceId }, async (tx) => {
      await upsertConnectionOAuth(tx, {
        workspaceId,
        connectionId,
        provider: TEST_PROVIDER_ID,
        accountSub: sub,
        accountEmail: `${sub}@example.com`,
        grantedScopes: [SCOPE],
        accessTokenEncrypted: null,
        accessTokenExpiresAt: null,
      });
      await tx
        .update(schema.connections)
        .set({
          credentialsEncrypted: sealOAuthCredentials(refreshToken, KEYRING, {
            workspaceId,
            connectionId,
          }),
        })
        .where(eq(schema.connections.id, connectionId));
      await resetConnectionAuth(tx, workspaceId, connectionId);
    });
    const planned = await runSchedulerTick(schedulerDb);
    expect(planned.enqueued).toBeGreaterThanOrEqual(1);
    await waitFor(
      async () => (await stateOf(connectionId)).lastSuccessAt !== null,
    );
    expect(await stateOf(connectionId)).toMatchObject({
      authState: "ok",
      authReason: null,
    });
  });

  it("ends in needs_reauthorization (scope_missing) when the connector needs more scopes", async () => {
    const { connectionId } = await seed("oauth-upgraded");
    received.length = 0;
    const job = await runJob(connectionId);
    expect(job.status).toBe("failed");
    expect(received).toHaveLength(0); // the connector never ran
    expect(await stateOf(connectionId)).toMatchObject({
      authState: "needs_reauthorization",
      authReason: "scope_missing",
    });
  });

  it("retries provider outages of the token endpoint as transient failures", async () => {
    const { connectionId } = await seed("oauth-fixture", { expired: true });
    provider.nextTokenErrors.push({
      status: 503,
      error: "temporarily_unavailable",
    });
    const jobId = await withWorkspace(appDb, { workspaceId }, (tx) =>
      enqueueJob(tx, { kind: "connection.sync", workspaceId, connectionId }),
    );
    await waitFor(async () => (await runsOf(connectionId)).length > 0);
    expect((await runsOf(connectionId))[0]).toMatchObject({
      status: "failed",
      error_class: "transient",
    });
    const [job] = await schedulerRaw<{ status: string }[]>`
      select status from jobs where id = ${jobId}`;
    expect(["pending", "running", "succeeded"]).toContain(job!.status);
    expect((await stateOf(connectionId)).authState).not.toBe(
      "needs_reauthorization",
    );
  });

  it("keeps token material out of logs, sync runs and job errors", async () => {
    // A refused check (401 twice) ends in auth_failed with the connector's
    // message.
    const refused = await seed("oauth-fixture");
    provider.rejectNextApiCalls = 2;
    expect((await runJob(refused.connectionId)).status).toBe("failed");
    expect(await stateOf(refused.connectionId)).toMatchObject({
      authState: "auth_failed",
    });
    // A connector error quoting its token is redacted at the boundary.
    const leaky = await seed("oauth-leaky");
    await withWorkspace(appDb, { workspaceId }, (tx) =>
      enqueueJob(tx, {
        kind: "connection.sync",
        workspaceId,
        connectionId: leaky.connectionId,
      }),
    );
    await waitFor(async () => (await runsOf(leaky.connectionId)).length > 0);
    expect((await runsOf(leaky.connectionId))[0]!.error_message).toContain(
      "provider rejected [redacted]",
    );

    const secrets = [
      TEST_CLIENT_SECRET,
      ...provider.accessTokens,
      ...provider.revocations,
    ];
    const runs = await withWorkspace(appDb, { workspaceId }, (tx) =>
      tx.execute<{ error_message: string | null }>(
        sql`select error_message from sync_runs`,
      ),
    );
    const jobErrors = await schedulerRaw<{ last_error: string | null }[]>`
      select last_error from jobs`;
    const haystack = [
      logs.join("\n"),
      ...runs.map((row) => row.error_message ?? ""),
      ...jobErrors.map((row) => row.last_error ?? ""),
    ].join("\n");
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of secrets) {
      expect(haystack).not.toContain(secret);
    }
    expect(haystack).not.toMatch(/fixture-(rt|at)-/);
  });
});
