import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  dashboardResponseSchema,
  deviceDashboardV2ResponseSchema,
  deviceDashboardV3ResponseSchema,
  workspaceResponseSchema,
  type Dashboard,
  type DashboardSlide,
  type DeviceDashboardV2Response,
  type DeviceDashboardV3Response,
} from "@netrics/contracts";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";
import { slideLayoutFor } from "@netrics/domain";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { pageSlideId } from "./devices/dashboard.js";
import {
  createDeviceService,
  type DeviceDashboardSchema,
} from "./devices/service.js";
import { loadConfig } from "./env.js";
import { createTestDatabase } from "./test-db.js";

// Device payload schema 3 (ADR 0017 section 9, #277): the primary layout,
// custom layouts and the device's settings for every screen alike; schema
// 2 reduced to the 16x9 layout for screens that know no formats. The
// dashboards are written through the API, so they are what the Studio
// saves.

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

const NOW = new Date("2026-10-04T10:00:00Z");

let app: FastifyInstance;
let db: Database;
let admin: Sql;
let owner: string;
let stranger: string;
let workspaceId: string;
let strangerWorkspaceId: string;
let connectionId: string;

function call(
  method: "GET" | "POST" | "PUT",
  url: string,
  cookie: string,
  payload?: unknown,
): Promise<InjectResponse> {
  const options: InjectOptions = {
    method,
    url,
    headers: { cookie },
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
    name: "Payload v3",
  });
  return workspaceResponseSchema.parse(response.json()).workspace.id;
}

const base = (workspace = workspaceId) =>
  `/v1/workspaces/${workspace}/dashboards`;

function parsed(response: InjectResponse): Dashboard {
  expect(response.statusCode, response.body).toBe(200);
  return dashboardResponseSchema.parse(response.json()).dashboard;
}

const metric = (x: number, y: number, title: string) => ({
  type: "metric",
  x,
  y,
  w: 3,
  h: 2,
  title,
  connectionId,
  metricKey: "demo.signups",
  period: "last_7_days",
});

const line = (x: number, y: number, w: number, h: number) => ({
  type: "line",
  x,
  y,
  w,
  h,
  title: "Visitors",
  connectionId,
  metricKey: "demo.visitors",
  period: "last_30_days",
});

const text = (x: number, y: number, w: number, h: number) => ({
  type: "text",
  x,
  y,
  w,
  h,
  text: "Daily **numbers**",
});

const clock = (x: number, y: number) => ({ type: "clock", x, y, w: 2, h: 1 });

/** A 16x9 design: two metrics above a chart, and a slide with a clock. */
const landscape = () => [
  {
    name: "Sales",
    widgets: [metric(0, 0, "A"), metric(3, 0, "B"), line(0, 2, 6, 4)],
  },
  { name: "Time", widgets: [clock(0, 0)] },
];

/**
 * A 9x16 design that needs two 16:9 pages: two metrics, a chart, a text,
 * two more metrics and a clock, top to bottom.
 */
const portrait = () => [
  {
    name: "Tall",
    widgets: [
      metric(0, 0, "A"),
      metric(3, 0, "B"),
      line(0, 2, 6, 4),
      text(0, 6, 6, 3),
      metric(0, 9, "C"),
      metric(3, 9, "D"),
      clock(0, 11),
    ],
  },
  { name: null, widgets: [clock(0, 0)] },
];

async function create(body: Record<string, unknown>, cookie = owner) {
  return parsed(
    await call(
      "POST",
      base(cookie === owner ? workspaceId : strangerWorkspaceId),
      cookie,
      { name: "Formats", ...body },
    ),
  );
}

/** What a client sends back: the document as read, minus read-only fields. */
function sendable(slide: DashboardSlide, extra: Record<string, unknown> = {}) {
  const { position: _p, formatWarnings: _w, layouts: _l, ...rest } = slide;
  return { ...rest, ...extra };
}

function put(dashboard: Dashboard, body: Record<string, unknown>) {
  return call("PUT", `${base()}/${dashboard.id}`, owner, {
    version: dashboard.version,
    name: dashboard.name,
    projectId: null,
    ...body,
  });
}

async function insertDevice(
  dashboardId: string,
  fields: { rotation?: number; displayMode?: string } = {},
  workspace = workspaceId,
): Promise<string> {
  const [row] = await admin`
    insert into devices (workspace_id, name, dashboard_id, rotation,
      display_mode)
    values (${workspace}, 'TV', ${dashboardId}, ${fields.rotation ?? 0},
      ${fields.displayMode ?? "screen"})
    returning id`;
  return row!.id as string;
}

let clockNow = NOW;

function service(payloadCacheMs?: number) {
  clockNow = NOW;
  return createDeviceService({
    db,
    pairingUrl: "http://localhost:3000/devices/approve",
    now: () => clockNow,
    ...(payloadCacheMs !== undefined ? { payloadCacheMs } : {}),
  });
}

type Devices = ReturnType<typeof service>;

async function read(
  devices: Devices,
  deviceId: string,
  schema: DeviceDashboardSchema,
  workspace = workspaceId,
) {
  const result = await devices.dashboard(
    { workspaceId: workspace, deviceId },
    undefined,
    schema,
  );
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

async function v3(
  devices: Devices,
  deviceId: string,
  workspace = workspaceId,
): Promise<DeviceDashboardV3Response> {
  const payload = await read(devices, deviceId, 3, workspace);
  // What the route sends: the contract, field for field.
  expect(deviceDashboardV3ResponseSchema.parse(payload)).toEqual(payload);
  return payload as DeviceDashboardV3Response;
}

async function v2(
  devices: Devices,
  deviceId: string,
): Promise<DeviceDashboardV2Response> {
  const payload = await read(devices, deviceId, 2);
  expect(deviceDashboardV2ResponseSchema.parse(payload)).toEqual(payload);
  return payload as DeviceDashboardV2Response;
}

/** Placements by widget title, for readable expectations. */
function placed(
  dashboard: Dashboard,
  slide: {
    widgets: Array<{ id: string; x: number; y: number; w: number; h: number }>;
  },
) {
  const names = new Map(
    dashboard.slides.flatMap((s) =>
      s.widgets.map((w) => [w.id, w.title ?? w.type] as const),
    ),
  );
  return slide.widgets.map(
    (w) => `${names.get(w.id)} ${w.x},${w.y} ${w.w}×${w.h}`,
  );
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
  owner = await signUp("v3-owner@example.com");
  stranger = await signUp("v3-stranger@example.com");
  workspaceId = await newWorkspace(owner);
  strangerWorkspaceId = await newWorkspace(stranger);
  const [row] = await admin`
    insert into connections (workspace_id, connector_id, name)
    values (${workspaceId}, 'demo', 'Demo') returning id`;
  connectionId = row!.id as string;
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin.end({ timeout: 5 }).catch(() => undefined);
});

describe("device payload schema 3", () => {
  it("is schema 2's content with the primary layout, formats and device settings", async () => {
    const dashboard = await create({ slides: landscape() });
    const device = await insertDevice(dashboard.id, {
      rotation: 90,
      displayMode: "scroll",
    });
    const devices = service();
    const payload = await v3(devices, device);
    const legacy = await v2(devices, device);

    const { slides, ...rest } = payload;
    expect(Object.keys(payload)).toEqual([
      "version",
      "schema",
      "refreshAfterSec",
      "timeZone",
      "locale",
      "primaryFormat",
      "formats",
      "device",
      "dashboard",
      "theme",
      "rotation",
      "slides",
      "images",
    ]);
    expect(rest).toMatchObject({
      schema: 3,
      locale: "en",
      primaryFormat: "16x9",
      device: { rotation: 90, displayMode: "scroll" },
      dashboard: legacy.dashboard,
      theme: legacy.theme,
      rotation: legacy.rotation,
      images: legacy.images,
    });
    expect(payload).not.toHaveProperty("grid");
    expect(payload.formats).toMatchInlineSnapshot(`
      {
        "16x9": {
          "columns": 12,
          "reference": [
            1920,
            1080,
          ],
          "rows": 8,
        },
        "21x9": {
          "columns": 16,
          "reference": [
            2520,
            1080,
          ],
          "rows": 8,
        },
        "3x4": {
          "columns": 6,
          "reference": [
            1080,
            1440,
          ],
          "rows": 10,
        },
        "4x3": {
          "columns": 9,
          "reference": [
            1440,
            1080,
          ],
          "rows": 8,
        },
        "9x16": {
          "columns": 6,
          "reference": [
            1080,
            1920,
          ],
          "rows": 14,
        },
      }
    `);
    // A 16x9 dashboard without custom layouts: schema 2's slides, each with
    // no layouts (every other format is auto).
    expect(slides).toEqual(
      legacy.slides.map((slide) => ({ ...slide, layouts: [] })),
    );
    expect(payload.version).not.toBe(legacy.version);
  });

  it("carries custom layouts without the review flag, and keeps schema 2 as it was", async () => {
    const dashboard = await create({ slides: landscape() });
    const device = await insertDevice(dashboard.id);
    const devices = service(0);
    const before = JSON.stringify(await v2(devices, device));

    const [sales, time] = dashboard.slides;
    const [a, b, chart] = sales!.widgets;
    const saved = parsed(
      await put(dashboard, {
        slides: [
          sendable(sales!, {
            layouts: [
              {
                format: "9x16",
                pages: 2,
                placements: [
                  { widgetId: a!.id, page: 0, x: 0, y: 0, w: 6, h: 2 },
                  { widgetId: b!.id, page: 0, x: 0, y: 2, w: 3, h: 2 },
                  { widgetId: chart!.id, page: 1, x: 0, y: 0, w: 6, h: 5 },
                ],
              },
              {
                format: "4x3",
                pages: 1,
                placements: [
                  { widgetId: a!.id, page: 0, x: 0, y: 0, w: 3, h: 2 },
                  {
                    widgetId: b!.id,
                    page: 0,
                    x: 3,
                    y: 0,
                    w: 3,
                    h: 2,
                    hidden: true,
                  },
                  { widgetId: chart!.id, page: 0, x: 0, y: 2, w: 9, h: 6 },
                ],
              },
            ],
          }),
          sendable(time!),
        ],
      }),
    );
    expect(saved.slides[0]!.layouts.map((l) => l.format)).toEqual([
      "4x3",
      "9x16",
    ]);

    const payload = await v3(devices, device);
    expect(payload.slides[0]!.layouts).toEqual([
      {
        format: "4x3",
        pages: 1,
        placements: [
          { widgetId: a!.id, page: 0, x: 0, y: 0, w: 3, h: 2, hidden: false },
          { widgetId: b!.id, page: 0, x: 3, y: 0, w: 3, h: 2, hidden: true },
          {
            widgetId: chart!.id,
            page: 0,
            x: 0,
            y: 2,
            w: 9,
            h: 6,
            hidden: false,
          },
        ],
      },
      {
        format: "9x16",
        pages: 2,
        placements: [
          { widgetId: a!.id, page: 0, x: 0, y: 0, w: 6, h: 2, hidden: false },
          { widgetId: b!.id, page: 0, x: 0, y: 2, w: 3, h: 2, hidden: false },
          {
            widgetId: chart!.id,
            page: 1,
            x: 0,
            y: 0,
            w: 6,
            h: 5,
            hidden: false,
          },
        ],
      },
    ]);
    expect(JSON.stringify(payload)).not.toContain("autoPlaced");
    expect(payload.slides[1]!.layouts).toEqual([]);
    // The widgets keep their primary placements.
    expect(placed(saved, payload.slides[0]!)).toEqual([
      "A 0,0 3×2",
      "B 3,0 3×2",
      "Visitors 0,2 6×4",
    ]);

    // Schema 2 of a 16x9 dashboard ignores other formats: unchanged except
    // for the saved version, which is not part of the payload.
    expect(JSON.stringify(await v2(devices, device))).toBe(before);
  });

  it("puts the device settings into the version, so a rotation reaches the screen", async () => {
    const dashboard = await create({ slides: landscape() });
    const upright = await insertDevice(dashboard.id);
    const turned = await insertDevice(dashboard.id, { rotation: 90 });
    const devices = service();
    const first = await v3(devices, upright);
    const other = await v3(devices, turned);
    // Same dashboard, other settings: shared content, its own version.
    expect(other.slides).toEqual(first.slides);
    expect(other.device).toEqual({ rotation: 90, displayMode: "screen" });
    expect(other.version).not.toBe(first.version);

    // Within the memo's 30 s, a changed setting is in the next payload.
    await admin`update devices set rotation = 270, display_mode = 'scroll'
                where id = ${upright}`;
    const changed = await v3(devices, upright);
    expect(changed.device).toEqual({ rotation: 270, displayMode: "scroll" });
    expect(changed.version).not.toBe(first.version);
    // Schema 2 knows no settings: its version stays.
    await admin`update devices set rotation = 0 where id = ${turned}`;
    const legacy = (await v2(devices, upright)).version;
    expect((await v2(devices, turned)).version).toBe(legacy);
    // Back to the first settings: the first version again.
    await admin`update devices set rotation = 0, display_mode = 'screen'
                where id = ${upright}`;
    expect((await v3(devices, upright)).version).toBe(first.version);
  });

  it("shows a saved layout change at once, despite the memo", async () => {
    const dashboard = await create({ slides: landscape() });
    const device = await insertDevice(dashboard.id);
    const devices = service();
    const first = await v3(devices, device);
    expect(first.slides[0]!.layouts).toEqual([]);
    const [sales, time] = dashboard.slides;
    const [a, b, chart] = sales!.widgets;
    parsed(
      await put(dashboard, {
        slides: [
          sendable(sales!, {
            layouts: [
              {
                format: "3x4",
                pages: 1,
                placements: [
                  { widgetId: a!.id, page: 0, x: 0, y: 0, w: 3, h: 2 },
                  { widgetId: b!.id, page: 0, x: 3, y: 0, w: 3, h: 2 },
                  { widgetId: chart!.id, page: 0, x: 0, y: 2, w: 6, h: 6 },
                ],
              },
            ],
          }),
          sendable(time!),
        ],
      }),
    );
    // Same clock, inside the 30 s: a save is a new dashboard version.
    const saved = await v3(devices, device);
    expect(saved.slides[0]!.layouts.map((l) => l.format)).toEqual(["3x4"]);
    expect(saved.version).not.toBe(first.version);
  });

  it("answers defaults without a dashboard", async () => {
    const [row] = await admin`
      insert into devices (workspace_id, name) values (${workspaceId}, 'TV')
      returning id`;
    const payload = await v3(service(), row!.id as string);
    expect(payload).toMatchObject({
      schema: 3,
      primaryFormat: "16x9",
      device: { rotation: 0, displayMode: "screen" },
      dashboard: null,
      slides: [],
      images: [],
    });
  });

  it("never serves one workspace's payload or layouts to another", async () => {
    const ours = await create({ slides: landscape() });
    const theirs = await create(
      { slides: [{ name: "Theirs", widgets: [clock(0, 0)] }] },
      stranger,
    );
    const ourDevice = await insertDevice(ours.id);
    const theirDevice = await insertDevice(theirs.id, {}, strangerWorkspaceId);
    const devices = service();
    const mine = await v3(devices, ourDevice);
    const other = await v3(devices, theirDevice, strangerWorkspaceId);
    expect(other.dashboard?.id).toBe(theirs.id);
    expect(other.slides.map((s) => s.widgets.map((w) => w.id))).toEqual([
      [theirs.slides[0]!.widgets[0]!.id],
    ]);
    expect(other.version).not.toBe(mine.version);
    // A device is only ever found in its own workspace.
    expect(
      await devices.dashboard(
        { workspaceId: strangerWorkspaceId, deviceId: ourDevice },
        undefined,
        3,
      ),
    ).toEqual({ ok: false, status: 401, error: "unauthorized" });
  });
});

describe("device payload schema 2 of a dashboard designed for another format", () => {
  it("is the auto 16x9 layout, continuation pages as extra slides with stable ids", async () => {
    const dashboard = await create({
      primaryFormat: "9x16",
      slides: portrait(),
    });
    expect(dashboard.primaryFormat).toBe("9x16");
    const device = await insertDevice(dashboard.id);
    const payload = await v2(service(0), device);
    const [tall, second] = dashboard.slides;

    expect(payload.grid).toEqual({ columns: 12, rows: 8 });
    expect(payload.slides.map((slide) => [slide.id, slide.name])).toEqual([
      [tall!.id, "Tall 1/2"],
      [pageSlideId(tall!.id, 1), "Tall 2/2"],
      [second!.id, null],
    ]);
    expect(payload.slides.map((slide) => placed(dashboard, slide)))
      .toMatchInlineSnapshot(`
      [
        [
          "A 0,0 6×3",
          "B 6,0 6×3",
          "Visitors 0,3 12×5",
        ],
        [
          "text 0,0 12×4",
          "C 0,4 6×3",
          "D 6,4 6×3",
          "clock 0,7 4×1",
        ],
        [
          "clock 0,3 4×1",
        ],
      ]
    `);
    // Exactly the domain's 16x9 layout: what a schema 3 screen computes.
    const pages = slideLayoutFor({
      widgets: tall!.widgets,
      primaryFormat: "9x16",
      format: "16x9",
    });
    expect(
      payload.slides
        .slice(0, 2)
        .map((slide) =>
          slide.widgets.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })),
        ),
    ).toEqual(pages);
    // Every widget is on exactly one page, with its data.
    expect(
      payload.slides
        .slice(0, 2)
        .flatMap((slide) => slide.widgets.map((w) => w.id))
        .sort(),
    ).toEqual(tall!.widgets.map((w) => w.id).sort());
    // Stable across requests: same ids, same version.
    const again = await v2(service(0), device);
    expect(again.version).toBe(payload.version);
    expect(pageSlideId(tall!.id, 1)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(pageSlideId(tall!.id, 1)).not.toBe(pageSlideId(tall!.id, 2));
    expect(pageSlideId(tall!.id, 1)).not.toBe(pageSlideId(second!.id, 1));

    // Schema 3 sends the primary placements; screens reflow themselves.
    const modern = await v3(service(0), device);
    expect(modern.primaryFormat).toBe("9x16");
    expect(modern.slides.map((slide) => slide.id)).toEqual([
      tall!.id,
      second!.id,
    ]);
    expect(placed(dashboard, modern.slides[0]!)).toEqual(
      tall!.widgets.map(
        (w) => `${w.title ?? w.type} ${w.x},${w.y} ${w.w}×${w.h}`,
      ),
    );
  });

  it("uses a custom 16x9 layout, leaving hidden widgets out", async () => {
    const dashboard = await create({
      primaryFormat: "9x16",
      slides: portrait(),
    });
    const [tall, second] = dashboard.slides;
    const byTitle = (title: string) =>
      tall!.widgets.find((w) => (w.title ?? w.type) === title)!.id;
    parsed(
      await put(dashboard, {
        primaryFormat: "9x16",
        slides: [
          sendable(tall!, {
            layouts: [
              {
                format: "16x9",
                pages: 1,
                placements: [
                  { widgetId: byTitle("A"), page: 0, x: 0, y: 0, w: 3, h: 2 },
                  { widgetId: byTitle("B"), page: 0, x: 3, y: 0, w: 3, h: 2 },
                  { widgetId: byTitle("C"), page: 0, x: 6, y: 0, w: 3, h: 2 },
                  { widgetId: byTitle("D"), page: 0, x: 9, y: 0, w: 3, h: 2 },
                  {
                    widgetId: byTitle("Visitors"),
                    page: 0,
                    x: 0,
                    y: 2,
                    w: 8,
                    h: 6,
                  },
                  {
                    widgetId: byTitle("text"),
                    page: 0,
                    x: 8,
                    y: 2,
                    w: 4,
                    h: 5,
                  },
                  {
                    widgetId: byTitle("clock"),
                    page: 0,
                    x: 8,
                    y: 7,
                    w: 2,
                    h: 1,
                    hidden: true,
                  },
                ],
              },
            ],
          }),
          sendable(second!),
        ],
      }),
    );
    const payload = await v2(service(0), await insertDevice(dashboard.id));
    expect(payload.slides.map((slide) => [slide.id, slide.name])).toEqual([
      [tall!.id, "Tall"],
      [second!.id, null],
    ]);
    expect(placed(dashboard, payload.slides[0]!)).toEqual([
      "A 0,0 3×2",
      "B 3,0 3×2",
      "C 6,0 3×2",
      "D 9,0 3×2",
      "Visitors 0,2 8×6",
      "text 8,2 4×5",
    ]);
  });
});
