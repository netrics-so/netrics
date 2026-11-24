import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dashboardDataResponseSchema,
  dashboardResponseSchema,
  deviceDashboardV2ResponseSchema,
  deviceDashboardV3ResponseSchema,
} from "@netrics/contracts";

import { stateItemsOf } from "./dashboards/state.js";
import { createItemsFixture, type ItemsFixture } from "./test-items.js";

// The state widget (#875, ADR 0019 section 15): saved like a latest-items
// widget, bound to a published model with a name and a state dimension
// (plus an optional changed-at and rolled-back flag). Its data is every
// item's state normalized to the fixed set, not healthy first, bounded by
// the list's limit with a total; screens get it with `features=state`,
// older ones a text in its place.

let f: ItemsFixture;
let modelId: string;

/** The services table: one row per service, each of a project. */
const SERVICES = [
  // name, project, state, healthy, changed_at, rolled_back
  ["web", "shop", "up", true, "2026-11-09T08:00:00.000Z", false],
  ["api", "shop", "FAILED", false, "2026-11-10T09:30:00.000Z", false],
  ["worker", "shop", "building", true, null, false],
  ["site", "blog", "READY", true, "2026-11-08T12:00:00.000Z", true],
  ["db", "blog", "degraded", false, null, false],
  ["cron", "blog", "sleeping", true, null, true],
] as const;

const binding = (extra: Record<string, unknown> = {}) => ({
  modelId,
  nameDimensionId: "service",
  stateDimensionId: "state",
  changedAtDimensionId: "changed_at",
  rolledBackDimensionId: "rolled_back",
  ...extra,
});

const projectFilter = () => ({
  id: "project",
  name: "Project",
  type: "string",
  mode: "values",
  mappings: [{ modelId, dimensionId: "project" }],
  defaultValue: null,
});

const stateWidget = (extra: Record<string, unknown> = {}) => ({
  type: "state",
  x: 0,
  y: 0,
  w: 4,
  h: 4,
  binding: binding(),
  options: {},
  ...extra,
});

function save(
  widgets: unknown[],
  dataFilters: unknown[] = [],
  slide: Record<string, unknown> = {},
) {
  return f.call("POST", "/dashboards", {
    name: "Operations",
    settings: { dataFilters },
    slides: [{ widgets, ...slide }],
  });
}

async function saved(
  widgets: unknown[],
  dataFilters: unknown[] = [],
  slide: Record<string, unknown> = {},
) {
  const response = await save(widgets, dataFilters, slide);
  expect(response.statusCode, response.body).toBe(200);
  return dashboardResponseSchema.parse(response.json()).dashboard;
}

async function data(dashboardId: string, values: unknown = {}) {
  const response = await f.call("POST", `/dashboards/${dashboardId}/data`, {
    values,
  });
  expect(response.statusCode, response.body).toBe(200);
  return dashboardDataResponseSchema.parse(response.json());
}

const names = (items: Array<{ name: string | null }>) =>
  items.map((item) => item.name);

beforeAll(async () => {
  f = await createItemsFixture("state-widget");
  const field = (id: string, type: string) => ({
    id,
    name: id,
    type,
    nullable: id !== "id",
    classification: "internal",
  });
  const manual = await f.call("POST", "/data/manual", {
    definition: {
      key: "services",
      name: "Services",
      version: 1,
      mode: "snapshot",
      grain: "one service",
      keyFields: ["id"],
      fields: [
        field("id", "string"),
        field("service", "string"),
        field("project", "string"),
        field("state", "string"),
        field("healthy", "boolean"),
        field("changed_at", "timestamp"),
        field("rolled_back", "boolean"),
        field("cpu", "number"),
      ],
    },
    records: SERVICES.map(
      ([service, project, state, healthy, changed, rolled], index) => ({
        values: {
          id: `s${index}`,
          service,
          project,
          state,
          healthy,
          changed_at: changed,
          rolled_back: rolled,
          cpu: index,
        },
      }),
    ),
  });
  expect(manual.statusCode, manual.body).toBe(200);
  const datasetId = manual.json().datasetId as string;
  const model = await f.call("POST", "/data/models", {
    name: "Services",
    definition: {
      version: 1,
      datasets: [datasetId],
      relationships: [],
      dimensions: [
        "service",
        "project",
        "state",
        "healthy",
        "changed_at",
        "rolled_back",
        "cpu",
      ].map((id) => ({ id, name: id, datasetId, fieldId: id })),
      measures: [
        {
          id: "services",
          name: "Services",
          kind: "aggregate",
          datasetId,
          aggregate: { id: "services", name: "services", op: "count" },
        },
      ],
    },
  });
  expect(model.statusCode, model.body).toBe(200);
  const { id, version } = model.json().model;
  const published = await f.call("POST", `/data/models/${id}/publish`, {
    version,
  });
  expect(published.statusCode, published.body).toBe(200);
  modelId = id as string;
}, 120_000);

afterAll(async () => {
  await f?.close();
});

describe("the state widget (#875)", () => {
  it("saves with its binding and options, defaults filled in", async () => {
    const dashboard = await saved([stateWidget()]);
    const widget = dashboard.slides[0]!.widgets[0]!;
    expect(widget).toMatchObject({
      type: "state",
      binding: binding({ exclusions: [] }),
      options: {
        layout: "list",
        item: null,
        limit: 8,
        showChanged: true,
        states: {},
      },
    });
  });

  it("refuses dimensions of the wrong type or unknown to the model", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ nameDimensionId: "cpu" }, "state_name_dimension_invalid"],
      [{ stateDimensionId: "cpu" }, "state_state_dimension_invalid"],
      [{ changedAtDimensionId: "service" }, "state_changed_dimension_invalid"],
      [
        { rolledBackDimensionId: "state" },
        "state_rolled_back_dimension_invalid",
      ],
      [{ nameDimensionId: "nope" }, "state_dimension_unknown"],
    ];
    for (const [extra, code] of cases) {
      const response = await save([stateWidget({ binding: binding(extra) })]);
      expect(response.statusCode, JSON.stringify(extra)).toBe(400);
      expect(response.json().error, JSON.stringify(extra)).toBe(code);
    }
    // A boolean health flag is a valid state.
    await saved([
      stateWidget({ binding: binding({ stateDimensionId: "healthy" }) }),
    ]);
  });

  it("lists every item normalized, not healthy first, with the changed time", async () => {
    const dashboard = await saved([stateWidget()]);
    const { states } = await data(dashboard.id);
    expect(states).toHaveLength(1);
    const [list] = states;
    expect(list).toMatchObject({ status: "ok", total: 6, error: null });
    expect(list!.items).toEqual([
      // "degraded" is no built-in word: unknown, until mapped.
      {
        name: "api",
        state: "failed",
        rolledBack: false,
        changedAt: "2026-11-10T09:30:00.000Z",
        value: "FAILED",
      },
      {
        name: "db",
        state: "unknown",
        rolledBack: false,
        changedAt: null,
        value: "degraded",
      },
      {
        name: "worker",
        state: "building",
        rolledBack: false,
        changedAt: null,
        value: "building",
      },
      // Rolled back is a qualifier on up only.
      {
        name: "cron",
        state: "sleeping",
        rolledBack: false,
        changedAt: null,
        value: "sleeping",
      },
      {
        name: "site",
        state: "up",
        rolledBack: true,
        changedAt: "2026-11-08T12:00:00.000Z",
        value: "READY",
      },
      {
        name: "web",
        state: "up",
        rolledBack: false,
        changedAt: "2026-11-09T08:00:00.000Z",
        value: "up",
      },
    ]);
  });

  it("applies the widget's own state mapping and bounds the list", async () => {
    const dashboard = await saved([
      stateWidget({ options: { limit: 2, states: { Degraded: "down" } } }),
    ]);
    const [list] = (await data(dashboard.id)).states;
    expect(names(list!.items)).toEqual(["db", "api"]);
    expect(list!.items[0]!.state).toBe("down");
    expect(list!.total).toBe(6);
  });

  it("reads a boolean health flag as up or down", async () => {
    const dashboard = await saved([
      stateWidget({
        binding: binding({
          stateDimensionId: "healthy",
          rolledBackDimensionId: undefined,
          changedAtDimensionId: undefined,
        }),
      }),
    ]);
    const [list] = (await data(dashboard.id)).states;
    expect(list!.items.map((item) => `${item.name}:${item.state}`)).toEqual([
      "api:down",
      "db:down",
      "cron:up",
      "site:up",
      "web:up",
      "worker:up",
    ]);
    expect(list!.items.every((item) => item.changedAt === null)).toBe(true);
  });

  it("shows the chosen item, or the most urgent one, in the single form", async () => {
    const dashboard = await saved([
      stateWidget({ options: { layout: "single", item: "site" } }),
      stateWidget({ x: 4, options: { layout: "single" } }),
      stateWidget({ x: 8, options: { layout: "single", item: "gone" } }),
    ]);
    const [chosen, worst, gone] = (await data(dashboard.id)).states;
    expect(chosen!.items).toEqual([
      expect.objectContaining({ name: "site", state: "up", rolledBack: true }),
    ]);
    expect(chosen!.total).toBe(1);
    expect(names(worst!.items)).toEqual(["api"]);
    expect(worst!.total).toBe(6);
    expect(gone).toMatchObject({ status: "no_data", items: [], total: 0 });
  });

  it("follows a dashboard filter and a slide's project scope", async () => {
    const dashboard = await saved([stateWidget()], [projectFilter()]);
    const [blog] = (
      await data(dashboard.id, {
        project: { kind: "values", values: ["blog"] },
      })
    ).states;
    expect(names(blog!.items)).toEqual(["db", "cron", "site"]);
    const scoped = await saved([stateWidget()], [projectFilter()], {
      scope: { project: { kind: "values", values: ["shop"] } },
    });
    const [shop] = (await data(scoped.id)).states;
    expect(names(shop!.items)).toEqual(["api", "worker", "web"]);
  });

  it("refuses a filter the widget neither maps nor excludes", async () => {
    // Mapped to another model only.
    const other = await f.publishModel("Other photos");
    const elsewhere = {
      ...projectFilter(),
      mappings: [{ modelId: other, dimensionId: "team" }],
    };
    const response = await save([stateWidget()], [elsewhere]);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("dashboard_filter_not_applicable");
    await saved(
      [
        stateWidget({
          binding: binding({
            exclusions: [{ filterId: "project", reason: "Every project" }],
          }),
        }),
      ],
      [elsewhere],
    );
  });

  it("previews an unsaved widget", async () => {
    const response = await f.call("POST", "/dashboards/data/preview", {
      filters: [],
      widgets: [],
      states: [
        {
          id: "00000000-0000-4000-8000-000000000875",
          binding: binding({ exclusions: [] }),
          options: {
            layout: "list",
            item: null,
            limit: 3,
            showChanged: true,
            states: {},
          },
        },
      ],
    });
    expect(response.statusCode, response.body).toBe(200);
    const [preview] = dashboardDataResponseSchema.parse(response.json()).states;
    expect(names(preview!.items)).toEqual(["api", "db", "worker"]);
    expect(preview!.total).toBe(6);
  });

  it("answers no_data with the code when the model is gone, never failing the dashboard", async () => {
    const dashboard = await saved([stateWidget()]);
    await f.admin`update data_models set published_version = null
      where id = ${modelId}`;
    try {
      const [list] = (await data(dashboard.id)).states;
      expect(list).toMatchObject({
        status: "no_data",
        items: [],
        total: 0,
        error: "data_model_not_published",
      });
    } finally {
      await f.admin`update data_models set published_version = 1
        where id = ${modelId}`;
    }
  });
});

describe("stateItemsOf (#875)", () => {
  it("cuts long names and keeps the source value", () => {
    const [item] = stateItemsOf(
      [{ dimensions: { n: "x".repeat(300), s: "Running" } }],
      {
        modelId: "m",
        nameDimensionId: "n",
        stateDimensionId: "s",
        exclusions: [],
      },
      { states: {} },
    );
    expect(item!.name).toHaveLength(200);
    expect(item!.name!.endsWith("…")).toBe(true);
    expect(item).toMatchObject({
      state: "up",
      value: "Running",
      changedAt: null,
      rolledBack: false,
    });
  });
});

describe("the state widget on screens (#875)", () => {
  let dashboardId: string;
  let widgetId: string;
  let all: { token: string; deviceId: string };
  let blog: { token: string; deviceId: string };

  type Payload = {
    version?: string;
    slides: Array<{ widgets: Array<Record<string, unknown>> }>;
  };
  async function payload(token: string, query: string): Promise<Payload> {
    const response = await f.app.inject({
      method: "GET",
      url: `/v1/device/dashboard${query}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    if (query.includes("schema=3"))
      expect(deviceDashboardV3ResponseSchema.parse(body)).toEqual(body);
    else expect(deviceDashboardV2ResponseSchema.parse(body)).toEqual(body);
    return body as Payload;
  }
  const widgetOf = (body: Payload) =>
    body.slides[0]!.widgets.find((widget) => widget.id === widgetId)!;

  beforeAll(async () => {
    const dashboard = await saved(
      [
        stateWidget({
          title: "Services",
          options: { limit: 3, states: { degraded: "down" } },
        }),
      ],
      [projectFilter()],
    );
    dashboardId = dashboard.id;
    widgetId = dashboard.slides[0]!.widgets[0]!.id;
    all = await f.pairScreen(dashboardId);
    blog = await f.pairScreen(dashboardId);
    await f.admin`
      update devices set scope = ${f.admin.json({
        dashboardId,
        values: { project: { kind: "values", values: ["blog"] } },
      })}
      where id = ${blog.deviceId}`;
  });

  it("sends the state widget to clients with features=state, the mapping kept on the server", async () => {
    for (const schema of ["2", "3"]) {
      const body = await payload(
        all.token,
        `?schema=${schema}&features=measure_split,items,state`,
      );
      const widget = widgetOf(body);
      expect(widget).toMatchObject({
        type: "state",
        label: "Services",
        options: { layout: "list", item: null, limit: 3, showChanged: true },
        data: {
          status: "ok",
          total: 6,
          items: [
            {
              name: "db",
              state: "down",
              rolledBack: false,
              changedAt: null,
            },
            {
              name: "api",
              state: "failed",
              rolledBack: false,
              changedAt: "2026-11-10T09:30:00.000Z",
            },
            {
              name: "worker",
              state: "building",
              rolledBack: false,
              changedAt: null,
            },
          ],
        },
      });
      expect(widget.options).not.toHaveProperty("states");
      expect((widget.data as { items: object[] }).items[0]).not.toHaveProperty(
        "value",
      );
      if (schema === "3") expect(widget.min).toEqual({ w: 3, h: 2 });
    }
  });

  it("gives older clients a text in its place, with its own ETag", async () => {
    const body = await payload(
      all.token,
      "?schema=3&features=measure_split,items",
    );
    const widget = widgetOf(body);
    expect(widget).toMatchObject({
      type: "text",
      label: "Services",
      text: "Update netrics TV to show the status.",
    });
    const etag = async (query: string) =>
      (
        await f.app.inject({
          method: "GET",
          url: `/v1/device/dashboard${query}`,
          headers: { authorization: `Bearer ${all.token}` },
        })
      ).headers.etag;
    expect(await etag("?schema=3&features=state")).not.toBe(
      await etag("?schema=3"),
    );
    // Schema 2 alike, with a suffixed version.
    const v2 = await payload(all.token, "?schema=2");
    expect(widgetOf(v2).type).toBe("text");
    expect(v2.version).toMatch(/-nostate$/);
    expect(
      (await payload(all.token, "?schema=2&features=state")).version,
    ).not.toMatch(/-nostate$/);
  });

  it("words the placeholder in German for a German screen language", async () => {
    await f.admin`update workspaces set screen_locale = 'de'
      where id = ${f.workspaceId}`;
    try {
      const body = await payload(all.token, "?schema=3");
      expect(widgetOf(body).text).toBe(
        "Aktualisiere netrics TV, um den Status zu sehen.",
      );
    } finally {
      await f.admin`update workspaces set screen_locale = null
        where id = ${f.workspaceId}`;
    }
  });

  it("follows a screen's fixed scope", async () => {
    const body = await payload(blog.token, "?schema=3&features=state");
    const data = widgetOf(body).data as {
      items: Array<{ name: string }>;
      total: number;
    };
    expect(data.items.map((item) => item.name)).toEqual(["db", "cron", "site"]);
    expect(data.total).toBe(3);
  });
});
