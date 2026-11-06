import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "@netrics/database";
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
