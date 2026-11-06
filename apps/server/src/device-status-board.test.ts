import {
  deviceDashboardV2ResponseSchema,
  deviceDashboardV3ResponseSchema,
  type DeviceWidget,
} from "@netrics/contracts";
import {
  createDatabase,
  createRawSqlClient,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";
import { STUDIO_MIN_WIDGET_SIZE, type Locale } from "@netrics/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildDeviceDashboardV2,
  buildDeviceDashboardV3,
  withDevice,
} from "./devices/dashboard.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

// The status board in device payloads (ADR 0019 section 7, #338): one item
// per connection with the `tileStatus` rules, attention first, from the
// payload's one connection query, and never a connection of another
// workspace, its credentials, configuration or errors.

const NOW = new Date("2026-10-04T10:00:00Z");

let testDb: TestDatabase;
let owner: Sql;
let db: Database;
let workspaceId: string;
let otherWorkspaceId: string;
const connections: Record<string, string> = {};
let foreignConnectionId: string;

const id = (group: number, n: number) =>
  `${String(group).repeat(8)}-0000-4000-8000-${String(n).padStart(12, "0")}`;

const BOARDS = id(1, 0);
const CHOSEN = id(2, 0);
const FOREIGN = id(3, 0);
const SECRET = "sk_live_do_not_leak";
const ERROR_TEXT = "401 invalid token for account 12345";

async function insertConnection(
  workspace: string,
  name: string,
  state: {
    lastSuccessAt?: string | null;
    authState?: string;
    setupPending?: boolean;
  } | null,
): Promise<string> {
  const [row] = await owner`
    insert into connections (workspace_id, connector_id, name, config,
      credentials_encrypted, setup_pending)
    values (${workspace}, 'snap', ${name},
      ${owner.json({ apiKey: SECRET, property: "sc-domain:example.com" })},
      ${Buffer.from(SECRET)}, ${state?.setupPending ?? false})
    returning id`;
  const connectionId = row!.id as string;
  if (state) {
    await owner`
      insert into connection_state (connection_id, workspace_id,
        last_success_at, poll_interval_seconds, auth_state)
      values (${connectionId}, ${workspace}, ${state.lastSuccessAt ?? null},
        300, ${state.authState ?? "ok"})`;
  }
  return connectionId;
}

async function insertBoard(
  dashboardId: string,
  workspace: string,
  widgets: Array<{ n: number; x: number; options: unknown; title?: string }>,
) {
  await owner`
    insert into dashboards (id, workspace_id, name)
    values (${dashboardId}, ${workspace}, 'Boards')`;
  const slideId = dashboardId.replace(/0{12}$/, "000000000100");
  await owner`
    insert into dashboard_slides (id, dashboard_id, workspace_id, position)
    values (${slideId}, ${dashboardId}, ${workspace}, 0)`;
  for (const widget of widgets) {
    await owner`
      insert into dashboard_widgets (id, slide_id, dashboard_id, workspace_id,
        type, x, y, w, h, title, options)
      values (${dashboardId.replace(/0{12}$/, String(100 + widget.n).padStart(12, "0"))},
        ${slideId}, ${dashboardId}, ${workspace}, 'status', ${widget.x}, 0, 3,
        3, ${widget.title ?? null}, ${owner.json(widget.options as never)})`;
  }
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  owner = createRawSqlClient(testDb.adminUrl, {
    max: 1,
    onnotice: () => undefined,
  });
  await owner`insert into connectors (id, version, manifest) values
    ('snap', '1.0.0', ${owner.json({ id: "snap" })})`;
  const [workspace] = await owner`
    insert into workspaces (name) values ('W') returning id`;
  workspaceId = workspace!.id as string;
  const [other] = await owner`
    insert into workspaces (name) values ('Other') returning id`;
  otherWorkspaceId = other!.id as string;

  // Fresh (5 minutes), stale (2 hours at a 5 minute interval), failing
  // credentials, a grant to reauthorize, an outage, a setup not finished,
  // and a first sync still pending.
  connections.vercel = await insertConnection(workspaceId, "Vercel", {
    lastSuccessAt: "2026-10-04T09:55:00Z",
  });
  connections.analytics = await insertConnection(workspaceId, "analytics", {
    lastSuccessAt: "2026-10-04T09:58:00Z",
  });
  connections.appStore = await insertConnection(
    workspaceId,
    "App Store Connect",
    { lastSuccessAt: "2026-10-04T08:00:00Z" },
  );
  connections.stripe = await insertConnection(workspaceId, "Stripe", {
    lastSuccessAt: "2026-10-04T09:00:00Z",
    authState: "auth_failed",
  });
  connections.google = await insertConnection(workspaceId, "Google Ads", {
    lastSuccessAt: "2026-10-04T09:50:00Z",
    authState: "needs_reauthorization",
  });
  connections.plausible = await insertConnection(workspaceId, "Plausible", {
    lastSuccessAt: "2026-10-04T09:30:00Z",
    authState: "outage",
  });
  connections.searchConsole = await insertConnection(
    workspaceId,
    "Search Console",
    { setupPending: true },
  );
  connections.fresh = await insertConnection(workspaceId, "New site", null);
  // A failed sync's error text stays on the server.
  await owner`
    insert into jobs (kind, workspace_id, connection_id, status, last_error)
    values ('sync', ${workspaceId}, ${connections.stripe!}, 'failed',
      ${ERROR_TEXT})`;

  foreignConnectionId = await insertConnection(
    otherWorkspaceId,
    "Foreign source",
    { lastSuccessAt: "2026-10-04T09:59:00Z" },
  );

  await insertBoard(BOARDS, workspaceId, [
    { n: 1, x: 0, options: {} },
    { n: 2, x: 3, options: { showAge: false }, title: "Feeds" },
  ]);
  // Chosen sources: one of this workspace, a deleted one, and one of
  // another workspace written past the API's validation.
  await insertBoard(CHOSEN, workspaceId, [
    {
      n: 1,
      x: 0,
      options: {
        connectionIds: [
          connections.appStore,
          id(9, 9),
          foreignConnectionId,
          connections.vercel,
        ],
      },
    },
  ]);
  await insertBoard(FOREIGN, otherWorkspaceId, [{ n: 1, x: 0, options: {} }]);

  db = createDatabase(testDb.appUrl, { max: 2 });
}, 120_000);

afterAll(async () => {
  await owner?.end({ timeout: 5 }).catch(() => undefined);
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
});

function v2(dashboardId: string, workspace = workspaceId, locale?: Locale) {
  return withWorkspace(db, { workspaceId: workspace }, (tx) =>
    buildDeviceDashboardV2(tx, workspace, dashboardId, {
      now: NOW,
      ...(locale ? { locale } : {}),
    }),
  );
}

function boards(widgets: readonly DeviceWidget[]) {
  return widgets.map((widget) => {
    if (widget.type !== "status") throw new Error("expected a status board");
    return widget;
  });
}

describe("status board payload (ADR 0019 section 7)", () => {
  it("lists every source attention first, then by name", async () => {
    const payload = deviceDashboardV2ResponseSchema.parse(await v2(BOARDS));
    const [all, feeds] = boards(payload.slides[0]!.widgets);
    expect(all).toMatchObject({
      type: "status",
      label: "Sources",
      options: { connectionIds: null, showAge: true },
      data: { status: "ok" },
    });
    expect(all!.data.items.map((item) => [item.name, item.status])).toEqual([
      ["Google Ads", "auth_failed"],
      ["Search Console", "auth_failed"],
      ["Stripe", "auth_failed"],
      ["Plausible", "outage"],
      ["App Store Connect", "stale"],
      ["New site", "backfilling"],
      ["analytics", "ok"],
      ["Vercel", "ok"],
    ]);
    expect(all!.data.items[4]).toEqual({
      connectionId: connections.appStore,
      name: "App Store Connect",
      status: "stale",
      lastSuccessAt: "2026-10-04T08:00:00.000Z",
    });
    expect(feeds).toMatchObject({
      label: "Feeds",
      options: { showAge: false },
    });
    expect(feeds!.data.items).toEqual(all!.data.items);
  });

  it("never sends credentials, configuration or error texts", async () => {
    const text = JSON.stringify(await v2(BOARDS));
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("sc-domain");
    expect(text).not.toContain("invalid token");
    for (const item of boards(
      deviceDashboardV2ResponseSchema.parse(await v2(BOARDS)).slides[0]!
        .widgets,
    )[0]!.data.items) {
      expect(Object.keys(item).sort()).toEqual([
        "connectionId",
        "lastSuccessAt",
        "name",
        "status",
      ]);
    }
  });

  it("lists the chosen sources only, without deleted or foreign ones", async () => {
    const payload = deviceDashboardV2ResponseSchema.parse(await v2(CHOSEN));
    const [board] = boards(payload.slides[0]!.widgets);
    expect(board!.data.items.map((item) => item.connectionId)).toEqual([
      connections.appStore,
      connections.vercel,
    ]);
    expect(JSON.stringify(payload)).not.toContain("Foreign source");
  });

  it("never lists another workspace's connections (cross-workspace)", async () => {
    const mine = JSON.stringify(await v2(BOARDS));
    expect(mine).not.toContain(foreignConnectionId);
    expect(mine).not.toContain("Foreign source");
    // The other workspace's board lists its own source only.
    const theirs = deviceDashboardV2ResponseSchema.parse(
      await v2(FOREIGN, otherWorkspaceId),
    );
    const [board] = boards(theirs.slides[0]!.widgets);
    expect(board!.data.items).toEqual([
      {
        connectionId: foreignConnectionId,
        name: "Foreign source",
        status: "ok",
        lastSuccessAt: "2026-10-04T09:59:00.000Z",
      },
    ]);
    // A board of this workspace asked for from the other one is not there.
    const crossed = await v2(BOARDS, otherWorkspaceId);
    expect(crossed.dashboard).toBeNull();
    expect(JSON.stringify(crossed)).not.toContain("Vercel");
  });

  it("labels an untitled board in the payload's language", async () => {
    const payload = deviceDashboardV2ResponseSchema.parse(
      await v2(BOARDS, workspaceId, "de"),
    );
    expect(boards(payload.slides[0]!.widgets)[0]!.label).toBe("Quellen");
  });

  it("carries the 3 × 3 minimum in schema 3", async () => {
    const content = await withWorkspace(db, { workspaceId }, (tx) =>
      buildDeviceDashboardV3(tx, workspaceId, BOARDS, { now: NOW }),
    );
    const payload = deviceDashboardV3ResponseSchema.parse(
      withDevice(content, { rotation: 0, displayMode: "screen" }),
    );
    expect(payload.slides[0]!.widgets[0]!.min).toEqual(
      STUDIO_MIN_WIDGET_SIZE.status,
    );
    expect(payload.slides[0]!.widgets[0]!.min).toEqual({ w: 3, h: 3 });
  });
});
