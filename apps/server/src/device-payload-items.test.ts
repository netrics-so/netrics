import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dashboardResponseSchema,
  deviceDashboardV2ResponseSchema,
  deviceDashboardV3ResponseSchema,
  workspaceResponseSchema,
} from "@netrics/contracts";

import {
  deviceItemImageIds,
  createDeviceItemImages,
} from "./devices/item-images.js";
import { createDeviceImageService } from "./images/service.js";
import {
  createItemsFixture,
  photoUrl,
  type ItemsFixture,
} from "./test-items.js";

// The latest-items widget on screens (#810): sent only to clients that ask
// with `features=items`, with its images in `images`; older clients get a
// text placeholder and none of its images. A device fetches an item image
// only while its own current payload references it.

let f: ItemsFixture;
let imageF: string, imageE: string, imageX: string, foreignImage: string;
let itemsWidgetId: string;
let dashboardId: string;
/** Unscoped and red-team screens on the items dashboard; one elsewhere. */
let all: { token: string; deviceId: string };
let red: { token: string; deviceId: string };
let other: { token: string; deviceId: string };

type Widget = {
  id: string;
  type: string;
  text?: string;
  label?: string | null;
  data?: { items: Array<{ title: string | null; imageId: string | null }> };
};
type Payload = {
  version?: string;
  images: Array<{ id: string; url: string }>;
  slides: Array<{ widgets: Widget[] }>;
};

async function deviceDashboard(
  token: string,
  query: string,
  headers: Record<string, string> = {},
) {
  const response = await f.app.inject({
    method: "GET",
    url: `/v1/device/dashboard${query}`,
    headers: { authorization: `Bearer ${token}`, ...headers },
  });
  return response;
}

async function payload(token: string, query: string): Promise<Payload> {
  const response = await deviceDashboard(token, query);
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json();
  if (query.includes("schema=3"))
    expect(deviceDashboardV3ResponseSchema.parse(body)).toEqual(body);
  else expect(deviceDashboardV2ResponseSchema.parse(body)).toEqual(body);
  return body as Payload;
}

const deviceImage = (token: string, imageId: string) =>
  f.app.inject({
    method: "GET",
    url: `/v1/device/images/${imageId}`,
    headers: { authorization: `Bearer ${token}` },
  });

const itemsOf = (body: Payload) =>
  body.slides[0]!.widgets.find((widget) => widget.id === itemsWidgetId)!;

beforeAll(async () => {
  f = await createItemsFixture("device-items");
  imageF = (await f.storeImage(photoUrl("f"))).id;
  imageE = (await f.storeImage(photoUrl("e"))).id;
  // Stored for a URL that no model row names (another stream).
  imageX = (await f.storeImage("https://img.example/other/x.png")).id;
  const stranger = await f.signUp("device-items-stranger@example.com");
  const created = await f.call(
    "POST",
    "/v1/workspaces",
    { name: "Stranger" },
    stranger,
  );
  const strangerWorkspace = workspaceResponseSchema.parse(created.json())
    .workspace.id;
  foreignImage = (await f.storeImage(photoUrl("f"), strangerWorkspace)).id;
  const filter = {
    id: "team",
    name: "Team",
    type: "string",
    mode: "values",
    mappings: [{ modelId: f.modelId, dimensionId: "team" }],
    defaultValue: null,
  };
  const saved = await f.call("POST", "/dashboards", {
    name: "Photos",
    settings: { dataFilters: [filter] },
    slides: [
      {
        widgets: [
          {
            type: "items",
            x: 0,
            y: 0,
            w: 6,
            h: 4,
            title: "Photos",
            binding: {
              modelId: f.modelId,
              imageDimensionId: "photo",
              titleDimensionId: "title",
              timeDimensionId: "taken_at",
            },
            options: { count: 3 },
          },
          { type: "text", x: 6, y: 0, w: 3, h: 2, text: "Hello" },
        ],
      },
    ],
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const dashboard = dashboardResponseSchema.parse(saved.json()).dashboard;
  itemsWidgetId = dashboard.slides[0]!.widgets[0]!.id;
  dashboardId = dashboard.id;
  const plain = await f.call("POST", "/dashboards", {
    name: "Plain",
    slides: [{ widgets: [{ type: "clock", x: 0, y: 0, w: 2, h: 1 }] }],
  });
  expect(plain.statusCode, plain.body).toBe(200);
  all = await f.pairScreen(dashboard.id);
  red = await f.pairScreen(dashboard.id);
  other = await f.pairScreen(
    dashboardResponseSchema.parse(plain.json()).dashboard.id,
  );
  await f.admin`
    update devices set scope = ${f.admin.json({
      dashboardId: dashboard.id,
      values: { team: { kind: "values", values: ["red"] } },
    })}
    where id = ${red.deviceId}`;
}, 120_000);

afterAll(async () => {
  await f?.close();
});

describe("latest items on screens (#810)", () => {
  it("sends the items widget with image references to clients with features=items", async () => {
    const body = await payload(
      all.token,
      "?schema=3&features=measure_split,items",
    );
    const widget = itemsOf(body);
    expect(widget).toMatchObject({ type: "items", label: "Photos" });
    expect(widget.data!.items[0]).toEqual({
      title: "f",
      subtitle: null,
      time: "2026-11-06",
      imageId: imageF,
    });
    expect(widget.data!.items.map((item) => item.imageId)).toEqual([
      imageF,
      imageE,
      null,
    ]);
    expect(body.images.map((image) => image.id).sort()).toEqual(
      [imageE, imageF].sort(),
    );
    expect(JSON.stringify(body)).not.toContain("img.example");
  });

  it("older clients get a placeholder and no item images", async () => {
    const body = await payload(all.token, "?schema=3&features=measure_split");
    expect(itemsOf(body)).toMatchObject({
      type: "text",
      label: "Photos",
      text: "Update netrics TV to show the latest items.",
    });
    expect(body.images.map((image) => image.id)).not.toContain(imageE);
    expect(body.images).toEqual([]);
    const full = await deviceDashboard(
      all.token,
      "?schema=3&features=measure_split,items",
    );
    const older = await deviceDashboard(all.token, "?schema=3");
    expect(older.headers.etag).not.toBe(full.headers.etag);
    // Schema 2 alike, with a suffixed version.
    const v2 = await payload(all.token, "?schema=2");
    expect(itemsOf(v2).type).toBe("text");
    expect(v2.version).toMatch(/-noitems$/);
    expect(
      (await payload(all.token, "?schema=2&features=items")).version,
    ).not.toMatch(/-noitems$/);
  });

  it("words the placeholder in German for a German screen language", async () => {
    await f.admin`update workspaces set screen_locale = 'de'
      where id = ${f.workspaceId}`;
    try {
      const body = await payload(all.token, "?schema=3");
      expect(itemsOf(body).text).toBe(
        "Aktualisiere netrics TV, um die neuesten Einträge zu sehen.",
      );
    } finally {
      await f.admin`update workspaces set screen_locale = null
        where id = ${f.workspaceId}`;
    }
  });

  it("applies the screen's fixed scope to the items", async () => {
    const body = await payload(red.token, "?schema=3&features=items");
    expect(itemsOf(body).data!.items.map((item) => item.title)).toEqual([
      "e",
      "c",
      "a",
    ]);
    expect(body.images.map((image) => image.id)).toEqual([imageE]);
  });

  it("serves an item image to the device and 404s it for a device on another dashboard", async () => {
    expect((await deviceImage(all.token, imageE)).statusCode).toBe(200);
    expect((await deviceImage(other.token, imageE)).statusCode).toBe(404);
  });

  it("404s a custom_api image of the same workspace that the device's own payload does not reference", async () => {
    expect((await deviceImage(all.token, imageX)).statusCode).toBe(404);
    // Filtered out by the red screen's scope, shown on the unscoped one.
    expect((await deviceImage(red.token, imageF)).statusCode).toBe(404);
    expect((await deviceImage(all.token, imageF)).statusCode).toBe(200);
    // Another workspace's image of the same URL is never found.
    expect((await deviceImage(all.token, foreignImage)).statusCode).toBe(404);
  });

  it("keeps the payload ETag stable when nothing changed", async () => {
    const query = "?schema=3&features=measure_split,items";
    const first = await deviceDashboard(all.token, query);
    const second = await deviceDashboard(all.token, query, {
      "if-none-match": first.headers.etag as string,
    });
    expect(second.statusCode).toBe(304);
  });
});

describe("the device image route's cost and edges (#810)", () => {
  const counted = (clock: { at: number }) => {
    const calls: string[] = [];
    const service = createDeviceImageService({
      db: f.db,
      itemImages: createDeviceItemImages({
        ttlMs: 10_000,
        clock: () => clock.at,
        compute: (...args) => {
          calls.push(args[2].id);
          return deviceItemImageIds(...args);
        },
      }),
    });
    return { service, calls };
  };
  const principal = () => ({
    workspaceId: f.workspaceId,
    deviceId: all.deviceId,
  });

  it("does not reuse an answer whose items query failed", async () => {
    const clock = { at: 1_000 };
    const calls: string[] = [];
    const service = createDeviceImageService({
      db: f.db,
      itemImages: createDeviceItemImages({
        ttlMs: 10_000,
        clock: () => clock.at,
        compute: (...args) => {
          calls.push(args[2].id);
          // The first items query fails as a timeout would: no images.
          return calls.length === 1
            ? Promise.resolve({ ids: new Set<string>(), complete: false })
            : deviceItemImageIds(...args);
        },
      }),
    });
    expect(await service.read(principal(), imageF, undefined)).toMatchObject({
      ok: false,
      status: 404,
    });
    clock.at += 1;
    expect((await service.read(principal(), imageF, undefined)).ok).toBe(true);
    expect(calls).toEqual([all.deviceId, all.deviceId]);
  });

  it("runs no items query for a wrong version", async () => {
    const { service, calls } = counted({ at: 0 });
    const wrong = await service.read(principal(), imageF, "0".repeat(64));
    expect(wrong).toMatchObject({ ok: false, status: 404 });
    expect(calls).toEqual([]);
  });

  it("reuses one device's answer within the TTL", async () => {
    const clock = { at: 1_000 };
    const { service, calls } = counted(clock);
    expect((await service.read(principal(), imageF, undefined)).ok).toBe(true);
    clock.at += 9_999;
    expect((await service.read(principal(), imageE, undefined)).ok).toBe(true);
    expect(calls).toEqual([all.deviceId]);
    clock.at += 1;
    expect((await service.read(principal(), imageF, undefined)).ok).toBe(true);
    expect(calls).toEqual([all.deviceId, all.deviceId]);
  });

  it("refuses an unassigned device and a revoked one", async () => {
    const unassigned = await f.pairScreen(null);
    expect((await deviceImage(unassigned.token, imageF)).statusCode).toBe(404);
    const revoked = await f.pairScreen(dashboardId);
    expect((await deviceImage(revoked.token, imageF)).statusCode).toBe(200);
    // Revoked as the owner does it: its tokens go with it.
    const revoke = await f.call("POST", `/devices/${revoked.deviceId}/revoke`);
    expect(revoke.statusCode, revoke.body).toBe(200);
    expect((await deviceImage(revoked.token, imageF)).statusCode).toBe(401);
    // Defence in depth: the service answers none for a revoked device
    // even without the token check, and runs no query.
    const { service, calls } = counted({ at: 0 });
    expect(
      await service.read(
        { workspaceId: f.workspaceId, deviceId: revoked.deviceId },
        imageF,
        undefined,
      ),
    ).toMatchObject({ ok: false, status: 404 });
    expect(calls).toEqual([]);
  });

  it("reuses an answer with a permanently broken items widget within the TTL", async () => {
    const widget = (titleDimensionId: string, x: number) => ({
      type: "items",
      x,
      y: 0,
      w: 6,
      h: 4,
      binding: {
        modelId: f.modelId,
        imageDimensionId: "photo",
        titleDimensionId,
        timeDimensionId: "taken_at",
      },
      options: { count: 3 },
    });
    const created = await f.call("POST", "/dashboards", {
      name: "One broken items widget",
      slides: [{ widgets: [widget("title", 0), widget("title", 6)] }],
    });
    expect(created.statusCode, created.body).toBe(200);
    const dashboard = dashboardResponseSchema.parse(created.json()).dashboard;
    // The second widget names a dimension its model no longer has: it
    // fails on every query, not now and then.
    await f.admin`update dashboard_widgets
      set model_binding = jsonb_set(model_binding, '{titleDimensionId}',
        '"no_such_dimension"')
      where id = ${dashboard.slides[0]!.widgets[1]!.id}`;
    const screen = await f.pairScreen(dashboard.id);
    const clock = { at: 1_000 };
    const calls: string[] = [];
    const service = createDeviceImageService({
      db: f.db,
      itemImages: createDeviceItemImages({
        ttlMs: 10_000,
        clock: () => clock.at,
        compute: (...args) => {
          calls.push(args[2].id);
          return deviceItemImageIds(...args);
        },
      }),
    });
    const principal = {
      workspaceId: f.workspaceId,
      deviceId: screen.deviceId,
    };
    expect((await service.read(principal, imageF, undefined)).ok).toBe(true);
    clock.at += 1;
    expect((await service.read(principal, imageE, undefined)).ok).toBe(true);
    expect(calls).toEqual([screen.deviceId]);
  });

  it("serves nothing for an items widget on a disabled slide", async () => {
    const created = await f.call("POST", "/dashboards", {
      name: "Disabled items",
      slides: [
        { widgets: [{ type: "clock", x: 0, y: 0, w: 2, h: 1 }] },
        {
          enabled: false,
          widgets: [
            {
              type: "items",
              x: 0,
              y: 0,
              w: 6,
              h: 4,
              binding: {
                modelId: f.modelId,
                imageDimensionId: "photo",
                titleDimensionId: "title",
                timeDimensionId: "taken_at",
              },
              options: { count: 3 },
            },
          ],
        },
      ],
    });
    expect(created.statusCode, created.body).toBe(200);
    const screen = await f.pairScreen(
      dashboardResponseSchema.parse(created.json()).dashboard.id,
    );
    const body = await payload(screen.token, "?schema=3&features=items");
    expect(
      body.slides.flatMap((slide) => slide.widgets.map((w) => w.type)),
    ).not.toContain("items");
    expect((await deviceImage(screen.token, imageF)).statusCode).toBe(404);
  });
});

// Last: these change the photos and the stored images.
describe("item images that leave the payload (#810)", () => {
  it("stops serving an item image once it leaves the device's payload", async () => {
    // Three newer photos push e and f out of the newest three.
    await f.writePhotos(
      ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((id, index) => ({
        id,
        team: index % 2 ? "blue" : "red",
        day: `2026-11-0${index + 1}`,
      })),
    );
    const body = await payload(all.token, "?schema=3&features=items");
    expect(itemsOf(body).data!.items.map((item) => item.title)).toEqual([
      "i",
      "h",
      "g",
    ]);
    expect((await deviceImage(all.token, imageE)).statusCode).toBe(404);
    expect((await deviceImage(all.token, imageF)).statusCode).toBe(404);
  });

  it("shows a pruned lookup's item without an image and 404s it", async () => {
    const imageG = await f.storeImage(photoUrl("g"));
    const served = await payload(all.token, "?schema=3&features=items");
    expect(itemsOf(served).data!.items[2]).toMatchObject({
      title: "g",
      imageId: imageG.id,
    });
    expect((await deviceImage(all.token, imageG.id)).statusCode).toBe(200);
    // The prune deletes lookups first; the image row may stay a while.
    await f.admin`delete from custom_api_item_images
      where image_id = ${imageG.id}`;
    const pruned = await payload(all.token, "?schema=3&features=items");
    expect(itemsOf(pruned).data!.items[2]).toMatchObject({
      title: "g",
      imageId: null,
    });
    expect(pruned.images.map((image) => image.id)).not.toContain(imageG.id);
    expect((await deviceImage(all.token, imageG.id)).statusCode).toBe(404);
  });
});
