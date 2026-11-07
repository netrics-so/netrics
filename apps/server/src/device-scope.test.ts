/**
 * Fixed device scope (#500) and the query-path isolation matrix of the 11D
 * gate: every way a dashboard or a screen reaches model data, tried from
 * another workspace, from a device token and from a scoped screen.
 *
 * | Path                                   | Other workspace | Device token | Scoped screen       |
 * | -------------------------------------- | --------------- | ------------ | ------------------- |
 * | Dashboard data (saved, preview)        | 404             | 401          | n/a (session only)  |
 * | Dimension values, published models     | 404             | 401          | n/a (session only)  |
 * | Model query                            | 404             | 401          | n/a (session only)  |
 * | Paginated result session (#471)        | 404 / refused   | 401          | n/a (session only)  |
 * | Device payload, schemas 1–3            | foreign dashboard refused | own only | intersected, never widened |
 * | Server payload memo and ETag           | keyed by workspace | per device | keyed by scope   |
 */
import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPairingResponseSchema,
  deviceDashboardResponseSchema,
  deviceDashboardV2ResponseSchema,
  deviceDashboardV3ResponseSchema,
  deviceListResponseSchema,
  deviceResponseSchema,
  errorResponseSchema,
  pollPairingResponseSchema,
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
import { createTestDatabase } from "./test-db.js";
import { addMemberViaInvitation } from "./test-helpers.js";

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

let app: FastifyInstance, db: Database, admin: Sql;
let owner: string, editor: string, viewer: string, stranger: string;
let workspaceId: string, otherWorkspaceId: string;
let modelId: string, dashboardId: string, connectionId: string;
let scoped: Paired, unscoped: Paired, foreign: Paired;
let ip = 0;

interface Paired {
  id: string;
  accessToken: string;
}

const DE = { country: { kind: "values", values: ["DE"] } };

function call(
  method: "GET" | "POST" | "PUT" | "PATCH",
  url: string,
  options: {
    cookie?: string;
    token?: string;
    payload?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<InjectResponse> {
  return app.inject({
    method,
    url,
    headers: {
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
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

async function pair(
  workspace: string,
  cookie: string,
  dashboard: string | null,
): Promise<Paired> {
  const started = createPairingResponseSchema.parse(
    (await call("POST", "/v1/device/pairings")).json(),
  );
  const approved = await call(
    "POST",
    `/v1/workspaces/${workspace}/devices/approve`,
    {
      cookie,
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

const patchDevice = (device: Paired, payload: unknown, cookie = owner) =>
  call("PATCH", `/v1/workspaces/${workspaceId}/devices/${device.id}`, {
    cookie,
    payload,
  });

async function payload(device: Paired, schema: 1 | 2 | 3 = 3) {
  const response = await call("GET", `/v1/device/dashboard?schema=${schema}`, {
    token: device.accessToken,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response;
}

const filter = (fields: Record<string, unknown> = {}) => ({
  id: "country",
  name: "Country",
  type: "string",
  mode: "values",
  mappings: [{ modelId, dimensionId: "country" }],
  defaultValue: null,
  ...fields,
});
const measure = (fields: Record<string, unknown> = {}) => ({
  type: "measure",
  x: 0,
  y: 0,
  w: 4,
  h: 3,
  binding: {
    modelId,
    measureIds: ["income"],
    groupBy: [],
    exclusions: [],
  },
  options: { view: "value", limit: 20 },
  ...fields,
});
const chart = () =>
  measure({
    x: 4,
    w: 8,
    binding: {
      modelId,
      measureIds: ["income"],
      groupBy: ["country"],
      exclusions: [],
      interaction: { filterId: "country" },
    },
    options: { view: "bar", limit: 20 },
  });

async function saveDashboard(
  id: string,
  slides: unknown[],
  dataFilters: unknown[] = [filter()],
) {
  const current = (
    await call("GET", `/v1/workspaces/${workspaceId}/dashboards/${id}`, {
      cookie: editor,
    })
  ).json().dashboard;
  const saved = await call(
    "PUT",
    `/v1/workspaces/${workspaceId}/dashboards/${id}`,
    {
      cookie: editor,
      payload: {
        name: current.name,
        version: current.version,
        projectId: current.projectId,
        slides,
        settings: { ...current.settings, dataFilters },
      },
    },
  );
  expect(saved.statusCode, saved.body).toBe(200);
}

async function createDashboard(name: string, slides: unknown[]) {
  const created = await call(
    "POST",
    `/v1/workspaces/${workspaceId}/dashboards`,
    {
      cookie: editor,
      payload: { name, settings: { dataFilters: [filter()] }, slides },
    },
  );
  expect(created.statusCode, created.body).toBe(200);
  return created.json().dashboard.id as string;
}

type MeasureData = {
  scope?: string[];
  error: string | null;
  result: {
    releaseId: string | null;
    provenance: unknown[];
    appliedFilter: unknown;
    rows: Array<{
      dimensions: Record<string, unknown>;
      measures: Record<string, { value: unknown }>;
    }>;
  } | null;
};
function measures(body: unknown): Array<{ view: string; data: MeasureData }> {
  const slides = (body as { slides: Array<{ widgets: unknown[] }> }).slides;
  return slides.flatMap((slide) =>
    (
      slide.widgets as Array<{
        type: string;
        options: { view: string };
        data: MeasureData;
      }>
    )
      .filter((widget) => widget.type === "measure")
      .map((widget) => ({ view: widget.options.view, data: widget.data })),
  );
}
const income = (body: unknown) =>
  measures(body).find((widget) => widget.view === "value")!.data.result!
    .rows[0]!.measures.income!.value;
const bars = (body: unknown) =>
  measures(body)
    .find((widget) => widget.view === "bar")!
    .data.result!.rows.map((row) => [
      row.dimensions.country,
      row.measures.income!.value,
    ]);

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
  owner = await signUp("scope-owner@example.com");
  editor = await signUp("scope-editor@example.com");
  viewer = await signUp("scope-viewer@example.com");
  stranger = await signUp("scope-stranger@example.com");
  workspaceId = workspaceResponseSchema.parse(
    (
      await call("POST", "/v1/workspaces", {
        cookie: owner,
        payload: { name: "Scoped" },
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
  for (const [email, role] of [
    ["scope-editor@example.com", "editor"],
    ["scope-viewer@example.com", "viewer"],
  ] as const)
    expect(
      (await addMemberViaInvitation(app, db, owner, workspaceId, email, role))
        .statusCode,
    ).toBe(200);

  const data = `/v1/workspaces/${workspaceId}/data`;
  const source = await call("POST", `${data}/manual`, {
    cookie: editor,
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
          ["country", "string"],
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
        { values: { id: "a", country: "DE", amount: "100" } },
        { values: { id: "b", country: "DE", amount: "50" } },
        { values: { id: "c", country: "FR", amount: "25" } },
      ],
    },
  });
  expect(source.statusCode, source.body).toBe(200);
  const datasetId = source.json().datasetId as string;
  const model = await call("POST", `${data}/models`, {
    cookie: editor,
    payload: {
      name: "Sales",
      definition: {
        version: 1,
        datasets: [datasetId],
        relationships: [],
        dimensions: [
          { id: "country", name: "Country", datasetId, fieldId: "country" },
        ],
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
        cookie: editor,
        payload: { version: 1 },
      })
    ).statusCode,
  ).toBe(200);
  dashboardId = await createDashboard("Sales", [
    { widgets: [measure(), chart()] },
  ]);

  // An older observation source for widgets that cannot follow filters.
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
    insert into connections (workspace_id, connector_id, name)
    values (${workspaceId}, 'snap', 'Store') returning id`;
  connectionId = connection!.id as string;

  scoped = await pair(workspaceId, owner, dashboardId);
  unscoped = await pair(workspaceId, owner, dashboardId);
  foreign = await pair(otherWorkspaceId, stranger, null);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.$client.end({ timeout: 5 });
  await admin?.end({ timeout: 5 });
});

describe("setting and reviewing a screen's fixed scope", () => {
  it("stores the scope with its dashboard and lists it for review", async () => {
    const set = await patchDevice(scoped, { scope: { values: DE } });
    expect(set.statusCode, set.body).toBe(200);
    expect(deviceResponseSchema.parse(set.json()).device.scope).toEqual({
      dashboardId,
      values: DE,
    });
    const listed = deviceListResponseSchema.parse(
      (
        await call("GET", `/v1/workspaces/${workspaceId}/devices`, {
          cookie: owner,
        })
      ).json(),
    ).devices;
    expect(listed.find((device) => device.id === scoped.id)?.scope).toEqual({
      dashboardId,
      values: DE,
    });
    expect(
      listed.find((device) => device.id === unscoped.id)?.scope,
    ).toBeNull();
  });

  it("lets only owners and admins of the workspace change it", async () => {
    expectError(
      await patchDevice(unscoped, { scope: { values: DE } }, viewer),
      403,
      "forbidden",
    );
    expectError(
      await patchDevice(unscoped, { scope: { values: DE } }, stranger),
      404,
      "workspace_not_found",
    );
    expectError(
      await call(
        "PATCH",
        `/v1/workspaces/${otherWorkspaceId}/devices/${unscoped.id}`,
        { cookie: stranger, payload: { scope: { values: DE } } },
      ),
      404,
      "device_not_found",
    );
  });

  it("refuses scopes the dashboard cannot apply instead of storing them", async () => {
    for (const [values, error] of [
      [
        { region: { kind: "values", values: ["DE"] } },
        "device_scope_filter_unknown",
      ],
      [
        { country: { kind: "values", values: [1] } },
        "device_scope_value_invalid",
      ],
      [
        { country: { kind: "range", from: "A", to: "Z" } },
        "device_scope_value_invalid",
      ],
    ] as const)
      expectError(
        await patchDevice(unscoped, { scope: { values } }),
        400,
        error,
      );
    // An empty list would mean "everything": it is not a scope.
    expect(
      (
        await patchDevice(unscoped, {
          scope: { values: { country: { kind: "values", values: [] } } },
        })
      ).statusCode,
    ).toBe(400);
    const excluded = await createDashboard("Independent", [
      {
        widgets: [
          measure({
            binding: {
              modelId,
              measureIds: ["income"],
              groupBy: [],
              exclusions: [{ filterId: "country", reason: "All markets" }],
            },
          }),
        ],
      },
    ]);
    expectError(
      await patchDevice(unscoped, {
        dashboardId: excluded,
        scope: { values: DE },
      }),
      400,
      "device_scope_not_applicable",
    );
    const legacy = await createDashboard("Legacy", [
      {
        widgets: [
          {
            type: "metric",
            x: 0,
            y: 0,
            w: 4,
            h: 3,
            connectionId,
            metricKey: "snap.downloads",
            period: "last_7_days",
            filterExclusions: [{ filterId: "country", reason: "All apps" }],
          },
        ],
      },
    ]);
    expectError(
      await patchDevice(unscoped, {
        dashboardId: legacy,
        scope: { values: DE },
      }),
      400,
      "device_scope_not_applicable",
    );
    expectError(
      await patchDevice(unscoped, { dashboardId: null, scope: { values: DE } }),
      400,
      "device_scope_dashboard_required",
    );
    const after = deviceListResponseSchema
      .parse(
        (
          await call("GET", `/v1/workspaces/${workspaceId}/devices`, {
            cookie: owner,
          })
        ).json(),
      )
      .devices.find((device) => device.id === unscoped.id)!;
    expect(after).toMatchObject({ dashboardId, scope: null });
  });

  it("keeps a scope on its dashboard when a scope and a dashboard change race", async () => {
    const other = await createDashboard("Racing", [{ widgets: [measure()] }]);
    const racer = await pair(workspaceId, owner, dashboardId);
    for (let round = 0; round < 8; round += 1) {
      await admin`update devices set scope = null, dashboard_id = ${dashboardId}
        where id = ${racer.id}`;
      await Promise.all([
        patchDevice(racer, { scope: { values: DE } }),
        patchDevice(racer, { dashboardId: other }),
      ]);
      const [row] = await admin`
        select dashboard_id, scope from devices where id = ${racer.id}`;
      const scope = row!.scope as { dashboardId: string } | null;
      // Either order is fine; a scope recorded for another dashboard is not.
      if (scope !== null) expect(scope.dashboardId).toBe(row!.dashboard_id);
    }
  });

  it("never carries a scope to another dashboard silently", async () => {
    const other = await createDashboard("Other", [{ widgets: [measure()] }]);
    expectError(
      await patchDevice(scoped, { dashboardId: other }),
      409,
      "device_scope_dashboard_changed",
    );
    const moved = await patchDevice(scoped, {
      dashboardId: other,
      scope: { values: DE },
    });
    expect(moved.json().device.scope).toEqual({
      dashboardId: other,
      values: DE,
    });
    const back = await patchDevice(scoped, { dashboardId, scope: null });
    expect(back.json().device).toMatchObject({ dashboardId, scope: null });
    expect(
      (await patchDevice(scoped, { scope: { values: DE } })).statusCode,
    ).toBe(200);
  });
});

describe("device payloads under a fixed scope", () => {
  it("computes every schema on the server from the scope", async () => {
    const all = (await payload(unscoped)).json();
    const only = (await payload(scoped)).json();
    expect(income(all)).toBe("175");
    expect(income(only)).toBe("150");
    expect(bars(only)).toEqual([["DE", "150"]]);
    const data = measures(only)[0]!.data;
    // The scope is recorded with the applied filter, the model release
    // and the source generations of the result.
    expect(data.scope).toEqual(["Country: DE"]);
    expect(JSON.stringify(data.result!.appliedFilter)).toContain('"DE"');
    expect(data.result!.releaseId).toBeTruthy();
    expect(data.result!.provenance.length).toBeGreaterThan(0);
    expect(income((await payload(scoped, 2)).json())).toBe("150");
    // Released contracts still read a scoped payload: nothing new for apps.
    expect(() => deviceDashboardV3ResponseSchema.parse(only)).not.toThrow();
    const v2 = (await payload(scoped, 2)).json();
    expect(() => deviceDashboardV2ResponseSchema.parse(v2)).not.toThrow();
    const v1 = (await payload(scoped, 1)).json();
    expect(() => deviceDashboardResponseSchema.parse(v1)).not.toThrow();
  });

  it("never widens through filter values, saved defaults or interactions", async () => {
    // A device has no way to send choices: extra query parameters do not
    // change what it gets.
    const asked = await call(
      "GET",
      `/v1/device/dashboard?schema=3&values=${encodeURIComponent(JSON.stringify({ country: null }))}&country=FR`,
      { token: scoped.accessToken },
    );
    if (asked.statusCode === 200) expect(income(asked.json())).toBe("150");
    else expect(asked.statusCode).toBe(400);
    // The chart's click target never reaches a screen.
    expect((await payload(scoped)).body).not.toContain("interaction");
    // Saved choices are intersected, never substituted.
    await saveDashboard(
      dashboardId,
      [{ widgets: [measure(), chart()] }],
      [filter({ defaultValue: { kind: "values", values: ["DE", "FR"] } })],
    );
    expect(income((await payload(scoped)).json())).toBe("150");
    expect(income((await payload(unscoped)).json())).toBe("175");
    await saveDashboard(
      dashboardId,
      [{ widgets: [measure(), chart()] }],
      [filter({ defaultValue: { kind: "values", values: ["FR"] } })],
    );
    const disjoint = (await payload(scoped)).json();
    expect(income(disjoint)).toBeNull();
    expect(measures(disjoint)[0]!.data.scope).toEqual(["Country: FR ∩ DE"]);
    expect(income((await payload(unscoped)).json())).toBe("25");
    await saveDashboard(dashboardId, [{ widgets: [measure(), chart()] }]);
  });

  it("fails visibly when the dashboard stops supporting the scope", async () => {
    // A widget saved later that excludes the scoped filter reports an
    // error on the scoped screen instead of an unscoped total.
    await saveDashboard(dashboardId, [
      {
        widgets: [
          measure({
            binding: {
              modelId,
              measureIds: ["income"],
              groupBy: [],
              exclusions: [{ filterId: "country", reason: "All markets" }],
            },
          }),
        ],
      },
    ]);
    const excluded = measures((await payload(scoped)).json())[0]!.data;
    expect(excluded).toMatchObject({
      error: "device_scope_not_applicable",
      result: null,
    });
    expect(income((await payload(unscoped)).json())).toBe("175");
    // A removed filter does not drop the scope either.
    await saveDashboard(dashboardId, [{ widgets: [measure()] }], []);
    expect(measures((await payload(scoped)).json())[0]!.data).toMatchObject({
      error: "device_scope_filter_unknown",
      result: null,
    });
    await saveDashboard(dashboardId, [{ widgets: [measure(), chart()] }]);
    expect(income((await payload(scoped)).json())).toBe("150");
  });

  it("withholds widgets that cannot follow the scope and never shares a cached payload across scopes", async () => {
    const legacy = await createDashboard("Mixed", [{ widgets: [measure()] }]);
    const moved = await patchDevice(scoped, {
      dashboardId: legacy,
      scope: { values: DE },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(
      (await patchDevice(unscoped, { dashboardId: legacy })).statusCode,
    ).toBe(200);
    // Saved afterwards: only observation widgets, no model widget, so the
    // payload is memoized like every dashboard before models.
    await saveDashboard(legacy, [
      {
        widgets: [
          {
            type: "metric",
            x: 0,
            y: 0,
            w: 4,
            h: 3,
            connectionId,
            metricKey: "snap.downloads",
            period: "last_7_days",
            filterExclusions: [{ filterId: "country", reason: "All apps" }],
          },
          { type: "text", x: 4, y: 0, w: 4, h: 3, text: "Welcome" },
        ],
      },
    ]);
    const types = (body: {
      slides: Array<{ widgets: Array<{ type: string }> }>;
    }) =>
      body.slides.flatMap((slide) =>
        slide.widgets.map((widget) => widget.type),
      );
    const open = await payload(unscoped);
    expect(types(open.json())).toEqual(["metric", "text"]);
    expect((await payload(unscoped, 1)).json().tiles).toHaveLength(1);
    // The scoped screen asks with the unscoped screen's ETag: it gets its
    // own payload, not a 304 and not the memoized unscoped one.
    const response = await call("GET", "/v1/device/dashboard?schema=3", {
      token: scoped.accessToken,
      headers: { "if-none-match": open.headers.etag as string },
    });
    expect(response.statusCode).toBe(200);
    expect(types(response.json())).toEqual(["text"]);
    expect(response.headers.etag).not.toBe(open.headers.etag);
    expect((await payload(scoped, 1)).json().tiles).toEqual([]);
    expect(
      (await payload(scoped, 2))
        .json()
        .slides[0].widgets.map((widget: { type: string }) => widget.type),
    ).toEqual(["text"]);
    // And the other way round: the unscoped screen is not narrowed by it.
    expect(types((await payload(unscoped)).json())).toEqual(["metric", "text"]);
    // A new scope on this dashboard is refused while it cannot follow it.
    expectError(
      await patchDevice(unscoped, { scope: { values: DE } }),
      400,
      "device_scope_not_applicable",
    );
    await patchDevice(scoped, { dashboardId, scope: { values: DE } });
    await patchDevice(unscoped, { dashboardId });
  });
});

describe("query paths: cross-workspace and device-scope isolation", () => {
  const w = () => `/v1/workspaces/${workspaceId}`;
  const paths = (): Array<[string, "GET" | "POST", string, unknown?]> => [
    [
      "dashboard data",
      "POST",
      `${w()}/dashboards/${dashboardId}/data`,
      {
        values: { country: null },
      },
    ],
    [
      "dashboard preview",
      "POST",
      `${w()}/dashboards/data/preview`,
      {
        filters: [filter()],
        values: {},
        widgets: [
          {
            id: "51bb53cb-3540-4b70-a287-151c5fa16803",
            binding: measure().binding,
            options: measure().options,
          },
        ],
      },
    ],
    [
      "dimension values",
      "POST",
      `${w()}/dashboards/models/${modelId}/dimensions/country/values`,
      {},
    ],
    ["published models", "GET", `${w()}/dashboards/published-models`],
    [
      "model query",
      "POST",
      `${w()}/data/models/${modelId}/query`,
      {
        measureIds: ["income"],
        groupBy: ["country"],
      },
    ],
  ];

  it("answers the workspace's own members and nobody else", async () => {
    for (const [name, method, url, body] of paths()) {
      const own = await call(method, url, { cookie: viewer, payload: body });
      expect(own.statusCode, `${name}: ${own.body}`).toBe(200);
      const outside = await call(method, url, {
        cookie: stranger,
        payload: body,
      });
      expect(outside.statusCode, name).toBe(404);
      expect(outside.body, name).not.toContain("DE");
      const anonymous = await call(method, url, { payload: body });
      expect(anonymous.statusCode, name).toBe(401);
      // Device tokens only reach the device API, scoped or not.
      for (const device of [scoped, unscoped, foreign]) {
        const response = await call(method, url, {
          token: device.accessToken,
          payload: body,
        });
        expect(response.statusCode, name).toBe(401);
      }
    }
    // The same ids under the stranger's own workspace find nothing, and
    // answer exactly as ids that exist nowhere: no existence oracle.
    const mine = `/v1/workspaces/${otherWorkspaceId}`;
    const nowhere = "0b9cc5c4-5a3e-4c1f-9a43-2f0d7e3e9f10";
    for (const [method, url, body, foreignId] of [
      ["POST", `${mine}/dashboards/{id}/data`, { values: {} }, dashboardId],
      [
        "POST",
        `${mine}/dashboards/models/{id}/dimensions/country/values`,
        {},
        modelId,
      ],
      [
        "POST",
        `${mine}/data/models/{id}/query`,
        { measureIds: ["income"], groupBy: [] },
        modelId,
      ],
    ] as const) {
      const real = await call(method, url.replace("{id}", foreignId), {
        cookie: stranger,
        payload: body,
      });
      const unknown = await call(method, url.replace("{id}", nowhere), {
        cookie: stranger,
        payload: body,
      });
      expect(real.statusCode, url).toBeGreaterThanOrEqual(400);
      expect([real.statusCode, real.json()], url).toEqual([
        unknown.statusCode,
        unknown.json(),
      ]);
    }
  });

  it("binds paginated result sessions to their caller and workspace", async () => {
    const query = { measureIds: ["income"], groupBy: ["country"], limit: 1 };
    const first = await call("POST", `${w()}/data/models/${modelId}/query`, {
      cookie: viewer,
      payload: { ...query, pinPages: true },
    });
    expect(first.statusCode, first.body).toBe(200);
    const pageToken = first.json().nextPageToken as string;
    expect(pageToken).toBeTruthy();
    const next = await call("POST", `${w()}/data/models/${modelId}/query`, {
      cookie: viewer,
      payload: { ...query, pageToken },
    });
    expect(next.statusCode, next.body).toBe(200);
    expect(next.json().rows[0].dimensions.country).toBe("FR");
    for (const [cookie, url] of [
      [owner, `${w()}/data/models/${modelId}/query`],
      [stranger, `${w()}/data/models/${modelId}/query`],
      [
        stranger,
        `/v1/workspaces/${otherWorkspaceId}/data/models/${modelId}/query`,
      ],
    ] as const) {
      const response = await call("POST", url, {
        cookie,
        payload: { ...query, pageToken },
      });
      expect(response.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(response.body).not.toContain("FR");
    }
    for (const device of [scoped, foreign]) {
      const response = await call(
        "POST",
        `${w()}/data/models/${modelId}/query`,
        { token: device.accessToken, payload: { ...query, pageToken } },
      );
      expect(response.statusCode).toBe(401);
    }
  });

  it("keeps device payloads inside the device's workspace", async () => {
    // Another workspace's screen cannot be pointed at this dashboard, and
    // its payload never contains it.
    expectError(
      await call(
        "PATCH",
        `/v1/workspaces/${otherWorkspaceId}/devices/${foreign.id}`,
        { cookie: stranger, payload: { dashboardId } },
      ),
      404,
      "dashboard_not_found",
    );
    expectError(
      await call(
        "PATCH",
        `/v1/workspaces/${otherWorkspaceId}/devices/${foreign.id}`,
        { cookie: stranger, payload: { scope: { values: DE } } },
      ),
      400,
      "device_scope_dashboard_required",
    );
    // A stored scope naming a foreign dashboard shows nothing of it.
    await admin`update devices set dashboard_id = null,
      scope = ${admin.json({ dashboardId, values: DE })}
      where id = ${foreign.id}`;
    const body = (await payload(foreign)).json();
    expect(body.dashboard).toBeNull();
    expect(body.slides).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(dashboardId);
  });
});
