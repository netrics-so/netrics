import { randomBytes, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20_000 });

import {
  connectionResponseSchema,
  dashboardResponseSchema,
  dashboardTemplateOptionsResponseSchema,
  deviceDashboardV3ResponseSchema,
  workspaceListResponseSchema,
  type Dashboard,
  type DeviceDashboardV3Response,
} from "@netrics/contracts";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import type { Connector, ConnectorRuntime } from "@netrics/connector-sdk";
import {
  createAppleAdsConnector,
  createDemoConnector,
} from "@netrics/connectors";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { createDefaultRegistry } from "./connectors.js";
import { createCredentialKeyring } from "./credentials.js";
import { createDeviceService } from "./devices/service.js";
import { loadConfig } from "./env.js";
import { createJobHandlers } from "./jobs/handlers.js";
import { capturingLogger } from "./oauth/test-provider.js";
import { SignedKeyProviders } from "./signed-keys/registry.js";
import {
  apiUserCredentials,
  createFakeAppleAdsServer,
  fakeApiUserKey,
  type FakeAdAccount,
  type FakeReportEntry,
} from "./signed-keys/test-apple-ads.js";
import { p256KeyPair } from "./signed-keys/test-keys.js";
import { syncCatalog } from "./sync/catalog.js";
import { createTestDatabase } from "./test-db.js";

// #377 end to end, on fixture data: a real Apple Ads connection (the real
// connector and provider against the offline fake of Apple's API) syncs a
// week of campaign × country rows; the Overview template then has an
// Apple Ads slide that the API accepts without a readability warning in
// any format (what the Studio, the web TV mode and the kiosk lay out), and
// whose device payload (what tvOS and the kiosk decode) carries the
// numbers. A server without the preview connector (production) offers no
// Apple Ads slide, even with an Apple Ads connection in its database.

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const KEYRING = createCredentialKeyring(ENCRYPTION_KEY);

const APP_ID = "1000000001";
const CAMPAIGNS = [
  { id: "5100000001", name: "Wurfel – Brand", appId: APP_ID },
  { id: "5100000002", name: "Wurfel – Discovery", appId: APP_ID },
  { id: "5100000003", name: "Wurfel – Competitors", appId: APP_ID },
];
const DAYS = ["2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"];
const COUNTRIES = ["US", "DE", "GB"];

/** Spend 10.50 USD per campaign, country and day; 4 tap and 1 view installs. */
const REPORT: FakeReportEntry[] = CAMPAIGNS.flatMap((campaign, index) =>
  DAYS.flatMap((date) =>
    COUNTRIES.map((country) => ({
      campaignId: campaign.id,
      appId: APP_ID,
      date,
      country,
      spend: (10.5 * (index + 1)).toFixed(2),
      impressions: 400,
      taps: 20,
      tapInstalls: 4,
      viewInstalls: 1,
    })),
  ),
);

const ACCOUNT: FakeAdAccount = {
  id: "4100000001",
  name: "Example Apps US",
  orgId: "4000000001",
  currency: "USD",
  timezone: "America/Los_Angeles",
  productFeatures: ["APPSTORE_APP_MANUAL"],
  campaigns: CAMPAIGNS,
  report: REPORT,
};

const USER = fakeApiUserKey(p256KeyPair(), {
  [ACCOUNT.id]: ["API Account Read Only"],
});
const apple = createFakeAppleAdsServer([ACCOUNT], [USER]);

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
  registry.register(towardsFake(createAppleAdsConnector({ now: () => NOW })));
  return registry;
}

const signedKeys = new SignedKeyProviders({
  http: () => (url, init) => apple.fetch(url, init),
});

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
let app: FastifyInstance;
let db: Database;
let admin: Sql;
let cookie: string;
let workspaceId: string;
let connectionId: string;
const logs: string[] = [];

function configFor() {
  return loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "silent",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
    APP_ENCRYPTION_KEY: ENCRYPTION_KEY,
  });
}

async function appWith(connectors: ConnectorRegistry) {
  const config = configFor();
  return buildApp(config, {
    db,
    authService: createAuthService(config, db, {
      logger: pino({ level: "silent" }),
    }),
    registry: connectors,
    signedKeys,
    checkDb: async () => true,
    logger: capturingLogger(logs),
  });
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  const owner = createDatabase(testDb.adminUrl, { max: 1 });
  await syncCatalog(owner, registry());
  await owner.$client.end({ timeout: 5 });
  db = createDatabase(testDb.appUrl);
  app = await appWith(registry());
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });

  const signUp = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: {
      name: "Owner",
      email: "apple-ads-templates@example.com",
      password: "password-12345",
    },
  });
  expect(signUp.statusCode).toBe(200);
  const header = signUp.headers["set-cookie"];
  cookie = (Array.isArray(header) ? header : [header])
    .find((value) => value?.startsWith("better-auth.session_token="))!
    .split(";")[0]!;
  await app.inject({
    method: "POST",
    url: "/v1/bootstrap",
    headers: { cookie },
    payload: { workspaceName: "Ads" },
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

  const created = await call(app, "POST", "/connections", {
    connectorId: "apple-ads",
    name: ACCOUNT.name,
    config: {
      adAccountId: ACCOUNT.id,
      adAccountName: ACCOUNT.name,
      currency: ACCOUNT.currency,
      timeZone: ACCOUNT.timezone,
    },
    credentials: apiUserCredentials(USER),
  });
  expect(created.statusCode, created.body).toBe(200);
  connectionId = connectionResponseSchema.parse(created.json()).connection.id;
  // The backfill a new connection queues, as the worker would run it:
  // its first page reads the newest months, where the fixture's days are.
  await createJobHandlers({
    registry: registry(),
    credentialKeyring: KEYRING,
    signedKeys,
    now: () => new Date(NOW),
  })["connection.backfill"]!({
    job: {
      id: randomUUID(),
      kind: "connection.backfill",
      workspaceId,
      connectionId,
      payload: {},
      runAt: new Date(),
      attempts: 0,
      maxAttempts: 8,
      status: "running",
      lockedBy: "test",
      lockedAt: new Date(),
      lastError: null,
      idempotencyKey: null,
      createdAt: new Date(),
    },
    appDb: db,
    schedulerDb: db,
    logger: capturingLogger(logs),
  });
  // Done: no backfill is queued any more.
  await admin`delete from jobs where connection_id = ${connectionId}`;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin?.end({ timeout: 5 }).catch(() => undefined);
});

function call(
  server: FastifyInstance,
  method: "GET" | "POST",
  path: string,
  payload?: Record<string, unknown>,
) {
  return server.inject({
    method,
    url: `/v1/workspaces/${workspaceId}${path}`,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });
}

async function overview(server: FastifyInstance): Promise<Dashboard> {
  const response = await call(server, "POST", "/dashboard-templates", {
    template: "overview",
  });
  expect(response.statusCode, response.body).toBe(200);
  return dashboardResponseSchema.parse(response.json()).dashboard;
}

describe("Apple Ads in the Overview template (#377)", () => {
  let dashboard: Dashboard;

  it("offers the Apple Ads connection to the Overview, not to Brand", async () => {
    const response = await call(app, "GET", "/dashboard-templates");
    expect(response.statusCode, response.body).toBe(200);
    const options = dashboardTemplateOptionsResponseSchema.parse(
      response.json(),
    );
    expect(options.overview.sources).toContainEqual({
      connectionId,
      connectionName: ACCOUNT.name,
      connectorId: "apple-ads",
    });
    expect(
      options.brand.resources.some(
        (resource) => resource.connectorId === "apple-ads",
      ),
    ).toBe(false);
  });

  it("creates an Apple Ads slide the API accepts with no readability warning in any format", async () => {
    dashboard = await overview(app);
    const slide = dashboard.slides.find((s) => s.name === "Apple Ads")!;
    expect(slide).toBeDefined();
    expect(
      slide.widgets.map((widget) => [widget.type, widget.title ?? null]),
    ).toEqual([
      ["metric", "Ad spend, 30 days · USD"],
      ["metric", "Ad installs, 30 days"],
      ["compare", "Cost per install, 30 days"],
      ["table", "Top campaigns"],
      ["bar", "Spend by country"],
      ["bar", "Installs: tap or view"],
      ["text", null],
    ]);
    const note = slide.widgets.at(-1)!;
    expect(note.type === "text" && note.text).toBe(
      "Days in America/Los_Angeles, as in Apple Ads.",
    );
    // Every format (16:9, 21:9, 4:3, portrait, phone), auto reflow:
    // continuation pages at most, nothing cut.
    expect(
      slide.formatWarnings.filter(
        (warning) => warning.severity === "attention",
      ),
    ).toEqual([]);
    expect(
      slide.formatWarnings.every((warning) => warning.code === "continues"),
    ).toBe(true);
  });

  it("puts the numbers in the device payload that tvOS and the kiosk show", async () => {
    const [row] = await admin`
      insert into devices (workspace_id, name, dashboard_id)
      values (${workspaceId}, 'TV', ${dashboard.id})
      returning id`;
    const devices = createDeviceService({
      db,
      pairingUrl: "http://localhost:3000/devices/approve",
      now: () => new Date(NOW),
    });
    const result = await devices.dashboard(
      { workspaceId, deviceId: row!.id as string },
      undefined,
      3,
    );
    if (!result.ok) throw new Error(result.error);
    const payload = result.value as DeviceDashboardV3Response;
    expect(deviceDashboardV3ResponseSchema.parse(payload)).toEqual(payload);

    const slide = payload.slides.find((s) => s.name === "Apple Ads")!;
    const [spend, installs, cpi, table, countries, attribution, note] =
      slide.widgets;
    const total = (index: number) => 3 * 4 * 1050 * (index + 1);
    const spent = total(0) + total(1) + total(2);
    expect(spend).toMatchObject({
      type: "metric",
      label: "Ad spend, 30 days · USD",
      data: { status: "ok", value: spent, unit: "USD_minor" },
    });
    // The total: tap plus view, 3 campaigns × 3 countries × 4 days × 5.
    expect(installs).toMatchObject({
      type: "metric",
      data: { status: "ok", value: 180 },
    });
    expect(cpi).toMatchObject({
      type: "compare",
      options: { format: "ratio", ratioLabel: "per install" },
      data: {
        status: "ok",
        unit: "USD_minor",
        numerator: { value: spent },
        denominator: { value: 180 },
      },
    });
    expect(cpi!.type === "compare" && cpi!.data.ratio.value).toBeCloseTo(
      spent / 180,
    );
    expect(table).toMatchObject({ type: "table", data: { status: "ok" } });
    expect(
      table!.type === "table" &&
        table!.data.rows.map((r) => [r.label, r.value]),
    ).toEqual([
      ["Wurfel – Competitors", total(2)],
      ["Wurfel – Discovery", total(1)],
      ["Wurfel – Brand", total(0)],
    ]);
    expect(
      countries!.type === "bar" && countries!.data.bars.map((b) => b.label),
    ).toEqual(expect.arrayContaining(["United States", "Germany"]));
    expect(
      attribution!.type === "bar" &&
        attribution!.data.bars.map((b) => [b.label, b.value]),
    ).toEqual([
      ["Tap-through", 144],
      ["View-through", 36],
    ]);
    expect(note).toMatchObject({
      type: "text",
      text: "Days in America/Los_Angeles, as in Apple Ads.",
    });
    // Every data widget carries its freshness (ADR 0018 section 5).
    for (const widget of slide.widgets) {
      if ("data" in widget && "updatedAt" in widget.data) {
        expect(widget.data.updatedAt).not.toBeNull();
      }
    }
  });

  it("offers no Apple Ads slide on a server without the preview connector (production)", async () => {
    const production = await appWith(
      createDefaultRegistry({ nodeEnv: "production" }),
    );
    try {
      const response = await call(production, "GET", "/dashboard-templates");
      expect(response.statusCode, response.body).toBe(200);
      const options = dashboardTemplateOptionsResponseSchema.parse(
        response.json(),
      );
      expect(
        options.overview.sources.map((source) => source.connectorId),
      ).not.toContain("apple-ads");
      const built = await call(production, "POST", "/dashboard-templates", {
        template: "overview",
      });
      // The Apple Ads connection is all the workspace has: to this server
      // nothing the templates know is connected.
      expect(built.statusCode, built.body).toBe(409);
      expect(built.json()).toEqual({ error: "none_connected" });
      expect(built.body).not.toContain("apple_ads");
      // Beside a connection it knows, the Overview has no Apple Ads in it.
      await admin`
        insert into connections (workspace_id, connector_id, name)
        values (${workspaceId}, 'demo', 'Demo')`;
      const withDemo = await call(production, "POST", "/dashboard-templates", {
        template: "overview",
      });
      expect(withDemo.statusCode, withDemo.body).toBe(200);
      const { dashboard: other } = dashboardResponseSchema.parse(
        withDemo.json(),
      );
      expect(other.slides.map((slide) => slide.name)).toEqual(["Web"]);
      expect(withDemo.body).not.toContain("apple_ads");
      expect(withDemo.body).not.toContain("Apple Ads");
    } finally {
      await production.close();
    }
  });
});
