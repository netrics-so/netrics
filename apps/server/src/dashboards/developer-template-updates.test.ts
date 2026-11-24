import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  createRawSqlClient,
  createWorkspace,
  findDashboard,
  schema,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";
import type { StoreTemplatePlan } from "@netrics/contracts";

import { createDefaultRegistry } from "../connectors.js";
import { createDataService } from "../data/service.js";
import { syncCatalog } from "../sync/catalog.js";
import {
  createTestDatabase,
  TEST_DATABASE_DROP_TIMEOUT_MS,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
  type TestDatabase,
} from "../test-db.js";
import { developerTemplate } from "./developer-template.js";
import { createDeveloperTemplateService } from "./developer-template-service.js";
import { createDeveloperTemplateUpdateService } from "./developer-template-updates.js";
import { createStoreTemplateUpdateService } from "./store-template-updates.js";
import type { StoreTemplateDefinition } from "./store-template.js";

/**
 * Updating a Developer Portfolio install (#876) the App Portfolio's way:
 * a newer template version, or a project linked since the dashboard was
 * built, is offered, reviewed, applied as drafts, copied and swapped.
 */
const NOW = "2026-11-24T12:00:00.000Z";
const at = () => new Date(NOW);
let test: TestDatabase, db: Database, owner: Sql, userId: string;
const registry = createDefaultRegistry();

/**
 * An earlier version: the same records, but the state model's measure and
 * the overview's deploys widget named differently, as a newer version
 * renames them.
 */
const older: StoreTemplateDefinition = {
  version: 1,
  keys: (inputs) => developerTemplate.keys(inputs),
  build(key, inputs, ids) {
    const record = developerTemplate.build(key, inputs, ids);
    if (record.kind === "model" && key === "model:state") {
      const definition = structuredClone(record.definition);
      definition.measures[0]!.name = "Services (v0)";
      return { ...record, definition };
    }
    if (record.kind === "dashboard") {
      const request = structuredClone(record.request);
      for (const slide of request.slides ?? [])
        for (const widget of slide.widgets)
          if (widget.title === "Deploys today") widget.title = "Deploys (v0)";
      return { ...record, request };
    }
    return record;
  },
};
/** The current builders as version 2. */
const newer: StoreTemplateDefinition = { ...developerTemplate, version: 2 };

const updates = (template?: StoreTemplateDefinition) =>
  createDeveloperTemplateUpdateService({
    db,
    registry,
    now: at,
    ...(template ? { template } : {}),
  });

beforeAll(async () => {
  test = await createTestDatabase();
  db = createDatabase(test.appUrl);
  owner = createRawSqlClient(test.adminUrl, { max: 1 });
  const admin = createDatabase(test.adminUrl, { max: 1 });
  await syncCatalog(admin, registry);
  await admin.$client.end({ timeout: 5 });
  const [user] = await db
    .insert(schema.users)
    .values({ email: "developer-updates@example.test", displayName: "Owner" })
    .returning();
  userId = user!.id;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);
afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
  await owner?.end({ timeout: 5 });
  await test?.drop();
}, TEST_DATABASE_DROP_TIMEOUT_MS);

/** A workspace with a Railway and a Vercel connection and two projects. */
async function setup() {
  const workspaceId = await createWorkspace(db, {
    name: "Developer " + randomUUID().slice(0, 8),
    ownerUserId: userId,
  });
  const projects: string[] = [];
  for (const name of ["Alpha", "Beta"]) {
    const [row] = await owner<{ id: string }[]>`
      insert into projects (workspace_id, name) values (${workspaceId}, ${name})
      returning id`;
    projects.push(row!.id);
  }
  const connections: string[] = [];
  for (const connectorId of ["railway", "vercel"]) {
    const [row] = await owner<{ id: string }[]>`
      insert into connections (workspace_id, connector_id, name, setup_pending)
      values (${workspaceId}, ${connectorId}, ${connectorId}, false)
      returning id`;
    connections.push(row!.id);
  }
  const actor = { workspaceId, callerId: userId, locale: "en" as const };
  return { workspaceId, projects, connections, actor };
}

async function install(
  target: Awaited<ReturnType<typeof setup>>,
  template: StoreTemplateDefinition,
) {
  const requestId = randomUUID();
  const result = await createDeveloperTemplateService({
    db,
    registry,
    now: at,
    template,
  }).install(target.actor, {
    requestId,
    name: "Developer Portfolio",
    connections: target.connections,
    links: [
      {
        connectionId: target.connections[0]!,
        resourceId: "rw-alpha",
        projectId: target.projects[0]!,
      },
    ],
  });
  return { requestId, result };
}

const decisions = (
  plan: StoreTemplatePlan,
): { ref: string; choice: "template" | "remove" }[] =>
  plan.records.flatMap((record) =>
    record.items.flatMap(
      (item): { ref: string; choice: "template" | "remove" }[] =>
        item.outcome === "choose"
          ? [{ ref: item.ref, choice: "template" }]
          : item.outcome === "propose_removal"
            ? [{ ref: item.ref, choice: "remove" }]
            : [],
    ),
  );

/** Applies the offered update, publishes its drafts, copies and swaps. */
async function applyUpdate(
  target: Awaited<ReturnType<typeof setup>>,
  requestId: string,
  template?: StoreTemplateDefinition,
) {
  const service = updates(template);
  const plan = await service.plan(target.actor, requestId);
  const update = await service.apply(target.actor, requestId, {
    basis: plan.basis,
    decisions: decisions(plan),
  });
  const data = createDataService(db, at);
  for (const draft of update.drafts)
    if (draft.kind === "preparation")
      await data.publishPreparation(
        target.actor,
        draft.recordId,
        draft.version,
      );
    else await data.publishModel(target.actor, draft.recordId, draft.version);
  const copied = await service.createCopy(
    target.actor,
    update.id,
    "dashboard:portfolio",
  );
  const copyId = copied.dashboards[0]!.copyId!;
  await service.swap(target.actor, update.id, "dashboard:portfolio");
  const copy = await withWorkspace(
    db,
    { workspaceId: target.workspaceId },
    (tx) => findDashboard(tx, target.workspaceId, copyId),
  );
  return { plan, update, copy: copy! };
}

const TIMEOUT_MS = 60_000;

describe("Developer Portfolio updates", { timeout: TIMEOUT_MS }, () => {
  it("is up to date right after an install", async () => {
    const target = await setup();
    const { requestId } = await install(target, developerTemplate);
    const listed = await updates().list(target.actor);
    expect(listed.installs).toHaveLength(1);
    expect(listed.installs[0]).toMatchObject({
      requestId,
      templateVersion: 1,
      latestVersion: 1,
      updateAvailable: false,
    });
    await expect(updates().plan(target.actor, requestId)).rejects.toMatchObject(
      { code: "store_template_up_to_date" },
    );
    // The App Portfolio's updates never list or plan it.
    const store = createStoreTemplateUpdateService({ db, registry, now: at });
    expect((await store.list(target.actor)).installs).toEqual([]);
    await expect(store.plan(target.actor, requestId)).rejects.toMatchObject({
      code: "store_template_not_found",
    });
  });

  it("updates an install from an earlier version", async () => {
    const target = await setup();
    const { requestId, result } = await install(target, older);
    const listed = await updates(newer).list(target.actor);
    expect(listed.installs[0]).toMatchObject({
      templateVersion: 1,
      latestVersion: 2,
      updateAvailable: true,
      newerVersion: true,
    });
    const { plan, copy } = await applyUpdate(target, requestId, newer);
    expect(
      plan.records.flatMap((record) => record.items.map((item) => item.ref)),
    ).toEqual(
      expect.arrayContaining([
        "model:state#measure:items",
        expect.stringMatching(/^dashboard:portfolio#widget:deploys/),
      ]),
    );
    expect(copy.slides[0]!.widgets.map((widget) => widget.title)).toContain(
      "Deploys today",
    );
    const [model] = await owner<
      { definition: { measures: { name: string }[] } }[]
    >`
      select definition from data_models
      where workspace_id = ${target.workspaceId} and id = ${result.models.state!}`;
    expect(model!.definition.measures[0]!.name).toBe("Services");
    const after = await updates(newer).list(target.actor);
    expect(after.installs[0]).toMatchObject({
      templateVersion: 2,
      updateAvailable: false,
    });
  });

  it("offers a project linked since as a new slide", async () => {
    const target = await setup();
    const { requestId, result } = await install(target, developerTemplate);
    const before = await withWorkspace(
      db,
      { workspaceId: target.workspaceId },
      (tx) => findDashboard(tx, target.workspaceId, result.dashboardId),
    );
    expect(before!.slides.map((slide) => slide.name)).toEqual([
      "Overview",
      "Alpha",
    ]);
    // The customer links a Vercel project to Beta in the links table.
    const data = createDataService(db, at);
    const table = await data.readManual(target.actor, result.linksDatasetId, {
      offset: 0,
      limit: 1000,
    });
    await data.saveManual(
      target.actor,
      {
        definition: table.definition,
        records: [
          ...table.records.map((record) => ({ values: record.values })),
          {
            values: {
              app_key: `${target.connections[1]}:prj_beta`,
              product_id: target.projects[1]!,
            },
          },
        ],
        generationId: table.generationId,
      },
      result.linksDatasetId,
    );
    const listed = await updates().list(target.actor);
    expect(listed.installs[0]).toMatchObject({
      updateAvailable: true,
      newerVersion: false,
    });
    const { copy } = await applyUpdate(target, requestId);
    expect(copy.slides.map((slide) => slide.name)).toEqual([
      "Overview",
      "Alpha",
      "Beta",
    ]);
    const beta = copy.slides[2]!;
    expect(beta.scope).toEqual({
      project: { kind: "values", values: [target.projects[1]] },
    });
    // Vercel fills its usage, deploys, cost and state.
    expect(beta.widgets.map((widget) => widget.type).sort()).toEqual([
      "measure",
      "measure",
      "measure",
      "state",
    ]);
    expect((await updates().list(target.actor)).installs[0]).toMatchObject({
      updateAvailable: false,
    });
  });
});
