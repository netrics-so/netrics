import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  createRawSqlClient,
  createWorkspace,
  ingestDatasetPage,
  replaceImageReferences,
  schema,
  upsertConnectionResources,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";
import {
  replaceDashboardRequestSchema,
  type StoreTemplatePlan,
} from "@netrics/contracts";
import { measureOptionsForBinding, type DataRow } from "@netrics/domain";
import { createDefaultRegistry } from "../connectors.js";
import { syncCatalog } from "../sync/catalog.js";
import { createDataService } from "../data/service.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "../test-db.js";
import { createDashboardService } from "./service.js";
import {
  createStoreTemplateService,
  type StoreIconFetcher,
} from "./store-template-service.js";
import { createStoreTemplateUpdateService } from "./store-template-updates.js";
import { createStoreProductService } from "./store-template-products.js";
import {
  STORE_TEMPLATE_VERSION,
  storeTemplate,
  storeTemplateV3,
  storeTemplateV4,
  storeTemplateV5,
} from "./store-template.js";
import { appSlideKey } from "./store-portfolio.js";
import { apple, google, now } from "./test-helpers.js";

// App Portfolio template version 4 (#709): the overview, then one slide per
// app, scoped to it, with its icon as the slide's logo; paid and free
// layouts; identity changes offered as template updates.

let db: Database, owner: Sql, workspaceId: string, userId: string;
const registry = createDefaultRegistry();
const vercelId = "33333333-3333-4333-8333-333333333333";
let locale: "en" | "de" = "en";
const actor = () => ({ workspaceId, callerId: userId, locale });
const at = () => new Date(now);
const TIMEOUT_MS = 60_000;

const focus = `${apple.id}:1001`,
  timer = `${google.id}:com.timer`;

/** The icons fetched, as the resource-icon path stores them. */
const fetched: string[] = [];
const fetchIcons: StoreIconFetcher = async (_actor, sources) => {
  for (const source of sources) {
    fetched.push(`${source.connectionId}:${source.resourceId}`);
    // Timer's icon arrives; every other fetch fails.
    if (source.resourceId === "com.timer")
      await icon(source.connectionId, source.resourceId);
  }
};

async function icon(connectionId: string, resourceId: string) {
  const content = Buffer.from("icon " + connectionId + resourceId);
  const [row] = await owner`insert into workspace_images
      (workspace_id, name, content_type, bytes, width, height, sha256, content,
       origin, connection_id, resource_id, created_at)
    values (${workspaceId}, 'App icon', 'image/png', ${content.length}, 64, 64,
      ${createHash("sha256").update(content).digest("hex")}, ${content},
      'resource_icon', ${connectionId}, ${resourceId}, ${now})
    returning id`;
  return row!.id as string;
}

async function ingest(
  source: typeof apple,
  key: string,
  rows: DataRow[],
): Promise<void> {
  const definition = registry
    .get(source.connectorId)!
    .manifest.datasets!.find((dataset) => dataset.key === key)!;
  await withWorkspace(db, { workspaceId }, (tx) =>
    ingestDatasetPage(tx, {
      workspaceId,
      connectionId: source.id,
      definition,
      page: {
        datasetKey: key,
        schemaVersion: definition.version,
        refreshKey: "report-" + key,
        pageKey: "page-1",
        previousPageKey: null,
        complete: true,
        window: {
          from: "2026-01-01",
          toExclusive: "2026-12-01",
          partition: {},
        },
        records: rows.map((row, index) => ({
          values: Object.fromEntries(
            definition.fields.map((field) => [
              field.id,
              field.id in row
                ? row[field.id]
                : field.id === "row_id"
                  ? String(index)
                  : field.id === "currency"
                    ? "USD"
                    : field.nullable
                      ? null
                      : field.type === "date"
                        ? "2026-10-01"
                        : field.type === "decimal"
                          ? "0"
                          : field.type === "json"
                            ? {}
                            : "",
            ]),
          ),
        })),
      },
      now: at(),
    }),
  );
}

const installs = (template = storeTemplate) =>
  createStoreTemplateService({ db, registry, now: at, template, fetchIcons });
const updates = (template = storeTemplate) =>
  createStoreTemplateUpdateService({
    db,
    registry,
    now: at,
    template,
    fetchIcons,
  });
const products = () => createStoreProductService({ db, now: at });

/**
 * Focus (App Store, paid: in-app proceeds, icon stored), Timer (Google
 * Play, free, icon fetched at install) and Notes (a product of a Play app
 * and an App Store app, free, its icon cannot be fetched).
 */
function install(template = storeTemplate, requestId = randomUUID()) {
  return installs(template).install(actor(), {
    requestId,
    name: "App portfolio",
    connections: [apple.id, google.id],
    groups: [
      {
        id: "8b0f8a8e-2f7a-4d55-9f43-3c3f1d1b0e01",
        name: "Notes: Quick Capture for Ideas",
        apps: [
          { connectionId: google.id, appId: "com.notes" },
          { connectionId: apple.id, appId: "1002" },
        ],
      },
    ],
  });
}
async function readDashboard(id: string) {
  const result = await createDashboardService({ db }).get(actor(), id);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
const shape = (slide: Awaited<ReturnType<typeof readDashboard>>["slides"][0]) =>
  slide.widgets.map((widget) =>
    widget.type === "measure"
      ? `measure:${widget.binding.measureIds.join("+")}`
      : widget.type === "review"
        ? `review:${widget.dimensions.resource}`
        : "metricKey" in widget
          ? `${widget.type}:${widget.metricKey}`
          : widget.type,
  );
/** Every choice the template's (removals: remove). */
const decisions = (
  plan: StoreTemplatePlan,
): { ref: string; choice: "template" | "remove" }[] =>
  plan.records.flatMap((record) =>
    record.items.flatMap(
      (item): { ref: string; choice: "template" | "remove" }[] =>
        item.outcome === "choose"
          ? [{ ref: item.ref, choice: "template" as const }]
          : item.outcome === "propose_removal"
            ? [{ ref: item.ref, choice: "remove" as const }]
            : [],
    ),
  );
async function updateAvailable(requestId: string) {
  const list = await updates().list(actor());
  return list.installs.find((entry) => entry.requestId === requestId)!
    .updateAvailable;
}
/** Applies the offered update and makes its dashboard copy. */
async function applyUpdate(requestId: string, template = storeTemplate) {
  const plan = await updates(template).plan(actor(), requestId);
  const update = await updates(template).apply(actor(), requestId, {
    basis: plan.basis,
    decisions: decisions(plan),
  });
  const data = createDataService(db, at);
  for (const draft of update.drafts)
    if (draft.kind === "preparation")
      await data.publishPreparation(actor(), draft.recordId, draft.version);
    else await data.publishModel(actor(), draft.recordId, draft.version);
  const copied = await updates(template).createCopy(
    actor(),
    update.id,
    "dashboard:portfolio",
  );
  return { plan, copy: await readDashboard(copied.dashboards[0]!.copyId!) };
}

let focusIcon = "";
beforeAll(async () => {
  const test = await createTestDatabase();
  db = createDatabase(test.appUrl);
  owner = createRawSqlClient(test.adminUrl, { max: 1 });
  const admin = createDatabase(test.adminUrl, { max: 1 });
  await syncCatalog(admin, registry);
  await admin.$client.end({ timeout: 5 });
  const [user] = await db
    .insert(schema.users)
    .values({ email: "store-v4@example.test", displayName: "Owner" })
    .returning();
  userId = user!.id;
  workspaceId = await createWorkspace(db, {
    name: "Stores",
    ownerUserId: userId,
  });
  for (const [id, connector, name] of [
    [apple.id, apple.connectorId, apple.name],
    [google.id, google.connectorId, google.name],
    [vercelId, "vercel", "Websites"],
  ])
    await owner`insert into connections(id,workspace_id,connector_id,name,setup_pending)
      values (${id!},${workspaceId},${connector!},${name!},false)`;
  for (const [connectionId, resources] of [
    [
      apple.id,
      [
        ["1001", "Focus Timer: Pomodoro & Deep Work", "app"],
        ["1002", "Notes", "app"],
      ],
    ],
    [
      google.id,
      [
        ["com.timer", "Timer", "app"],
        ["com.notes", "Notes", "app"],
      ],
    ],
    [vercelId, [["prj_focus", "focus.example", "project"]]],
  ] as const)
    await withWorkspace(db, { workspaceId }, (tx) =>
      upsertConnectionResources(tx, {
        workspaceId,
        connectionId,
        resources: resources.map(([id, name, kind]) => ({ id, name, kind })),
        now: at(),
      }),
    );
  // Focus sold in-app purchases in the last 90 days: paid.
  await ingest(apple, "sales_rows", [
    {
      app_id: "1001",
      product_type: "IAY",
      units: "2",
      developer_proceeds_per_unit: "0.70",
    },
    { app_id: "1002", product_type: "1F", units: "10" },
  ]);
  focusIcon = await icon(apple.id, "1001");
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await owner?.end({ timeout: 5 });
  await db?.$client.end({ timeout: 5 });
});

describe("App Portfolio version 4", { timeout: TIMEOUT_MS }, () => {
  it("installs the overview and one slide per app, scoped, with the app's icon", async () => {
    const requestId = randomUUID();
    const result = await install(storeTemplate, requestId);
    expect(result.omittedApps).toBeUndefined();
    // Icons the apps lacked were fetched first: Timer's arrived, Notes'
    // (its App Store app) did not.
    expect(fetched).toEqual(
      expect.arrayContaining([timer, `${apple.id}:1002`]),
    );
    expect(fetched).not.toContain(focus);
    const dashboard = await readDashboard(result.dashboardId);
    expect(dashboard.settings.autoAdvance).toBe(true);
    const [timerIcon] = await owner`select id from workspace_images
      where workspace_id = ${workspaceId} and resource_id = 'com.timer'`;
    expect(
      dashboard.slides.map((slide) => [
        slide.name,
        slide.logoImageId,
        slide.scope,
      ]),
    ).toEqual([
      ["App portfolio", null, {}],
      [
        "Focus Timer: Pomodoro & Deep Work",
        focusIcon,
        { app: { kind: "values", values: [focus] } },
      ],
      [
        "Notes: Quick Capture for Ideas",
        null,
        {
          app: {
            kind: "values",
            values: ["product:8b0f8a8e-2f7a-4d55-9f43-3c3f1d1b0e01"],
          },
        },
      ],
      ["Timer", timerIcon!.id, { app: { kind: "values", values: [timer] } }],
    ]);
    expect(dashboard.slides.map(shape)).toEqual([
      [
        "measure:downloads",
        "measure:proceeds",
        "table:app_store_connect.proceeds",
        "measure:rating+rating_count",
      ],
      // Paid, no website linked: no visitors widget.
      [
        "metric:app_store_connect.proceeds",
        "metric:app_store_connect.downloads",
        "measure:rating+rating_count",
        "review:1001",
      ],
      // Free, in both stores (version 6, #784): both stores' downloads (a
      // total with a line per store); its latest review is its App Store
      // app's, though the Play app comes first in the product.
      ["measure:downloads", "measure:rating+rating_count", "review:1002"],
      // Free, Google Play only: no revenue, no review.
      ["measure:downloads", "measure:rating+rating_count"],
    ]);
    // Readable in every format (ADR 0017 section 6).
    for (const slide of dashboard.slides)
      expect(
        slide.formatWarnings
          .filter((warning) => warning.severity === "attention")
          .map((warning) => `${slide.name} ${warning.format} ${warning.code}`),
      ).toEqual([]);
    // Idempotent: the same request answers the same install.
    expect(await install(storeTemplate, requestId)).toEqual(result);
    expect(await updateAvailable(requestId)).toBe(false);
  });

  it("names the apps past the dashboard's limits at install", async () => {
    const many = Array.from({ length: 12 }, (_, n) => [
      `com.many${String(n).padStart(2, "0")}`,
      `Many ${String(n).padStart(2, "0")}`,
      "app",
    ]);
    const other = "44444444-4444-4444-8444-444444444444";
    await owner`insert into connections(id,workspace_id,connector_id,name,setup_pending)
      values (${other},${workspaceId},'google-play','Many apps',false)`;
    await withWorkspace(db, { workspaceId }, (tx) =>
      upsertConnectionResources(tx, {
        workspaceId,
        connectionId: other,
        resources: many.map(([id, name, kind]) => ({
          id: id!,
          name: name!,
          kind: kind!,
        })),
        now: at(),
      }),
    );
    const result = await installs().install(actor(), {
      requestId: randomUUID(),
      name: "Many apps",
      connections: [other],
      groups: [],
    });
    expect(result.omittedApps).toEqual(["Many 11"]);
    const dashboard = await readDashboard(result.dashboardId);
    expect(dashboard.slides).toHaveLength(12);
    expect(dashboard.slides.at(-1)!.name).toBe("Many 10");
  });

  it("updates a version 3 install to the app slides", async () => {
    const requestId = randomUUID();
    const result = await install(storeTemplateV3, requestId);
    const v3 = await readDashboard(result.dashboardId);
    expect(v3.slides).toHaveLength(1);
    // The customer retitled the downloads table: kept.
    const downloads = v3.slides[0]!.widgets.find(
      (widget) =>
        widget.type === "measure" &&
        widget.binding.measureIds[0] === "downloads",
    )!;
    await owner`update dashboard_widgets set title = 'My downloads'
      where workspace_id = ${workspaceId} and id = ${downloads.id}`;
    expect(await updateAvailable(requestId)).toBe(true);
    const { plan, copy } = await applyUpdate(requestId);
    expect(plan).toMatchObject({
      fromVersion: 3,
      toVersion: STORE_TEMPLATE_VERSION,
    });
    expect(plan.summary.widgets.added).toBeGreaterThan(0);
    expect(copy.settings.autoAdvance).toBe(true);
    expect(copy.slides.map((slide) => slide.name)).toEqual([
      "App portfolio",
      "Focus Timer: Pomodoro & Deep Work",
      "Notes: Quick Capture for Ideas",
      "Timer",
    ]);
    expect(copy.slides[1]!.logoImageId).toBe(focusIcon);
    // The overview's tables move to make room for revenue: the retitled
    // one is the customer's choice (the template's was taken here).
    expect(
      plan.records
        .flatMap((record) => record.items)
        .find((item) => item.ref === "dashboard:portfolio#widget:downloads"),
    ).toMatchObject({ outcome: "choose" });
    // The copy's slides and widgets are the template's: nothing to offer.
    const swapped = await updates().swap(
      actor(),
      (await updates().list(actor())).installs.find(
        (entry) => entry.requestId === requestId,
      )!.openUpdate!.id,
      "dashboard:portfolio",
    );
    expect(swapped.dashboards[0]!.swappedAt).not.toBeNull();
    expect(await updateAvailable(requestId)).toBe(false);
  });

  it("offers version 5's fitted tables to a version 4 install as a reviewed update (#768)", async () => {
    const requestId = randomUUID();
    const result = await install(storeTemplateV4, requestId);
    const v4 = await readDashboard(result.dashboardId);
    const tables = (slide: (typeof v4.slides)[number]) =>
      slide.widgets.flatMap((widget) =>
        widget.type === "measure" && widget.options.view === "table"
          ? [[widget.binding.measureIds[0], widget.options.limit]]
          : [],
      );
    // Version 4 asks for twenty rows in a four-row tile: flagged.
    expect(tables(v4.slides[0]!)).toEqual([
      ["downloads", 20],
      ["proceeds", 20],
      ["rating", 20],
    ]);
    expect(
      v4.slides[0]!.formatWarnings.filter((w) => w.code === "rows_cut").length,
    ).toBeGreaterThan(0);
    expect(await updateAvailable(requestId)).toBe(true);
    const { plan, copy } = await applyUpdate(requestId, storeTemplateV5);
    expect(plan).toMatchObject({ fromVersion: 4, toVersion: 5 });
    // The model tables change (the overview's and each app's ratings),
    // and the App Store's store name: offered for review like any
    // template change.
    const apps = copy.slides.slice(1);
    expect(
      plan.records
        .flatMap((record) => record.items)
        .map((item) =>
          [
            item.ref.replace(/app-[0-9a-f]{16}/, "app"),
            item.change,
            item.outcome,
          ].join(" "),
        )
        .sort(),
    ).toEqual(
      [
        ...apps.map(
          () => "dashboard:portfolio#widget:app:ratings changed template",
        ),
        "dashboard:portfolio#widget:downloads changed template",
        "dashboard:portfolio#widget:proceeds changed template",
        "dashboard:portfolio#widget:ratings changed template",
        // "App Store" instead of "Apple App Store" (short in tables): the
        // App Store sources' store name, a data draft to publish.
        ...["downloads", "proceeds", "ratings"].map(
          (metric) =>
            `preparation:source:${apple.id}:${metric}#step:calculate_store_name changed template`,
        ),
      ].sort(),
    );
    expect(copy.slides).toHaveLength(v4.slides.length);
    // Nothing changes on screens until the copy is swapped in.
    expect(
      tables((await readDashboard(result.dashboardId)).slides[0]!),
    ).toEqual(tables(v4.slides[0]!));
    const overview = copy.slides[0]!;
    expect(
      overview.widgets.flatMap((widget) =>
        widget.type === "measure" ? [widget.options.order ?? null] : [],
      ),
    ).toEqual([
      { measureId: "downloads", direction: "desc" },
      null,
      { measureId: "rating_count", direction: "desc" },
    ]);
    for (const s of copy.slides)
      expect(
        s.formatWarnings
          .filter((w) => w.severity === "attention")
          .map((w) => `${s.name} ${w.format} ${w.code}`),
      ).toEqual([]);
  });

  it("offers both stores on a linked product's slide to a version 5 install as a reviewed update (#784)", async () => {
    const requestId = randomUUID();
    const result = await install(storeTemplateV5, requestId);
    const v5 = await readDashboard(result.dashboardId);
    // Version 5: the linked product (Notes) shows its App Store app only.
    expect(shape(v5.slides[2]!)).toEqual([
      "metric:app_store_connect.downloads",
      "measure:rating+rating_count",
      "review:1002",
    ]);
    expect(await updateAvailable(requestId)).toBe(true);
    const { plan, copy } = await applyUpdate(requestId);
    expect(plan).toMatchObject({ fromVersion: 5, toVersion: 6 });
    // Only the linked product's downloads change; single-store apps and
    // the overview stay as they were.
    expect(
      plan.records
        .flatMap((record) => record.items)
        .map((item) =>
          [
            item.ref.replace(/app-[0-9a-f]{16}/, "app"),
            item.change,
            item.outcome,
          ].join(" "),
        ),
    ).toEqual(["dashboard:portfolio#widget:app:downloads changed template"]);
    // Nothing changes on screens until the copy is swapped in.
    expect(shape((await readDashboard(result.dashboardId)).slides[2]!)).toEqual(
      shape(v5.slides[2]!),
    );
    const notes = copy.slides[2]!;
    expect(shape(notes)).toEqual([
      "measure:downloads",
      "measure:rating+rating_count",
      "review:1002",
    ]);
    const split = notes.widgets[0]!;
    if (split.type !== "measure") throw new Error("not a measure");
    expect(split.binding.groupBy).toEqual(["store"]);
    expect(split.options).toMatchObject({ view: "value", limit: 2 });
    for (const slide of [...copy.slides, ...v5.slides])
      expect(
        slide.formatWarnings
          .filter((w) => w.severity === "attention")
          .map((w) => `${slide.name} ${w.format} ${w.code}`),
      ).toEqual([]);
    const swapped = await updates().swap(
      actor(),
      (await updates().list(actor())).installs.find(
        (entry) => entry.requestId === requestId,
      )!.openUpdate!.id,
      "dashboard:portfolio",
    );
    expect(swapped.dashboards[0]!.swappedAt).not.toBeNull();
    expect(await updateAvailable(requestId)).toBe(false);
  });

  it("saves a version 5 table edited in the Studio (#768)", async () => {
    const result = await install(storeTemplate, randomUUID());
    const dashboard = await readDashboard(result.dashboardId);
    const service = createDashboardService({ db });
    const save = (slides: typeof dashboard.slides, version: number) =>
      service.replace(
        actor(),
        result.dashboardId,
        replaceDashboardRequestSchema.parse({
          version,
          name: dashboard.name,
          projectId: dashboard.projectId,
          slides: slides.map(
            ({ formatWarnings: _warnings, ...slide }) => slide,
          ),
        }),
      );
    // The ratings table ranks by its rating count; unticking that measure
    // left the order behind before the Studio dropped it: it is ignored.
    const untick = (keep: (options: object, binding: object) => object) =>
      dashboard.slides.map((slide, index) =>
        index !== 0
          ? slide
          : {
              ...slide,
              widgets: slide.widgets.map((widget) => {
                if (
                  widget.type !== "measure" ||
                  !widget.binding.measureIds.includes("rating_count")
                )
                  return widget;
                const binding = { ...widget.binding, measureIds: ["rating"] };
                return {
                  ...widget,
                  binding,
                  options: keep(widget.options, binding),
                };
              }),
            },
      ) as typeof dashboard.slides;
    const kept = await save(
      untick((options) => options),
      dashboard.version,
    );
    expect(kept.ok, JSON.stringify(kept)).toBe(true);
    // What the Studio saves now: no order or label for the removed measure.
    const studio = untick((options, binding) =>
      measureOptionsForBinding(
        binding as { measureIds: string[]; groupBy: string[] },
        options as { view: "table" },
      ),
    );
    const ratings = studio[0]!.widgets.find(
      (widget) =>
        widget.type === "measure" && widget.binding.groupBy.includes("listing"),
    )!;
    expect(ratings.type === "measure" && ratings.options).toMatchObject({
      view: "table",
      labels: { listing: expect.any(String), storefront: expect.any(String) },
    });
    expect(ratings.type === "measure" && "order" in ratings.options).toBe(
      false,
    );
    const saved = await save(studio, dashboard.version + 1);
    expect(saved.ok, JSON.stringify(saved)).toBe(true);
  });

  it("offers an app that turned free, or got a website, as an update", async () => {
    const requestId = randomUUID();
    const result = await install(storeTemplate, requestId);
    expect(await updateAvailable(requestId)).toBe(false);
    await products().update(actor(), requestId, {
      products: [
        {
          productId: focus,
          pricing: "free",
          website: { connectionId: vercelId, projectId: "prj_focus" },
        },
      ],
    });
    // Nothing changes on the dashboard by itself.
    const before = await readDashboard(result.dashboardId);
    expect(
      before.slides.find((s) => s.name?.startsWith("Focus"))!.widgets,
    ).toHaveLength(4);
    expect(await updateAvailable(requestId)).toBe(true);
    const { plan, copy } = await applyUpdate(requestId);
    expect(plan).toMatchObject({
      fromVersion: STORE_TEMPLATE_VERSION,
      toVersion: STORE_TEMPLATE_VERSION,
    });
    const slide = `dashboard:portfolio#widget:${appSlideKey(focus)}`;
    const items = plan.records.flatMap((record) => record.items);
    expect(
      items
        .filter((item) => item.ref.startsWith(slide))
        .map((item) => [item.ref.slice(slide.length), item.outcome])
        .filter(([, outcome]) => outcome !== "template"),
    ).toEqual([[":revenue", "propose_removal"]]);
    expect(items.map((item) => item.ref)).toContain(`${slide}:visitors`);
    const focusSlide = copy.slides.find((s) => s.name?.startsWith("Focus"))!;
    expect(shape(focusSlide)).toEqual([
      "metric:app_store_connect.downloads",
      "metric:vercel.visitors",
      "measure:rating+rating_count",
      "review:1001",
    ]);
    // The overview adds the website's visitors.
    expect(shape(copy.slides[0]!)).toContain("table:vercel.visitors");
    for (const s of copy.slides)
      expect(
        s.formatWarnings.filter((w) => w.severity === "attention"),
      ).toEqual([]);
  });

  it("says a newer version is still to be swapped in after a closed v3 → v4 update", async () => {
    const requestId = randomUUID();
    await install(storeTemplateV3, requestId);
    const plan = await updates().plan(actor(), requestId);
    const update = await updates().apply(actor(), requestId, {
      basis: plan.basis,
      decisions: decisions(plan),
    });
    await updates().closeUpdate(actor(), requestId, update.id);
    const listed = (await updates().list(actor())).installs.find(
      (entry) => entry.requestId === requestId,
    )!;
    // The install is at the current version, its dashboard record still
    // at 3: the apps page asks for the update first, as scopePlan does.
    expect(listed).toMatchObject({
      templateVersion: STORE_TEMPLATE_VERSION,
      latestVersion: STORE_TEMPLATE_VERSION,
      updateAvailable: true,
      newerVersion: true,
    });
    await expect(
      updates().scopePlan(actor(), requestId, {
        connections: [apple.id, google.id],
        appScope: null,
      }),
    ).rejects.toThrow("store_template_update_available");
  });

  it("fetches the icons of the apps a scope change adds", async () => {
    // App Store only at first, then Google Play too.
    const narrow = randomUUID();
    await installs().install(actor(), {
      requestId: narrow,
      name: "App Store apps",
      connections: [apple.id],
      groups: [],
    });
    fetched.length = 0;
    await updates().scopePlan(actor(), narrow, {
      connections: [apple.id, google.id],
      appScope: null,
    });
    expect(fetched).toContain(`${google.id}:com.notes`);
    // A dashboard of one app (no slides, no fetch) becomes a portfolio.
    const fixed = randomUUID();
    await installs().install(actor(), {
      requestId: fixed,
      name: "Notes only",
      connections: [apple.id],
      groups: [],
      appScope: { connectionId: apple.id, appId: "1002" },
    });
    fetched.length = 0;
    await updates().scopePlan(actor(), fixed, {
      connections: [apple.id],
      appScope: null,
    });
    expect(fetched).toContain(`${apple.id}:1002`);
  });

  it("lets a scope change build from changed apps instead of holding it up", async () => {
    const requestId = randomUUID();
    await install(storeTemplate, requestId);
    await products().update(actor(), requestId, {
      products: [{ productId: focus, pricing: "free", website: null }],
    });
    expect(await updateAvailable(requestId)).toBe(true);
    // The same connections, Google Play only: Focus's slide goes with its
    // connection, and the plan reads the apps as they are now.
    const plan = await updates().scopePlan(actor(), requestId, {
      connections: [google.id],
      appScope: null,
    });
    const refs = plan.records.flatMap((record) =>
      record.items.map((item) => item.ref),
    );
    expect(refs).toContain(`dashboard:portfolio#slide:${appSlideKey(focus)}`);
    expect(plan.toVersion).toBe(plan.fromVersion);
  });

  it("is readable in German with the widest app slide: paid, with a website", async () => {
    locale = "de";
    try {
      const requestId = randomUUID();
      await install(storeTemplate, requestId);
      await products().update(actor(), requestId, {
        products: [
          {
            productId: focus,
            pricing: "paid",
            website: { connectionId: vercelId, projectId: "prj_focus" },
          },
        ],
      });
      const { copy } = await applyUpdate(requestId);
      const focusSlide = copy.slides.find((s) => s.name?.startsWith("Focus"))!;
      expect(focusSlide.widgets.map((w) => w.title)).toEqual([
        "Erlöse, letzte 30 Tage",
        "Downloads, letzte 30 Tage",
        "Website-Besucher, letzte 30 Tage",
        "Store-Bewertungen",
        null,
      ]);
      for (const s of copy.slides)
        expect(
          s.formatWarnings
            .filter((w) => w.severity === "attention")
            .map((w) => `${s.name} ${w.format} ${w.code}`),
        ).toEqual([]);
    } finally {
      locale = "en";
    }
  });

  it("names a slide after its first app when the product's name is empty", async () => {
    const requestId = randomUUID();
    const result = await install(storeTemplate, requestId);
    // An empty product name is valid in the editable Products table.
    const data = createDataService(db, at);
    const table = await data.readManual(actor(), result.productDatasetId, {
      offset: 0,
      limit: 1000,
    });
    await data.saveManual(
      actor(),
      {
        definition: table.definition,
        records: table.records.map((record) => ({
          values: String(record.values.product_id).startsWith("product:")
            ? { ...record.values, product_name: "" }
            : record.values,
        })),
        generationId: table.generationId,
      },
      result.productDatasetId,
    );
    // Listing installs and the update work; the slide has a name.
    expect(await updateAvailable(requestId)).toBe(true);
    const { copy } = await applyUpdate(requestId);
    expect(copy.slides.map((slide) => slide.name)).toEqual([
      "App portfolio",
      "Focus Timer: Pomodoro & Deep Work",
      "Notes",
      "Timer",
    ]);
  });

  it("offers the app changes again when their update is closed before the swap", async () => {
    const requestId = randomUUID();
    await install(storeTemplate, requestId);
    await products().update(actor(), requestId, {
      products: [{ productId: focus, pricing: "free", website: null }],
    });
    const plan = await updates().plan(actor(), requestId);
    const update = await updates().apply(actor(), requestId, {
      basis: plan.basis,
      decisions: decisions(plan),
    });
    await updates().closeUpdate(actor(), requestId, update.id);
    // The dashboard on screens still has Focus's revenue: still an update.
    expect(await updateAvailable(requestId)).toBe(true);
    const again = await updates().plan(actor(), requestId);
    expect(
      again.records.flatMap((record) => record.items).map((item) => item.ref),
    ).toContain(`dashboard:portfolio#widget:${appSlideKey(focus)}:revenue`);
    // Swapping back restores the old slides: the update is offered again.
    const { copy } = await applyUpdate(requestId);
    const listed = (await updates().list(actor())).installs.find(
      (entry) => entry.requestId === requestId,
    )!;
    await updates().swap(actor(), listed.openUpdate!.id, "dashboard:portfolio");
    expect(await updateAvailable(requestId)).toBe(false);
    await updates().swapBack(
      actor(),
      listed.openUpdate!.id,
      "dashboard:portfolio",
    );
    expect(await updateAvailable(requestId)).toBe(true);
    expect(
      copy.slides.find((s) => s.name?.startsWith("Focus"))!.widgets,
    ).toHaveLength(3);
  });

  it("makes the copy with an app's current icon after the daily refresh replaced it", async () => {
    const requestId = randomUUID();
    await install(storeTemplateV3, requestId);
    const plan = await updates().plan(actor(), requestId);
    const update = await updates().apply(actor(), requestId, {
      basis: plan.basis,
      decisions: decisions(plan),
    });
    const data = createDataService(db, at);
    for (const draft of update.drafts)
      if (draft.kind === "preparation")
        await data.publishPreparation(actor(), draft.recordId, draft.version);
      else await data.publishModel(actor(), draft.recordId, draft.version);
    // The refresh stores a changed icon and removes the old one, as
    // images/resource-icons.ts does.
    const content = Buffer.from("a refreshed icon");
    const [fresh] = await owner`insert into workspace_images
        (workspace_id, name, content_type, bytes, width, height, sha256,
         content, origin, connection_id, resource_id, created_at)
      values (${workspaceId}, 'App icon', 'image/png', ${content.length}, 64,
        64, ${createHash("sha256").update(content).digest("hex")}, ${content},
        'resource_icon', ${apple.id}, '1001', ${now})
      returning id`;
    await withWorkspace(db, { workspaceId }, (tx) =>
      replaceImageReferences(tx, workspaceId, focusIcon, fresh!.id as string),
    );
    await owner`delete from workspace_images where id = ${focusIcon}`;
    focusIcon = fresh!.id as string;
    const copied = await updates().createCopy(
      actor(),
      update.id,
      "dashboard:portfolio",
    );
    const copy = await readDashboard(copied.dashboards[0]!.copyId!);
    expect(
      copy.slides.find((s) => s.name?.startsWith("Focus"))!.logoImageId,
    ).toBe(focusIcon);
  });

  it("refuses the same app update applied twice as stale", async () => {
    const requestId = randomUUID();
    await install(storeTemplate, requestId);
    await products().update(actor(), requestId, {
      products: [{ productId: focus, pricing: "free", website: null }],
    });
    const plan = await updates().plan(actor(), requestId);
    const body = { basis: plan.basis, decisions: decisions(plan) };
    await updates().apply(actor(), requestId, body);
    // A double click or a second tab: the first update stays.
    await expect(updates().apply(actor(), requestId, body)).rejects.toThrow(
      "store_update_stale",
    );
  });

  it("makes the copy of a renamed app after the refresh replaced its icon", async () => {
    const requestId = randomUUID();
    await install(storeTemplate, requestId);
    // Focus is renamed: its slide's name changes in the update.
    await withWorkspace(db, { workspaceId }, (tx) =>
      upsertConnectionResources(tx, {
        workspaceId,
        connectionId: apple.id,
        resources: [{ id: "1001", name: "Focus Pro", kind: "app" }],
        now: at(),
      }),
    );
    const plan = await updates().plan(actor(), requestId);
    const update = await updates().apply(actor(), requestId, {
      basis: plan.basis,
      decisions: decisions(plan),
    });
    // Before the copy, the daily refresh replaces Focus's icon.
    const content = Buffer.from("an icon refreshed again");
    const [fresh] = await owner`insert into workspace_images
        (workspace_id, name, content_type, bytes, width, height, sha256,
         content, origin, connection_id, resource_id, created_at)
      values (${workspaceId}, 'App icon', 'image/png', ${content.length}, 64,
        64, ${createHash("sha256").update(content).digest("hex")}, ${content},
        'resource_icon', ${apple.id}, '1001', ${now})
      returning id`;
    await withWorkspace(db, { workspaceId }, (tx) =>
      replaceImageReferences(tx, workspaceId, focusIcon, fresh!.id as string),
    );
    await owner`delete from workspace_images where id = ${focusIcon}`;
    focusIcon = fresh!.id as string;
    const copied = await updates().createCopy(
      actor(),
      update.id,
      "dashboard:portfolio",
    );
    const copy = await readDashboard(copied.dashboards[0]!.copyId!);
    const slide = copy.slides.find((s) => s.name === "Focus Pro")!;
    expect(slide.logoImageId).toBe(focusIcon);
  });

  // Last: its apps would be listed by every install after it.
  it("offers a two-store app's App Store icon after its Play icon was refreshed", async () => {
    // Clock is in both stores; only its Play app has an icon at install.
    for (const [connectionId, id] of [
      [apple.id, "1003"],
      [google.id, "com.clock"],
    ] as const)
      await withWorkspace(db, { workspaceId }, (tx) =>
        upsertConnectionResources(tx, {
          workspaceId,
          connectionId,
          resources: [{ id, name: "Clock", kind: "app" }],
          now: at(),
        }),
      );
    const playIcon = await icon(google.id, "com.clock");
    const requestId = randomUUID();
    const result = await installs().install(actor(), {
      requestId,
      name: "App portfolio",
      connections: [apple.id, google.id],
      groups: [
        {
          id: "8b0f8a8e-2f7a-4d55-9f43-3c3f1d1b0e02",
          name: "Clock",
          apps: [
            { connectionId: google.id, appId: "com.clock" },
            { connectionId: apple.id, appId: "1003" },
          ],
        },
      ],
    });
    const clockLogo = async (dashboardId: string) =>
      (await readDashboard(dashboardId)).slides.find(
        (slide) => slide.name === "Clock",
      )!.logoImageId;
    expect(await clockLogo(result.dashboardId)).toBe(playIcon);
    expect(await updateAvailable(requestId)).toBe(false);

    // The daily refresh replaces the Play icon, as images/resource-icons.ts
    // does: the new image takes the old one's place, which is removed.
    const content = Buffer.from("a refreshed Play icon");
    const [refreshed] = await owner`insert into workspace_images
        (workspace_id, name, content_type, bytes, width, height, sha256,
         content, origin, connection_id, resource_id, created_at)
      values (${workspaceId}, 'App icon', 'image/png', ${content.length}, 64,
        64, ${createHash("sha256").update(content).digest("hex")}, ${content},
        'resource_icon', ${google.id}, 'com.clock', ${now})
      returning id`;
    await withWorkspace(db, { workspaceId }, (tx) =>
      replaceImageReferences(
        tx,
        workspaceId,
        playIcon,
        refreshed!.id as string,
      ),
    );
    await owner`delete from workspace_images where id = ${playIcon}`;
    expect(await clockLogo(result.dashboardId)).toBe(refreshed!.id);
    // A refreshed logo alone is no update.
    expect(await updateAvailable(requestId)).toBe(false);

    // Then the App Store icon, which the product prefers, arrives.
    const appStoreIcon = await icon(apple.id, "1003");
    expect(await updateAvailable(requestId)).toBe(true);
    const { plan, copy } = await applyUpdate(requestId);
    expect(
      plan.records
        .flatMap((record) => record.items)
        .find(
          (item) =>
            item.ref ===
            `dashboard:portfolio#slide:${appSlideKey("product:8b0f8a8e-2f7a-4d55-9f43-3c3f1d1b0e02")}`,
        ),
    ).toMatchObject({ change: "changed", outcome: "template" });
    expect(copy.slides.find((s) => s.name === "Clock")!.logoImageId).toBe(
      appStoreIcon,
    );
    const listed = (await updates().list(actor())).installs.find(
      (entry) => entry.requestId === requestId,
    )!;
    await updates().swap(actor(), listed.openUpdate!.id, "dashboard:portfolio");
    expect(await clockLogo(copy.id)).toBe(appStoreIcon);
    expect(await updateAvailable(requestId)).toBe(false);
  });
});
