import { and, eq } from "drizzle-orm";
import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  schema,
  withWorkspace,
  type Database,
} from "@netrics/database";
import {
  dataImpactResponseSchema,
  modelResponseSchema,
  preparationResponseSchema,
  workspaceResponseSchema,
} from "@netrics/contracts";
import { buildApp } from "../app.js";
import { createAuthService } from "../auth/index.js";
import { loadConfig } from "../env.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "../test-db.js";
import { addMemberViaInvitation } from "../test-helpers.js";

let app: FastifyInstance, db: Database;
let ownerW1: string, ownerW2: string, viewerW1: string;
interface Shape {
  workspaceId: string;
  prep: string;
  model: string;
  dashboard: string;
  filters: string;
}
let w1: Shape, w2: Shape, brokenModel: string;

const call = (
  method: "GET" | "POST" | "PUT",
  path: string,
  cookie: string,
  payload?: unknown,
  workspaceId = w1.workspaceId,
) =>
  app.inject({
    method,
    url: `/v1/workspaces/${workspaceId}${path}`,
    headers: { cookie },
    ...(payload === undefined
      ? {}
      : { payload: payload as InjectOptions["payload"] }),
  });

async function signup(email: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { name: email, email, password: "password-12345" },
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers["set-cookie"];
  return (Array.isArray(header) ? header : [header])
    .find((c) => c?.startsWith("better-auth.session_token="))!
    .split(";")[0]!;
}

const definition = (datasetId: string, total = "sum") => ({
  version: 1,
  datasets: [datasetId],
  relationships: [],
  dimensions: [{ id: "label", name: "Label", datasetId, fieldId: "id" }],
  measures: [
    {
      id: "spend",
      name: "Spend",
      kind: "aggregate",
      datasetId,
      aggregate: { id: "spend", name: "Spend", op: total, fieldId: "amount" },
    },
    {
      id: "doubled",
      name: "Doubled spend",
      kind: "formula",
      expression: {
        kind: "call",
        fn: "multiply",
        args: [
          { kind: "field", fieldId: "spend" },
          { kind: "literal", type: "integer", value: 2 },
        ],
      },
    },
    {
      id: "rows",
      name: "Rows",
      kind: "aggregate",
      datasetId,
      aggregate: { id: "rows", name: "Rows", op: "count" },
    },
  ],
});

/** Preparation → model → dashboard (one measure widget) → paired "Lobby", plus a revoked "Old". */
async function buildShape(cookie: string, name: string): Promise<Shape> {
  const created = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { cookie },
    payload: { name },
  });
  const workspaceId = workspaceResponseSchema.parse(created.json()).workspace
    .id;
  const source = await call(
    "POST",
    "/data/manual",
    cookie,
    {
      definition: {
        key: "numbers",
        name: "Numbers",
        version: 1,
        mode: "snapshot",
        grain: "one number",
        keyFields: ["id"],
        retentionDays: 30,
        fields: [
          {
            id: "id",
            name: "ID",
            type: "string",
            nullable: false,
            classification: "internal",
          },
          {
            id: "amount",
            name: "Amount",
            type: "decimal",
            nullable: false,
            classification: "internal",
          },
        ],
      },
      records: [{ values: { id: "one", amount: "12.50" } }],
    },
    workspaceId,
  );
  expect(source.statusCode, source.body).toBe(200);
  const prepSaved = await call(
    "POST",
    "/data/preparations",
    cookie,
    {
      name: name + " numbers",
      graph: {
        version: 1,
        nodes: [
          { id: "source", type: "source", datasetId: source.json().datasetId },
          {
            id: "kept",
            type: "select",
            input: "source",
            fields: ["id", "amount"],
          },
        ],
        outputs: ["kept"],
      },
    },
    workspaceId,
  );
  expect(prepSaved.statusCode, prepSaved.body).toBe(200);
  const prep = preparationResponseSchema.parse(prepSaved.json()).preparation.id;
  expect(
    (
      await call(
        "POST",
        `/data/preparations/${prep}/publish`,
        cookie,
        { version: 1 },
        workspaceId,
      )
    ).statusCode,
  ).toBe(200);
  const modelSaved = await call(
    "POST",
    "/data/models",
    cookie,
    {
      name: name + " model",
      definition: definition(`prepared:${prep}:kept`),
    },
    workspaceId,
  );
  expect(modelSaved.statusCode, modelSaved.body).toBe(200);
  const model = modelResponseSchema.parse(modelSaved.json()).model.id;
  expect(
    (
      await call(
        "POST",
        `/data/models/${model}/publish`,
        cookie,
        { version: 1 },
        workspaceId,
      )
    ).statusCode,
  ).toBe(200);
  const dashboardSaved = await call(
    "POST",
    "/dashboards",
    cookie,
    {
      name: name + " dashboard",
      slides: [
        {
          widgets: [
            {
              type: "measure",
              x: 0,
              y: 0,
              w: 6,
              h: 3,
              title: "Spend",
              binding: {
                modelId: model,
                measureIds: ["doubled"],
                groupBy: [],
                exclusions: [],
              },
              options: { view: "value", limit: 20 },
            },
          ],
        },
      ],
    },
    workspaceId,
  );
  expect(dashboardSaved.statusCode, dashboardSaved.body).toBe(200);
  const dashboard = (dashboardSaved.json() as { dashboard: { id: string } })
    .dashboard.id;
  // A dashboard tied to the model only through a shared filter mapping.
  const filtersSaved = await call(
    "POST",
    "/dashboards",
    cookie,
    {
      name: name + " filters",
      settings: {
        dataFilters: [
          {
            id: "label",
            name: "Label",
            type: "string",
            mode: "values",
            defaultValue: null,
            mappings: [{ modelId: model, dimensionId: "label" }],
          },
        ],
      },
      slides: [{ widgets: [] }],
    },
    workspaceId,
  );
  expect(filtersSaved.statusCode, filtersSaved.body).toBe(200);
  const filters = (filtersSaved.json() as { dashboard: { id: string } })
    .dashboard.id;
  await withWorkspace(db, { workspaceId }, async (tx) => {
    // A compare widget bound to the model's measures (#507), written as
    // stored: its metric side needs a connection this fixture does not have.
    const [measureWidget] = await tx
      .select()
      .from(schema.dashboardWidgets)
      .where(
        and(
          eq(schema.dashboardWidgets.workspaceId, workspaceId),
          eq(schema.dashboardWidgets.dashboardId, dashboard),
        ),
      );
    const [connection] = await tx
      .insert(schema.connections)
      .values({ workspaceId, connectorId: "demo", name: "Shop" })
      .returning({ id: schema.connections.id });
    await tx.insert(schema.dashboardWidgets).values({
      connectionId: connection!.id,
      metricKey: "demo.orders",
      aggregation: "sum",
      period: "last_7_days",
      denominatorConnectionId: connection!.id,
      denominatorMetricKey: "demo.visits",
      denominatorAggregation: "sum",
      slideId: measureWidget!.slideId,
      dashboardId: dashboard,
      workspaceId,
      type: "compare",
      modelId: model,
      modelBinding: {
        modelId: model,
        dateDimensionId: "label",
        measureIds: {
          numerator: "spend",
          denominator: "doubled",
          ratio: "doubled",
        },
      },
      x: 6,
      y: 0,
      w: 6,
      h: 3,
      title: "Ratio",
    });
    await tx.insert(schema.devices).values([
      { workspaceId, name: "Lobby", dashboardId: dashboard },
      {
        workspaceId,
        name: "Old",
        dashboardId: dashboard,
        revokedAt: new Date(),
      },
      {
        workspaceId,
        name: "Scoped",
        dashboardId: filters,
        scope: {
          dashboardId: filters,
          values: { label: { kind: "values", values: ["one"] } },
        },
      },
    ]);
  });
  return { workspaceId, prep, model, dashboard, filters };
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
  app = await buildApp(config, {
    db,
    authService: createAuthService(config, db, {
      logger: pino({ level: "silent" }),
    }),
    checkDb: async () => true,
  });
  ownerW1 = await signup("impact-owner-1@example.com");
  ownerW2 = await signup("impact-owner-2@example.com");
  viewerW1 = await signup("impact-viewer@example.com");
  w1 = await buildShape(ownerW1, "W1");
  w2 = await buildShape(ownerW2, "W2");
  // A published model whose stored draft no longer parses: its live
  // release still reads the preparation and must stay listed.
  const broken = await call("POST", "/data/models", ownerW1, {
    name: "W1 broken draft",
    definition: definition(`prepared:${w1.prep}:kept`),
  });
  expect(broken.statusCode, broken.body).toBe(200);
  brokenModel = modelResponseSchema.parse(broken.json()).model.id;
  expect(
    (
      await call("POST", `/data/models/${brokenModel}/publish`, ownerW1, {
        version: 1,
      })
    ).statusCode,
  ).toBe(200);
  await withWorkspace(db, { workspaceId: w1.workspaceId }, (tx) =>
    tx
      .update(schema.dataModels)
      .set({ definition: { version: 1, retired: true } })
      .where(
        and(
          eq(schema.dataModels.workspaceId, w1.workspaceId),
          eq(schema.dataModels.id, brokenModel),
        ),
      ),
  );
  expect(
    (
      await addMemberViaInvitation(
        app,
        db,
        ownerW1,
        w1.workspaceId,
        "impact-viewer@example.com",
        "viewer",
      )
    ).statusCode,
  ).toBe(200);
}, TEST_DATABASE_SETUP_TIMEOUT_MS);
afterAll(async () => {
  await app?.close();
  await db?.$client.end({ timeout: 5 });
});

describe("impact before publish routes", () => {
  it("lists dependents of a preparation in the caller's workspace only", async () => {
    const res = await call(
      "GET",
      `/data/preparations/${w1.prep}/impact`,
      ownerW1,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = dataImpactResponseSchema.parse(res.json());
    expect(body.target).toEqual({ kind: "preparation", id: w1.prep });
    expect(body.models).toEqual([
      {
        id: brokenModel,
        name: "W1 broken draft",
        publishedVersion: 1,
        pinnedVersion: 1,
      },
      {
        id: w1.model,
        name: "W1 model",
        publishedVersion: 1,
        pinnedVersion: 1,
      },
    ]);
    expect(body.dashboards).toEqual([
      {
        id: w1.dashboard,
        name: "W1 dashboard",
        widgets: [
          { id: expect.any(String), type: "compare", title: "Ratio" },
          { id: expect.any(String), type: "measure", title: "Spend" },
        ],
        viaFilter: false,
      },
      { id: w1.filters, name: "W1 filters", widgets: [], viaFilter: true },
    ]);
    expect(body.screens).toEqual([
      { id: expect.any(String), name: "Lobby", dashboardId: w1.dashboard },
      { id: expect.any(String), name: "Scoped", dashboardId: w1.filters },
    ]);
    expect(body.hidden).toEqual({
      preparations: 0,
      models: 0,
      dashboards: 0,
      screens: 0,
    });
    for (const foreign of [w2.prep, w2.model, w2.dashboard])
      expect(JSON.stringify(body)).not.toContain(foreign);
    // The model with the unreadable draft still answers.
    const broken = await call(
      "GET",
      `/data/models/${brokenModel}/impact`,
      ownerW1,
    );
    expect(broken.statusCode, broken.body).toBe(200);
    expect(
      dataImpactResponseSchema.parse(broken.json()).changedMeasureIds,
    ).toEqual([]);
    expect(
      (
        await call(
          "GET",
          `/data/models/${brokenModel}/impact?measureId=spend`,
          ownerW1,
        )
      ).statusCode,
    ).toBe(404);
  });

  it("answers 404 for another workspace's preparation and model", async () => {
    const prep = await call(
      "GET",
      `/data/preparations/${w2.prep}/impact`,
      ownerW1,
    );
    expect([prep.statusCode, prep.json()]).toEqual([
      404,
      { error: "data_preparation_not_found" },
    ]);
    const model = await call("GET", `/data/models/${w2.model}/impact`, ownerW1);
    expect([model.statusCode, model.json()]).toEqual([
      404,
      { error: "data_model_not_found" },
    ]);
  });

  it("refuses viewers", async () => {
    expect(
      (await call("GET", `/data/models/${w1.model}/impact`, viewerW1))
        .statusCode,
    ).toBe(403);
    expect(
      (await call("GET", `/data/preparations/${w1.prep}/impact`, viewerW1))
        .statusCode,
    ).toBe(403);
  });

  it("narrows to a measure and rejects unknown measures", async () => {
    const spend = await call(
      "GET",
      `/data/models/${w1.model}/impact?measureId=spend`,
      ownerW1,
    );
    expect(spend.statusCode, spend.body).toBe(200);
    const body = dataImpactResponseSchema.parse(spend.json());
    expect(body.target).toEqual({
      kind: "measure",
      id: w1.model,
      measureIds: ["spend"],
    });
    expect(body.measures).toEqual([
      { modelId: w1.model, id: "doubled", name: "Doubled spend" },
    ]);
    // A shared filter reads dimensions only: the filter-only dashboard and
    // its scoped screen are not affected by a measure.
    expect(body.dashboards.map((d) => d.id)).toEqual([w1.dashboard]);
    expect(body.dashboards[0]!.widgets.map((w) => w.type)).toEqual([
      "compare",
      "measure",
    ]);
    expect(body.screens.map((s) => s.name)).toEqual(["Lobby"]);
    const rows = dataImpactResponseSchema.parse(
      (
        await call(
          "GET",
          `/data/models/${w1.model}/impact?measureId=rows&measureId=spend`,
          ownerW1,
        )
      ).json(),
    );
    expect(rows.target).toEqual({
      kind: "measure",
      id: w1.model,
      measureIds: ["rows", "spend"],
    });
    const unused = dataImpactResponseSchema.parse(
      (
        await call(
          "GET",
          `/data/models/${w1.model}/impact?measureId=rows`,
          ownerW1,
        )
      ).json(),
    );
    expect(unused.dashboards).toEqual([]);
    expect(unused.screens).toEqual([]);
    const nope = await call(
      "GET",
      `/data/models/${w1.model}/impact?measureId=nope`,
      ownerW1,
    );
    expect([nope.statusCode, nope.json()]).toEqual([
      404,
      { error: "data_measure_not_found" },
    ]);
    expect(
      (
        await call(
          "GET",
          `/data/models/${w1.model}/impact?measureId=1bad`,
          ownerW1,
        )
      ).statusCode,
    ).toBe(400);
  });

  it("reports measures changed in the draft and does not block publishing", async () => {
    const saved = await call("PUT", `/data/models/${w1.model}`, ownerW1, {
      name: "W1 model",
      definition: definition(`prepared:${w1.prep}:kept`, "max"),
      version: 1,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const version = modelResponseSchema.parse(saved.json()).model.version;
    const impact = dataImpactResponseSchema.parse(
      (await call("GET", `/data/models/${w1.model}/impact`, ownerW1)).json(),
    );
    expect(impact.changedMeasureIds).toEqual(["spend"]);
    expect(impact.dashboards.map((d) => [d.id, d.viaFilter])).toEqual([
      [w1.dashboard, false],
      [w1.filters, true],
    ]);
    expect(impact.screens.map((s) => s.name)).toEqual(["Lobby", "Scoped"]);
    const published = await call(
      "POST",
      `/data/models/${w1.model}/publish`,
      ownerW1,
      { version },
    );
    expect(published.statusCode, published.body).toBe(200);
    expect(
      dataImpactResponseSchema.parse(
        (await call("GET", `/data/models/${w1.model}/impact`, ownerW1)).json(),
      ).changedMeasureIds,
    ).toEqual([]);
  });
});
