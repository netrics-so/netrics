import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  createRawSqlClient,
  createWorkspace,
  findDashboard,
  ingestDatasetPage,
  schema,
  upsertConnectionResources,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";
import type { DatasetRecord } from "@netrics/connector-sdk";
import type { DeveloperTemplateResult } from "@netrics/contracts";
import type { DataExpression } from "@netrics/domain";

import { createDefaultRegistry } from "../connectors.js";
import { createDataService } from "../data/service.js";
import { syncCatalog } from "../sync/catalog.js";
import {
  createTestDatabase,
  TEST_DATABASE_DROP_TIMEOUT_MS,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
  type TestDatabase,
} from "../test-db.js";
import { queryDashboardData } from "./data.js";
import { mappedProductApps } from "./freshness.js";
import {
  createDeveloperTemplateService,
  projectProduct,
} from "./developer-template-service.js";
import { presentDashboard } from "./service.js";

/**
 * The Developer Portfolio (#876): installs with any subset of its sources,
 * relates every source's resources to workspace projects, sums costs and
 * users per project, and its dashboard's filters and slide scopes apply to
 * every widget.
 */
const NOW = "2026-11-24T12:00:00.000Z";
let test: TestDatabase, db: Database, owner: Sql, userId: string;
const registry = createDefaultRegistry();
const service = () =>
  createDeveloperTemplateService({ db, registry, now: () => new Date(NOW) });

beforeAll(async () => {
  test = await createTestDatabase();
  db = createDatabase(test.appUrl);
  owner = createRawSqlClient(test.adminUrl, { max: 1 });
  const admin = createDatabase(test.adminUrl, { max: 1 });
  await syncCatalog(admin, registry);
  await admin.$client.end({ timeout: 5 });
  const [user] = await db
    .insert(schema.users)
    .values({ email: "developer-template@example.test", displayName: "Owner" })
    .returning();
  userId = user!.id;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);
afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
  await owner?.end({ timeout: 5 });
  await test?.drop();
}, TEST_DATABASE_DROP_TIMEOUT_MS);

type Connector =
  | "railway"
  | "vercel"
  | "hetzner-cloud"
  | "http-check"
  | "posthog"
  | "google-search-console"
  | "app-store-connect"
  | "google-play";

/** A workspace with two projects and set-up connections of `connectors`. */
async function workspace(
  connectors: Connector[],
  options: { assign?: Partial<Record<Connector, "web" | "api">> } = {},
) {
  const id = await createWorkspace(db, {
    name: "Developer " + randomUUID().slice(0, 8),
    ownerUserId: userId,
  });
  const projects: Record<"web" | "api", string> = { web: "", api: "" };
  for (const [key, name] of [
    ["web", "Web shop"],
    ["api", "Public API"],
  ] as const) {
    const [row] = await owner<{ id: string }[]>`
      insert into projects (workspace_id, name) values (${id}, ${name})
      returning id`;
    projects[key] = row!.id;
  }
  const connections = {} as Record<Connector, string>;
  for (const connectorId of connectors) {
    const project = options.assign?.[connectorId];
    const [row] = await owner<{ id: string }[]>`
      insert into connections (workspace_id, connector_id, name, setup_pending, project_id)
      values (${id}, ${connectorId}, ${connectorId}, false,
        ${project ? projects[project] : null})
      returning id`;
    connections[connectorId] = row!.id;
  }
  return { id, projects, connections };
}

const actor = (workspaceId: string, locale: "en" | "de" = "en") => ({
  workspaceId,
  callerId: userId,
  locale,
});

async function ingest(
  workspaceId: string,
  connectionId: string,
  connectorId: Connector,
  key: string,
  records: DatasetRecord[],
) {
  const definition = registry
    .get(connectorId)!
    .manifest.datasets!.find((dataset) => dataset.key === key)!;
  await withWorkspace(db, { workspaceId }, (tx) =>
    ingestDatasetPage(tx, {
      workspaceId,
      connectionId,
      definition,
      page: {
        datasetKey: key,
        schemaVersion: definition.version,
        refreshKey: "fixture",
        pageKey: "page-1",
        previousPageKey: null,
        complete: true,
        records,
      },
      now: new Date(NOW),
    }),
  );
}

async function observe(
  workspaceId: string,
  connectionId: string,
  connectorId: Connector,
  metricKey: string,
  rows: { resource: string; day: string; value: number }[],
) {
  await owner`
    insert into observations (workspace_id, connection_id,
      metric_definition_id, dimensions, source_timestamp, value)
    select ${workspaceId}, ${connectionId}, m.id, r.dimensions::jsonb,
           r.at::timestamptz, r.value
    from metric_definitions m,
         json_to_recordset(${owner.json(
           rows.map((row) => ({
             dimensions: JSON.stringify({ resource: row.resource }),
             at: row.day + "T00:00:00.000Z",
             value: row.value,
           })),
         )}::json) as r(dimensions text, at text, value double precision)
    where m.connector_id = ${connectorId} and m.key = ${metricKey}`;
}

const ALL: Connector[] = [
  "railway",
  "vercel",
  "hetzner-cloud",
  "http-check",
  "posthog",
  "google-search-console",
  "app-store-connect",
  "google-play",
];

const counts = async (workspaceId: string) => {
  const [row] = await owner<
    { preparations: number; models: number; dashboards: number }[]
  >`select
      (select count(*)::int from data_preparations where workspace_id = ${workspaceId}) as preparations,
      (select count(*)::int from data_models where workspace_id = ${workspaceId}) as models,
      (select count(*)::int from dashboards where workspace_id = ${workspaceId}) as dashboards`;
  return row!;
};

const TIMEOUT_MS = 60_000;

describe("Developer Portfolio installs", { timeout: TIMEOUT_MS }, () => {
  it("installs with every source", async () => {
    const target = await workspace(ALL);
    const result = await service().install(actor(target.id), {
      requestId: randomUUID(),
      name: "Developer Portfolio",
      connections: Object.values(target.connections),
      links: [],
    });
    expect(Object.keys(result.models).sort()).toEqual([
      "audience",
      "costs",
      "deploys",
      "downloads",
      "proceeds",
      "ratings",
      "state",
    ]);
    expect(await counts(target.id)).toMatchObject({ models: 7, dashboards: 1 });
    const [install] = await owner<
      { template_id: string; template_version: number }[]
    >`select template_id, template_version from data_template_installs
      where workspace_id = ${target.id}`;
    expect(install).toEqual({
      template_id: "developer_portfolio",
      template_version: 1,
    });
    const dashboard = await withWorkspace(
      db,
      { workspaceId: target.id },
      (tx) => findDashboard(tx, target.id, result.dashboardId),
    );
    // Nothing is linked yet: the overview only.
    expect(dashboard!.slides).toHaveLength(1);
    expect(dashboard!.slides[0]!.widgets.map((widget) => widget.type)).toEqual(
      expect.arrayContaining(["state", "measure"]),
    );
  });

  it("installs with only Railway", async () => {
    const target = await workspace(["railway"], {
      assign: { railway: "api" },
    });
    await ingest(
      target.id,
      target.connections.railway,
      "railway",
      "service_states",
      [],
    );
    await withWorkspace(db, { workspaceId: target.id }, (tx) =>
      upsertConnectionResources(tx, {
        workspaceId: target.id,
        connectionId: target.connections.railway,
        resources: [
          { id: "rw-project", name: "api-prod", kind: "project" },
          { id: "svc-1", name: "api", kind: "service" },
        ],
        now: new Date(NOW),
      }),
    );
    const result = await service().install(actor(target.id), {
      requestId: randomUUID(),
      name: "Ops",
      connections: [target.connections.railway],
      links: [],
    });
    expect(Object.keys(result.models).sort()).toEqual([
      "costs",
      "deploys",
      "state",
    ]);
    // A source preparation per family; one source needs no append.
    expect(await counts(target.id)).toMatchObject({
      preparations: 3,
      models: 3,
      dashboards: 1,
    });
    const dashboard = await withWorkspace(
      db,
      { workspaceId: target.id },
      (tx) => findDashboard(tx, target.id, result.dashboardId),
    );
    // The connection's project gets a slide, scoped to it; the service
    // resource is no project and is not linked.
    expect(dashboard!.slides.map((slide) => slide.name)).toEqual([
      "Overview",
      "Public API",
    ]);
    expect(dashboard!.slides[1]!.scope).toEqual({
      project: {
        kind: "values",
        values: [projectProduct(target.projects.api)],
      },
    });
    const [links] = await owner<{ rows: unknown[] }[]>`
      select coalesce(json_agg(r.values order by r.values->>'app_key'), '[]') as rows
      from data_records r
      join data_generations g on g.id = r.generation_id
      join data_datasets d on d.id = g.dataset_id
      where d.workspace_id = ${target.id} and d.key like 'developer_links_%'`;
    expect(links!.rows).toEqual([
      {
        app_key: `${target.connections.railway}:rw-project`,
        product_id: projectProduct(target.projects.api),
      },
    ]);
  });

  it("installs with only App Store", async () => {
    const target = await workspace(["app-store-connect"]);
    const result = await service().install(actor(target.id, "de"), {
      requestId: randomUUID(),
      name: "Apps",
      connections: [target.connections["app-store-connect"]],
      links: [
        {
          connectionId: target.connections["app-store-connect"],
          resourceId: "123",
          projectId: target.projects.web,
        },
      ],
    });
    expect(Object.keys(result.models).sort()).toEqual([
      "downloads",
      "proceeds",
      "ratings",
    ]);
    const dashboard = await withWorkspace(
      db,
      { workspaceId: target.id },
      (tx) => findDashboard(tx, target.id, result.dashboardId),
    );
    expect(dashboard!.slides.map((slide) => slide.name)).toEqual([
      "Übersicht",
      "Web shop",
    ]);
    expect(dashboard!.slides[1]!.widgets.map((widget) => widget.title)).toEqual(
      ["Downloads (30 Tage)", "Erlöse (30 Tage)", "Bewertungen"],
    );
  });

  it("refuses connections of other connectors and links to unknown projects", async () => {
    const target = await workspace(["railway", "apple-ads" as Connector]);
    await expect(
      service().install(actor(target.id), {
        requestId: randomUUID(),
        name: "Ops",
        connections: [target.connections["apple-ads" as Connector]],
        links: [],
      }),
    ).rejects.toMatchObject({ code: "developer_connector_required" });
    await expect(
      service().install(actor(target.id), {
        requestId: randomUUID(),
        name: "Ops",
        connections: [target.connections.railway],
        links: [
          {
            connectionId: target.connections.railway,
            resourceId: "x",
            projectId: randomUUID(),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "developer_link_invalid" });
  });
});

describe("Developer Portfolio data", { timeout: TIMEOUT_MS }, () => {
  let target: Awaited<ReturnType<typeof workspace>>,
    result: DeveloperTemplateResult;
  beforeAll(async () => {
    target = await workspace(
      ["railway", "vercel", "hetzner-cloud", "http-check", "posthog"],
      { assign: { railway: "api" } },
    );
    const c = target.connections;
    await ingest(target.id, c.railway, "railway", "service_states", [
      {
        values: {
          project_id: "rw-1",
          project_name: "api-prod",
          service_id: "s1",
          service_name: "api",
          environment_id: "e1",
          environment_name: "production",
          state: "failed",
          active_deployments: 0,
          latest_deployment_id: "d2",
          latest_status: "FAILED",
          latest_created_at: "2026-11-24T09:00:00.000Z",
          latest_status_updated_at: "2026-11-24T09:05:00.000Z",
          checked_at: NOW,
        },
      },
    ]);
    await ingest(
      target.id,
      c.railway,
      "railway",
      "deployments",
      [
        ["d1", "SUCCESS", false, "2026-11-23T10:00:00.000Z"],
        ["d2", "FAILED", true, "2026-11-24T09:00:00.000Z"],
        ["d3", "SUCCESS", false, "2026-11-24T10:00:00.000Z"],
        // Another service of the same name (a worker called "api").
        ["d4", "SUCCESS", false, "2026-11-24T11:00:00.000Z", "s2"],
      ].map(([id, status, failed, created, service = "s1"]) => ({
        values: {
          deployment_id: id,
          project_id: "rw-1",
          service_id: service,
          service_name: "api",
          environment_id: "e1",
          environment_name: "production",
          status,
          failed,
          created_at: created,
          status_updated_at: created,
          finished_at: created,
          duration_seconds: 60,
        },
      })),
    );
    await ingest(target.id, c.railway, "railway", "project_usage", [
      {
        values: {
          project_id: "rw-1",
          project_name: "api-prod",
          month: "2026-11-01",
          as_of: NOW,
          cpu_vcpu_minutes: 1,
          memory_gb_minutes: 1,
          egress_gb: 1,
          disk_gb_minutes: 1,
          cost_usd: "12.5",
          estimated_cost_usd: "20",
          currency: "USD",
        },
      },
    ]);
    await ingest(target.id, c.vercel, "vercel", "production_deployments", [
      {
        values: {
          project_id: "prj_web",
          project_name: "web",
          web_analytics: true,
          state: "up",
          latest_deployment_id: "v2",
          latest_state: "READY",
          latest_created_at: "2026-11-24T08:00:00.000Z",
          latest_ready_at: "2026-11-24T08:02:00.000Z",
          live_deployment_id: "v1",
          live_created_at: "2026-11-20T08:00:00.000Z",
          live_ready_at: "2026-11-20T08:02:00.000Z",
          live_url: null,
          rolled_back: true,
          checked_at: NOW,
        },
      },
    ]);
    await ingest(
      target.id,
      c.vercel,
      "vercel",
      "deployments",
      [
        ["v1", "production", "2026-11-20T08:00:00.000Z"],
        ["v2", "production", "2026-11-24T08:00:00.000Z"],
        ["v3", "preview", "2026-11-24T08:30:00.000Z"],
      ].map(([id, target, created]) => ({
        values: {
          deployment_id: id,
          project_id: "prj_web",
          project_name: "web",
          state: "READY",
          failed: false,
          target,
          created_at: created,
          building_at: null,
          ready_at: null,
          build_duration_seconds: null,
          ready_substate: null,
          source: null,
          branch: null,
          url: null,
        },
      })),
    );
    await ingest(
      target.id,
      c.vercel,
      "vercel",
      "billing_charges",
      [
        ["prj_web", "sku1", "3.25", "4"],
        ["prj_web", "sku2", "1.75", "1.75"],
        ["", "sku3", "20", "20"],
      ].map(([project, sku, effective, billed]) => ({
        values: {
          team_id: "team",
          team_name: "Team",
          project_id: project,
          project_name: project ? "web" : null,
          sku_id: sku,
          service_name: "Functions",
          service_category: null,
          charge_category: "Usage",
          month: "2026-11-01",
          as_of: NOW,
          billed_cost: billed,
          effective_cost: effective,
          consumed_quantity: null,
          consumed_unit: null,
          currency: "USD",
        },
      })),
    );
    await ingest(
      target.id,
      c["hetzner-cloud"],
      "hetzner-cloud",
      "servers",
      // Two servers of one name: two items, never one.
      ["42", "43"].map((server) => ({
        values: {
          server_id: server,
          name: "db-1",
          status: "running",
          state: "up",
          server_type: "cx22",
          cores: 2,
          memory_gb: 4,
          disk_gb: 40,
          location: "fsn1",
          city: null,
          country: null,
          network_zone: null,
          labels: null,
          backups: false,
          created_at: "2026-01-01T00:00:00.000Z",
          outgoing_traffic_bytes: null,
          ingoing_traffic_bytes: null,
          included_traffic_bytes: null,
          checked_at: NOW,
        },
      })),
    );
    await ingest(
      target.id,
      c["hetzner-cloud"],
      "hetzner-cloud",
      "cost_items",
      [
        ["server", "42", "42", "4.5"],
        ["backup", "42", "42", "0.9"],
        ["volume", "7", "unattached", null],
      ].map(([kind, id, resource, net]) => ({
        values: {
          item_kind: kind,
          item_id: id,
          name: kind,
          resource_id: resource,
          location: "fsn1",
          basis: "list price",
          monthly_net: net,
          monthly_gross: net,
          currency: "EUR",
          as_of: NOW,
        },
      })),
    );
    await ingest(target.id, c["http-check"], "http-check", "checks", [
      {
        values: {
          check_id: "chk1",
          name: "Shop home",
          url: "https://shop.example.test/",
          host: "shop.example.test",
          method: "GET",
          expected_status: "2xx",
          state: "down",
          reason: "timeout",
          status_code: null,
          response_ms: null,
          checked_at: NOW,
          last_change_at: "2026-11-24T11:00:00.000Z",
        },
      },
    ]);
    await observe(target.id, c.posthog, "posthog", "posthog.dau", [
      { resource: "ph-1", day: "2026-11-22", value: 50 },
      { resource: "ph-1", day: "2026-11-23", value: 70 },
      // Today's partial day is not yet "active users".
      { resource: "ph-1", day: "2026-11-24", value: 99 },
      // A second PostHog project of the same workspace project.
      { resource: "ph-3", day: "2026-11-22", value: 1 },
      { resource: "ph-3", day: "2026-11-23", value: 6 },
      { resource: "ph-2", day: "2026-11-23", value: 5 },
    ]);
    await observe(target.id, c.posthog, "posthog", "posthog.mau", [
      { resource: "ph-1", day: "2026-11-23", value: 900 },
      { resource: "ph-2", day: "2026-11-23", value: 40 },
    ]);
    await observe(target.id, c.vercel, "vercel", "vercel.visitors", [
      { resource: "prj_web", day: "2026-11-22", value: 10 },
      { resource: "prj_web", day: "2026-11-23", value: 15 },
    ]);
    const web = target.projects.web;
    result = await service().install(actor(target.id), {
      requestId: randomUUID(),
      name: "Developer Portfolio",
      connections: Object.values(c),
      links: [
        { connectionId: c.vercel, resourceId: "prj_web", projectId: web },
        { connectionId: c["hetzner-cloud"], resourceId: "42", projectId: web },
        { connectionId: c["hetzner-cloud"], resourceId: "43", projectId: web },
        { connectionId: c.posthog, resourceId: "ph-3", projectId: web },
        { connectionId: c["http-check"], resourceId: "chk1", projectId: web },
        { connectionId: c.posthog, resourceId: "ph-1", projectId: web },
        {
          connectionId: c.posthog,
          resourceId: "ph-2",
          projectId: target.projects.api,
        },
        {
          connectionId: c.railway,
          resourceId: "rw-1",
          projectId: target.projects.api,
        },
      ],
    });
    // Far east of UTC: the workspace's "today" is already 2026-11-25 at
    // NOW, while the template's rows are dated in UTC.
    await owner`update workspaces set time_zone = 'Pacific/Kiritimati'
      where id = ${target.id}`;
  }, TIMEOUT_MS);

  const day = (value: string): DataExpression => ({
    kind: "literal",
    type: "date",
    value,
  });
  const dayField: DataExpression = { kind: "field", fieldId: "day" };
  /** Yesterday (UTC 2026-11-23), as the widgets' previous window of "today" reads it. */
  const today: DataExpression = {
    kind: "call",
    fn: "and",
    args: [
      { kind: "call", fn: "gte", args: [dayField, day("2026-11-23")] },
      { kind: "call", fn: "lte", args: [dayField, day("2026-11-23")] },
    ],
  };
  const query = (
    modelId: string,
    measureIds: string[],
    groupBy: string[],
    filter?: DataExpression,
  ) =>
    createDataService(db, () => new Date(NOW)).query(
      actor(target.id),
      modelId,
      {
        measureIds,
        groupBy,
        ...(filter ? { filter } : {}),
      },
    );
  const byProject = (
    rows: {
      dimensions: Record<string, unknown>;
      measures: Record<string, { value: unknown }>;
    }[],
    measure: string,
  ) =>
    Object.fromEntries(
      rows.map((row) => [
        String(row.dimensions.project),
        Number(row.measures[measure]!.value),
      ]),
    );

  it("sums costs per project and provider, net and effective, per currency", async () => {
    const costs = await query(
      result.models.costs!,
      ["cost"],
      ["project", "provider", "currency"],
    );
    const cost = (project: string, provider: string) =>
      Number(
        costs.rows.find(
          (row) =>
            row.dimensions.project === project &&
            row.dimensions.provider === provider,
        )?.measures.cost?.value,
      );
    expect(cost(projectProduct(target.projects.api), "railway")).toBe(12.5);
    // Vercel's effective cost, not the billed one.
    expect(cost(projectProduct(target.projects.web), "vercel")).toBe(5);
    // Hetzner's net monthly price; an unpriced item adds nothing.
    expect(cost(projectProduct(target.projects.web), "hetzner")).toBe(5.4);
    // A team charge without a project is its team's (linkable by its ID).
    expect(cost(`${target.connections.vercel}:team`, "vercel")).toBe(20);
  });

  it("sums users per project from yesterday's complete UTC day", async () => {
    const users = await query(
      result.models.audience!,
      ["dau", "mau", "visitors"],
      ["project"],
      today,
    );
    // Two PostHog projects of one workspace project: 70 + 6 on the same
    // day, not today's partial 99 nor anybody's "newest" day.
    expect(byProject(users.rows, "dau")).toMatchObject({
      [projectProduct(target.projects.web)]: 76,
      [projectProduct(target.projects.api)]: 5,
    });
    expect(byProject(users.rows, "mau")).toMatchObject({
      [projectProduct(target.projects.web)]: 900,
      [projectProduct(target.projects.api)]: 40,
    });
    expect(
      byProject(users.rows, "visitors")[projectProduct(target.projects.web)],
    ).toBe(15);
    const total = await query(result.models.audience!, ["dau"], [], today);
    expect(Number(total.rows[0]!.measures.dau!.value)).toBe(81);
  });

  it("counts deploys per day and keeps Vercel previews out", async () => {
    const deploys = await query(
      result.models.deploys!,
      ["deploys", "failed_deploys"],
      ["provider", "day"],
    );
    const on = (provider: string, day: string) =>
      deploys.rows.find(
        (row) =>
          row.dimensions.provider === provider && row.dimensions.day === day,
      )?.measures;
    expect(Number(on("railway", "2026-11-24")!.deploys!.value)).toBe(3);
    expect(Number(on("railway", "2026-11-24")!.failed_deploys!.value)).toBe(1);
    expect(Number(on("vercel", "2026-11-24")!.deploys!.value)).toBe(1);
  });

  it("keeps two services of one name apart in the latest deploys", async () => {
    const latest = await query(
      result.models.deploys!,
      ["last_deploy"],
      ["service"],
    );
    const railway = latest.rows.filter((row) =>
      String(row.dimensions.service).startsWith(target.connections.railway),
    );
    expect(
      railway.map((row) => [
        row.dimensions.service,
        row.dimensionLabels?.service,
      ]),
    ).toEqual([
      [`${target.connections.railway}:s1`, "api"],
      [`${target.connections.railway}:s2`, "api"],
    ]);
  });

  it("resolves a project's slide freshness through the links table", async () => {
    const apps = await withWorkspace(db, { workspaceId: target.id }, (tx) =>
      mappedProductApps(tx, target.id, new Set([result.linksDatasetId]), {
        now: new Date(NOW),
      }),
    );
    expect(apps.get(projectProduct(target.projects.web))?.sort()).toEqual(
      [
        `${target.connections.vercel}:prj_web`,
        `${target.connections["hetzner-cloud"]}:42`,
        `${target.connections["hetzner-cloud"]}:43`,
        `${target.connections["http-check"]}:chk1`,
        `${target.connections.posthog}:ph-1`,
        `${target.connections.posthog}:ph-3`,
      ].sort(),
    );
  });

  it("states every service, server and check with its project", async () => {
    const states = await query(
      result.models.state!,
      ["items"],
      ["project", "item", "state", "rolled_back"],
    );
    expect(
      states.rows
        .map((row) => [
          row.dimensions.project,
          row.dimensionLabels?.item ?? row.dimensions.item,
          row.dimensions.state,
          row.dimensions.rolled_back,
        ])
        .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    ).toEqual(
      [
        [
          projectProduct(target.projects.api),
          "api · production",
          "failed",
          false,
        ],
        [projectProduct(target.projects.web), "db-1", "up", false],
        [projectProduct(target.projects.web), "db-1", "up", false],
        [projectProduct(target.projects.web), "Shop home", "down", false],
        [projectProduct(target.projects.web), "web", "up", true],
      ].sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    );
  });

  it("gives every linked project a slide its scope narrows, and filters every widget", async () => {
    const dashboard = (await withWorkspace(
      db,
      { workspaceId: target.id },
      (tx) => findDashboard(tx, target.id, result.dashboardId),
    ))!;
    expect(dashboard.slides.map((slide) => slide.name)).toEqual([
      "Overview",
      "Public API",
      "Web shop",
    ]);
    const web = dashboard.slides.find((slide) => slide.name === "Web shop")!;
    expect(web.widgets.map((widget) => widget.type).sort()).toEqual([
      "measure",
      "measure",
      "measure",
      "state",
    ]);
    // Every model-bound widget is mapped by the project filter.
    const filters = dashboard.dataFilters as {
      id: string;
      mappings: { modelId: string }[];
    }[];
    const project = filters.find((filter) => filter.id === "project")!;
    for (const slide of dashboard.slides)
      for (const widget of slide.widgets) {
        const binding = (widget as { binding?: { modelId: string } }).binding;
        if (binding)
          expect(project.mappings.map((m) => m.modelId)).toContain(
            binding.modelId,
          );
      }
    // The overview, filtered to one project, and the project's own slide
    // (its scope) read the same project's numbers.
    const read = (
      slideName: string,
      values: Record<string, { kind: "values"; values: string[] }>,
    ) =>
      withWorkspace(db, { workspaceId: target.id }, async (tx) => {
        const slides = await tx.select().from(schema.dashboardSlides);
        const widgets = await tx.select().from(schema.dashboardWidgets);
        const slide = slides.find(
          (row) =>
            row.dashboardId === result.dashboardId && row.name === slideName,
        )!;
        return queryDashboardData(
          tx,
          target.id,
          [
            {
              scope: slide.scope,
              widgets: widgets.filter((widget) => widget.slideId === slide.id),
            },
          ],
          dashboard.dataFilters,
          values,
          new Date(NOW),
        );
      });
    const filtered = await read("Overview", {
      project: {
        kind: "values",
        values: [projectProduct(target.projects.web)],
      },
    });
    const scoped = await read("Web shop", {});
    const costCells = (data: Awaited<ReturnType<typeof read>>) =>
      data.widgets
        .filter((widget) => widget.metadata?.modelId === result.models.costs)
        .flatMap((widget) =>
          widget.result!.rows.map((row) => [
            row.dimensions.provider,
            Number(row.measures.cost!.value),
          ]),
        )
        .sort();
    expect(costCells(filtered)).toEqual([
      ["hetzner", 5.4],
      ["vercel", 5],
    ]);
    expect(costCells(scoped)).toEqual(costCells(filtered));
    // The lists (every item); the overview's summary beside its list
    // (owner decision A) shows the most urgent one and the counts.
    const stateNames = (data: Awaited<ReturnType<typeof read>>) =>
      data.states
        .filter((state) => state.items.length === state.total)
        .flatMap((state) => state.items.map((item) => item.name));
    const summary = filtered.states.find(
      (state) => state.items.length === 1 && state.total === 4,
    );
    expect(summary?.items[0]?.name).toBe("Web shop · Shop home");
    // The overview names each item with its project; the slide by itself.
    expect(stateNames(filtered).sort()).toEqual([
      "Web shop · Shop home",
      "Web shop · db-1",
      "Web shop · db-1",
      "Web shop · web",
    ]);
    expect(stateNames(scoped).sort()).toEqual([
      "Shop home",
      "db-1",
      "db-1",
      "web",
    ]);
    // Deploys "today" and active users read UTC days (#876): the
    // workspace's zone is already on 2026-11-25.
    const overview = await read("Overview", {});
    const cells = (modelId: string, measure: string, dimension: string) =>
      overview.widgets
        .filter((widget) => widget.metadata?.modelId === modelId)
        .flatMap((widget) =>
          widget.result!.rows.map((row) => [
            row.dimensionLabels?.[dimension] ?? row.dimensions[dimension],
            Number(row.measures[measure]!.value),
          ]),
        )
        .sort();
    expect(cells(result.models.deploys!, "deploys", "provider")).toEqual([
      ["Railway", 3],
      ["Vercel", 1],
    ]);
    expect(cells(result.models.audience!, "dau", "project")).toEqual([
      ["Public API", 5],
      ["Web shop", 76],
    ]);
    const shown = await withWorkspace(db, { workspaceId: target.id }, (tx) =>
      presentDashboard(tx, target.id, dashboard, "en", {}),
    );
    expect(shown).toBeDefined();
  });
});
