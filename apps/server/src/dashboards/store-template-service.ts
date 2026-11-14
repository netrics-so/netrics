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
  hasSqlstate,
  DatasetStoreError,
  type Database,
  type Transaction,
} from "@netrics/database";
import {
  DEFAULT_DATA_POLICY,
  exceedsDataPolicy,
  type DataPolicy,
  type Locale,
} from "@netrics/domain";
import { createDataService, DataServiceError } from "../data/service.js";
import { createDashboardService } from "./service.js";
import {
  storeTemplateCopy,
  type StoreTemplateSource,
  type StoreMetric,
  type StoreConnectorId,
} from "./store-portfolio.js";
import {
  storeTemplate,
  type StoreTemplateDefinition,
  type StoreTemplateIds,
  type StoreTemplateInputs,
  type StoreTemplateRecord,
  STORE_TEMPLATE_ID,
  storeTemplateInputsSchema,
} from "./store-template.js";

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
 * template's widgets in `widgetKeys` order.
 */
async function installedWidgetKeys(
  tx: Transaction,
  workspaceId: string,
  dashboardId: string,
  widgetKeys: string[],
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
  return Object.fromEntries(
    widgets.map((widget, index) => [widget.id, widgetKeys[index]!]),
  );
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
}) {
  const now = deps.now ?? (() => new Date()),
    defaults = deps.policy ?? DEFAULT_DATA_POLICY,
    template = deps.template ?? storeTemplate,
    recordChunk = deps.recordChunk ?? 1000;
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
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await withWorkspace(
            deps.db,
            { workspaceId: actor.workspaceId, userId: actor.callerId },
            async (tx) => {
              await tx.execute(
                sql`select pg_advisory_xact_lock(hashtext('netrics.store_template'),hashtext(${actor.workspaceId + ":" + input.requestId}))`,
              );
              const [installed] = await tx
                .select()
                .from(schema.dataTemplateInstalls)
                .where(
                  and(
                    eq(
                      schema.dataTemplateInstalls.workspaceId,
                      actor.workspaceId,
                    ),
                    eq(schema.dataTemplateInstalls.requestId, input.requestId),
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
              const rows = await tx
                .select()
                .from(schema.connections)
                .where(
                  and(
                    eq(schema.connections.workspaceId, actor.workspaceId),
                    inArray(schema.connections.id, input.connections),
                  ),
                )
                .orderBy(asc(schema.connections.id));
              if (rows.length !== input.connections.length)
                reject("connection_not_found", 404);
              const sources: StoreTemplateSource[] = [];
              for (const row of rows) {
                if (row.setupPending) reject("connection_setup_pending", 409);
                if (
                  row.connectorId !== "app-store-connect" &&
                  row.connectorId !== "google-play"
                )
                  reject("store_connector_required");
                const registered = deps.registry.get(row.connectorId);
                if (!registered) reject("connector_unavailable", 503);
                const needed =
                  row.connectorId === "app-store-connect"
                    ? ["sales_rows", "store_ratings"]
                    : ["install_rows", "earning_rows", "store_ratings"];
                const datasets: Record<string, string> = {};
                for (const key of needed) {
                  const definition = registered.manifest.datasets?.find(
                    (dataset) => dataset.key === key,
                  );
                  if (!definition)
                    reject("store_source_schema_unavailable", 503);
                  datasets[key] = (
                    await registerSourceDataset(tx, {
                      workspaceId: actor.workspaceId,
                      connectionId: row.id,
                      definition,
                      policyDefaults: defaults,
                    })
                  ).id;
                }
                sources.push({
                  id: row.id,
                  name: row.name,
                  connectorId: row.connectorId,
                  datasets,
                });
              }
              const data = createDataService(tx, now, defaults),
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
                productRows.push({
                  values: {
                    product_id: source.id + ":__unmapped",
                    product_name: `${t.unallocated} · ${source.name}`.slice(
                      0,
                      100,
                    ),
                  },
                });
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
              const result: StoreTemplateResult = {
                dashboardId,
                mappingDatasetId: mapping.datasetId,
                productDatasetId: products.datasetId,
                models,
                preparationIds,
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
                          : { request: record.request },
                    widgetKeys:
                      record.kind === "dashboard" ? dashboardWidgetKeys : null,
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
            { isolationLevel: "serializable" },
          );
        } catch (error) {
          const conflict =
            hasSqlstate(error, "40001") ||
            hasSqlstate(error, "40P01") ||
            (error instanceof DataServiceError &&
              error.code === "version_conflict");
          if (conflict && attempt < 2) continue;
          if (conflict) reject("version_conflict", 409);
          if (error instanceof DatasetStoreError)
            reject(error.code, /quota|limit/.test(error.code) ? 413 : 400);
          throw error;
        }
      }
      return reject("version_conflict", 409);
    },
  };
}
