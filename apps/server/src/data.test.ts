import { buildDeviceDashboardV3 } from "./devices/dashboard.js";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminSetDataPolicy,
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
let appConfig: ReturnType<typeof loadConfig>;
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
  appConfig = config;
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
  it("binds pinned pages to the authenticated caller and reauthorizes every continuation", async () => {
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
    await adminSetDataPolicy(db, workspaceId, {
      querySnapshotCount: 3,
      queryPageSessionsPerCaller: 1,
    });
    const firstResponse = await call("POST", `/models/${id}/query`, viewer, {
      ...input,
      pinPages: true,
    });
    expect(firstResponse.statusCode, firstResponse.body).toBe(200);
    const first = modelQueryResponseSchema.parse(firstResponse.json());
    expect(first.nextPageToken).toBeDefined();
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: {
        email: "data-viewer@example.com",
        password: "password-12345",
      },
    });
    expect(signIn.statusCode, signIn.body).toBe(200);
    const header = signIn.headers["set-cookie"];
    const secondLogin = (Array.isArray(header) ? header : [header])
      .find((cookie) => cookie?.startsWith("better-auth.session_token="))!
      .split(";")[0]!;
    const denied = await call("POST", `/models/${id}/query`, secondLogin, {
      ...input,
      pinPages: true,
    });
    expect(denied.statusCode, denied.body).toBe(200);
    const deniedResult = modelQueryResponseSchema.parse(denied.json());
    expect(deniedResult.nextPageToken).toBeUndefined();
    expect(deniedResult.warnings).toContain("immutable_pagination_unavailable");
    const otherCaller = await call("POST", `/models/${id}/query`, editor, {
      ...input,
      pinPages: true,
    });
    expect(otherCaller.statusCode, otherCaller.body).toBe(200);
    expect(
      modelQueryResponseSchema.parse(otherCaller.json()).nextPageToken,
    ).toBeDefined();
    await adminSetDataPolicy(db, workspaceId, {});
    const continuation = { ...input, pageToken: first.nextPageToken! };
    const crossCaller = await call(
      "POST",
      `/models/${id}/query`,
      editor,
      continuation,
    );
    expect(crossCaller.statusCode, crossCaller.body).toBe(409);
    expect(crossCaller.json()).toEqual({ error: "data_page_unavailable" });
    expect(
      (
        await call("POST", `/models/${id}/query`, editor, {
          ...continuation,
          callerId: "data-viewer@example.com",
        })
      ).statusCode,
    ).toBe(400);
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
      secondLogin,
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
    const identity = await app.inject({
      url: "/v1/me",
      headers: { cookie: secondLogin },
    });
    expect(identity.statusCode, identity.body).toBe(200);
    const removed = await app.inject({
      method: "DELETE",
      url: `/v1/workspaces/${workspaceId}/members/${identity.json().user.id}`,
      headers: { cookie: owner },
    });
    expect(removed.statusCode, removed.body).toBe(204);
    try {
      expect(
        (await call("POST", `/models/${id}/query`, secondLogin, continuation))
          .statusCode,
      ).toBe(404);
    } finally {
      expect(
        (
          await addMemberViaInvitation(
            app,
            db,
            owner,
            workspaceId,
            "data-viewer@example.com",
            "viewer",
          )
        ).statusCode,
      ).toBe(200);
    }
    expect(
      (await call("POST", `/models/${id}/query`, secondLogin, continuation))
        .statusCode,
    ).toBe(200);
  });
  it("lets an editor repair a restored model after a used source field changes type", async () => {
    const sourceDefinition = {
      ...manual.definition,
      key: "restored-schema-repair",
      fields: [
        ...manual.definition.fields,
        {
          id: "extra",
          name: "Extra",
          type: "string",
          nullable: false,
          classification: "internal",
        },
      ],
    };
    const source = await call("POST", "/manual", editor, {
      definition: sourceDefinition,
      records: [{ values: { id: "one", amount: "5", extra: "7" } }],
    });
    expect(source.statusCode, source.body).toBe(200);
    const sourceId = source.json().datasetId as string;
    const created = await call("POST", "/models", editor, {
      name: "Repair restored model",
      definition: {
        version: 1,
        datasets: [sourceId],
        relationships: [],
        dimensions: [
          { id: "extra", name: "Extra", datasetId: sourceId, fieldId: "extra" },
        ],
        measures: [
          {
            id: "total",
            name: "Total",
            kind: "aggregate",
            datasetId: sourceId,
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
    let model = modelResponseSchema.parse(created.json()).model;
    expect(
      (
        await call("POST", `/models/${model.id}/publish`, editor, {
          version: 1,
        })
      ).statusCode,
    ).toBe(200);
    const query = { measureIds: ["total"], groupBy: [] };
    const read = () => call("POST", `/models/${model.id}/query`, viewer, query);
    const original = modelQueryResponseSchema.parse((await read()).json());
    expect(original.rows[0]!.measures.total!.value).toBe("5");
    const restored = await call("POST", `/models/${model.id}/restore`, editor, {
      version: 1,
      publishedVersion: 1,
    });
    expect(restored.statusCode, restored.body).toBe(200);
    model = modelResponseSchema.parse(restored.json()).model;
    const changed = await call("PUT", `/manual/${sourceId}`, editor, {
      definition: {
        ...sourceDefinition,
        version: 2,
        fields: sourceDefinition.fields.map((field) =>
          field.id === "extra" ? { ...field, type: "integer" } : field,
        ),
      },
      generationId: source.json().generationId,
      records: [{ values: { id: "one", amount: "10", extra: 7 } }],
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const inputsPath = `/models/${model.id}/inputs?version=${model.version}`;
    const metadata = await call("GET", inputsPath, editor);
    expect(metadata.statusCode, metadata.body).toBe(200);
    expect(metadata.headers["cache-control"]).toBe("no-store");
    expect(
      metadata
        .json()
        .sources.find((item: { id: string }) => item.id === sourceId).fields,
    ).toContainEqual(expect.objectContaining({ id: "extra", type: "integer" }));
    expect((await call("GET", inputsPath, viewer)).statusCode).toBe(403);
    expect((await call("GET", inputsPath, stranger)).statusCode).toBe(404);
    const blocked = await call("POST", "/models/preview", editor, {
      definition: model.definition,
      query,
      draft: { id: model.id, version: model.version },
    });
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(blocked.json()).toEqual({ error: "data_model_schema_changed" });
    expect(
      (
        await call("POST", `/models/${model.id}/publish`, editor, {
          version: model.version,
        })
      ).statusCode,
    ).toBe(409);
    const fixed = await call("PUT", `/models/${model.id}`, editor, {
      name: model.name,
      version: model.version,
      definition: { ...model.definition, dimensions: [] },
    });
    expect(fixed.statusCode, fixed.body).toBe(200);
    model = modelResponseSchema.parse(fixed.json()).model;
    expect(model.restoredFromVersion).toBe(1);
    expect((await call("GET", inputsPath, editor)).statusCode).toBe(409);
    const preview = await call("POST", "/models/preview", editor, {
      definition: model.definition,
      query,
      draft: { id: model.id, version: model.version },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(
      modelQueryResponseSchema.parse(preview.json()).rows[0]!.measures.total!
        .value,
    ).toBe("10");
    const active = modelQueryResponseSchema.parse((await read()).json());
    expect(active).toMatchObject({
      releaseId: original.releaseId,
      stale: true,
      provenance: original.provenance,
    });
    expect(active.rows[0]!.measures.total!.value).toBe("5");
    const published = await call(
      "POST",
      `/models/${model.id}/publish`,
      editor,
      {
        version: model.version,
      },
    );
    expect(published.statusCode, published.body).toBe(200);
    expect(modelQueryResponseSchema.parse((await read()).json())).toMatchObject(
      {
        stale: false,
        rows: [{ measures: { total: { value: "10" } } }],
      },
    );
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
      const metadata = await call(
        "GET",
        `/${kind}/${resourceId}/inputs?version=1`,
        editor,
      );
      expect(metadata.statusCode, metadata.body).toBe(200);
      expect(metadata.headers["cache-control"]).toBe("no-store");
      expect(metadata.json().sources[0].fields.length).toBeGreaterThan(0);
      expect(
        (await call("GET", `/${kind}/${resourceId}/inputs?version=1`, viewer))
          .statusCode,
      ).toBe(403);
      expect(
        (await call("GET", `/${kind}/${resourceId}/inputs?version=1`, stranger))
          .statusCode,
      ).toBe(404);
      expect(
        (await call("GET", `/${kind}/${resourceId}/inputs?version=99`, editor))
          .statusCode,
      ).toBe(409);
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
  it("validates declared chart-to-filter interactions at save and evaluates clicks as viewer choices", async () => {
    const chart = (
      interaction: unknown,
      view = "bar",
      groupBy = ["country"],
      exclusions: unknown[] = [],
    ) => ({
      ...widget("income"),
      w: 6,
      binding: {
        ...widget("income").binding,
        groupBy,
        exclusions,
        interaction,
      },
      options: { view, limit: 20 },
    });
    const created = await dataCall("POST", "", editor, {
      name: "Clickable",
      settings: { dataFilters: [filter()] },
      slides: [
        {
          widgets: [
            chart({ filterId: "country" }),
            { ...widget("spend", 6), w: 6 },
          ],
        },
      ],
    });
    expect(created.statusCode, created.body).toBe(200);
    const clickable = created.json().dashboard;
    expect(clickable.slides[0].widgets[0].binding.interaction).toEqual({
      filterId: "country",
    });
    // A click sends an ordinary filter choice; every widget mapped to the
    // filter follows it, evaluated under the viewer's own authorization.
    const clicked = await dataCall("POST", `/${clickable.id}/data`, viewer, {
      values: { country: { kind: "values", values: ["FR"] } },
    });
    expect(clicked.statusCode, clicked.body).toBe(200);
    expect(
      clicked.json().widgets.map(
        (widget: {
          result: {
            rows: Array<{
              dimensions: Record<string, unknown>;
              measures: Record<string, { value: unknown }>;
            }>;
          };
        }) =>
          widget.result.rows.map((row) => [
            row.dimensions.country ?? null,
            Object.values(row.measures)[0]!.value,
          ]),
      ),
    ).toEqual([[["FR", "25"]], [[null, "10"]]]);
    expect(
      (
        await dataCall("POST", `/${clickable.id}/data`, stranger, {
          values: { country: { kind: "values", values: ["FR"] } },
        })
      ).statusCode,
    ).toBe(404);
    // Paired screens get no interaction: the binding never reaches devices.
    const payload = await withWorkspace(
      db,
      { workspaceId },
      (tx) =>
        buildDeviceDashboardV3(tx, workspaceId, clickable.id, {
          now: new Date(),
        }),
      { isolationLevel: "repeatable read" },
    );
    expect(payload.slides[0]!.widgets).toHaveLength(2);
    expect(JSON.stringify(payload)).not.toContain("interaction");
    for (const [invalid, error] of [
      [
        chart({ filterId: "country" }, "value", []),
        "dashboard_interaction_view_unsupported",
      ],
      [chart({ filterId: "missing" }), "dashboard_interaction_filter_unknown"],
      [
        chart(
          { filterId: "country" },
          "bar",
          ["country"],
          [{ filterId: "country", reason: "All markets" }],
        ),
        "dashboard_interaction_filter_excluded",
      ],
      [
        chart({ filterId: "country" }, "table", []),
        "dashboard_interaction_dimension_not_grouped",
      ],
    ] as const) {
      const result = await dataCall("POST", "", editor, {
        name: "Invalid interaction",
        settings: { dataFilters: [filter()] },
        slides: [{ widgets: [invalid] }],
      });
      expect(result.statusCode, result.body).toBe(400);
      expect(result.json()).toEqual({ error });
    }
    // Removing the declared filter re-validates the unchanged widget.
    const removed = await dataCall("PUT", `/${clickable.id}`, editor, {
      name: clickable.name,
      version: clickable.version,
      projectId: clickable.projectId,
      slides: clickable.slides.map(
        (slide: {
          widgets: Array<{ binding?: { exclusions: unknown[] } }>;
        }) => ({
          ...slide,
          widgets: slide.widgets.slice(0, 1),
        }),
      ),
      settings: { ...clickable.settings, dataFilters: [] },
    });
    expect(removed.statusCode, removed.body).toBe(400);
    expect(removed.json()).toEqual({
      error: "dashboard_interaction_filter_unknown",
    });
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
  it("shows the most recent points of time-ordered charts on dashboards and devices", async () => {
    const days = Array.from(
      { length: 30 },
      (_, index) => `2026-01-${String(index + 1).padStart(2, "0")}`,
    );
    const sourceId = await source(
      "daily-units",
      [
        { id: "id", type: "string" },
        { id: "day", type: "date" },
        { id: "units", type: "integer" },
      ],
      days.map((day, index) => ({ id: day, day, units: index + 1 })),
    );
    const created = await call("POST", "/models", editor, {
      name: "Daily units",
      definition: {
        version: 1,
        datasets: [sourceId],
        relationships: [],
        dimensions: [
          {
            id: "day",
            name: "Day",
            datasetId: sourceId,
            fieldId: "day",
            timeAlignment: "reporting_date",
          },
        ],
        measures: [
          {
            id: "units",
            name: "Units",
            kind: "aggregate",
            datasetId: sourceId,
            aggregate: {
              id: "units",
              name: "Units",
              op: "sum",
              fieldId: "units",
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
    const measure = (view: string, x: number) => ({
      type: "measure",
      x,
      y: 0,
      w: 4,
      h: 3,
      binding: {
        modelId: id,
        measureIds: ["units"],
        groupBy: ["day"],
        exclusions: [],
      },
      options: { view, limit: 5 },
    });
    const dashboard = await dataCall("POST", "", editor, {
      name: "Daily",
      slides: [
        {
          widgets: [measure("line", 0), measure("bar", 4), measure("table", 8)],
        },
      ],
    });
    expect(dashboard.statusCode, dashboard.body).toBe(200);
    const daily = dashboard.json().dashboard.id as string;
    type Result = {
      totalRows: number;
      offset: number;
      rows: Array<{ dimensions: Record<string, unknown> }>;
    };
    const shown = (result: Result) => ({
      days: result.rows.map((row) => row.dimensions.day),
      totalRows: result.totalRows,
      offset: result.offset,
    });
    const latest = { days: days.slice(25), totalRows: 30, offset: 25 };
    const first = { days: days.slice(0, 5), totalRows: 30, offset: 0 };
    const query = await dataCall("POST", `/${daily}/data`, viewer, {
      values: {},
    });
    expect(query.statusCode, query.body).toBe(200);
    expect(
      query
        .json()
        .widgets.map((widget: { result: Result }) => shown(widget.result)),
    ).toEqual([latest, latest, first]);
    const payload = await withWorkspace(
      db,
      { workspaceId },
      (tx) =>
        buildDeviceDashboardV3(tx, workspaceId, daily, { now: new Date() }),
      { isolationLevel: "repeatable read" },
    );
    expect(
      payload.slides[0]!.widgets.map(
        (widget) =>
          widget.type === "measure" && shown(widget.data.result as Result),
      ),
    ).toEqual([latest, latest, first]);
  });
  it("serves concurrent reads of the same dashboard without spurious outages", async () => {
    const created = await dataCall("POST", "", editor, {
      name: "Concurrent",
      settings: { dataFilters: [filter()] },
      slides: [
        {
          widgets: [widget("income"), widget("spend", 4), widget("margin", 8)],
        },
      ],
    });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().dashboard.id as string;
    for (let round = 0; round < 3; round++) {
      const responses = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          index % 2
            ? dataCall("POST", `/${id}/data`, viewer, { values: {} })
            : dataCall("POST", "/data/preview", viewer, {
                filters: [filter()],
                values: {},
                widgets: [
                  {
                    ...widget("income"),
                    id: "51bb53cb-3540-4b70-a287-151c5fa16803",
                  },
                ].map(({ id, binding, options }) => ({ id, binding, options })),
              }),
        ),
      );
      for (const response of responses) {
        expect(response.statusCode, response.body).toBe(200);
        expect(
          response
            .json()
            .widgets.map((widget: { status: string }) => widget.status),
          response.body,
        ).not.toContain("outage");
      }
    }
  });
  it("evaluates unsaved previews at the application clock", async () => {
    const at = new Date("2031-02-03T04:05:06Z");
    const clocked = await buildApp(appConfig, {
      db,
      authService: createAuthService(appConfig, db, {
        logger: pino({ level: "silent" }),
      }),
      checkDb: async () => true,
      now: () => at,
    });
    try {
      const preview = await clocked.inject({
        method: "POST",
        url: `/v1/workspaces/${workspaceId}/dashboards/data/preview`,
        headers: { cookie: viewer },
        payload: {
          filters: [],
          values: {},
          widgets: [
            {
              id: "51bb53cb-3540-4b70-a287-151c5fa16803",
              binding: { ...widget("spend").binding, groupBy: ["country"] },
              options: { view: "table", limit: 20 },
            },
          ],
        },
      });
      expect(preview.statusCode, preview.body).toBe(200);
      const snapshots = await withWorkspace(db, { workspaceId }, (tx) =>
        tx
          .select({ updatedAt: schema.dataModelQuerySnapshots.updatedAt })
          .from(schema.dataModelQuerySnapshots),
      );
      expect(
        snapshots.some((row) => row.updatedAt.getTime() === at.getTime()),
      ).toBe(true);
    } finally {
      await clocked.close();
    }
  });
  it("saves unrelated edits while an unchanged binding has gone stale, and validates a changed one", async () => {
    const sourceId = await source(
      "stale-binding",
      [
        { id: "id", type: "string" },
        { id: "country", type: "string" },
        { id: "units", type: "integer" },
      ],
      [{ id: "a", country: "DE", units: 1 }],
    );
    const definition = (dimensionId: string) => ({
      version: 1,
      datasets: [sourceId],
      relationships: [],
      dimensions: [
        {
          id: dimensionId,
          name: "Country",
          datasetId: sourceId,
          fieldId: "country",
        },
      ],
      measures: [
        {
          id: "units",
          name: "Units",
          kind: "aggregate",
          datasetId: sourceId,
          aggregate: {
            id: "units",
            name: "Units",
            op: "sum",
            fieldId: "units",
          },
        },
      ],
    });
    const created = await call("POST", "/models", editor, {
      name: "Stale binding",
      definition: definition("country"),
    });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().model.id as string;
    const publish = async (version: number) => {
      const published = await call("POST", `/models/${id}/publish`, editor, {
        version,
      });
      expect(published.statusCode, published.body).toBe(200);
    };
    await publish(created.json().model.version as number);
    const dashboard = await dataCall("POST", "", editor, {
      name: "Stale",
      settings: {
        dataFilters: [
          {
            id: "market",
            name: "Market",
            type: "string",
            mode: "values",
            mappings: [{ modelId: id, dimensionId: "country" }],
            defaultValue: null,
          },
        ],
      },
      slides: [
        {
          widgets: [
            {
              type: "measure",
              x: 0,
              y: 0,
              w: 4,
              h: 3,
              binding: {
                modelId: id,
                measureIds: ["units"],
                groupBy: ["country"],
                exclusions: [],
              },
              options: { view: "table", limit: 20 },
            },
          ],
        },
      ],
    });
    expect(dashboard.statusCode, dashboard.body).toBe(200);
    const stale = dashboard.json().dashboard.id as string;
    const saved = await call("PUT", `/models/${id}`, editor, {
      name: "Stale binding",
      definition: definition("market"),
      version: created.json().model.version,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    await publish(saved.json().model.version as number);
    const current = (await dataCall("GET", `/${stale}`, editor)).json()
      .dashboard;
    const save = (widgets: unknown[], version: number) =>
      dataCall("PUT", `/${stale}`, editor, {
        name: "Stale, renamed",
        version,
        projectId: current.projectId,
        slides: [{ ...current.slides[0], widgets }],
        settings: current.settings,
      });
    const moved = await save(
      [{ ...current.slides[0].widgets[0], x: 4 }],
      current.version,
    );
    expect(moved.statusCode, moved.body).toBe(200);
    const query = await dataCall("POST", `/${stale}/data`, viewer, {
      values: {},
    });
    expect(query.json().widgets[0].status).toBe("outage");
    const changed = await save(
      [
        {
          ...current.slides[0].widgets[0],
          options: { view: "table", limit: 10 },
        },
      ],
      moved.json().dashboard.version,
    );
    expect(changed.statusCode, changed.body).toBe(400);
  });
});

describe("rolling and period-offset model measures", () => {
  const dashboards = (
    method: "POST" | "PUT",
    path: string,
    cookie: string,
    payload: unknown,
  ) =>
    app.inject({
      method,
      url: `/v1/workspaces/${workspaceId}/dashboards${path}`,
      headers: { cookie },
      payload: payload as InjectOptions["payload"],
    });
  // 2026-09-25 … 2026-10-05, one unit per day.
  const days = Array.from({ length: 11 }, (_, index) =>
    new Date(Date.UTC(2026, 8, 25 + index)).toISOString().slice(0, 10),
  );
  let sourceId: string;
  const rolling = {
    id: "units_7d",
    name: "Units, 7 days",
    kind: "rolling",
    baseMeasureId: "units",
    timeDimensionId: "day",
    window: { unit: "day", length: 7 },
  };
  const weekChange = {
    id: "units_week_change",
    name: "Units vs. previous week",
    kind: "period_offset",
    baseMeasureId: "units",
    timeDimensionId: "day",
    offset: { unit: "week", length: 1 },
    output: "change",
  };
  const definition = (measures: unknown[]) => ({
    version: 1,
    datasets: [sourceId],
    relationships: [],
    dimensions: [
      {
        id: "day",
        name: "Day",
        datasetId: sourceId,
        fieldId: "day",
        timeAlignment: "reporting_date",
      },
      {
        id: "at",
        name: "Received",
        datasetId: sourceId,
        fieldId: "at",
        timeAlignment: "instant",
      },
    ],
    measures: [
      {
        id: "units",
        name: "Units",
        kind: "aggregate",
        datasetId: sourceId,
        aggregate: { id: "units", name: "Units", op: "sum", fieldId: "units" },
      },
      ...measures,
    ],
  });
  const create = async (name: string, measures: unknown[]) => {
    const created = await call("POST", "/models", editor, {
      name,
      definition: definition(measures),
    });
    expect(created.statusCode, created.body).toBe(200);
    return modelResponseSchema.parse(created.json()).model;
  };
  const publish = (model: { id: string; version: number }) =>
    call("POST", `/models/${model.id}/publish`, editor, {
      version: model.version,
    });

  it("refuses invalid windowed measures when saving or publishing", async () => {
    const source = await call("POST", "/manual", editor, {
      definition: {
        key: "daily-windowed-units",
        name: "Daily units",
        version: 1,
        mode: "snapshot",
        grain: "one reporting day",
        keyFields: ["id"],
        retentionDays: null,
        fields: [
          { id: "id", type: "string" },
          { id: "day", type: "date" },
          { id: "at", type: "timestamp" },
          { id: "units", type: "integer" },
        ].map((field) => ({
          ...field,
          name: field.id,
          nullable: false,
          classification: "internal",
        })),
      },
      records: days.map((day) => ({
        values: { id: day, day, at: `${day}T12:00:00Z`, units: 1 },
      })),
    });
    expect(source.statusCode, source.body).toBe(200);
    sourceId = source.json().datasetId as string;

    // Bounds are part of the contract.
    for (const window of [
      { unit: "day", length: 367 },
      { unit: "month", length: 0 },
      { unit: "year", length: 1 },
    ]) {
      const refused = await call("POST", "/models", editor, {
        name: "Out of bounds",
        definition: definition([{ ...rolling, window }]),
      });
      expect(refused.statusCode, refused.body).toBe(400);
    }

    // Semantic rules surface as stable codes when publishing.
    for (const [measures, code] of [
      [
        [
          {
            id: "double",
            name: "Double",
            kind: "formula",
            expression: {
              kind: "call",
              fn: "multiply",
              args: [
                { kind: "field", fieldId: "units" },
                { kind: "literal", type: "integer", value: 2 },
              ],
            },
          },
          { ...rolling, baseMeasureId: "double" },
        ],
        "model_window_base_aggregate_required",
      ],
      [
        [{ ...rolling, timeDimensionId: "at" }],
        "model_window_date_dimension_required",
      ],
      [
        [
          { ...rolling, window: { unit: "day", length: 366 } },
          {
            ...weekChange,
            id: "year_ago",
            baseMeasureId: "units_7d",
            offset: { unit: "day", length: 366 },
            output: "value",
          },
          {
            ...weekChange,
            id: "too_far",
            baseMeasureId: "year_ago",
            offset: { unit: "day", length: 100 },
          },
        ],
        "model_window_lookback_limit",
      ],
      [
        [{ ...weekChange, id: "loop", baseMeasureId: "loop" }],
        "model_measure_cycle",
      ],
    ] as const) {
      const model = await create("Invalid windows", [...measures]);
      const refused = await publish(model);
      expect(refused.statusCode, refused.body).toBe(400);
      expect(refused.json()).toEqual({ error: code });
    }
  });

  it("serves rolling and offset measures to viewers and refuses an ungrouped rolling binding", async () => {
    const model = await create("Windowed units", [rolling, weekChange]);
    const published = await publish(model);
    expect(published.statusCode, published.body).toBe(200);

    const range = (from: string, to: string) => ({
      kind: "call",
      fn: "and",
      args: [
        {
          kind: "call",
          fn: "gte",
          args: [
            { kind: "field", fieldId: "day" },
            { kind: "literal", type: "date", value: from },
          ],
        },
        {
          kind: "call",
          fn: "lte",
          args: [
            { kind: "field", fieldId: "day" },
            { kind: "literal", type: "date", value: to },
          ],
        },
      ],
    });
    const direct = await call("POST", `/models/${model.id}/query`, viewer, {
      measureIds: ["units_7d", "units_week_change"],
      groupBy: ["day"],
      filter: range("2026-10-02", "2026-10-05"),
    });
    expect(direct.statusCode, direct.body).toBe(200);
    const result = modelQueryResponseSchema.parse(direct.json());
    expect(result.totalRows).toBe(4);
    expect(result.rows.map((row) => row.dimensions.day)).toEqual(days.slice(7));
    expect(result.rows.at(-1)!.measures).toMatchObject({
      units_7d: { value: "7", status: "ok" },
      units_week_change: {
        value: "0",
        status: "ok",
        comparedTo: { from: "2026-09-28", to: "2026-09-28" },
      },
    });

    const filter = {
      id: "day",
      name: "Day",
      type: "date",
      mode: "range",
      mappings: [{ modelId: model.id, dimensionId: "day" }],
      defaultValue: null,
    };
    const widget = (view: string, groupBy: string[]) => ({
      type: "measure",
      x: 0,
      y: 0,
      w: 6,
      h: 3,
      binding: {
        modelId: model.id,
        measureIds: ["units_7d"],
        groupBy,
        exclusions: [],
      },
      options: { view, limit: 20 },
    });
    const dashboard = await dashboards("POST", "", editor, {
      name: "Rolling units",
      settings: { dataFilters: [filter] },
      slides: [{ widgets: [widget("line", ["day"])] }],
    });
    expect(dashboard.statusCode, dashboard.body).toBe(200);
    const read = await dashboards(
      "POST",
      `/${dashboard.json().dashboard.id as string}/data`,
      viewer,
      {
        values: {
          day: { kind: "range", from: "2026-10-01", to: "2026-10-05" },
        },
      },
    );
    expect(read.statusCode, read.body).toBe(200);
    const [line] = read.json().widgets;
    expect(line.error).toBeNull();
    // Lookback rows from September fill each window but add no points.
    expect(line.result.totalRows).toBe(5);
    expect(
      line.result.rows.map(
        (row: {
          dimensions: { day: string };
          measures: { units_7d: { value: unknown } };
        }) => [row.dimensions.day, row.measures.units_7d.value],
      ),
    ).toEqual(days.slice(6).map((day) => [day, "7"]));

    const ungrouped = await dashboards("POST", "", editor, {
      name: "Ungrouped rolling",
      settings: { dataFilters: [filter] },
      slides: [{ widgets: [widget("value", [])] }],
    });
    expect(ungrouped.statusCode, ungrouped.body).toBe(400);
    expect(ungrouped.json()).toEqual({
      error: "model_window_time_grouping_required",
    });
  });

  it("keeps dashboard date filters on windowed bindings to supported ranges", async () => {
    const previousPeriod = {
      id: "units_previous_period",
      name: "Units, previous period",
      kind: "period_offset",
      baseMeasureId: "units",
      timeDimensionId: "day",
      offset: { unit: "range", length: 1 },
      output: "value",
    };
    const model = await create("Windowed filters", [
      rolling,
      previousPeriod,
      { ...previousPeriod, id: "units_pct", output: "percent_change" },
    ]);
    expect((await publish(model)).statusCode).toBe(200);
    const filter = (mode: "values" | "range", defaultValue: unknown) => ({
      id: "day",
      name: "Day",
      type: "date",
      mode,
      mappings: [{ modelId: model.id, dimensionId: "day" }],
      defaultValue,
    });
    const widget = (measureId: string, view: string, groupBy: string[]) => ({
      type: "measure",
      x: 0,
      y: 0,
      w: 6,
      h: 3,
      binding: {
        modelId: model.id,
        measureIds: [measureId],
        groupBy,
        exclusions: [],
      },
      options: { view, limit: 20 },
    });

    // A list of dates can become several dates or "no date", which no
    // window can read: refused when saving, not at every viewer's query.
    const listed = await dashboards("POST", "", editor, {
      name: "Listed days",
      settings: { dataFilters: [filter("values", null)] },
      slides: [{ widgets: [widget("units_7d", "line", ["day"])] }],
    });
    expect(listed.statusCode, listed.body).toBe(400);
    expect(listed.json()).toEqual({
      error: "dashboard_filter_window_unsupported",
    });
    // Excluding the widget from that filter is fine.
    const excluded = await dashboards("POST", "", editor, {
      name: "Listed days, excluded",
      settings: { dataFilters: [filter("values", null)] },
      slides: [
        {
          widgets: [
            {
              ...widget("units_7d", "line", ["day"]),
              binding: {
                ...widget("units_7d", "line", ["day"]).binding,
                exclusions: [{ filterId: "day", reason: "Rolling" }],
              },
            },
          ],
        },
      ],
    });
    expect(excluded.statusCode, excluded.body).toBe(200);

    // Saved without a default range (or without any date filter), the
    // comparison has no period: the editor is asked for one.
    for (const dataFilters of [[filter("range", null)], []]) {
      const open = await dashboards("POST", "", editor, {
        name: "Previous period, no range",
        settings: { dataFilters },
        slides: [{ widgets: [widget("units_previous_period", "value", [])] }],
      });
      expect(open.statusCode, open.body).toBe(400);
      expect(open.json()).toEqual({
        error: "dashboard_measure_window_range_required",
      });
    }

    // A cleared range leaves a comparison without its period: the widget
    // explains that instead of reporting an outage.
    const ranged = await dashboards("POST", "", editor, {
      name: "Previous period",
      settings: {
        dataFilters: [
          filter("range", {
            kind: "range",
            from: "2026-10-04",
            to: "2026-10-05",
          }),
        ],
      },
      slides: [{ widgets: [widget("units_previous_period", "value", [])] }],
    });
    expect(ranged.statusCode, ranged.body).toBe(200);
    const read = (values: unknown) =>
      dashboards(
        "POST",
        `/${ranged.json().dashboard.id as string}/data`,
        viewer,
        { values },
      );
    const chosen = await read({});
    expect(chosen.statusCode, chosen.body).toBe(200);
    expect(chosen.json().widgets[0]).toMatchObject({
      status: "ok",
      error: null,
    });
    // Clients learn which measures are change ratios to show percentages.
    expect(chosen.json().widgets[0].metadata.measures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "units_pct", percentChange: true }),
        expect.not.objectContaining({ percentChange: true }),
      ]),
    );
    expect(
      chosen
        .json()
        .widgets[0].metadata.measures.filter(
          (measure: { percentChange?: true }) => measure.percentChange,
        ),
    ).toHaveLength(1);
    expect(chosen.json().widgets[0].result.rows[0].measures).toMatchObject({
      units_previous_period: {
        value: "2",
        comparedTo: { from: "2026-10-02", to: "2026-10-03" },
      },
    });
    for (const value of [
      { kind: "range", from: null, to: null },
      { kind: "range", from: "2026-10-01", to: null },
    ]) {
      const cleared = await read({ day: value });
      expect(cleared.statusCode, cleared.body).toBe(200);
      expect(cleared.json().widgets[0]).toMatchObject({
        status: "no_data",
        error: "model_window_time_range_required",
        result: null,
      });
    }
  });

  it("type-checks dashboard charts with the units windowed measures return", async () => {
    const source = await call("POST", "/manual", editor, {
      definition: {
        key: "daily-windowed-weights",
        name: "Daily weights",
        version: 1,
        mode: "snapshot",
        grain: "one reporting day",
        keyFields: ["id"],
        retentionDays: null,
        fields: [
          { id: "id", type: "string" },
          { id: "day", type: "date" },
          { id: "kg", type: "integer", unit: "kg" },
        ].map((field) => ({
          ...field,
          name: field.id,
          nullable: false,
          classification: "internal",
        })),
      },
      records: days.map((day, index) => ({
        values: { id: day, day, kg: index + 1 },
      })),
    });
    expect(source.statusCode, source.body).toBe(200);
    const weights = source.json().datasetId as string;
    const field = (fieldId: string) => ({ kind: "field", fieldId });
    const created = await call("POST", "/models", editor, {
      name: "Weight change",
      definition: {
        version: 1,
        datasets: [weights],
        relationships: [],
        dimensions: [
          {
            id: "day",
            name: "Day",
            datasetId: weights,
            fieldId: "day",
            timeAlignment: "reporting_date",
          },
        ],
        measures: [
          {
            id: "kg",
            name: "Weight",
            kind: "aggregate",
            datasetId: weights,
            aggregate: { id: "kg", name: "Weight", op: "sum", fieldId: "kg" },
          },
          {
            id: "kg_daily",
            name: "Weight per day",
            kind: "aggregate",
            datasetId: weights,
            requiredDimensions: ["day"],
            aggregate: { id: "kg", name: "Weight", op: "sum", fieldId: "kg" },
          },
          {
            ...weekChange,
            id: "kg_pct",
            baseMeasureId: "kg",
            output: "percent_change",
          },
          // Last week's change, and the week before: still ratios.
          {
            ...weekChange,
            id: "kg_pct_prior",
            baseMeasureId: "kg_pct",
            output: "value",
          },
          {
            ...weekChange,
            id: "kg_pct_prior_2",
            baseMeasureId: "kg_pct_prior",
            output: "value",
          },
          {
            id: "share",
            name: "Share",
            kind: "formula",
            expression: {
              kind: "call",
              fn: "divide",
              args: [field("kg"), field("kg")],
            },
          },
          // A unitless ratio plus another: kilograms only in the base.
          {
            id: "pct_and_share",
            name: "Change and share",
            kind: "formula",
            expression: {
              kind: "call",
              fn: "add",
              args: [field("kg_pct"), field("share")],
            },
          },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const model = modelResponseSchema.parse(created.json()).model;
    const published = await publish(model);
    expect(published.statusCode, published.body).toBe(200);
    const dashboard = await dashboards("POST", "", editor, {
      name: "Weight change",
      settings: { dataFilters: [] },
      slides: [
        {
          widgets: [
            {
              type: "measure",
              x: 0,
              y: 0,
              w: 6,
              h: 3,
              binding: {
                modelId: model.id,
                measureIds: ["pct_and_share"],
                groupBy: ["day"],
                exclusions: [],
              },
              options: { view: "line", limit: 20 },
            },
          ],
        },
      ],
    });
    expect(dashboard.statusCode, dashboard.body).toBe(200);
    const read = await dashboards(
      "POST",
      `/${dashboard.json().dashboard.id as string}/data`,
      viewer,
      { values: {} },
    );
    expect(read.statusCode, read.body).toBe(200);
    const [line] = read.json().widgets;
    expect(line.error).toBeNull();
    // 2026-10-05 (11 kg) against 2026-09-28 (4 kg): +175%, plus a share of 1.
    expect(line.result.rows.at(-1).measures.pct_and_share).toMatchObject({
      value: "2.75",
      status: "ok",
    });
    expect(
      line.metadata.measures
        .filter((measure: { percentChange?: true }) => measure.percentChange)
        .map((measure: { id: string }) => measure.id),
    ).toEqual(["kg_pct", "kg_pct_prior", "kg_pct_prior_2"]);
    // Only windows need the date grouped; a date grain can be filtered.
    expect(line.metadata.measures).toEqual(
      expect.arrayContaining([
        { id: "kg_daily", name: "Weight per day", requiredDimensions: ["day"] },
        expect.objectContaining({
          id: "pct_and_share",
          requiredDimensions: ["day"],
          perDateDimensions: ["day"],
        }),
      ]),
    );
  });
});
