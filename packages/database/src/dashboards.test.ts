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
    await expectDbError(
      insert("", `'clock', 11, 0, 2, 1`),
      /dashboard_widgets_grid_valid/,
    );
    await expectDbError(
      insert("", `'clock', 0, 7, 2, 2`),
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
