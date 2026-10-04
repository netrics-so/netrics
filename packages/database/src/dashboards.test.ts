import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as authSchema from "./auth-schema.js";
import { withWorkspace } from "./context.js";
import {
  findDashboard,
  insertDashboard,
  listDashboards,
  replaceDashboard,
  schema1Tiles,
  type Dashboard,
  type SlideInput,
  type WidgetInput,
} from "./dashboards.js";
import * as schema from "./schema.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

let testDb: TestDatabase;
let admin: postgres.Sql;
let appClient: postgres.Sql;
let db: PostgresJsDatabase<typeof schema & typeof authSchema>;
let workspaceA: string;
let workspaceB: string;
let connectionA: string;
let connectionB: string;

function metric(
  connectionId: string,
  overrides: Partial<WidgetInput> = {},
): WidgetInput {
  return {
    type: "metric",
    x: 0,
    y: 0,
    w: 3,
    h: 2,
    title: null,
    connectionId,
    metricKey: "visits",
    aggregation: "sum",
    period: "last_7_days",
    dimensions: {},
    displayCurrency: null,
    text: null,
    imageId: null,
    options: {},
    ...overrides,
  };
}

function slide(
  widgets: WidgetInput[],
  overrides: Partial<SlideInput> = {},
): SlideInput {
  return {
    name: null,
    durationSeconds: null,
    enabled: true,
    backgroundImageId: null,
    backgroundDim: 0,
    widgets,
    ...overrides,
  };
}

const widgetsOf = (dashboard: Dashboard | null | undefined) =>
  dashboard?.slides.flatMap((s) => s.widgets) ?? [];

function errorChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
}

async function expectDbError(promise: Promise<unknown>, pattern: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect(errorChain(error)).toMatch(pattern);
    return;
  }
  expect.unreachable("expected the query to fail");
}

const inA = <T>(run: Parameters<typeof withWorkspace<T>>[2]) =>
  withWorkspace(db, { workspaceId: workspaceA }, run);
const inB = <T>(run: Parameters<typeof withWorkspace<T>>[2]) =>
  withWorkspace(db, { workspaceId: workspaceB }, run);

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = postgres(testDb.adminUrl, { max: 1 });
  appClient = postgres(testDb.appUrl, { max: 2 });
  db = drizzle(appClient, { schema: { ...schema, ...authSchema } });
  await admin`insert into connectors (id, version, manifest)
              values ('demo', '1.0.0', '{"id":"demo"}'::jsonb)`;
  const [a] =
    await admin`insert into workspaces (name) values ('A') returning id`;
  const [b] =
    await admin`insert into workspaces (name) values ('B') returning id`;
  workspaceA = a!.id as string;
  workspaceB = b!.id as string;
  const [ca] =
    await admin`insert into connections (workspace_id, connector_id, name)
                           values (${workspaceA}, 'demo', 'A') returning id`;
  const [cb] =
    await admin`insert into connections (workspace_id, connector_id, name)
                           values (${workspaceB}, 'demo', 'B') returning id`;
  connectionA = ca!.id as string;
  connectionB = cb!.id as string;
}, 30_000);

afterAll(async () => {
  await admin.end({ timeout: 5 }).catch(() => undefined);
  await appClient.end({ timeout: 5 }).catch(() => undefined);
});

describe("dashboards", () => {
  it("stores slides of widgets and keeps them to their workspace", async () => {
    const created = await inA((tx) =>
      insertDashboard(tx, workspaceA, {
        name: "Overview",
        projectId: null,
        slides: [
          slide([
            metric(connectionA, { x: 3 }),
            metric(connectionA, { metricKey: "b", period: "today" }),
          ]),
          slide(
            [
              {
                ...metric(connectionA),
                type: "text",
                connectionId: null,
                metricKey: null,
                aggregation: null,
                period: null,
                text: "## Hello",
              },
            ],
            { name: "Notes", durationSeconds: 30 },
          ),
        ],
      }),
    );
    expect(created).toMatchObject({
      version: 1,
      showHeader: true,
      autoAdvance: true,
      defaultSlideSeconds: 20,
      transition: "fade",
    });
    expect(
      created.slides.map((s) => [s.position, s.name, s.durationSeconds]),
    ).toEqual([
      [0, null, null],
      [1, "Notes", 30],
    ]);
    // Reading order on a slide: row, then column.
    expect(created.slides[0]!.widgets.map((w) => [w.x, w.metricKey])).toEqual([
      [0, "b"],
      [3, "visits"],
    ]);

    // Invisible from workspace B, by RLS and by the explicit predicate.
    expect(await inB((tx) => listDashboards(tx, workspaceB))).toEqual([]);
    expect(
      await inB((tx) => findDashboard(tx, workspaceA, created.id)),
    ).toBeNull();
    expect(
      await inB((tx) => findDashboard(tx, workspaceB, created.id)),
    ).toBeNull();
    const hidden = await inB(async (tx) => ({
      slides: await tx.select().from(schema.dashboardSlides),
      widgets: await tx.select().from(schema.dashboardWidgets),
    }));
    expect(hidden).toEqual({ slides: [], widgets: [] });
    const [summary] = await inA((tx) => listDashboards(tx, workspaceA));
    expect(summary).toMatchObject({
      name: "Overview",
      tileCount: 2,
      slideCount: 2,
      widgetCount: 3,
    });
  });

  it("rejects a widget that points at another workspace's connection", async () => {
    await expectDbError(
      inA((tx) =>
        insertDashboard(tx, workspaceA, {
          name: "Sneaky",
          projectId: null,
          slides: [slide([metric(connectionB)])],
        }),
      ),
      /dashboard_widgets_connection_fk/,
    );
  });

  it("keeps widgets on a slide of their own dashboard and workspace", async () => {
    const a = await inA((tx) =>
      insertDashboard(tx, workspaceA, {
        name: "A",
        projectId: null,
        slides: [slide([])],
      }),
    );
    const other = await inA((tx) =>
      insertDashboard(tx, workspaceA, {
        name: "Other",
        projectId: null,
        slides: [slide([])],
      }),
    );
    const slideId = a.slides[0]!.id;
    // Even the owner cannot hang a widget on a slide of another dashboard
    // or move it into another workspace.
    for (const [dashboardId, workspaceId] of [
      [other.id, workspaceA],
      [a.id, workspaceB],
    ]) {
      await expectDbError(
        admin`insert into dashboard_widgets (slide_id, dashboard_id,
                workspace_id, type, x, y, w, h)
              values (${slideId}, ${dashboardId!}, ${workspaceId!}, 'clock',
                0, 0, 2, 1)`,
        /dashboard_widgets_slide_fk/,
      );
    }
    await expectDbError(
      admin`insert into dashboard_slides (dashboard_id, workspace_id, position)
            values (${a.id}, ${workspaceB}, 5)`,
      /dashboard_slides_dashboard_fk/,
    );
  });

  it("checks the grid and the columns of each type", async () => {
    const created = await inA((tx) =>
      insertDashboard(tx, workspaceA, {
        name: "Checks",
        projectId: null,
        slides: [slide([])],
      }),
    );
    const slideId = created.slides[0]!.id;
    const insert = (columns: string, values: string) =>
      admin.unsafe(
        `insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
           type, x, y, w, h${columns})
         values ('${slideId}', '${created.id}', '${workspaceA}', ${values})`,
      );
    const data = `, connection_id, metric_key, aggregation, period`;
    const binding = `, '${connectionA}', 'visits', 'sum', 'today'`;
    // The largest grid of any format (16 × 14, ADR 0017); the service
    // checks the primary format's own grid.
    await expectDbError(
      insert("", `'clock', 15, 0, 2, 1`),
      /dashboard_widgets_grid_valid/,
    );
    await expectDbError(
      insert("", `'clock', 0, 13, 2, 2`),
      /dashboard_widgets_grid_valid/,
    );
    await expectDbError(
      insert("", `'clock', -1, 0, 2, 1`),
      /dashboard_widgets_grid_valid/,
    );
    await expectDbError(
      insert("", `'chart', 0, 0, 2, 1`),
      /dashboard_widgets_type_valid/,
    );
    // A metric widget needs its metric; a clock or text has none.
    await expectDbError(
      insert("", `'metric', 0, 0, 3, 2`),
      /dashboard_widgets_type_columns/,
    );
    await expectDbError(
      insert(data, `'clock', 0, 0, 2, 1${binding}`),
      /dashboard_widgets_type_columns/,
    );
    await expectDbError(
      insert("", `'text', 0, 0, 2, 1`),
      /dashboard_widgets_type_columns/,
    );
    await expectDbError(
      insert(", text", `'text', 0, 0, 2, 1, '${"x".repeat(501)}'`),
      /dashboard_widgets_text_valid/,
    );
    await insert(data, `'line', 0, 0, 4, 3${binding}`);
    await insert(", text", `'text', 4, 0, 2, 1, 'Hi'`);
    await insert("", `'clock', 10, 7, 2, 1`);
    await expectDbError(
      admin`update dashboards set default_slide_seconds = 4
            where id = ${created.id}`,
      /dashboards_default_slide_seconds_valid/,
    );
    await expectDbError(
      admin`update dashboards set transition = 'slide'
            where id = ${created.id}`,
      /dashboards_transition_valid/,
    );
  });

  it("refuses to create a dashboard in another workspace under RLS", async () => {
    await expectDbError(
      inA((tx) =>
        insertDashboard(tx, workspaceB, {
          name: "Foreign",
          projectId: null,
          slides: [],
        }),
      ),
      /row-level security/,
    );
  });

  it("replaces everything when the version matches, keeping known ids", async () => {
    const created = await inA((tx) =>
      insertDashboard(tx, workspaceA, {
        name: "Draft",
        projectId: null,
        slides: [slide([metric(connectionA)]), slide([])],
      }),
    );
    const [first, second] = created.slides;
    const widgetId = first!.widgets[0]!.id;
    // A widget id of another dashboard is not taken over.
    const foreign = await inA((tx) =>
      insertDashboard(tx, workspaceA, {
        name: "Foreign",
        projectId: null,
        slides: [slide([metric(connectionA)])],
      }),
    );
    const foreignWidget = widgetsOf(foreign)[0]!.id;

    const replaced = await inA((tx) =>
      replaceDashboard(tx, workspaceA, created.id, 1, {
        name: "Final",
        projectId: null,
        settings: { autoAdvance: false, transition: "none" },
        slides: [
          // The slides swap places; the widget moves to the other slide.
          slide([metric(connectionA, { id: widgetId, metricKey: "x" })], {
            id: second!.id,
          }),
          slide(
            [
              metric(connectionA, { id: foreignWidget, metricKey: "y" }),
              metric(connectionA, { id: widgetId, x: 3, metricKey: "z" }),
            ],
            { id: first!.id },
          ),
        ],
      }),
    );
    expect(replaced.status).toBe("ok");
    const dashboard = replaced.status === "ok" ? replaced.dashboard : null;
    expect(dashboard).toMatchObject({
      name: "Final",
      version: 2,
      autoAdvance: false,
      transition: "none",
      showHeader: true,
    });
    expect(dashboard!.slides.map((s) => s.id)).toEqual([second!.id, first!.id]);
    const widgets = widgetsOf(dashboard);
    expect(widgets.map((w) => w.metricKey)).toEqual(["x", "y", "z"]);
    expect(widgets[0]!.id).toBe(widgetId);
    expect(widgets[1]!.id).not.toBe(foreignWidget);
    expect(widgets[2]!.id).not.toBe(widgetId);
    expect(
      widgetsOf(
        await inA((tx) => findDashboard(tx, workspaceA, foreign.id)),
      )[0]!.id,
    ).toBe(foreignWidget);

    // A writer still holding version 1 must not overwrite version 2.
    const stale = await inA((tx) =>
      replaceDashboard(tx, workspaceA, created.id, 1, {
        name: "Stale",
        projectId: null,
        slides: [],
      }),
    );
    expect(stale).toEqual({ status: "version_conflict", currentVersion: 2 });
    const current = await inA((tx) =>
      findDashboard(tx, workspaceA, created.id),
    );
    expect(current).toMatchObject({ name: "Final", version: 2 });
    expect(widgetsOf(current)).toHaveLength(3);

    // Another workspace cannot even see it.
    expect(
      await inB((tx) =>
        replaceDashboard(tx, workspaceB, created.id, 2, {
          name: "Hijack",
          projectId: null,
          slides: [],
        }),
      ),
    ).toEqual({ status: "not_found" });
  });

  it("mirrors the schema 1 tiles into dashboard_tiles", async () => {
    const created = await inA((tx) =>
      insertDashboard(tx, workspaceA, {
        name: "Mirror",
        projectId: null,
        slides: [
          slide([metric(connectionA, { metricKey: "off" })], {
            enabled: false,
          }),
          slide([
            metric(connectionA, { x: 3, y: 0, metricKey: "second" }),
            metric(connectionA, { x: 0, y: 2, metricKey: "third" }),
            metric(connectionA, { x: 0, y: 0, metricKey: "first" }),
          ]),
        ],
      }),
    );
    expect(schema1Tiles(created.slides).map((w) => w.metricKey)).toEqual([
      "first",
      "second",
      "third",
    ]);
    const rows = await admin`
      select id, metric_key, position from dashboard_tiles
      where dashboard_id = ${created.id} order by position`;
    expect(rows.map((row) => [row.metric_key, row.position])).toEqual([
      ["first", 0],
      ["second", 1],
      ["third", 2],
    ]);
    expect(rows[0]!.id).toBe(created.slides[1]!.widgets[0]!.id);
  });

  it("drops a deleted connection's widgets", async () => {
    const [extra] =
      await admin`insert into connections (workspace_id, connector_id, name)
                                values (${workspaceA}, 'demo', 'Temp') returning id`;
    const created = await inA((tx) =>
      insertDashboard(tx, workspaceA, {
        name: "Temp",
        projectId: null,
        slides: [
          slide([metric(connectionA), metric(extra!.id as string, { x: 3 })]),
        ],
      }),
    );
    await admin`delete from connections where id = ${extra!.id}`;
    const after = await inA((tx) => findDashboard(tx, workspaceA, created.id));
    expect(widgetsOf(after).map((w) => w.connectionId)).toEqual([connectionA]);
  });
});

describe("custom layouts (ADR 0017)", () => {
  const clock = (overrides: Partial<WidgetInput> = {}): WidgetInput => ({
    ...metric(connectionA),
    type: "clock",
    connectionId: null,
    metricKey: null,
    aggregation: null,
    period: null,
    w: 2,
    h: 1,
    ...overrides,
  });
  const place = (
    widget: number,
    overrides: Partial<{
      page: number;
      x: number;
      y: number;
      w: number;
      h: number;
      hidden: boolean;
      autoPlaced: boolean;
    }> = {},
  ) => ({
    widget,
    page: 0,
    x: 0,
    y: widget,
    w: 2,
    h: 1,
    hidden: false,
    autoPlaced: false,
    ...overrides,
  });

  async function withLayouts() {
    return inA((tx) =>
      insertDashboard(tx, workspaceA, {
        name: "Formats",
        projectId: null,
        slides: [
          slide([clock(), clock({ x: 2 })], {
            layouts: [
              {
                format: "9x16",
                pages: 2,
                placements: [place(0), place(1, { page: 1, autoPlaced: true })],
              },
              {
                format: "4x3",
                pages: 1,
                placements: [place(0), place(1, { hidden: true })],
              },
            ],
          }),
          slide([clock()]),
        ],
      }),
    );
  }

  it("stores a primary format and custom layouts per slide and format", async () => {
    const plain = await inA((tx) =>
      insertDashboard(tx, workspaceA, {
        name: "Plain",
        projectId: null,
        slides: [slide([clock()])],
      }),
    );
    expect(plain.primaryFormat).toBe("16x9");
    expect(plain.slides[0]!.layouts).toEqual([]);

    const created = await withLayouts();
    const [first, second] = created.slides;
    const [a, b] = first!.widgets;
    // Formats in their fixed order, placements in widget order.
    expect(first!.layouts).toEqual([
      {
        format: "4x3",
        pages: 1,
        placements: [
          { widgetId: a!.id, ...place(0), widget: undefined },
          { widgetId: b!.id, ...place(1, { hidden: true }), widget: undefined },
        ].map(({ widget: _, ...rest }) => rest),
      },
      {
        format: "9x16",
        pages: 2,
        placements: [
          { widgetId: a!.id, ...place(0) },
          { widgetId: b!.id, ...place(1, { page: 1, autoPlaced: true }) },
        ].map(({ widget: _, ...rest }) => rest),
      },
    ]);
    expect(second!.layouts).toEqual([]);
    expect(
      await inA((tx) => findDashboard(tx, workspaceA, created.id)),
    ).toEqual(created);

    const moved = await inA((tx) =>
      insertDashboard(tx, workspaceA, {
        name: "Portrait",
        projectId: null,
        primaryFormat: "9x16",
        slides: [slide([clock({ y: 12, h: 2 })])],
      }),
    );
    expect(moved.primaryFormat).toBe("9x16");
    expect(moved.slides[0]!.widgets[0]).toMatchObject({ y: 12, h: 2 });
  });

  it("keeps layouts to their workspace (RLS and composite keys)", async () => {
    const created = await withLayouts();
    const slideId = created.slides[0]!.id;
    const widgetId = created.slides[0]!.widgets[0]!.id;
    const hidden = await inB(async (tx) => ({
      slides: await tx.select().from(schema.dashboardSlideLayouts),
      widgets: await tx.select().from(schema.dashboardWidgetLayouts),
    }));
    expect(hidden).toEqual({ slides: [], widgets: [] });
    // Under RLS, workspace B cannot write a layout row of workspace A, nor
    // hang its own on A's slide.
    await expectDbError(
      inB((tx) =>
        tx.insert(schema.dashboardSlideLayouts).values({
          slideId,
          format: "21x9",
          workspaceId: workspaceA,
          dashboardId: created.id,
          pages: 1,
        }),
      ),
      /row-level security/,
    );
    await expectDbError(
      inB((tx) =>
        tx.insert(schema.dashboardSlideLayouts).values({
          slideId,
          format: "21x9",
          workspaceId: workspaceB,
          dashboardId: created.id,
          pages: 1,
        }),
      ),
      /dashboard_slide_layouts_slide_fk/,
    );
    // Even the owner cannot move a placement into another workspace or onto
    // a widget of another slide.
    await expectDbError(
      admin`insert into dashboard_widget_layouts (widget_id, format, slide_id,
              workspace_id, page, x, y, w, h)
            values (${widgetId}, '21x9', ${slideId}, ${workspaceB},
              0, 0, 0, 2, 1)`,
      /dashboard_widget_layouts_(widget|layout)_fk/,
    );
    await admin`insert into dashboard_slide_layouts (slide_id, format,
                  workspace_id, dashboard_id, pages)
                values (${created.slides[1]!.id}, '3x4', ${workspaceA},
                  ${created.id}, 1)`;
    await expectDbError(
      admin`insert into dashboard_widget_layouts (widget_id, format, slide_id,
              workspace_id, page, x, y, w, h)
            values (${widgetId}, '3x4', ${created.slides[1]!.id},
              ${workspaceA}, 0, 0, 0, 2, 1)`,
      /dashboard_widget_layouts_widget_fk/,
    );
    // B's update and delete see nothing.
    const touched = await inB(async (tx) => ({
      updated: await tx
        .update(schema.dashboardWidgetLayouts)
        .set({ autoPlaced: false })
        .returning(),
      deleted: await tx.delete(schema.dashboardSlideLayouts).returning(),
    }));
    expect(touched).toEqual({ updated: [], deleted: [] });
    expect(
      (await inA((tx) => findDashboard(tx, workspaceA, created.id)))!.slides[0]!
        .layouts,
    ).toHaveLength(2);
  });

  it("checks formats, pages and the largest grid", async () => {
    const created = await withLayouts();
    const slideId = created.slides[1]!.id;
    const widgetId = created.slides[1]!.widgets[0]!.id;
    const layout = (format: string, pages: number) =>
      admin`insert into dashboard_slide_layouts (slide_id, format,
              workspace_id, dashboard_id, pages)
            values (${slideId}, ${format}, ${workspaceA}, ${created.id},
              ${pages})`;
    await expectDbError(
      layout("16x10", 1),
      /dashboard_slide_layouts_format_valid/,
    );
    await expectDbError(
      layout("21x9", 9),
      /dashboard_slide_layouts_pages_valid/,
    );
    await expectDbError(
      layout("21x9", 0),
      /dashboard_slide_layouts_pages_valid/,
    );
    await layout("21x9", 8);
    const placement = (page: number, x: number, y: number, w: number) =>
      admin`insert into dashboard_widget_layouts (widget_id, format, slide_id,
              workspace_id, page, x, y, w, h)
            values (${widgetId}, '21x9', ${slideId}, ${workspaceA}, ${page},
              ${x}, ${y}, ${w}, 1)`;
    await expectDbError(
      placement(8, 0, 0, 2),
      /dashboard_widget_layouts_page_valid/,
    );
    await expectDbError(
      placement(0, 15, 0, 2),
      /dashboard_widget_layouts_grid_valid/,
    );
    await expectDbError(
      placement(0, 0, 14, 2),
      /dashboard_widget_layouts_grid_valid/,
    );
    await placement(7, 14, 13, 2);
  });

  it("drops placements with their widget, and layouts with their slide", async () => {
    const created = await withLayouts();
    const [first, second] = created.slides;
    await admin`delete from dashboard_widgets where id = ${first!.widgets[1]!.id}`;
    const after = await inA((tx) => findDashboard(tx, workspaceA, created.id));
    expect(
      after!.slides[0]!.layouts.map((layout) => [
        layout.format,
        layout.placements.map((placement) => placement.widgetId),
      ]),
    ).toEqual([
      ["4x3", [first!.widgets[0]!.id]],
      ["9x16", [first!.widgets[0]!.id]],
    ]);
    await admin`delete from dashboard_slides where id = ${first!.id}`;
    const [counts] = await admin`
      select (select count(*)::int from dashboard_slide_layouts
                where dashboard_id = ${created.id}) as slides,
             (select count(*)::int from dashboard_widget_layouts
                where slide_id = ${first!.id}) as widgets`;
    expect({ ...counts }).toEqual({ slides: 0, widgets: 0 });
    expect(second).toBeDefined();
  });

  it("replaces layouts with the slides, keeping widget ids", async () => {
    const created = await withLayouts();
    const [first] = created.slides;
    const replaced = await inA((tx) =>
      replaceDashboard(tx, workspaceA, created.id, created.version, {
        name: created.name,
        projectId: null,
        slides: [
          slide(
            [
              clock({ id: first!.widgets[1]!.id, x: 4 }),
              // A new widget, placed by its index.
              clock({ x: 8 }),
            ],
            {
              id: first!.id,
              layouts: [
                {
                  format: "3x4",
                  pages: 1,
                  placements: [place(0), place(1, { autoPlaced: true })],
                },
              ],
            },
          ),
        ],
      }),
    );
    expect(replaced.status).toBe("ok");
    if (replaced.status !== "ok") return;
    const [only] = replaced.dashboard.slides;
    expect(only!.id).toBe(first!.id);
    const ids = only!.widgets.map((widget) => widget.id);
    expect(ids).toContain(first!.widgets[1]!.id);
    expect(only!.layouts).toEqual([
      {
        format: "3x4",
        pages: 1,
        placements: only!.widgets.map((widget) => ({
          widgetId: widget.id,
          page: 0,
          x: 0,
          y: widget.id === first!.widgets[1]!.id ? 0 : 1,
          w: 2,
          h: 1,
          hidden: false,
          autoPlaced: widget.id !== first!.widgets[1]!.id,
        })),
      },
    ]);
  });
});
