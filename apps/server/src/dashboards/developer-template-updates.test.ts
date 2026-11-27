import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  createRawSqlClient,
  adminSetDataPolicy,
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
import {
  developerTemplate,
  developerTemplateV1,
} from "./developer-template.js";
import {
  createDeveloperTemplateService,
  projectProduct,
} from "./developer-template-service.js";
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
/** The current builders as a version after `older`. */
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

/** The rows of an install's links table, as the customer sees them. */
async function linkRows(
  target: Awaited<ReturnType<typeof setup>>,
  datasetId: string,
) {
  const table = await createDataService(db, at).readManual(
    target.actor,
    datasetId,
    { offset: 0, limit: 1000 },
  );
  return table.records.map((record) => record.values);
}

/** A resource a connection's discovery found. */
async function addResource(
  target: Awaited<ReturnType<typeof setup>>,
  connectionId: string,
  resourceId: string,
) {
  await owner`insert into connection_resources
      (connection_id, workspace_id, resource_id, name, kind)
    values (${connectionId}, ${target.workspaceId}, ${resourceId},
      ${resourceId}, 'project')`;
}

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
  // A data-only update (a default link of a slide the dashboard already
  // has) has no dashboard to copy: done once its drafts are published.
  if (!update.dashboards.length) return { plan, update, copy: null! };
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
      templateVersion: 2,
      latestVersion: 2,
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
              product_id: projectProduct(target.projects[1]!),
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
      project: {
        kind: "values",
        values: [projectProduct(target.projects[1]!)],
      },
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

  it("offers a new workspace project and its connection's resources as an update (owner decision C)", async () => {
    const target = await setup();
    const { requestId, result } = await install(target, developerTemplate);
    const linksBefore = await linkRows(target, result.linksDatasetId);
    // After the install: a new project, and the Vercel connection moved
    // into it with a project it has discovered.
    const [gamma] = await owner<{ id: string }[]>`
      insert into projects (workspace_id, name)
      values (${target.workspaceId}, 'Gamma') returning id`;
    await owner`update connections set project_id = ${gamma!.id}
      where id = ${target.connections[1]!}`;
    await owner`insert into connection_resources
        (connection_id, workspace_id, resource_id, name, kind)
      values (${target.connections[1]!}, ${target.workspaceId}, 'prj_gamma',
        'gamma-web', 'project')`;
    // Not applied by itself: offered for review.
    const listed = await updates().list(target.actor);
    expect(listed.installs[0]).toMatchObject({
      updateAvailable: true,
      newerVersion: false,
    });
    const before = await withWorkspace(
      db,
      { workspaceId: target.workspaceId },
      (tx) => findDashboard(tx, target.workspaceId, result.dashboardId),
    );
    expect(before!.slides.map((slide) => slide.name)).toEqual([
      "Overview",
      "Alpha",
    ]);
    const { copy } = await applyUpdate(target, requestId);
    expect(copy.slides.map((slide) => slide.name)).toEqual([
      "Overview",
      "Alpha",
      "Gamma",
    ]);
    // Applying wrote the reviewed drafts only: the customer's links table
    // is as it was; the default link is in the Vercel preparations.
    expect(await linkRows(target, result.linksDatasetId)).toEqual(linksBefore);
    expect((await updates().list(target.actor)).installs[0]).toMatchObject({
      updateAvailable: false,
    });
  });

  it("offers a new resource of a project that has its slide, and the review guards it", async () => {
    const target = await setup();
    const { requestId, result } = await install(target, developerTemplate);
    const linksBefore = await linkRows(target, result.linksDatasetId);
    // Railway's connection moves into Alpha, whose slide already shows
    // Railway (the explicit link): its other project is a new default.
    await owner`update connections set project_id = ${target.projects[0]!}
      where id = ${target.connections[0]!}`;
    await addResource(target, target.connections[0]!, "rw-alpha-2");
    const listed = await updates().list(target.actor);
    expect(listed.installs[0]).toMatchObject({ updateAvailable: true });
    const plan = await updates().plan(target.actor, requestId);
    const refs = plan.records.flatMap((record) =>
      record.items.map((item) => item.ref),
    );
    expect(
      refs.some((ref) =>
        ref.startsWith(`preparation:ops:state:${target.connections[0]}#`),
      ),
    ).toBe(true);
    // A resource found after the review: the reviewed plan is stale.
    await addResource(target, target.connections[0]!, "rw-alpha-3");
    await expect(
      updates().apply(target.actor, requestId, {
        basis: plan.basis,
        decisions: decisions(plan),
      }),
    ).rejects.toMatchObject({ code: "store_update_stale" });
    await applyUpdate(target, requestId);
    // Nothing but the reviewed drafts: no rows added to the table.
    expect(await linkRows(target, result.linksDatasetId)).toEqual(linksBefore);
    expect((await updates().list(target.actor)).installs[0]).toMatchObject({
      updateAvailable: false,
    });
  });

  it("never proposes a link the customer removed again", async () => {
    const target = await setup();
    // Vercel's connection in Beta: its project is linked by default.
    await owner`update connections set project_id = ${target.projects[1]!}
      where id = ${target.connections[1]!}`;
    await addResource(target, target.connections[1]!, "prj_beta");
    const { requestId, result } = await install(target, developerTemplate);
    const slides = async () =>
      (await withWorkspace(db, { workspaceId: target.workspaceId }, (tx) =>
        findDashboard(tx, target.workspaceId, result.dashboardId),
      ))!.slides.map((slide) => slide.name);
    expect(await slides()).toEqual(["Overview", "Alpha", "Beta"]);
    // The customer unlinks it: a row with an empty project.
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
              product_id: "",
            },
          },
        ],
        generationId: table.generationId,
      },
      result.linksDatasetId,
    );
    // The update removes Beta's slide; once applied, nothing re-proposes it.
    const { copy } = await applyUpdate(target, requestId);
    expect(copy.slides.map((slide) => slide.name)).toEqual([
      "Overview",
      "Alpha",
    ]);
    expect((await updates().list(target.actor)).installs[0]).toMatchObject({
      updateAvailable: false,
    });
  });

  it("reads the update's tables and defaults under the workspace's data policy", async () => {
    const target = await setup();
    const { requestId } = await install(target, older);
    await owner`update connections set project_id = ${target.projects[1]!}
      where id = ${target.connections[1]!}`;
    for (const id of ["prj_one", "prj_two", "prj_three"])
      await addResource(target, target.connections[1]!, id);
    // A workspace allowed two rows a read: its three resources are over.
    await adminSetDataPolicy(db, target.workspaceId, { queryRows: 2 });
    await expect(
      updates(newer).plan(target.actor, requestId),
    ).rejects.toMatchObject({ code: "data_source_row_limit", status: 413 });
  });

  it("updates a released version 1 install to version 2 (#913)", async () => {
    const target = await setup();
    const { requestId } = await install(target, developerTemplateV1);
    const listed = await updates().list(target.actor);
    expect(listed.installs[0]).toMatchObject({
      templateVersion: 1,
      latestVersion: 2,
      updateAvailable: true,
      newerVersion: true,
    });
    const { plan, update } = await applyUpdate(target, requestId);
    // Vercel's state is dated by the state it reports: the data changes,
    // the dashboard stays as it is (no copy to swap in).
    expect(update.dashboards).toEqual([]);
    expect(
      plan.records.some((record) =>
        record.items.some((item) =>
          item.ref.startsWith(
            `preparation:ops:state:${target.connections[1]}#`,
          ),
        ),
      ),
    ).toBe(true);
    const [state] = await owner<{ graph: { nodes: { id: string }[] } }[]>`
      select v.graph from data_preparations p
      join data_preparation_versions v
        on v.preparation_id = p.id and v.version = p.published_version
      where p.workspace_id = ${target.workspaceId}
        and p.id = (select record_id from data_template_records
          where request_id = ${requestId}
            and key = ${`preparation:ops:state:${target.connections[1]}`})`;
    expect(JSON.stringify(state!.graph)).toContain('"building"');
    // The names its projects table was seeded with (the workspace's, as
    // the rows still say them) are stored from now on.
    const [row] = await owner<
      { template_version: number; inputs: { seededNames?: object } }[]
    >`select template_version, inputs from data_template_installs
      where request_id = ${requestId}`;
    expect(row!.template_version).toBe(2);
    expect(row!.inputs.seededNames).toEqual({
      [projectProduct(target.projects[0]!)]: "Alpha",
      [projectProduct(target.projects[1]!)]: "Beta",
    });
    expect((await updates().list(target.actor)).installs[0]).toMatchObject({
      templateVersion: 2,
      updateAvailable: false,
    });
  });

  it("follows a workspace project's rename unless the customer named it (#913)", async () => {
    const target = await setup();
    const { requestId, result } = await install(target, developerTemplate);
    await owner`update projects set name = 'Alpha renamed'
      where id = ${target.projects[0]!}`;
    // The seeded row says the old name: no override, so the rename is
    // offered as an update.
    expect((await updates().list(target.actor)).installs[0]).toMatchObject({
      updateAvailable: true,
      newerVersion: false,
    });
    const renamed = await applyUpdate(target, requestId);
    expect(renamed.copy.slides.map((slide) => slide.name)).toEqual([
      "Overview",
      "Alpha renamed",
    ]);
    // The customer names the project in the projects table: theirs wins.
    const data = createDataService(db, at);
    const table = await data.readManual(
      target.actor,
      result.projectsDatasetId,
      { offset: 0, limit: 1000 },
    );
    await data.saveManual(
      target.actor,
      {
        definition: table.definition,
        records: table.records.map((record) => ({
          values:
            record.values.product_id === projectProduct(target.projects[0]!)
              ? { ...record.values, product_name: "Our shop" }
              : record.values,
        })),
        generationId: table.generationId,
      },
      result.projectsDatasetId,
    );
    const named = await applyUpdate(target, requestId);
    expect(named.copy.slides.map((slide) => slide.name)).toEqual([
      "Overview",
      "Our shop",
    ]);
    // A later rename leaves the customer's name.
    await owner`update projects set name = 'Alpha again'
      where id = ${target.projects[0]!}`;
    const plan = await updates().plan(target.actor, requestId);
    expect(
      plan.records.some((record) => record.key === "dashboard:portfolio"),
    ).toBe(false);
  });

  it("refuses a plan or an apply over the row limit, never 'up to date' (#913)", async () => {
    const target = await setup();
    const { requestId } = await install(target, developerTemplate);
    await owner`update connections set project_id = ${target.projects[1]!}
      where id = ${target.connections[1]!}`;
    for (const id of ["prj_one", "prj_two", "prj_three"])
      await addResource(target, target.connections[1]!, id);
    await adminSetDataPolicy(db, target.workspaceId, { queryRows: 2 });
    const rowLimit = { code: "data_source_row_limit", status: 413 };
    await expect(updates().plan(target.actor, requestId)).rejects.toMatchObject(
      rowLimit,
    );
    await expect(
      updates().apply(target.actor, requestId, { basis: "x", decisions: [] }),
    ).rejects.toMatchObject(rowLimit);
    // The list of installs never fails for it.
    expect((await updates().list(target.actor)).installs[0]).toMatchObject({
      requestId,
      updateAvailable: false,
    });
  });

  it("refuses the App Portfolio's routes on a Developer Portfolio update", async () => {
    const target = await setup();
    const { requestId, result } = await install(target, older);
    const service = updates(newer);
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
    const store = createStoreTemplateUpdateService({ db, registry, now: at });
    const notFound = { code: "store_template_update_not_found", status: 404 };
    await expect(
      store.createCopy(target.actor, update.id, "dashboard:portfolio"),
    ).rejects.toMatchObject(notFound);
    await expect(
      store.swap(target.actor, update.id, "dashboard:portfolio"),
    ).rejects.toMatchObject(notFound);
    await expect(
      store.swapBack(target.actor, update.id, "dashboard:portfolio"),
    ).rejects.toMatchObject(notFound);
    await expect(
      store.closeUpdate(target.actor, requestId, update.id),
    ).rejects.toMatchObject(notFound);
    // Nothing changed: no copy, still open.
    const [row] = await owner<{ closed: boolean; dashboards: unknown }[]>`
      select closed_at is not null as closed, dashboards
      from data_template_updates where id = ${update.id}`;
    expect(row!.closed).toBe(false);
    expect(row!.dashboards).toEqual([
      expect.objectContaining({
        originalId: result.dashboardId,
        copyId: null,
      }),
    ]);
  });
});
