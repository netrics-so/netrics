import { randomBytes, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import pino from "pino";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";

import {
  connectionResponseSchema,
  metricBreakdownRequestSchema,
  workspaceListResponseSchema,
} from "@netrics/contracts";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import type { Connector, ConnectorRuntime } from "@netrics/connector-sdk";
import {
  APPLE_ADS_AD_GROUP_METRIC_KEYS,
  APPLE_ADS_METRIC_KEYS,
  createAppleAdsConnector,
  createDemoConnector,
} from "@netrics/connectors";
import {
  connectionHasResource,
  createDatabase,
  findDimensionValueNames,
  createRawSqlClient,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "../app.js";
import { createAuthService } from "../auth/index.js";
import { createCredentialKeyring } from "../credentials.js";
import { loadConfig } from "../env.js";
import { createJobHandlers } from "../jobs/handlers.js";
import {
  listResourcesOfMetric,
  queryMetricBreakdown,
} from "../metrics/query.js";
import { capturingLogger } from "../oauth/test-provider.js";
import { SignedKeyProviders } from "../signed-keys/registry.js";
import {
  apiUserCredentials,
  createFakeAppleAdsServer,
  fakeApiUserKey,
  type FakeAdAccount,
  type FakeReportEntry,
} from "../signed-keys/test-apple-ads.js";
import { p256KeyPair } from "../signed-keys/test-keys.js";
import { createTestDatabase } from "../test-db.js";
import { syncCatalog } from "./catalog.js";

vi.setConfig({ testTimeout: 30_000 });

// The Apple Ads campaign report sync (#374) in the sync engine, offline:
// the real provider (token exchange) and connector against a fake of
// Apple's token endpoint and Platform API, on a pinned clock. A backfill
// meets a 429 in the middle and resumes from its checkpoint; the next
// incremental sync re-reads the lookback and updates a revised day; the
// query layer labels campaigns by name and keeps them out of a tile's
// resource choices.

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
const KEYRING = createCredentialKeyring(ENCRYPTION_KEY);

/**
 * 2026-10-29 03:00 UTC: still the 28th in Los Angeles, the 29th in
 * Berlin. Every sync window comes from this clock, never the real one.
 */
const START = Date.parse("2026-10-29T03:00:00.000Z");
let clockMs = START;
const clock = () => clockMs;

const APP = "1000000001";
const BRAND = "5100000001";
/** A deleted campaign: in the report, no longer in discovery. */
const OLD = "5100000009";
const DE_BRAND = "5200000001";

function entry(
  campaignId: string,
  date: string,
  country: string,
  spend: string,
): FakeReportEntry {
  return {
    campaignId,
    appId: APP,
    date,
    country,
    spend,
    impressions: 1000,
    taps: 50,
    tapInstalls: 10,
    viewInstalls: 2,
  };
}

const US: FakeAdAccount = {
  id: "4100000001",
  name: "Example Apps US",
  orgId: "4000000001",
  currency: "USD",
  timezone: "America/Los_Angeles",
  productFeatures: ["APPSTORE_APP_MANUAL"],
  campaigns: [{ id: BRAND, name: "Wurfel – Brand", appId: APP }],
  report: [
    entry(BRAND, "2026-10-27", "US", "20.00"),
    entry(BRAND, "2026-10-27", "CA", "5.00"),
    entry(BRAND, "2026-06-15", "US", "7.50"),
    entry(OLD, "2026-01-10", "DE", "3.00"),
  ],
};
const EU: FakeAdAccount = {
  id: "4100000002",
  name: "Example Apps EU",
  orgId: "4000000001",
  currency: "EUR",
  timezone: "Europe/Berlin",
  productFeatures: ["APPSTORE_APP_MANUAL"],
  campaigns: [{ id: DE_BRAND, name: "Wurfel – DE Brand", appId: APP }],
  report: [entry(DE_BRAND, "2026-10-27", "DE", "9.00")],
};

const USER = fakeApiUserKey(p256KeyPair(), {
  [US.id]: ["API Account Read Only"],
  [EU.id]: ["API Account Read Only"],
});
const apple = createFakeAppleAdsServer([US, EU], [USER]);

function towardsFake(connector: Connector): Connector {
  const rewrite = (runtime: ConnectorRuntime): ConnectorRuntime => ({
    signal: runtime.signal,
    fetch: (url, init) => apple.fetch(url, init),
  });
  return {
    manifest: connector.manifest,
    check: (context, runtime) => connector.check(context, rewrite(runtime)),
    discover: (context, runtime) =>
      connector.discover(context, rewrite(runtime)),
    sync: (context, request, runtime) =>
      connector.sync(context, request, rewrite(runtime)),
  };
}

function registry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(createDemoConnector());
  registry.register(
    towardsFake(
      createAppleAdsConnector({ now: clock, sleep: async () => undefined }),
    ),
  );
  return registry;
}

const signedKeys = new SignedKeyProviders({
  http: () => (url, init) => apple.fetch(url, init),
});

let app: FastifyInstance;
let db: Database;
let admin: Sql;
let cookie: string;
let workspaceId: string;
const connections: Record<string, string> = {};

beforeAll(async () => {
  const testDb = await createTestDatabase();
  const owner = createDatabase(testDb.adminUrl, { max: 1 });
  await syncCatalog(owner, registry());
  await owner.$client.end({ timeout: 5 });
  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
    APP_ENCRYPTION_KEY: ENCRYPTION_KEY,
  });
  db = createDatabase(testDb.appUrl);
  app = await buildApp(config, {
    db,
    authService: createAuthService(config, db, {
      logger: pino({ level: "silent" }),
    }),
    registry: registry(),
    signedKeys,
    checkDb: async () => true,
    logger: capturingLogger([]),
  });
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });

  const signUp = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: {
      name: "Owner",
      email: "apple-ads-sync@example.com",
      password: "password-12345",
    },
  });
  const header = signUp.headers["set-cookie"];
  cookie = (Array.isArray(header) ? header : [header])
    .find((value) => value?.startsWith("better-auth.session_token="))!
    .split(";")[0]!;
  await app.inject({
    method: "POST",
    url: "/v1/bootstrap",
    headers: { cookie },
    payload: { workspaceName: "Apple Ads sync" },
  });
  workspaceId = workspaceListResponseSchema.parse(
    (
      await app.inject({
        method: "GET",
        url: "/v1/workspaces",
        headers: { cookie },
      })
    ).json(),
  ).workspaces[0]!.id;

  for (const account of [US, EU]) {
    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/connections`,
      headers: { cookie },
      payload: {
        connectorId: "apple-ads",
        name: account.name,
        config: {
          adAccountId: account.id,
          currency: account.currency,
          timeZone: account.timezone,
        },
        credentials: apiUserCredentials(USER),
      },
    });
    expect(response.statusCode).toBe(200);
    connections[account.id] = connectionResponseSchema.parse(
      response.json(),
    ).connection.id;
  }
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin?.end({ timeout: 5 }).catch(() => undefined);
});

function job(
  kind: "connection.sync" | "connection.backfill",
  connectionId: string,
  id: string = randomUUID(),
  attempts = 0,
) {
  return {
    id,
    kind,
    workspaceId,
    connectionId,
    payload: {},
    runAt: new Date(clockMs),
    attempts,
    maxAttempts: 8,
    status: "running" as const,
    lockedBy: "test",
    lockedAt: new Date(clockMs),
    lastError: null,
    idempotencyKey: null,
    createdAt: new Date(clockMs),
  };
}

async function run(
  kind: "connection.sync" | "connection.backfill",
  connectionId: string,
  id?: string,
  attempts = 0,
) {
  const handlers = createJobHandlers({
    registry: registry(),
    credentialKeyring: KEYRING,
    signedKeys,
    now: () => new Date(clockMs),
  });
  return handlers[kind]!({
    job: job(kind, connectionId, id, attempts),
    appDb: db,
    schedulerDb: db,
    logger: capturingLogger([]),
  });
}

interface ReportCall {
  timeRange: { start: string; end: string };
  groupBy?: string[];
}

function reportCalls(): ReportCall[] {
  return apple.calls
    .filter((call) => call.path === "/v1/reports/apps/campaigns/query")
    .map((call) => {
      const body = call.body as ReportCall;
      return {
        ...body,
        timeRange: { start: body.timeRange.start, end: body.timeRange.end },
      };
    });
}

async function stored(connectionId: string) {
  return admin<
    Array<{
      key: string;
      day: string;
      value: number;
      dimensions: Record<string, string>;
    }>
  >`
    select m.key, to_char(o.source_timestamp at time zone 'UTC', 'YYYY-MM-DD') as day,
           o.value::float8 as value, o.dimensions
    from observations o
    join metric_definitions m on m.id = o.metric_definition_id
    where o.connection_id = ${connectionId}
  `;
}

function total(
  rows: Awaited<ReturnType<typeof stored>>,
  key: string,
  where: Record<string, string> = {},
): number {
  return rows
    .filter(
      (row) =>
        row.key === key &&
        Object.entries(where).every(([k, v]) => row.dimensions[k] === v),
    )
    .reduce((sum, row) => sum + row.value, 0);
}

describe("Apple Ads campaign report sync", () => {
  const backfillJob = randomUUID();

  it("backfills newest first; a 429 in the middle fails the run with a checkpoint", async () => {
    apple.calls.length = 0;
    // The second range (May to July) meets a long 429.
    apple.failures.push({
      status: 429,
      headers: { "retry-after": "120" },
      match: (call) =>
        call.path === "/v1/reports/apps/campaigns/query" &&
        (call.body as ReportCall).timeRange.end === "2026-07-31",
    });
    await expect(
      run("connection.backfill", connections[US.id]!, backfillJob),
    ).rejects.toThrow("429");
    const ranges = reportCalls().map((call) => call.timeRange);
    // Days of the ad account: the 28th in Los Angeles at 03:00 UTC.
    expect(ranges[0]).toEqual({ start: "2026-08-01", end: "2026-10-28" });
    const [state] = await admin<Array<{ cursor: string; auth_state: string }>>`
      select cursor, auth_state from connection_state
      where connection_id = ${connections[US.id]!}
    `;
    expect(state!.cursor).toBe("apple-ads:1:2025-10-29:2026-10-28:2026-07-31");
    expect(state!.auth_state).toBe("outage");
    // The first range is committed: October's spend is there.
    expect(
      total(await stored(connections[US.id]!), APPLE_ADS_METRIC_KEYS.spend),
    ).toBe(2500);
  });

  it("resumes the backfill from the checkpoint and stores every campaign × country row", async () => {
    apple.calls.length = 0;
    await run("connection.backfill", connections[US.id]!, backfillJob, 1);
    const ranges = reportCalls().map((call) => call.timeRange);
    // Not October again: the retry starts at the checkpoint.
    // June and July: with May the range would pass 90 days.
    expect(ranges[0]).toEqual({ start: "2026-06-01", end: "2026-07-31" });
    expect(ranges.at(-1)!.start).toBe("2025-10-29");
    for (const range of ranges) {
      const days =
        (Date.parse(range.end) - Date.parse(range.start)) / 86_400_000 + 1;
      expect(days).toBeLessThanOrEqual(90);
    }

    const rows = await stored(connections[US.id]!);
    // The unfiltered sum is the ad account's total: 20 + 5 + 7.50 + 3.
    expect(total(rows, APPLE_ADS_METRIC_KEYS.spend)).toBe(3550);
    expect(total(rows, APPLE_ADS_METRIC_KEYS.spend, { country: "CA" })).toBe(
      500,
    );
    // The deleted campaign keeps its history.
    expect(total(rows, APPLE_ADS_METRIC_KEYS.spend, { campaign: OLD })).toBe(
      300,
    );
    expect(
      total(rows, APPLE_ADS_METRIC_KEYS.installs, { attribution: "view" }),
    ).toBe(8);
    const main = new Set<string>(Object.values(APPLE_ADS_METRIC_KEYS));
    for (const row of rows) {
      expect(row.dimensions.campaign).toBeDefined();
      if (main.has(row.key)) {
        expect(row.dimensions.country).toBeDefined();
        expect(row.dimensions.ad_group).toBeUndefined();
      } else {
        // The ad-group rows (#376), in their own keys.
        expect(row.key).toMatch(/_by_ad_group$/);
        expect(row.dimensions.ad_group).toBeDefined();
        expect(row.dimensions.country).toBeUndefined();
      }
      if (
        row.key === APPLE_ADS_METRIC_KEYS.spend ||
        row.key === APPLE_ADS_AD_GROUP_METRIC_KEYS.spend
      ) {
        expect(row.dimensions.currency).toBe("USD");
      }
    }
    // By ad group, the same total, never added to the main keys.
    expect(total(rows, APPLE_ADS_AD_GROUP_METRIC_KEYS.spend)).toBe(3550);
    expect(
      total(rows, APPLE_ADS_AD_GROUP_METRIC_KEYS.spend, { campaign: OLD }),
    ).toBe(300);
    const [state] = await admin<Array<{ cursor: string; auth_state: string }>>`
      select cursor, auth_state from connection_state
      where connection_id = ${connections[US.id]!}
    `;
    // The next incremental sync re-reads the last 3 days.
    expect(state).toEqual({
      cursor: "2026-10-26T00:00:00.000Z",
      auth_state: "ok",
    });
  });

  it("re-reads the lookback incrementally: no duplicates, a revised day updated", async () => {
    const before = await stored(connections[US.id]!);
    clockMs = START + 24 * 60 * 60 * 1000;
    onTestFinished(() => {
      clockMs = START;
    });
    US.report![0]!.spend = "21.00";
    apple.calls.length = 0;
    await run("connection.sync", connections[US.id]!);
    const ranges = reportCalls().map((call) => call.timeRange);
    expect(ranges).toEqual([
      { start: "2026-10-01", end: "2026-10-29" },
      { start: "2026-10-01", end: "2026-10-29" },
    ]);
    const after = await stored(connections[US.id]!);
    // The same identities; only the 26th, settled now, gains its zeros.
    const besides26 = (rows: typeof before) =>
      rows.filter((row) => row.day !== "2026-10-26");
    expect(besides26(after)).toHaveLength(besides26(before).length);
    expect(
      after
        .filter((row) => row.day === "2026-10-26")
        .every((row) => row.value === 0),
    ).toBe(true);
    expect(
      total(after, APPLE_ADS_METRIC_KEYS.spend, {
        campaign: BRAND,
        country: "US",
      }),
    ).toBe(2100 + 750);
    expect(total(after, APPLE_ADS_METRIC_KEYS.spend)).toBe(3650);
  });

  it("keeps a second ad account's currency and days apart", async () => {
    apple.calls.length = 0;
    await run("connection.backfill", connections[EU.id]!);
    // Berlin is already on the 29th.
    expect(reportCalls()[0]!.timeRange.end).toBe("2026-10-29");
    const rows = await stored(connections[EU.id]!);
    expect(total(rows, APPLE_ADS_METRIC_KEYS.spend)).toBe(900);
    expect(
      new Set(
        rows
          .filter((row) => row.key === APPLE_ADS_METRIC_KEYS.spend)
          .map((row) => row.dimensions.currency),
      ),
    ).toEqual(new Set(["EUR"]));
    for (const call of apple.calls) {
      if (call.path !== "/v1/acls") {
        expect(call.context).toBe(`adAccountId=${EU.id}`);
      }
    }
  });

  it("labels a breakdown by campaign with the campaign names, and offers no campaign as a tile's resource", async () => {
    const connectionId = connections[US.id]!;
    const now = new Date(clockMs);
    const breakdown = await withWorkspace(db, { workspaceId }, (tx) =>
      queryMetricBreakdown(
        tx,
        workspaceId,
        metricBreakdownRequestSchema.parse({
          connectionId,
          metricKey: APPLE_ADS_METRIC_KEYS.spend,
          period: "last_12_months",
          groupBy: "campaign",
          dimensions: { currency: "USD" },
        }),
        now,
      ),
    );
    if (!breakdown.ok) throw new Error(breakdown.error);
    expect(
      breakdown.value.groups.map(({ key, label, value }) => [
        key,
        label,
        value,
      ]),
    ).toEqual([
      [BRAND, "Wurfel – Brand", 3350],
      // Deleted before netrics discovered it: its ID.
      [OLD, OLD, 300],
    ]);
    expect(breakdown.value.groupByName).toBe("Campaign");

    const resources = await withWorkspace(db, { workspaceId }, (tx) =>
      listResourcesOfMetric(tx, workspaceId, {
        connectionId,
        metricKey: APPLE_ADS_METRIC_KEYS.spend,
      }),
    );
    if (!resources.ok) throw new Error(resources.error);
    expect(resources.value.resources.map((r) => r.id)).toEqual([APP]);
    const [campaignIsResource, appIsResource] = await withWorkspace(
      db,
      { workspaceId },
      async (tx) => [
        await connectionHasResource(tx, workspaceId, connectionId, BRAND),
        await connectionHasResource(tx, workspaceId, connectionId, APP),
      ],
    );
    expect(campaignIsResource).toBe(false);
    expect(appIsResource).toBe(true);

    // Campaign names stay in their workspace: RLS and the predicate.
    const query = {
      workspaceId,
      connectionId,
      dimension: "campaign",
      values: [BRAND],
    };
    const own = await withWorkspace(db, { workspaceId }, (tx) =>
      findDimensionValueNames(tx, query),
    );
    expect([...own]).toEqual([[BRAND, "Wurfel – Brand"]]);
    const other = randomUUID();
    const underOther = await withWorkspace(db, { workspaceId: other }, (tx) =>
      findDimensionValueNames(tx, query),
    );
    expect(underOther.size).toBe(0);
    const otherPredicate = await withWorkspace(db, { workspaceId }, (tx) =>
      findDimensionValueNames(tx, { ...query, workspaceId: other }),
    );
    expect(otherPredicate.size).toBe(0);
  });
});
