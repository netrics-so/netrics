/**
 * Project navigation checks (#572, milestone 11E): every list that
 * navigation and pickers read follows the project filter and never shows
 * another workspace; archiving hides a project's items from those lists but
 * keeps paired screens and direct links working; a hard-deleted project's
 * items come back under All.
 */
import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPairingResponseSchema,
  deviceResponseSchema,
  pollPairingResponseSchema,
  projectResponseSchema,
  workspaceResponseSchema,
} from "@netrics/contracts";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;
type Item = { id: string; name: string };

let app: FastifyInstance, db: Database, admin: Sql;
let owner: string, stranger: string;
let W1: World, W2: World;
let ip = 0;

interface World {
  workspaceId: string;
  A: string;
  B: string;
  ids: Set<string>;
  dashboardInA: string;
}

function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
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
    remoteAddress: `198.51.100.${(ip = (ip % 250) + 1)}`,
    ...(options.payload !== undefined
      ? { payload: options.payload as InjectOptions["payload"] }
      : {}),
  });
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

async function ok(response: Promise<InjectResponse>) {
  const resolved = await response;
  expect(resolved.statusCode, resolved.body).toBe(200);
  return resolved.json();
}

const NAMES = { A: "in A", B: "in B", none: "none" } as const;

/**
 * One workspace with projects A and B and, for every kind, an item in A,
 * one in B and one unassigned; B is archived at the end.
 */
async function seed(cookie: string, name: string): Promise<World> {
  const workspaceId = workspaceResponseSchema.parse(
    await ok(call("POST", "/v1/workspaces", { cookie, payload: { name } })),
  ).workspace.id;
  const ws = `/v1/workspaces/${workspaceId}`;
  const project = async (projectName: string) =>
    projectResponseSchema.parse(
      await ok(
        call("POST", `${ws}/projects`, {
          cookie,
          payload: { name: projectName },
        }),
      ),
    ).project.id;
  const A = await project("A");
  const B = await project("B");
  const projects = { A, B, none: null } as const;
  const ids = new Set<string>();

  const source = await ok(
    call("POST", `${ws}/data/manual`, {
      cookie,
      payload: {
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
    }),
  );
  const datasetId = source.datasetId as string;
  ids.add(datasetId);

  const models = {} as Record<keyof typeof NAMES, string>;
  for (const key of ["A", "B", "none"] as const) {
    const projectId = projects[key];
    const preparation = (
      await ok(
        call("POST", `${ws}/data/preparations`, {
          cookie,
          payload: {
            name: NAMES[key],
            graph: {
              version: 1,
              nodes: [{ id: "source", type: "source", datasetId }],
              outputs: ["source"],
            },
            ...(projectId ? { projectId } : {}),
          },
        }),
      )
    ).preparation.id as string;
    await ok(
      call("POST", `${ws}/data/preparations/${preparation}/publish`, {
        cookie,
        payload: { version: 1 },
      }),
    );
    ids.add(preparation);
    ids.add(`prepared:${preparation}:source`);

    const model = (
      await ok(
        call("POST", `${ws}/data/models`, {
          cookie,
          payload: {
            name: NAMES[key],
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
            ...(projectId ? { projectId } : {}),
          },
        }),
      )
    ).model.id as string;
    await ok(
      call("POST", `${ws}/data/models/${model}/publish`, {
        cookie,
        payload: { version: 1 },
      }),
    );
    models[key] = model;
    ids.add(model);

    const [connection] = await admin`
      insert into connections (workspace_id, project_id, connector_id, name)
      values (${workspaceId}, ${projectId}, 'app-store-connect', ${NAMES[key]})
      returning id`;
    const connectionId = connection!.id as string;
    await admin`
      insert into connection_resources
        (connection_id, workspace_id, resource_id, name, kind)
      values (${connectionId}, ${workspaceId}, 'app-1', 'App', 'app')`;
    ids.add(connectionId);
    ids.add(`resources:${connectionId}`);
  }

  const dashboards = {} as Record<keyof typeof NAMES, string>;
  for (const key of ["A", "B", "none"] as const) {
    const projectId = projects[key];
    const dashboard = await ok(
      call("POST", `${ws}/dashboards`, {
        cookie,
        payload: {
          name: NAMES[key],
          ...(projectId ? { projectId } : {}),
          slides: [
            {
              name: "Numbers",
              widgets: [
                {
                  type: "measure",
                  x: 0,
                  y: 0,
                  w: 4,
                  h: 3,
                  binding: {
                    modelId: models[key],
                    measureIds: ["total"],
                    groupBy: [],
                    exclusions: [],
                  },
                  options: { view: "value", limit: 20 },
                },
              ],
            },
          ],
        },
      }),
    );
    dashboards[key] = dashboard.dashboard.id as string;
    ids.add(dashboards[key]);
  }

  await ok(call("POST", `${ws}/projects/${B}/archive`, { cookie }));
  return { workspaceId, A, B, ids, dashboardInA: dashboards.A };
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
  admin = createRawSqlClient(test.adminUrl, { max: 1 });
  app = await buildApp(config, {
    db,
    authService: createAuthService(config, db, {
      logger: pino({ level: "silent" }),
    }),
    checkDb: async () => true,
  });
  owner = await signUp("navigation-owner@example.com");
  stranger = await signUp("navigation-stranger@example.com");
  W1 = await seed(owner, "W1");
  W2 = await seed(stranger, "W2");
}, TEST_DATABASE_SETUP_TIMEOUT_MS * 2);

afterAll(async () => {
  await app?.close();
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin?.end({ timeout: 5 }).catch(() => undefined);
});

type Body = Record<string, unknown>;
const items = (value: unknown) => value as Item[];
const sources = (b: Body, kind: string) =>
  items(b.sources)
    .filter((s) => (s as Item & { kind: string }).kind === kind)
    .map((s) => ({ id: s.id, name: s.name.replace(/ \/ Resources$/, "") }));

const LISTS = [
  { path: "/dashboards", label: "", pick: (b: Body) => items(b.dashboards) },
  { path: "/connections", label: "", pick: (b: Body) => items(b.connections) },
  {
    path: "/data/preparations",
    label: "",
    pick: (b: Body) => items(b.preparations),
  },
  { path: "/data/models", label: "", pick: (b: Body) => items(b.models) },
  {
    path: "/data/sources",
    label: "(prepared outputs)",
    pick: (b: Body) => sources(b, "prepared"),
  },
  {
    path: "/data/sources",
    label: "(connection sources)",
    pick: (b: Body) => sources(b, "resources"),
  },
  {
    path: "/dashboards/published-models",
    label: "",
    pick: (b: Body) =>
      (b.models as { modelId: string; modelName: string }[]).map((m) => ({
        id: m.modelId,
        name: m.modelName,
      })),
  },
] as const;

const names = (list: Item[]) => list.map((item) => item.name).sort();
const ids = (list: Item[]) => list.map((item) => item.id);

async function list(path: string, query: string, world = W1, cookie = owner) {
  return (await ok(
    call("GET", `/v1/workspaces/${world.workspaceId}${path}${query}`, {
      cookie,
    }),
  )) as Body;
}

async function pair(dashboardId: string) {
  const started = createPairingResponseSchema.parse(
    (await call("POST", "/v1/device/pairings")).json(),
  );
  const approved = await call(
    "POST",
    `/v1/workspaces/${W1.workspaceId}/devices/approve`,
    {
      cookie: owner,
      payload: { code: started.code, name: "Lobby TV", dashboardId },
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
  deviceResponseSchema.parse(approved.json());
  return polled.credentials.accessToken;
}

async function devicePayload(token: string) {
  const bodies: string[] = [];
  for (const schema of [1, 2, 3]) {
    const response = await call(
      "GET",
      `/v1/device/dashboard?schema=${schema}`,
      { token },
    );
    expect(response.statusCode, response.body).toBe(200);
    bodies.push(response.body);
  }
  return bodies;
}

describe("project navigation checks", () => {
  it.each(LISTS)(
    "$path $label follows the project filter",
    async ({ path, pick }) => {
      expect(names(pick(await list(path, "?project=" + W1.A)))).toEqual([
        "in A",
      ]);
      expect(
        names(pick(await list(path, `?project=${W1.A}&unassigned=include`))),
      ).toEqual(["in A", "none"]);
      // B is archived: hidden under All.
      expect(names(pick(await list(path, "?project=all")))).toEqual([
        "in A",
        "none",
      ]);
      // An archived project's items are still reachable by asking for it.
      expect(names(pick(await list(path, "?project=" + W1.B)))).toEqual([
        "in B",
      ]);
      // No filter: the full list, as before.
      expect(names(pick(await list(path, "")))).toEqual([
        "in A",
        "in B",
        "none",
      ]);
    },
  );

  it.each(LISTS)(
    "$path $label never shows another workspace",
    async ({ path, pick }) => {
      expect(ids(pick(await list(path, "?project=" + W2.A)))).toEqual([]);
      expect(
        ids(pick(await list(path, `?project=${W2.A}&unassigned=include`))).some(
          (id) => W2.ids.has(id),
        ),
      ).toBe(false);
      for (const query of ["?project=all", ""])
        expect(
          ids(pick(await list(path, query))).some((id) => W2.ids.has(id)),
        ).toBe(false);
    },
  );

  it("counts manual sources as unassigned", async () => {
    const manual = async (query: string) =>
      items((await list("/data/sources", query)).sources)
        .filter((s) => (s as Item & { kind: string }).kind === "manual")
        .map((s) => s.name);
    expect(await manual("?project=" + W1.A)).toEqual([]);
    expect(await manual(`?project=${W1.A}&unassigned=include`)).toEqual([
      "Numbers",
    ]);
    expect(await manual("?project=all")).toEqual(["Numbers"]);
  });

  it("rejects malformed filters", async () => {
    for (const { path } of LISTS)
      for (const query of [
        "?project=nope",
        "?unassigned=exclude",
        `?project=${W1.A}&other=1`,
      ]) {
        const response = await call(
          "GET",
          `/v1/workspaces/${W1.workspaceId}${path}${query}`,
          { cookie: owner },
        );
        expect(response.statusCode, `${path}${query}`).toBe(400);
      }
  });

  it("archiving keeps paired screens working byte for byte", async () => {
    const token = await pair(W1.dashboardInA);
    const before = await devicePayload(token);
    const ws = `/v1/workspaces/${W1.workspaceId}`;
    await ok(call("POST", `${ws}/projects/${W1.A}/archive`, { cookie: owner }));
    expect(await devicePayload(token)).toEqual(before);
    // The direct link keeps working.
    const view = await call("GET", `${ws}/dashboards/${W1.dashboardInA}`, {
      cookie: owner,
    });
    expect(view.statusCode).toBe(200);
    // Hidden from navigation while archived.
    expect(
      names(items((await list("/dashboards", "?project=all")).dashboards)),
    ).toEqual(["none"]);
    await ok(
      call("POST", `${ws}/projects/${W1.A}/unarchive`, { cookie: owner }),
    );
    expect(await devicePayload(token)).toEqual(before);
  });

  it("a hard-deleted project's items reappear under All", async () => {
    const deleted = await call(
      "DELETE",
      `/v1/workspaces/${W1.workspaceId}/projects/${W1.A}`,
      { cookie: owner },
    );
    expect(deleted.statusCode).toBe(204);
    for (const { path, pick } of LISTS) {
      expect(names(pick(await list(path, "?project=all"))), path).toEqual([
        "in A",
        "none",
      ]);
      expect(names(pick(await list(path, "?project=" + W1.A))), path).toEqual(
        [],
      );
    }
  });
});
