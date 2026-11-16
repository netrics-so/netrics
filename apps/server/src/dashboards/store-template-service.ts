import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { ConnectorRegistry } from "@netrics/connector-runtime";
import {
  createDashboardRequestSchema,
  sourceDatasetSchema,
  storeTemplateResultSchema,
  type StoreTemplateRequest,
  type StoreTemplateResult,
  type StoreTemplateOptions,
} from "@netrics/contracts";
import {
  withWorkspace,
  schema,
  registerSourceDataset,
  resolveDataPolicy,
  insertAuditEvent,
  retryOnSerializationFailure,
  DatasetStoreError,
  hasSqlstate,
  type Database,
  type TableLocks,
  type Transaction,
} from "@netrics/database";
import {
  DEFAULT_DATA_POLICY,
  exceedsDataPolicy,
  type DataPolicy,
  type Locale,
} from "@netrics/domain";
import {
  createDataService,
  DataServiceError,
  datasetStoreStatus,
  isDataConflict,
  isRetryableDataConflict,
} from "../data/service.js";
import { createDashboardService } from "./service.js";
import {
  storeAppSlides,
  storeTemplateCopy,
  type StoreTemplateSource,
  type StoreMetric,
  type StoreConnectorId,
} from "./store-portfolio.js";
import {
  installIconSources,
  readStoreProducts,
  storeAppIdentities,
  type StoreIconSource,
} from "./store-template-products.js";
import {
  storeTemplate,
  type StoreTemplateDefinition,
  type StoreTemplateIds,
  type StoreTemplateInputs,
  type StoreTemplateRecord,
  STORE_TEMPLATE_ID,
  storeTemplateInputsSchema,
  storePortfolio,
} from "./store-template.js";

/**
 * Fetches the icons of apps that have none through the validated
 * resource-icon path (images/resource-icons.ts), so app slides get their
 * logo without "Use app icon" (#709). Best effort: what cannot be fetched
 * stays without an icon, and the slide without a logo.
 */
export type StoreIconFetcher = (
  actor: { workspaceId: string; callerId: string },
  sources: StoreIconSource[],
) => Promise<void>;

/**
 * The apps of an install as version 4 builds their slides, read in tx
 * from its tables and the connections' identity; none for a dashboard of
 * one app (`fixedProduct`), which has no app slides. The data policy's
 * statement timeout the read sets is restored after it.
 */
export async function readStoreApps(
  tx: Transaction,
  workspaceId: string,
  requestId: string,
  input: {
    result: { productDatasetId: string; mappingDatasetId: string };
    connections: { id: string; connectorId: StoreConnectorId }[];
    fixedProduct: string | null;
    /** The Products and mapping rows, when the caller just wrote them. */
    tables?: {
      products: Record<string, unknown>[];
      mapping: Record<string, unknown>[];
    };
  },
  now: Date,
  policy: DataPolicy,
) {
  if (input.fixedProduct !== null) return [];
  const [timeout] = await tx.execute(
    sql`select current_setting('statement_timeout') as value`,
  );
  const products = await readStoreProducts(
    tx,
    workspaceId,
    requestId,
    now,
    policy,
    {
      result: input.result,
      connections: input.connections,
      ...(input.tables ? { tables: input.tables } : {}),
    },
  );
  await tx.execute(
    sql`select set_config('statement_timeout', ${String(timeout!.value)}, true)`,
  );
  return storeAppIdentities(products.products);
}

/**
 * Installs run one at a time, across workspaces (#604). An install is one
 * serializable transaction of ~25 tables that reads before it writes
 * (dataset keys, schema versions, generations, refreshes, install ids).
 * Until those tables are large, every workspace's rows share their heap
 * relation (the planner picks sequential scans, which lock the whole
 * relation) or a single index leaf page, so any two concurrent installs read
 * what the other writes and SSI cancels all but one of them. Measured: of 4
 * (8) concurrent installs in different workspaces, exactly one committed
 * per round, so the last needed 4 (8) full attempts and the jittered retries
 * could run out of budget under load (409 version_conflict).
 *
 * The lock is taken before the snapshot: a lock taken after it (an advisory
 * lock in a SELECT) still leaves the waiter's snapshot older than the
 * holder's commit, and SSI cancels it anyway. SHARE UPDATE EXCLUSIVE
 * conflicts with itself (and VACUUM/ANALYZE of the table), not with reads or
 * writes: update operations (apply, close, swap, legacy completion) and
 * cascading deletes never wait for a running install, so an install cannot
 * stall another tenant's update or deadlock with one through the locks those
 * hold (the install's advisory lock, the workspace ingestion lock 440). The
 * lock replaces the per-request advisory lock, which installs no longer need.
 *
 * An install waits for the lock once, in the lock's FIFO queue (#660). An
 * install was ~1,100 statements, each a round trip: ~0.7 s on CI, 3-7.5 s
 * against a local Docker Postgres, 6-13 s there while other suites run.
 * Since #668 it is ~320 (one batch data service whose loaders share their
 * source loads; store-template-install-queries.test.ts keeps it there).
 * The wait used to be 2 s, retried twice:
 * every waiter behind an install longer than 2 s gave up together, queued
 * again at the back, and the third and later installs answered 409
 * version_conflict after ~6 s (never a serialization failure between
 * installs). One wait of INSTALL_LOCK_TIMEOUT_MS keeps the waiter's place
 * and covers a queue of a few slow installs; past it the install fails
 * with 55P03 and answers 409 version_conflict. A waiting install holds a
 * pooled connection for the wait.
 *
 * The lock stays global, not per workspace or template (#668): the
 * conflicts it prevents are between installs in different workspaces, whose
 * reads of small shared relations SSI cannot tell apart (see above). A
 * narrower lock would let them run together and cancel each other again.
 */
export const INSTALL_LOCK_TIMEOUT_MS = 60_000;
export const INSTALL_LOCK = {
  tables: [schema.dataTemplateInstalls],
  mode: "share update exclusive",
  timeoutMs: INSTALL_LOCK_TIMEOUT_MS,
} satisfies TableLocks;
/** lock_not_available: the install lock was not granted in time. */
const isLockTimeout = (error: unknown) => hasSqlstate(error, "55P03");

type Actor = { workspaceId: string; callerId: string; locale: Locale };
const appKey = (app: { connectionId: string; appId: string }) =>
  app.connectionId + ":" + app.appId;
function reject(
  code: string,
  status: 400 | 404 | 409 | 413 | 503 = 400,
): never {
  throw new DataServiceError(code, status);
}
function normalize(input: StoreTemplateRequest) {
  const connections = [...new Set(input.connections)].sort(),
    groups = input.groups
      .map((group) => ({
        ...group,
        apps: [...group.apps].sort((a, b) =>
          appKey(a).localeCompare(appKey(b)),
        ),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  const seen = new Set<string>(),
    groupIds = new Set<string>();
  for (const group of groups) {
    if (groupIds.has(group.id)) reject("store_mapping_duplicate");
    groupIds.add(group.id);
    for (const app of group.apps) {
      if (!connections.includes(app.connectionId) || seen.has(appKey(app)))
        reject("store_mapping_duplicate");
      seen.add(appKey(app));
    }
  }
  if (input.appScope && !connections.includes(input.appScope.connectionId))
    reject("store_scope_invalid");
  return { ...input, connections, groups };
}

/**
 * Widget id → widget template key of a dashboard the template just created:
 * its widgets in reading order (slide position, then y, x) are the
 * template's widgets in `widgetKeys` order; its slides in position order are
 * `slideKeys` (version 4), else `slide:<index>`.
 */
async function installedWidgetKeys(
  tx: Transaction,
  workspaceId: string,
  dashboardId: string,
  widgetKeys: string[],
  slideKeys?: string[],
): Promise<Record<string, string>> {
  const widgets = await tx
    .select({ id: schema.dashboardWidgets.id })
    .from(schema.dashboardWidgets)
    .innerJoin(
      schema.dashboardSlides,
      and(
        eq(schema.dashboardSlides.id, schema.dashboardWidgets.slideId),
        eq(schema.dashboardSlides.workspaceId, workspaceId),
      ),
    )
    .where(
      and(
        eq(schema.dashboardWidgets.workspaceId, workspaceId),
        eq(schema.dashboardWidgets.dashboardId, dashboardId),
      ),
    )
    .orderBy(
      asc(schema.dashboardSlides.position),
      asc(schema.dashboardWidgets.y),
      asc(schema.dashboardWidgets.x),
    );
  if (widgets.length !== widgetKeys.length)
    throw new Error("store template widgets differ from their keys");
  // Slides in position order are the template's slides: `slide:<index>`.
  const slides = await tx
    .select({ id: schema.dashboardSlides.id })
    .from(schema.dashboardSlides)
    .where(
      and(
        eq(schema.dashboardSlides.workspaceId, workspaceId),
        eq(schema.dashboardSlides.dashboardId, dashboardId),
      ),
    )
    .orderBy(asc(schema.dashboardSlides.position));
  return Object.fromEntries([
    ...slides.map((slide, index) => [
      slide.id,
      slideKeys?.[index] ?? `slide:${index}`,
    ]),
    ...widgets.map((widget, index) => [widget.id, widgetKeys[index]!]),
  ]);
}

/**
 * A connection's row in an install's products table: the name of its
 * account rows no app claims (`<connectionId>:__unmapped`).
 */
export function unmappedProductRow(
  source: { id: string; name: string },
  locale: Locale,
): { values: { product_id: string; product_name: string } } {
  return {
    values: {
      product_id: source.id + ":__unmapped",
      product_name:
        `${storeTemplateCopy(locale).unallocated} · ${source.name}`.slice(
          0,
          100,
        ),
    },
  };
}

/**
 * The source datasets the store template reads per connector. Google Play's
 * rating report rows and report availability are read since template
 * version 2 (Play Console rating reports).
 */
export const STORE_SOURCE_DATASETS: Record<StoreConnectorId, string[]> = {
  "app-store-connect": ["sales_rows", "store_ratings"],
  "google-play": [
    "install_rows",
    "earning_rows",
    "store_ratings",
    "rating_rows",
    "report_status",
  ],
};

/**
 * The dataset id of each of `keys` (default: every dataset the template reads
 * for the connector): registered now with `register`, otherwise the
 * registered id or a `pending:` placeholder.
 */
export async function storeSourceDatasets(
  tx: Transaction,
  deps: { registry: ConnectorRegistry; policy: DataPolicy },
  workspaceId: string,
  row: { id: string; connectorId: StoreConnectorId },
  options: { register: boolean },
  keys: string[] = STORE_SOURCE_DATASETS[row.connectorId],
): Promise<Record<string, string>> {
  const registered = deps.registry.get(row.connectorId);
  if (!registered) reject("connector_unavailable", 503);
  const datasets: Record<string, string> = {};
  for (const key of keys) {
    const definition = registered.manifest.datasets?.find(
      (dataset) => dataset.key === key,
    );
    if (!definition) reject("store_source_schema_unavailable", 503);
    if (options.register) {
      datasets[key] = (
        await registerSourceDataset(tx, {
          workspaceId,
          connectionId: row.id,
          definition,
          policyDefaults: deps.policy,
        })
      ).id;
      continue;
    }
    const [existing] = await tx
      .select({ id: schema.dataDatasets.id })
      .from(schema.dataDatasets)
      .where(
        and(
          eq(schema.dataDatasets.workspaceId, workspaceId),
          eq(schema.dataDatasets.connectionId, row.id),
          eq(schema.dataDatasets.kind, "source"),
          eq(schema.dataDatasets.key, definition.key),
        ),
      );
    datasets[key] = existing?.id ?? `pending:${row.id}:${key}`;
  }
  return datasets;
}

/**
 * The store sources of `connectionIds` (all of the workspace, set up, of a
 * store connector), each with the source datasets the template reads.
 * `register` registers those datasets; without it (a read-only plan) a
 * dataset not registered yet is `pending:<connectionId>:<key>`.
 */
export async function storeTemplateSources(
  tx: Transaction,
  deps: { registry: ConnectorRegistry; policy: DataPolicy },
  workspaceId: string,
  connectionIds: string[],
  options: { register: boolean },
): Promise<StoreTemplateSource[]> {
  if (!connectionIds.length) return [];
  const rows = await tx
    .select()
    .from(schema.connections)
    .where(
      and(
        eq(schema.connections.workspaceId, workspaceId),
        inArray(schema.connections.id, connectionIds),
      ),
    )
    .orderBy(asc(schema.connections.id));
  if (rows.length !== new Set(connectionIds).size)
    reject("connection_not_found", 404);
  const sources: StoreTemplateSource[] = [];
  for (const row of rows) {
    if (row.setupPending) reject("connection_setup_pending", 409);
    if (
      row.connectorId !== "app-store-connect" &&
      row.connectorId !== "google-play"
    )
      reject("store_connector_required");
    const datasets = await storeSourceDatasets(
      tx,
      deps,
      workspaceId,
      { id: row.id, connectorId: row.connectorId },
      options,
    );
    sources.push({
      id: row.id,
      name: row.name,
      connectorId: row.connectorId,
      datasets,
    });
  }
  return sources;
}

export function createStoreTemplateService(deps: {
  db: Database;
  registry: ConnectorRegistry;
  now?: () => Date;
  policy?: DataPolicy;
  /** The template definition installs build from; tests pass other versions. */
  template?: StoreTemplateDefinition;
  /** Template records per insert statement; tests pass small values. */
  recordChunk?: number;
  /** The wait for the install lock; tests pass small values. */
  installLockTimeoutMs?: number;
  /** Fetches missing app icons before an install (version 4). */
  fetchIcons?: StoreIconFetcher;
}) {
  const now = deps.now ?? (() => new Date()),
    defaults = deps.policy ?? DEFAULT_DATA_POLICY,
    template = deps.template ?? storeTemplate,
    recordChunk = deps.recordChunk ?? 1000,
    installLock: TableLocks = {
      ...INSTALL_LOCK,
      timeoutMs: deps.installLockTimeoutMs ?? INSTALL_LOCK.timeoutMs,
    };
  return {
    options(actor: Actor): Promise<StoreTemplateOptions> {
      return withWorkspace(
        deps.db,
        { workspaceId: actor.workspaceId, userId: actor.callerId },
        async (tx) => {
          const connections = await tx
            .select({
              id: schema.connections.id,
              name: schema.connections.name,
              connectorId: schema.connections.connectorId,
              setupPending: schema.connections.setupPending,
            })
            .from(schema.connections)
            .where(
              and(
                eq(schema.connections.workspaceId, actor.workspaceId),
                inArray(schema.connections.connectorId, [
                  "app-store-connect",
                  "google-play",
                ]),
              ),
            )
            .orderBy(asc(schema.connections.name), asc(schema.connections.id));
          const { policy } = await resolveDataPolicy(
            tx,
            actor.workspaceId,
            defaults,
          );
          const query = tx
            .select({
              connectionId: schema.connectionResources.connectionId,
              id: schema.connectionResources.resourceId,
              name: schema.connectionResources.name,
            })
            .from(schema.connectionResources)
            .where(
              and(
                eq(schema.connectionResources.workspaceId, actor.workspaceId),
                inArray(
                  schema.connectionResources.connectionId,
                  connections.map((connection) => connection.id),
                ),
              ),
            )
            .orderBy(
              asc(schema.connectionResources.name),
              asc(schema.connectionResources.resourceId),
            );
          const resources = connections.length
            ? await (policy.queryRows === null
                ? query
                : query.limit(policy.queryRows + 1))
            : [];
          if (exceedsDataPolicy(resources.length, policy.queryRows))
            reject("data_source_row_limit", 413);
          return {
            connections: connections
              .filter((connection) => deps.registry.get(connection.connectorId))
              .map((connection) => ({
                ...connection,
                connectorId: connection.connectorId as StoreConnectorId,
                apps: [
                  ...new Map(
                    resources
                      .filter(
                        (resource) => resource.connectionId === connection.id,
                      )
                      .map((resource) => [
                        resource.id,
                        { id: resource.id, name: resource.name },
                      ]),
                  ).values(),
                ],
              })),
          };
        },
      );
    },
    async install(
      actor: Actor,
      request: StoreTemplateRequest,
    ): Promise<StoreTemplateResult> {
      const input = normalize(request);
      const hash = createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex");
      // App slides show the app's icon (version 4): icons the apps lack are
      // fetched first, outside the install's transaction and lock.
      if (deps.fetchIcons && template.version >= 4 && !input.appScope)
        try {
          const sources = await withWorkspace(
            deps.db,
            { workspaceId: actor.workspaceId, userId: actor.callerId },
            (tx) => installIconSources(tx, actor.workspaceId, input, defaults),
          );
          if (sources.length) await deps.fetchIcons(actor, sources);
        } catch {
          // No icon: the slide has no logo; the install goes on.
        }
      try {
        return await retryOnSerializationFailure(
          () =>
            withWorkspace(
              deps.db,
              { workspaceId: actor.workspaceId, userId: actor.callerId },
              async (tx) => {
                const [installed] = await tx
                  .select()
                  .from(schema.dataTemplateInstalls)
                  .where(
                    and(
                      eq(
                        schema.dataTemplateInstalls.workspaceId,
                        actor.workspaceId,
                      ),
                      eq(
                        schema.dataTemplateInstalls.requestId,
                        input.requestId,
                      ),
                    ),
                  );
                if (installed) {
                  if (installed.requestHash !== hash)
                    reject("store_template_request_reused", 409);
                  const result = storeTemplateResultSchema.parse(
                    installed.result,
                  );
                  const [dashboard] = await tx
                    .select({ id: schema.dashboards.id })
                    .from(schema.dashboards)
                    .where(
                      and(
                        eq(schema.dashboards.workspaceId, actor.workspaceId),
                        eq(schema.dashboards.id, result.dashboardId),
                      ),
                    );
                  if (!dashboard) reject("store_template_removed", 409);
                  return result;
                }
                const sources = await storeTemplateSources(
                  tx,
                  { registry: deps.registry, policy: defaults },
                  actor.workspaceId,
                  input.connections,
                  { register: true },
                );
                // One batch service for the whole install (#668).
                const data = createDataService(tx, now, defaults, undefined, {
                    batch: true,
                  }),
                  t = storeTemplateCopy(actor.locale);
                const mappingRows = input.groups.flatMap((group) =>
                  group.apps.map((app) => ({
                    values: {
                      app_key: appKey(app),
                      product_id: "product:" + group.id,
                    },
                  })),
                );
                const productRows = input.groups.map((group) => ({
                  values: {
                    product_id: "product:" + group.id,
                    product_name: group.name,
                  },
                }));
                for (const source of sources)
                  productRows.push(unmappedProductRow(source, actor.locale));
                const products = await data.saveManual(actor, {
                  definition: sourceDatasetSchema.parse({
                    key: "store_products_" + input.requestId,
                    name: t.products,
                    version: 1,
                    mode: "snapshot",
                    grain: "One canonical name per confirmed product identity",
                    keyFields: ["product_id"],
                    retentionDays: null,
                    fields: [
                      {
                        id: "product_id",
                        name: "Product ID",
                        type: "string",
                        nullable: false,
                        classification: "internal",
                      },
                      {
                        id: "product_name",
                        name: t.app,
                        type: "string",
                        nullable: false,
                        classification: "internal",
                      },
                    ],
                  }),
                  records: productRows,
                });
                const mapping = await data.saveManual(actor, {
                  definition: sourceDatasetSchema.parse({
                    key: "store_mapping_" + input.requestId,
                    name: t.mapping,
                    version: 1,
                    mode: "snapshot",
                    grain:
                      "One confirmed product mapping per source app; unmapped apps retain their source identity",
                    keyFields: ["app_key"],
                    retentionDays: null,
                    fields: ["app_key", "product_id"].map((id) => ({
                      id,
                      name: id,
                      type: "string",
                      nullable: false,
                      classification: "internal",
                    })),
                  }),
                  records: mappingRows,
                });
                const scoped = input.appScope
                  ? input.groups.find((group) =>
                      group.apps.some(
                        (app) => appKey(app) === appKey(input.appScope!),
                      ),
                    )
                  : undefined;
                const inputs: StoreTemplateInputs = {
                  name: input.name,
                  locale: actor.locale,
                  projectId: input.projectId ?? null,
                  connections: sources,
                  fixedProduct: input.appScope
                    ? scoped
                      ? "product:" + scoped.id
                      : appKey(input.appScope)
                    : null,
                  groups: input.groups,
                };
                if (template.version >= 4)
                  inputs.apps = await readStoreApps(
                    tx,
                    actor.workspaceId,
                    input.requestId,
                    {
                      result: {
                        productDatasetId: products.datasetId,
                        mappingDatasetId: mapping.datasetId,
                      },
                      connections: sources,
                      fixedProduct: inputs.fixedProduct,
                      // As just written: not read back.
                      tables: {
                        products: productRows.map((row) => row.values),
                        mapping: mappingRows.map((row) => row.values),
                      },
                    },
                    now(),
                    defaults,
                  );
                const ids = {
                  "dataset:mapping": mapping.datasetId,
                  "dataset:products": products.datasetId,
                } as StoreTemplateIds;
                const preparationIds: string[] = [],
                  models = {} as Record<StoreMetric, string>,
                  built: StoreTemplateRecord[] = [];
                let dashboardId: string | undefined;
                for (const key of template.keys(inputs)) {
                  const record = template.build(key, inputs, ids);
                  built.push(record);
                  if (record.kind === "preparation") {
                    const saved = await data.savePreparation(actor, {
                      name: record.name,
                      graph: record.graph,
                      projectId: input.projectId,
                    });
                    await data.publishPreparation(
                      actor,
                      saved.preparation.id,
                      saved.preparation.version,
                    );
                    preparationIds.push(saved.preparation.id);
                    ids[key] = saved.preparation.id;
                  } else if (record.kind === "model") {
                    const model = await data.saveModel(actor, {
                      name: record.name,
                      definition: record.definition,
                      projectId: input.projectId,
                    });
                    await data.publishModel(
                      actor,
                      model.model.id,
                      model.model.version,
                    );
                    models[key.slice("model:".length) as StoreMetric] =
                      model.model.id;
                    ids[key] = model.model.id;
                  } else {
                    const dashboard = await createDashboardService({
                      db: tx,
                    }).create(
                      actor,
                      createDashboardRequestSchema.parse({
                        ...record.request,
                        projectId: input.projectId,
                      }),
                    );
                    if (!dashboard.ok)
                      reject(
                        dashboard.error,
                        dashboard.status as 400 | 404 | 409 | 413 | 503,
                      );
                    dashboardId = dashboard.value.id;
                    ids[key] = dashboard.value.id;
                  }
                }
                if (!dashboardId)
                  throw new Error("store template without dashboard");
                const omitted = storeAppSlides(storePortfolio(inputs)).omitted;
                const result: StoreTemplateResult = {
                  dashboardId,
                  mappingDatasetId: mapping.datasetId,
                  productDatasetId: products.datasetId,
                  models,
                  preparationIds,
                  // Apps past the dashboard's limits: the overview only.
                  ...(omitted.length
                    ? { omittedApps: omitted.map((app) => app.name) }
                    : {}),
                };
                await tx.insert(schema.dataTemplateInstalls).values({
                  workspaceId: actor.workspaceId,
                  requestId: input.requestId,
                  requestHash: hash,
                  result,
                  templateId: STORE_TEMPLATE_ID,
                  templateVersion: template.version,
                  inputs: storeTemplateInputsSchema.parse(inputs),
                  createdAt: now(),
                  updatedAt: now(),
                });
                const dashboardRecord = built.find(
                  (record) => record.kind === "dashboard",
                )!;
                const dashboardWidgetKeys = await installedWidgetKeys(
                  tx,
                  actor.workspaceId,
                  dashboardId,
                  dashboardRecord.kind === "dashboard"
                    ? dashboardRecord.widgetKeys
                    : [],
                  dashboardRecord.kind === "dashboard"
                    ? dashboardRecord.slideKeys
                    : undefined,
                );
                const recordRows: (typeof schema.dataTemplateRecords.$inferInsert)[] =
                  [
                    ...built.map((record) => ({
                      workspaceId: actor.workspaceId,
                      requestId: input.requestId,
                      key: record.key,
                      kind: record.kind,
                      recordId: ids[record.key]!,
                      templateVersion: template.version,
                      original:
                        record.kind === "preparation"
                          ? { graph: record.graph }
                          : record.kind === "model"
                            ? { definition: record.definition }
                            : // The widget keys in the request's reading
                              // order: a jsonb `widgetKeys` map loses order.
                              {
                                request: record.request,
                                widgetKeys: record.widgetKeys,
                                ...(record.slideKeys
                                  ? { slideKeys: record.slideKeys }
                                  : {}),
                                // The apps its slides were built from: what
                                // a later app change is compared with.
                                ...(inputs.apps ? { apps: inputs.apps } : {}),
                              },
                      widgetKeys:
                        record.kind === "dashboard"
                          ? dashboardWidgetKeys
                          : null,
                    })),
                    ...(["dataset:mapping", "dataset:products"] as const).map(
                      (key) => ({
                        workspaceId: actor.workspaceId,
                        requestId: input.requestId,
                        key,
                        kind: "dataset",
                        recordId: ids[key],
                        templateVersion: template.version,
                        original: null,
                        widgetKeys: null,
                      }),
                    ),
                  ];
                // Chunked: Postgres takes at most 65,535 parameters a statement.
                for (
                  let offset = 0;
                  offset < recordRows.length;
                  offset += recordChunk
                )
                  await tx
                    .insert(schema.dataTemplateRecords)
                    .values(recordRows.slice(offset, offset + recordChunk));
                await insertAuditEvent(tx, {
                  workspaceId: actor.workspaceId,
                  actorUserId: actor.callerId,
                  action: "data.store_template_installed",
                  target: dashboardId,
                  metadata: {
                    requestId: input.requestId,
                    mappingDatasetId: mapping.datasetId,
                  },
                });
                return result;
              },
              { isolationLevel: "serializable", lockTables: installLock },
            ),
          // A lock timeout is not retried: the retry would queue behind
          // installs that came later and wait the whole timeout again.
          { retryable: isRetryableDataConflict },
        );
      } catch (error) {
        if (isDataConflict(error) || isLockTimeout(error))
          reject("version_conflict", 409);
        if (error instanceof DatasetStoreError)
          reject(error.code, datasetStoreStatus(error.code));
        throw error;
      }
    },
  };
}
