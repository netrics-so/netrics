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
} from "@netrics/database";
import {
  DEFAULT_DATA_POLICY,
  exceedsDataPolicy,
  type DataPolicy,
  type Locale,
  type PreparationGraph,
} from "@netrics/domain";
import { createDataService, DataServiceError } from "../data/service.js";
import { createDashboardService } from "./service.js";
import {
  buildStorePreparation,
  buildStoreAppend,
  buildStoreModel,
  buildStoreDashboard,
  storeTemplateCopy,
  type StoreTemplateSource,
  type StoreMetric,
  type StoreConnectorId,
} from "./store-portfolio.js";

type Actor = { workspaceId: string; callerId: string; locale: Locale };
const metrics: StoreMetric[] = ["downloads", "proceeds", "ratings"];
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

export function createStoreTemplateService(deps: {
  db: Database;
  registry: ConnectorRegistry;
  now?: () => Date;
  policy?: DataPolicy;
}) {
  const now = deps.now ?? (() => new Date()),
    defaults = deps.policy ?? DEFAULT_DATA_POLICY;
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
              const preparationIds: string[] = [],
                outputs: Record<StoreMetric, string[]> = {
                  downloads: [],
                  proceeds: [],
                  ratings: [],
                };
              const publish = async (name: string, graph: PreparationGraph) => {
                const saved = await data.savePreparation(actor, {
                  name: name.slice(0, 100),
                  graph,
                });
                await data.publishPreparation(
                  actor,
                  saved.preparation.id,
                  saved.preparation.version,
                );
                preparationIds.push(saved.preparation.id);
                return `prepared:${saved.preparation.id}:${graph.outputs[0]!}`;
              };
              for (const source of sources)
                for (const metric of metrics)
                  outputs[metric].push(
                    await publish(
                      `${t[metric]} · ${source.name}`,
                      buildStorePreparation(
                        source,
                        metric,
                        mapping.datasetId,
                        products.datasetId,
                        actor.locale,
                      ),
                    ),
                  );
              const combine = async (
                metric: StoreMetric,
                inputs: string[],
              ): Promise<string> => {
                if (inputs.length === 1) return inputs[0]!;
                const next: string[] = [];
                for (let offset = 0; offset < inputs.length; offset += 80)
                  next.push(
                    await publish(
                      t[metric],
                      buildStoreAppend(inputs.slice(offset, offset + 80)),
                    ),
                  );
                return next.length === 1 ? next[0]! : combine(metric, next);
              };
              const models = {} as Record<StoreMetric, string>;
              for (const metric of metrics) {
                const definition = buildStoreModel(
                  metric,
                  await combine(metric, outputs[metric]),
                  actor.locale,
                );
                const model = await data.saveModel(actor, {
                  name: `${input.name} · ${t[metric]}`.slice(0, 100),
                  definition,
                });
                await data.publishModel(
                  actor,
                  model.model.id,
                  model.model.version,
                );
                models[metric] = model.model.id;
              }
              const scoped = input.appScope
                ? input.groups.find((group) =>
                    group.apps.some(
                      (app) => appKey(app) === appKey(input.appScope!),
                    ),
                  )
                : undefined;
              const product = input.appScope
                ? scoped
                  ? "product:" + scoped.id
                  : appKey(input.appScope)
                : undefined;
              const dashboard = await createDashboardService({ db: tx }).create(
                actor,
                createDashboardRequestSchema.parse(
                  buildStoreDashboard(
                    input.name,
                    models,
                    actor.locale,
                    product,
                  ),
                ),
              );
              if (!dashboard.ok)
                reject(
                  dashboard.error,
                  dashboard.status as 400 | 404 | 409 | 413 | 503,
                );
              const result: StoreTemplateResult = {
                dashboardId: dashboard.value.id,
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
                createdAt: now(),
              });
              await insertAuditEvent(tx, {
                workspaceId: actor.workspaceId,
                actorUserId: actor.callerId,
                action: "data.store_template_installed",
                target: dashboard.value.id,
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
