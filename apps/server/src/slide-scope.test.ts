/**
 * Slide scope and slide logo (#707): a slide sets fixed values of the
 * dashboard's shared filters for every widget on it, and may show a logo of
 * its own in the header. Measure widgets apply the scope through their
 * model; metric widgets through their resource when the scope names their
 * connection's app. A screen's fixed scope still wins: a slide scoped to
 * something the screen may not show is left out of its payload.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPairingResponseSchema,
  dashboardDataResponseSchema,
  deviceDashboardV2ResponseSchema,
  deviceDashboardV3ResponseSchema,
  deviceResponseSchema,
  errorResponseSchema,
  imageResponseSchema,
  pollPairingResponseSchema,
  workspaceResponseSchema,
} from "@netrics/contracts";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";
import { connectionResourceKey } from "@netrics/domain";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";
import { createTestDatabase } from "./test-db.js";

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

let app: FastifyInstance, db: Database, admin: Sql;
let owner: string, stranger: string;
let workspaceId: string, otherWorkspaceId: string;
let modelId: string, connectionId: string;
let ip = 0;

interface Paired {
  id: string;
  accessToken: string;
}

function call(
  method: "GET" | "POST" | "PUT" | "PATCH",
  url: string,
  options: { cookie?: string; token?: string; payload?: unknown } = {},
): Promise<InjectResponse> {
  return app.inject({
    method,
    url,
    headers: {
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    remoteAddress: `198.51.100.${(ip += 1)}`,
    ...(options.payload !== undefined
      ? { payload: options.payload as InjectOptions["payload"] }
      : {}),
  });
}

function expectError(response: InjectResponse, status: number, error: string) {
  expect(response.statusCode, response.body).toBe(status);
  expect(errorResponseSchema.parse(response.json()).error).toBe(error);
}

async function signUp(email: string): Promise<string> {
  const response = await call("POST", "/api/auth/sign-up/email", {
    payload: { name: email, email, password: "password-12345" },
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers["set-cookie"];
  return (Array.isArray(header) ? header : [header])
    .find((c) => c?.startsWith("better-auth.session_token="))!
    .split(";")[0]!;
}

async function pair(dashboard: string): Promise<Paired> {
  const started = createPairingResponseSchema.parse(
    (await call("POST", "/v1/device/pairings")).json(),
  );
  const approved = await call(
    "POST",
    `/v1/workspaces/${workspaceId}/devices/approve`,
    {
      cookie: owner,
      payload: { code: started.code, name: "Lobby TV", dashboardId: dashboard },
    },
  );
  expect(approved.statusCode, approved.body).toBe(200);
  const polled = pollPairingResponseSchema.parse(
    (
      await call("POST", "/v1/device/pairings/poll", {
        payload: {
          pairingId: started.pairingId,
          pollSecret: started.pollSecret,
        },
      })
    ).json(),
  );
  if (polled.status !== "approved") throw new Error("not approved");
  return {
    id: deviceResponseSchema.parse(approved.json()).device.id,
    accessToken: polled.credentials.accessToken,
  };
}

async function upload(workspace: string, cookie: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspace}/images`,
    headers: { cookie, "content-type": "image/png" },
    payload: readFileSync(
      path.join(import.meta.dirname, "images", "fixtures", "plain.png"),
    ),
    remoteAddress: `198.51.100.${(ip += 1)}`,
  });
  expect(response.statusCode, response.body).toBe(200);
  return imageResponseSchema.parse(response.json()).image.id;
}

const appFilter = () => ({
  id: "app",
  name: "App",
  type: "string",
  mode: "values",
  mappings: [{ modelId, dimensionId: "app" }],
  defaultValue: null,
});
const income = (fields: Record<string, unknown> = {}) => ({
  type: "measure",
  x: 0,
  y: 0,
  w: 4,
  h: 3,
  binding: { modelId, measureIds: ["income"], groupBy: [], exclusions: [] },
  options: { view: "value", limit: 20 },
  ...fields,
});
const downloads = (fields: Record<string, unknown> = {}) => ({
  type: "metric",
  x: 4,
  y: 0,
  w: 4,
  h: 3,
  connectionId,
  metricKey: "snap.downloads",
  period: "last_7_days",
  ...fields,
});
const APP_A = () => connectionResourceKey(connectionId, "app-a");
const APP_B = () => connectionResourceKey(connectionId, "app-b");
const only = (value: string) => ({
  app: { kind: "values", values: [value] },
});

async function createDashboard(slides: unknown[], settings = {}) {
  const created = await call(
    "POST",
    `/v1/workspaces/${workspaceId}/dashboards`,
    {
      cookie: owner,
      payload: {
        name: "Portfolio",
        settings: { dataFilters: [appFilter()], ...settings },
        slides,
      },
    },
  );
  return created;
}

async function dashboardOf(id: string) {
  const response = await call(
    "GET",
    `/v1/workspaces/${workspaceId}/dashboards/${id}`,
    { cookie: owner },
  );
  expect(response.statusCode, response.body).toBe(200);
  return response.json().dashboard;
}

async function devicePayload(device: Paired, schema: 2 | 3 = 3) {
  const response = await call("GET", `/v1/device/dashboard?schema=${schema}`, {
    token: device.accessToken,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

beforeAll(async () => {
  const test = await createTestDatabase();
  const config = loadConfig({
    DATABASE_URL: test.appUrl,
    LOG_LEVEL: "silent",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
  });
  db = createDatabase(test.appUrl);
  admin = createRawSqlClient(test.adminUrl, {
    max: 1,
    onnotice: () => undefined,
  });
  app = await buildApp(config, {
    db,
    authService: createAuthService(config, db, {
      logger: pino({ level: "silent" }),
    }),
    checkDb: async () => true,
  });
  owner = await signUp("slide-owner@example.com");
  stranger = await signUp("slide-stranger@example.com");
  workspaceId = workspaceResponseSchema.parse(
    (
      await call("POST", "/v1/workspaces", {
        cookie: owner,
        payload: { name: "Apps" },
      })
    ).json(),
  ).workspace.id;
  otherWorkspaceId = workspaceResponseSchema.parse(
    (
      await call("POST", "/v1/workspaces", {
        cookie: stranger,
        payload: { name: "Foreign" },
      })
    ).json(),
  ).workspace.id;

  // A connection whose apps the model's rows name, as the App Portfolio
  // template does for apps not grouped into a product.
  await admin`insert into connectors (id, version, manifest) values
    ('snap', '1.0.0', ${admin.json({ id: "snap" })})
    on conflict do nothing`;
  await admin`
    insert into metric_definitions (connector_id, key, name, description,
      kind, unit, granularity, dimensions, aggregations)
    values ('snap', 'snap.downloads', 'Downloads', '', 'delta', 'count',
      'day', '["resource"]', '["sum"]')
    on conflict do nothing`;
  const [connection] = await admin`
    insert into connections (workspace_id, connector_id, name, config)
    values (${workspaceId}, 'snap', 'Store',
      ${admin.json({ resourceSelection: ["app-a", "app-b"] })})
    returning id`;
  connectionId = connection!.id as string;
  const today = new Date();
  for (let day = 1; day <= 3; day += 1) {
    const date = new Date(today.getTime() - day * 86_400_000)
      .toISOString()
      .slice(0, 10);
    for (const [resource, value] of [
      ["app-a", 10],
      ["app-b", 1000],
    ] as const)
      await admin`
        insert into observations (workspace_id, connection_id,
          metric_definition_id, dimensions, source_timestamp, value)
        select ${workspaceId}, ${connectionId}, m.id,
               ${admin.json({ resource })}, ${`${date}T00:00:00Z`}::timestamptz,
               ${value}
        from metric_definitions m where m.key = 'snap.downloads'`;
  }

  const data = `/v1/workspaces/${workspaceId}/data`;
  const source = await call("POST", `${data}/manual`, {
    cookie: owner,
    payload: {
      definition: {
        key: "sales",
        name: "Sales",
        version: 1,
        mode: "snapshot",
        grain: "one sale",
        keyFields: ["id"],
        retentionDays: null,
        fields: [
          ["id", "string"],
          ["app", "string"],
          ["amount", "decimal"],
        ].map(([id, type]) => ({
          id,
          name: id,
          type,
          nullable: false,
          classification: "internal",
        })),
      },
      records: [
        { values: { id: "1", app: APP_A(), amount: "100" } },
        { values: { id: "2", app: APP_A(), amount: "50" } },
        { values: { id: "3", app: APP_B(), amount: "25" } },
      ],
    },
  });
  expect(source.statusCode, source.body).toBe(200);
  const datasetId = source.json().datasetId as string;
  const model = await call("POST", `${data}/models`, {
    cookie: owner,
    payload: {
      name: "Sales",
      definition: {
        version: 1,
        datasets: [datasetId],
        relationships: [],
        dimensions: [{ id: "app", name: "App", datasetId, fieldId: "app" }],
        measures: [
          {
            id: "income",
            name: "Income",
            kind: "aggregate",
            datasetId,
            aggregate: {
              id: "income",
              name: "income",
              op: "sum",
              fieldId: "amount",
            },
          },
        ],
      },
    },
  });
  expect(model.statusCode, model.body).toBe(200);
  modelId = model.json().model.id as string;
  expect(
    (
      await call("POST", `${data}/models/${modelId}/publish`, {
        cookie: owner,
        payload: { version: 1 },
      })
    ).statusCode,
  ).toBe(200);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.$client.end({ timeout: 5 });
  await admin?.end({ timeout: 5 });
});

type Widget = {
  type: string;
  label?: string;
  data?: {
    value?: number | null;
    scope?: string[];
    result?: { rows: Array<{ measures: Record<string, { value: unknown }> }> };
  };
};
const slideWidgets = (body: unknown, index: number) =>
  (body as { slides: Array<{ widgets: Widget[] }> }).slides[index]!.widgets;
const incomeOf = (widgets: Widget[]) =>
  widgets.find((widget) => widget.type === "measure")!.data!.result!.rows[0]!
    .measures.income!.value;
const downloadsOf = (widgets: Widget[]) =>
  widgets.find((widget) => widget.type === "metric")!.data!.value;

describe("a slide scoped to one app", () => {
  let dashboardId: string;

  it("stores each slide's scope and gives two slides different numbers", async () => {
    const created = await createDashboard([
      { name: "App A", scope: only(APP_A()), widgets: [income(), downloads()] },
      { name: "App B", scope: only(APP_B()), widgets: [income(), downloads()] },
      {
        name: "All apps",
        widgets: [
          income(),
          downloads({
            filterExclusions: [{ filterId: "app", reason: "All apps" }],
          }),
        ],
      },
    ]);
    expect(created.statusCode, created.body).toBe(200);
    dashboardId = created.json().dashboard.id as string;
    const stored = await dashboardOf(dashboardId);
    expect(
      stored.slides.map((slide: { scope: unknown }) => slide.scope),
    ).toEqual([only(APP_A()), only(APP_B()), {}]);

    // The browser's dashboard data: each measure widget with its slide's scope.
    const read = await call(
      "POST",
      `/v1/workspaces/${workspaceId}/dashboards/${dashboardId}/data`,
      { cookie: owner, payload: { values: {} } },
    );
    expect(read.statusCode, read.body).toBe(200);
    const values = dashboardDataResponseSchema
      .parse(read.json())
      .widgets.map((widget) => widget.result!.rows[0]!.measures.income!.value);
    expect(values).toEqual(["150", "25", "175"]);

    // A screen: measure widgets through the model, the metric widget
    // through its resource.
    const screen = await pair(dashboardId);
    const body = deviceDashboardV3ResponseSchema.parse(
      await devicePayload(screen),
    );
    expect(body.slides.map((slide) => slide.name)).toEqual([
      "App A",
      "App B",
      "All apps",
    ]);
    expect(incomeOf(slideWidgets(body, 0))).toBe("150");
    expect(incomeOf(slideWidgets(body, 1))).toBe("25");
    expect(incomeOf(slideWidgets(body, 2))).toBe("175");
    expect(downloadsOf(slideWidgets(body, 0))).toBe(30);
    expect(downloadsOf(slideWidgets(body, 1))).toBe(3000);
    expect(downloadsOf(slideWidgets(body, 2))).toBe(3030);
    // The scope is named on the widget, like a fixed value.
    expect(
      slideWidgets(body, 0).find((widget) => widget.type === "measure")!.data!
        .scope,
    ).toEqual([`App: ${APP_A()}`]);
  });

  it("previews unsaved widgets with their slide's scope", async () => {
    const preview = await call(
      "POST",
      `/v1/workspaces/${workspaceId}/dashboards/data/preview`,
      {
        cookie: owner,
        payload: {
          filters: [appFilter()],
          values: {},
          widgets: [
            {
              id: crypto.randomUUID(),
              binding: income().binding,
              options: income().options,
              scope: only(APP_B()),
            },
          ],
        },
      },
    );
    expect(preview.statusCode, preview.body).toBe(200);
    expect(
      dashboardDataResponseSchema.parse(preview.json()).widgets[0]!.result!
        .rows[0]!.measures.income!.value,
    ).toBe("25");
  });

  it("keeps widget exclusions working on a scoped slide", async () => {
    const created = await createDashboard([
      {
        scope: only(APP_A()),
        widgets: [
          income({
            binding: {
              modelId,
              measureIds: ["income"],
              groupBy: [],
              exclusions: [{ filterId: "app", reason: "Portfolio total" }],
            },
          }),
          downloads({
            filterExclusions: [{ filterId: "app", reason: "All apps" }],
          }),
        ],
      },
    ]);
    expect(created.statusCode, created.body).toBe(200);
    const body = await devicePayload(await pair(created.json().dashboard.id));
    expect(incomeOf(slideWidgets(body, 0))).toBe("175");
    expect(downloadsOf(slideWidgets(body, 0))).toBe(3030);
  });

  it("refuses a scope the dashboard's filters cannot apply, and a metric widget of another app", async () => {
    expectError(
      await createDashboard([
        { scope: { gone: { kind: "values", values: ["x"] } }, widgets: [] },
      ]),
      400,
      "slide_scope_filter_unknown",
    );
    expectError(
      await createDashboard([
        { scope: { app: { kind: "values", values: [] } }, widgets: [] },
      ]),
      400,
      "invalid_request",
    );
    expectError(
      await createDashboard([
        {
          scope: only(APP_A()),
          widgets: [downloads({ dimensions: { resource: "app-b" } })],
        },
      ]),
      400,
      "slide_scope_resource_conflict",
    );
    // A slide scoped to something that names no app of the connection: the
    // metric widget cannot follow it and must say so.
    expectError(
      await createDashboard([
        {
          scope: only("product:wurfel"),
          widgets: [downloads()],
        },
      ]),
      400,
      "dashboard_filter_not_applicable",
    );
  });

  it("keeps a stored scope when a client without the field saves", async () => {
    const stored = await dashboardOf(dashboardId);
    const saved = await call(
      "PUT",
      `/v1/workspaces/${workspaceId}/dashboards/${dashboardId}`,
      {
        cookie: owner,
        payload: {
          name: stored.name,
          version: stored.version,
          projectId: stored.projectId,
          slides: stored.slides.map(
            ({
              scope: _scope,
              logoImageId: _logo,
              formatWarnings: _warnings,
              position: _position,
              ...slide
            }: Record<string, unknown>) => slide,
          ),
        },
      },
    );
    expect(saved.statusCode, saved.body).toBe(200);
    expect(
      saved
        .json()
        .dashboard.slides.map((slide: { scope: unknown }) => slide.scope),
    ).toEqual([only(APP_A()), only(APP_B()), {}]);
  });
});

describe("a slide scoped to a linked product (#777)", () => {
  // A second model over a store-template install's mapping table, which
  // links app-b into a product; the app filter maps to it as well.
  let productsModelId: string;
  const productFilter = () => ({
    ...appFilter(),
    mappings: [
      { modelId, dimensionId: "app" },
      { modelId: productsModelId, dimensionId: "app" },
    ],
  });

  beforeAll(async () => {
    const data = `/v1/workspaces/${workspaceId}/data`;
    const mapping = await call("POST", `${data}/manual`, {
      cookie: owner,
      payload: {
        definition: {
          key: "store_mapping",
          name: "Mapping",
          version: 1,
          mode: "snapshot",
          grain: "One product per source app",
          keyFields: ["app_key"],
          retentionDays: null,
          fields: ["app_key", "product_id"].map((id) => ({
            id,
            name: id,
            type: "string",
            nullable: false,
            classification: "internal",
          })),
        },
        records: [
          { values: { app_key: APP_B(), product_id: "product:w" } },
          // A product with two apps of the connection picks no single one.
          { values: { app_key: APP_A(), product_id: "product:twins" } },
          {
            values: {
              app_key: connectionResourceKey(connectionId, "app-c"),
              product_id: "product:twins",
            },
          },
        ],
      },
    });
    expect(mapping.statusCode, mapping.body).toBe(200);
    const datasetId = mapping.json().datasetId as string;
    const model = await call("POST", `${data}/models`, {
      cookie: owner,
      payload: {
        name: "Products",
        definition: {
          version: 1,
          datasets: [datasetId],
          relationships: [],
          dimensions: [
            { id: "app", name: "App", datasetId, fieldId: "product_id" },
          ],
          measures: [
            {
              id: "apps",
              name: "Apps",
              kind: "aggregate",
              datasetId,
              aggregate: { id: "apps", name: "apps", op: "count" },
            },
          ],
        },
      },
    });
    expect(model.statusCode, model.body).toBe(200);
    productsModelId = model.json().model.id as string;
    expect(
      (
        await call("POST", `${data}/models/${productsModelId}/publish`, {
          cookie: owner,
          payload: { version: 1 },
        })
      ).statusCode,
    ).toBe(200);
    await admin`
      insert into data_template_installs (workspace_id, request_id,
        request_hash, result)
      values (${workspaceId}, gen_random_uuid(), ${"0".repeat(64)},
        ${admin.json({ mappingDatasetId: datasetId })})`;
  }, 120_000);

  it("gives a metric widget the product's app of its connection", async () => {
    const created = await createDashboard(
      [
        // No exclusion: the widget follows the product through its app.
        { name: "Product", scope: only("product:w"), widgets: [downloads()] },
        {
          name: "All apps",
          widgets: [
            downloads({
              filterExclusions: [{ filterId: "app", reason: "All apps" }],
            }),
          ],
        },
      ],
      { dataFilters: [productFilter()] },
    );
    expect(created.statusCode, created.body).toBe(200);
    const dashboard = created.json().dashboard;
    // Browsers resolve the same scope from the products' member apps.
    expect(dashboard.productApps).toEqual({
      "product:twins": [APP_A(), connectionResourceKey(connectionId, "app-c")],
      "product:w": [APP_B()],
    });
    expect((await dashboardOf(dashboard.id)).productApps).toEqual(
      dashboard.productApps,
    );
    const body = deviceDashboardV3ResponseSchema.parse(
      await devicePayload(await pair(dashboard.id)),
    );
    // app-b's downloads only; before, every app's (3030).
    expect(downloadsOf(slideWidgets(body, 0))).toBe(3000);
    expect(downloadsOf(slideWidgets(body, 1))).toBe(3030);
    // Schema 1 tiles follow it as well.
    const tiles = (await call("GET", "/v1/device/dashboard", {
      token: (await pair(dashboard.id)).accessToken,
    })) as InjectResponse;
    expect(tiles.statusCode, tiles.body).toBe(200);
    expect(
      (tiles.json() as { tiles: { value: number }[] }).tiles.map(
        (tile) => tile.value,
      ),
    ).toEqual([3000, 3030]);
  });

  it("refuses a widget fixed to another app, and one the product picks no single app for", async () => {
    expectError(
      await createDashboard(
        [
          {
            scope: only("product:w"),
            widgets: [downloads({ dimensions: { resource: "app-a" } })],
          },
        ],
        { dataFilters: [productFilter()] },
      ),
      400,
      "slide_scope_resource_conflict",
    );
    for (const product of ["product:twins", "product:unknown"])
      expectError(
        await createDashboard(
          [{ scope: only(product), widgets: [downloads()] }],
          { dataFilters: [productFilter()] },
        ),
        400,
        "dashboard_filter_not_applicable",
      );
  });

  it("has no products on a dashboard without shared filters", async () => {
    const created = await createDashboard([{ widgets: [] }], {
      dataFilters: [],
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json().dashboard).not.toHaveProperty("productApps");
  });
});

describe("a screen scope and a slide scope", () => {
  it("leaves out a slide scoped to an app the screen may not show", async () => {
    const created = await createDashboard([
      { name: "App A", scope: only(APP_A()), widgets: [income()] },
      { name: "App B", scope: only(APP_B()), widgets: [income()] },
      { name: "Overview", widgets: [income()] },
    ]);
    expect(created.statusCode, created.body).toBe(200);
    const screen = await pair(created.json().dashboard.id);
    const scoped = await call(
      "PATCH",
      `/v1/workspaces/${workspaceId}/devices/${screen.id}`,
      { cookie: owner, payload: { scope: { values: only(APP_A()) } } },
    );
    expect(scoped.statusCode, scoped.body).toBe(200);
    for (const schema of [2, 3] as const) {
      const body = await devicePayload(screen, schema);
      (schema === 2
        ? deviceDashboardV2ResponseSchema
        : deviceDashboardV3ResponseSchema
      ).parse(body);
      // The screen's scope wins: App B's slide is not shown, and the
      // overview shows App A only.
      expect(
        (body.slides as Array<{ name: string }>).map((slide) => slide.name),
      ).toEqual(["App A", "Overview"]);
      expect(incomeOf(slideWidgets(body, 0))).toBe("150");
      expect(incomeOf(slideWidgets(body, 1))).toBe("150");
    }
    // A screen scope of both apps shows every slide, each narrowed further.
    await call("PATCH", `/v1/workspaces/${workspaceId}/devices/${screen.id}`, {
      cookie: owner,
      payload: {
        scope: {
          values: { app: { kind: "values", values: [APP_A(), APP_B()] } },
        },
      },
    });
    const both = await devicePayload(screen);
    expect(
      (both.slides as Array<{ name: string }>).map((slide) => slide.name),
    ).toEqual(["App A", "App B", "Overview"]);
    expect(incomeOf(slideWidgets(both, 1))).toBe("25");
  });
});

describe("a slide's logo", () => {
  it("round-trips, reaches screens and stays in its workspace", async () => {
    const dashboardLogo = await upload(workspaceId, owner);
    const slideLogo = await upload(workspaceId, owner);
    const foreignLogo = await upload(otherWorkspaceId, stranger);
    expectError(
      await createDashboard([{ logoImageId: foreignLogo, widgets: [] }]),
      400,
      "image_not_found",
    );
    const created = await createDashboard(
      [
        { name: "With logo", logoImageId: slideLogo, widgets: [] },
        { name: "Without", widgets: [] },
      ],
      { logoImageId: dashboardLogo },
    );
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().dashboard.id as string;
    const stored = await dashboardOf(id);
    expect(
      stored.slides.map((slide: { logoImageId: unknown }) => slide.logoImageId),
    ).toEqual([slideLogo, null]);

    // Replacing with another workspace's image is refused too.
    expectError(
      await call("PUT", `/v1/workspaces/${workspaceId}/dashboards/${id}`, {
        cookie: owner,
        payload: {
          name: stored.name,
          version: stored.version,
          projectId: stored.projectId,
          slides: [{ logoImageId: foreignLogo, widgets: [] }],
        },
      }),
      400,
      "image_not_found",
    );

    const screen = await pair(id);
    const body = deviceDashboardV3ResponseSchema.parse(
      await devicePayload(screen),
    );
    expect(body.dashboard?.logo).toEqual({ imageId: dashboardLogo });
    expect(body.slides[0]!.logo).toEqual({ imageId: slideLogo });
    // Additive: a slide without a logo of its own has no field.
    expect("logo" in body.slides[1]!).toBe(false);
    expect(body.images.map((image) => image.id).sort()).toEqual(
      [dashboardLogo, slideLogo].sort(),
    );
    const served = await call("GET", `/v1/device/images/${slideLogo}`, {
      token: screen.accessToken,
    });
    expect(served.statusCode).toBe(200);

    // A used slide logo cannot be deleted.
    const deleted = await call(
      "DELETE" as "GET",
      `/v1/workspaces/${workspaceId}/images/${slideLogo}`,
      { cookie: owner },
    );
    expect(deleted.statusCode, deleted.body).toBe(409);
  });
});
