import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  createRawSqlClient,
  createWorkspace,
  schema,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";
import {
  errorResponseSchema,
  meResponseSchema,
  storeTemplateInstallListSchema,
  storeTemplatePlanSchema,
  storeTemplateUpdateSchema,
  workspaceResponseSchema,
  type StoreTemplatePlan,
} from "@netrics/contracts";
import {
  DEFAULT_DATA_POLICY,
  type DataPolicy,
  type PreparationGraph,
  type SemanticModelDefinition,
} from "@netrics/domain";
import { createDataService } from "../data/service.js";
import { buildApp } from "../app.js";
import { createAuthService } from "../auth/index.js";
import { createDefaultRegistry } from "../connectors.js";
import { loadConfig } from "../env.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
  type TestDatabase,
} from "../test-db.js";
import { createStoreTemplateService } from "./store-template-service.js";
import { createStoreTemplateUpdateService } from "./store-template-updates.js";
import { ensureInstallCompleted } from "./store-template-legacy.js";
import {
  dashboardItems,
  normalizeTemplateDashboard,
} from "./store-template-items.js";
import {
  storeTemplate,
  type StoreTemplateDefinition,
  type StoreTemplateRecord,
} from "./store-template.js";
import { now } from "./test-helpers.js";

/**
 * Version 2 of the store template, as a fixture: renames the downloads
 * measure and adds `downloads_avg`, renames the store-name step of every
 * source preparation, removes the ratings widget and adds a summary widget.
 * `ratings` decides what happens to the ratings widget instead.
 */
function fixture(
  ratings: "remove" | "retitle" | "keep",
  options: { slideName?: string } = {},
): StoreTemplateDefinition {
  return {
    version: 2,
    keys: (inputs) => storeTemplate.keys(inputs),
    build(key, inputs, ids): StoreTemplateRecord {
      const record = storeTemplate.build(key, inputs, ids);
      if (record.kind === "model" && key === "model:downloads") {
        const definition = structuredClone(record.definition);
        const downloads = definition.measures[0]!;
        downloads.name = "Downloads (v2)";
        definition.measures.push({ ...downloads, id: "downloads_avg" });
        return { ...record, definition };
      }
      if (
        record.kind === "preparation" &&
        key.startsWith("preparation:source:")
      ) {
        const graph = structuredClone(record.graph);
        const step = graph.nodes.find((n) => n.id === "calculate_store_name");
        if (step?.type === "calculate") step.name = "Store name (v2)";
        return { ...record, graph };
      }
      if (record.kind === "dashboard") {
        const request = structuredClone(record.request);
        if (options.slideName) request.slides![0]!.name = options.slideName;
        const widgets = request.slides![0]!.widgets!;
        const ratingsWidget = widgets[2]!;
        if (ratings === "remove") widgets.splice(2, 1);
        if (ratings === "retitle") ratingsWidget.title = "Ratings (v2)";
        widgets.push({ ...widgets[0]!, x: 0, y: 8, title: "Summary" } as never);
        return {
          ...record,
          request,
          widgetKeys: [
            "widget:downloads",
            "widget:proceeds",
            ...(ratings === "remove" ? [] : ["widget:ratings"]),
            "widget:summary",
          ],
        };
      }
      return record;
    },
  };
}
const v2 = fixture("remove");

let test: TestDatabase, db: Database, owner: Sql, userId: string;
const registry = createDefaultRegistry();
const actor = (workspaceId: string) => ({
  workspaceId,
  callerId: userId,
  locale: "en" as const,
});
const updates = (template?: StoreTemplateDefinition, policy?: DataPolicy) =>
  createStoreTemplateUpdateService({
    db,
    registry,
    now: () => new Date(now),
    ...(template ? { template } : {}),
    ...(policy ? { policy } : {}),
  });
const item = (plan: StoreTemplatePlan, ref: string) =>
  plan.records.flatMap((record) => record.items).find((i) => i.ref === ref);
const items = (plan: StoreTemplatePlan) =>
  plan.records.flatMap((record) => record.items);

/** A workspace with its own store connections and one install of them. */
async function installIn(
  connectors: ("app-store-connect" | "google-play")[],
  options: { appScope?: boolean } = {},
) {
  const workspaceId = await createWorkspace(db, {
    name: "Stores " + randomUUID().slice(0, 8),
    ownerUserId: userId,
  });
  const connections = [];
  for (const connectorId of connectors) {
    const [connection] = await withWorkspace(db, { workspaceId }, (tx) =>
      tx
        .insert(schema.connections)
        .values({
          workspaceId,
          connectorId,
          name: connectorId === "google-play" ? "Play account" : "Apple team",
          setupPending: false,
        })
        .returning(),
    );
    connections.push(connection!);
  }
  const requestId = randomUUID();
  const installed = await createStoreTemplateService({
    db,
    registry,
    now: () => new Date(now),
  }).install(actor(workspaceId), {
    requestId,
    name: "App portfolio",
    connections: connections.map((c) => c.id),
    groups: [],
    ...(options.appScope
      ? { appScope: { connectionId: connections[0]!.id, appId: "a" } }
      : {}),
  });
  return { workspaceId, requestId, installed, connections };
}

async function modelDefinition(id: string): Promise<SemanticModelDefinition> {
  const [row] = await owner`select definition from data_models where id=${id}`;
  return row!.definition as SemanticModelDefinition;
}

/**
 * Turns an install into one made before template versions, as the 0072
 * migration left it: no inputs, `legacy:<id>` preparation keys, the
 * dashboard rows as the original and no widget keys.
 */
async function makeLegacy(workspaceId: string, requestId: string) {
  await owner`update data_template_installs set inputs=null
    where workspace_id=${workspaceId} and request_id=${requestId}`;
  await owner`update data_template_records set key='legacy:' || record_id
    where workspace_id=${workspaceId} and request_id=${requestId} and kind='preparation'`;
  await owner`update data_template_records r set widget_keys=null,
    original=jsonb_build_object('legacySnapshot', jsonb_build_object(
      'dashboard', to_jsonb(d.*),
      'slides', coalesce((
        select jsonb_agg(to_jsonb(s.*) || jsonb_build_object('widgets', coalesce((
          select jsonb_agg(to_jsonb(wd.*) order by wd."y", wd."x", wd."id")
          from dashboard_widgets wd
          where wd.slide_id = s.id and wd.workspace_id = s.workspace_id
        ), '[]'::jsonb)) order by s.position)
        from dashboard_slides s
        where s.dashboard_id = d.id and s.workspace_id = d.workspace_id
      ), '[]'::jsonb)))
    from dashboards d
    where r.workspace_id=${workspaceId} and r.request_id=${requestId}
      and r.key='dashboard:portfolio' and d.id=r.record_id`;
}

beforeAll(async () => {
  test = await createTestDatabase();
  db = createDatabase(test.appUrl);
  owner = createRawSqlClient(test.adminUrl, { max: 1 });
  const [user] = await db
    .insert(schema.users)
    .values({ email: "store-updates@example.test", displayName: "Owner" })
    .returning();
  userId = user!.id;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);
afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
  await owner?.end({ timeout: 5 });
  await test?.drop();
});

const TIMEOUT_MS = 30_000;

describe("store-template updates", { timeout: TIMEOUT_MS }, () => {
  it("reports an update with a summary of the template's changes", async () => {
    const { workspaceId, requestId, installed } = await installIn([
      "app-store-connect",
      "google-play",
    ]);
    const current = await updates().list(actor(workspaceId));
    expect(current.installs).toEqual([
      expect.objectContaining({
        requestId,
        templateVersion: 1,
        latestVersion: 1,
        updateAvailable: false,
        summary: null,
        error: null,
        openUpdate: null,
      }),
    ]);
    const { installs } = await updates(v2).list(actor(workspaceId));
    expect(installs[0]).toMatchObject({
      name: "App portfolio",
      templateVersion: 1,
      latestVersion: 2,
      updateAvailable: true,
      summary: {
        measures: { added: 1, changed: 1, removed: 0 },
        steps: { added: 0, changed: 6, removed: 0 },
        widgets: { added: 1, changed: 0, removed: 1 },
        conflicts: 0,
        removals: 1,
      },
      dashboardIds: [installed.dashboardId],
    });
    expect(installs[0]!.modelIds.sort()).toEqual(
      Object.values(installed.models).sort(),
    );
    expect(installs[0]!.preparationIds.sort()).toEqual(
      [...installed.preparationIds].sort(),
    );
    expect(storeTemplateInstallListSchema.parse({ installs })).toBeTruthy();
  });

  it("reads a fresh install as unchanged by the customer", async () => {
    const { workspaceId, requestId, connections } = await installIn([
      "google-play",
    ]);
    const plan = await updates(v2).plan(actor(workspaceId), requestId);
    // Exactly the fixture's changes: any other item would be a difference
    // between how the template builds a record and how it is stored.
    const source = (metric: string) =>
      `preparation:source:${connections[0]!.id}:${metric}#step:calculate_store_name`;
    expect(
      items(plan)
        .filter((i) => i.outcome === "template")
        .map((i) => i.ref)
        .sort(),
    ).toEqual(
      [
        "model:downloads#measure:downloads",
        "model:downloads#measure:downloads_avg",
        source("downloads"),
        source("proceeds"),
        source("ratings"),
        "dashboard:portfolio#widget:summary",
      ].sort(),
    );
    expect(items(plan).filter((i) => i.outcome !== "template")).toEqual([
      expect.objectContaining({
        ref: "dashboard:portfolio#widget:ratings",
        outcome: "propose_removal",
      }),
    ]);
    expect(plan).toMatchObject({ fromVersion: 1, toVersion: 2 });
    expect(plan.basis).toMatch(/^[0-9a-f]{64}$/);
  });

  it("lists customer-only changes as kept and both-changed items as choices", async () => {
    const { workspaceId, requestId, installed, connections } = await installIn([
      "app-store-connect",
    ]);
    const before = await updates(v2).plan(actor(workspaceId), requestId);
    // A draft of the downloads model renames its measure and adds one.
    const definition = await modelDefinition(installed.models.downloads);
    definition.measures[0]!.name = "Our downloads";
    definition.measures.push({
      ...definition.measures[0]!,
      id: "custom_total",
    });
    await owner`update data_models set definition=${owner.json(definition as never)}, version=version+1
      where id=${installed.models.downloads}`;
    // A published edit of the store-name step, and of the app-key step.
    const source = `preparation:source:${connections[0]!.id}:downloads`;
    const [prep] =
      await owner`select record_id from data_template_records where key=${source} and workspace_id=${workspaceId}`;
    const [row] =
      await owner`select name, graph, version from data_preparations where id=${prep!.record_id}`;
    const graph = row!.graph as PreparationGraph;
    for (const [id, name] of [
      ["calculate_store_name", "Ours"],
      ["calculate_app_key", "Our key"],
    ]) {
      const node = graph.nodes.find((n) => n.id === id);
      if (node?.type === "calculate") node.name = name!;
    }
    const data = createDataService(db, () => new Date(now));
    const saved = await data.savePreparation(
      actor(workspaceId),
      { name: row!.name as string, graph, version: row!.version as number },
      prep!.record_id as string,
    );
    await data.publishPreparation(
      actor(workspaceId),
      saved.preparation.id,
      saved.preparation.version,
    );
    // A customer widget on the dashboard.
    await owner`insert into dashboard_widgets (slide_id, dashboard_id, workspace_id, type, x, y, w, h, text, options)
      select s.id, s.dashboard_id, s.workspace_id, 'text', 0, 12, 4, 2, 'Hello', '{}'::jsonb
      from dashboard_slides s where s.dashboard_id=${installed.dashboardId} and s.position=0`;

    const plan = await updates(v2).plan(actor(workspaceId), requestId);
    expect(item(plan, "model:downloads#measure:downloads")).toMatchObject({
      outcome: "choose",
      change: "changed",
      current: expect.objectContaining({ name: "Our downloads" }),
      next: expect.objectContaining({ name: "Downloads (v2)" }),
    });
    expect(item(plan, "model:downloads#measure:custom_total")).toMatchObject({
      outcome: "customer",
      change: "added",
    });
    expect(item(plan, "model:downloads#measure:downloads_avg")?.outcome).toBe(
      "template",
    );
    expect(item(plan, `${source}#step:calculate_store_name`)?.outcome).toBe(
      "choose",
    );
    expect(item(plan, `${source}#step:calculate_app_key`)?.outcome).toBe(
      "customer",
    );
    expect(item(plan, "dashboard:portfolio#widget:ratings")?.outcome).toBe(
      "propose_removal",
    );
    expect(
      items(plan).find((i) =>
        i.ref.startsWith("dashboard:portfolio#widget:custom:"),
      ),
    ).toMatchObject({ outcome: "customer", change: "added" });
    expect(plan.records.find((r) => r.key === "model:downloads")).toMatchObject(
      {
        recordId: installed.models.downloads,
        hasUnpublishedDraft: true,
      },
    );
    expect(
      plan.records.find((r) => r.key === source)!.hasUnpublishedDraft,
    ).toBe(false);
    // The summary counts the template's changes, not the customer's.
    expect(plan.summary).toMatchObject({
      measures: { added: 1, changed: 1, removed: 0 },
      widgets: { added: 1, changed: 0, removed: 1 },
      conflicts: 2,
      removals: 1,
    });
    // Any change of a record changes the basis.
    expect(plan.basis).not.toBe(before.basis);
  });

  it("never reports app-scope differences as conflicts", async () => {
    // Two installs of different connections compare the same way.
    const one = await installIn(["app-store-connect"], { appScope: true });
    const two = await installIn(["app-store-connect", "google-play"]);
    const plans = [
      await updates(v2).plan(actor(one.workspaceId), one.requestId),
      await updates(v2).plan(actor(two.workspaceId), two.requestId),
    ];
    for (const plan of plans)
      expect(items(plan).filter((i) => i.outcome === "choose")).toEqual([]);
    expect(item(plans[0]!, "model:downloads#measure:downloads")).toEqual(
      item(plans[1]!, "model:downloads#measure:downloads"),
    );
    // The install's apps change (a second connection, no app scope): the
    // per-connection preparations, the append tree, the models' datasets and
    // the app filter's fixed value follow, as scope.
    const [extra] = await withWorkspace(
      db,
      { workspaceId: one.workspaceId },
      (tx) =>
        tx
          .insert(schema.connections)
          .values({
            workspaceId: one.workspaceId,
            connectorId: "google-play",
            name: "Play account",
            setupPending: false,
          })
          .returning(),
    );
    const [install] =
      await owner`select inputs from data_template_installs where request_id=${one.requestId}`;
    const inputs = install!.inputs as {
      connections: unknown[];
      fixedProduct: string | null;
    };
    inputs.connections.push({
      id: extra!.id,
      name: "Play account",
      connectorId: "google-play",
      datasets: {
        install_rows: randomUUID(),
        earning_rows: randomUUID(),
        store_ratings: randomUUID(),
      },
    });
    inputs.fixedProduct = null;
    await owner`update data_template_installs set inputs=${owner.json(inputs as never)} where request_id=${one.requestId}`;
    const plan = await updates(v2).plan(actor(one.workspaceId), one.requestId);
    // Changed inputs are a different basis.
    expect(plan.basis).not.toBe(plans[0]!.basis);
    expect(items(plan).filter((i) => i.outcome === "choose")).toEqual([]);
    for (const ref of [
      `preparation:source:${extra!.id}:downloads#step:raw`,
      "preparation:append:downloads:0:0#step:append_0_0",
      "model:downloads#settings:datasets",
      "dashboard:portfolio#filter:app.fixedValue",
    ])
      expect(item(plan, ref)?.outcome, ref).toBe("scope");
    expect(plan.summary.steps.added).toBe(0);
    expect(
      plan.records.find(
        (r) => r.key === `preparation:source:${extra!.id}:downloads`,
      ),
    ).toMatchObject({ recordId: null });
  });

  it("says up to date when the install has the latest version", async () => {
    const { workspaceId, requestId } = await installIn(["google-play"]);
    await expect(updates().plan(actor(workspaceId), requestId)).rejects.toThrow(
      "store_template_up_to_date",
    );
    await expect(
      updates(v2).plan(actor(workspaceId), randomUUID()),
    ).rejects.toThrow("store_template_not_found");
  });

  it("reads every shape of a dashboard original the same way", async () => {
    const { workspaceId, requestId } = await installIn(["app-store-connect"]);
    const reference = await updates(v2).plan(actor(workspaceId), requestId);
    const [record] =
      await owner`select original from data_template_records where request_id=${requestId} and key='dashboard:portfolio'`;
    const original = record!.original as {
      request: never;
      widgetKeys: string[];
    };
    // A request without its key order (installs before template updates).
    await owner`update data_template_records set original=${owner.json({ request: original.request })}
      where request_id=${requestId} and key='dashboard:portfolio'`;
    expect(await updates(v2).plan(actor(workspaceId), requestId)).toEqual(
      reference,
    );
    // Already normalized, with symbolic references.
    const rows =
      await owner`select key, record_id from data_template_records where request_id=${requestId}`;
    const idsToKeys = new Map(
      rows.map((row) => [row.record_id as string, row.key as string]),
    );
    const normalized = normalizeTemplateDashboard(
      original.request,
      original.widgetKeys,
      idsToKeys,
    );
    await owner`update data_template_records set original=${owner.json({ normalized } as never)}
      where request_id=${requestId} and key='dashboard:portfolio'`;
    expect(await updates(v2).plan(actor(workspaceId), requestId)).toEqual(
      reference,
    );
    expect(
      dashboardItems("dashboard:portfolio", normalized).size,
    ).toBeGreaterThan(0);
    // The migrated row snapshot (an install made before versions).
    // Its basis differs: the inputs are derived (no install-time groups).
    await makeLegacy(workspaceId, requestId);
    expect(await updates(v2).plan(actor(workspaceId), requestId)).toEqual({
      ...reference,
      basis: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("counts a template widget deleted before the migration as the customer's deletion", async () => {
    const { workspaceId, requestId, installed } = await installIn([
      "app-store-connect",
      "google-play",
    ]);
    // Before versions existed, the customer deleted the ratings widget and
    // added one of their own.
    await owner`delete from dashboard_widgets where dashboard_id=${installed.dashboardId} and model_id=${installed.models.ratings}`;
    await owner`insert into dashboard_widgets (slide_id, dashboard_id, workspace_id, type, x, y, w, h, text, options)
      select s.id, s.dashboard_id, s.workspace_id, 'text', 0, 4, 4, 2, 'Mine', '{}'::jsonb
      from dashboard_slides s where s.dashboard_id=${installed.dashboardId} and s.position=0`;
    await makeLegacy(workspaceId, requestId);

    const kept = await updates(fixture("keep")).plan(
      actor(workspaceId),
      requestId,
    );
    expect(item(kept, "dashboard:portfolio#widget:ratings")).toBeUndefined();
    expect(item(kept, "dashboard:portfolio#widget:summary")?.outcome).toBe(
      "template",
    );
    expect(kept.summary.widgets).toEqual({ added: 1, changed: 0, removed: 0 });
    expect(
      items(kept).find((i) => i.ref.includes("#widget:custom:")),
    ).toMatchObject({ outcome: "customer", change: "added" });
    // The customer removed what the template changes: their choice.
    const retitled = await updates(fixture("retitle")).plan(
      actor(workspaceId),
      requestId,
    );
    expect(item(retitled, "dashboard:portfolio#widget:ratings")).toMatchObject({
      outcome: "choose",
      change: "changed",
    });
    // The template removes it too: nothing to decide.
    const removed = await updates(v2).plan(actor(workspaceId), requestId);
    expect(item(removed, "dashboard:portfolio#widget:ratings")).toBeUndefined();
    // Reading status and plans completes the baseline in memory only.
    await updates(v2).list(actor(workspaceId));
    const [install] =
      await owner`select inputs from data_template_installs where request_id=${requestId}`;
    expect(install!.inputs).toBeNull();
    const keys =
      await owner`select key from data_template_records where request_id=${requestId} and key like 'legacy:%'`;
    expect(keys.length).toBeGreaterThan(0);
  });

  it("keeps template slides apart from slides the customer inserts", async () => {
    const { workspaceId, requestId, installed } = await installIn([
      "google-play",
    ]);
    const reference = await updates(v2).plan(actor(workspaceId), requestId);
    // The customer puts a slide of their own in front of the template's.
    await owner`update dashboard_slides set position = position + 1 where dashboard_id=${installed.dashboardId}`;
    await owner`insert into dashboard_slides (dashboard_id, workspace_id, position, name)
      values (${installed.dashboardId}, ${workspaceId}, 0, 'Mine')`;
    const plan = await updates(v2).plan(actor(workspaceId), requestId);
    const byRef = (p: StoreTemplatePlan) =>
      Object.fromEntries(
        items(p)
          .filter((i) => !i.ref.includes("#slide:custom:"))
          .map((i) => [i.ref, i]),
      );
    // The template's changes apply as before, nothing becomes a conflict.
    expect(byRef(plan)).toEqual(byRef(reference));
    expect(items(plan).filter((i) => i.outcome === "choose")).toEqual([]);
    expect(
      items(plan).find((i) => i.ref.includes("#slide:custom:")),
    ).toMatchObject({ outcome: "customer", change: "added" });
    // The new widget lands on the template's slide, not on position 0.
    expect(item(plan, "dashboard:portfolio#widget:summary")).toMatchObject({
      outcome: "template",
      next: expect.objectContaining({ slide: "slide:0" }),
    });
    // The install stored the template slide's key with its widgets' keys.
    const [record] =
      await owner`select widget_keys from data_template_records where request_id=${requestId} and key='dashboard:portfolio'`;
    expect(Object.values(record!.widget_keys as object)).toContain("slide:0");
  });

  it("finds the template slide by its template widgets when no slide key was stored", async () => {
    const { workspaceId, requestId, installed } = await installIn([
      "google-play",
    ]);
    // An install keyed before slides were: its widget keys only.
    const [templateSlide] =
      await owner`select id, name from dashboard_slides where dashboard_id=${installed.dashboardId}`;
    await owner`update data_template_records set widget_keys = widget_keys - ${templateSlide!.id as string}::text
      where request_id=${requestId} and key='dashboard:portfolio'`;
    // In front of it, a customer slide that looks exactly like it.
    await owner`update dashboard_slides set position = position + 1 where dashboard_id=${installed.dashboardId}`;
    const [mine] =
      await owner`insert into dashboard_slides (dashboard_id, workspace_id, position, name)
      values (${installed.dashboardId}, ${workspaceId}, 0, ${templateSlide!.name as string}) returning id`;
    const plan = await updates(
      fixture("remove", { slideName: "Portfolio v2" }),
    ).plan(actor(workspaceId), requestId);
    // The template's slide change targets the template's slide; the
    // customer's slide is theirs.
    expect(item(plan, "dashboard:portfolio#slide:0")).toMatchObject({
      outcome: "template",
      next: expect.objectContaining({ name: "Portfolio v2" }),
    });
    expect(
      item(plan, `dashboard:portfolio#slide:custom:${mine!.id as string}`),
    ).toMatchObject({ outcome: "customer", change: "added" });
    // Template widgets stay on the template slide: no change, no conflict.
    expect(item(plan, "dashboard:portfolio#widget:downloads")).toBeUndefined();
    expect(items(plan).filter((i) => i.outcome === "choose")).toEqual([]);
    expect(item(plan, "dashboard:portfolio#widget:summary")).toMatchObject({
      outcome: "template",
      next: expect.objectContaining({ slide: "slide:0" }),
    });
  });

  it("plans the same before and after the baseline is written", async () => {
    for (const legacy of [false, true]) {
      const { workspaceId, requestId } = await installIn([
        "app-store-connect",
        "google-play",
      ]);
      if (legacy) await makeLegacy(workspaceId, requestId);
      const read = await updates(v2).plan(actor(workspaceId), requestId);
      await withWorkspace(db, { workspaceId }, (tx) =>
        ensureInstallCompleted(tx, workspaceId, requestId),
      );
      const [install] =
        await owner`select inputs from data_template_installs where request_id=${requestId}`;
      expect(install!.inputs).not.toBeNull();
      const written = await updates(v2).plan(actor(workspaceId), requestId);
      expect(written.basis).toBe(read.basis);
      expect(written).toEqual(read);
    }
  });

  it("reports a baseline that cannot be read instead of a wrong plan", async () => {
    const { workspaceId, requestId, connections } = await installIn([
      "app-store-connect",
      "google-play",
    ]);
    await makeLegacy(workspaceId, requestId);
    // A connection the install used is gone: its inputs cannot be derived.
    await owner`delete from connections where id=${connections[1]!.id}`;
    const { installs } = await updates(v2).list(actor(workspaceId));
    expect(installs[0]).toMatchObject({
      updateAvailable: true,
      summary: null,
      error: "store_template_baseline_unavailable",
    });
    await expect(
      updates(v2).plan(actor(workspaceId), requestId),
    ).rejects.toThrow("store_template_baseline_unavailable");
  });
});

type Decisions = {
  ref: string;
  choice: "template" | "customer" | "remove" | "keep";
}[];
/** A choice for every item the plan asks about. */
const choices = (
  plan: StoreTemplatePlan,
  side: "template" | "customer",
): Decisions =>
  items(plan).flatMap((i): Decisions =>
    i.outcome === "choose"
      ? [{ ref: i.ref, choice: side }]
      : i.outcome === "propose_removal"
        ? [{ ref: i.ref, choice: side === "template" ? "remove" : "keep" }]
        : [],
  );
/** Every stored row of a dashboard, its slides and widgets. */
async function readDashboardData(dashboardId: string) {
  const [dashboard] =
    await owner`select to_jsonb(d.*) as row from dashboards d where id=${dashboardId}`;
  const slides =
    await owner`select to_jsonb(s.*) as row from dashboard_slides s where dashboard_id=${dashboardId} order by id`;
  const widgets =
    await owner`select to_jsonb(w.*) as row from dashboard_widgets w where dashboard_id=${dashboardId} order by id`;
  return {
    dashboard: dashboard!.row as unknown,
    slides: slides.map((r) => r.row as unknown),
    widgets: widgets.map((r) => r.row as unknown),
  };
}
/** Version and published version of every preparation and model. */
async function publishedState(workspaceId: string) {
  const preparations =
    await owner`select id, version, published_version from data_preparations where workspace_id=${workspaceId} order by id`;
  const models =
    await owner`select id, version, published_version from data_models where workspace_id=${workspaceId} order by id`;
  return { preparations: [...preparations], models: [...models] };
}
async function preparationRow(id: string) {
  const [row] =
    await owner`select name, graph, version, published_version from data_preparations where id=${id}`;
  return row as {
    name: string;
    graph: PreparationGraph;
    version: number;
    published_version: number | null;
  };
}
async function recordOf(requestId: string, key: string) {
  const [row] =
    await owner`select * from data_template_records where request_id=${requestId} and key=${key}`;
  return row;
}
const strings = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(strings)
      : value !== null && typeof value === "object"
        ? Object.values(value).flatMap(strings)
        : [];
/** Renames a step of a preparation as a draft (published when asked). */
async function editStep(
  workspaceId: string,
  id: string,
  step: string,
  name: string,
  publish: boolean,
) {
  const row = await preparationRow(id);
  const graph = structuredClone(row.graph);
  const node = graph.nodes.find((n) => n.id === step);
  if (node?.type === "calculate") node.name = name;
  const data = createDataService(db, () => new Date(now));
  const saved = await data.savePreparation(
    actor(workspaceId),
    { name: row.name, graph, version: row.version },
    id,
  );
  if (publish)
    await data.publishPreparation(
      actor(workspaceId),
      id,
      saved.preparation.version,
    );
}

/** A second store connection in the install's inputs (app scope grows). */
async function addConnection(workspaceId: string, requestId: string) {
  const [extra] = await withWorkspace(db, { workspaceId }, (tx) =>
    tx
      .insert(schema.connections)
      .values({
        workspaceId,
        connectorId: "google-play",
        name: "Play account",
        setupPending: false,
      })
      .returning(),
  );
  const [install] =
    await owner`select inputs from data_template_installs where request_id=${requestId}`;
  const inputs = install!.inputs as { connections: unknown[] };
  inputs.connections.push({
    id: extra!.id,
    name: "Play account",
    connectorId: "google-play",
    datasets: {
      install_rows: randomUUID(),
      earning_rows: randomUUID(),
      store_ratings: randomUUID(),
    },
  });
  await owner`update data_template_installs set inputs=${owner.json(inputs as never)} where request_id=${requestId}`;
  return extra!;
}
/** Everything an apply writes, to show a refused apply wrote nothing. */
async function writtenState(workspaceId: string, requestId: string) {
  return {
    data: await publishedState(workspaceId),
    install: [
      ...(await owner`select template_version, inputs from data_template_installs where request_id=${requestId}`),
    ],
    records: [
      ...(await owner`select key, record_id, template_version, original, detached_at
        from data_template_records where request_id=${requestId} order by key`),
    ],
    updates: [
      ...(await owner`select id, closed_at from data_template_updates where request_id=${requestId} order by id`),
    ],
    audit: [
      ...(await owner`select id from audit_events where workspace_id=${workspaceId}
        and action='data.store_template_update_applied'`),
    ],
  };
}
/**
 * The downloads model reads a second dataset in its original and current
 * state (the ratings source), with a customer measure on it; the new
 * template no longer has that dataset, so the measure reads nothing.
 */
async function measureOnDroppedDataset(
  workspaceId: string,
  requestId: string,
  modelId: string,
  connectionId: string,
) {
  const ratings = (await recordOf(
    requestId,
    `preparation:source:${connectionId}:ratings`,
  ))!.record_id as string;
  const dataset = `prepared:${ratings}:output`;
  const record = await recordOf(requestId, "model:downloads");
  const original = record!.original as { definition: SemanticModelDefinition };
  original.definition.datasets.push(dataset);
  await owner`update data_template_records set original=${owner.json(original as never)}
    where request_id=${requestId} and key='model:downloads'`;
  const definition = await modelDefinition(modelId);
  definition.datasets.push(dataset);
  definition.measures.push({
    ...definition.measures[0]!,
    id: "on_ratings",
    datasetId: dataset,
  } as never);
  await owner`update data_models set definition=${owner.json(definition as never)}, version=version+1
    where id=${modelId} and workspace_id=${workspaceId}`;
}

describe("applying a store-template update", { timeout: TIMEOUT_MS }, () => {
  it("keeps a dataset the customer added to a model, and what reads it", async () => {
    const { workspaceId, requestId, installed, connections } = await installIn([
      "app-store-connect",
    ]);
    // The customer's own preparation, read by a measure of theirs.
    const source = (await recordOf(
      requestId,
      `preparation:source:${connections[0]!.id}:downloads`,
    ))!.record_id as string;
    const data = createDataService(db, () => new Date(now));
    const { preparation: mine } = await data.savePreparation(
      actor(workspaceId),
      { name: "Mine", graph: (await preparationRow(source)).graph },
    );
    const dataset = `prepared:${mine.id}:output`;
    const definition = await modelDefinition(installed.models.downloads);
    definition.datasets.push(dataset);
    definition.measures.push({
      ...definition.measures[0]!,
      id: "mine_total",
      name: "Mine",
      datasetId: dataset,
    } as never);
    const { model: current } = await data.getModel(
      actor(workspaceId),
      installed.models.downloads,
    );
    await data.saveModel(
      actor(workspaceId),
      { name: current.name, definition, version: current.version },
      installed.models.downloads,
    );
    // The app scope grows too: the template's dataset becomes an append.
    await addConnection(workspaceId, requestId);
    const plan = await updates(v2).plan(actor(workspaceId), requestId);
    await updates(v2).apply(actor(workspaceId), requestId, {
      basis: plan.basis,
      decisions: choices(plan, "template"),
    });
    const append = (await recordOf(
      requestId,
      "preparation:append:downloads:0:0",
    ))!.record_id as string;
    const after = await modelDefinition(installed.models.downloads);
    expect(after.datasets).toEqual([
      expect.stringMatching(new RegExp(`^prepared:${append}:`)),
      dataset,
    ]);
    const byId = Object.fromEntries(after.measures.map((m) => [m.id, m]));
    expect(byId.mine_total).toMatchObject({ name: "Mine", datasetId: dataset });
    expect(byId.downloads).toMatchObject({
      name: "Downloads (v2)",
      datasetId: after.datasets[0],
    });
    expect(byId.downloads_avg).toMatchObject({ datasetId: after.datasets[0] });
    expect(
      after.dimensions.every((d) => d.datasetId === after.datasets[0]),
    ).toBe(true);
  });

  it("keeps a model on the dataset the customer swapped in, template changes included", async () => {
    const { workspaceId, requestId, installed, connections } = await installIn([
      "google-play",
    ]);
    const source = (await recordOf(
      requestId,
      `preparation:source:${connections[0]!.id}:downloads`,
    ))!.record_id as string;
    const data = createDataService(db, () => new Date(now));
    const { preparation: mine } = await data.savePreparation(
      actor(workspaceId),
      { name: "Mine", graph: (await preparationRow(source)).graph },
    );
    // The customer points the whole model at their own preparation.
    const template = `prepared:${source}:output`,
      dataset = `prepared:${mine.id}:output`;
    const definition = JSON.parse(
      JSON.stringify(await modelDefinition(installed.models.downloads))
        .split(template)
        .join(dataset),
    ) as SemanticModelDefinition;
    const { model: current } = await data.getModel(
      actor(workspaceId),
      installed.models.downloads,
    );
    await data.saveModel(
      actor(workspaceId),
      { name: current.name, definition, version: current.version },
      installed.models.downloads,
    );
    const plan = await updates(v2).plan(actor(workspaceId), requestId);
    expect(item(plan, "model:downloads#measure:downloads")?.outcome).toBe(
      "template",
    );
    await updates(v2).apply(actor(workspaceId), requestId, {
      basis: plan.basis,
      decisions: choices(plan, "template"),
    });
    const after = await modelDefinition(installed.models.downloads);
    expect(after.datasets).toEqual([dataset]);
    expect(JSON.stringify(after)).not.toContain(template);
    expect(after.measures.map((m) => [m.id, m.name])).toEqual([
      ["downloads", "Downloads (v2)"],
      ["downloads_avg", "Downloads (v2)"],
    ]);
    for (const measure of after.measures)
      expect(measure).toMatchObject({ datasetId: dataset });
  });

  it("asks before a new template measure brings back a dataset the customer removed", async () => {
    // Version 2 reads the ratings source in the downloads model too, with a
    // measure on it; installs made from it start with that dataset.
    const ratingsOf = (inputs: { connections: { id: string }[] }) =>
      `preparation:source:${inputs.connections[0]!.id}:ratings`;
    const reading: StoreTemplateDefinition = {
      ...v2,
      build(key, inputs, ids) {
        const record = v2.build(key, inputs, ids);
        if (record.kind !== "model" || key !== "model:downloads") return record;
        const definition = structuredClone(record.definition);
        const ratings = `prepared:${ids[ratingsOf(inputs)]!}:output`;
        definition.datasets.push(ratings);
        definition.measures.push({
          ...definition.measures[0]!,
          id: "on_ratings",
          name: "On ratings",
          datasetId: ratings,
        } as never);
        return { ...record, definition };
      },
    };
    for (const choice of ["customer", "template"] as const) {
      const { workspaceId, requestId, installed, connections } =
        await installIn(["google-play"]);
      // The original read the ratings source too; the customer removed it.
      const ratings = `prepared:${
        (await recordOf(
          requestId,
          `preparation:source:${connections[0]!.id}:ratings`,
        ))!.record_id as string
      }:output`;
      const record = await recordOf(requestId, "model:downloads");
      const original = record!.original as {
        definition: SemanticModelDefinition;
      };
      original.definition.datasets.push(ratings);
      await owner`update data_template_records set original=${owner.json(original as never)}
        where request_id=${requestId} and key='model:downloads'`;
      const plan = await updates(reading).plan(actor(workspaceId), requestId);
      const added = "model:downloads#measure:on_ratings";
      expect(item(plan, added)).toMatchObject({
        outcome: "choose",
        change: "added",
        reason: "reads_removed_dataset",
        dataset: `ref:preparation:source:${connections[0]!.id}:ratings:output`,
      });
      // The reason and dataset are part of the plan contract.
      expect(storeTemplatePlanSchema.parse(plan)).toEqual(plan);
      // The datasets item shows what the update writes: no ratings.
      expect(item(plan, "model:downloads#settings:datasets")).toBeUndefined();
      await updates(reading).apply(actor(workspaceId), requestId, {
        basis: plan.basis,
        decisions: [
          ...choices(plan, "template").filter((d) => d.ref !== added),
          { ref: added, choice },
        ],
      });
      const after = await modelDefinition(installed.models.downloads);
      const measures = after.measures.map((m) => m.id);
      if (choice === "customer") {
        expect(after.datasets).not.toContain(ratings);
        expect(measures).not.toContain("on_ratings");
      } else {
        expect(after.datasets).toContain(ratings);
        expect(after.measures.find((m) => m.id === "on_ratings")).toMatchObject(
          { datasetId: ratings },
        );
      }
    }
  });

  it("refuses a merge that would point at nothing, and writes nothing", async () => {
    const { workspaceId, requestId, installed, connections } = await installIn([
      "google-play",
    ]);
    await measureOnDroppedDataset(
      workspaceId,
      requestId,
      installed.models.downloads,
      connections[0]!.id,
    );
    const plan = await updates(v2).plan(actor(workspaceId), requestId);
    const before = await writtenState(workspaceId, requestId);
    const error = await updates(v2)
      .apply(actor(workspaceId), requestId, {
        basis: plan.basis,
        decisions: choices(plan, "template"),
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "store_update_unmergeable",
      status: 409,
      key: "model:downloads",
      refs: ["model:downloads#measure:on_ratings"],
    });
    expect(await writtenState(workspaceId, requestId)).toEqual(before);
  });

  it("writes nothing when the apply fails part-way", async () => {
    const { workspaceId, requestId } = await installIn(["app-store-connect"]);
    // Three new source and three append preparations; room for one more.
    await addConnection(workspaceId, requestId);
    const plan = await updates(v2).plan(actor(workspaceId), requestId);
    const before = await writtenState(workspaceId, requestId);
    const limited = { ...DEFAULT_DATA_POLICY, maxPreparations: 4 };
    await expect(
      updates(v2, limited).apply(actor(workspaceId), requestId, {
        basis: plan.basis,
        decisions: choices(plan, "template"),
      }),
    ).rejects.toMatchObject({ code: "data_preparation_limit", status: 413 });
    expect(await writtenState(workspaceId, requestId)).toEqual(before);
  });

  it("names the items a merged record fails validation on", async () => {
    // A broken template: the downloads measure loses its name.
    const broken: StoreTemplateDefinition = {
      ...v2,
      build(key, inputs, ids) {
        const record = v2.build(key, inputs, ids);
        if (record.kind !== "model" || key !== "model:downloads") return record;
        const definition = structuredClone(record.definition);
        definition.measures[0]!.name = "";
        return { ...record, definition };
      },
    };
    const { workspaceId, requestId } = await installIn(["google-play"]);
    const plan = await updates(broken).plan(actor(workspaceId), requestId);
    const before = await writtenState(workspaceId, requestId);
    await expect(
      updates(broken).apply(actor(workspaceId), requestId, {
        basis: plan.basis,
        decisions: choices(plan, "template"),
      }),
    ).rejects.toMatchObject({
      code: "store_update_unmergeable",
      status: 409,
      key: "model:downloads",
      refs: ["model:downloads#measure:downloads"],
      paths: ["measures.0.name"],
    });
    expect(await writtenState(workspaceId, requestId)).toEqual(before);
  });

  it("closes an update and leaves its drafts as ordinary drafts", async () => {
    const { workspaceId, requestId } = await installIn(["google-play"]);
    const first = await updates(v2).plan(actor(workspaceId), requestId);
    const update = await updates(v2).apply(actor(workspaceId), requestId, {
      basis: first.basis,
      decisions: choices(first, "template"),
    });
    const drafts = await publishedState(workspaceId);
    await updates(v2).closeUpdate(actor(workspaceId), requestId, update.id);
    // Drafts untouched, the update closed (once: closing again is a no-op).
    expect(await publishedState(workspaceId)).toEqual(drafts);
    await updates(v2).closeUpdate(actor(workspaceId), requestId, update.id);
    expect(
      (await updates(v2).list(actor(workspaceId))).installs[0]!.openUpdate,
    ).toBeNull();
    const audit =
      await owner`select target, metadata from audit_events where workspace_id=${workspaceId} and action='store_template_update.closed'`;
    expect(audit.map((row) => row.target as string)).toEqual([update.id]);
    // A new apply is allowed; it builds on the drafts as the customer's.
    const again = await updates(v2).plan(actor(workspaceId), requestId);
    const replaced = await updates(v2).apply(actor(workspaceId), requestId, {
      basis: again.basis,
      decisions: choices(again, "template"),
    });
    expect(replaced.id).not.toBe(update.id);
    // Unknown updates, and an update of another install, are not found.
    const other = await installIn(["google-play"]);
    const otherPlan = await updates(v2).plan(
      actor(other.workspaceId),
      other.requestId,
    );
    const otherUpdate = await updates(v2).apply(
      actor(other.workspaceId),
      other.requestId,
      { basis: otherPlan.basis, decisions: choices(otherPlan, "template") },
    );
    for (const [workspace, request, id] of [
      [workspaceId, requestId, randomUUID()],
      [workspaceId, requestId, otherUpdate.id],
      [workspaceId, other.requestId, otherUpdate.id],
    ] as const)
      await expect(
        updates(v2).closeUpdate(actor(workspace), request, id),
      ).rejects.toMatchObject({
        code: "store_template_update_not_found",
        status: 404,
      });
    expect(
      (await updates(v2).list(actor(other.workspaceId))).installs[0]!
        .openUpdate!.id,
    ).toBe(otherUpdate.id);
  });

  it("waits for an open update's drafts before applying again", async () => {
    const { workspaceId, requestId } = await installIn(["google-play"]);
    const first = await updates(v2).plan(actor(workspaceId), requestId);
    const update = await updates(v2).apply(actor(workspaceId), requestId, {
      basis: first.basis,
      decisions: choices(first, "template"),
    });
    const again = await updates(v2).plan(actor(workspaceId), requestId);
    const body = { basis: again.basis, decisions: choices(again, "template") };
    await expect(
      updates(v2).apply(actor(workspaceId), requestId, body),
    ).rejects.toMatchObject({ code: "store_update_open", status: 409 });
    const open = (await updates(v2).list(actor(workspaceId))).installs[0]!
      .openUpdate!;
    expect(open.id).toBe(update.id);
    expect(open.dashboards[0]!.ready).toBe(false);
    // Once the drafts are published, a new apply replaces the update.
    const data = createDataService(db, () => new Date(now));
    for (const draft of update.drafts)
      if (draft.kind === "preparation")
        await data.publishPreparation(
          actor(workspaceId),
          draft.recordId,
          draft.version,
        );
      else
        await data.publishModel(
          actor(workspaceId),
          draft.recordId,
          draft.version,
        );
    const replaced = await updates(v2).apply(
      actor(workspaceId),
      requestId,
      body,
    );
    expect(replaced.id).not.toBe(update.id);
    const rows =
      await owner`select id, closed_at from data_template_updates where request_id=${requestId} order by created_at, id`;
    expect(rows.filter((r) => r.closed_at === null).map((r) => r.id)).toEqual([
      replaced.id,
    ]);
  });

  it("writes drafts only: dashboards and published queries stay as they were", async () => {
    const { workspaceId, requestId, installed, connections } = await installIn([
      "app-store-connect",
      "google-play",
    ]);
    const plan = await updates(v2).plan(actor(workspaceId), requestId);
    const dashboardBefore = await readDashboardData(installed.dashboardId);
    const before = await publishedState(workspaceId);
    const update = await updates(v2).apply(actor(workspaceId), requestId, {
      basis: plan.basis,
      decisions: choices(plan, "template"),
    });
    expect(storeTemplateUpdateSchema.parse(update)).toEqual(update);
    expect(update).toMatchObject({ requestId, fromVersion: 1, toVersion: 2 });
    expect(update.drafts.every((d) => !d.published)).toBe(true);
    // The model and every source preparation the template changes.
    expect(update.drafts.map((d) => d.key).sort()).toEqual(
      [
        "model:downloads",
        ...connections.flatMap((c) =>
          ["downloads", "proceeds", "ratings"].map(
            (m) => `preparation:source:${c.id}:${m}`,
          ),
        ),
      ].sort(),
    );
    expect(await readDashboardData(installed.dashboardId)).toEqual(
      dashboardBefore,
    );
    const after = await publishedState(workspaceId);
    // Published versions untouched; only drafts were added.
    expect(after.models.map((m) => m.published_version)).toEqual(
      before.models.map((m) => m.published_version),
    );
    expect(after.preparations.map((p) => p.published_version)).toEqual(
      before.preparations.map((p) => p.published_version),
    );
    const data = createDataService(db, () => new Date(now));
    const { model } = await data.getModel(
      actor(workspaceId),
      installed.models.downloads,
    );
    expect(model.version).toBeGreaterThan(model.publishedVersion!);
    expect(model.definition.measures.map((m) => [m.id, m.name])).toEqual([
      ["downloads", "Downloads (v2)"],
      ["downloads_avg", "Downloads (v2)"],
    ]);
    const source = `preparation:source:${connections[0]!.id}:downloads`;
    const sourceRecord = await recordOf(requestId, source);
    const graph = (await preparationRow(sourceRecord!.record_id as string))
      .graph;
    expect(
      graph.nodes.find((n) => n.id === "calculate_store_name"),
    ).toMatchObject({ name: "Store name (v2)" });
    // The draft's references are real ids again.
    expect(strings(graph).filter((v) => /^(ref|new):/.test(v))).toEqual([]);
    // The dashboard waits for the published data: no copy yet.
    expect(update.dashboards).toEqual([
      {
        key: "dashboard:portfolio",
        originalId: installed.dashboardId,
        copyId: null,
        swappedAt: null,
        swappedBackAt: null,
        ready: false,
      },
    ]);
    // The install and its data records are at the new version; the
    // dashboard record keeps its original until its copy exists.
    const [install] =
      await owner`select template_version from data_template_installs where request_id=${requestId}`;
    expect(install!.template_version).toBe(2);
    expect(sourceRecord).toMatchObject({ template_version: 2 });
    expect(
      (sourceRecord!.original as { graph: PreparationGraph }).graph.nodes.find(
        (n) => n.id === "calculate_store_name",
      ),
    ).toMatchObject({ name: "Store name (v2)" });
    expect(await recordOf(requestId, "dashboard:portfolio")).toMatchObject({
      template_version: 1,
    });
    const [audit] =
      await owner`select metadata from audit_events where workspace_id=${workspaceId} and action='data.store_template_update_applied'`;
    expect(audit!.metadata).toEqual({
      requestId,
      fromVersion: 1,
      toVersion: 2,
    });
    const { installs } = await updates(v2).list(actor(workspaceId));
    expect(installs[0]!.openUpdate).toEqual(update);
  });

  it("keeps a customer-only measure and step change in the draft", async () => {
    const { workspaceId, requestId, installed, connections } = await installIn([
      "app-store-connect",
    ]);
    const definition = await modelDefinition(installed.models.downloads);
    definition.measures.push({
      ...definition.measures[0]!,
      id: "custom_total",
      name: "Our total",
    });
    const data = createDataService(db, () => new Date(now));
    const { model: current } = await data.getModel(
      actor(workspaceId),
      installed.models.downloads,
    );
    const saved = await data.saveModel(
      actor(workspaceId),
      { name: current.name, definition, version: current.version },
      installed.models.downloads,
    );
    await data.publishModel(
      actor(workspaceId),
      installed.models.downloads,
      saved.model.version,
    );
    const source = `preparation:source:${connections[0]!.id}:downloads`;
    const sourceId = (await recordOf(requestId, source))!.record_id as string;
    await editStep(workspaceId, sourceId, "calculate_app_key", "Our key", true);
    const plan = await updates(v2).plan(actor(workspaceId), requestId);
    await updates(v2).apply(actor(workspaceId), requestId, {
      basis: plan.basis,
      decisions: choices(plan, "template"),
    });
    const { model } = await data.getModel(
      actor(workspaceId),
      installed.models.downloads,
    );
    expect(model.definition.measures.map((m) => m.id)).toEqual([
      // A template addition follows the item before it in the template.
      "downloads",
      "downloads_avg",
      "custom_total",
    ]);
    const graph = (await preparationRow(sourceId)).graph;
    expect(graph.nodes.find((n) => n.id === "calculate_app_key")).toMatchObject(
      { name: "Our key" },
    );
    expect(
      graph.nodes.find((n) => n.id === "calculate_store_name"),
    ).toMatchObject({ name: "Store name (v2)" });
  });

  it("keeps an unpublished customer draft as the customer state", async () => {
    const { workspaceId, requestId, connections } = await installIn([
      "google-play",
    ]);
    const source = `preparation:source:${connections[0]!.id}:proceeds`;
    const sourceId = (await recordOf(requestId, source))!.record_id as string;
    await editStep(workspaceId, sourceId, "calculate_app_key", "Draft", false);
    const drafted = await preparationRow(sourceId);
    expect(drafted.version).toBeGreaterThan(drafted.published_version!);
    const plan = await updates(v2).plan(actor(workspaceId), requestId);
    expect(
      plan.records.find((r) => r.key === source)!.hasUnpublishedDraft,
    ).toBe(true);
    const update = await updates(v2).apply(actor(workspaceId), requestId, {
      basis: plan.basis,
      decisions: choices(plan, "template"),
    });
    const row = await preparationRow(sourceId);
    expect(row.version).toBe(drafted.version + 1);
    expect(row.published_version).toBe(drafted.published_version);
    expect(
      row.graph.nodes.find((n) => n.id === "calculate_app_key"),
    ).toMatchObject({ name: "Draft" });
    expect(
      row.graph.nodes.find((n) => n.id === "calculate_store_name"),
    ).toMatchObject({ name: "Store name (v2)" });
    // Steps keep the draft's order.
    expect(row.graph.nodes.map((n) => n.id)).toEqual(
      drafted.graph.nodes.map((n) => n.id),
    );
    expect(update.drafts.find((d) => d.key === source)).toMatchObject({
      recordId: sourceId,
      version: row.version,
      published: false,
    });
  });

  it("applies the customer's choice per conflicting item", async () => {
    const { workspaceId, requestId, installed, connections } = await installIn([
      "app-store-connect",
    ]);
    const definition = await modelDefinition(installed.models.downloads);
    definition.measures[0]!.name = "Our downloads";
    await owner`update data_models set definition=${owner.json(definition as never)}, version=version+1
      where id=${installed.models.downloads}`;
    const source = `preparation:source:${connections[0]!.id}:downloads`;
    const sourceId = (await recordOf(requestId, source))!.record_id as string;
    await editStep(workspaceId, sourceId, "calculate_store_name", "Ours", true);
    const plan = await updates(v2).plan(actor(workspaceId), requestId);
    const measure = "model:downloads#measure:downloads",
      step = `${source}#step:calculate_store_name`;
    expect(item(plan, measure)?.outcome).toBe("choose");
    expect(item(plan, step)?.outcome).toBe("choose");
    await updates(v2).apply(actor(workspaceId), requestId, {
      basis: plan.basis,
      decisions: [
        ...choices(plan, "template").filter((d) => d.ref !== measure),
        { ref: measure, choice: "customer" },
      ],
    });
    const after = await modelDefinition(installed.models.downloads);
    expect(after.measures.find((m) => m.id === "downloads")!.name).toBe(
      "Our downloads",
    );
    expect(after.measures.map((m) => m.id)).toContain("downloads_avg");
    expect(
      (await preparationRow(sourceId)).graph.nodes.find(
        (n) => n.id === "calculate_store_name",
      ),
    ).toMatchObject({ name: "Store name (v2)" });
  });

  it("removes a part the template drops only when the customer says so", async () => {
    // Version 2 also drops the country dimension of the downloads model.
    const dropping: StoreTemplateDefinition = {
      ...v2,
      build(key, inputs, ids) {
        const record = v2.build(key, inputs, ids);
        if (record.kind !== "model" || key !== "model:downloads") return record;
        const definition = structuredClone(record.definition);
        definition.dimensions = definition.dimensions.filter(
          (d) => d.id !== "country",
        );
        return { ...record, definition };
      },
    };
    const country = "model:downloads#dimension:country";
    for (const choice of ["remove", "keep"] as const) {
      const { workspaceId, requestId, installed } = await installIn([
        "google-play",
      ]);
      const plan = await updates(dropping).plan(actor(workspaceId), requestId);
      expect(item(plan, country)?.outcome).toBe("propose_removal");
      await updates(dropping).apply(actor(workspaceId), requestId, {
        basis: plan.basis,
        decisions: [
          ...choices(plan, "template").filter((d) => d.ref !== country),
          { ref: country, choice },
        ],
      });
      const dimensions = (
        await modelDefinition(installed.models.downloads)
      ).dimensions.map((d) => d.id);
      if (choice === "remove") expect(dimensions).not.toContain("country");
      else expect(dimensions).toContain("country");
    }
  });

  it("refuses undecided conflicts and stale plans", async () => {
    const { workspaceId, requestId } = await installIn(["google-play"]);
    const plan = await updates(v2).plan(actor(workspaceId), requestId);
    const missing = await updates(v2)
      .apply(actor(workspaceId), requestId, {
        basis: plan.basis,
        decisions: [],
      })
      .catch((error: unknown) => error);
    expect(missing).toMatchObject({
      code: "store_update_decision_missing",
      status: 400,
      refs: ["dashboard:portfolio#widget:ratings"],
    });
    // A choice that does not fit the item counts as missing.
    await expect(
      updates(v2).apply(actor(workspaceId), requestId, {
        basis: plan.basis,
        decisions: [
          { ref: "dashboard:portfolio#widget:ratings", choice: "template" },
        ],
      }),
    ).rejects.toThrow("store_update_decision_missing");
    const state = await publishedState(workspaceId);
    expect(
      (await updates(v2).list(actor(workspaceId))).installs[0]!.openUpdate,
    ).toBeNull();
    const full = { basis: plan.basis, decisions: choices(plan, "template") };
    await expect(
      updates(v2).apply(actor(workspaceId), requestId, {
        ...full,
        basis: "0".repeat(64),
      }),
    ).rejects.toThrow("store_update_stale");
    expect(await publishedState(workspaceId)).toEqual(state);
    await updates(v2).apply(actor(workspaceId), requestId, full);
    const applied = await publishedState(workspaceId);
    await expect(
      updates(v2).apply(actor(workspaceId), requestId, full),
    ).rejects.toThrow("store_update_stale");
    // No second set of drafts, one update.
    expect(await publishedState(workspaceId)).toEqual(applied);
    const rows =
      await owner`select id from data_template_updates where request_id=${requestId}`;
    expect(rows).toHaveLength(1);
    // Concurrent applies (double click, two tabs): one wins, one is stale.
    const other = await installIn(["google-play"]);
    const otherPlan = await updates(v2).plan(
      actor(other.workspaceId),
      other.requestId,
    );
    const body = {
      basis: otherPlan.basis,
      decisions: choices(otherPlan, "template"),
    };
    const results = await Promise.allSettled([
      updates(v2).apply(actor(other.workspaceId), other.requestId, body),
      updates(v2).apply(actor(other.workspaceId), other.requestId, body),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(
      (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
        .reason,
    ).toMatchObject({ code: "store_update_stale" });
    // Up to date and unknown installs.
    await expect(
      updates().apply(actor(other.workspaceId), randomUUID(), body),
    ).rejects.toThrow("store_template_not_found");
    const fresh = await installIn(["google-play"]);
    await expect(
      updates().apply(actor(fresh.workspaceId), fresh.requestId, full),
    ).rejects.toThrow("store_template_up_to_date");
  });

  it("publishes the drafts through the normal flow and marks the dashboard copy ready", async () => {
    const { workspaceId, requestId } = await installIn(["app-store-connect"]);
    const plan = await updates(v2).plan(actor(workspaceId), requestId);
    const update = await updates(v2).apply(actor(workspaceId), requestId, {
      basis: plan.basis,
      decisions: choices(plan, "template"),
    });
    const data = createDataService(db, () => new Date(now));
    const open = async () =>
      (await updates(v2).list(actor(workspaceId))).installs[0]!.openUpdate!;
    for (const [index, draft] of update.drafts.entries()) {
      expect((await open()).dashboards[0]!.ready).toBe(false);
      if (draft.kind === "preparation")
        await data.publishPreparation(
          actor(workspaceId),
          draft.recordId,
          draft.version,
        );
      else
        await data.publishModel(
          actor(workspaceId),
          draft.recordId,
          draft.version,
        );
      expect((await open()).drafts[index]!.published).toBe(true);
    }
    expect((await open()).dashboards[0]!.ready).toBe(true);
  });

  it("detaches records the template no longer builds and keeps them", async () => {
    // Two connections; the install drops the second one (app scope).
    const { workspaceId, requestId, connections } = await installIn([
      "app-store-connect",
      "google-play",
    ]);
    const gone = connections[1]!.id;
    const edited = `preparation:source:${gone}:downloads`;
    const editedId = (await recordOf(requestId, edited))!.record_id as string;
    await editStep(workspaceId, editedId, "calculate_app_key", "Mine", true);
    const editedGraph = (await preparationRow(editedId)).graph;
    const [install] =
      await owner`select inputs from data_template_installs where request_id=${requestId}`;
    const inputs = install!.inputs as { connections: { id: string }[] };
    inputs.connections = inputs.connections.filter((c) => c.id !== gone);
    await owner`update data_template_installs set inputs=${owner.json(inputs as never)} where request_id=${requestId}`;
    const plan = await updates(v2).plan(actor(workspaceId), requestId);
    const update = await updates(v2).apply(actor(workspaceId), requestId, {
      basis: plan.basis,
      decisions: choices(plan, "template"),
    });
    const detached =
      await owner`select key, record_id from data_template_records
        where request_id=${requestId} and detached_at is not null order by key`;
    expect(detached.map((r) => r.key as string)).toEqual(
      [
        "preparation:append:downloads:0:0",
        "preparation:append:proceeds:0:0",
        "preparation:append:ratings:0:0",
        `preparation:source:${gone}:downloads`,
        `preparation:source:${gone}:proceeds`,
        `preparation:source:${gone}:ratings`,
      ].sort(),
    );
    // Nothing is deleted; the customer's edit is still there.
    for (const row of detached)
      expect(await preparationRow(row.record_id as string)).toBeTruthy();
    expect((await preparationRow(editedId)).graph).toEqual(editedGraph);
    // The models read the remaining source preparation, as a draft.
    const kept = (await recordOf(
      requestId,
      `preparation:source:${connections[0]!.id}:downloads`,
    ))!.record_id as string;
    const model = update.drafts.find((d) => d.key === "model:downloads")!;
    expect((await modelDefinition(model.recordId)).datasets).toEqual([
      `prepared:${kept}:output`,
    ]);
  });

  it("creates the records a new version or new app scope adds, unpublished", async () => {
    const { workspaceId, requestId, installed } = await installIn([
      "app-store-connect",
    ]);
    const [extra] = await withWorkspace(db, { workspaceId }, (tx) =>
      tx
        .insert(schema.connections)
        .values({
          workspaceId,
          connectorId: "google-play",
          name: "Play account",
          setupPending: false,
        })
        .returning(),
    );
    const [install] =
      await owner`select inputs from data_template_installs where request_id=${requestId}`;
    const inputs = install!.inputs as { connections: unknown[] };
    inputs.connections.push({
      id: extra!.id,
      name: "Play account",
      connectorId: "google-play",
      datasets: {
        install_rows: randomUUID(),
        earning_rows: randomUUID(),
        store_ratings: randomUUID(),
      },
    });
    await owner`update data_template_installs set inputs=${owner.json(inputs as never)} where request_id=${requestId}`;
    const plan = await updates(v2).plan(actor(workspaceId), requestId);
    const update = await updates(v2).apply(actor(workspaceId), requestId, {
      basis: plan.basis,
      decisions: choices(plan, "template"),
    });
    const append = await recordOf(
      requestId,
      "preparation:append:downloads:0:0",
    );
    const source = await recordOf(
      requestId,
      `preparation:source:${extra!.id}:downloads`,
    );
    expect(append).toMatchObject({ kind: "preparation", template_version: 2 });
    expect(source).toMatchObject({ kind: "preparation", template_version: 2 });
    for (const record of [append!, source!]) {
      const row = await preparationRow(record.record_id as string);
      expect(row.published_version).toBeNull();
      expect(strings(row.graph).filter((v) => /^(ref|new):/.test(v))).toEqual(
        [],
      );
      expect(update.drafts.map((d) => d.recordId)).toContain(record.record_id);
    }
    // The new append reads the new source; the model reads the append.
    expect(
      strings((await preparationRow(append!.record_id as string)).graph),
    ).toContain(`prepared:${source!.record_id as string}:output`);
    const datasets = (await modelDefinition(installed.models.downloads))
      .datasets;
    expect(datasets).toHaveLength(1);
    expect(datasets[0]).toMatch(
      new RegExp(`^prepared:${append!.record_id as string}:`),
    );
    // After applying, the data has nothing left from the template.
    const after = await updates(v2).plan(actor(workspaceId), requestId);
    expect(
      items(after).filter(
        (i) => !i.ref.startsWith("dashboard:") && i.outcome !== "customer",
      ),
    ).toEqual([]);
  });

  it("applies to an install made before versions with the plan read before", async () => {
    const { workspaceId, requestId } = await installIn([
      "app-store-connect",
      "google-play",
    ]);
    await makeLegacy(workspaceId, requestId);
    const plan = await updates(v2).plan(actor(workspaceId), requestId);
    const update = await updates(v2).apply(actor(workspaceId), requestId, {
      basis: plan.basis,
      decisions: choices(plan, "template"),
    });
    expect(update.drafts.length).toBeGreaterThan(0);
    const [install] =
      await owner`select inputs, template_version from data_template_installs where request_id=${requestId}`;
    expect(install!.inputs).not.toBeNull();
    expect(install!.template_version).toBe(2);
    const legacy =
      await owner`select key from data_template_records where request_id=${requestId} and key like 'legacy:%'`;
    expect([...legacy]).toEqual([]);
  });
});

describe("store-template update routes", { timeout: TIMEOUT_MS }, () => {
  let app: FastifyInstance;
  const signup = async (email: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { name: email, email, password: "password-12345" },
    });
    expect(response.statusCode).toBe(200);
    const header = response.headers["set-cookie"];
    const cookie = (Array.isArray(header) ? header : [header])
      .find((c) => c?.startsWith("better-auth.session_token="))!
      .split(";")[0]!;
    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie },
    });
    return { cookie, id: meResponseSchema.parse(me.json()).user.id };
  };
  let updated: FastifyInstance;
  let install: Awaited<ReturnType<typeof installIn>>;
  let editor: string,
    viewer: string,
    stranger: string,
    strangerWorkspace: string;
  beforeAll(async () => {
    const config = loadConfig({
      DATABASE_URL: test.appUrl,
      LOG_LEVEL: "silent",
      BETTER_AUTH_URL: "http://localhost:3001",
      WEB_ORIGIN: "http://localhost:3000",
    });
    app = await buildApp(config, {
      db,
      authService: createAuthService(config, db, {
        logger: pino({ level: "silent" }),
      }),
      checkDb: async () => true,
    });
    updated = await buildApp(config, {
      db,
      authService: createAuthService(config, db, {
        logger: pino({ level: "silent" }),
      }),
      checkDb: async () => true,
      storeTemplate: v2,
    });
    install = await installIn(["google-play"]);
    const users = {
      editor: await signup("updates-editor@example.test"),
      viewer: await signup("updates-viewer@example.test"),
      stranger: await signup("updates-stranger@example.test"),
    };
    for (const [key, role] of [
      ["editor", "editor"],
      ["viewer", "viewer"],
    ] as const)
      await owner`insert into memberships (workspace_id, user_id, role)
        values (${install.workspaceId}, ${users[key].id}, ${role})`;
    editor = users.editor.cookie;
    viewer = users.viewer.cookie;
    stranger = users.stranger.cookie;
    const created = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { cookie: stranger },
      payload: { name: "Elsewhere" },
    });
    strangerWorkspace = workspaceResponseSchema.parse(created.json()).workspace
      .id;
  }, TEST_DATABASE_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await app?.close();
    await updated?.close();
  });
  const post = (
    target: FastifyInstance,
    workspaceId: string,
    requestId: string,
    cookie: string,
    payload: unknown,
  ) =>
    target.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/dashboard-templates/stores/installs/${requestId}/update`,
      headers: { cookie },
      payload: payload as object,
    });
  const get = (workspaceId: string, path: string, cookie: string) =>
    app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceId}/dashboard-templates/stores${path}`,
      headers: { cookie },
    });

  it("lets a viewer see the list but not the plan", async () => {
    const list = await get(install.workspaceId, "/installs", viewer);
    expect(list.statusCode).toBe(200);
    expect(list.headers["cache-control"]).toBe("no-store");
    expect(
      storeTemplateInstallListSchema.parse(list.json()).installs[0],
    ).toMatchObject({ requestId: install.requestId, updateAvailable: false });
    const plan = await get(
      install.workspaceId,
      `/installs/${install.requestId}/update`,
      viewer,
    );
    expect(plan.statusCode).toBe(403);
    const upToDate = await get(
      install.workspaceId,
      `/installs/${install.requestId}/update`,
      editor,
    );
    expect(upToDate.statusCode).toBe(409);
    expect(errorResponseSchema.parse(upToDate.json())).toEqual({
      error: "store_template_up_to_date",
    });
  });

  it("answers another workspace's install like a random id", async () => {
    for (const requestId of [install.requestId, randomUUID(), "not-a-uuid"]) {
      const response = await get(
        strangerWorkspace,
        `/installs/${requestId}/update`,
        stranger,
      );
      expect(response.statusCode).toBe(404);
      expect(errorResponseSchema.parse(response.json())).toEqual({
        error: "store_template_not_found",
      });
    }
    const list = await get(strangerWorkspace, "/installs", stranger);
    expect(storeTemplateInstallListSchema.parse(list.json()).installs).toEqual(
      [],
    );
    expect(
      (await get(install.workspaceId, "/installs", stranger)).statusCode,
    ).toBe(404);
  });

  it("applies an update for editors only, with the items still undecided", async () => {
    const body = { basis: "0".repeat(64), decisions: [] };
    for (const target of [app, updated])
      expect(
        (
          await post(
            target,
            install.workspaceId,
            install.requestId,
            viewer,
            body,
          )
        ).statusCode,
      ).toBe(403);
    const upToDate = await post(
      app,
      install.workspaceId,
      install.requestId,
      editor,
      body,
    );
    expect(upToDate.statusCode).toBe(409);
    expect(upToDate.json()).toEqual({ error: "store_template_up_to_date" });
    const invalid = await post(
      updated,
      install.workspaceId,
      install.requestId,
      editor,
      { basis: 1 },
    );
    expect(invalid.statusCode).toBe(400);
    const stale = await post(
      updated,
      install.workspaceId,
      install.requestId,
      editor,
      body,
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: "store_update_stale" });
    const planned = await updated.inject({
      method: "GET",
      url: `/v1/workspaces/${install.workspaceId}/dashboard-templates/stores/installs/${install.requestId}/update`,
      headers: { cookie: editor },
    });
    const plan = planned.json() as StoreTemplatePlan;
    const missing = await post(
      updated,
      install.workspaceId,
      install.requestId,
      editor,
      { basis: plan.basis, decisions: [] },
    );
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({
      error: "store_update_decision_missing",
      refs: ["dashboard:portfolio#widget:ratings"],
    });
    const applied = await post(
      updated,
      install.workspaceId,
      install.requestId,
      editor,
      { basis: plan.basis, decisions: choices(plan, "template") },
    );
    expect(applied.statusCode).toBe(200);
    expect(applied.headers["cache-control"]).toBe("no-store");
    const update = storeTemplateUpdateSchema.parse(applied.json());
    expect(update.requestId).toBe(install.requestId);
    const list = await updated.inject({
      method: "GET",
      url: `/v1/workspaces/${install.workspaceId}/dashboard-templates/stores/installs`,
      headers: { cookie: viewer },
    });
    expect(
      storeTemplateInstallListSchema.parse(list.json()).installs[0]!.openUpdate,
    ).toEqual(update);
  });

  it("names the record a merge cannot write", async () => {
    const other = await installIn(["google-play"]);
    const [user] =
      await owner`select user_id from memberships where workspace_id=${install.workspaceId} and role='editor'`;
    await owner`insert into memberships (workspace_id, user_id, role)
      values (${other.workspaceId}, ${user!.user_id as string}, 'editor')`;
    await measureOnDroppedDataset(
      other.workspaceId,
      other.requestId,
      other.installed.models.downloads,
      other.connections[0]!.id,
    );
    const plan = await updates(v2).plan(
      actor(other.workspaceId),
      other.requestId,
    );
    const response = await post(
      updated,
      other.workspaceId,
      other.requestId,
      editor,
      { basis: plan.basis, decisions: choices(plan, "template") },
    );
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "store_update_unmergeable",
      key: "model:downloads",
      refs: ["model:downloads#measure:on_ratings"],
    });
  });

  it("closes an update for editors only, within the workspace", async () => {
    const [open] =
      await owner`select id from data_template_updates where request_id=${install.requestId} and closed_at is null`;
    const updateId = open!.id as string;
    const close = (workspaceId: string, cookie: string, id = updateId) =>
      updated.inject({
        method: "POST",
        url: `/v1/workspaces/${workspaceId}/dashboard-templates/stores/installs/${install.requestId}/updates/${id}/close`,
        headers: { cookie },
      });
    expect((await close(install.workspaceId, viewer)).statusCode).toBe(403);
    expect((await close(install.workspaceId, stranger)).statusCode).toBe(404);
    const elsewhere = await close(strangerWorkspace, stranger);
    expect(elsewhere.statusCode).toBe(404);
    expect(elsewhere.json()).toEqual({
      error: "store_template_update_not_found",
    });
    for (const id of [randomUUID(), "not-a-uuid"])
      expect((await close(install.workspaceId, editor, id)).statusCode).toBe(
        404,
      );
    for (let attempt = 0; attempt < 2; attempt++)
      expect((await close(install.workspaceId, editor)).statusCode).toBe(204);
    const list = await updated.inject({
      method: "GET",
      url: `/v1/workspaces/${install.workspaceId}/dashboard-templates/stores/installs`,
      headers: { cookie: viewer },
    });
    expect(
      storeTemplateInstallListSchema.parse(list.json()).installs[0]!.openUpdate,
    ).toBeNull();
  });

  it("answers another workspace's install like a random id when applying", async () => {
    for (const requestId of [install.requestId, randomUUID(), "not-a-uuid"]) {
      const response = await post(
        updated,
        strangerWorkspace,
        requestId,
        stranger,
        { basis: "0".repeat(64), decisions: [] },
      );
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "store_template_not_found" });
    }
    expect(
      (
        await post(updated, install.workspaceId, install.requestId, stranger, {
          basis: "0".repeat(64),
          decisions: [],
        })
      ).statusCode,
    ).toBe(404);
  });
});
