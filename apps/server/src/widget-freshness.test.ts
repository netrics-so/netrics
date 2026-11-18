import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  deviceDashboardV2ResponseSchema,
  deviceDashboardV3ResponseSchema,
  type DeviceDashboardV2Response,
  type DeviceWidget,
} from "@netrics/contracts";
import type { ConnectorManifest } from "@netrics/connector-sdk";
import {
  createDatabase,
  createRawSqlClient,
  findDashboard,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";
import {
  DEFAULT_DATA_POLICY,
  type DashboardDataFilter,
  type SlideFilterScope,
} from "@netrics/domain";

import {
  queryDashboardData,
  queryDashboardMeasure,
} from "./dashboards/data.js";
import {
  createFreshnessReader,
  modelFreshnessDependencies,
  type FreshnessManifests,
} from "./dashboards/freshness.js";
import { createDataService } from "./data/service.js";
import {
  buildDeviceDashboard,
  buildDeviceDashboardV2,
  buildDeviceDashboardV3,
} from "./devices/dashboard.js";
import { createDeviceService } from "./devices/service.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// Freshness in widget data and the device payload (ADR 0025 sections 6 and
// 7, #704): which streams a widget depends on, the least fresh of their
// stored rows, and payloads that stay as they were without freshness.

const NOW = new Date("2026-11-16T12:00:00Z");
const MINUTE = 60_000,
  HOUR = 60 * MINUTE;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

/** A connector with every kind of stream; only its streams matter here. */
const manifest = {
  id: "fresh",
  name: "Fresh",
  supportsResourceSelection: true,
  metrics: [],
  translations: {
    de: { freshnessStreams: { sales: "Verkäufe", analytics: "Analysen" } },
  },
  freshnessStreams: [
    {
      key: "sales",
      name: "Sales",
      kind: "periodic",
      timeZone: "America/Los_Angeles",
      metrics: ["fresh.sales"],
      datasets: ["sales_rows"],
    },
    {
      key: "analytics",
      name: "Analytics",
      kind: "periodic",
      timeZone: "America/Los_Angeles",
      metrics: ["fresh.views"],
    },
    {
      key: "earnings",
      name: "Earnings",
      kind: "periodic",
      period: "month",
      timeZone: "America/Los_Angeles",
      metrics: ["fresh.revenue"],
    },
    {
      key: "reviews",
      name: "Reviews",
      kind: "continuous",
      metrics: ["fresh.rating"],
    },
  ],
} as unknown as ConnectorManifest;
const manifests: FreshnessManifests = {
  get: (id) => (id === "fresh" ? { manifest } : undefined),
};

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
let owner: Sql;
let db: Database;
let workspaceId: string;
let otherWorkspaceId: string;
let callerId: string;
/** Connections by scenario. */
const c: Record<string, string> = {};
const metricIds: Record<string, string> = {};
let salesDatasetId: string;
let modelId: string;
let dashboardId: string;
let quietDashboardId: string;
let measureDashboardId: string;
let deviceId: string;
let boardDashboardId: string;
let boardDeviceId: string;

async function connection(
  name: string,
  fields: { workspace?: string; selection?: string[] } = {},
): Promise<string> {
  const workspace = fields.workspace ?? workspaceId;
  const [row] = await owner`
    insert into connections (workspace_id, connector_id, name, config)
    values (${workspace}, 'fresh', ${name},
      ${owner.json(fields.selection ? { resourceSelection: fields.selection } : {})})
    returning id`;
  const id = row!.id as string;
  await owner`
    insert into connection_state (connection_id, workspace_id,
      last_success_at, poll_interval_seconds, next_due_at)
    values (${id}, ${workspace}, ${at(-5 * MINUTE)}, 21600,
      ${at(2 * HOUR)})`;
  await owner`
    insert into connection_resources (connection_id, workspace_id,
      resource_id, name, kind)
    values (${id}, ${workspace}, 'app-1', 'Wurfel', 'app'),
           (${id}, ${workspace}, 'app-2', 'voilà', 'app')`;
  // Yesterday's numbers of every metric for both apps: widgets are `ok`.
  for (const resource of ["app-1", "app-2"])
    await owner`
      insert into observations (workspace_id, connection_id,
        metric_definition_id, dimensions, source_timestamp, value)
      select ${workspace}, ${id}, m.id, ${owner.json({ resource })},
             '2026-11-15T00:00:00Z'::timestamptz, 7
      from metric_definitions m where m.connector_id = 'fresh'`;
  return id;
}

async function freshness(
  connectionId: string,
  stream: string,
  row: {
    resource?: string;
    dataThrough?: string | null;
    nextExpectedAt?: Date | null;
    checkedAt: Date;
    workspace?: string;
  },
) {
  const date = row.dataThrough ?? null;
  await owner`
    insert into connection_freshness (workspace_id, connection_id, stream,
      resource, data_through, time_zone, next_expected_at, checked_at,
      advanced_at)
    values (${row.workspace ?? workspaceId}, ${connectionId}, ${stream},
      ${row.resource ?? ""}, ${date},
      ${date === null ? null : "America/Los_Angeles"},
      ${row.nextExpectedAt ?? null}, ${row.checkedAt},
      ${date === null ? null : row.checkedAt})`;
}

let widgetCount = 0;
async function widget(
  dashboard: string,
  slide: string,
  fields: Record<string, unknown>,
): Promise<string> {
  const { options, dimensions, model_binding, ...rest } = fields;
  const [row] = await owner`
    insert into dashboard_widgets ${owner({
      slide_id: slide,
      dashboard_id: dashboard,
      workspace_id: workspaceId,
      x: 0,
      y: widgetCount++,
      w: 3,
      h: 1,
      ...rest,
      ...(model_binding === undefined
        ? {}
        : { model_binding: owner.json(model_binding as never) }),
    })} returning id`;
  await owner`
    update dashboard_widgets
    set options = ${owner.json((options ?? {}) as never)},
        dimensions = ${owner.json((dimensions ?? {}) as never)}
    where id = ${row!.id as string}`;
  return row!.id as string;
}

const metricWidget = (
  connectionId: string,
  metricKey: string,
  title: string,
  fields: Record<string, unknown> = {},
) => ({
  type: "metric",
  title,
  connection_id: connectionId,
  metric_key: metricKey,
  aggregation: "sum",
  period: "last_7_days",
  ...fields,
});

async function dashboardWith(name: string) {
  const [dashboard] = await owner`
    insert into dashboards (workspace_id, name) values (${workspaceId}, ${name})
    returning id`;
  return dashboard!.id as string;
}

async function slideOf(dashboard: string, position: number, scope = {}) {
  const [slide] = await owner`
    insert into dashboard_slides (dashboard_id, workspace_id, position, scope)
    values (${dashboard}, ${workspaceId}, ${position}, ${owner.json(scope)})
    returning id`;
  return slide!.id as string;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  owner = createRawSqlClient(testDb.adminUrl, {
    max: 1,
    onnotice: () => undefined,
  });
  await owner`insert into connectors (id, version, manifest) values
    ('fresh', '1.0.0', ${owner.json({ id: "fresh" })})`;
  for (const key of [
    "fresh.sales",
    "fresh.views",
    "fresh.revenue",
    "fresh.rating",
    "fresh.other",
  ]) {
    const [metric] = await owner`
      insert into metric_definitions (connector_id, key, name, description,
        kind, unit, granularity, dimensions, aggregations)
      values ('fresh', ${key}, ${key}, '', 'delta', 'count', 'day',
        '["resource"]', '["sum"]')
      returning id`;
    metricIds[key] = metric!.id as string;
  }
  const [user] = await owner`
    insert into users (email, display_name)
    values ('freshness@example.test', 'Owner') returning id`;
  callerId = user!.id as string;
  const [workspace] = await owner`
    insert into workspaces (name, time_zone) values ('W', 'Europe/Berlin')
    returning id`;
  workspaceId = workspace!.id as string;
  await owner`insert into memberships (workspace_id, user_id, role)
    values (${workspaceId}, ${callerId}, 'owner')`;
  const [other] = await owner`
    insert into workspaces (name) values ('Other') returning id`;
  otherWorkspaceId = other!.id as string;

  c.periodic = await connection("Periodic", { selection: ["app-1", "app-2"] });
  c.late = await connection("Late");
  c.overdue = await connection("Overdue");
  c.continuous = await connection("Continuous");
  c.monthly = await connection("Monthly");
  c.none = await connection("Without rows");
  c.other = await connection("Other workspace", {
    workspace: otherWorkspaceId,
  });

  // Sales: one report for the connection. Analytics: per app.
  await freshness(c.periodic, "sales", {
    dataThrough: "2026-11-14",
    nextExpectedAt: at(8 * HOUR),
    checkedAt: at(-5 * MINUTE),
  });
  await freshness(c.periodic, "analytics", {
    resource: "app-1",
    dataThrough: "2026-11-13",
    nextExpectedAt: at(8 * HOUR),
    checkedAt: at(-5 * MINUTE),
  });
  await freshness(c.periodic, "analytics", {
    resource: "app-2",
    dataThrough: "2026-11-12",
    nextExpectedAt: at(9 * HOUR),
    checkedAt: at(-10 * MINUTE),
  });
  // An app outside the selection is ignored.
  await freshness(c.periodic, "analytics", {
    resource: "app-9",
    dataThrough: "2026-10-01",
    checkedAt: at(-HOUR),
  });
  // A sync 23 h 59 min after the expected time: late, not yet overdue.
  await freshness(c.late, "sales", {
    dataThrough: "2026-11-14",
    nextExpectedAt: at(-25 * HOUR),
    checkedAt: at(-HOUR - MINUTE),
  });
  // Exactly 24 h after: overdue.
  await freshness(c.overdue, "sales", {
    dataThrough: "2026-11-14",
    nextExpectedAt: at(-25 * HOUR),
    checkedAt: at(-HOUR),
  });
  await freshness(c.continuous, "reviews", { checkedAt: at(-20 * MINUTE) });
  await freshness(c.monthly, "earnings", {
    dataThrough: "2026-10-31",
    nextExpectedAt: new Date("2026-11-18T20:00:00Z"),
    checkedAt: at(-5 * MINUTE),
  });
  // Credentials refused, a grant to renew: the scheduler skips both.
  c.authFailed = await connection("Auth failed");
  c.reauth = await connection("Reauthorize");
  await owner`
    update connection_state set auth_state = 'auth_failed'
    where connection_id = ${c.authFailed}`;
  await owner`
    update connection_state set auth_state = 'needs_reauthorization'
    where connection_id = ${c.reauth}`;
  for (const id of [c.authFailed, c.reauth])
    await freshness(id, "sales", {
      dataThrough: "2026-11-14",
      nextExpectedAt: at(8 * HOUR),
      checkedAt: at(-5 * MINUTE),
    });
  await freshness(c.other, "sales", {
    dataThrough: "2026-11-01",
    checkedAt: at(-HOUR),
    workspace: otherWorkspaceId,
  });

  const [dataset] = await owner`
    insert into data_datasets (workspace_id, connection_id, kind, key, name)
    values (${workspaceId}, ${c.periodic}, 'source', 'sales_rows', 'Sales')
    returning id`;
  salesDatasetId = dataset!.id as string;

  db = createDatabase(testDb.appUrl, { max: 2 });

  // A measure model over the views observations, read through a
  // preparation (as store templates read theirs).
  const service = createDataService(db, () => NOW);
  const actor = { workspaceId, callerId };
  const observation = `observation:${c.periodic}:${metricIds["fresh.views"]}`;
  const preparation = await service.savePreparation(actor, {
    name: "Views",
    graph: {
      version: 1,
      nodes: [{ id: "source", type: "source", datasetId: observation }],
      outputs: ["source"],
    },
  });
  await service.publishPreparation(actor, preparation.preparation.id, 1);
  const prepared = `prepared:${preparation.preparation.id}:source`;
  const model = await service.saveModel(actor, {
    name: "Views",
    definition: {
      version: 1,
      datasets: [prepared],
      relationships: [],
      dimensions: [
        {
          id: "day",
          name: "Day",
          datasetId: prepared,
          fieldId: "time",
          timeAlignment: "reporting_date",
        },
      ],
      measures: [
        {
          id: "views",
          name: "Views",
          kind: "aggregate",
          datasetId: prepared,
          aggregate: {
            id: "views",
            name: "Views",
            op: "sum",
            fieldId: "value",
          },
        },
      ],
    },
  });
  await service.publishModel(actor, model.model.id, 1);
  modelId = model.model.id;

  dashboardId = await dashboardWith("Freshness");
  const slide = await slideOf(dashboardId, 0);
  await widget(
    dashboardId,
    slide,
    metricWidget(c.periodic, "fresh.sales", "Sales"),
  );
  await widget(
    dashboardId,
    slide,
    metricWidget(c.periodic, "fresh.views", "Views"),
  );
  await widget(
    dashboardId,
    slide,
    metricWidget(c.periodic, "fresh.other", "Other"),
  );
  await widget(dashboardId, slide, metricWidget(c.late, "fresh.sales", "Late"));
  await widget(
    dashboardId,
    slide,
    metricWidget(c.overdue, "fresh.sales", "Overdue"),
  );
  await widget(
    dashboardId,
    slide,
    metricWidget(c.continuous, "fresh.rating", "Rating", { type: "line" }),
  );
  await widget(
    dashboardId,
    slide,
    metricWidget(c.monthly, "fresh.revenue", "Revenue", {
      type: "bar",
      options: { groupBy: "resource" },
    }),
  );
  await widget(dashboardId, slide, metricWidget(c.none, "fresh.sales", "None"));
  // A slide scoped to app-1 (#707): its widgets read app-1's rows only.
  const scoped = await slideOf(dashboardId, 1, {
    app: { kind: "values", values: [`${c.periodic}:app-1`] },
  });
  await widget(
    dashboardId,
    scoped,
    metricWidget(c.periodic, "fresh.views", "Views of app-1"),
  );

  // Connections without rows only: a payload as before.
  quietDashboardId = await dashboardWith("Quiet");
  const quiet = await slideOf(quietDashboardId, 0);
  await widget(
    quietDashboardId,
    quiet,
    metricWidget(c.none, "fresh.sales", "A"),
  );
  await widget(
    quietDashboardId,
    quiet,
    metricWidget(c.none, "fresh.views", "B", { type: "line" }),
  );

  measureDashboardId = await dashboardWith("Measures");
  const measures = await slideOf(measureDashboardId, 0);
  await widget(measureDashboardId, measures, {
    type: "measure",
    title: "Views",
    model_id: modelId,
    model_binding: {
      modelId,
      measureIds: ["views"],
      groupBy: [],
      exclusions: [],
    },
    options: { view: "value", limit: 20 },
  });

  const [device] = await owner`
    insert into devices (workspace_id, name, dashboard_id)
    values (${workspaceId}, 'TV', ${dashboardId}) returning id`;
  deviceId = device!.id as string;

  // A status board over every source (#727).
  boardDashboardId = await dashboardWith("Board");
  await widget(boardDashboardId, await slideOf(boardDashboardId, 0), {
    type: "status",
    title: "Sources",
    y: 0,
    h: 3,
  });
  const [board] = await owner`
    insert into devices (workspace_id, name, dashboard_id)
    values (${workspaceId}, 'Board', ${boardDashboardId}) returning id`;
  boardDeviceId = board!.id as string;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await owner?.end({ timeout: 5 }).catch(() => undefined);
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
});

function v2(
  dashboard: string,
  options: { now?: Date; withRegistry?: boolean; locale?: "de" } = {},
) {
  return withWorkspace(db, { workspaceId }, (tx) =>
    buildDeviceDashboardV2(tx, workspaceId, dashboard, {
      now: options.now ?? NOW,
      ...(options.withRegistry === false ? {} : { freshness: manifests }),
      ...(options.locale ? { locale: options.locale } : {}),
    }),
  );
}

function byLabel(payload: DeviceDashboardV2Response, label: string) {
  const found = payload.slides
    .flatMap((slide) => slide.widgets)
    .find((widget) => "label" in widget && widget.label === label);
  if (!found) throw new Error(`no widget ${label}`);
  return found as Extract<DeviceWidget, { data: unknown }>;
}

const dataOf = (payload: DeviceDashboardV2Response, label: string) =>
  byLabel(payload, label).data as {
    status: string;
    freshness?: Record<string, unknown>;
  };

describe("device payload freshness (ADR 0025 §7)", () => {
  it("gives a metric widget its periodic stream", async () => {
    const payload = deviceDashboardV2ResponseSchema.parse(
      await v2(dashboardId),
    );
    expect(dataOf(payload, "Sales")).toMatchObject({
      status: "ok",
      freshness: {
        kind: "periodic",
        stream: "Sales",
        fetchedAt: at(-5 * MINUTE).toISOString(),
        dataThrough: "2026-11-14",
        nextExpectedAt: at(8 * HOUR).toISOString(),
        nextCheckAt: at(2 * HOUR).toISOString(),
      },
    });
    const { freshness } = dataOf(payload, "Sales");
    // No zone, no late flag, no period for a daily stream.
    expect(Object.keys(freshness!)).toEqual([
      "kind",
      "stream",
      "fetchedAt",
      "dataThrough",
      "nextExpectedAt",
      "nextCheckAt",
    ]);
  });

  it("shows the least fresh of a widget's resources, selected ones only", async () => {
    const payload = await v2(dashboardId);
    expect(dataOf(payload, "Views").freshness).toEqual({
      kind: "periodic",
      stream: "Analytics",
      // The oldest check of the rows used (app-9 is not selected).
      fetchedAt: at(-10 * MINUTE).toISOString(),
      dataThrough: "2026-11-12",
      nextExpectedAt: at(9 * HOUR).toISOString(),
      nextCheckAt: at(2 * HOUR).toISOString(),
    });
  });

  it("uses only the app's rows on a slide scoped to it", async () => {
    const payload = await v2(dashboardId);
    expect(dataOf(payload, "Views of app-1").freshness).toMatchObject({
      stream: "Analytics",
      fetchedAt: at(-5 * MINUTE).toISOString(),
      dataThrough: "2026-11-13",
      nextExpectedAt: at(8 * HOUR).toISOString(),
    });
  });

  it("keeps a provider late under 24 h `ok`, and makes it `stale` at 24 h", async () => {
    const payload = await v2(dashboardId);
    expect(dataOf(payload, "Late")).toMatchObject({
      status: "ok",
      freshness: { dataThrough: "2026-11-14", late: true },
    });
    expect(dataOf(payload, "Overdue")).toMatchObject({
      status: "stale",
      freshness: { dataThrough: "2026-11-14", late: true },
    });
  });

  it("words a continuous stream by its check only", async () => {
    const payload = await v2(dashboardId);
    expect(dataOf(payload, "Rating").freshness).toEqual({
      kind: "continuous",
      stream: "Reviews",
      fetchedAt: at(-20 * MINUTE).toISOString(),
      nextCheckAt: at(2 * HOUR).toISOString(),
    });
  });

  it("marks a monthly stream", async () => {
    const payload = await v2(dashboardId);
    expect(dataOf(payload, "Revenue").freshness).toEqual({
      kind: "periodic",
      stream: "Earnings",
      fetchedAt: at(-5 * MINUTE).toISOString(),
      dataThrough: "2026-10-31",
      period: "month",
      nextExpectedAt: "2026-11-18T20:00:00.000Z",
      nextCheckAt: at(2 * HOUR).toISOString(),
    });
  });

  it("names the stream in the payload's language", async () => {
    const payload = await v2(dashboardId, { locale: "de" });
    expect(dataOf(payload, "Sales").freshness?.stream).toBe("Verkäufe");
  });

  it("has no freshness for metrics in no stream or without rows", async () => {
    const payload = await v2(dashboardId);
    expect(dataOf(payload, "Other")).not.toHaveProperty("freshness");
    expect(dataOf(payload, "None")).not.toHaveProperty("freshness");
  });

  it("leaves payloads without freshness byte for byte as they were", async () => {
    const withRegistry = await v2(quietDashboardId);
    const without = await v2(quietDashboardId, { withRegistry: false });
    expect(JSON.stringify(withRegistry)).toBe(JSON.stringify(without));
    const v3 = (freshness: boolean) =>
      withWorkspace(db, { workspaceId }, (tx) =>
        buildDeviceDashboardV3(tx, workspaceId, quietDashboardId, {
          now: NOW,
          ...(freshness ? { freshness: manifests } : {}),
        }),
      );
    expect(JSON.stringify(await v3(true))).toBe(
      JSON.stringify(await v3(false)),
    );
  });

  it("never gives schema 1 tiles freshness", async () => {
    const v1 = (freshness: boolean) =>
      withWorkspace(db, { workspaceId }, (tx) =>
        buildDeviceDashboard(tx, workspaceId, dashboardId, {
          now: NOW,
          ...(freshness ? { freshness: manifests } : {}),
        }),
      );
    const tiles = await v1(true);
    expect(JSON.stringify(tiles)).toBe(JSON.stringify(await v1(false)));
    expect(JSON.stringify(tiles)).not.toContain("freshness");
  });

  it("keeps the version (ETag) across clock times with the same rows", async () => {
    let clock = NOW;
    const service = createDeviceService({
      db,
      pairingUrl: "https://pair.example.test",
      now: () => clock,
      payloadCacheMs: 0,
      registry: manifests,
    });
    const read = async (schema: 2 | 3) => {
      const result = await service.dashboard(
        { workspaceId, deviceId },
        undefined,
        schema,
      );
      if (!result.ok) throw new Error(result.error);
      return result.value as { version: string };
    };
    const first = await read(2);
    const firstV3 = deviceDashboardV3ResponseSchema.parse(await read(3));
    // Ten minutes on: the expected times of the late rows pass, nothing
    // stored changes.
    clock = at(10 * MINUTE);
    const second = await read(2);
    expect(second.version).toBe(first.version);
    expect((await read(3)).version).toBe(firstV3.version);
    expect(JSON.stringify(second)).toContain('"freshness"');
    // A stored change is a new version.
    await owner`
      update connection_freshness set checked_at = ${at(MINUTE)}
      where connection_id = ${c.late!}`;
    try {
      expect((await read(2)).version).not.toBe(first.version);
    } finally {
      await owner`
        update connection_freshness set checked_at = ${at(-HOUR - MINUTE)}
        where connection_id = ${c.late!}`;
    }
  });
});

describe("measure widget freshness (ADR 0025 §6)", () => {
  it("resolves the model's sources through its preparations", async () => {
    const payload = await v2(measureDashboardId);
    const data = dataOf(payload, "Views");
    expect(data.freshness).toEqual({
      kind: "periodic",
      stream: "Analytics",
      fetchedAt: at(-10 * MINUTE).toISOString(),
      dataThrough: "2026-11-12",
      nextExpectedAt: at(9 * HOUR).toISOString(),
      nextCheckAt: at(2 * HOUR).toISOString(),
    });
    // The web's dashboard data carries the same.
    const web = await withWorkspace(db, { workspaceId }, async (tx) => {
      const dashboard = await findDashboard(
        tx,
        workspaceId,
        measureDashboardId,
      );
      return queryDashboardData(
        tx,
        workspaceId,
        dashboard!.slides,
        dashboard!.dataFilters,
        {},
        NOW,
        DEFAULT_DATA_POLICY,
        "en",
        createFreshnessReader(workspaceId, manifests, "en"),
      );
    });
    expect(web.widgets[0]!.freshness).toEqual(data.freshness);
  });

  it("shows the least fresh of a model over two streams", async () => {
    const found = await withWorkspace(db, { workspaceId }, async (tx) => {
      const dependencies = await modelFreshnessDependencies(
        tx,
        workspaceId,
        {
          bindings: {
            // A source dataset of the sales stream, by its key …
            [salesDatasetId]: [],
            // … and the views observations of the analytics stream.
            [`observation:${c.periodic}:${metricIds["fresh.views"]}`]: [],
            // Resource names have no stream.
            [`resources:${c.periodic}`]: [],
          },
          dependencies: {},
        },
        {},
        [],
      );
      expect(dependencies).toEqual(
        expect.arrayContaining([
          { connectionId: c.periodic, datasetKey: "sales_rows" },
          { connectionId: c.periodic, metricKey: "fresh.views" },
        ]),
      );
      return createFreshnessReader(workspaceId, manifests).read(
        tx,
        dependencies,
      );
    });
    expect(found).toEqual({
      overdue: false,
      freshness: {
        kind: "periodic",
        stream: "Analytics",
        fetchedAt: at(-10 * MINUTE).toISOString(),
        dataThrough: "2026-11-12",
        nextExpectedAt: at(9 * HOUR).toISOString(),
        nextCheckAt: at(2 * HOUR).toISOString(),
      },
    });
  });

  it("follows the slide scope's app", async () => {
    const found = await withWorkspace(db, { workspaceId }, async (tx) =>
      createFreshnessReader(workspaceId, manifests).read(
        tx,
        await modelFreshnessDependencies(
          tx,
          workspaceId,
          {
            bindings: {
              [`observation:${c.periodic}:${metricIds["fresh.views"]}`]: [],
            },
            dependencies: {},
          },
          { app: { kind: "values", values: [`${c.periodic}:app-1`] } },
          [],
        ),
      ),
    );
    expect(found.freshness).toMatchObject({ dataThrough: "2026-11-13" });
  });

  it("follows a screen's scope as it follows a slide's", async () => {
    const data = await withWorkspace(db, { workspaceId }, (tx) =>
      queryDashboardMeasure(
        tx,
        workspaceId,
        {
          id: "33333333-3333-4333-8333-333333333333",
          binding: {
            modelId,
            measureIds: ["views"],
            groupBy: [],
            exclusions: [],
          },
          options: { view: "value", limit: 20 },
        },
        [],
        {},
        NOW,
        DEFAULT_DATA_POLICY,
        "en",
        // The screen shows app-1 only (#500).
        { app: { kind: "values", values: [`${c.periodic}:app-1`] } },
        {},
        createFreshnessReader(workspaceId, manifests),
      ),
    );
    expect(data.freshness).toMatchObject({
      dataThrough: "2026-11-13",
      fetchedAt: at(-5 * MINUTE).toISOString(),
    });
  });
});

describe("app slide freshness (#767)", () => {
  // An App Portfolio model over an App Store and a Google Play connection:
  // a slide's app, or its linked product, counts only its own apps' rows.
  const store: Record<string, string> = {};
  let storeModelId: string;
  let appFilter: DashboardDataFilter;
  let mappingDatasetId: string;

  beforeAll(async () => {
    store.apple = await connection("App Store");
    store.play = await connection("Google Play");
    const rows = [
      // The App Store app's ratings: checked today, the next one due.
      [store.apple, "app-1", "2026-11-15", at(8 * HOUR)],
      [store.apple, "app-2", "2026-11-14", at(7 * HOUR)],
      // Google Play's rating report: an older day and no next time.
      [store.play, "app-1", "2026-11-11", null],
      [store.play, "app-2", "2026-11-13", at(6 * HOUR)],
    ] as const;
    for (const [connectionId, resource, dataThrough, nextExpectedAt] of rows)
      await freshness(connectionId, "analytics", {
        resource,
        dataThrough,
        nextExpectedAt,
        checkedAt: at(-5 * MINUTE),
      });
    const service = createDataService(db, () => NOW);
    const actor = { workspaceId, callerId };
    // The install's mapping table links app-2 of both stores as one product.
    const mapping = await service.saveManual(actor, {
      definition: {
        key: "store_mapping_freshness",
        name: "Mapping",
        version: 1,
        mode: "snapshot",
        grain: "One product per source app",
        keyFields: ["app_key"],
        retentionDays: null,
        fields: ["app_key", "product_id"].map((id) => ({
          id,
          name: id,
          type: "string" as const,
          nullable: false,
          classification: "internal" as const,
        })),
      },
      records: [
        {
          values: { app_key: `${store.apple}:app-2`, product_id: "product:p" },
        },
        { values: { app_key: `${store.play}:app-2`, product_id: "product:p" } },
      ],
    });
    const views = (connectionId: string) =>
      `observation:${connectionId}:${metricIds["fresh.views"]}`;
    // As the template's preparations: each row's app key, its mapping
    // row's product, else the app key itself (resolveStoreProducts).
    const resource =
      "dimension." + createHash("sha256").update("resource").digest("hex");
    const keyed = (id: string, input: string, connectionId: string) => ({
      id,
      type: "calculate" as const,
      input,
      fieldId: "app_key",
      name: "App key",
      expression: {
        kind: "call" as const,
        fn: "concat" as const,
        args: [
          {
            kind: "literal" as const,
            type: "string" as const,
            value: `${connectionId}:`,
          },
          { kind: "field" as const, fieldId: resource },
        ],
      },
    });
    const preparation = await service.savePreparation(actor, {
      name: "Store views",
      graph: {
        version: 1,
        nodes: [
          { id: "apple", type: "source", datasetId: views(store.apple) },
          { id: "play", type: "source", datasetId: views(store.play) },
          { id: "mapping", type: "source", datasetId: mapping.datasetId },
          keyed("apple_keyed", "apple", store.apple!),
          keyed("play_keyed", "play", store.play!),
          { id: "all", type: "append", inputs: ["apple_keyed", "play_keyed"] },
          {
            id: "mapped",
            type: "join",
            left: "all",
            right: "mapping",
            keys: [{ left: "app_key", right: "app_key" }],
            mode: "left",
            cardinality: "many_to_one",
            rightPrefix: "map.",
          },
          {
            id: "products",
            type: "calculate",
            input: "mapped",
            fieldId: "product",
            name: "Product",
            expression: {
              kind: "call",
              fn: "coalesce",
              args: [
                { kind: "field", fieldId: "map.product_id" },
                { kind: "field", fieldId: "app_key" },
              ],
            },
          },
        ],
        outputs: ["products"],
      },
    });
    await service.publishPreparation(actor, preparation.preparation.id, 1);
    const prepared = `prepared:${preparation.preparation.id}:products`;
    const model = await service.saveModel(actor, {
      name: "Store views",
      definition: {
        version: 1,
        datasets: [prepared],
        relationships: [],
        dimensions: [
          {
            id: "app",
            name: "App",
            datasetId: prepared,
            fieldId: "product",
          },
        ],
        measures: [
          {
            id: "views",
            name: "Views",
            kind: "aggregate",
            datasetId: prepared,
            aggregate: {
              id: "views",
              name: "Views",
              op: "sum",
              fieldId: "value",
            },
          },
        ],
      },
    });
    await service.publishModel(actor, model.model.id, 1);
    storeModelId = model.model.id;
    mappingDatasetId = mapping.datasetId;
    await owner`
      insert into data_template_installs (workspace_id, request_id,
        request_hash, result)
      values (${workspaceId}, gen_random_uuid(), ${"0".repeat(64)},
        ${owner.json({ mappingDatasetId: mapping.datasetId })})`;
    appFilter = {
      id: "app",
      name: "App",
      type: "string",
      mode: "values",
      mappings: [{ modelId: storeModelId, dimensionId: "app" }],
      defaultValue: null,
    };
  });

  const measure = (slide: SlideFilterScope, screen: SlideFilterScope = {}) =>
    withWorkspace(db, { workspaceId }, (tx) =>
      queryDashboardMeasure(
        tx,
        workspaceId,
        {
          id: "44444444-4444-4444-8444-444444444444",
          binding: {
            modelId: storeModelId,
            measureIds: ["views"],
            groupBy: ["app"],
            exclusions: [],
          },
          options: { view: "table", limit: 20 },
        },
        [appFilter],
        {},
        NOW,
        DEFAULT_DATA_POLICY,
        "en",
        screen,
        slide,
        createFreshnessReader(workspaceId, manifests),
      ),
    );
  const app = (...values: string[]) => ({
    app: { kind: "values" as const, values },
  });
  /** The apps (products) whose rows the widget shows. */
  const shown = (data: Awaited<ReturnType<typeof measure>>) =>
    (data.result?.rows ?? []).map((row) => row.dimensions.app).sort();

  it("counts only the App Store app's rows on its slide", async () => {
    const data = await measure(app(`${store.apple}:app-1`));
    // Its rows are the App Store app's, and so is its freshness.
    expect(shown(data)).toEqual([`${store.apple}:app-1`]);
    expect(data.freshness).toMatchObject({
      dataThrough: "2026-11-15",
      nextExpectedAt: at(8 * HOUR).toISOString(),
    });
  });

  it("counts the apps of both stores on a linked product's slide", async () => {
    const data = await measure(app("product:p"));
    expect(shown(data)).toEqual(["product:p"]);
    expect(data.freshness).toMatchObject({
      dataThrough: "2026-11-13",
      nextExpectedAt: at(6 * HOUR).toISOString(),
    });
  });

  it("resolves a screen's product scope as a slide's", async () => {
    const data = await measure({}, app("product:p"));
    expect(data.freshness).toMatchObject({
      dataThrough: "2026-11-13",
      nextExpectedAt: at(6 * HOUR).toISOString(),
    });
  });

  it("keeps an unscoped widget's freshness over every app", async () => {
    const data = await measure({});
    expect(data.freshness).toMatchObject({ dataThrough: "2026-11-11" });
    expect(data.freshness).not.toHaveProperty("nextExpectedAt");
  });

  it("has no freshness, and no rows, where slide and screen share no app", async () => {
    const data = await measure(
      app(`${store.apple}:app-1`),
      app(`${store.play}:app-1`),
    );
    expect(shown(data)).toEqual([]);
    expect(data.freshness).toBeUndefined();
  });

  it("counts only the apps a slide and a screen share", async () => {
    // The slide shows the App Store and the Play app-1, the screen Play's.
    const data = await measure(
      app(`${store.apple}:app-1`, `${store.play}:app-1`),
      app(`${store.play}:app-1`),
    );
    expect(shown(data)).toEqual([`${store.play}:app-1`]);
    expect(data.freshness).toMatchObject({ dataThrough: "2026-11-11" });
    expect(data.freshness).not.toHaveProperty("nextExpectedAt");
    // Two App Store apps on the slide, one of them on the screen.
    const apple = await measure(
      app(`${store.apple}:app-1`, `${store.play}:app-1`),
      app(`${store.apple}:app-1`),
    );
    expect(shown(apple)).toEqual([`${store.apple}:app-1`]);
    expect(apple.freshness).toMatchObject({
      dataThrough: "2026-11-15",
      nextExpectedAt: at(8 * HOUR).toISOString(),
    });
  });

  it("falls back to every app for a product no mapping row names", async () => {
    const data = await measure(app("product:unknown"));
    expect(shown(data)).toEqual([]);
    expect(data.freshness).toMatchObject({ dataThrough: "2026-11-11" });
    expect(data.freshness).not.toHaveProperty("nextExpectedAt");
  });

  it("falls back to every app when the mapping table has expired", async () => {
    const bindings = {
      [`observation:${store.apple}:${metricIds["fresh.views"]}`]: [],
      [`observation:${store.play}:${metricIds["fresh.views"]}`]: [],
      [mappingDatasetId]: [],
    };
    const read = (now: Date) =>
      withWorkspace(db, { workspaceId }, async (tx) =>
        createFreshnessReader(workspaceId, manifests).read(
          tx,
          await modelFreshnessDependencies(
            tx,
            workspaceId,
            { bindings, dependencies: {} },
            app("product:p"),
            [],
            {},
            { now },
          ),
        ),
      );
    expect((await read(NOW)).freshness).toMatchObject({
      dataThrough: "2026-11-13",
    });
    await owner`update data_generations set expires_at = ${at(-HOUR)}
      where dataset_id = ${mappingDatasetId}`;
    try {
      const found = await read(NOW);
      expect(found.freshness).toMatchObject({ dataThrough: "2026-11-11" });
      expect(found.freshness).not.toHaveProperty("nextExpectedAt");
    } finally {
      await owner`update data_generations set expires_at = null
        where dataset_id = ${mappingDatasetId}`;
    }
  });

  it("reads a response's mapping table once for every widget", async () => {
    const reader = createFreshnessReader(workspaceId, manifests);
    const resolve = () =>
      withWorkspace(db, { workspaceId }, async (tx) =>
        reader.read(
          tx,
          await modelFreshnessDependencies(
            tx,
            workspaceId,
            {
              bindings: {
                [`observation:${store.play}:${metricIds["fresh.views"]}`]: [],
                [mappingDatasetId]: [],
              },
              dependencies: {},
            },
            app("product:p"),
            [],
            {},
            { now: NOW, cache: reader.scopeMappings },
          ),
        ),
      );
    expect((await resolve()).freshness).toMatchObject({
      dataThrough: "2026-11-13",
    });
    expect([...reader.scopeMappings.products.keys()]).toEqual([
      mappingDatasetId,
    ]);
    // Read from the cache, not the table: an edit since is not seen.
    const cached = reader.scopeMappings.products.get(mappingDatasetId);
    reader.scopeMappings.products.set(
      mappingDatasetId,
      new Map([["product:p", [`${store.play}:app-1`]]]),
    );
    expect((await resolve()).freshness).toMatchObject({
      dataThrough: "2026-11-11",
    });
    expect(cached?.get("product:p")).toHaveLength(2);
  });

  it("reads the mapping table under the policy's query timeout", async () => {
    const timeout = await withWorkspace(db, { workspaceId }, async (tx) => {
      await modelFreshnessDependencies(
        tx,
        workspaceId,
        { bindings: { [mappingDatasetId]: [] }, dependencies: {} },
        app("product:p"),
        [],
        {},
        {
          now: NOW,
          defaults: { ...DEFAULT_DATA_POLICY, queryTimeoutMs: 4321 },
        },
      );
      const [row] = await tx.execute<{ timeout: string }>(
        sql`select current_setting('statement_timeout') as timeout`,
      );
      return row!.timeout;
    });
    expect(timeout).toBe("4321ms");
  });

  it("resolves no product for store values or app keys", async () => {
    const reader = createFreshnessReader(workspaceId, manifests);
    await withWorkspace(db, { workspaceId }, (tx) =>
      modelFreshnessDependencies(
        tx,
        workspaceId,
        { bindings: { [mappingDatasetId]: [] }, dependencies: {} },
        app("app_store", `${store.apple}:app-1`),
        [],
        {},
        { now: NOW, cache: reader.scopeMappings },
      ),
    );
    expect(reader.scopeMappings.isMapping.size).toBe(0);
    expect(reader.scopeMappings.products.size).toBe(0);
  });

  it("gives a screen the slide's freshness (device payload)", async () => {
    const dashboard = await dashboardWith("App Portfolio");
    await owner`update dashboards set data_filters = ${owner.json([appFilter] as never)}
      where id = ${dashboard}`;
    const binding = {
      modelId: storeModelId,
      measureIds: ["views"],
      groupBy: [],
      exclusions: [],
    };
    for (const [position, scope, title] of [
      [0, {}, "All apps"],
      [1, app(`${store.apple}:app-1`), "Wurfel"],
      [2, app("product:p"), "voilà"],
    ] as const)
      await widget(dashboard, await slideOf(dashboard, position, scope), {
        type: "measure",
        title,
        y: 0,
        model_id: storeModelId,
        model_binding: binding,
        options: { view: "value", limit: 20 },
      });
    const payload = await v2(dashboard);
    expect(dataOf(payload, "All apps").freshness).toMatchObject({
      dataThrough: "2026-11-11",
    });
    expect(dataOf(payload, "Wurfel").freshness).toMatchObject({
      dataThrough: "2026-11-15",
      nextExpectedAt: at(8 * HOUR).toISOString(),
    });
    expect(dataOf(payload, "voilà").freshness).toMatchObject({
      dataThrough: "2026-11-13",
      nextExpectedAt: at(6 * HOUR).toISOString(),
    });
  });
});

describe("measure source health through preparations (#721)", () => {
  // Warnings name the sources freshness reads: those the model binds and
  // those its preparations read.
  let sourcesDashboardId: string;
  const DAY = 24 * HOUR;

  /** A published model of the views in its first dataset. */
  async function viewsModel(
    name: string,
    datasets: { prepared?: string[]; direct?: string[] },
  ) {
    const service = createDataService(db, () => NOW);
    const actor = { workspaceId, callerId };
    const bound = [...(datasets.direct ?? [])];
    for (const dataset of datasets.prepared ?? []) {
      const preparation = await service.savePreparation(actor, {
        name: `${name} ${bound.length}`,
        graph: {
          version: 1,
          nodes: [{ id: "source", type: "source", datasetId: dataset }],
          outputs: ["source"],
        },
      });
      await service.publishPreparation(actor, preparation.preparation.id, 1);
      bound.push(`prepared:${preparation.preparation.id}:source`);
    }
    const first = bound[0]!;
    const model = await service.saveModel(actor, {
      name,
      definition: {
        version: 1,
        datasets: bound,
        relationships: [],
        dimensions: [
          {
            id: "day",
            name: "Day",
            datasetId: first,
            fieldId: "time",
            timeAlignment: "reporting_date",
          },
        ],
        measures: [
          {
            id: "views",
            name: "Views",
            kind: "aggregate",
            datasetId: first,
            aggregate: {
              id: "views",
              name: "Views",
              op: "sum",
              fieldId: "value",
            },
          },
        ],
      },
    });
    await service.publishModel(actor, model.model.id, 1);
    return model.model.id;
  }

  const views = (connectionId: string) =>
    `observation:${connectionId}:${metricIds["fresh.views"]}`;

  beforeAll(async () => {
    // A connection whose syncs fail for two days: its analytics overdue.
    c.stale = await connection("Stale");
    await owner`
      update connection_state
      set consecutive_failures = 3, last_success_at = ${at(-2 * DAY)}
      where connection_id = ${c.stale}`;
    await freshness(c.stale, "analytics", {
      dataThrough: "2026-11-12",
      nextExpectedAt: at(-2 * DAY),
      checkedAt: at(-HOUR),
    });
    c.direct = await connection("Direct");
    sourcesDashboardId = await dashboardWith("Sources");
    const slide = await slideOf(sourcesDashboardId, 0);
    const models: [string, Parameters<typeof viewsModel>[1]][] = [
      ["Prepared auth failed", { prepared: [views(c.authFailed!)] }],
      ["Prepared stale", { prepared: [views(c.stale)] }],
      ["Prepared ok", { prepared: [views(c.periodic!)] }],
      // Bindings that name only the prepared output (below).
      ["Prepared only", { prepared: [views(c.stale)] }],
      ["Direct reauth", { direct: [views(c.reauth!)] }],
      ["Direct ok", { direct: [views(c.direct)] }],
      // The same connection bound and prepared, and prepared twice.
      [
        "Both",
        {
          direct: [views(c.authFailed!)],
          prepared: [views(c.authFailed!), views(c.authFailed!)],
        },
      ],
    ];
    for (const [index, [title, datasets]] of models.entries()) {
      const id = await viewsModel(title, datasets);
      // The loader records what a preparation read in the release's
      // bindings; without those, only `dependencies.prepared` names them.
      if (title === "Prepared only")
        await owner`
          update data_model_releases
          set schema_bindings = schema_bindings - ${views(c.stale)}::text
          where model_id = ${id}`;
      await widget(sourcesDashboardId, slide, {
        type: "measure",
        title,
        x: (index % 4) * 3,
        y: Math.floor(index / 4),
        model_id: id,
        model_binding: {
          modelId: id,
          measureIds: ["views"],
          groupBy: [],
          exclusions: [],
        },
        options: { view: "value", limit: 20 },
      });
    }
  });

  type MeasureData = {
    status: string;
    sourceHealth?: { connectionId: string; status: string }[];
    freshness?: Record<string, unknown>;
  };
  /** A widget's data in the screen's payload and the web's, which agree. */
  async function both() {
    const device = deviceDashboardV2ResponseSchema.parse(
      await v2(sourcesDashboardId),
    );
    const web = await withWorkspace(db, { workspaceId }, async (tx) => {
      const dashboard = await findDashboard(
        tx,
        workspaceId,
        sourcesDashboardId,
      );
      return queryDashboardData(
        tx,
        workspaceId,
        dashboard!.slides,
        dashboard!.dataFilters,
        {},
        NOW,
        DEFAULT_DATA_POLICY,
        "en",
        createFreshnessReader(workspaceId, manifests, "en"),
      );
    });
    return (title: string) => {
      const found = byLabel(device, title);
      const fromWeb = web.widgets.find((entry) => entry.widgetId === found.id);
      expect(fromWeb?.sourceHealth).toEqual(
        (found.data as MeasureData).sourceHealth,
      );
      return found.data as MeasureData;
    };
  }

  it("warns of a failed connection behind a preparation", async () => {
    const data = (await both())("Prepared auth failed");
    expect(data.sourceHealth).toEqual([
      {
        connectionId: c.authFailed,
        name: "Auth failed",
        status: "auth_failed",
        lastSuccessAt: at(-5 * MINUTE).toISOString(),
      },
    ]);
  });

  it("warns of a stale connection behind a preparation, as its freshness does", async () => {
    const data = (await both())("Prepared stale");
    expect(data.sourceHealth).toEqual([
      {
        connectionId: c.stale,
        name: "Stale",
        status: "outage",
        lastSuccessAt: at(-2 * DAY).toISOString(),
      },
    ]);
    expect(data.status).toBe("stale");
    expect(data.freshness).toMatchObject({
      stream: "Analytics",
      dataThrough: "2026-11-12",
    });
  });

  it("keeps direct bindings as they were", async () => {
    const data = await both();
    expect(data("Direct reauth").sourceHealth).toEqual([
      {
        connectionId: c.reauth,
        name: "Reauthorize",
        status: "needs_reauthorization",
        lastSuccessAt: at(-5 * MINUTE).toISOString(),
      },
    ]);
    expect(data("Direct ok").sourceHealth).toEqual([
      {
        connectionId: c.direct,
        name: "Direct",
        status: "ok",
        lastSuccessAt: at(-5 * MINUTE).toISOString(),
      },
    ]);
  });

  it("names a connection once, however many ways the model reads it", async () => {
    const data = (await both())("Both");
    expect(data.sourceHealth).toEqual([
      expect.objectContaining({
        connectionId: c.authFailed,
        status: "auth_failed",
      }),
    ]);
  });

  it("follows the preparations a release depends on, as freshness does", async () => {
    const data = (await both())("Prepared only");
    expect(data.sourceHealth).toEqual([
      expect.objectContaining({ connectionId: c.stale, status: "outage" }),
    ]);
    expect(data.status).toBe("stale");
    expect(data.freshness).toMatchObject({ dataThrough: "2026-11-12" });
  });

  it("leaves a payload without failing sources as it was", async () => {
    // The healthy source behind the preparation, as before (#721).
    expect((await both())("Prepared ok").sourceHealth).toEqual([
      {
        connectionId: c.periodic,
        name: "Periodic",
        status: "ok",
        lastSuccessAt: at(-5 * MINUTE).toISOString(),
      },
    ]);
    const payload = await v2(measureDashboardId);
    const found = byLabel(payload, "Views");
    const data = found.data as Record<string, unknown>;
    expect(JSON.stringify(data)).toBe(
      JSON.stringify({
        sourceHealth: [
          {
            connectionId: c.periodic,
            name: "Periodic",
            status: "ok",
            lastSuccessAt: at(-5 * MINUTE).toISOString(),
          },
        ],
        scope: [],
        status: "ok",
        widgetId: found.id,
        metadata: data.metadata,
        result: data.result,
        error: null,
        exclusions: [],
        freshness: data.freshness,
      }),
    );
  });
});

type StatusItem = {
  connectionId: string;
  status: string;
  streams?: Record<string, unknown>[];
};

async function boardItems(options: { locale?: "de" } = {}) {
  const payload = deviceDashboardV2ResponseSchema.parse(
    await v2(boardDashboardId, options),
  );
  const board = payload.slides[0]!.widgets.find(
    (widget) => widget.type === "status",
  ) as Extract<DeviceWidget, { type: "status" }>;
  const items = board.data.items as StatusItem[];
  return (id: string) => {
    const item = items.find((entry) => entry.connectionId === id);
    if (!item) throw new Error(`no item ${id}`);
    return item;
  };
}

describe("status board streams (#727)", () => {
  it("lists each source's streams, selected resources only", async () => {
    const item = await boardItems();
    expect(item(c.periodic!).streams).toEqual([
      {
        key: "sales",
        kind: "periodic",
        stream: "Sales",
        fetchedAt: at(-5 * MINUTE).toISOString(),
        dataThrough: "2026-11-14",
        nextExpectedAt: at(8 * HOUR).toISOString(),
        nextCheckAt: at(2 * HOUR).toISOString(),
      },
      {
        // The least fresh selected app; app-9 is not selected.
        key: "analytics",
        kind: "periodic",
        stream: "Analytics",
        fetchedAt: at(-10 * MINUTE).toISOString(),
        dataThrough: "2026-11-12",
        nextExpectedAt: at(9 * HOUR).toISOString(),
        nextCheckAt: at(2 * HOUR).toISOString(),
      },
    ]);
    expect(item(c.monthly!).streams).toEqual([
      expect.objectContaining({ key: "earnings", period: "month" }),
    ]);
    expect(item(c.continuous!).streams).toEqual([
      {
        key: "reviews",
        kind: "continuous",
        stream: "Reviews",
        fetchedAt: at(-20 * MINUTE).toISOString(),
        nextCheckAt: at(2 * HOUR).toISOString(),
      },
    ]);
  });

  it("marks late and overdue streams", async () => {
    const item = await boardItems();
    expect(item(c.late!).streams).toEqual([
      expect.objectContaining({ key: "sales", late: true }),
    ]);
    expect(item(c.late!).streams![0]).not.toHaveProperty("overdue");
    expect(item(c.overdue!).streams).toEqual([
      expect.objectContaining({ key: "sales", late: true, overdue: true }),
    ]);
  });

  it("leaves out the next times of a connection the scheduler skips", async () => {
    const item = await boardItems();
    for (const id of [c.authFailed!, c.reauth!]) {
      expect(item(id).status).toBe("auth_failed");
      expect(item(id).streams).toEqual([
        {
          key: "sales",
          kind: "periodic",
          stream: "Sales",
          fetchedAt: at(-5 * MINUTE).toISOString(),
          dataThrough: "2026-11-14",
        },
      ]);
    }
  });

  it("has no streams for a source without rows", async () => {
    const item = await boardItems();
    expect(item(c.none!)).not.toHaveProperty("streams");
  });

  it("names streams in the payload's language", async () => {
    const item = await boardItems({ locale: "de" });
    expect(item(c.periodic!).streams![0]).toMatchObject({
      stream: "Verkäufe",
    });
  });

  it("keeps the board's version across clock times", async () => {
    let clock = NOW;
    const service = createDeviceService({
      db,
      pairingUrl: "https://pair.example.test",
      now: () => clock,
      payloadCacheMs: 0,
      registry: manifests,
    });
    const read = async (schema: 2 | 3) => {
      const result = await service.dashboard(
        { workspaceId, deviceId: boardDeviceId },
        undefined,
        schema,
      );
      if (!result.ok) throw new Error(result.error);
      return result.value as { version: string };
    };
    const first = await read(2);
    const firstV3 = deviceDashboardV3ResponseSchema.parse(await read(3));
    expect(JSON.stringify(first)).toContain('"streams"');
    // Ten minutes on: next expected times pass, nothing stored changes.
    clock = at(10 * MINUTE);
    expect((await read(2)).version).toBe(first.version);
    expect((await read(3)).version).toBe(firstV3.version);
  });
});

describe("tenant isolation", () => {
  it("never reads another workspace's rows", async () => {
    const found = await withWorkspace(db, { workspaceId }, (tx) =>
      createFreshnessReader(workspaceId, manifests).read(tx, [
        { connectionId: c.other!, metricKey: "fresh.sales" },
      ]),
    );
    expect(found).toEqual({ overdue: false });
    // The other workspace sees its own.
    const own = await withWorkspace(
      db,
      { workspaceId: otherWorkspaceId },
      (tx) =>
        createFreshnessReader(otherWorkspaceId, manifests).read(tx, [
          { connectionId: c.other!, metricKey: "fresh.sales" },
        ]),
    );
    expect(own.freshness).toMatchObject({ dataThrough: "2026-11-01" });
  });
});
