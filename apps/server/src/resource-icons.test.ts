import { randomBytes, randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";

import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20_000 });

import {
  connectionResponseSchema,
  dashboardResponseSchema,
  dashboardTemplateOptionsResponseSchema,
  errorResponseSchema,
  imageResponseSchema,
  resourceIconListResponseSchema,
  workspaceResponseSchema,
  type Dashboard,
} from "@netrics/contracts";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import type {
  Connector,
  ConnectorFetchInit,
  ConnectorResponse,
  ConnectorRuntime,
} from "@netrics/connector-sdk";
import {
  createAppStoreConnectConnector,
  createDemoConnector,
} from "@netrics/connectors";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";
import { BUILTIN_THEMES, slideLayoutProblem } from "@netrics/domain";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { createCredentialKeyring } from "./credentials.js";
import { loadConfig } from "./env.js";
import { createJobHandlers } from "./jobs/handlers.js";
import { capturingLogger } from "./oauth/test-provider.js";
import { SignedKeyProviders } from "./signed-keys/registry.js";
import {
  createFakeAsc,
  type FakeAscTeam,
} from "./signed-keys/test-app-store-connect.js";
import { p256KeyPair } from "./signed-keys/test-keys.js";
import { syncCatalog } from "./sync/catalog.js";
import { addMemberViaInvitation } from "./test-helpers.js";
import { createTestDatabase } from "./test-db.js";

// App icons as workspace images and the dashboard templates (#226), end
// to end: a real App Store Connect connection (signed key, in-memory App
// Store Connect), the real connector, and an in-memory App Store lookup
// and image CDN behind its runtime.fetch.

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
const KEYRING = createCredentialKeyring(ENCRYPTION_KEY);
// 13:00 PDT on Oct 1: Sept 30 is the latest published reporting day.
const NOW = Date.parse("2026-10-01T20:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const WURFEL = "6767935139";
const PAPERSTAND = "6788250340";
const UNRELEASED = "6700000001";
/** Sold in Japan only, and only the Japanese storefront lists it. */
const KUBIK = "6700000002";

const REPORT = [
  [
    "Provider",
    "SKU",
    "Title",
    "Product Type Identifier",
    "Units",
    "Developer Proceeds",
    "Country Code",
    "Currency of Proceeds",
    "Apple Identifier",
    "Parent Identifier",
    "Device",
  ],
  [
    "APPLE",
    "WURFEL",
    "Wurfel",
    "1F",
    "12",
    "0",
    "DE",
    "EUR",
    WURFEL,
    "",
    "iPhone",
  ],
  [
    "APPLE",
    "WURFEL",
    "Wurfel",
    "1F",
    "5",
    "0",
    "US",
    "USD",
    WURFEL,
    "",
    "iPad",
  ],
  ["APPLE", "KUBIK", "Kubik", "1F", "3", "0", "JP", "JPY", KUBIK, "", "iPhone"],
]
  .map((row) => row.join("\t"))
  .join("\n");

const TEAM: FakeAscTeam = {
  issuerId: "57246542-96fe-1a63-e053-0824d011072a",
  keyId: "2X9R4HXF34",
  key: p256KeyPair(),
  apps: [
    { id: WURFEL, name: "Wurfel – Cube Solver", bundleId: "app.wurfel" },
    { id: PAPERSTAND, name: "Paperstand", bundleId: "paperstand.app" },
    { id: UNRELEASED, name: "Secret Project", bundleId: "app.secret" },
    { id: KUBIK, name: "Kubik", bundleId: "app.kubik" },
  ],
  vendorNumbers: ["85012345"],
  reports: { "2026-09-30": REPORT },
};
const asc = createFakeAsc([TEAM]);

function pngChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])));
  return Buffer.concat([header, data, crc]);
}

/** A 4 × 4 PNG of one colour, with a tEXt chunk that must not survive. */
function iconPng(rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(4, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.from([0, ...Array.from({ length: 4 }, () => rgb).flat()]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("tEXt", Buffer.from("Comment\0private build machine", "latin1")),
    pngChunk("IDAT", deflateSync(Buffer.concat([row, row, row, row]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The in-memory App Store lookup and CDN (mutable per test). */
const apple = {
  listed: new Set([WURFEL, PAPERSTAND]),
  /** Apps listed in one storefront only. */
  listedIn: new Map([[KUBIK, "jp"]]),
  failing: false,
  icons: new Map<string, Buffer>([
    [WURFEL, iconPng([20, 110, 230])],
    [PAPERSTAND, iconPng([230, 80, 30])],
    [KUBIK, iconPng([40, 200, 120])],
  ]),
  requests: [] as Array<{ url: URL; init: ConnectorFetchInit | undefined }>,
};

function answer(status: number, body: Buffer, type: string): ConnectorResponse {
  return {
    status,
    headers: { "content-type": type },
    text: () => body.toString("utf8"),
    json: () => JSON.parse(body.toString("utf8")) as unknown,
    bytes: () => new Uint8Array(body),
  };
}

async function appleFetch(
  raw: string,
  init?: ConnectorFetchInit,
): Promise<ConnectorResponse> {
  const url = new URL(raw);
  if (url.hostname === "itunes.apple.com") {
    apple.requests.push({ url, init });
    if (apple.failing) {
      return answer(503, Buffer.from("{}"), "application/json");
    }
    const ids = (url.searchParams.get("id") ?? "").split(",");
    const country = url.searchParams.get("country");
    const results = ids
      .filter((id) =>
        apple.listedIn.has(id)
          ? apple.listedIn.get(id) === country
          : apple.listed.has(id),
      )
      .map((id) => ({
        wrapperType: "software",
        kind: "software",
        trackId: Number(id),
        artworkUrl512: `https://is1-ssl.mzstatic.com/image/thumb/Purple/v4/${id}/AppIcon.png/512x512bb.jpg`,
      }));
    return answer(
      200,
      Buffer.from(JSON.stringify({ resultCount: results.length, results })),
      "text/javascript; charset=utf-8",
    );
  }
  if (url.hostname === "is1-ssl.mzstatic.com") {
    apple.requests.push({ url, init });
    const id = url.pathname.split("/")[5] ?? "";
    const icon = apple.icons.get(id);
    return icon && url.pathname.endsWith("/1024x1024bb.png")
      ? answer(200, icon, "image/png")
      : answer(404, Buffer.from(""), "text/plain");
  }
  return asc.fetch(raw, init);
}

/** The real connector; every request goes to the in-memory Apple. */
function towardsFake(connector: Connector): Connector {
  const rewrite = (runtime: ConnectorRuntime): ConnectorRuntime => ({
    signal: runtime.signal,
    fetch: appleFetch,
  });
  return {
    manifest: connector.manifest,
    check: (context, runtime) => connector.check(context, rewrite(runtime)),
    discover: (context, runtime) =>
      connector.discover(context, rewrite(runtime)),
    sync: (context, request, runtime) =>
      connector.sync(context, request, rewrite(runtime)),
    resourceIcons: (context, request, runtime) =>
      connector.resourceIcons!(context, request, rewrite(runtime)),
  };
}

function registry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(createDemoConnector());
  registry.register(
    towardsFake(
      createAppStoreConnectConnector({
        now: () => NOW,
        log: () => {},
        analytics: false,
      }),
    ),
  );
  return registry;
}

const signedKeys = new SignedKeyProviders({
  http: () => (url, init) => asc.fetch(url, init),
});

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

let app: FastifyInstance;
let db: Database;
let admin: Sql;
const logs: string[] = [];
let owner: string;
let viewer: string;
let stranger: string;
let workspaceId: string;
let otherWorkspaceId: string;
let emptyWorkspaceId: string;
let connectionId: string;

async function signUp(email: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { name: email, email, password: "password-12345" },
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers["set-cookie"];
  return (Array.isArray(header) ? header : [header])
    .find((value) => value?.startsWith("better-auth.session_token="))!
    .split(";")[0]!;
}

async function newWorkspace(cookie: string, name: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { cookie },
    payload: { name },
  });
  return workspaceResponseSchema.parse(response.json()).workspace.id;
}

function call(
  cookie: string,
  method: "GET" | "POST",
  path: string,
  payload?: Record<string, unknown>,
  workspace = workspaceId,
): Promise<InjectResponse> {
  return app.inject({
    method,
    url: `/v1/workspaces/${workspace}${path}`,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });
}

function expectError(response: InjectResponse, status: number, error: string) {
  expect(response.statusCode, response.body).toBe(status);
  expect(errorResponseSchema.parse(response.json()).error).toBe(error);
}

async function runSync(id: string) {
  const handlers = createJobHandlers({
    registry: registry(),
    credentialKeyring: KEYRING,
    signedKeys,
    now: () => new Date(NOW),
  });
  await handlers["connection.sync"]!({
    job: {
      id: randomUUID(),
      kind: "connection.sync",
      workspaceId,
      connectionId: id,
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
}

async function useIcon(resourceId: string, cookie = owner) {
  return call(cookie, "POST", "/resource-icons", { connectionId, resourceId });
}

beforeAll(async () => {
  const testDb = await createTestDatabase();
  const ownerDb = createDatabase(testDb.adminUrl, { max: 1 });
  await syncCatalog(ownerDb, registry());
  await ownerDb.$client.end({ timeout: 5 });
  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "debug",
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
    logger: capturingLogger(logs),
  });
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });

  owner = await signUp("icons-owner@example.com");
  viewer = await signUp("icons-viewer@example.com");
  stranger = await signUp("icons-stranger@example.com");
  workspaceId = await newWorkspace(owner, "Icons");
  emptyWorkspaceId = await newWorkspace(owner, "Nothing connected");
  otherWorkspaceId = await newWorkspace(stranger, "Elsewhere");
  const added = await addMemberViaInvitation(
    app,
    db,
    owner,
    workspaceId,
    "icons-viewer@example.com",
    "viewer",
  );
  expect(added.statusCode).toBe(200);

  const created = await call(owner, "POST", "/connections", {
    connectorId: "app-store-connect",
    name: "Wurfel team",
    config: { vendorNumber: TEAM.vendorNumbers[0] },
    credentials: {
      issuerId: TEAM.issuerId,
      keyId: TEAM.keyId,
      privateKey: TEAM.key.privateKeyPem,
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  connectionId = connectionResponseSchema.parse(created.json()).connection.id;
  // The first sync stores the sales and the apps' names.
  await runSync(connectionId);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin?.end({ timeout: 5 }).catch(() => undefined);
});

describe("resource icons", () => {
  it("lists the connection's apps as icon sources, none fetched yet", async () => {
    const response = await call(viewer, "GET", "/resource-icons");
    expect(response.statusCode, response.body).toBe(200);
    const { resources } = resourceIconListResponseSchema.parse(response.json());
    expect(
      resources.map((resource) => [resource.resourceId, resource.image]),
    ).toEqual(
      expect.arrayContaining([
        [WURFEL, null],
        [PAPERSTAND, null],
        [UNRELEASED, null],
      ]),
    );
    expect(resources[0]!.connectionName).toBe("Wurfel team");
    // Listing never reaches Apple.
    expect(apple.requests).toHaveLength(0);
  });

  it("fetches an app icon on the server and stores it as a validated, stripped workspace image", async () => {
    const response = await useIcon(WURFEL);
    expect(response.statusCode, response.body).toBe(200);
    const { image } = imageResponseSchema.parse(response.json());
    expect(image).toMatchObject({
      origin: "resource_icon",
      connectionId,
      resourceId: WURFEL,
      contentType: "image/png",
      width: 4,
      height: 4,
      name: "Wurfel – Cube Solver icon",
    });
    const content = await app.inject({
      method: "GET",
      url: image.url,
      headers: { cookie: owner },
    });
    expect(content.statusCode).toBe(200);
    expect(content.rawPayload.includes("private build machine")).toBe(false);
    expect(content.rawPayload.length).toBeLessThan(
      apple.icons.get(WURFEL)!.length,
    );
    // One lookup for the app, its storefront hinted from the sales (DE
    // sold most), and the CDN; the signed token went to neither.
    const lookup = apple.requests.find(
      (request) => request.url.hostname === "itunes.apple.com",
    )!;
    expect(lookup.url.searchParams.get("id")).toBe(WURFEL);
    for (const request of apple.requests) {
      expect(request.init?.headers?.authorization).toBeUndefined();
    }
    const [audit] = await admin`
      select action, metadata from audit_events
      where workspace_id = ${workspaceId} and target = ${image.id}`;
    expect(audit).toMatchObject({ action: "image.uploaded" });
    expect(JSON.stringify(audit!.metadata)).not.toContain("Wurfel");
  });

  it("reuses a fresh icon without asking Apple again", async () => {
    const before = apple.requests.length;
    const first = imageResponseSchema.parse((await useIcon(WURFEL)).json());
    const again = imageResponseSchema.parse((await useIcon(WURFEL)).json());
    expect(again.image.id).toBe(first.image.id);
    expect(apple.requests.length).toBe(before);
    const listed = resourceIconListResponseSchema
      .parse((await call(owner, "GET", "/resource-icons")).json())
      .resources.find((resource) => resource.resourceId === WURFEL)!;
    expect(listed.image?.id).toBe(first.image.id);
  });

  it("looks an app up in its sales territory when the US storefront does not list it", async () => {
    const before = apple.requests.length;
    const response = await useIcon(KUBIK);
    expect(response.statusCode, response.body).toBe(200);
    expect(imageResponseSchema.parse(response.json()).image.resourceId).toBe(
      KUBIK,
    );
    const countries = apple.requests
      .slice(before)
      .filter((request) => request.url.hostname === "itunes.apple.com")
      .map((request) => request.url.searchParams.get("country"));
    expect(countries).toEqual([null, "jp"]);
  });

  it("answers 404 for an app nobody lists (the build probe is refused for a Sales key, silently)", async () => {
    const before = asc.requests.length;
    expectError(await useIcon(UNRELEASED), 404, "resource_icon_not_found");
    const builds = asc.requests
      .slice(before)
      .filter((request) => request.url.pathname === "/v1/builds");
    expect(builds).toHaveLength(1);
  });

  it("answers 502 when Apple fails and no icon is stored, without the provider's words", async () => {
    apple.failing = true;
    try {
      const response = await useIcon(PAPERSTAND);
      expectError(response, 502, "resource_icon_unavailable");
    } finally {
      apple.failing = false;
    }
  });

  it("refuses viewers, unknown resources, other connectors and other workspaces", async () => {
    expectError(await useIcon(WURFEL, viewer), 403, "forbidden");
    expectError(await useIcon("123"), 404, "resource_not_found");
    const strangers = await call(
      stranger,
      "POST",
      "/resource-icons",
      { connectionId, resourceId: WURFEL },
      otherWorkspaceId,
    );
    expectError(strangers, 404, "resource_not_found");
    expectError(
      await call(stranger, "POST", "/resource-icons", {
        connectionId,
        resourceId: WURFEL,
      }),
      404,
      "workspace_not_found",
    );
    const demo = await call(owner, "POST", "/connections", {
      connectorId: "demo",
      name: "Demo",
      config: {},
    });
    const demoId = connectionResponseSchema.parse(demo.json()).connection.id;
    await admin`
      insert into connection_resources
        (workspace_id, connection_id, resource_id, name, kind, discovered_at)
      values (${workspaceId}, ${demoId}, 'demo-site-1', 'Demo site', 'site', now())`;
    expectError(
      await call(owner, "POST", "/resource-icons", {
        connectionId: demoId,
        resourceId: "demo-site-1",
      }),
      400,
      "resource_icons_unsupported",
    );
    await admin`delete from connections where id = ${demoId}`;
    // Other workspaces see none of these icons.
    const elsewhere = resourceIconListResponseSchema.parse(
      (
        await call(
          stranger,
          "GET",
          "/resource-icons",
          undefined,
          otherWorkspaceId,
        )
      ).json(),
    );
    expect(elsewhere.resources).toEqual([]);
  });
});

describe("dashboard templates", () => {
  let brand: Dashboard;

  it("offers the Overview from the connections and a Brand per app", async () => {
    const response = await call(owner, "GET", "/dashboard-templates");
    expect(response.statusCode, response.body).toBe(200);
    const options = dashboardTemplateOptionsResponseSchema.parse(
      response.json(),
    );
    expect(options.overview.sources).toEqual([
      {
        connectionId,
        connectionName: "Wurfel team",
        connectorId: "app-store-connect",
      },
    ]);
    expect(
      options.brand.resources.map((resource) => [
        resource.resourceId,
        resource.iconSupported,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [WURFEL, true],
        [PAPERSTAND, true],
      ]),
    );
    expectError(
      await call(viewer, "POST", "/dashboard-templates", {
        template: "overview",
      }),
      403,
      "forbidden",
    );
  });

  it("creates the Overview as an ordinary studio dashboard", async () => {
    const response = await call(owner, "POST", "/dashboard-templates", {
      template: "overview",
    });
    expect(response.statusCode, response.body).toBe(200);
    const { dashboard } = dashboardResponseSchema.parse(response.json());
    expect(dashboard.name).toBe("Overview");
    expect(dashboard.slides.map((slide) => slide.name)).toEqual(["App Store"]);
    const widgets = dashboard.slides[0]!.widgets;
    expect(
      widgets.map((widget) =>
        "metricKey" in widget ? [widget.type, widget.metricKey] : widget.type,
      ),
    ).toEqual([
      ["metric", "app_store_connect.downloads"],
      ["metric", "app_store_connect.proceeds"],
      ["line", "app_store_connect.downloads"],
      ["bar", "app_store_connect.downloads"],
    ]);
    // English: metrics untitled (their automatic label follows the screen
    // language), charts titled with their period (#268).
    expect(widgets.map((widget) => widget.title ?? null)).toEqual([
      null,
      null,
      "Downloads, 30 days",
      "Downloads by app",
    ]);
    expect(
      "allResourcesName" in widgets[0]! && widgets[0].allResourcesName,
    ).toBe("All apps");
    expect(slideLayoutProblem(widgets)).toBeNull();
    // No reviews key: no reviews widget.
    expect(JSON.stringify(dashboard)).not.toContain("reviews");
  });

  it("refuses an Overview when nothing is connected", async () => {
    expectError(
      await call(
        owner,
        "POST",
        "/dashboard-templates",
        { template: "overview" },
        emptyWorkspaceId,
      ),
      409,
      "none_connected",
    );
  });

  it("creates a Brand dashboard with the app icon as logo and image, its accent and its own numbers", async () => {
    const response = await call(owner, "POST", "/dashboard-templates", {
      template: "brand",
      connectionId,
      resourceId: WURFEL,
      accentColor: "#4f8cff",
    });
    expect(response.statusCode, response.body).toBe(200);
    brand = dashboardResponseSchema.parse(response.json()).dashboard;
    const icon = resourceIconListResponseSchema
      .parse((await call(owner, "GET", "/resource-icons")).json())
      .resources.find((resource) => resource.resourceId === WURFEL)!.image!;
    expect(brand.name).toBe("Wurfel – Cube Solver");
    expect(brand.settings).toMatchObject({
      accentColor: "#4f8cff",
      logoImageId: icon.id,
      showHeader: true,
    });
    expect(brand.slides.map((slide) => slide.name)).toEqual(["Today", "Trend"]);
    const all = brand.slides.flatMap((slide) => slide.widgets);
    expect(all.find((widget) => widget.type === "image")).toMatchObject({
      imageId: icon.id,
    });
    for (const widget of all) {
      if ("metricKey" in widget) {
        expect(widget.dimensions).toEqual({ resource: WURFEL });
      }
    }
    expect(
      all.find(
        (widget) =>
          widget.type === "bar" &&
          widget.metricKey === "app_store_connect.downloads_by_territory",
      ),
    ).toMatchObject({ options: { groupBy: "territory" } });
    for (const slide of brand.slides) {
      expect(slideLayoutProblem(slide.widgets)).toBeNull();
    }
  });

  it("refuses a brand accent that is unreadable on the theme", async () => {
    // The default theme's own surface colour: contrast 1:1.
    const surface = BUILTIN_THEMES.netrics_dark.tokens.surface;
    expectError(
      await call(owner, "POST", "/dashboard-templates", {
        template: "brand",
        connectionId,
        resourceId: PAPERSTAND,
        accentColor: surface,
        logoImageId: null,
      }),
      400,
      "contrast_too_low",
    );
  });

  it("refuses a Brand for another workspace's connection", async () => {
    expectError(
      await call(
        stranger,
        "POST",
        "/dashboard-templates",
        { template: "brand", connectionId, resourceId: WURFEL },
        otherWorkspaceId,
      ),
      404,
      "resource_not_found",
    );
  });

  it("refreshes a changed icon with the daily resource refresh and moves every use to it", async () => {
    const oldLogo = brand.settings.logoImageId!;
    apple.icons.set(WURFEL, iconPng([200, 40, 160]));
    // A day later: the names (and with them the icons) are due again.
    await admin`
      update connection_resources set discovered_at = ${new Date(NOW - 2 * DAY)}
      where connection_id = ${connectionId}`;
    await runSync(connectionId);
    const icons = await admin`
      select id from workspace_images
      where workspace_id = ${workspaceId} and origin = 'resource_icon'
        and resource_id = ${WURFEL}`;
    expect(icons).toHaveLength(1);
    const fresh = icons[0]!.id as string;
    expect(fresh).not.toBe(oldLogo);
    const reloaded = dashboardResponseSchema.parse(
      (await call(owner, "GET", `/dashboards/${brand.id}`)).json(),
    ).dashboard;
    expect(reloaded.settings.logoImageId).toBe(fresh);
    expect(reloaded.version).toBe(brand.version);
    expect(
      reloaded.slides
        .flatMap((slide) => slide.widgets)
        .find((widget) => widget.type === "image"),
    ).toMatchObject({ imageId: fresh });
    const [audit] = await admin`
      select action, actor_user_id from audit_events
      where workspace_id = ${workspaceId} and target = ${fresh}`;
    expect(audit).toMatchObject({
      action: "image.icon_refreshed",
      actor_user_id: null,
    });
    // An unchanged icon is kept as it is.
    await admin`
      update connection_resources set discovered_at = ${new Date(NOW - 2 * DAY)}
      where connection_id = ${connectionId}`;
    await runSync(connectionId);
    const [kept] = await admin`
      select id from workspace_images
      where workspace_id = ${workspaceId} and resource_id = ${WURFEL}`;
    expect(kept!.id).toBe(fresh);
  });

  describe("in the creator's language (#268)", () => {
    function patchLocale(locale: string | null) {
      return app.inject({
        method: "PATCH",
        url: "/v1/me",
        headers: { cookie: owner },
        payload: { locale },
      });
    }

    function create(
      payload: Record<string, unknown>,
      acceptLanguage?: string,
    ): Promise<InjectResponse> {
      return app.inject({
        method: "POST",
        url: `/v1/workspaces/${workspaceId}/dashboard-templates`,
        headers: {
          cookie: owner,
          ...(acceptLanguage ? { "accept-language": acceptLanguage } : {}),
        },
        payload,
      });
    }

    function titlesOf(dashboard: { slides: { widgets: unknown[] }[] }) {
      return dashboard.slides.flatMap((slide) =>
        (slide.widgets as { title?: string | null }[]).map(
          (widget) => widget.title ?? null,
        ),
      );
    }

    afterAll(async () => {
      expect((await patchLocale("en")).statusCode).toBe(200);
    });

    it("creates Overview and Brand in the user's language", async () => {
      expect((await patchLocale("de")).statusCode).toBe(200);
      // The user's setting wins over the browser's.
      const overview = await create({ template: "overview" }, "en");
      expect(overview.statusCode, overview.body).toBe(200);
      const { dashboard } = dashboardResponseSchema.parse(overview.json());
      expect(dashboard.name).toBe("Übersicht");
      expect(dashboard.slides.map((slide) => slide.name)).toEqual([
        "App Store",
      ]);
      expect(titlesOf(dashboard)).toEqual([
        null,
        null,
        "Downloads, 30 Tage",
        "Downloads nach App",
      ]);
      // The untitled widgets' scope is in the reader's language too.
      const first = dashboard.slides[0]!.widgets[0]!;
      expect("allResourcesName" in first && first.allResourcesName).toBe(
        "Alle Apps",
      );

      const brandDe = await create({
        template: "brand",
        connectionId,
        resourceId: PAPERSTAND,
        logoImageId: null,
      });
      expect(brandDe.statusCode, brandDe.body).toBe(200);
      const created = dashboardResponseSchema.parse(brandDe.json()).dashboard;
      expect(created.slides.map((slide) => slide.name)).toEqual([
        "Heute",
        "Verlauf",
      ]);
      expect(titlesOf(created)).toEqual([
        "Downloads, 7 Tage",
        "Erlöse, 30 Tage",
        "Downloads, 30 Tage",
        "Top-Länder",
        "Downloads, 90 Tage",
        "Erlöse, 90 Tage",
      ]);
    });

    it("follows the browser's language when the user has none", async () => {
      expect((await patchLocale(null)).statusCode).toBe(200);
      const german = await create({ template: "overview" }, "de-DE,de;q=0.9");
      expect(german.statusCode, german.body).toBe(200);
      expect(dashboardResponseSchema.parse(german.json()).dashboard.name).toBe(
        "Übersicht",
      );
      const english = await create({ template: "overview" }, "en-US");
      expect(dashboardResponseSchema.parse(english.json()).dashboard.name).toBe(
        "Overview",
      );
    });
  });
});
