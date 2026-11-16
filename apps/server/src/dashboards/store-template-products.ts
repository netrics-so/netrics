import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import {
  storeTemplateResultSchema,
  type StoreProductPricing,
  type StoreTemplateProducts,
  type StoreTemplateProductsRequest,
} from "@netrics/contracts";
import {
  connectionHasResource,
  insertAuditEvent,
  listNamedResources,
  listResourceIcons,
  resourceNameKey,
  schema,
  withWorkspace,
  type Database,
  type ImageRow,
  type Transaction,
} from "@netrics/database";
import { DataServiceError } from "../data/service.js";
import { presentImage } from "../images/service.js";
import { deriveInstallCompletion } from "./store-template-legacy.js";
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

function reject(code: string, status: 400 | 404 | 409 = 400): never {
  throw new DataServiceError(code, status);
}

/** The values of a dataset's latest generation (manual tables). */
async function latestRecords(
  tx: Transaction,
  workspaceId: string,
  datasetId: string,
  now: Date,
): Promise<Record<string, unknown>[]> {
  const [generation] = await tx
    .select({ id: schema.dataGenerations.id })
    .from(schema.dataGenerations)
    .where(
      and(
        eq(schema.dataGenerations.workspaceId, workspaceId),
        eq(schema.dataGenerations.datasetId, datasetId),
        or(
          isNull(schema.dataGenerations.expiresAt),
          gt(schema.dataGenerations.expiresAt, now),
        ),
      ),
    )
    .orderBy(desc(schema.dataGenerations.sequence))
    .limit(1);
  if (!generation) return [];
  const rows = await tx
    .select({ values: schema.dataRecords.values })
    .from(schema.dataRecords)
    .where(
      and(
        eq(schema.dataRecords.workspaceId, workspaceId),
        eq(schema.dataRecords.generationId, generation.id),
        or(
          isNull(schema.dataRecords.expiresAt),
          gt(schema.dataRecords.expiresAt, now),
        ),
      ),
    )
    .orderBy(asc(schema.dataRecords.recordKey));
  return rows.map((row) => row.values as Record<string, unknown>);
}

/** A decimal text as numeric; null (not an error) for anything else. */
const decimal = (text: ReturnType<typeof sql>) =>
  sql`(case when ${text} ~ '^-?[0-9]+([.][0-9]+)?$' then (${text})::numeric end)`;

/**
 * App keys (`<connectionId>:<appId>`) of the connections' apps with
 * proceeds since `since` (a day, YYYY-MM-DD): App Store sales rows whose
 * units × developer proceeds per unit is positive, Google Play earnings
 * rows with a positive amount (charges; fees and refunds are negative).
 * Read from each source dataset's latest generation, which holds every
 * current row.
 */
export async function appsWithProceeds(
  tx: Transaction,
  workspaceId: string,
  connectionIds: string[],
  since: string,
  now: Date,
): Promise<Set<string>> {
  if (!connectionIds.length) return new Set();
  const at = now.toISOString();
  const rows = await tx.execute(sql`
    select distinct d.connection_id, r."values"->>'app_id' as app_id
    from data_datasets d
    join lateral (
      select g.id from data_generations g
      where g.workspace_id = ${workspaceId} and g.dataset_id = d.id
        and (g.expires_at is null or g.expires_at > ${at}::timestamptz)
      order by g.sequence desc limit 1
    ) g on true
    join data_records r
      on r.workspace_id = ${workspaceId} and r.generation_id = g.id
     and (r.expires_at is null or r.expires_at > ${at}::timestamptz)
    where d.workspace_id = ${workspaceId} and d.kind = 'source'
      and d.connection_id in (${sql.join(
        connectionIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      and (
        (d.key = 'sales_rows'
          and r."values"->>'day' >= ${since}
          and ${decimal(sql`r."values"->>'units'`)}
            * ${decimal(sql`r."values"->>'developer_proceeds_per_unit'`)} > 0)
        or (d.key = 'earning_rows'
          and r."values"->>'transaction_day' >= ${since}
          and ${decimal(sql`r."values"->>'merchant_amount'`)} > 0)
      )`);
  return new Set(
    rows.map((row) => `${row.connection_id as string}:${row.app_id as string}`),
  );
}

/** The install's product identities (see the module comment). */
export async function readStoreProducts(
  tx: Transaction,
  workspaceId: string,
  requestId: string,
  now: Date,
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
  // One after another: the queries share the transaction's connection.
  const productRows = await latestRecords(
    tx,
    workspaceId,
    result.productDatasetId,
    now,
  );
  const mappingRows = await latestRecords(
    tx,
    workspaceId,
    result.mappingDatasetId,
    now,
  );
  const resources = await listNamedResources(tx, workspaceId, connectionIds);
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
  const proceeds = await appsWithProceeds(
    tx,
    workspaceId,
    connectionIds,
    new Date(now.getTime() - PROCEEDS_WINDOW_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10),
    now,
  );
  const appNames = new Map(
    resources.map((resource) => [
      resource.connectionId + ":" + resource.resourceId,
      resource.name,
    ]),
  );
  const appOf = (key: string): ProductApp | null => {
    const cut = key.indexOf(":"),
      connectionId = key.slice(0, cut),
      appId = key.slice(cut + 1),
      connectorId = connections.get(connectionId);
    if (cut < 0 || !connectorId || appId === "__unmapped") return null;
    return {
      connectionId,
      appId,
      name: appNames.get(key) ?? appId,
      connectorId: connectorId as StoreConnectorId,
    };
  };
  // Products in table order; their apps from the mapping table.
  const products = new Map<string, { name: string; apps: ProductApp[] }>();
  for (const row of productRows) {
    const id = String(row.product_id ?? "");
    if (!id || id.endsWith(":__unmapped")) continue;
    products.set(id, { name: String(row.product_name ?? id), apps: [] });
  }
  const claimed = new Set<string>();
  for (const row of mappingRows) {
    const key = String(row.app_key ?? ""),
      product = products.get(String(row.product_id ?? ""));
    const app = appOf(key);
    if (!product || !app) continue;
    claimed.add(key);
    product.apps.push(app);
  }
  for (const resource of resources) {
    const key = resource.connectionId + ":" + resource.resourceId;
    if (claimed.has(key) || products.has(key)) continue;
    const app = appOf(key);
    if (app) products.set(key, { name: app.name, apps: [app] });
  }
  const iconOf = new Map<string, ImageRow>();
  for (const icon of icons) {
    const key = resourceNameKey(icon.connectionId!, icon.resourceId!);
    if (!iconOf.has(key)) iconOf.set(key, icon);
  }
  const settingOf = new Map(settings.map((row) => [row.productId, row]));
  const websites = await websiteChoices(tx, workspaceId);
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
    products: [...products].map(([productId, product]) => {
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
        iconSource: ordered[0]
          ? {
              connectionId: ordered[0].connectionId,
              resourceId: ordered[0].appId,
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

/** The workspace's Vercel connections and their (selected) projects. */
async function websiteChoices(tx: Transaction, workspaceId: string) {
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
  const projects = await listNamedResources(
    tx,
    workspaceId,
    vercel.map((connection) => connection.id),
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
}) {
  const now = deps.now ?? (() => new Date());
  return {
    read(actor: Actor, requestId: string): Promise<StoreTemplateProducts> {
      return withWorkspace(
        deps.db,
        { workspaceId: actor.workspaceId, userId: actor.callerId },
        (tx) => readStoreProducts(tx, actor.workspaceId, requestId, now()),
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
          return readStoreProducts(tx, actor.workspaceId, requestId, at);
        },
      );
    },
  };
}
