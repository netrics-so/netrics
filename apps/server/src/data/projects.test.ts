import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  auditEventListResponseSchema,
  modelQueryResponseSchema,
  modelResponseSchema,
  preparationResponseSchema,
  projectResponseSchema,
  workspaceResponseSchema,
} from "@netrics/contracts";
import { createDatabase, type Database } from "@netrics/database";

import { buildApp } from "../app.js";
import { createAuthService } from "../auth/index.js";
import { loadConfig } from "../env.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "../test-db.js";
import { addMemberViaInvitation } from "../test-helpers.js";

// A project on preparations and models (#572): set on create, moved with
// its own route, never by a draft save, and a move never creates a draft or
// changes what published dashboards show.

let app: FastifyInstance, db: Database;
let owner: string, editor: string, viewer: string, stranger: string;
let workspaceId: string, otherWorkspaceId: string;
let A: string, B: string, archived: string, projectOfW2: string;
let datasetId: string;

const call = (
  method: "GET" | "POST" | "PUT",
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
async function project(cookie: string, workspace: string, name: string) {
  const response = await call("POST", "/projects", cookie, { name }, workspace);
  expect(response.statusCode).toBe(200);
  return projectResponseSchema.parse(response.json()).project.id;
}
const graph = () => ({
  version: 1,
  nodes: [{ id: "source", type: "source", datasetId }],
  outputs: ["source"],
});
const definition = () => ({
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
      aggregate: { id: "total", name: "Total", op: "sum", fieldId: "amount" },
    },
  ],
});

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
  owner = await signup("projects-owner@example.com");
  editor = await signup("projects-editor@example.com");
  viewer = await signup("projects-viewer@example.com");
  stranger = await signup("projects-stranger@example.com");
  for (const [cookie, name] of [
    [owner, "Data projects"],
    [stranger, "Other"],
  ] as const) {
    const created = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { cookie },
      payload: { name },
    });
    const id = workspaceResponseSchema.parse(created.json()).workspace.id;
    if (cookie === owner) workspaceId = id;
    else otherWorkspaceId = id;
  }
  for (const [email, role] of [
    ["projects-editor@example.com", "editor"],
    ["projects-viewer@example.com", "viewer"],
  ] as const)
    expect(
      (await addMemberViaInvitation(app, db, owner, workspaceId, email, role))
        .statusCode,
    ).toBe(200);
  A = await project(owner, workspaceId, "A");
  B = await project(owner, workspaceId, "B");
  archived = await project(owner, workspaceId, "Archived");
  expect(
    (await call("POST", `/projects/${archived}/archive`, owner)).statusCode,
  ).toBe(200);
  projectOfW2 = await project(stranger, otherWorkspaceId, "A");
  const source = await call("POST", "/data/manual", editor, {
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
  });
  expect(source.statusCode, source.body).toBe(200);
  datasetId = source.json().datasetId as string;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);
afterAll(async () => {
  await app?.close();
  await db?.$client.end({ timeout: 5 });
});

async function createModel(name: string, projectId?: string) {
  const created = await call("POST", "/data/models", editor, {
    name,
    definition: definition(),
    ...(projectId === undefined ? {} : { projectId }),
  });
  expect(created.statusCode, created.body).toBe(200);
  return modelResponseSchema.parse(created.json()).model;
}

describe("a project on preparations and models", () => {
  it("creates a preparation in a project and moves it without a new draft", async () => {
    const created = await call("POST", "/data/preparations", editor, {
      name: "P",
      graph: graph(),
      projectId: A,
    });
    expect(created.statusCode, created.body).toBe(200);
    const preparation = preparationResponseSchema.parse(
      created.json(),
    ).preparation;
    expect(preparation.projectId).toBe(A);
    expect(
      (
        await call(
          "POST",
          `/data/preparations/${preparation.id}/publish`,
          editor,
          { version: 1 },
        )
      ).statusCode,
    ).toBe(200);
    const published = preparationResponseSchema.parse(
      (
        await call("GET", `/data/preparations/${preparation.id}`, editor)
      ).json(),
    ).preparation;
    const moved = await call(
      "PUT",
      `/data/preparations/${preparation.id}/project`,
      editor,
      { projectId: B },
    );
    expect(moved.statusCode, moved.body).toBe(200);
    expect(
      preparationResponseSchema.parse(moved.json()).preparation,
    ).toMatchObject({
      projectId: B,
      version: published.version,
      publishedVersion: published.publishedVersion,
      updatedAt: published.updatedAt,
    });
    // Clearing to unassigned always works.
    const cleared = await call(
      "PUT",
      `/data/preparations/${preparation.id}/project`,
      editor,
      { projectId: null },
    );
    expect(cleared.json().preparation.projectId).toBeNull();
    const events = auditEventListResponseSchema.parse(
      (await call("GET", "/audit-events", owner)).json(),
    ).events;
    expect(
      events
        .filter(
          (e) =>
            e.action === "data.preparation_project_changed" &&
            e.target === preparation.id,
        )
        .map((e) => e.metadata),
    ).toEqual([
      { from: B, to: null },
      { from: A, to: B },
    ]);
  });

  it("ignores projectId on a draft save", async () => {
    const model = await createModel("Draft save", A);
    const saved = await call("PUT", `/data/models/${model.id}`, editor, {
      name: "Draft save",
      definition: definition(),
      version: model.version,
      projectId: B,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(modelResponseSchema.parse(saved.json()).model).toMatchObject({
      projectId: A,
      version: model.version + 1,
    });
    const created = await call("POST", "/data/preparations", editor, {
      name: "Prep draft save",
      graph: graph(),
      projectId: A,
    });
    const preparation = preparationResponseSchema.parse(
      created.json(),
    ).preparation;
    const savedPreparation = await call(
      "PUT",
      `/data/preparations/${preparation.id}`,
      editor,
      {
        name: "Prep draft save",
        graph: graph(),
        version: preparation.version,
        projectId: B,
      },
    );
    expect(savedPreparation.json().preparation.projectId).toBe(A);
  });

  it("refuses another workspace's or an archived project", async () => {
    const m = (await createModel("Refused")).id;
    expect((await createModel("Unassigned")).projectId).toBeNull();
    for (const projectId of [projectOfW2, archived, crypto.randomUUID()]) {
      const response = await call("PUT", `/data/models/${m}/project`, editor, {
        projectId,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "project_not_found" });
      const created = await call("POST", "/data/models", editor, {
        name: "Refused on create",
        definition: definition(),
        projectId,
      });
      expect(created.statusCode).toBe(404);
      expect(created.json()).toEqual({ error: "project_not_found" });
    }
    expect(
      (
        await call(
          "PUT",
          `/data/models/${crypto.randomUUID()}/project`,
          editor,
          {
            projectId: A,
          },
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call("PUT", `/data/models/${m}/project`, editor, {
          projectId: "nope",
        })
      ).statusCode,
    ).toBe(400);
    // Another workspace's caller cannot move it either.
    expect(
      (
        await call(
          "PUT",
          `/data/models/${m}/project`,
          stranger,
          { projectId: projectOfW2 },
          otherWorkspaceId,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      modelResponseSchema.parse(
        (await call("GET", `/data/models/${m}`, editor)).json(),
      ).model.projectId,
    ).toBeNull();
  });

  it("accepts a no-op move to the current, since archived project", async () => {
    const project = await call("POST", "/projects", owner, {
      name: "Archived later",
    });
    const later = projectResponseSchema.parse(project.json()).project.id;
    const model = await createModel("Stays put", later);
    expect(
      (await call("POST", `/projects/${later}/archive`, owner)).statusCode,
    ).toBe(200);
    const same = await call("PUT", `/data/models/${model.id}/project`, editor, {
      projectId: later,
    });
    expect(same.statusCode, same.body).toBe(200);
    expect(modelResponseSchema.parse(same.json()).model.projectId).toBe(later);
    const events = auditEventListResponseSchema.parse(
      (await call("GET", "/audit-events", owner)).json(),
    ).events;
    expect(
      events.some(
        (e) =>
          e.action === "data.model_project_changed" && e.target === model.id,
      ),
    ).toBe(false);
    // Moving away and back is a change, so it is refused.
    await call("PUT", `/data/models/${model.id}/project`, editor, {
      projectId: null,
    });
    expect(
      (
        await call("PUT", `/data/models/${model.id}/project`, editor, {
          projectId: later,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("refuses viewers", async () => {
    const m = (await createModel("Viewer target")).id;
    for (const kind of ["models", "preparations"] as const)
      expect(
        (
          await call("PUT", `/data/${kind}/${m}/project`, viewer, {
            projectId: A,
          })
        ).statusCode,
      ).toBe(403);
  });

  it("keeps the published dashboard's data identical after a project move", async () => {
    const model = await createModel("Published", A);
    expect(
      (
        await call("POST", `/data/models/${model.id}/publish`, editor, {
          version: 1,
        })
      ).statusCode,
    ).toBe(200);
    const query = () =>
      call("POST", `/data/models/${model.id}/query`, viewer, {
        measureIds: ["total"],
        groupBy: [],
      });
    const before = modelQueryResponseSchema.parse((await query()).json());
    const moved = await call("PUT", `/data/models/${model.id}/project`, owner, {
      projectId: B,
    });
    expect(modelResponseSchema.parse(moved.json()).model).toMatchObject({
      projectId: B,
      version: 1,
      publishedVersion: 1,
    });
    const after = modelQueryResponseSchema.parse((await query()).json());
    expect(after.rows).toEqual(before.rows);
    expect(after.releaseId).toBe(before.releaseId);
  });
});
