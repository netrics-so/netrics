import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  schema,
  withWorkspace,
  type Database,
} from "@netrics/database";
import {
  dataInUseResponseSchema,
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

// Deleting preparations and models (#671): refused while something uses
// the item, naming it; otherwise gone with every version and draft. Scoped
// to the caller's workspace and to owners and admins.

let app: FastifyInstance, db: Database, admin: postgres.Sql;
let owner: string, otherOwner: string, editor: string;
let workspaceId: string, otherWorkspaceId: string;

const call = (
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  cookie: string,
  payload?: unknown,
  workspace = workspaceId,
) =>
  app.inject({
    method,
    url: `/v1/workspaces/${workspace}${path}`,
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

async function createWorkspace(cookie: string, name: string) {
  const created = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { cookie },
    payload: { name },
  });
  return workspaceResponseSchema.parse(created.json()).workspace.id;
}

async function source(cookie: string, workspace = workspaceId) {
  const saved = await call(
    "POST",
    "/data/manual",
    cookie,
    {
      definition: {
        key: "numbers-" + randomUUID().slice(0, 8),
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
    workspace,
  );
  expect(saved.statusCode, saved.body).toBe(200);
  return saved.json().datasetId as string;
}

async function preparation(
  cookie: string,
  name: string,
  datasetId: string,
  workspace = workspaceId,
) {
  const saved = await call(
    "POST",
    "/data/preparations",
    cookie,
    {
      name,
      graph: {
        version: 1,
        nodes: [
          { id: "source", type: "source", datasetId },
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
    workspace,
  );
  expect(saved.statusCode, saved.body).toBe(200);
  const id = preparationResponseSchema.parse(saved.json()).preparation.id;
  const published = await call(
    "POST",
    `/data/preparations/${id}/publish`,
    cookie,
    { version: 1 },
    workspace,
  );
  expect(published.statusCode, published.body).toBe(200);
  return id;
}

async function model(cookie: string, name: string, datasetId: string) {
  const saved = await call("POST", "/data/models", cookie, {
    name,
    definition: {
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
          aggregate: {
            id: "spend",
            name: "Spend",
            op: "sum",
            fieldId: "amount",
          },
        },
      ],
    },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const id = modelResponseSchema.parse(saved.json()).model.id;
  const published = await call("POST", `/data/models/${id}/publish`, cookie, {
    version: 1,
  });
  expect(published.statusCode, published.body).toBe(200);
  return id;
}

async function dashboard(cookie: string, name: string, modelId: string) {
  const saved = await call("POST", "/dashboards", cookie, {
    name,
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
              modelId,
              measureIds: ["spend"],
              groupBy: [],
              exclusions: [],
            },
            options: { view: "value", limit: 20 },
          },
        ],
      },
    ],
  });
  expect(saved.statusCode, saved.body).toBe(200);
  return (saved.json() as { dashboard: { id: string } }).dashboard.id;
}

const inUse = (response: { statusCode: number; json: () => unknown }) => {
  expect(response.statusCode).toBe(409);
  return dataInUseResponseSchema.parse(response.json()).usedBy;
};

const count = async (table: string, column: string, id: string) =>
  Number(
    (
      await admin.unsafe(
        `select count(*)::int as n from ${table} where ${column} = $1`,
        [id],
      )
    )[0]!.n,
  );

beforeAll(async () => {
  const test = await createTestDatabase();
  const config = loadConfig({
    DATABASE_URL: test.appUrl,
    LOG_LEVEL: "silent",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
  });
  db = createDatabase(test.appUrl);
  admin = postgres(test.adminUrl, { max: 1, onnotice: () => undefined });
  app = await buildApp(config, {
    db,
    authService: createAuthService(config, db, {
      logger: pino({ level: "silent" }),
    }),
    checkDb: async () => true,
  });
  owner = await signup("delete-owner@example.com");
  otherOwner = await signup("delete-other@example.com");
  editor = await signup("delete-editor@example.com");
  workspaceId = await createWorkspace(owner, "Delete W1");
  otherWorkspaceId = await createWorkspace(otherOwner, "Delete W2");
  expect(
    (
      await addMemberViaInvitation(
        app,
        db,
        owner,
        workspaceId,
        "delete-editor@example.com",
        "editor",
      )
    ).statusCode,
  ).toBe(200);
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await db?.$client.end({ timeout: 5 });
  await admin?.end({ timeout: 5 });
});

describe("deleting preparations and models", () => {
  it("deletes an unused preparation with its versions, drafts and prepared cache", async () => {
    const prep = await preparation(owner, "Unused", await source(owner));
    // A draft after the published version, and a prepared-output entry.
    const draft = await call("PUT", `/data/preparations/${prep}`, owner, {
      name: "Unused (edited)",
      version: 1,
      graph: (await call("GET", `/data/preparations/${prep}`, owner)).json()
        .preparation.graph,
    });
    expect(draft.statusCode, draft.body).toBe(200);
    expect(
      (
        await call("POST", "/data/preview", owner, {
          sourceId: `prepared:${prep}:kept`,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      await count("data_preparation_versions", "preparation_id", prep),
    ).toBeGreaterThan(0);
    expect(
      await count("data_prepared_generations", "preparation_id", prep),
    ).toBeGreaterThan(0);

    const deleted = await call("DELETE", `/data/preparations/${prep}`, owner);
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect(
      (await call("GET", `/data/preparations/${prep}`, owner)).statusCode,
    ).toBe(404);
    expect(await count("data_preparations", "id", prep)).toBe(0);
    expect(
      await count("data_preparation_versions", "preparation_id", prep),
    ).toBe(0);
    expect(
      await count("data_prepared_generations", "preparation_id", prep),
    ).toBe(0);
    const [audit] = await admin`
      select action, metadata from audit_events
      where target = ${prep} and action = 'data.preparation_deleted'`;
    expect(audit?.metadata).toMatchObject({ name: "Unused (edited)" });
    // Gone: a second delete answers 404.
    expect(
      (await call("DELETE", `/data/preparations/${prep}`, owner)).statusCode,
    ).toBe(404);
  });

  it("refuses while a model, a preparation or a dashboard uses the item, and names them", async () => {
    const raw = await source(owner);
    const base = await preparation(owner, "Base", raw);
    const downstream = await preparation(
      owner,
      "Downstream",
      `prepared:${base}:kept`,
    );
    const m = await model(owner, "Revenue", `prepared:${base}:kept`);
    const board = await dashboard(owner, "Sales board", m);

    const prepUsers = inUse(
      await call("DELETE", `/data/preparations/${base}`, owner),
    );
    expect(prepUsers.preparations).toEqual([
      { id: downstream, name: "Downstream" },
    ]);
    expect(prepUsers.models).toEqual([{ id: m, name: "Revenue" }]);
    // Direct users only: the dashboard reads the model, not the preparation.
    expect(prepUsers.dashboards).toEqual([]);

    const modelUsers = inUse(await call("DELETE", `/data/models/${m}`, owner));
    expect(modelUsers.dashboards).toEqual([{ id: board, name: "Sales board" }]);
    expect(await count("data_models", "id", m)).toBe(1);

    // Remove the users one by one; then everything goes.
    expect(
      (await call("DELETE", `/dashboards/${board}`, owner)).statusCode,
    ).toBe(204);
    expect((await call("DELETE", `/data/models/${m}`, owner)).statusCode).toBe(
      204,
    );
    expect(await count("data_model_releases", "model_id", m)).toBe(0);
    const left = inUse(
      await call("DELETE", `/data/preparations/${base}`, owner),
    );
    expect(left.models).toEqual([]);
    expect(left.preparations.map((p) => p.name)).toEqual(["Downstream"]);
    expect(
      (await call("DELETE", `/data/preparations/${downstream}`, owner))
        .statusCode,
    ).toBe(204);
    expect(
      (await call("DELETE", `/data/preparations/${base}`, owner)).statusCode,
    ).toBe(204);
  });

  it("refuses while a model is mapped in a dashboard's shared filter", async () => {
    const m = await model(owner, "Filtered", await source(owner));
    const saved = await call("POST", "/dashboards", owner, {
      name: "Filter board",
      settings: {
        dataFilters: [
          {
            id: "label",
            name: "Label",
            type: "string",
            mode: "values",
            defaultValue: null,
            mappings: [{ modelId: m, dimensionId: "label" }],
          },
        ],
      },
      slides: [{ widgets: [] }],
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(
      inUse(await call("DELETE", `/data/models/${m}`, owner)).dashboards,
    ).toEqual([{ id: saved.json().dashboard.id, name: "Filter board" }]);
  });

  it("refuses while a store-template install with a dashboard owns the item", async () => {
    const m = await model(owner, "Template model", await source(owner));
    const board = await dashboard(owner, "Store portfolio", m);
    const requestId = randomUUID();
    await withWorkspace(db, { workspaceId }, async (tx) => {
      await tx.insert(schema.dataTemplateInstalls).values({
        workspaceId,
        requestId,
        requestHash: "a".repeat(64),
        result: {},
        inputs: { name: "My apps" },
      });
      await tx.insert(schema.dataTemplateRecords).values([
        {
          workspaceId,
          requestId,
          key: "model:portfolio",
          kind: "model",
          recordId: m,
          templateVersion: 1,
          original: { definition: {} },
        },
        {
          workspaceId,
          requestId,
          key: "dashboard:portfolio",
          kind: "dashboard",
          recordId: board,
          templateVersion: 1,
          original: { normalized: {} },
        },
      ]);
    });
    const users = inUse(await call("DELETE", `/data/models/${m}`, owner));
    expect(users.storeTemplates).toEqual([
      { requestId, name: "Store portfolio" },
    ]);
    expect(users.dashboards).toEqual([{ id: board, name: "Store portfolio" }]);

    // The dashboard deleted: the install shows nothing any more, so its
    // model can go (template updates skip records deleted since).
    expect(
      (await call("DELETE", `/dashboards/${board}`, owner)).statusCode,
    ).toBe(204);
    expect((await call("DELETE", `/data/models/${m}`, owner)).statusCode).toBe(
      204,
    );
  });

  it("refuses while an open template update holds a draft of the item", async () => {
    const prep = await preparation(owner, "Drafted", await source(owner));
    const requestId = randomUUID();
    await withWorkspace(db, { workspaceId }, async (tx) => {
      await tx.insert(schema.dataTemplateInstalls).values({
        workspaceId,
        requestId,
        requestHash: "b".repeat(64),
        result: {},
        inputs: { name: "Updating apps" },
      });
      await tx.insert(schema.dataTemplateUpdates).values({
        workspaceId,
        requestId,
        fromVersion: 1,
        toVersion: 2,
        decisions: {},
        drafts: [
          {
            key: "preparation:x",
            kind: "preparation",
            recordId: prep,
            version: 2,
          },
        ],
        dashboards: [],
      });
    });
    expect(
      inUse(await call("DELETE", `/data/preparations/${prep}`, owner))
        .storeTemplates,
    ).toEqual([{ requestId, name: "Updating apps" }]);
    await withWorkspace(db, { workspaceId }, (tx) =>
      tx
        .update(schema.dataTemplateUpdates)
        .set({ closedAt: new Date() })
        .where(
          and(
            eq(schema.dataTemplateUpdates.workspaceId, workspaceId),
            eq(schema.dataTemplateUpdates.requestId, requestId),
          ),
        ),
    );
    expect(
      (await call("DELETE", `/data/preparations/${prep}`, owner)).statusCode,
    ).toBe(204);
  });

  it("deletes an item of an archived project", async () => {
    const created = await call("POST", "/projects", owner, { name: "Old" });
    expect(created.statusCode, created.body).toBe(200);
    const projectId = created.json().project.id as string;
    const m = await model(owner, "Archived model", await source(owner));
    expect(
      (await call("PUT", `/data/models/${m}/project`, owner, { projectId }))
        .statusCode,
    ).toBe(200);
    expect(
      (await call("POST", `/projects/${projectId}/archive`, owner)).statusCode,
    ).toBe(200);
    expect((await call("DELETE", `/data/models/${m}`, owner)).statusCode).toBe(
      204,
    );
  });

  it("is scoped to the caller's workspace and to owners and admins", async () => {
    const prep = await preparation(owner, "Scoped", await source(owner));
    const m = await model(owner, "Scoped model", await source(owner));
    // Another workspace's owner: through their own workspace the id is
    // unknown, and they are no member of this one.
    for (const path of [`/data/preparations/${prep}`, `/data/models/${m}`]) {
      expect(
        (await call("DELETE", path, otherOwner, undefined, otherWorkspaceId))
          .statusCode,
      ).toBe(404);
      expect((await call("DELETE", path, otherOwner)).statusCode).toBe(404);
      // Editors edit and publish, but do not delete (data:delete).
      expect((await call("DELETE", path, editor)).statusCode).toBe(403);
    }
    expect(await count("data_preparations", "id", prep)).toBe(1);
    expect(await count("data_models", "id", m)).toBe(1);
    // A malformed id answers like an unknown one.
    expect(
      (await call("DELETE", "/data/models/not-a-uuid", owner)).statusCode,
    ).toBe(404);
  });
});
