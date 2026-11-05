import { buildDeviceDashboardV3 } from "./devices/dashboard.js";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  withWorkspace,
  schema,
  type Database,
} from "@netrics/database";
import {
  workspaceResponseSchema,
  modelResponseSchema,
  modelQueryResponseSchema,
} from "@netrics/contracts";
import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";
import { createTestDatabase } from "./test-db.js";
import { addMemberViaInvitation } from "./test-helpers.js";

let app: FastifyInstance, db: Database;
let owner: string, editor: string, viewer: string, stranger: string;
let workspaceId: string, datasetId: string, modelId: string;
const base = () => `/v1/workspaces/${workspaceId}/data`;
const call = (
  method: "GET" | "POST" | "PUT",
  path: string,
  cookie?: string,
  payload?: unknown,
) =>
  app.inject({
    method,
    url: base() + path,
    headers: cookie ? { cookie } : {},
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
  owner = await signup("data-owner@example.com");
  editor = await signup("data-editor@example.com");
  viewer = await signup("data-viewer@example.com");
  stranger = await signup("data-stranger@example.com");
  const created = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { cookie: owner },
    payload: { name: "Data" },
  });
  workspaceId = workspaceResponseSchema.parse(created.json()).workspace.id;
  for (const [email, role] of [
    ["data-editor@example.com", "editor"],
    ["data-viewer@example.com", "viewer"],
  ] as const)
    expect(
      (await addMemberViaInvitation(app, db, owner, workspaceId, email, role))
        .statusCode,
    ).toBe(200);
}, 60000);
afterAll(async () => {
  await app?.close();
  await db?.$client.end({ timeout: 5 });
});

describe("data API authorization and contract", () => {
  const manual = {
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
  };
  it("requires a session, hides foreign workspaces, and denies viewers source rows", async () => {
    expect((await call("GET", "/sources")).statusCode).toBe(401);
    expect((await call("GET", "/sources", stranger)).statusCode).toBe(404);
    expect((await call("GET", "/sources", viewer)).statusCode).toBe(403);
    expect((await call("POST", "/manual", viewer, manual)).statusCode).toBe(
      403,
    );
  });
  it("authorizes store templates and paged manual editing before accessing workspace data", async () => {
    const url = `/v1/workspaces/${workspaceId}/dashboard-templates/stores`;
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    for (const [cookie, status] of [
      [viewer, 403],
      [stranger, 404],
    ] as const) {
      expect(
        (await app.inject({ method: "GET", url, headers: { cookie } }))
          .statusCode,
      ).toBe(status);
      expect(
        (
          await app.inject({
            method: "POST",
            url,
            headers: { cookie },
            payload: {
              requestId: randomUUID(),
              name: "Stores",
              connections: [randomUUID()],
              groups: [],
            },
          })
        ).statusCode,
      ).toBe(status);
      expect(
        (
          await call("POST", "/manual/pages", cookie, {
            definition: manual.definition,
            generationId: null,
            refreshId: randomUUID(),
            page: 0,
            complete: true,
            records: manual.records,
          })
        ).statusCode,
      ).toBe(status);
      expect(
        (
          await call("POST", `/manual/${randomUUID()}/read`, cookie, {
            offset: 0,
            limit: 1000,
          })
        ).statusCode,
      ).toBe(status);
    }
    const [connection] = await withWorkspace(db, { workspaceId }, (tx) =>
      tx
        .insert(schema.connections)
        .values({
          workspaceId,
          connectorId: "app-store-connect",
          name: "Template Apple",
          setupPending: false,
        })
        .returning(),
    );
    const payload = {
      requestId: randomUUID(),
      name: "Stores",
      connections: [connection!.id],
      groups: [],
    };
    const response = await app.inject({
      method: "POST",
      url,
      headers: { cookie: editor },
      payload,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      productDatasetId: expect.any(String),
      mappingDatasetId: expect.any(String),
      models: {
        downloads: expect.any(String),
        proceeds: expect.any(String),
        ratings: expect.any(String),
      },
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { cookie: editor },
          payload,
        })
      ).json(),
    ).toEqual(response.json());
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { cookie: editor },
          payload: {
            ...payload,
            requestId: randomUUID(),
            connections: [randomUUID()],
          },
        })
      ).statusCode,
    ).toBe(404);
  });
  it("lets an editor publish reference data, a model and its measures", async () => {
    const source = await call("POST", "/manual", editor, manual);
    expect(source.statusCode, source.body).toBe(200);
    datasetId = source.json().datasetId as string;
    const model = await call("POST", "/models", editor, {
      name: "Numbers",
      definition: {
        version: 1,
        datasets: [datasetId],
        relationships: [],
        dimensions: [],
        measures: [
          {
            id: "total",
            name: "Total",
            kind: "aggregate",
            datasetId,
            aggregate: {
              id: "total",
              name: "Total",
              op: "sum",
              fieldId: "amount",
            },
          },
        ],
      },
    });
    expect(model.statusCode, model.body).toBe(200);
    modelId = modelResponseSchema.parse(model.json()).model.id;
    expect(
      (
        await call("POST", `/models/${modelId}/query`, viewer, {
          measureIds: ["total"],
          groupBy: [],
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await call("POST", `/models/${modelId}/publish`, editor, { version: 1 }))
        .statusCode,
    ).toBe(200);
  });
  it("lets viewers query published results while keeping drafts, previews and formulas restricted", async () => {
    const response = await call("POST", `/models/${modelId}/query`, viewer, {
      measureIds: ["total"],
      groupBy: [],
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      modelQueryResponseSchema.parse(response.json()).rows[0]?.measures.total,
    ).toMatchObject({ value: "12.5", type: "decimal", status: "ok" });
    for (const [method, path, payload] of [
      ["GET", "/models", undefined],
      ["GET", `/models/${modelId}`, undefined],
      [
        "POST",
        `/models/${modelId}/preview`,
        { measureIds: ["total"], groupBy: [] },
      ],
      ["POST", "/preview", { sourceId: datasetId }],
      ["POST", "/formula", { formula: "1 + 2", references: [] }],
      ["POST", `/models/${modelId}/publish`, { version: 1 }],
    ] as const)
      expect((await call(method, path, viewer, payload)).statusCode).toBe(403);
    expect(
      (
        await call("POST", `/models/${modelId}/query`, stranger, {
          measureIds: ["total"],
          groupBy: [],
        })
      ).statusCode,
    ).toBe(404);
  });
  it("previews an unsaved model without creating or changing a draft", async () => {
    const draft = modelResponseSchema.parse(
      (await call("GET", `/models/${modelId}`, editor)).json(),
    ).model;
    const before = (await call("GET", "/models", editor)).json().models.length;
    const body = {
      definition: draft.definition,
      query: { measureIds: ["total"], groupBy: [] },
    };
    const preview = await call("POST", "/models/preview", editor, body);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(modelQueryResponseSchema.parse(preview.json())).toMatchObject({
      releaseId: null,
      rows: [{ measures: { total: { value: "12.5" } } }],
    });
    expect((await call("GET", "/models", editor)).json().models).toHaveLength(
      before,
    );
    expect(
      (await call("POST", "/models/preview", viewer, body)).statusCode,
    ).toBe(403);
    expect(
      (await call("POST", "/models/preview", stranger, body)).statusCode,
    ).toBe(404);
  });
  it("continues pinned result pages through the authorized query API", async () => {
    const source = await call("POST", "/manual", editor, {
      ...manual,
      definition: { ...manual.definition, key: "paged-numbers" },
      records: [
        { values: { id: "one", amount: "1.10" } },
        { values: { id: "two", amount: "2.20" } },
      ],
    });
    expect(source.statusCode, source.body).toBe(200);
    const datasetId = source.json().datasetId as string;
    const created = await call("POST", "/models", editor, {
      name: "Paged numbers",
      definition: {
        version: 1,
        datasets: [datasetId],
        relationships: [],
        dimensions: [{ id: "id", name: "ID", datasetId, fieldId: "id" }],
        measures: [
          {
            id: "total",
            name: "Total",
            kind: "aggregate",
            datasetId,
            aggregate: {
              id: "total",
              name: "Total",
              op: "sum",
              fieldId: "amount",
            },
          },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const id = modelResponseSchema.parse(created.json()).model.id;
    expect(
      (await call("POST", `/models/${id}/publish`, editor, { version: 1 }))
        .statusCode,
    ).toBe(200);
    const input = { measureIds: ["total"], groupBy: ["id"], limit: 1 };
    const firstResponse = await call("POST", `/models/${id}/query`, viewer, {
      ...input,
      pinPages: true,
    });
    expect(firstResponse.statusCode, firstResponse.body).toBe(200);
    const first = modelQueryResponseSchema.parse(firstResponse.json());
    expect(first.nextPageToken).toBeDefined();
    const continuation = { ...input, pageToken: first.nextPageToken! };
    expect(
      (await call("POST", `/models/${id}/query`, undefined, continuation))
        .statusCode,
    ).toBe(401);
    expect(
      (await call("POST", `/models/${id}/query`, stranger, continuation))
        .statusCode,
    ).toBe(404);
    const response = await call(
      "POST",
      `/models/${id}/query`,
      viewer,
      continuation,
    );
    expect(response.statusCode, response.body).toBe(200);
    const second = modelQueryResponseSchema.parse(response.json());
    expect(second).toMatchObject({
      releaseId: first.releaseId,
      provenance: first.provenance,
      offset: 1,
    });
    expect(second.rows[0]).toMatchObject({
      dimensions: { id: "two" },
      measures: { total: { value: "2.2" } },
    });
    expect(
      (
        await call("POST", `/models/${id}/query`, viewer, {
          ...continuation,
          filter: { kind: "literal", type: "boolean", value: true },
        })
      ).statusCode,
    ).toBe(409);
  });
  it("restricts history and draft restoration to editors and leaves published results active", async () => {
    const current = modelResponseSchema.parse(
      (await call("GET", `/models/${modelId}`, editor)).json(),
    ).model;
    const created = await call("POST", "/models", editor, {
      name: "History model",
      definition: current.definition,
    });
    const model = modelResponseSchema.parse(created.json()).model;
    expect(
      (
        await call("POST", `/models/${model.id}/publish`, editor, {
          version: 1,
        })
      ).statusCode,
    ).toBe(200);
    const prep = await call("POST", "/preparations", editor, {
      name: "History preparation",
      graph: {
        version: 1,
        nodes: [{ id: "source", type: "source", datasetId }],
        outputs: ["source"],
      },
    });
    const preparation = prep.json().preparation as { id: string };
    expect(
      (
        await call("POST", `/preparations/${preparation.id}/publish`, editor, {
          version: 1,
        })
      ).statusCode,
    ).toBe(200);
    for (const [kind, resourceId] of [
      ["models", model.id],
      ["preparations", preparation.id],
    ] as const) {
      const history = await call(
        "GET",
        `/${kind}/${resourceId}/history?limit=1`,
        editor,
      );
      expect(history.statusCode, history.body).toBe(200);
      expect(history.headers["cache-control"]).toBe("no-store");
      expect(history.json()).toMatchObject({
        versions: [{ version: 1, active: true }],
        nextBeforeVersion: null,
      });
      expect(
        (await call("GET", `/${kind}/${resourceId}/history?limit=51`, editor))
          .statusCode,
      ).toBe(400);
      expect(
        (await call("GET", `/${kind}/${resourceId}/history`, viewer))
          .statusCode,
      ).toBe(403);
      expect(
        (await call("GET", `/${kind}/${resourceId}/history`, stranger))
          .statusCode,
      ).toBe(404);
      expect(
        (
          await call("POST", `/${kind}/${resourceId}/restore`, viewer, {
            version: 1,
            publishedVersion: 1,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await call("POST", `/${kind}/${resourceId}/restore`, stranger, {
            version: 1,
            publishedVersion: 1,
          })
        ).statusCode,
      ).toBe(404);
      const restored = await call(
        "POST",
        `/${kind}/${resourceId}/restore`,
        editor,
        { version: 1, publishedVersion: 1 },
      );
      expect(restored.statusCode, restored.body).toBe(200);
      expect(Object.values(restored.json())[0]).toMatchObject({
        version: 2,
        publishedVersion: 1,
        restoredFromVersion: 1,
      });
      expect(
        (
          await call("POST", `/${kind}/${resourceId}/restore`, editor, {
            version: 1,
            publishedVersion: 1,
          })
        ).statusCode,
      ).toBe(409);
    }
    const live = await call("POST", `/models/${model.id}/query`, viewer, {
      measureIds: ["total"],
      groupBy: [],
    });
    expect(live.statusCode).toBe(200);
    expect(live.json().rows[0].measures.total.value).toBe("12.5");
    const stalePreview = await call("POST", "/models/preview", editor, {
      definition: model.definition,
      query: { measureIds: ["total"], groupBy: [] },
      draft: { id: model.id, version: 1 },
    });
    expect(stalePreview.statusCode).toBe(409);
  });
  it("rejects arbitrary code and excessive expression nesting before execution", async () => {
    const code = await call("POST", "/formula", editor, {
      formula: "globalThis.process.exit()",
      references: [],
    });
    expect(code.statusCode).toBe(400);
    let expression: unknown = { kind: "literal", type: "boolean", value: true };
    for (let depth = 0; depth < 30; depth++)
      expression = { kind: "call", fn: "not", args: [expression] };
    const response = await call("POST", `/models/${modelId}/query`, viewer, {
      measureIds: ["total"],
      groupBy: [],
      filter: expression,
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("process");
  });
});

describe("published dashboard measure bindings", () => {
  let dashboardId: string, portfolioId: string;
  const dataCall = (
    method: "GET" | "POST" | "PUT",
    path: string,
    cookie: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url: `/v1/workspaces/${workspaceId}/dashboards${path}`,
      headers: { cookie },
      ...(payload === undefined
        ? {}
        : { payload: payload as InjectOptions["payload"] }),
    });
  const filter = () => ({
    id: "country",
    name: "Country",
    type: "string",
    mode: "values",
    mappings: [{ modelId: portfolioId, dimensionId: "country" }],
    defaultValue: null,
  });
  const widget = (measureId: string, x = 0) => ({
    type: "measure",
    x,
    y: 0,
    w: 4,
    h: 3,
    binding: {
      modelId: portfolioId,
      measureIds: [measureId],
      groupBy: [],
      exclusions: [],
    },
    options: { view: "value", limit: 20 },
  });
  async function source(
    key: string,
    fields: Array<{
      id: string;
      type: string;
      unit?: string;
      currencyField?: string;
    }>,
    rows: Array<Record<string, unknown>>,
  ) {
    const result = await call("POST", "/manual", editor, {
      definition: {
        key,
        name: key,
        version: 1,
        mode: "snapshot",
        grain: "one fixture record",
        keyFields: ["id"],
        retentionDays: null,
        fields: fields.map((field) => ({
          ...field,
          name: field.id,
          nullable: false,
          classification: "internal",
        })),
      },
      records: rows.map((values) => ({ values })),
    });
    expect(result.statusCode, result.body).toBe(200);
    return result.json().datasetId as string;
  }
  it("publishes independently aggregated facts and exposes only published metadata to viewers", async () => {
    const products = await source(
      "products",
      [
        { id: "id", type: "string" },
        { id: "country", type: "string" },
      ],
      [
        { id: "a", country: "DE" },
        { id: "b", country: "FR" },
      ],
    );
    const fields = [
      { id: "id", type: "string" },
      { id: "product", type: "string" },
      { id: "amount", type: "decimal" },
    ];
    const proceeds = await source("proceeds", fields, [
      { id: "one", product: "a", amount: "100" },
      { id: "two", product: "a", amount: "50" },
      { id: "three", product: "b", amount: "25" },
    ]);
    const spend = await source("spend", fields, [
      { id: "one", product: "a", amount: "30" },
      { id: "two", product: "b", amount: "10" },
    ]);
    const created = await call("POST", "/models", editor, {
      name: "Portfolio",
      definition: {
        version: 1,
        datasets: [products, proceeds, spend],
        relationships: [proceeds, spend].map((datasetId, index) => ({
          id: `r${index}`,
          from: { datasetId, fieldId: "product" },
          to: { datasetId: products, fieldId: "id" },
          cardinality: "many_to_one",
        })),
        dimensions: [
          {
            id: "country",
            name: "Country",
            datasetId: products,
            fieldId: "country",
          },
        ],
        measures: [
          ...[
            ["income", proceeds],
            ["spend", spend],
          ].map(([id, datasetId]) => ({
            id,
            name: id,
            kind: "aggregate",
            datasetId,
            aggregate: { id, name: id, op: "sum", fieldId: "amount" },
          })),
          {
            id: "margin",
            name: "Contribution",
            kind: "formula",
            expression: {
              kind: "call",
              fn: "subtract",
              args: [
                { kind: "field", fieldId: "income" },
                { kind: "field", fieldId: "spend" },
              ],
            },
          },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    portfolioId = created.json().model.id as string;
    const before = await dataCall("GET", "/published-models", viewer);
    expect(
      before
        .json()
        .models.some(
          (model: { modelId: string }) => model.modelId === portfolioId,
        ),
    ).toBe(false);
    expect(
      (
        await call("POST", `/models/${portfolioId}/publish`, editor, {
          version: 1,
        })
      ).statusCode,
    ).toBe(200);
    const catalog = await dataCall("GET", "/published-models", viewer);
    expect(catalog.statusCode, catalog.body).toBe(200);
    expect(
      catalog
        .json()
        .models.find(
          (model: { modelId: string }) => model.modelId === portfolioId,
        ),
    ).toMatchObject({
      modelName: "Portfolio",
      dimensions: [{ id: "country", type: "string" }],
    });
    expect(catalog.body).not.toContain(proceeds);
    expect(catalog.body).not.toContain('"definition"');
    expect(
      (await dataCall("GET", "/published-models", stranger)).statusCode,
    ).toBe(404);
  });
  it("saves reusable measure bindings and shares filters across independent facts", async () => {
    const created = await dataCall("POST", "", editor, {
      name: "Portfolio overview",
      settings: { dataFilters: [filter()] },
      slides: [
        {
          widgets: [widget("income"), widget("spend", 4), widget("margin", 8)],
        },
      ],
    });
    expect(created.statusCode, created.body).toBe(200);
    dashboardId = created.json().dashboard.id as string;
    expect(created.json().dashboard.settings.dataFilters).toEqual([filter()]);
    const query = await dataCall("POST", `/${dashboardId}/data`, viewer, {
      values: { country: { kind: "values", values: ["DE"] } },
    });
    expect(query.statusCode, query.body).toBe(200);
    expect(
      query.json().widgets.map(
        (widget: {
          result: {
            rows: Array<{ measures: Record<string, { value: unknown }> }>;
          };
        }) => Object.values(widget.result.rows[0]!.measures)[0]!.value,
      ),
    ).toEqual(["150", "30", "120"]);
    expect(
      query
        .json()
        .widgets.every(
          (widget: { result: { releaseId: string; provenance: unknown[] } }) =>
            widget.result.releaseId && widget.result.provenance.length,
        ),
    ).toBe(true);
    const reset = await dataCall("POST", `/${dashboardId}/data`, viewer, {
      values: {},
    });
    expect(reset.json().widgets[2].result.rows[0].measures.margin.value).toBe(
      "135",
    );
    expect(
      (await dataCall("POST", `/${dashboardId}/data`, stranger, { values: {} }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await dataCall("POST", `/${dashboardId}/data`, viewer, {
          values: { unknown: null },
        })
      ).statusCode,
    ).toBe(400);
    const duplicate = await dataCall(
      "POST",
      `/${dashboardId}/duplicate`,
      editor,
      {},
    );
    expect(duplicate.statusCode, duplicate.body).toBe(200);
    expect(
      duplicate.json().dashboard.slides[0].widgets[0].binding.modelId,
    ).toBe(portfolioId);
  });
  it("intersects viewer choices with fixed scope and never lets all-values remove it", async () => {
    for (const values of [
      { country: null },
      { country: { kind: "values", values: ["DE", "FR"] } },
      { country: { kind: "values", values: ["FR"] } },
    ]) {
      const result = await dataCall("POST", "/data/preview", viewer, {
        filters: [
          { ...filter(), fixedValue: { kind: "values", values: ["DE"] } },
        ],
        values,
        widgets: [
          { ...widget("income"), id: "51bb53cb-3540-4b70-a287-151c5fa16803" },
        ].map(({ id, binding, options }) => ({ id, binding, options })),
      });
      expect(result.statusCode, result.body).toBe(200);
      expect(
        result.json().widgets[0].result.rows[0].measures.income.value,
      ).toBe(values.country?.values?.length === 1 ? null : "150");
    }
  });
  it("refuses incompatible saved bindings and contains an invalid preview widget", async () => {
    for (const change of [
      { settings: { dataFilters: [{ ...filter(), mappings: [] }] } },
      { settings: { dataFilters: [{ ...filter(), type: "integer" }] } },
      { settings: { dataFilters: [filter(), filter()] } },
      {
        settings: { dataFilters: [filter()] },
        slides: [
          {
            widgets: [
              {
                ...widget("income"),
                binding: {
                  ...widget("income").binding,
                  modelId: "7c271797-0183-4591-b219-e2c6d8357b28",
                },
              },
            ],
          },
        ],
      },
    ]) {
      const result = await dataCall("POST", "", editor, {
        name: "Invalid",
        ...{
          settings: { dataFilters: [filter()] },
          slides: [{ widgets: [widget("income")] }],
        },
        ...change,
      });
      expect(result.statusCode, result.body).toBe(400);
    }
    const widgets = [widget("unknown"), widget("income")].map(
      ({ binding, options }, index) => ({
        binding,
        options,
        id: index
          ? "51bb53cb-3540-4b70-a287-151c5fa16803"
          : "97118a1d-d1a4-4abb-b9c7-b20309178d0e",
      }),
    );
    const preview = await dataCall("POST", "/data/preview", viewer, {
      widgets,
      filters: [],
      values: {},
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().widgets[0]).toMatchObject({
      error: "model_measure_not_found",
      result: null,
    });
    expect(preview.json().widgets[1].result.rows[0].measures.income.value).toBe(
      "175",
    );
  });
  it("searches typed dimension values with paging and enforces workspace access", async () => {
    const path = `/models/${portfolioId}/dimensions/country/values`;
    const page = await dataCall("POST", path, viewer, { limit: 1, offset: 1 });
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json()).toEqual({ values: ["FR"], total: 2, offset: 1 });
    const search = await dataCall("POST", path, viewer, { search: "de" });
    expect(search.json()).toEqual({ values: ["DE"], total: 1, offset: 0 });
    expect((await dataCall("POST", path, stranger, {})).statusCode).toBe(404);
  });
  it("computes paired-screen results from the saved scope and refuses a foreign dashboard", async () => {
    const current = (await dataCall("GET", `/${dashboardId}`, editor)).json()
      .dashboard;
    const saved = await dataCall("PUT", `/${dashboardId}`, editor, {
      name: current.name,
      version: current.version,
      projectId: current.projectId,
      slides: current.slides,
      settings: {
        ...current.settings,
        dataFilters: [
          { ...filter(), defaultValue: { kind: "values", values: ["DE"] } },
        ],
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const payload = await withWorkspace(
      db,
      { workspaceId },
      (tx) =>
        buildDeviceDashboardV3(tx, workspaceId, dashboardId, {
          now: new Date(),
        }),
      { isolationLevel: "repeatable read" },
    );
    const widgets = payload.slides[0]!.widgets;
    expect(widgets.map((widget) => widget.type)).toEqual([
      "measure",
      "measure",
      "measure",
    ]);
    expect(
      widgets.map(
        (widget) =>
          widget.type === "measure" &&
          Object.values(widget.data.result!.rows[0]!.measures)[0]!.value,
      ),
    ).toEqual(["150", "30", "120"]);
    expect(widgets[0]!.type === "measure" && widgets[0]!.data.scope).toEqual([
      "Country: DE",
    ]);
    const foreign = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { cookie: stranger },
      payload: { name: "Foreign" },
    });
    const other = foreign.json().workspace.id as string;
    const denied = await withWorkspace(db, { workspaceId: other }, (tx) =>
      buildDeviceDashboardV3(tx, other, dashboardId, { now: new Date() }),
    );
    expect(denied.slides).toEqual([]);
  });
  it("allows a multi-currency model while refusing mixed totals and incomparable charts", async () => {
    const sourceId = await source(
      "multiple-currencies",
      [
        { id: "id", type: "string" },
        { id: "country", type: "string" },
        {
          id: "amount",
          type: "decimal",
          unit: "currency",
          currencyField: "currency",
        },
        { id: "currency", type: "string" },
      ],
      [
        { id: "a", country: "DE", amount: "10.25", currency: "EUR" },
        { id: "b", country: "US", amount: "20.5", currency: "USD" },
      ],
    );
    const created = await call("POST", "/models", editor, {
      name: "Multi-currency",
      definition: {
        version: 1,
        datasets: [sourceId],
        relationships: [],
        dimensions: [
          {
            id: "country",
            name: "Country",
            datasetId: sourceId,
            fieldId: "country",
          },
        ],
        measures: [
          {
            id: "amount",
            name: "Proceeds",
            kind: "aggregate",
            datasetId: sourceId,
            aggregate: {
              id: "amount",
              name: "Proceeds",
              op: "sum",
              fieldId: "amount",
            },
          },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().model.id as string;
    const published = await call("POST", `/models/${id}/publish`, editor, {
      version: 1,
    });
    expect(published.statusCode, published.body).toBe(200);
    const binding = {
      modelId: id,
      measureIds: ["amount"],
      groupBy: ["country"],
      exclusions: [],
    };
    const run = (view: string, groupBy = binding.groupBy) =>
      dataCall("POST", "/data/preview", viewer, {
        filters: [],
        values: {},
        widgets: [
          {
            id: "51bb53cb-3540-4b70-a287-151c5fa16803",
            binding: { ...binding, groupBy },
            options: { view, limit: 20 },
          },
        ],
      });
    const table = await run("table");
    expect(
      table
        .json()
        .widgets[0].result.rows.map(
          (row: { measures: { amount: { currency: string } } }) =>
            row.measures.amount.currency,
        ),
    ).toEqual(["EUR", "USD"]);
    expect((await run("bar")).json().widgets[0].error).toBe(
      "dashboard_measure_currency_incompatible",
    );
    expect((await run("value", [])).json().widgets[0].error).toBe(
      "aggregate_currency_mixed",
    );
  });
});
