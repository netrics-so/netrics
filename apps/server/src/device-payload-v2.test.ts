import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  deviceDashboardResponseSchema,
  deviceDashboardV2ResponseSchema,
  deviceDashboardV3ResponseSchema,
  type DeviceDashboardV2Response,
  type ImageContentType,
} from "@netrics/contracts";
import {
  createDatabase,
  createRawSqlClient,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";
import {
  BUILTIN_THEMES,
  STUDIO_MIN_WIDGET_SIZE,
  type Locale,
} from "@netrics/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildDeviceDashboard,
  buildDeviceDashboardV2,
  buildDeviceDashboardV3,
  withDevice,
} from "./devices/dashboard.js";
import { createDeviceService } from "./devices/service.js";
import { sanitizeImage } from "./images/format.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

// Device payload schema 2 (ADR 0015 section 7, #219) on a dashboard with
// every widget type, fixed ids and a pinned clock, so the payload is a
// stable snapshot. Schema 1 of the same dashboard is checked alongside.

const NOW = new Date("2026-10-04T10:00:00Z");

let testDb: TestDatabase;
let owner: Sql;
let db: Database;
let workspaceId: string;
let otherWorkspaceId: string;
let connectionId: string;

const id = (group: number, n: number) =>
  `${String(group).repeat(8)}-0000-4000-8000-${String(n).padStart(12, "0")}`;

const STUDIO = id(1, 0);
const CUSTOM = id(2, 0);
const EMPTY = id(3, 0);
const MAXIMAL = id(4, 0);
const OTHER = id(5, 0);
const IMAGES = {
  logo: id(6, 1),
  background: id(6, 2),
  widget: id(6, 3),
  unused: id(6, 4),
  disabledOnly: id(6, 5),
};
const THEME = id(7, 1);
const TABLES = id(9, 0);

const fixture = (name: string) =>
  readFileSync(path.join(import.meta.dirname, "images", "fixtures", name));

async function insertImage(imageId: string, file: string, type: string) {
  const image = sanitizeImage(type as ImageContentType, fixture(file));
  if (!image.ok) throw new Error(image.error);
  const sha256 = createHash("sha256").update(image.content).digest("hex");
  await owner`
    insert into workspace_images (id, workspace_id, name, content_type,
      bytes, width, height, sha256, content)
    values (${imageId}, ${workspaceId}, ${file}, ${type},
      ${image.content.length}, ${image.width}, ${image.height}, ${sha256},
      ${image.content})`;
}

async function insertDashboard(
  dashboardId: string,
  name: string,
  fields: Record<string, unknown> = {},
  workspace = workspaceId,
) {
  await owner`
    insert into dashboards ${owner({
      id: dashboardId,
      workspace_id: workspace,
      name,
      ...fields,
    })}`;
}

async function insertSlide(
  slideId: string,
  dashboardId: string,
  position: number,
  fields: Record<string, unknown> = {},
  workspace = workspaceId,
) {
  await owner`
    insert into dashboard_slides ${owner({
      id: slideId,
      dashboard_id: dashboardId,
      workspace_id: workspace,
      position,
      ...fields,
    })}`;
}

async function insertWidget(
  widgetId: string,
  slideId: string,
  dashboardId: string,
  fields: Record<string, unknown>,
  workspace = workspaceId,
) {
  const { options, dimensions, ...rest } = fields;
  await owner`
    insert into dashboard_widgets ${owner({
      id: widgetId,
      slide_id: slideId,
      dashboard_id: dashboardId,
      workspace_id: workspace,
      ...rest,
    })}`;
  await owner`
    update dashboard_widgets
    set options = ${owner.json((options ?? {}) as never)},
        dimensions = ${owner.json((dimensions ?? {}) as never)}
    where id = ${widgetId}`;
}

const downloads = (fields: Record<string, unknown> = {}) => ({
  connection_id: connectionId,
  metric_key: "snap.downloads",
  aggregation: "sum",
  period: "last_7_days",
  ...fields,
});

beforeAll(async () => {
  testDb = await createTestDatabase();
  owner = createRawSqlClient(testDb.adminUrl, {
    max: 1,
    onnotice: () => undefined,
  });
  await owner`insert into connectors (id, version, manifest) values
    ('snap', '1.0.0', ${owner.json({ id: "snap" })})`;
  await owner`
    insert into metric_definitions (connector_id, key, name, description,
      kind, unit, granularity, dimensions, aggregations)
    values
      ('snap', 'snap.downloads', 'Downloads', '', 'delta', 'count', 'day',
       '["resource"]', '["sum","avg","min","max"]'),
      ('snap', 'snap.proceeds', 'Proceeds', '', 'delta', 'currency_minor',
       'day', '["resource","currency"]', '["sum"]')`;
  const [workspace] = await owner`
    insert into workspaces (name, time_zone, display_currency)
    values ('W', 'Europe/Berlin', 'EUR') returning id`;
  workspaceId = workspace!.id as string;
  const [other] = await owner`
    insert into workspaces (name) values ('Other') returning id`;
  otherWorkspaceId = other!.id as string;
  const [connection] = await owner`
    insert into connections (workspace_id, connector_id, name)
    values (${workspaceId}, 'snap', 'Store') returning id`;
  connectionId = connection!.id as string;
  await owner`
    insert into connection_state (connection_id, workspace_id,
      last_success_at, poll_interval_seconds)
    values (${connectionId}, ${workspaceId}, '2026-10-04T09:55:00Z', 300)`;
  await owner`
    insert into connection_resources (connection_id, workspace_id,
      resource_id, name, kind)
    values (${connectionId}, ${workspaceId}, 'app-1', 'Wurfel', 'app'),
           (${connectionId}, ${workspaceId}, 'app-2', 'voilà', 'app'),
           (${connectionId}, ${workspaceId}, 'app-3', 'paperstand', 'app')`;
  // 14 days of downloads per app, so the previous week has data too.
  for (let day = 0; day < 14; day++) {
    const date = new Date(Date.UTC(2026, 8, 21 + day))
      .toISOString()
      .slice(0, 10);
    for (const [resource, factor] of [
      ["app-1", 10],
      ["app-2", 3],
      ["app-3", 1],
    ] as const) {
      await owner`
        insert into observations (workspace_id, connection_id,
          metric_definition_id, dimensions, source_timestamp, value)
        select ${workspaceId}, ${connectionId}, m.id,
               ${owner.json({ resource })}, ${`${date}T00:00:00Z`}::timestamptz,
               ${factor * (day + 1)}
        from metric_definitions m where m.key = 'snap.downloads'`;
    }
  }

  await insertImage(IMAGES.logo, "plain.png", "image/png");
  await insertImage(IMAGES.background, "plain.jpg", "image/jpeg");
  await insertImage(IMAGES.widget, "lossy.webp", "image/webp");
  await insertImage(IMAGES.unused, "lossless.webp", "image/webp");
  await insertImage(IMAGES.disabledOnly, "alpha.webp", "image/webp");

  // The studio dashboard: every widget type, a disabled slide, a brand.
  await insertDashboard(STUDIO, "Wurfel", {
    theme_builtin: "light",
    accent_color: "#c2410c",
    logo_image_id: IMAGES.logo,
    default_slide_seconds: 15,
    transition: "none",
  });
  const sales = id(1, 100);
  const hidden = id(1, 200);
  const third = id(1, 300);
  await insertSlide(sales, STUDIO, 0, {
    name: "Sales",
    background_image_id: IMAGES.background,
    background_dim: 40,
  });
  await insertSlide(hidden, STUDIO, 1, { name: "Hidden", enabled: false });
  await insertSlide(third, STUDIO, 2, { duration_seconds: 45 });
  await insertWidget(id(1, 101), sales, STUDIO, {
    type: "metric",
    x: 0,
    y: 0,
    w: 4,
    h: 3,
    ...downloads({ dimensions: { resource: "app-1" } }),
  });
  await insertWidget(id(1, 102), sales, STUDIO, {
    type: "line",
    x: 4,
    y: 0,
    w: 8,
    h: 3,
    title: "Downloads this week",
    ...downloads(),
    options: { showAxis: false },
  });
  await insertWidget(id(1, 103), sales, STUDIO, {
    type: "bar",
    x: 0,
    y: 3,
    w: 6,
    h: 5,
    ...downloads(),
    options: { groupBy: "resource", limit: 3 },
  });
  await insertWidget(id(1, 104), sales, STUDIO, {
    type: "image",
    x: 6,
    y: 3,
    w: 2,
    h: 2,
    image_id: IMAGES.widget,
    options: { fit: "cover" },
  });
  await insertWidget(id(1, 105), sales, STUDIO, {
    type: "text",
    x: 8,
    y: 3,
    w: 4,
    h: 2,
    text: "## Wurfel\nDaily **numbers**",
    options: { size: "heading" },
  });
  await insertWidget(id(1, 106), sales, STUDIO, {
    type: "clock",
    x: 6,
    y: 5,
    w: 3,
    h: 1,
    options: { hour12: true },
  });
  // Fails: proceeds have no average. It reports no_data on its own.
  await insertWidget(id(1, 107), sales, STUDIO, {
    type: "metric",
    x: 9,
    y: 5,
    w: 3,
    h: 2,
    connection_id: connectionId,
    metric_key: "snap.proceeds",
    aggregation: "avg",
    period: "today",
  });
  await insertWidget(id(1, 201), hidden, STUDIO, {
    type: "image",
    x: 0,
    y: 0,
    w: 2,
    h: 2,
    image_id: IMAGES.disabledOnly,
  });
  await insertWidget(id(1, 202), hidden, STUDIO, {
    type: "metric",
    x: 3,
    y: 0,
    w: 3,
    h: 2,
    ...downloads(),
  });
  await insertWidget(id(1, 301), third, STUDIO, {
    type: "metric",
    x: 0,
    y: 0,
    w: 3,
    h: 2,
    ...downloads({
      dimensions: { resource: "app-2" },
      period: "last_30_days",
    }),
    options: { showSparkline: false },
  });

  // A custom theme, no accent.
  const tokens = { ...BUILTIN_THEMES.midnight.tokens, accent: "#22d3ee" };
  await owner`
    insert into workspace_themes (id, workspace_id, name, base, tokens)
    values (${THEME}, ${workspaceId}, 'Night shift', 'midnight',
      ${owner.json(tokens)})`;
  await insertDashboard(CUSTOM, "Custom", {
    theme_builtin: null,
    theme_id: THEME,
    show_header: false,
    auto_advance: false,
  });
  await insertSlide(id(2, 100), CUSTOM, 0);
  await insertDashboard(EMPTY, "Empty");
  await insertSlide(id(3, 100), EMPTY, 0, { enabled: false });

  // The largest dashboard the limits allow, by bytes: 12 slides, 48 line
  // charts over 30 daily points and 144 texts of 500
  // characters.
  await insertDashboard(MAXIMAL, "Maximal");
  for (let slide = 0; slide < 12; slide++) {
    const slideId = id(4, 1000 + slide * 100);
    await insertSlide(slideId, MAXIMAL, slide, {
      name: "A".repeat(60),
      background_image_id: IMAGES.background,
      background_dim: 80,
    });
    for (let n = 0; n < 4; n++) {
      await insertWidget(id(4, 1000 + slide * 100 + n), slideId, MAXIMAL, {
        type: "line",
        x: (n % 3) * 4,
        y: n < 3 ? 0 : 3,
        w: 4,
        h: 3,
        title: "T".repeat(100),
        ...downloads({
          period: "last_30_days",
          dimensions: { resource: "app-1" },
        }),
      });
    }
    for (let n = 0; n < 12; n++) {
      await insertWidget(id(4, 1050 + slide * 100 + n), slideId, MAXIMAL, {
        type: "text",
        x: 4 + (n % 4) * 2,
        y: 3 + Math.floor(n / 4),
        w: 2,
        h: 1,
        title: "T".repeat(100),
        text: "**Wurfel** ".repeat(50).slice(0, 500),
      });
    }
  }

  // Tables (ADR 0019 section 6): with change and Others, and without.
  await insertDashboard(TABLES, "Tables");
  await insertSlide(id(9, 100), TABLES, 0);
  await insertWidget(id(9, 101), id(9, 100), TABLES, {
    type: "table",
    x: 0,
    y: 0,
    w: 6,
    h: 6,
    ...downloads(),
    options: { groupBy: "resource", limit: 3, showOthers: true },
  });
  await insertWidget(id(9, 102), id(9, 100), TABLES, {
    type: "table",
    x: 6,
    y: 0,
    w: 4,
    h: 4,
    title: "Top apps",
    ...downloads(),
    options: { groupBy: "resource", limit: 3, showChange: false },
  });

  await insertDashboard(OTHER, "Other", {}, otherWorkspaceId);
  await insertSlide(id(5, 100), OTHER, 0, {}, otherWorkspaceId);
  await insertWidget(
    id(5, 101),
    id(5, 100),
    OTHER,
    { type: "text", x: 0, y: 0, w: 2, h: 1, text: "Other workspace" },
    otherWorkspaceId,
  );

  db = createDatabase(testDb.appUrl, { max: 2 });
}, 120_000);

afterAll(async () => {
  await owner?.end({ timeout: 5 }).catch(() => undefined);
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
});

function v2(dashboardId: string | null, now = NOW, locale?: Locale) {
  return withWorkspace(db, { workspaceId }, (tx) =>
    buildDeviceDashboardV2(tx, workspaceId, dashboardId, {
      now,
      exchangeRates: true,
      ...(locale ? { locale } : {}),
    }),
  );
}

function v1(dashboardId: string | null, locale?: Locale) {
  return withWorkspace(db, { workspaceId }, (tx) =>
    buildDeviceDashboard(tx, workspaceId, dashboardId, {
      now: NOW,
      exchangeRates: true,
      ...(locale ? { locale } : {}),
    }),
  );
}

function widgetsOf(payload: DeviceDashboardV2Response) {
  return payload.slides.flatMap((slide) => slide.widgets);
}

describe("device payload schema 2", () => {
  it("carries every widget type with its data", async () => {
    const payload = deviceDashboardV2ResponseSchema.parse(await v2(STUDIO));
    expect(payload).toMatchInlineSnapshot(`
      {
        "dashboard": {
          "id": "11111111-0000-4000-8000-000000000000",
          "logo": {
            "imageId": "66666666-0000-4000-8000-000000000001",
          },
          "name": "Wurfel",
          "showHeader": true,
        },
        "grid": {
          "columns": 12,
          "rows": 8,
        },
        "images": [
          {
            "bytes": 165,
            "contentType": "image/png",
            "height": 16,
            "id": "66666666-0000-4000-8000-000000000001",
            "sha256": "d5347228a968bdfd92af52816b59c95e676d695558fb443200e38b398879e75d",
            "url": "/v1/device/images/66666666-0000-4000-8000-000000000001?v=d5347228a968bdfd92af52816b59c95e676d695558fb443200e38b398879e75d",
            "width": 24,
          },
          {
            "bytes": 752,
            "contentType": "image/jpeg",
            "height": 16,
            "id": "66666666-0000-4000-8000-000000000002",
            "sha256": "13e26cadec5da29b5473a551f5ddc2d27c5a313c78025767077f000563d8e6da",
            "url": "/v1/device/images/66666666-0000-4000-8000-000000000002?v=13e26cadec5da29b5473a551f5ddc2d27c5a313c78025767077f000563d8e6da",
            "width": 24,
          },
          {
            "bytes": 154,
            "contentType": "image/webp",
            "height": 16,
            "id": "66666666-0000-4000-8000-000000000003",
            "sha256": "8e19283bfaad3b0b51af7bf0b358a1da99d17aa0fc40a0fd2c709823cbb07531",
            "url": "/v1/device/images/66666666-0000-4000-8000-000000000003?v=8e19283bfaad3b0b51af7bf0b358a1da99d17aa0fc40a0fd2c709823cbb07531",
            "width": 24,
          },
        ],
        "locale": "en",
        "refreshAfterSec": 60,
        "rotation": {
          "autoAdvance": true,
          "transition": "none",
        },
        "schema": 2,
        "slides": [
          {
            "background": {
              "dim": 40,
              "imageId": "66666666-0000-4000-8000-000000000002",
            },
            "durationSec": 15,
            "id": "11111111-0000-4000-8000-000000000100",
            "name": "Sales",
            "widgets": [
              {
                "data": {
                  "aggregation": "sum",
                  "better": "higher",
                  "change": {
                    "delta": 490,
                    "previousValue": 280,
                    "ratio": 1.75,
                  },
                  "conversion": null,
                  "granularity": "day",
                  "kind": "delta",
                  "period": "last_7_days",
                  "spark": [
                    80,
                    90,
                    100,
                    110,
                    120,
                    130,
                    140,
                  ],
                  "status": "ok",
                  "unit": "count",
                  "updatedAt": "2026-10-04T09:55:00.000Z",
                  "value": 770,
                },
                "h": 3,
                "id": "11111111-0000-4000-8000-000000000101",
                "label": "Downloads · Wurfel",
                "options": {
                  "showChange": true,
                  "showSparkline": true,
                },
                "type": "metric",
                "w": 4,
                "x": 0,
                "y": 0,
              },
              {
                "data": {
                  "aggregation": "sum",
                  "better": "higher",
                  "buckets": [
                    "2026-09-28T00:00:00.000Z",
                    "2026-09-29T00:00:00.000Z",
                    "2026-09-30T00:00:00.000Z",
                    "2026-10-01T00:00:00.000Z",
                    "2026-10-02T00:00:00.000Z",
                    "2026-10-03T00:00:00.000Z",
                    "2026-10-04T00:00:00.000Z",
                  ],
                  "change": {
                    "delta": 686,
                    "previousValue": 392,
                    "ratio": 1.75,
                  },
                  "conversion": null,
                  "granularity": "day",
                  "kind": "delta",
                  "period": "last_7_days",
                  "previous": [
                    14,
                    28,
                    42,
                    56,
                    70,
                    84,
                    98,
                  ],
                  "status": "ok",
                  "unit": "count",
                  "updatedAt": "2026-10-04T09:55:00.000Z",
                  "value": 1078,
                  "values": [
                    112,
                    126,
                    140,
                    154,
                    168,
                    182,
                    196,
                  ],
                },
                "h": 3,
                "id": "11111111-0000-4000-8000-000000000102",
                "label": "Downloads this week",
                "options": {
                  "showAxis": false,
                  "showPrevious": true,
                },
                "type": "line",
                "w": 8,
                "x": 4,
                "y": 0,
              },
              {
                "data": {
                  "aggregation": "sum",
                  "bars": [
                    {
                      "key": "app-1",
                      "label": "Wurfel",
                      "value": 770,
                    },
                    {
                      "key": "app-2",
                      "label": "voilà",
                      "value": 231,
                    },
                    {
                      "key": "app-3",
                      "label": "paperstand",
                      "value": 77,
                    },
                  ],
                  "better": "higher",
                  "conversion": null,
                  "granularity": "day",
                  "groupBy": "resource",
                  "kind": "delta",
                  "others": null,
                  "period": "last_7_days",
                  "status": "ok",
                  "unit": "count",
                  "updatedAt": "2026-10-04T09:55:00.000Z",
                },
                "h": 5,
                "id": "11111111-0000-4000-8000-000000000103",
                "label": "Downloads · All resources",
                "options": {
                  "groupBy": "resource",
                  "limit": 3,
                },
                "type": "bar",
                "w": 6,
                "x": 0,
                "y": 3,
              },
              {
                "h": 2,
                "id": "11111111-0000-4000-8000-000000000104",
                "imageId": "66666666-0000-4000-8000-000000000003",
                "label": null,
                "options": {
                  "align": "center",
                  "fit": "cover",
                },
                "type": "image",
                "w": 2,
                "x": 6,
                "y": 3,
              },
              {
                "h": 2,
                "id": "11111111-0000-4000-8000-000000000105",
                "label": null,
                "options": {
                  "align": "start",
                  "size": "heading",
                },
                "text": "## Wurfel
      Daily **numbers**",
                "type": "text",
                "w": 4,
                "x": 8,
                "y": 3,
              },
              {
                "h": 1,
                "id": "11111111-0000-4000-8000-000000000106",
                "label": null,
                "options": {
                  "hour12": true,
                  "showDate": true,
                  "timeZone": "Europe/Berlin",
                },
                "type": "clock",
                "w": 3,
                "x": 6,
                "y": 5,
              },
              {
                "data": {
                  "aggregation": "avg",
                  "better": "higher",
                  "change": {
                    "delta": null,
                    "previousValue": null,
                    "ratio": null,
                  },
                  "conversion": null,
                  "granularity": null,
                  "kind": null,
                  "period": "today",
                  "spark": [],
                  "status": "no_data",
                  "unit": null,
                  "updatedAt": "2026-10-04T09:55:00.000Z",
                  "value": null,
                },
                "h": 2,
                "id": "11111111-0000-4000-8000-000000000107",
                "label": "snap.proceeds · All resources",
                "options": {
                  "showChange": true,
                  "showSparkline": true,
                },
                "type": "metric",
                "w": 3,
                "x": 9,
                "y": 5,
              },
            ],
          },
          {
            "background": null,
            "durationSec": 45,
            "id": "11111111-0000-4000-8000-000000000300",
            "name": null,
            "widgets": [
              {
                "data": {
                  "aggregation": "sum",
                  "better": "higher",
                  "change": {
                    "delta": null,
                    "previousValue": null,
                    "ratio": null,
                  },
                  "conversion": null,
                  "granularity": "day",
                  "kind": "delta",
                  "period": "last_30_days",
                  "spark": [
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    3,
                    6,
                    9,
                    12,
                    15,
                    18,
                    21,
                    24,
                    27,
                    30,
                    33,
                    36,
                    39,
                    42,
                  ],
                  "status": "ok",
                  "unit": "count",
                  "updatedAt": "2026-10-04T09:55:00.000Z",
                  "value": 315,
                },
                "h": 2,
                "id": "11111111-0000-4000-8000-000000000301",
                "label": "Downloads · voilà",
                "options": {
                  "showChange": true,
                  "showSparkline": false,
                },
                "type": "metric",
                "w": 3,
                "x": 0,
                "y": 0,
              },
            ],
          },
        ],
        "theme": {
          "name": "Light",
          "tokens": {
            "accent": "#c2410c",
            "background": "#eef0f3",
            "border": "#d5d9e0",
            "chartFill": "#9db6ee",
            "chartLine": "#7a828e",
            "down": "#c22f2f",
            "fontScale": 1,
            "label": "#343a44",
            "muted": "#5a616c",
            "surface": "#ffffff",
            "text": "#14171c",
            "up": "#1a7f37",
            "warning": "#8f5f00",
          },
        },
        "timeZone": "Europe/Berlin",
        "version": "vkS3519PLTrdKahmZu4VSTgmws72uAFK",
      }
    `);
  });

  it("matches its contract and keeps the version stable", async () => {
    const first = await v2(STUDIO);
    expect(deviceDashboardV2ResponseSchema.parse(first)).toEqual(first);
    expect((await v2(STUDIO)).version).toBe(first.version);
    // A different clock with the same data: same content, same version.
    expect((await v2(STUDIO, new Date("2026-10-04T10:00:30Z"))).version).toBe(
      first.version,
    );
  });

  it("sends the clock's long date and zone line only when set (ADR 0019 §9)", async () => {
    const before = await v2(STUDIO);
    const clockOf = (payload: DeviceDashboardV2Response) =>
      widgetsOf(payload).find((widget) => widget.id === id(1, 106))!;
    // Unset: the payload and its version are as before the options existed.
    expect(clockOf(before).options).not.toHaveProperty("dateStyle");
    expect(clockOf(before).options).not.toHaveProperty("showZone");
    const set = { hour12: true, dateStyle: "long", showZone: true };
    await owner`
      update dashboard_widgets set options = ${owner.json(set)}
      where id = ${id(1, 106)}`;
    try {
      const after = await v2(STUDIO);
      expect(clockOf(after).options).toEqual({
        showDate: true,
        hour12: true,
        timeZone: "Europe/Berlin",
        dateStyle: "long",
        showZone: true,
      });
      expect(after.version).not.toBe(before.version);
      expect(deviceDashboardV2ResponseSchema.parse(after)).toEqual(after);
    } finally {
      await owner`
        update dashboard_widgets set options = ${owner.json({ hour12: true })}
        where id = ${id(1, 106)}`;
    }
  });

  it("omits disabled slides and their images", async () => {
    const payload = await v2(STUDIO);
    expect(payload.slides.map((slide) => slide.name)).toEqual(["Sales", null]);
    const ids = widgetsOf(payload).map((widget) => widget.id);
    expect(ids).not.toContain(id(1, 201));
    expect(ids).not.toContain(id(1, 202));
    expect(payload.images.map((image) => image.id)).toEqual(
      [IMAGES.logo, IMAGES.background, IMAGES.widget].sort(),
    );
    for (const image of payload.images) {
      expect(image.url).toBe(`/v1/device/images/${image.id}?v=${image.sha256}`);
    }
  });

  it("resolves durations, the custom theme and the header", async () => {
    const studio = await v2(STUDIO);
    expect(studio.slides.map((slide) => slide.durationSec)).toEqual([15, 45]);
    expect(studio.theme.name).toBe("Light");
    expect(studio.theme.tokens).toEqual({
      ...BUILTIN_THEMES.light.tokens,
      accent: "#c2410c",
    });
    const custom = await v2(CUSTOM);
    expect(custom).toMatchObject({
      dashboard: { id: CUSTOM, showHeader: false, logo: null },
      theme: {
        name: "Night shift",
        tokens: { ...BUILTIN_THEMES.midnight.tokens, accent: "#22d3ee" },
      },
      rotation: { autoAdvance: false, transition: "fade" },
      slides: [{ widgets: [], background: null, durationSec: 20 }],
      images: [],
    });
  });

  it("answers defaults without a dashboard and without enabled slides", async () => {
    for (const dashboardId of [null, EMPTY]) {
      const payload = deviceDashboardV2ResponseSchema.parse(
        await v2(dashboardId),
      );
      expect(payload).toMatchObject({
        schema: 2,
        refreshAfterSec: 60,
        timeZone: "Europe/Berlin",
        theme: {
          name: "netrics Dark",
          tokens: BUILTIN_THEMES.netrics_dark.tokens,
        },
        rotation: { autoAdvance: true, transition: "fade" },
        grid: { columns: 12, rows: 8 },
        slides: [],
        images: [],
      });
    }
    expect((await v2(null)).dashboard).toBeNull();
  });

  it("stays well below 256 KB for the largest dashboard", async () => {
    const payload = await v2(MAXIMAL);
    expect(widgetsOf(payload)).toHaveLength(12 * 16);
    const line = widgetsOf(payload).find((widget) => widget.type === "line");
    expect(line?.type === "line" && line.data.values.length).toBe(30);
    // About 185 KiB, most of it the texts and titles at their limits.
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    expect(bytes).toBeLessThan(256 * 1024);
    // The dashboard of the issue's example, a brand slide: a few KB.
    expect(Buffer.byteLength(JSON.stringify(await v2(STUDIO)))).toBeLessThan(
      8 * 1024,
    );
  });

  it("carries a table's rows with their previous window (ADR 0019 §6)", async () => {
    const payload = deviceDashboardV2ResponseSchema.parse(await v2(TABLES));
    const [ranked, plain] = widgetsOf(payload);
    expect(ranked).toMatchObject({
      type: "table",
      label: "Downloads · All resources",
      options: {
        groupBy: "resource",
        limit: 3,
        showChange: true,
        showOthers: true,
      },
      data: {
        status: "ok",
        unit: "count",
        better: "higher",
        groupBy: "resource",
        columns: { label: "Resource", value: "Downloads" },
        others: null,
      },
    });
    if (ranked?.type !== "table" || plain?.type !== "table") {
      throw new Error("expected two tables");
    }
    expect(ranked.data.columns.label).not.toBe("");
    expect(ranked.data.rows.map((row) => [row.key, row.label])).toEqual([
      ["app-1", "Wurfel"],
      ["app-2", "voilà"],
      ["app-3", "paperstand"],
    ]);
    // The previous week of each app; values rise every day, so each row
    // grew, by the same ratio for every app (factors 10, 3 and 1).
    for (const row of ranked.data.rows) {
      expect(row.previousValue).toBeGreaterThan(0);
      expect(row.ratio).toBeCloseTo(
        (row.value - row.previousValue!) / row.previousValue!,
        12,
      );
    }
    expect(ranked.data.rows[0]!.value).toBe(ranked.data.rows[2]!.value * 10);
    // Without the Δ column no previous window is read; Others only with
    // showOthers (three apps, three rows: there is no rest).
    expect(plain).toMatchObject({ label: "Top apps", data: { others: null } });
    expect(
      plain.data.rows.map((row) => [row.previousValue, row.ratio]),
    ).toEqual([
      [null, null],
      [null, null],
      [null, null],
    ]);
  });

  it("hashes the schema: versions differ between schema 1 and 2", async () => {
    expect((await v2(EMPTY)).version).not.toBe((await v1(EMPTY)).version);
    expect((await v2(null)).version).not.toBe((await v1(null)).version);
  });
});

describe("device payload schema 3 (#277)", () => {
  function v3(dashboardId: string | null) {
    return withWorkspace(db, { workspaceId }, async (tx) =>
      withDevice(
        await buildDeviceDashboardV3(tx, workspaceId, dashboardId, {
          now: NOW,
          exchangeRates: true,
        }),
        { rotation: 180, displayMode: "screen" },
      ),
    );
  }

  it("carries every widget type as schema 2 does, in the primary layout", async () => {
    for (const dashboardId of [STUDIO, CUSTOM, EMPTY, MAXIMAL, null]) {
      const payload = await v3(dashboardId);
      expect(deviceDashboardV3ResponseSchema.parse(payload)).toEqual(payload);
      const legacy = await v2(dashboardId);
      const { schema: _s, grid: _g, version: _v, slides, ...shared } = legacy;
      expect(payload).toMatchObject({
        ...shared,
        schema: 3,
        primaryFormat: "16x9",
        device: { rotation: 180, displayMode: "screen" },
      });
      // A 16x9 dashboard: schema 2's slides, widgets, data and background,
      // with no custom layouts; each widget with its type's minimum.
      expect(payload.slides).toEqual(
        slides.map((slide) => ({
          ...slide,
          widgets: slide.widgets.map((widget) => ({
            ...widget,
            min: STUDIO_MIN_WIDGET_SIZE[widget.type],
          })),
          layouts: [],
        })),
      );
    }
    const studio = await v3(STUDIO);
    expect([
      ...new Set(studio.slides.flatMap((s) => s.widgets.map((w) => w.type))),
    ]).toEqual(["metric", "line", "bar", "image", "text", "clock"]);
    // Stable: the same content and settings, the same version.
    expect((await v3(STUDIO)).version).toBe(studio.version);
    expect(studio.version).not.toBe((await v2(STUDIO)).version);
  });
});

describe("device payload schema 1 of a studio dashboard", () => {
  it("is the metric widgets of the enabled slides in reading order", async () => {
    const payload = deviceDashboardResponseSchema.parse(await v1(STUDIO));
    expect(payload).not.toHaveProperty("schema");
    expect(payload.tiles.map((tile) => [tile.id, tile.label])).toEqual([
      [id(1, 101), "Downloads · Wurfel"],
      [id(1, 107), "snap.proceeds · All resources"],
      [id(1, 301), "Downloads · voilà"],
    ]);
    // The metric widget's v2 data is the same tile without id and label.
    const v2Metric = widgetsOf(await v2(STUDIO)).find(
      (widget) => widget.id === id(1, 101),
    );
    const { id: _id, label, ...tile } = payload.tiles[0]!;
    expect(v2Metric).toMatchObject({ type: "metric", label, data: tile });
  });

  it("is empty for a dashboard whose slides are all disabled", async () => {
    expect((await v1(EMPTY)).tiles).toEqual([]);
  });
});

describe("screen language (ADR 0016)", () => {
  const labels = (payload: DeviceDashboardV2Response) =>
    widgetsOf(payload).map((widget) => [widget.id, widget.label]);

  it("labels schema 2 in German and names the language", async () => {
    const payload = deviceDashboardV2ResponseSchema.parse(
      await v2(STUDIO, NOW, "de"),
    );
    expect(payload.locale).toBe("de");
    expect(labels(payload)).toEqual([
      [id(1, 101), "Downloads · Wurfel"],
      [id(1, 102), "Downloads this week"],
      [id(1, 103), "Downloads · Alle Ressourcen"],
      [id(1, 104), null],
      [id(1, 105), null],
      [id(1, 106), null],
      [id(1, 107), "snap.proceeds · Alle Ressourcen"],
      [id(1, 301), "Downloads · voilà"],
    ]);
    // Same data, other labels: a new version, so every screen refetches.
    const english = await v2(STUDIO);
    expect(english.locale).toBe("en");
    expect(labels(english)).toContainEqual([
      id(1, 103),
      "Downloads · All resources",
    ]);
    expect(payload.version).not.toBe(english.version);
    // English is the default.
    expect((await v2(STUDIO, NOW, "en")).version).toBe(english.version);
  });

  it("uses the connector's German metric names and noun (#257)", async () => {
    await owner`update connectors set manifest = ${owner.json({
      id: "snap",
      translations: {
        de: {
          resourceNoun: { singular: "App", plural: "Apps" },
          metrics: { "snap.downloads": { name: "Ladevorgänge" } },
        },
      },
    })} where id = 'snap'`;
    try {
      const payload = await v2(STUDIO, NOW, "de");
      expect(labels(payload)).toContainEqual([
        id(1, 103),
        "Ladevorgänge · Alle Apps",
      ]);
      expect(labels(payload)).toContainEqual([
        id(1, 101),
        "Ladevorgänge · Wurfel",
      ]);
      expect((await v1(STUDIO, "de")).tiles[0]!.label).toBe(
        "Ladevorgänge · Wurfel",
      );
      // English keeps the manifest's own names.
      expect(labels(await v2(STUDIO))).toContainEqual([
        id(1, 103),
        "Downloads · All resources",
      ]);
    } finally {
      await owner`update connectors set manifest = ${owner.json({ id: "snap" })}
                  where id = 'snap'`;
    }
  });

  it("labels schema 1 in German and adds the language only then", async () => {
    const german = deviceDashboardResponseSchema.parse(await v1(STUDIO, "de"));
    expect(german.locale).toBe("de");
    expect(german.tiles.map((tile) => tile.label)).toEqual([
      "Downloads · Wurfel",
      "snap.proceeds · Alle Ressourcen",
      "Downloads · voilà",
    ]);
    // English stays byte for byte what old screens got: no locale field.
    const english = await v1(STUDIO, "en");
    expect(english).not.toHaveProperty("locale");
    expect(JSON.stringify(english)).toBe(JSON.stringify(await v1(STUDIO)));
    expect(german.version).not.toBe(english.version);
  });
});

describe("payload memo", () => {
  let clock: Date;
  let deviceA: string;
  let deviceB: string;
  let otherDevice: string;

  beforeAll(async () => {
    const insertDevice = async (workspace: string, dashboardId: string) => {
      const [row] = await owner`
        insert into devices (workspace_id, name, dashboard_id)
        values (${workspace}, 'TV', ${dashboardId}) returning id`;
      return row!.id as string;
    };
    deviceA = await insertDevice(workspaceId, STUDIO);
    deviceB = await insertDevice(workspaceId, STUDIO);
    otherDevice = await insertDevice(otherWorkspaceId, OTHER);
  });

  function service(payloadCacheMs?: number) {
    clock = new Date(NOW);
    return createDeviceService({
      db,
      pairingUrl: "http://localhost:3000/devices/approve",
      exchangeRates: true,
      now: () => clock,
      ...(payloadCacheMs !== undefined ? { payloadCacheMs } : {}),
    });
  }

  async function read(
    devices: ReturnType<typeof service>,
    deviceId: string,
    schema: 1 | 2 = 2,
    workspace = workspaceId,
  ) {
    const result = await devices.dashboard(
      { workspaceId: workspace, deviceId },
      undefined,
      schema,
    );
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }

  const setToday = (value: number) => owner`
    update observations set value = ${value}
    where connection_id = ${connectionId}
      and source_timestamp = '2026-10-04T00:00:00Z'
      and dimensions = ${owner.json({ resource: "app-1" })}`;

  it("computes once for screens on one dashboard, again after a save", async () => {
    const devices = service();
    const first = await read(devices, deviceA);
    await setToday(1_000);
    try {
      // Another screen within 30 s: the memo, though the data changed.
      expect((await read(devices, deviceB)).version).toBe(first.version);
      // Schema 1 is its own entry and sees the new data.
      const tiles = await read(devices, deviceA, 1);
      expect("tiles" in tiles && tiles.tiles[0]!.value).toBe(
        10 * (8 + 9 + 10 + 11 + 12 + 13) + 1_000,
      );
      // A save bumps the dashboard version: a new entry at once.
      await owner`update dashboards set version = version + 1
                  where id = ${STUDIO}`;
      const saved = await read(devices, deviceB);
      expect(saved.version).not.toBe(first.version);
      // After 30 s the entry is computed again as well.
      await setToday(140);
      expect((await read(devices, deviceA)).version).toBe(saved.version);
      clock = new Date(NOW.getTime() + 30_001);
      expect((await read(devices, deviceA)).version).toBe(first.version);
    } finally {
      await setToday(140);
    }
  });

  it("computes on every request without a memo", async () => {
    const devices = service(0);
    const first = await read(devices, deviceA);
    await setToday(1_000);
    try {
      expect((await read(devices, deviceB)).version).not.toBe(first.version);
    } finally {
      await setToday(140);
    }
  });

  it("follows the workspace screen language at once, then the instance default", async () => {
    const devices = service();
    const english = await read(devices, deviceA);
    expect(english.locale).toBe("en");
    await owner`update workspaces set screen_locale = 'de'
                where id = ${workspaceId}`;
    try {
      // Within the memo's 30 s: the language is part of the key.
      const german = await read(devices, deviceB);
      expect(german.locale).toBe("de");
      expect(german.version).not.toBe(english.version);
      const tiles = await read(devices, deviceA, 1);
      expect("tiles" in tiles && tiles.tiles[1]!.label).toBe(
        "snap.proceeds · Alle Ressourcen",
      );
    } finally {
      await owner`update workspaces set screen_locale = null
                  where id = ${workspaceId}`;
    }
    expect((await read(devices, deviceA)).locale).toBe("en");
    // NETRICS_DEFAULT_LOCALE applies to workspaces without a language.
    const instanceGerman = createDeviceService({
      db,
      pairingUrl: "http://localhost:3000/devices/approve",
      exchangeRates: true,
      now: () => clock,
      defaultLocale: "de",
    });
    expect((await read(instanceGerman, deviceA)).locale).toBe("de");
    await owner`update workspaces set screen_locale = 'en'
                where id = ${workspaceId}`;
    try {
      expect((await read(instanceGerman, deviceA)).locale).toBe("en");
    } finally {
      await owner`update workspaces set screen_locale = null
                  where id = ${workspaceId}`;
    }
  });

  it("never serves one workspace's payload to another", async () => {
    const devices = service();
    const studio = await read(devices, deviceA);
    const other = await read(devices, otherDevice, 2, otherWorkspaceId);
    expect(other.dashboard?.id).toBe(OTHER);
    expect(other.version).not.toBe(studio.version);
    expect(
      "slides" in other && other.slides[0]!.widgets.map((w) => w.id),
    ).toEqual([id(5, 101)]);
    // A device is only ever found in its own workspace.
    const crossed = await devices.dashboard(
      { workspaceId: otherWorkspaceId, deviceId: deviceA },
      undefined,
      2,
    );
    expect(crossed).toEqual({ ok: false, status: 401, error: "unauthorized" });
  });
});

describe("data status backfilling (#311)", () => {
  const BACKFILL = id(8, 0);
  const slideId = id(8, 100);
  let fresh: string;
  let refetching: string;

  beforeAll(async () => {
    // A connection whose first sync has not succeeded yet (its backfill
    // was queued on creation), and one that synced before and now
    // backfills its history again after a config change (#153).
    const [first] = await owner`
      insert into connections (workspace_id, connector_id, name)
      values (${workspaceId}, 'snap', 'Fresh') returning id`;
    fresh = first!.id as string;
    const [second] = await owner`
      insert into connections (workspace_id, connector_id, name)
      values (${workspaceId}, 'snap', 'Refetching') returning id`;
    refetching = second!.id as string;
    await owner`
      insert into connection_state (connection_id, workspace_id,
        last_success_at, poll_interval_seconds)
      values (${refetching}, ${workspaceId}, '2026-10-04T09:55:00Z', 300)`;
    await owner`
      insert into jobs (kind, workspace_id, connection_id, status)
      values ('connection.backfill', ${workspaceId}, ${refetching},
              'running')`;
    await insertDashboard(BACKFILL, "Backfill");
    await insertSlide(slideId, BACKFILL, 0);
    for (const [n, connection, type] of [
      [101, fresh, "metric"],
      [102, refetching, "line"],
      [103, refetching, "bar"],
      [104, connectionId, "metric"],
    ] as const) {
      await insertWidget(id(8, n), slideId, BACKFILL, {
        type,
        x: (n - 101) * 3,
        y: 0,
        w: 3,
        h: 3,
        ...downloads({ connection_id: connection }),
        // The synced connection's widget asks for a resource without data.
        ...(n === 104 ? { dimensions: { resource: "app-9" } } : {}),
        options: type === "bar" ? { groupBy: "resource" } : {},
      });
    }
  });

  const statuses = async () =>
    widgetsOf(await v2(BACKFILL)).map((widget) =>
      "data" in widget ? widget.data.status : null,
    );

  it("reports a widget without data as backfilling while its history loads", async () => {
    expect(await statuses()).toEqual([
      "backfilling",
      "backfilling",
      "backfilling",
      "no_data",
    ]);
    const tiles = (await v1(BACKFILL)).tiles.map((tile) => tile.status);
    expect(tiles).toEqual(["backfilling", "no_data"]);
    const payload = await v2(BACKFILL);
    expect(deviceDashboardV2ResponseSchema.parse(payload)).toEqual(payload);
  });

  it("reports no_data again once the backfill is done", async () => {
    await owner`
      update jobs set status = 'succeeded'
      where connection_id = ${refetching}`;
    expect(await statuses()).toEqual([
      "backfilling",
      "no_data",
      "no_data",
      "no_data",
    ]);
  });
});
