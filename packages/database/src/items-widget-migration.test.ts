import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { migrationsFolder } from "./index.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
  type TestDatabase,
} from "./test-db.js";

// The latest-items widget migration (#810) on dashboards in the previous
// shape: a widget of every existing type keeps everything it had.
// Afterwards an `items` widget names a model of its own workspace and its
// binding, never a connection, text or image. The migration is found by its
// name, not its number, so a renumbering on merge does not touch this test.

const TAG_SUFFIX = "_items_widget";

function lastBefore(): string {
  const journal = JSON.parse(
    readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };
  const at = journal.entries.findIndex((entry) =>
    entry.tag.endsWith(TAG_SUFFIX),
  );
  expect(at).toBeGreaterThan(0);
  return journal.entries[at - 1]!.tag;
}

let testDb: TestDatabase;
let owner: postgres.Sql;
let workspaceId: string;
let dashboardId: string;
let slideId: string;
let connectionId: string;
let modelId: string;
let foreignModelId: string;

const binding = () => ({
  modelId,
  imageDimensionId: "photo",
  titleDimensionId: "title",
  timeDimensionId: "taken_at",
  exclusions: [],
});

function errorChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
}

async function expectDbError(promise: Promise<unknown>, pattern: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect(errorChain(error)).toMatch(pattern);
    return;
  }
  expect.unreachable("expected the query to fail");
}

/** An items widget with the given columns on top of a valid one. */
function insertItems(extra: Record<string, unknown> = {}) {
  const row = {
    slide_id: slideId,
    dashboard_id: dashboardId,
    workspace_id: workspaceId,
    type: "items",
    x: 0,
    y: 4,
    w: 3,
    h: 3,
    model_id: modelId,
    model_binding: owner.json(binding()),
    ...extra,
  };
  return owner`insert into dashboard_widgets ${owner(row)} returning id`;
}

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: lastBefore() });
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => undefined });
  const [workspace] = await owner`
    insert into workspaces (name) values ('W') returning id`;
  workspaceId = workspace!.id as string;
  const [foreign] = await owner`
    insert into workspaces (name) values ('F') returning id`;
  await owner`insert into connectors (id, version, manifest)
    values ('c', '1.0.0', '{}'::jsonb) on conflict (id) do nothing`;
  const [connection] = await owner`
    insert into connections (workspace_id, connector_id, name)
    values (${workspaceId}, 'c', 'Shop') returning id`;
  connectionId = connection!.id as string;
  const [model] = await owner`
    insert into data_models (workspace_id, name, definition)
    values (${workspaceId}, 'Photos', '{}'::jsonb) returning id`;
  modelId = model!.id as string;
  const [foreignModel] = await owner`
    insert into data_models (workspace_id, name, definition)
    values (${foreign!.id}, 'Foreign', '{}'::jsonb) returning id`;
  foreignModelId = foreignModel!.id as string;
  const [dashboard] = await owner`
    insert into dashboards (workspace_id, name)
    values (${workspaceId}, 'D') returning id`;
  dashboardId = dashboard!.id as string;
  const [slide] = await owner`
    insert into dashboard_slides (dashboard_id, workspace_id, position)
    values (${dashboardId}, ${workspaceId}, 0) returning id`;
  slideId = slide!.id as string;
  const content = Buffer.from(randomUUID());
  const [image] = await owner`
    insert into workspace_images (workspace_id, name, content_type, bytes,
      width, height, sha256, content)
    values (${workspaceId}, 'logo', 'image/png', ${content.length}, 24, 16,
      ${createHash("sha256").update(content).digest("hex")}, ${content})
    returning id`;
  const imageId = image!.id as string;
  const at = (x: number) => ({
    slide_id: slideId,
    dashboard_id: dashboardId,
    workspace_id: workspaceId,
    x,
    y: 0,
    w: 1,
    h: 1,
  });
  const metricBinding = {
    connection_id: connectionId,
    metric_key: "c.visits",
    aggregation: "sum",
    period: "today",
  };
  // The previous shape: one widget of every type.
  const rows = [
    { ...at(0), type: "metric", ...metricBinding },
    { ...at(1), type: "line", ...metricBinding },
    { ...at(2), type: "bar", ...metricBinding },
    { ...at(3), type: "table", ...metricBinding },
    {
      ...at(4),
      type: "compare",
      ...metricBinding,
      denominator_connection_id: connectionId,
      denominator_metric_key: "c.signups",
      denominator_aggregation: "avg",
    },
    { ...at(5), type: "image", image_id: imageId },
    { ...at(6), type: "text", text: "Hello" },
    { ...at(7), type: "clock" },
    { ...at(8), type: "status" },
    { ...at(9), type: "countdown" },
    { ...at(10), type: "gauge" },
    { ...at(11), type: "review", connection_id: connectionId },
    {
      ...at(12),
      type: "measure",
      model_id: modelId,
      model_binding: owner.json({
        modelId,
        measureIds: ["m"],
        groupBy: [],
        exclusions: [],
      }),
    },
  ];
  for (const row of rows)
    await owner`insert into dashboard_widgets ${owner(row)}`;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

afterAll(async () => {
  await owner.end({ timeout: 5 }).catch(() => undefined);
});

const widgets = () => owner`select * from dashboard_widgets order by x, y`;

describe("the latest-items widget migration", () => {
  it("refuses an items widget before it", async () => {
    // Either check refuses it: the type, or a model on an unknown type.
    await expectDbError(insertItems(), /dashboard_widgets_(type|model)_valid/);
  });

  it("keeps a widget of every existing type exactly as it was", async () => {
    const before = await widgets();
    expect(new Set(before.map((row) => row.type)).size).toBe(13);
    await testDb.migrate();
    expect(await widgets()).toEqual(before);
  });

  it("stores an items widget with its model and binding", async () => {
    const [row] = await insertItems();
    await owner`delete from dashboard_widgets where id = ${row!.id}`;
  });

  it("refuses an items widget without its model or binding", async () => {
    await expectDbError(
      insertItems({ model_id: null }),
      /dashboard_widgets_model_valid/,
    );
    await expectDbError(
      insertItems({ model_binding: null }),
      /dashboard_widgets_model_valid/,
    );
    await expectDbError(
      insertItems({ model_id: foreignModelId }),
      /dashboard_widgets_model_fk/,
    );
  });

  it("refuses an items widget with a connection or text", async () => {
    await expectDbError(
      insertItems({ connection_id: connectionId }),
      /dashboard_widgets_type_columns/,
    );
    await expectDbError(
      insertItems({ text: "x" }),
      /dashboard_widgets_type_columns/,
    );
  });

  it("still refuses a model on other widgets and requires one on measure", async () => {
    await expectDbError(
      owner`update dashboard_widgets
        set model_id = ${modelId}, model_binding = ${owner.json(binding())}
        where type = 'metric'`,
      /dashboard_widgets_model_valid/,
    );
    await expectDbError(
      owner`update dashboard_widgets set model_id = null, model_binding = null
        where type = 'measure'`,
      /dashboard_widgets_model_valid/,
    );
  });
});
