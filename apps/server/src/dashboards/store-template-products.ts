import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  storeTemplateResultSchema,
  type StoreProductPricing,
  type StoreTemplateProducts,
  type StoreTemplateProductsRequest,
} from "@netrics/contracts";
import {
  connectionHasResource,
  insertAuditEvent,
  listResourceIcons,
  resolveDataPolicy,
  resourceNameKey,
  schema,
  withWorkspace,
  type Database,
  type ImageRow,
  type Transaction,
} from "@netrics/database";
import {
  DEFAULT_DATA_POLICY,
  exceedsDataPolicy,
  type DataPolicy,
} from "@netrics/domain";
import { createDataLoader, DataServiceError } from "../data/service.js";
import { presentImage } from "../images/service.js";
import { deriveInstallCompletion } from "./store-template-legacy.js";
import { STORE_SOURCE_DATASETS } from "./store-template-service.js";
import type { StoreConnectorId } from "./store-portfolio.js";

/**
 * Product identity of a store-template install (#708): per product its
 * icon, paid or free, and linked website, for the App Portfolio template's
 * app slides (#709).
 *
 * Where it lives: the products are those of the install's products and
 * mapping tables (manual datasets the customer edits), plus every app no
 * product claims (its product id is its app key, as in the preparations).
 * The owner's settings are rows of `data_template_products`, keyed by that
 * product id; a product without a row has the defaults (auto, no website),
 * so installs made before it need nothing. The settings are not fields of
 * the products table: an app without a product has no row there, the table
 * is edited freely in Data & measures (a website link there could not be
 * checked against the workspace), and adding fields would change the
 * schema of every install's table.
 *
 * Derived on read, never stored: the icon (the stored resource icon, which
 * the daily icon refresh replaces in place) and auto paid or free (proceeds
 * in the last 90 days in the synced source rows), so both follow the data
 * without a job of their own.
 */

/** The window auto paid or free looks at. */
export const PROCEEDS_WINDOW_DAYS = 90;

type Actor = { workspaceId: string; callerId: string };
type ProductApp = StoreTemplateProducts["products"][number]["apps"][number];

function reject(code: string, status: 400 | 404 | 409 | 413 = 400): never {
  throw new DataServiceError(code, status);
}

/** The sign of a decimal value (string or number); 0 for anything else. */
function decimalSign(value: unknown): -1 | 0 | 1 {
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : "";
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match || /^0*$/.test(match[2]! + (match[3] ?? ""))) return 0;
  return match[1] ? -1 : 1;
}

/**
 * Sources whose data is gone or not there yet read as no rows: the identity
 * then shows no proceeds and no report-only apps for them, as the
 * dashboards show no data. Row-limit and other failures still fail.
 */
const NO_DATA = new Set([
  "data_source_expired",
  "data_source_history_unavailable",
  "data_source_not_found",
]);

/**
 * What the install's tables and synced reports say, read through the data
 * reader (createDataLoader) that dashboards and queries use, so the same
 * guarantees hold: the resolved policy's row budget (413
 * data_source_row_limit), its retention ceiling on collected records, and
 * stored expiry of generations and records.
 *
 * - `products`, `mapping`: the rows of the install's Products and mapping
 *   tables.
 * - `dataApps`: the apps the synced source rows name (STORE_SOURCE_DATASETS).
 * - `proceeds`: app keys with proceeds since `since` (YYYY-MM-DD): App Store
 *   sales rows whose units and developer proceeds per unit are both
 *   positive or both negative (a positive product), Play earnings rows with
 *   a positive amount (charges; fees and refunds are negative).
 */
export async function readInstallData(
  tx: Transaction,
  workspaceId: string,
  input: {
    productDatasetId: string;
    mappingDatasetId: string;
    connectionIds: string[];
    since: string;
    now: Date;
    policy: DataPolicy;
  },
) {
  const loader = createDataLoader(tx, workspaceId, input.now, {
    policy: input.policy,
    allowPendingResults: true,
  });
  const rows = async (datasetId: string) => {
    try {
      return (await loader.load(datasetId)).rows;
    } catch (error) {
      if (error instanceof DataServiceError && NO_DATA.has(error.code))
        return [];
      throw error;
    }
  };
  const products = await rows(input.productDatasetId);
  const mapping = await rows(input.mappingDatasetId);
  const keys = [...new Set(Object.values(STORE_SOURCE_DATASETS).flat())];
  const sources = input.connectionIds.length
    ? await tx
        .select({
          id: schema.dataDatasets.id,
          connectionId: schema.dataDatasets.connectionId,
          key: schema.dataDatasets.key,
        })
        .from(schema.dataDatasets)
        .where(
          and(
            eq(schema.dataDatasets.workspaceId, workspaceId),
            eq(schema.dataDatasets.kind, "source"),
            inArray(schema.dataDatasets.connectionId, input.connectionIds),
            inArray(schema.dataDatasets.key, keys),
          ),
        )
        .orderBy(
          asc(schema.dataDatasets.connectionId),
          asc(schema.dataDatasets.key),
        )
    : [];
  const dataApps = new Map<string, { connectionId: string; appId: string }>(),
    proceeds = new Set<string>();
  for (const source of sources) {
    const connectionId = source.connectionId!;
    for (const row of await rows(source.id)) {
      const appId = row.app_id;
      if (typeof appId !== "string" || !appId) continue;
      const key = connectionId + ":" + appId;
      if (!dataApps.has(key)) dataApps.set(key, { connectionId, appId });
      if (
        source.key === "sales_rows" &&
        typeof row.day === "string" &&
        row.day >= input.since &&
        decimalSign(row.units) * decimalSign(row.developer_proceeds_per_unit) >
          0
      )
        proceeds.add(key);
      if (
        source.key === "earning_rows" &&
        typeof row.transaction_day === "string" &&
        row.transaction_day >= input.since &&
        decimalSign(row.merchant_amount) > 0
      )
        proceeds.add(key);
    }
  }
  return { products, mapping, dataApps: [...dataApps.values()], proceeds };
}

/** An app of an install's connections, as the products resolve it. */
type CatalogApp = ProductApp;

/**
 * The products of an install, resolved exactly as the template's
 * preparations resolve every row (buildStorePreparation): an app's product
 * is its mapping row's product_id, else its own app key; the product's name
 * is its Products row's product_name, else its first app's resource name,
 * else that app's id. The apps are the connections' catalog plus every app
 * the mapping names (its name then is its id, as in the data without a
 * resource name). A product without apps is not listed: no data row has
 * it. Products keep the Products table's order, then their first app's.
 * store-template-products-parity.test.ts runs both on the same tables.
 */
export function resolveStoreProducts(input: {
  products: Record<string, unknown>[];
  mapping: Record<string, unknown>[];
  /** The install's connections and their connectors. */
  connectors: Map<string, StoreConnectorId>;
  /** The connections' apps (complete catalog). */
  apps: CatalogApp[];
  /**
   * The apps of the synced source rows: Play names packages in earnings
   * reports that discovery never listed, and the preparations build a
   * product for each (named by its id, as no resource name exists).
   */
  dataApps?: { connectionId: string; appId: string }[];
}): { productId: string; name: string; apps: ProductApp[] }[] {
  const names = new Map<string, string>();
  for (const row of input.products) {
    const id = row.product_id,
      name = row.product_name;
    if (typeof id === "string" && id && !names.has(id))
      names.set(id, typeof name === "string" && name ? name : id);
  }
  const mapped = new Map<string, string>();
  for (const row of input.mapping) {
    const key = row.app_key,
      product = row.product_id;
    if (typeof key === "string" && typeof product === "string" && product)
      if (!mapped.has(key)) mapped.set(key, product);
  }
  const apps = new Map<string, ProductApp>();
  for (const app of input.apps)
    if (input.connectors.has(app.connectionId) && app.appId !== "__unmapped")
      if (!apps.has(app.connectionId + ":" + app.appId))
        apps.set(app.connectionId + ":" + app.appId, app);
  for (const app of input.dataApps ?? []) {
    const key = app.connectionId + ":" + app.appId,
      connectorId = input.connectors.get(app.connectionId);
    if (!connectorId || !app.appId || app.appId === "__unmapped") continue;
    if (!apps.has(key))
      apps.set(key, {
        connectionId: app.connectionId,
        appId: app.appId,
        name: app.appId,
        connectorId,
      });
  }
  for (const key of mapped.keys()) {
    const cut = key.indexOf(":"),
      connectionId = key.slice(0, cut),
      appId = key.slice(cut + 1),
      connectorId = input.connectors.get(connectionId);
    if (cut < 0 || !connectorId || !appId || appId === "__unmapped") continue;
    if (!apps.has(key))
      apps.set(key, { connectionId, appId, name: appId, connectorId });
  }
  const grouped = new Map<string, ProductApp[]>();
  for (const [key, app] of apps) {
    const productId = mapped.get(key) ?? key;
    grouped.set(productId, [...(grouped.get(productId) ?? []), app]);
  }
  const order = [
    ...[...names.keys()].filter((id) => grouped.has(id)),
    ...[...grouped.keys()].filter((id) => !names.has(id)),
  ];
  return order.map((productId) => {
    const productApps = grouped.get(productId)!;
    return {
      productId,
      name: names.get(productId) ?? productApps[0]!.name,
      apps: productApps,
    };
  });
}

/**
 * Every discovered resource of the connections (only the selected ones
 * when a connection syncs a selection), not the 500 that
 * listNamedResources returns: an app left out would vanish from the
 * products and its settings be refused. Bounded by the workspace's query
 * row limit, which answers 413 data_source_row_limit instead of a cut list.
 */
async function resourceCatalog(
  tx: Transaction,
  workspaceId: string,
  connectionIds: string[],
  queryRows: number | null,
): Promise<{ connectionId: string; resourceId: string; name: string }[]> {
  if (!connectionIds.length) return [];
  const rows = await tx.execute(sql`
    select distinct on (r.connection_id, r.resource_id)
      r.connection_id, r.resource_id, r.name
    from connection_resources r
    join connections c
      on c.workspace_id = ${workspaceId} and c.id = r.connection_id
    where r.workspace_id = ${workspaceId}
      and r.connection_id in (${sql.join(
        connectionIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      and not exists (
        select 1 from metric_definitions m
        where m.connector_id = c.connector_id
          and r.kind <> 'resource' and m.dimensions ? r.kind
      )
      and (
        jsonb_typeof(c.config -> 'resourceSelection') is distinct from 'array'
        or jsonb_array_length(c.config -> 'resourceSelection') = 0
        or c.config -> 'resourceSelection' ? r.resource_id
      )
    order by r.connection_id, r.resource_id, r.name
    ${queryRows === null ? sql`` : sql`limit ${queryRows + 1}`}`);
  if (exceedsDataPolicy(rows.length, queryRows))
    reject("data_source_row_limit", 413);
  return rows
    .map((row) => ({
      connectionId: row.connection_id as string,
      resourceId: row.resource_id as string,
      name: row.name as string,
    }))
    .sort(
      (a, b) =>
        a.connectionId.localeCompare(b.connectionId) ||
        a.name.localeCompare(b.name) ||
        a.resourceId.localeCompare(b.resourceId),
    );
}

/** The install's product identities (see the module comment). */
export async function readStoreProducts(
  tx: Transaction,
  workspaceId: string,
  requestId: string,
  now: Date,
  /** The deployment's data policy (NETRICS_DATA_POLICY). */
  defaults: DataPolicy = DEFAULT_DATA_POLICY,
): Promise<StoreTemplateProducts> {
  const [install] = await tx
    .select({ result: schema.dataTemplateInstalls.result })
    .from(schema.dataTemplateInstalls)
    .where(
      and(
        eq(schema.dataTemplateInstalls.workspaceId, workspaceId),
        eq(schema.dataTemplateInstalls.requestId, requestId),
      ),
    );
  if (!install) reject("store_template_not_found", 404);
  const completion = await deriveInstallCompletion(tx, workspaceId, requestId);
  if (!completion.ok) reject("store_template_baseline_unavailable", 409);
  const result = storeTemplateResultSchema.parse(install.result);
  const connections = new Map(
    completion.inputs.connections.map((connection) => [
      connection.id,
      connection.connectorId,
    ]),
  );
  const connectionIds = [...connections.keys()];
  const policy = (await resolveDataPolicy(tx, workspaceId, defaults)).policy;
  const resources = await resourceCatalog(
    tx,
    workspaceId,
    connectionIds,
    policy.queryRows,
  );
  const icons = await listResourceIcons(tx, workspaceId);
  const settings = await tx
    .select()
    .from(schema.dataTemplateProducts)
    .where(
      and(
        eq(schema.dataTemplateProducts.workspaceId, workspaceId),
        eq(schema.dataTemplateProducts.requestId, requestId),
      ),
    );
  const {
    products: productRows,
    mapping: mappingRows,
    dataApps,
    proceeds,
  } = await readInstallData(tx, workspaceId, {
    productDatasetId: result.productDatasetId,
    mappingDatasetId: result.mappingDatasetId,
    connectionIds,
    since: new Date(now.getTime() - PROCEEDS_WINDOW_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10),
    now,
    policy,
  });
  const products = resolveStoreProducts({
    products: productRows,
    mapping: mappingRows,
    connectors: connections,
    apps: resources.map((resource) => ({
      connectionId: resource.connectionId,
      appId: resource.resourceId,
      name: resource.name,
      connectorId: connections.get(resource.connectionId)!,
    })),
    dataApps,
  });
  const discovered = new Set(
    resources.map(
      (resource) => resource.connectionId + ":" + resource.resourceId,
    ),
  );
  const iconOf = new Map<string, ImageRow>();
  for (const icon of icons) {
    const key = resourceNameKey(icon.connectionId!, icon.resourceId!);
    if (!iconOf.has(key)) iconOf.set(key, icon);
  }
  const settingOf = new Map(settings.map((row) => [row.productId, row]));
  const websites = await websiteChoices(tx, workspaceId, policy.queryRows);
  const projectName = new Map(
    websites.flatMap((website) =>
      website.projects.map((project) => [
        resourceNameKey(website.connectionId, project.id),
        project.name,
      ]),
    ),
  );
  return {
    requestId,
    products: products.map((product) => {
      const productId = product.productId;
      // App Store first: its icon is the app's own artwork (ADR 0015).
      const ordered = [
        ...product.apps.filter(
          (app) => app.connectorId === "app-store-connect",
        ),
        ...product.apps.filter((app) => app.connectorId === "google-play"),
      ];
      const iconApp = ordered.find((app) =>
        iconOf.has(resourceNameKey(app.connectionId, app.appId)),
      );
      // The icon service fetches icons of discovered resources only; an
      // app only the reports or the mapping name offers none.
      const iconSource = ordered.find((app) =>
        discovered.has(app.connectionId + ":" + app.appId),
      );
      const setting = settingOf.get(productId);
      const pricing = (setting?.pricing ?? "auto") as StoreProductPricing;
      const hadProceeds = product.apps.some((app) =>
        proceeds.has(app.connectionId + ":" + app.appId),
      );
      return {
        productId,
        name: product.name,
        apps: product.apps,
        icon: iconApp
          ? presentImage(
              iconOf.get(resourceNameKey(iconApp.connectionId, iconApp.appId))!,
            )
          : null,
        iconSource: iconSource
          ? {
              connectionId: iconSource.connectionId,
              resourceId: iconSource.appId,
            }
          : null,
        pricing,
        hadProceeds,
        paid: pricing === "auto" ? hadProceeds : pricing === "paid",
        website:
          setting?.websiteConnectionId && setting.websiteResourceId
            ? {
                connectionId: setting.websiteConnectionId,
                projectId: setting.websiteResourceId,
                name:
                  projectName.get(
                    resourceNameKey(
                      setting.websiteConnectionId,
                      setting.websiteResourceId,
                    ),
                  ) ?? null,
              }
            : null,
      };
    }),
    websites,
  };
}

/** The workspace's Vercel connections and all their (selected) projects. */
async function websiteChoices(
  tx: Transaction,
  workspaceId: string,
  queryRows: number | null,
) {
  const vercel = await tx
    .select({ id: schema.connections.id, name: schema.connections.name })
    .from(schema.connections)
    .where(
      and(
        eq(schema.connections.workspaceId, workspaceId),
        eq(schema.connections.connectorId, "vercel"),
      ),
    )
    .orderBy(asc(schema.connections.name), asc(schema.connections.id));
  const projects = await resourceCatalog(
    tx,
    workspaceId,
    vercel.map((connection) => connection.id),
    queryRows,
  );
  return vercel.map((connection) => ({
    connectionId: connection.id,
    name: connection.name,
    projects: [
      ...new Map(
        projects
          .filter((project) => project.connectionId === connection.id)
          .map((project) => [
            project.resourceId,
            { id: project.resourceId, name: project.name },
          ]),
      ).values(),
    ],
  }));
}

export function createStoreProductService(deps: {
  db: Database;
  now?: () => Date;
  /** The deployment's data policy (NETRICS_DATA_POLICY). */
  policy?: DataPolicy;
}) {
  const now = deps.now ?? (() => new Date()),
    policy = deps.policy ?? DEFAULT_DATA_POLICY;
  return {
    read(actor: Actor, requestId: string): Promise<StoreTemplateProducts> {
      return withWorkspace(
        deps.db,
        { workspaceId: actor.workspaceId, userId: actor.callerId },
        (tx) =>
          readStoreProducts(tx, actor.workspaceId, requestId, now(), policy),
      );
    },
    /**
     * Sets the listed products' pricing and website. A product back at the
     * defaults loses its row. The website's connection must be a Vercel
     * connection of the actor's workspace that knows the project; the
     * composite foreign key holds the workspace binding in the database too.
     */
    update(
      actor: Actor,
      requestId: string,
      input: StoreTemplateProductsRequest,
    ): Promise<StoreTemplateProducts> {
      return withWorkspace(
        deps.db,
        { workspaceId: actor.workspaceId, userId: actor.callerId },
        async (tx) => {
          const at = now();
          const current = await readStoreProducts(
            tx,
            actor.workspaceId,
            requestId,
            at,
            policy,
          );
          const known = new Set(
            current.products.map((product) => product.productId),
          );
          const seen = new Set<string>();
          for (const product of input.products) {
            if (!known.has(product.productId) || seen.has(product.productId))
              reject("store_product_unknown");
            seen.add(product.productId);
          }
          const websiteIds = [
            ...new Set(
              input.products.flatMap((product) =>
                product.website ? [product.website.connectionId] : [],
              ),
            ),
          ];
          const vercel = websiteIds.length
            ? await tx
                .select({ id: schema.connections.id })
                .from(schema.connections)
                .where(
                  and(
                    eq(schema.connections.workspaceId, actor.workspaceId),
                    eq(schema.connections.connectorId, "vercel"),
                    inArray(schema.connections.id, websiteIds),
                  ),
                )
            : [];
          if (vercel.length !== websiteIds.length)
            reject("store_website_invalid");
          for (const product of input.products)
            if (
              product.website &&
              !(await connectionHasResource(
                tx,
                actor.workspaceId,
                product.website.connectionId,
                product.website.projectId,
              ))
            )
              reject("store_website_invalid");
          const defaults = input.products.filter(
            (product) => product.pricing === "auto" && !product.website,
          );
          if (defaults.length)
            await tx.delete(schema.dataTemplateProducts).where(
              and(
                eq(schema.dataTemplateProducts.workspaceId, actor.workspaceId),
                eq(schema.dataTemplateProducts.requestId, requestId),
                inArray(
                  schema.dataTemplateProducts.productId,
                  defaults.map((product) => product.productId),
                ),
              ),
            );
          const rows = input.products
            .filter((product) => product.pricing !== "auto" || product.website)
            .map((product) => ({
              workspaceId: actor.workspaceId,
              requestId,
              productId: product.productId,
              pricing: product.pricing,
              websiteConnectionId: product.website?.connectionId ?? null,
              websiteResourceId: product.website?.projectId ?? null,
              updatedAt: at,
            }));
          if (rows.length)
            await tx
              .insert(schema.dataTemplateProducts)
              .values(rows)
              .onConflictDoUpdate({
                target: [
                  schema.dataTemplateProducts.workspaceId,
                  schema.dataTemplateProducts.requestId,
                  schema.dataTemplateProducts.productId,
                ],
                set: {
                  pricing: sql`excluded.pricing`,
                  websiteConnectionId: sql`excluded.website_connection_id`,
                  websiteResourceId: sql`excluded.website_resource_id`,
                  updatedAt: sql`excluded.updated_at`,
                },
              });
          await insertAuditEvent(tx, {
            workspaceId: actor.workspaceId,
            actorUserId: actor.callerId,
            action: "data.store_products_changed",
            target: requestId,
            metadata: { products: input.products.length },
          });
          return readStoreProducts(
            tx,
            actor.workspaceId,
            requestId,
            at,
            policy,
          );
        },
      );
    },
  };
}
