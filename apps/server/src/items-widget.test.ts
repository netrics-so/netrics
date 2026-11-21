import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dashboardDataResponseSchema,
  dashboardResponseSchema,
  publishedModelCatalogSchema,
} from "@netrics/contracts";

import {
  createItemsFixture,
  photoUrl,
  type ItemsFixture,
} from "./test-items.js";

// The latest-items widget (#810): saved like a measure widget, bound to a
// published model with an image dimension. Its data is the model's newest
// items, newest first, each with a stored image reference (never the URL).

let f: ItemsFixture;
let imageF: string, imageE: string;

const binding = (extra: Record<string, unknown> = {}) => ({
  modelId: f.modelId,
  imageDimensionId: "photo",
  titleDimensionId: "title",
  timeDimensionId: "taken_at",
  ...extra,
});

const teamFilter = (modelId = f.modelId) => ({
  id: "team",
  name: "Team",
  type: "string",
  mode: "values",
  mappings: [{ modelId, dimensionId: "team" }],
  defaultValue: null,
});

const itemsWidget = (extra: Record<string, unknown> = {}) => ({
  type: "items",
  x: 0,
  y: 0,
  w: 6,
  h: 4,
  binding: binding(),
  options: { count: 3 },
  ...extra,
});

function save(widgets: unknown[], dataFilters: unknown[] = []) {
  return f.call("POST", "/dashboards", {
    name: "Photos",
    settings: { dataFilters },
    slides: [{ widgets }],
  });
}

async function saved(widgets: unknown[], dataFilters: unknown[] = []) {
  const response = await save(widgets, dataFilters);
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

beforeAll(async () => {
  f = await createItemsFixture("items-widget");
  // Stored after a sync: the newest two of the six photos.
  imageF = (await f.storeImage(photoUrl("f"))).id;
  imageE = (await f.storeImage(photoUrl("e"))).id;
}, 120_000);

afterAll(async () => {
  await f?.close();
});

describe("latest items widget (#810)", () => {
  it("saves an items widget and reads it back", async () => {
    const dashboard = await saved([itemsWidget({ title: "Photos" })]);
    const widget = dashboard.slides[0]!.widgets[0]!;
    expect(widget).toMatchObject({
      type: "items",
      title: "Photos",
      binding: { ...binding(), exclusions: [] },
      options: {
        layout: "grid",
        count: 3,
        rotateSeconds: 8,
        imageFit: "cover",
        showTime: true,
      },
    });
    const read = await f.call("GET", `/dashboards/${dashboard.id}`);
    expect(
      dashboardResponseSchema.parse(read.json()).dashboard.slides[0]!
        .widgets[0],
    ).toEqual(widget);
  });

  it("refuses an image dimension whose field has no image role", async () => {
    const response = await save([
      itemsWidget({ binding: binding({ imageDimensionId: "title" }) }),
    ]);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "items_image_dimension_invalid" });
  });

  it("refuses a time that is not a date and a dimension the model lacks", async () => {
    const time = await save([
      itemsWidget({ binding: binding({ timeDimensionId: "title" }) }),
    ]);
    expect(time.json()).toEqual({ error: "items_time_dimension_invalid" });
    const unknown = await save([
      itemsWidget({ binding: binding({ subtitleDimensionId: "nope" }) }),
    ]);
    expect(unknown.json()).toEqual({ error: "items_dimension_unknown" });
  });

  it("refuses a filter neither mapped nor excluded", async () => {
    const other = await f.publishModel("Other photos");
    const response = await save([itemsWidget()], [teamFilter(other)]);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "dashboard_filter_not_applicable",
    });
  });

  it("answers the newest items first with stored image references and never the URL", async () => {
    const dashboard = await saved([itemsWidget()]);
    const body = await data(dashboard.id);
    expect(body.widgets).toEqual([]);
    const items = body.items[0]!;
    expect(items.status).toBe("ok");
    expect(items.items.map((item) => item.title)).toEqual(["f", "e", "d"]);
    expect(items.items[0]).toEqual({
      title: "f",
      subtitle: null,
      time: "2026-11-06",
      image: {
        id: imageF,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        width: 1,
        height: 1,
      },
    });
    expect(items.items[1]!.image!.id).toBe(imageE);
    expect(JSON.stringify(body)).not.toContain("https://");
    expect(JSON.stringify(body)).not.toContain("img.example");
  });

  it("shows items outside the stored newest N without an image", async () => {
    const dashboard = await saved([itemsWidget({ options: { count: 6 } })]);
    const items = (await data(dashboard.id)).items[0]!.items;
    expect(items.map((item) => item.title)).toEqual([
      "f",
      "e",
      "d",
      "c",
      "b",
      "a",
    ]);
    expect(items.slice(2).every((item) => item.image === null)).toBe(true);
  });

  it("applies a dashboard filter mapped to the model", async () => {
    const dashboard = await saved([itemsWidget()], [teamFilter()]);
    const body = await data(dashboard.id, {
      team: { kind: "values", values: ["red"] },
    });
    expect(body.items[0]!.items.map((item) => item.title)).toEqual([
      "e",
      "c",
      "a",
    ]);
    // Excluded, the filter is ignored and listed.
    const excluded = await saved(
      [
        itemsWidget({
          binding: binding({
            exclusions: [{ filterId: "team", reason: "Every team" }],
          }),
        }),
      ],
      [teamFilter()],
    );
    const all = await data(excluded.id, {
      team: { kind: "values", values: ["red"] },
    });
    expect(all.items[0]!.items.map((item) => item.title)).toEqual([
      "f",
      "e",
      "d",
    ]);
    expect(all.items[0]!.exclusions).toEqual([
      { filterId: "team", reason: "Every team" },
    ]);
  });

  it("returns no_data with a code for an unpublished model instead of failing the dashboard", async () => {
    const other = await f.publishModel("Unpublished soon");
    const dashboard = await saved([
      itemsWidget({ binding: binding({ modelId: other }) }),
    ]);
    await f.admin`update data_models set published_version = null
      where id = ${other}`;
    const body = await data(dashboard.id);
    expect(body.items[0]).toMatchObject({
      status: "no_data",
      items: [],
      error: "data_model_not_published",
    });
  });

  it("previews an unsaved items widget", async () => {
    const id = "00000000-0000-4000-8000-0000000000aa";
    const response = await f.call("POST", "/dashboards/data/preview", {
      filters: [],
      widgets: [],
      items: [{ id, binding: binding(), options: { count: 2 } }],
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = dashboardDataResponseSchema.parse(response.json());
    expect(body.items[0]!.widgetId).toBe(id);
    expect(body.items[0]!.items.map((item) => item.title)).toEqual(["f", "e"]);
  });

  it("lists role image on the published model's dimensions", async () => {
    const response = await f.call("GET", "/dashboards/published-models");
    const catalog = publishedModelCatalogSchema.parse(response.json());
    const model = catalog.models.find((model) => model.modelId === f.modelId)!;
    expect(model.dimensions.find((d) => d.id === "photo")).toEqual({
      id: "photo",
      name: "photo",
      type: "string",
      role: "image",
    });
    expect(
      model.dimensions.find((d) => d.id === "title")!.role,
    ).toBeUndefined();
  });
});
