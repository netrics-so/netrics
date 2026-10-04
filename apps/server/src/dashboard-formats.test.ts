import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  dashboardResponseSchema,
  errorResponseSchema,
  workspaceResponseSchema,
  type Dashboard,
  type DashboardSlide,
  type SlideLayout,
} from "@netrics/contracts";
import {
  createDatabase,
  createRawSqlClient,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import {
  buildDeviceDashboard,
  buildDeviceDashboardV2,
} from "./devices/dashboard.js";
import { loadConfig } from "./env.js";
import { createTestDatabase } from "./test-db.js";

// Primary formats and custom layouts in the dashboard document (#275, ADR
// 0017 sections 4 and 8): validation, the sync rules on save, re-basing on
// another primary format, duplicates, and tenant isolation.

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

let app: FastifyInstance;
let db: Database;
let admin: Sql;
let owner: string;
let stranger: string;
let workspaceId: string;
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
    name: "Formats",
  });
  return workspaceResponseSchema.parse(response.json()).workspace.id;
}

const base = (workspace = workspaceId) =>
  `/v1/workspaces/${workspace}/dashboards`;

function expectError(response: InjectResponse, status: number, error: string) {
  expect(response.statusCode).toBe(status);
  expect(errorResponseSchema.parse(response.json()).error).toBe(error);
}

function parsed(response: InjectResponse): Dashboard {
  expect(response.statusCode).toBe(200);
  return dashboardResponseSchema.parse(response.json()).dashboard;
}

const metric = (x: number, y: number, extra: Record<string, unknown> = {}) => ({
  type: "metric",
  x,
  y,
  w: 3,
  h: 2,
  connectionId,
  metricKey: "demo.signups",
  period: "last_7_days",
  ...extra,
});

const line = (x: number, y: number, w = 6, h = 4) => ({
  type: "line",
  x,
  y,
  w,
  h,
  connectionId,
  metricKey: "demo.visitors",
  period: "last_30_days",
});

/** A time-only 2 × 1 clock: everything it shows fits. */
const clock = (x: number, y: number) => ({
  type: "clock",
  x,
  y,
  w: 2,
  h: 1,
  options: { showDate: false },
});

/** Two metrics above a chart, and a slide with a clock. */
const slides = () => [
  {
    name: "Sales",
    widgets: [metric(0, 0), metric(3, 0), line(0, 2)],
  },
  { name: "Time", widgets: [clock(0, 0)] },
];

async function create(body: Record<string, unknown> = {}) {
  return parsed(
    await call("POST", base(), owner, {
      name: "Formats",
      slides: slides(),
      ...body,
    }),
  );
}

/** What a client sends back: the document as read, minus read-only fields. */
function sendable(slide: DashboardSlide, extra: Record<string, unknown> = {}) {
  const { position: _p, formatWarnings: _w, layouts: _l, ...rest } = slide;
  return { ...rest, ...extra };
}

function put(
  dashboard: Pick<Dashboard, "id" | "version" | "name">,
  body: Record<string, unknown>,
  cookie = owner,
  workspace = workspaceId,
) {
  return call("PUT", `${base(workspace)}/${dashboard.id}`, cookie, {
    version: dashboard.version,
    name: dashboard.name,
    projectId: null,
    ...body,
  });
}

const get = async (id: string) =>
  parsed(await call("GET", `${base()}/${id}`, owner));

/** A 9x16 layout of the Sales slide: metrics side by side, the chart below. */
function portrait(sales: DashboardSlide): SlideLayout {
  const [a, b, chart] = sales.widgets;
  return {
    format: "9x16",
    pages: 1,
    placements: [
      { widgetId: a!.id, page: 0, x: 0, y: 0, w: 3, h: 2 },
      { widgetId: b!.id, page: 0, x: 3, y: 0, w: 3, h: 2 },
      { widgetId: chart!.id, page: 0, x: 0, y: 2, w: 6, h: 5 },
    ].map((placement) => ({ ...placement, hidden: false, autoPlaced: false })),
  };
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
  owner = await signUp("formats-owner@example.com");
  stranger = await signUp("formats-stranger@example.com");
  workspaceId = await newWorkspace(owner);
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

describe("primary format and custom layouts", () => {
  it("reads a dashboard as 16x9 with every format on auto", async () => {
    const dashboard = await create();
    expect(dashboard.primaryFormat).toBe("16x9");
    expect(dashboard.slides.map((s) => [s.layouts, s.formatWarnings])).toEqual([
      [[], []],
      [[], []],
    ]);
    expect(await get(dashboard.id)).toEqual(dashboard);
  });

  it("stores custom layouts and returns them as read", async () => {
    const dashboard = await create();
    const [sales, time] = dashboard.slides;
    const layout = portrait(sales!);
    const saved = parsed(
      await put(dashboard, {
        slides: [
          sendable(sales!, {
            layouts: [
              {
                ...layout,
                // hidden and autoPlaced default to false.
                placements: layout.placements.map(
                  ({ hidden: _h, autoPlaced: _a, ...rest }) => rest,
                ),
              },
            ],
          }),
          sendable(time!),
        ],
      }),
    );
    expect(saved.slides[0]!.layouts).toEqual([layout]);
    expect(saved.slides[1]!.layouts).toEqual([]);
    expect(await get(dashboard.id)).toEqual(saved);
  });

  it("refuses invalid custom layouts", async () => {
    const dashboard = await create();
    const [sales, time] = dashboard.slides;
    const layout = portrait(sales!);
    const [a, b, chart] = layout.placements;
    const save = (layouts: unknown[]) =>
      put(dashboard, {
        slides: [sendable(sales!, { layouts }), sendable(time!)],
      });
    const cases: Array<[string, unknown[], number, string]> = [
      [
        "the primary format",
        [{ ...layout, format: "16x9" }],
        400,
        "layout_primary_format",
      ],
      ["a format twice", [layout, layout], 400, "layout_duplicate_format"],
      [
        "a widget twice",
        [
          {
            ...layout,
            placements: [a, b, chart, { ...a!, y: 8 }],
          },
        ],
        400,
        "layout_widget_duplicated",
      ],
      [
        "past the 9x16 grid",
        [{ ...layout, placements: [a, { ...b!, x: 4 }, chart] }],
        400,
        "layout_widget_out_of_bounds",
      ],
      [
        "on a page the layout does not have",
        [{ ...layout, placements: [a, b, { ...chart!, page: 1 }] }],
        400,
        "layout_page_out_of_range",
      ],
      [
        "below the minimum size",
        [{ ...layout, placements: [a, b, { ...chart!, h: 2 }] }],
        400,
        "layout_widget_too_small",
      ],
      [
        "overlapping",
        [{ ...layout, placements: [a, { ...b!, x: 2 }, chart] }],
        400,
        "layout_widgets_overlap",
      ],
    ];
    for (const [, layouts, status, error] of cases) {
      expectError(await save(layouts), status, error);
    }
    // Contract bounds: at most 8 pages, a known format.
    expect((await save([{ ...layout, pages: 9 }])).statusCode).toBe(400);
    expect((await save([{ ...layout, format: "16x10" }])).statusCode).toBe(400);
    // Hidden widgets may overlap; the save is the old version, unchanged.
    const hidden = parsed(
      await save([
        {
          ...layout,
          placements: [a, { ...b!, x: 2, hidden: true }, chart],
        },
      ]),
    );
    expect(hidden.slides[0]!.layouts[0]!.placements[1]).toMatchObject({
      hidden: true,
    });
    expect((await get(dashboard.id)).version).toBe(dashboard.version + 1);
  });

  it("resolves placements of unknown widgets and widgets left out", async () => {
    // The normal state of a layout after a primary edit (ADR 0017 section
    // 4): completeCustomLayout drops the one and places the other.
    const dashboard = await create();
    const [sales, time] = dashboard.slides;
    const layout = portrait(sales!);
    const [a, b, chart] = layout.placements;
    const saved = parsed(
      await put(dashboard, {
        slides: [
          sendable(sales!, {
            layouts: [
              {
                ...layout,
                placements: [
                  a,
                  b,
                  { ...chart!, widgetId: time!.widgets[0]!.id, x: 0, y: 2 },
                ],
              },
              { format: "4x3", pages: 1, placements: [a, b] },
            ],
          }),
          sendable(time!),
        ],
      }),
    );
    const [fourThree, nineSixteen] = saved.slides[0]!.layouts;
    for (const custom of [fourThree!, nineSixteen!]) {
      expect(custom.placements.map((p) => p.widgetId).sort()).toEqual(
        sales!.widgets.map((w) => w.id).sort(),
      );
      expect(
        custom.placements.find((p) => p.widgetId === chart!.widgetId),
      ).toMatchObject({ autoPlaced: true, hidden: false });
    }
    expect(fourThree!.placements.slice(0, 2)).toEqual([a, b]);
    expect(saved.slides[1]!.layouts).toEqual([]);
  });

  it("checks widgets against the primary format's grid", async () => {
    expectError(
      await call("POST", base(), owner, {
        name: "Wide",
        slides: [{ widgets: [metric(10, 0)] }],
      }),
      400,
      "widget_out_of_bounds",
    );
    // A portrait primary has 6 columns and 14 rows.
    expectError(
      await call("POST", base(), owner, {
        name: "Portrait",
        primaryFormat: "9x16",
        slides: [{ widgets: [metric(4, 0)] }],
      }),
      400,
      "widget_out_of_bounds",
    );
    const tall = parsed(
      await call("POST", base(), owner, {
        name: "Portrait",
        primaryFormat: "9x16",
        slides: [{ widgets: [metric(3, 0), line(0, 10, 6, 4)] }],
      }),
    );
    expect(tall.primaryFormat).toBe("9x16");
    expect(tall.slides[0]!.widgets.map((w) => [w.x, w.y, w.w, w.h])).toEqual([
      [3, 0, 3, 2],
      [0, 10, 6, 4],
    ]);
    // Tiles are laid out on the 16x9 grid only.
    expectError(
      await call("POST", base(), owner, {
        name: "Tiles",
        primaryFormat: "9x16",
        tiles: [
          { connectionId, metricKey: "demo.signups", period: "last_7_days" },
        ],
      }),
      400,
      "tiles_primary_format",
    );
  });

  it("keeps stored layouts when a client sends none, and clears them with []", async () => {
    const dashboard = await create();
    const [sales, time] = dashboard.slides;
    const withLayout = parsed(
      await put(dashboard, {
        slides: [
          sendable(sales!, { layouts: [portrait(sales!)] }),
          sendable(time!),
        ],
      }),
    );
    // An old Studio tab: no layouts, settings changed, widgets as read.
    const old = parsed(
      await put(withLayout, {
        settings: { transition: "none" },
        slides: withLayout.slides.map((slide) => sendable(slide)),
      }),
    );
    expect(old.settings.transition).toBe("none");
    expect(old.slides.map((s) => s.layouts)).toEqual(
      withLayout.slides.map((s) => s.layouts),
    );
    // An empty list: every format auto again.
    const cleared = parsed(
      await put(old, {
        slides: old.slides.map((slide) => sendable(slide, { layouts: [] })),
      }),
    );
    expect(cleared.slides.map((s) => s.layouts)).toEqual([[], []]);
  });

  it("follows primary edits: added widgets placed and flagged, deleted ones gone", async () => {
    const dashboard = await create();
    const [sales, time] = dashboard.slides;
    const withLayout = parsed(
      await put(dashboard, {
        slides: [
          sendable(sales!, { layouts: [portrait(sales!)] }),
          sendable(time!),
        ],
      }),
    );
    const [, second, chart] = withLayout.slides[0]!.widgets;
    // An old client removes the second metric and adds a clock.
    const edited = parsed(
      await put(withLayout, {
        slides: [
          sendable(withLayout.slides[0]!, {
            widgets: [
              ...withLayout.slides[0]!.widgets.filter(
                (widget) => widget.id !== second!.id,
              ),
              clock(6, 0),
            ],
          }),
          sendable(withLayout.slides[1]!),
        ],
      }),
    );
    const slide = edited.slides[0]!;
    const added = slide.widgets.find((widget) => widget.type === "clock")!;
    const [layout] = slide.layouts;
    expect(layout!.placements.map((p) => p.widgetId).sort()).toEqual(
      slide.widgets.map((w) => w.id).sort(),
    );
    const byId = new Map(layout!.placements.map((p) => [p.widgetId, p]));
    // Kept placements stay exactly where the user put them.
    expect(byId.get(chart!.id)).toEqual(
      portrait(withLayout.slides[0]!).placements[2],
    );
    expect(byId.get(added.id)).toMatchObject({
      autoPlaced: true,
      hidden: false,
    });
    expect(byId.has(second!.id)).toBe(false);

    // A widget whose type no longer fits its placement is placed again: a
    // 3 × 2 metric that becomes a line chart (at least 4 × 3).
    const first = slide.widgets.find((widget) => widget.type === "metric")!;
    const changed = parsed(
      await put(edited, {
        slides: [
          sendable(slide, {
            widgets: slide.widgets.map((widget) =>
              widget.id === first.id
                ? { ...line(0, 0, 6, 2), id: first.id, h: 3 }
                : widget.type === "line"
                  ? { ...widget, y: 3, h: 4 }
                  : widget,
            ),
          }),
          sendable(edited.slides[1]!),
        ],
      }),
    );
    const replaced = changed.slides[0]!.layouts[0]!.placements.find(
      (placement) => placement.widgetId === first.id,
    )!;
    expect(replaced.autoPlaced).toBe(true);
    expect(replaced.w).toBeGreaterThanOrEqual(4);
    expect(replaced.h).toBeGreaterThanOrEqual(3);

    // "Looks good": the client sends the flag cleared.
    const reviewed = parsed(
      await put(changed, {
        slides: [
          sendable(changed.slides[0]!, {
            layouts: changed.slides[0]!.layouts.map((l) => ({
              ...l,
              placements: l.placements.map((p) => ({
                ...p,
                autoPlaced: false,
              })),
            })),
          }),
          sendable(changed.slides[1]!),
        ],
      }),
    );
    expect(
      reviewed.slides[0]!.layouts[0]!.placements.every((p) => !p.autoPlaced),
    ).toBe(true);
  });

  it("places a new widget sent without an id into the custom layouts", async () => {
    const dashboard = await create();
    const [sales, time] = dashboard.slides;
    const saved = parsed(
      await put(dashboard, {
        slides: [
          sendable(sales!, {
            widgets: [...sales!.widgets, clock(6, 0)],
            layouts: [portrait(sales!)],
          }),
          sendable(time!),
        ],
      }),
    );
    const slide = saved.slides[0]!;
    expect(slide.widgets).toHaveLength(4);
    const added = slide.widgets.find((widget) => widget.type === "clock")!;
    expect(
      slide.layouts[0]!.placements.find((p) => p.widgetId === added.id),
    ).toMatchObject({ autoPlaced: true, hidden: false });
  });

  it("re-bases on another primary format losslessly", async () => {
    const dashboard = await create();
    const original = dashboard.slides.map((slide) =>
      slide.widgets.map((w) => [w.id, w.x, w.y, w.w, w.h]),
    );
    const [sales, time] = dashboard.slides;
    // 9x16 has a custom layout; 4x3 is auto.
    const withLayout = parsed(
      await put(dashboard, {
        slides: [
          sendable(sales!, { layouts: [portrait(sales!)] }),
          sendable(time!),
        ],
      }),
    );
    const turned = parsed(
      await put(withLayout, {
        primaryFormat: "9x16",
        slides: withLayout.slides.map((slide) => sendable(slide)),
      }),
    );
    expect(turned.primaryFormat).toBe("9x16");
    // The custom 9x16 layout is the primary now…
    expect(
      turned.slides[0]!.widgets.map((w) => ({
        widgetId: w.id,
        page: 0,
        x: w.x,
        y: w.y,
        w: w.w,
        h: w.h,
        hidden: false,
        autoPlaced: false,
      })),
    ).toEqual(portrait(sales!).placements);
    // …and the old primary a custom 16x9 layout.
    expect(turned.slides[0]!.layouts.map((l) => l.format)).toEqual(["16x9"]);
    expect(
      turned.slides[0]!.layouts[0]!.placements.map((p) => [
        p.widgetId,
        p.x,
        p.y,
        p.w,
        p.h,
      ]),
    ).toEqual(original[0]);
    // The clock slide had no custom layout: auto, then the old primary kept.
    expect(turned.slides[1]!.widgets[0]).toMatchObject({ w: 2, h: 1 });
    expect(turned.slides[1]!.layouts.map((l) => l.format)).toEqual(["16x9"]);

    // And back: exactly the original design, 9x16 kept as custom.
    const back = parsed(
      await put(turned, {
        primaryFormat: "16x9",
        slides: turned.slides.map((slide) => sendable(slide)),
      }),
    );
    expect(back.primaryFormat).toBe("16x9");
    expect(
      back.slides.map((slide) =>
        slide.widgets.map((w) => [w.id, w.x, w.y, w.w, w.h]),
      ),
    ).toEqual(original);
    expect(back.slides[0]!.layouts).toEqual([portrait(sales!)]);
    expect(back.slides[1]!.layouts.map((l) => l.format)).toEqual(["9x16"]);

    // Audited with the change.
    const [audit] = await admin`
      select metadata from audit_events
      where action = 'dashboard.updated' and target = ${dashboard.id}
      order by created_at desc limit 1`;
    expect(audit!.metadata).toMatchObject({
      primaryFormat: { from: "9x16", to: "16x9" },
    });
  });

  it("refuses a primary format whose layout has continuation pages or hides widgets", async () => {
    // Four charts in a 2 × 2 block need more than the 14 rows of 9x16.
    const crowded = await create({
      slides: [
        {
          widgets: [line(0, 0), line(6, 0), line(0, 4), line(6, 4)],
        },
      ],
    });
    expectError(
      await put(crowded, {
        primaryFormat: "9x16",
        slides: crowded.slides.map((slide) => sendable(slide)),
      }),
      409,
      "format_has_overflow",
    );

    const dashboard = await create();
    const [sales, time] = dashboard.slides;
    const layout = portrait(sales!);
    const twoPages = {
      ...layout,
      pages: 2,
      placements: layout.placements.map((p, i) =>
        i === 2 ? { ...p, page: 1, y: 0 } : p,
      ),
    };
    expectError(
      await put(dashboard, {
        primaryFormat: "9x16",
        slides: [sendable(sales!, { layouts: [twoPages] }), sendable(time!)],
      }),
      409,
      "format_has_overflow",
    );
    const hiding = {
      ...layout,
      placements: layout.placements.map((p, i) =>
        i === 1 ? { ...p, hidden: true } : p,
      ),
    };
    expectError(
      await put(dashboard, {
        primaryFormat: "9x16",
        slides: [sendable(sales!, { layouts: [hiding] }), sendable(time!)],
      }),
      409,
      "format_has_hidden_widgets",
    );
    // Nothing was saved.
    expect(await get(dashboard.id)).toEqual(dashboard);
  });

  it("refuses a legacy tile save over a dashboard that is not 16x9", async () => {
    const tiles = [
      { connectionId, metricKey: "demo.signups", period: "last_7_days" },
    ];
    const dashboard = parsed(
      await call("POST", base(), owner, { name: "Tiles", tiles }),
    );
    const turned = parsed(
      await put(dashboard, {
        primaryFormat: "4x3",
        slides: dashboard.slides.map((slide) => sendable(slide)),
      }),
    );
    expect(turned.primaryFormat).toBe("4x3");
    expectError(await put(turned, { tiles }), 409, "studio_dashboard");
    expectError(
      await put(dashboard, { tiles, primaryFormat: "16x9" }),
      409,
      "version_conflict",
    );
  });

  it("checks the version as before", async () => {
    const dashboard = await create();
    const [sales, time] = dashboard.slides;
    parsed(
      await put(dashboard, { slides: [sendable(sales!), sendable(time!)] }),
    );
    expectError(
      await put(dashboard, {
        primaryFormat: "4x3",
        slides: [
          sendable(sales!, { layouts: [portrait(sales!)] }),
          sendable(time!),
        ],
      }),
      409,
      "version_conflict",
    );
  });

  it("copies primary format and layouts into a duplicate", async () => {
    const dashboard = await create({ primaryFormat: "16x9" });
    const [sales, time] = dashboard.slides;
    const turned = parsed(
      await put(dashboard, {
        primaryFormat: "4x3",
        slides: [
          sendable(sales!, { layouts: [portrait(sales!)] }),
          sendable(time!),
        ],
      }),
    );
    const copy = parsed(
      await call("POST", `${base()}/${turned.id}/duplicate`, owner, {}),
    );
    expect(copy.primaryFormat).toBe("4x3");
    const strip = (d: Dashboard) =>
      d.slides.map((slide) => {
        const index = new Map(slide.widgets.map((w, i) => [w.id, i]));
        return slide.layouts.map((layout) => ({
          ...layout,
          placements: layout.placements.map(({ widgetId, ...p }) => ({
            ...p,
            widget: index.get(widgetId),
          })),
        }));
      });
    expect(strip(copy)).toEqual(strip(turned));
    const copyIds = copy.slides.flatMap((s) => s.widgets.map((w) => w.id));
    expect(
      copy.slides.flatMap((s) =>
        s.layouts.flatMap((l) => l.placements.map((p) => p.widgetId)),
      ),
    ).toSatisfy((ids: string[]) => ids.every((id) => copyIds.includes(id)));
  });

  it("keeps layouts inside their workspace", async () => {
    const dashboard = await create();
    const [sales, time] = dashboard.slides;
    const saved = parsed(
      await put(dashboard, {
        slides: [
          sendable(sales!, { layouts: [portrait(sales!)] }),
          sendable(time!),
        ],
      }),
    );
    const strangers = await newWorkspace(stranger);
    expectError(
      await call("GET", `${base(strangers)}/${dashboard.id}`, stranger),
      404,
      "dashboard_not_found",
    );
    expectError(
      await call("GET", `${base()}/${dashboard.id}`, stranger),
      404,
      "workspace_not_found",
    );
    const [connection] = await admin`
      insert into connections (workspace_id, connector_id, name)
      values (${strangers}, 'demo', 'Demo') returning id`;
    const own = parsed(
      await call("POST", base(strangers), stranger, { name: "Mine" }),
    );
    // The stranger sends the other workspace's slide, widget ids and
    // layout: the ids are not taken over, the layout lands on its own
    // widgets, and the original is untouched.
    const response = await put(
      own,
      {
        slides: [
          {
            id: sales!.id,
            widgets: sales!.widgets.map((widget) => ({
              ...widget,
              connectionId: connection!.id as string,
              resourceName: undefined,
              allResourcesName: undefined,
            })),
            layouts: [portrait(sales!)],
          },
        ],
      },
      stranger,
      strangers,
    );
    const theirs = parsed(response);
    const ids = theirs.slides[0]!.widgets.map((w) => w.id);
    expect(ids.some((id) => sales!.widgets.some((w) => w.id === id))).toBe(
      false,
    );
    expect(
      theirs.slides[0]!.layouts[0]!.placements.map((p) => p.widgetId),
    ).toEqual(ids);
    expect(await get(dashboard.id)).toEqual(saved);
    const [rows] = await admin`
      select count(*)::int as count from dashboard_widget_layouts
      where workspace_id = ${strangers}`;
    expect(rows!.count).toBe(3);
  });

  it("leaves device payloads of schema 1 and 2 unchanged", async () => {
    const dashboard = await create();
    const now = new Date("2026-10-04T10:00:00Z");
    const payloads = () =>
      withWorkspace(db, { workspaceId }, async (tx) =>
        JSON.stringify([
          await buildDeviceDashboard(tx, workspaceId, dashboard.id, { now }),
          await buildDeviceDashboardV2(tx, workspaceId, dashboard.id, { now }),
        ]),
      );
    const before = await payloads();
    // Custom layouts written directly, so the version stays the same.
    const [sales] = dashboard.slides;
    await admin`
      insert into dashboard_slide_layouts (slide_id, format, workspace_id,
        dashboard_id, pages)
      values (${sales!.id}, '9x16', ${workspaceId}, ${dashboard.id}, 1)`;
    for (const placement of portrait(sales!).placements) {
      await admin`
        insert into dashboard_widget_layouts (widget_id, format, slide_id,
          workspace_id, page, x, y, w, h)
        values (${placement.widgetId}, '9x16', ${sales!.id}, ${workspaceId},
          0, ${placement.x}, ${placement.y}, ${placement.w}, ${placement.h})`;
    }
    expect((await get(dashboard.id)).slides[0]!.layouts).toHaveLength(1);
    expect(await payloads()).toBe(before);
  });
});

describe("readability per format (#280)", () => {
  /** Fits half the 16:9 grid; needs three lines at half a portrait grid. */
  const LONG =
    "Registrierungen · Durchschnittliche Bestellwerte aller Neukunden";

  const codes = (slide: DashboardSlide) =>
    slide.formatWarnings.map(
      (warning) =>
        `${warning.format} ${warning.code} ${warning.widgetId ?? "-"}${warning.pages === null ? "" : ` ${warning.pages}`}`,
    );

  it("returns warnings per slide and format on GET and PUT", async () => {
    const dashboard = await create({
      slides: [
        {
          name: "Umsatz",
          widgets: [
            metric(0, 0, { w: 6, title: LONG }),
            metric(6, 0, { w: 6, title: LONG }),
            // Untitled: "Signups · All sites", short in every format.
            metric(0, 2),
          ],
        },
        { name: "Time", widgets: [clock(0, 0)] },
      ],
    });
    const [sales, time] = dashboard.slides;
    const [a, b] = sales!.widgets;
    expect(codes(sales!)).toEqual([
      `3x4 label_cut ${a!.id}`,
      `3x4 label_cut ${b!.id}`,
      `9x16 label_cut ${a!.id}`,
      `9x16 label_cut ${b!.id}`,
    ]);
    expect(sales!.formatWarnings[0]).toEqual({
      format: "3x4",
      code: "label_cut",
      severity: "attention",
      widgetId: a!.id,
      pages: null,
      rows: null,
    });
    expect(time!.formatWarnings).toEqual([]);
    expect(await get(dashboard.id)).toEqual(dashboard);

    // A custom 9:16 layout: one widget full width, one hidden, the third
    // left for review; read-only warnings sent back are ignored.
    const [, , c] = sales!.widgets;
    const saved = parsed(
      await put(dashboard, {
        slides: [
          {
            ...sendable(sales!),
            formatWarnings: [],
            layouts: [
              {
                format: "9x16",
                pages: 1,
                placements: [
                  { widgetId: a!.id, page: 0, x: 0, y: 0, w: 6, h: 2 },
                  {
                    widgetId: b!.id,
                    page: 0,
                    x: 0,
                    y: 2,
                    w: 3,
                    h: 2,
                    hidden: true,
                  },
                  {
                    widgetId: c!.id,
                    page: 0,
                    x: 0,
                    y: 4,
                    w: 3,
                    h: 2,
                    autoPlaced: true,
                  },
                ],
              },
            ],
          },
          sendable(time!),
        ],
      }),
    );
    expect(codes(saved.slides[0]!)).toEqual([
      `3x4 label_cut ${a!.id}`,
      `3x4 label_cut ${b!.id}`,
      `9x16 widget_hidden ${b!.id}`,
      `9x16 widget_to_review ${c!.id}`,
    ]);
    expect(await get(dashboard.id)).toEqual(saved);
  });

  it("clock_parts_hidden: a 2 × 1 clock with the long date and zone line (info)", async () => {
    const options = { dateStyle: "long", showZone: true };
    const dashboard = await create({
      slides: [
        {
          name: "Time",
          widgets: [
            { type: "clock", x: 0, y: 0, w: 2, h: 1, options },
            { type: "clock", x: 0, y: 2, w: 3, h: 3, options },
          ],
        },
      ],
    });
    const [small, large] = dashboard.slides[0]!.widgets;
    expect(small!.options).toMatchObject(options);
    const primary = dashboard.slides[0]!.formatWarnings.filter(
      (warning) => warning.format === "16x9",
    );
    expect(primary).toEqual([
      {
        format: "16x9",
        code: "clock_parts_hidden",
        severity: "info",
        widgetId: small!.id,
        pages: null,
        rows: null,
      },
    ]);
    // The 3 × 3 clock shows all three lines in the primary format.
    expect(primary.some((warning) => warning.widgetId === large!.id)).toBe(
      false,
    );
  });

  it("reports continuation pages and a dashboard name too long for narrow headers", async () => {
    const dashboard = await create({
      name: "Unternehmenskennzahlen Vertrieb und Marketing Europa, Naher Osten und Afrika Q3",
      slides: [
        {
          name: "Alles",
          widgets: [
            metric(0, 0),
            metric(3, 0),
            metric(6, 0),
            metric(9, 0),
            metric(0, 2),
            metric(3, 2),
            metric(6, 2),
            metric(9, 2),
            line(0, 4, 12, 4),
          ],
        },
      ],
    });
    const warnings = dashboard.slides[0]!.formatWarnings;
    expect(
      warnings.filter((warning) => warning.code === "header_name_cut"),
    ).toEqual(
      ["4x3", "3x4", "9x16"].map((format) => ({
        format,
        code: "header_name_cut",
        severity: "attention",
        widgetId: null,
        pages: null,
        rows: null,
      })),
    );
    expect(
      warnings.filter((warning) => warning.code === "continues"),
    ).toContainEqual({
      format: "3x4",
      code: "continues",
      severity: "info",
      widgetId: null,
      pages: 2,
      rows: null,
    });
    // Without the header only the pages remain.
    const hidden = parsed(
      await put(dashboard, {
        settings: { ...dashboard.settings, showHeader: false },
        slides: dashboard.slides.map((slide) => sendable(slide)),
      }),
    );
    expect(
      hidden.slides[0]!.formatWarnings.every(
        (warning) => warning.code === "continues",
      ),
    ).toBe(true);
  });

  it("computes the warnings with labels in the reader's language", async () => {
    const dashboard = await create();
    const german = await app.inject({
      method: "GET",
      url: `${base()}/${dashboard.id}`,
      headers: { cookie: owner, "accept-language": "de" },
    });
    // "Registrierungen · Alle Websites" fits as "Signups · All sites" does.
    expect(parsed(german).slides.map((slide) => slide.formatWarnings)).toEqual(
      dashboard.slides.map((slide) => slide.formatWarnings),
    );
  });
});
