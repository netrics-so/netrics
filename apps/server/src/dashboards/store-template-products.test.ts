import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  createRawSqlClient,
  adminSetDataPolicy,
  createWorkspace,
  ingestDatasetPage,
  schema,
  upsertConnectionResources,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";
import { DEFAULT_DATA_POLICY, type DataRow } from "@netrics/domain";
import { createDefaultRegistry } from "../connectors.js";
import { syncCatalog } from "../sync/catalog.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "../test-db.js";
import { createDataService } from "../data/service.js";
import { createStoreTemplateService } from "./store-template-service.js";
import { storeTemplateV3 } from "./store-template.js";
import { createStoreProductService } from "./store-template-products.js";
import { apple, google, now } from "./test-helpers.js";

// Product identity of a store-template install (#708): icon, paid or free
// and linked website. The install is made before migration 0079, so it is
// an existing install when the settings table arrives.

let db: Database, owner: Sql, workspaceId: string, otherId: string;
let userId: string, productDatasetId: string, mappingDatasetId: string;
const registry = createDefaultRegistry();
const vercelId = "33333333-3333-4333-8333-333333333333",
  foreignVercelId = "44444444-4444-4444-8444-444444444444";
const requestId = randomUUID(),
  groupId = randomUUID();
const group = "product:" + groupId,
  beta = google.id + ":com.example.beta",
  gamma = google.id + ":com.example.gamma",
  reported = google.id + ":com.example.reported";
const actor = () => ({ workspaceId, callerId: userId, locale: "en" as const });
const products = () =>
  createStoreProductService({ db, now: () => new Date(now) });

/** Rewrites the install's Products table as the customer can in Data & measures. */
async function editProducts(
  edit: (rows: Record<string, unknown>[]) => Record<string, unknown>[],
  datasetId = productDatasetId,
) {
  const data = createDataService(db, () => new Date(now));
  const current = await data.readManual(actor(), datasetId, {
    offset: 0,
    limit: 1000,
  });
  await data.saveManual(
    actor(),
    {
      definition: current.definition,
      records: edit(current.records.map((record) => record.values)).map(
        (values) => ({ values }),
      ),
      generationId: current.generationId,
    },
    datasetId,
  );
}

async function ingest(
  source: typeof apple,
  key: string,
  rows: DataRow[],
  refresh = "",
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
        refreshKey: "report-" + key + refresh,
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
      now: new Date(now),
    }),
  );
}

async function icon(connectionId: string, resourceId: string, at: string) {
  const content = Buffer.from(at + resourceId);
  const [row] = await owner`insert into workspace_images
      (workspace_id, name, content_type, bytes, width, height, sha256, content,
       origin, connection_id, resource_id, created_at)
    values (${workspaceId}, 'App icon', 'image/png', ${content.length}, 1, 1,
      ${createHash("sha256").update(content).digest("hex")}, ${content},
      'resource_icon', ${connectionId}, ${resourceId}, ${at})
    returning id`;
  return row!.id as string;
}

beforeAll(async () => {
  const test = await createTestDatabase({
    upTo: "0078_connection_freshness",
  });
  db = createDatabase(test.appUrl);
  owner = createRawSqlClient(test.adminUrl, { max: 1 });
  const admin = createDatabase(test.adminUrl, { max: 1 });
  await syncCatalog(admin, registry);
  await admin.$client.end({ timeout: 5 });
  const [user] = await db
    .insert(schema.users)
    .values({ email: "store-products@example.test", displayName: "Owner" })
    .returning();
  userId = user!.id;
  workspaceId = await createWorkspace(db, {
    name: "Stores",
    ownerUserId: userId,
  });
  otherId = await createWorkspace(db, { name: "Other", ownerUserId: userId });
  for (const [id, workspace, connector, name] of [
    [apple.id, workspaceId, apple.connectorId, apple.name],
    [google.id, workspaceId, google.connectorId, google.name],
    [vercelId, workspaceId, "vercel", "Websites"],
    [foreignVercelId, otherId, "vercel", "Other websites"],
  ])
    await owner`insert into connections(id,workspace_id,connector_id,name,setup_pending)
      values (${id!},${workspace!},${connector!},${name!},false)`;
  for (const [workspace, connectionId, resources] of [
    [workspaceId, apple.id, [["a", "Apple Example", "iOS"]]],
    [
      workspaceId,
      google.id,
      [
        ["com.example.alpha", "Android Example", "Android"],
        ["com.example.beta", "Beta", "Android"],
        ["com.example.gamma", "Gamma", "Android"],
      ],
    ],
    [workspaceId, vercelId, [["prj_site", "example.com", "project"]]],
    [otherId, foreignVercelId, [["prj_other", "other.example", "project"]]],
  ] as const)
    await withWorkspace(db, { workspaceId: workspace }, (tx) =>
      upsertConnectionResources(tx, {
        workspaceId: workspace,
        connectionId,
        resources: resources.map(([id, name, kind]) => ({ id, name, kind })),
        now: new Date(now),
      }),
    );
  // The install runs today's service code, which reads every connections
  // column, so it runs on the migrated schema; the rows above are in the
  // previous shape, and the install keeps the template version from before
  // 0079 and has no product settings.
  await test.migrate();
  ({ productDatasetId, mappingDatasetId } = await createStoreTemplateService({
    db,
    registry,
    now: () => new Date(now),
    // Made before 0079 (no app identity yet): version 3.
    template: storeTemplateV3,
  }).install(actor(), {
    requestId,
    name: "App portfolio",
    connections: [apple.id, google.id],
    groups: [
      {
        id: groupId,
        name: "Example app",
        apps: [
          { connectionId: apple.id, appId: "a" },
          { connectionId: google.id, appId: "com.example.alpha" },
        ],
      },
    ],
  }));
  // Proceeds: the group's App Store app sold in-app purchases; beta earned
  // within 90 days; gamma's only charge is older than 90 days, and its
  // recent rows are fees and free units.
  await ingest(apple, "sales_rows", [
    {
      app_id: "a",
      product_type: "1F",
      units: "10",
      developer_proceeds_per_unit: "0",
    },
    {
      app_id: "a",
      product_type: "IAY",
      units: "2",
      developer_proceeds_per_unit: "0.70",
    },
  ]);
  await ingest(google, "earning_rows", [
    { app_id: "com.example.beta", merchant_amount: "4.99", currency: "EUR" },
    {
      app_id: "com.example.gamma",
      merchant_amount: "1.99",
      transaction_day: "2026-07-01",
    },
    { app_id: "com.example.gamma", merchant_amount: "-0.30" },
    // A package the earnings report names but discovery never listed.
    { app_id: "com.example.reported", merchant_amount: "2.99" },
  ]);
}, TEST_DATABASE_SETUP_TIMEOUT_MS);
afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
  await owner?.end({ timeout: 5 });
});

describe("store product identity", { timeout: 20_000 }, () => {
  it("gives an install made before the settings the defaults, paid from proceeds", async () => {
    const read = await products().read(actor(), requestId);
    expect(read.products.map((product) => product.productId)).toEqual([
      group,
      beta,
      gamma,
      reported,
    ]);
    // Only in the synced reports: named by its id, as in the data.
    expect(read.products[3]).toMatchObject({
      name: "com.example.reported",
      apps: [{ connectionId: google.id, appId: "com.example.reported" }],
      hadProceeds: true,
      paid: true,
      // Not a discovered resource: the icon service would not find it.
      iconSource: null,
      icon: null,
    });
    expect(read.products[0]).toMatchObject({
      name: "Example app",
      apps: [
        { connectionId: apple.id, appId: "a", name: "Apple Example" },
        { connectionId: google.id, appId: "com.example.alpha" },
      ],
      pricing: "auto",
      hadProceeds: true,
      paid: true,
      website: null,
    });
    expect(read.products[1]).toMatchObject({
      name: "Beta",
      pricing: "auto",
      hadProceeds: true,
      paid: true,
    });
    // Older than 90 days, or not positive: free.
    expect(read.products[2]).toMatchObject({
      name: "Gamma",
      pricing: "auto",
      hadProceeds: false,
      paid: false,
    });
    expect(read.websites).toEqual([
      {
        connectionId: vercelId,
        name: "Websites",
        projects: [{ id: "prj_site", name: "example.com" }],
      },
    ]);
    expect(await owner`select * from data_template_products`).toHaveLength(0);
  });

  it("lets the owner override auto, and back", async () => {
    const changed = await products().update(actor(), requestId, {
      products: [
        { productId: beta, pricing: "free", website: null },
        { productId: gamma, pricing: "paid", website: null },
      ],
    });
    const of = (id: string) =>
      changed.products.find((product) => product.productId === id)!;
    expect(of(beta)).toMatchObject({
      pricing: "free",
      hadProceeds: true,
      paid: false,
    });
    expect(of(gamma)).toMatchObject({
      pricing: "paid",
      hadProceeds: false,
      paid: true,
    });
    expect(of(group)).toMatchObject({ pricing: "auto", paid: true });
    const back = await products().update(actor(), requestId, {
      products: [{ productId: beta, pricing: "auto", website: null }],
    });
    expect(
      back.products.find((product) => product.productId === beta),
    ).toMatchObject({ pricing: "auto", paid: true });
    // Back at the defaults: no row.
    expect(
      (await owner`select product_id from data_template_products`).map(
        (row) => row.product_id,
      ),
    ).toEqual([gamma]);
  });

  it("links a website of the workspace and refuses other connections", async () => {
    const linked = await products().update(actor(), requestId, {
      products: [
        {
          productId: group,
          pricing: "auto",
          website: { connectionId: vercelId, projectId: "prj_site" },
        },
      ],
    });
    expect(linked.products[0]!.website).toEqual({
      connectionId: vercelId,
      projectId: "prj_site",
      name: "example.com",
    });
    for (const website of [
      // Another workspace's Vercel connection and project.
      { connectionId: foreignVercelId, projectId: "prj_other" },
      // A project the connection does not know.
      { connectionId: vercelId, projectId: "prj_unknown" },
      // Not a Vercel connection.
      { connectionId: apple.id, projectId: "a" },
    ])
      await expect(
        products().update(actor(), requestId, {
          products: [{ productId: beta, pricing: "auto", website }],
        }),
      ).rejects.toThrow("store_website_invalid");
    await expect(
      products().update(actor(), requestId, {
        products: [
          { productId: "product:unknown", pricing: "paid", website: null },
        ],
      }),
    ).rejects.toThrow("store_product_unknown");
    // The database binds the website to the row's workspace, too.
    await expect(
      owner`insert into data_template_products
          (workspace_id, request_id, product_id, website_connection_id, website_resource_id)
        values (${workspaceId}, ${requestId}, ${beta}, ${foreignVercelId}, 'prj_other')`,
    ).rejects.toThrow(/data_template_products_website_fk/);
    // Another workspace sees neither the install nor its settings.
    await expect(
      products().read({ workspaceId: otherId, callerId: userId }, requestId),
    ).rejects.toThrow("store_template_not_found");
    expect(
      await withWorkspace(db, { workspaceId: otherId }, (tx) =>
        tx.select().from(schema.dataTemplateProducts),
      ),
    ).toHaveLength(0);
  });

  it("takes the icon from the stored resource icons and follows their refresh", async () => {
    const before = await products().read(actor(), requestId);
    expect(before.products[0]!.icon).toBeNull();
    expect(before.products[0]!.iconSource).toEqual({
      connectionId: apple.id,
      resourceId: "a",
    });
    const play = await icon(
      google.id,
      "com.example.alpha",
      "2026-11-01T00:00:00Z",
    );
    expect(
      (await products().read(actor(), requestId)).products[0]!.icon,
    ).toMatchObject({ id: play, connectionId: google.id });
    // The App Store icon comes first; a refreshed one replaces it.
    await icon(apple.id, "a", "2026-11-02T00:00:00Z");
    const refreshed = await icon(apple.id, "a", "2026-11-03T00:00:00Z");
    const after = await products().read(actor(), requestId);
    expect(after.products[0]!.icon).toMatchObject({
      id: refreshed,
      connectionId: apple.id,
      resourceId: "a",
    });
    expect(after.products[1]!.icon).toBeNull();
    expect(after.products[1]!.iconSource).toEqual({
      connectionId: google.id,
      resourceId: "com.example.beta",
    });
  });

  it("clears only the website when its connection is deleted", async () => {
    await products().update(actor(), requestId, {
      products: [
        {
          productId: gamma,
          pricing: "paid",
          website: { connectionId: vercelId, projectId: "prj_site" },
        },
      ],
    });
    await owner`delete from connections where id=${vercelId}`;
    const read = await products().read(actor(), requestId);
    expect(
      read.products.find((product) => product.productId === gamma),
    ).toMatchObject({ pricing: "paid", paid: true, website: null });
    expect(read.websites).toEqual([]);
  });

  it("resolves a product like the preparations: a renamed app keeps its app", async () => {
    // The customer names an app without a linked product in Products.
    await editProducts((rows) => [
      ...rows,
      { product_id: beta, product_name: "Beta renamed" },
    ]);
    const read = await products().read(actor(), requestId);
    expect(
      read.products.filter((product) => product.productId === beta),
    ).toEqual([
      expect.objectContaining({
        name: "Beta renamed",
        apps: [expect.objectContaining({ appId: "com.example.beta" })],
        hadProceeds: true,
        paid: true,
        iconSource: { connectionId: google.id, resourceId: "com.example.beta" },
      }),
    ]);
  });

  it("keeps a linked product whose Products row was removed, with its settings", async () => {
    await products().update(actor(), requestId, {
      products: [{ productId: group, pricing: "free", website: null }],
    });
    await editProducts((rows) =>
      rows.filter((row) => row.product_id !== group),
    );
    const read = await products().read(actor(), requestId);
    const ids = read.products.map((product) => product.productId);
    // The mapping still links both apps to the product, as in the data.
    expect(ids).toContain(group);
    expect(ids).not.toContain(apple.id + ":a");
    expect(ids).not.toContain(google.id + ":com.example.alpha");
    expect(
      read.products.find((product) => product.productId === group),
    ).toMatchObject({
      // The first app's name, as the preparations fall back to it.
      name: "Apple Example",
      apps: [
        expect.objectContaining({ appId: "a" }),
        expect.objectContaining({ appId: "com.example.alpha" }),
      ],
      pricing: "free",
      paid: false,
    });
  });

  it("lists every app of a large catalog and accepts settings for the last", async () => {
    const many = Array.from({ length: 600 }, (_, index) => ({
      id: `com.example.many${String(index).padStart(3, "0")}`,
      name: `Many ${String(index).padStart(3, "0")}`,
      kind: "Android",
    }));
    await withWorkspace(db, { workspaceId }, (tx) =>
      upsertConnectionResources(tx, {
        workspaceId,
        connectionId: google.id,
        resources: many,
        now: new Date(now),
      }),
    );
    const read = await products().read(actor(), requestId);
    const ids = new Set(read.products.map((product) => product.productId));
    for (const app of many) expect(ids).toContain(google.id + ":" + app.id);
    const last = google.id + ":" + many.at(-1)!.id;
    const changed = await products().update(actor(), requestId, {
      products: [{ productId: last, pricing: "paid", website: null }],
    });
    expect(
      changed.products.find((product) => product.productId === last),
    ).toMatchObject({ pricing: "paid", paid: true });
    // Past the workspace's query row limit the read fails; it never cuts.
    await adminSetDataPolicy(db, workspaceId, { queryRows: 100 });
    try {
      await expect(products().read(actor(), requestId)).rejects.toThrow(
        "data_source_row_limit",
      );
    } finally {
      await adminSetDataPolicy(db, workspaceId, {});
    }
  });

  it("bounds the catalog by the deployment's data policy", async () => {
    const withRows = (queryRows: number | null) =>
      createStoreProductService({
        db,
        now: () => new Date(now),
        policy: { ...DEFAULT_DATA_POLICY, queryRows },
      });
    await expect(withRows(1).read(actor(), requestId)).rejects.toThrow(
      "data_source_row_limit",
    );
    // Unlimited: every app, past the default's ceiling too.
    expect(
      (await withRows(null).read(actor(), requestId)).products.length,
    ).toBeGreaterThan(600);
  });

  it("leaves out records past the deployment's retention ceiling", async () => {
    const later = new Date(Date.parse(now) + 10 * 86_400_000);
    const read = await createStoreProductService({
      db,
      now: () => later,
      policy: { ...DEFAULT_DATA_POLICY, maxRetentionDays: 5 },
    }).read(actor(), requestId);
    // Beta's earnings were collected 10 days ago: beyond 5 days, unread.
    expect(
      read.products.find((product) => product.productId === beta),
    ).toMatchObject({ hadProceeds: false });
  });

  it("bounds the apps of the synced reports by the row budget", async () => {
    const products = () =>
      createStoreProductService({
        db,
        now: () => new Date(now),
        policy: { ...DEFAULT_DATA_POLICY, queryRows: 605 },
      });
    // The discovered catalog alone fits.
    await products().read(actor(), requestId);
    await ingest(
      google,
      "earning_rows",
      Array.from({ length: 700 }, (_, index) => ({
        app_id: `com.example.report${index}`,
        merchant_amount: "1.00",
      })),
      "-many",
    );
    await expect(products().read(actor(), requestId)).rejects.toThrow(
      "data_source_row_limit",
    );
  });

  it(
    "reads a year of App Store sales for a small portfolio with the default policy",
    { timeout: 120_000 },
    async () => {
      // 4 apps × 150 territories × 365 days = 219,000 rows, more than the
      // default 100,000-row query budget; only app "a" had proceeds, on
      // the last day. Written as one generation straight into the store.
      const [dataset] = await owner`select id from data_datasets
        where workspace_id=${workspaceId} and connection_id=${apple.id}
          and kind='source' and key='sales_rows'`;
      const [next] = await owner`select coalesce(max(sequence),0)+1 as sequence,
          max(schema_version) as version
        from data_generations where dataset_id=${dataset!.id}`;
      const [generation] = await owner`insert into data_generations
          (dataset_id, workspace_id, schema_version, refresh_key,
           source_started_at, sequence, row_count)
        values (${dataset!.id}, ${workspaceId}, ${next!.version},
          'year-of-sales', ${now}, ${next!.sequence}, 219000)
        returning id`;
      await owner`insert into data_records
          (generation_id, workspace_id, record_key, collected_at, values)
        select ${generation!.id}, ${workspaceId},
          app || ':' || d::date || ':' || t, ${now}::timestamptz,
          jsonb_build_object(
            'app_id', app, 'day', d::date::text, 'row_id', t::text,
            'sku', 'SKU', 'product_type', '1F', 'units', '3',
            'developer_proceeds_per_unit',
              case when app = 'a' and d::date = '2026-11-04' then '0.70'
                   else '0' end,
            'currency', 'USD', 'country', 'C' || t, 'device', 'iPhone',
            'provider_fields', '{}'::jsonb)
        from unnest(array['a','b','c','d']) as app,
          generate_series('2025-11-05'::date, '2026-11-04'::date,
            interval '1 day') as d,
          generate_series(1, 150) as t`;
      const started = performance.now();
      const read = await createStoreProductService({
        db,
        now: () => new Date(now),
      }).read(actor(), requestId);
      const elapsed = performance.now() - started;
      console.log(
        `identity read over 219,000 sales rows: ${Math.round(elapsed)} ms`,
      );
      expect(
        read.products.find((product) => product.productId === group),
      ).toMatchObject({ hadProceeds: true });
      // The other three apps are in the reports only: listed, no proceeds.
      for (const app of ["b", "c", "d"])
        expect(
          read.products.find(
            (product) => product.productId === apple.id + ":" + app,
          ),
        ).toMatchObject({ hadProceeds: false });
      expect(elapsed).toBeLessThan(10_000);
    },
  );

  it("lists a product id too long for settings as not editable and refuses it", async () => {
    // Valid in the mapping table, but past what a settings key can hold:
    // incompressible, ~4,400 characters.
    const long = Array.from({ length: 4400 }, (_, index) =>
      String.fromCharCode(0x4e00 + ((index * 7919) % 20000)),
    ).join("");
    await editProducts(
      (rows) => [
        ...rows,
        { app_key: google.id + ":com.example.beta", product_id: long },
      ],
      mappingDatasetId,
    );
    const read = await products().read(actor(), requestId);
    expect(
      read.products.find((product) => product.productId === long),
    ).toMatchObject({ notEditable: "store_product_id_too_long" });
    expect(
      read.products.find((product) => product.productId === gamma),
    ).toMatchObject({ notEditable: null });
    await expect(
      products().update(actor(), requestId, {
        products: [{ productId: long, pricing: "paid", website: null }],
      }),
    ).rejects.toMatchObject({ code: "store_product_id_too_long", status: 400 });
  });
});
