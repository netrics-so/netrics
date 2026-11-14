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
  workspaceResponseSchema,
  type StoreTemplatePlan,
} from "@netrics/contracts";
import type {
  PreparationGraph,
  SemanticModelDefinition,
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
const updates = (template?: StoreTemplateDefinition) =>
  createStoreTemplateUpdateService({
    db,
    registry,
    now: () => new Date(now),
    ...(template ? { template } : {}),
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
});
