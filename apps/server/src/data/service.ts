import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  lte,
  lt,
  sql,
  or,
  isNull,
  inArray,
} from "drizzle-orm";
import { z } from "zod";
import {
  sourceDatasetSchema,
  manualDatasetReadInputSchema,
  manualDatasetPageInputSchema,
  preparationGraphSchema,
  semanticModelDefinitionSchema,
  type SourceDatasetDefinition,
} from "@netrics/contracts";
import {
  DataProcessingError,
  DATA_EXECUTION_VERSION,
  ProcessingBudget,
  executePreparation,
  querySemanticModel,
  validateSemanticModel,
  DEFAULT_DATA_POLICY,
  exceedsDataPolicy,
  type DataPolicy,
  validateDataTable,
  type DataTable,
  type DataField,
  type PreparationGraph,
  type SemanticModelDefinition,
  type ModelQuery,
} from "@netrics/domain";
import {
  withWorkspace,
  schema,
  ingestDatasetPage,
  listObservationDatasets,
  readObservationDataset,
  insertAuditEvent,
  DatasetStoreError,
  hasSqlstate,
  resolveDataPolicy,
  type Database,
  type Transaction,
} from "@netrics/database";

export class DataServiceError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: 400 | 404 | 409 | 413 | 503 = 400,
  ) {
    super(code);
    this.name = "DataServiceError";
  }
}
const MAX_SNAPSHOT_EXPIRY = Date.parse("9999-12-31T23:59:59Z");
function fail(code: string, status: 400 | 404 | 409 | 413 | 503 = 400): never {
  throw new DataServiceError(code, status);
}
export interface DataActor {
  workspaceId: string;
  callerId: string;
}
export interface DataModelQuery extends Omit<ModelQuery, "now"> {
  pageToken?: string;
  pinPages?: boolean;
}
export type DataModelQueryResult = ReturnType<typeof querySemanticModel> & {
  receivedAt: string | null;
  expiresAt: string | null;
  releaseId: string | null;
  stale: boolean;
  error?: string;
  nextPageToken?: string;
  pageExpiresAt?: string;
};
interface PageToken {
  releaseId: string;
  sessionId: string;
  offset: number;
}
function readPageToken(token: string): PageToken {
  const [releaseId, sessionId, offset, extra] = token.split(":");
  if (
    extra !== undefined ||
    !z.uuid().safeParse(releaseId).success ||
    !z.uuid().safeParse(sessionId).success ||
    !offset ||
    !/^[1-9][0-9]*$/.test(offset) ||
    !Number.isSafeInteger(Number(offset))
  )
    fail("data_page_invalid");
  return {
    releaseId: releaseId!,
    sessionId: sessionId!,
    offset: Number(offset),
  };
}
function writePageToken(token: PageToken) {
  return token.releaseId + ":" + token.sessionId + ":" + token.offset;
}
interface Dependencies {
  prepared: Record<string, number>;
}
interface OutputSchema {
  fields: DataField[];
  rowCount: number;
  aggregated?: boolean;
}
function outputName(name: string, graph: PreparationGraph, output: string) {
  if (graph.outputs.length === 1) return name;
  const node = graph.nodes.find((node) => node.id === output);
  return (
    name +
    " / " +
    (node?.type === "calculate" ? node.name : graph.outputs.indexOf(output) + 1)
  );
}
interface SourceView {
  id: string;
  name: string;
  kind: "source" | "manual" | "observations" | "prepared" | "resources";
  fields: DataField[];
  generationId: string | null;
  rowCount: number | null;
  schemaVersion: number;
  aggregated: boolean;
  expiresAt: string | null;
  connectionId: string | null;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + stable(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
function preparationView(row: typeof schema.dataPreparations.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    graph: preparationGraphSchema.parse(row.graph),
    version: row.version,
    publishedVersion: row.publishedVersion,
    restoredFromVersion: row.restoredFromVersion,
    updatedAt: row.updatedAt.toISOString(),
  };
}
function modelView(row: typeof schema.dataModels.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    definition: semanticModelDefinitionSchema.parse(row.definition),
    version: row.version,
    publishedVersion: row.publishedVersion,
    restoredFromVersion: row.restoredFromVersion,
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface DraftContext {
  id: string;
  version: number;
}
async function preparationPublication(
  tx: Transaction,
  workspaceId: string,
  id: string,
  version: number,
) {
  const [publication] = await tx
    .select()
    .from(schema.dataPreparationVersions)
    .where(
      and(
        eq(schema.dataPreparationVersions.workspaceId, workspaceId),
        eq(schema.dataPreparationVersions.preparationId, id),
        eq(schema.dataPreparationVersions.version, version),
      ),
    );
  if (!publication) fail("data_publication_not_found", 404);
  return publication;
}
async function modelPublication(
  tx: Transaction,
  workspaceId: string,
  id: string,
  version: number,
) {
  const [publication] = await tx
    .select()
    .from(schema.dataModelReleases)
    .where(
      and(
        eq(schema.dataModelReleases.workspaceId, workspaceId),
        eq(schema.dataModelReleases.modelId, id),
        eq(schema.dataModelReleases.version, version),
      ),
    );
  if (!publication) fail("data_publication_not_found", 404);
  return publication;
}
function checkSchemaBindings(
  pinned: Record<string, DataField[]>,
  actual: Record<string, DataField[]>,
  ignoreUnused = false,
) {
  for (const [source, fields] of Object.entries(pinned)) {
    const nextFields = actual[source];
    if (!nextFields && ignoreUnused) continue;
    if (
      !nextFields ||
      fields.some((field) => {
        const next = nextFields.find((f) => f.id === field.id);
        return (
          !next ||
          next.type !== field.type ||
          next.unit !== field.unit ||
          next.currencyField !== field.currencyField
        );
      })
    )
      fail("data_model_schema_changed", 409);
  }
}

const RESOURCE_FIELDS: DataField[] = [
  {
    id: "resource_id",
    name: "Resource ID",
    type: "string",
    nullable: false,
  },
  {
    id: "name",
    name: "Resource name",
    type: "string",
    nullable: false,
  },
  {
    id: "kind",
    name: "Resource kind",
    type: "string",
    nullable: false,
  },
];
async function resourceCatalog(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
  policy: DataPolicy,
) {
  const [connection] = await tx
    .select({ id: schema.connections.id, name: schema.connections.name })
    .from(schema.connections)
    .where(
      and(
        eq(schema.connections.workspaceId, workspaceId),
        eq(schema.connections.id, connectionId),
      ),
    );
  if (!connection) fail("data_source_not_found", 404);
  const query = tx
    .select({
      resource_id: schema.connectionResources.resourceId,
      name: schema.connectionResources.name,
      kind: schema.connectionResources.kind,
    })
    .from(schema.connectionResources)
    .where(
      and(
        eq(schema.connectionResources.workspaceId, workspaceId),
        eq(schema.connectionResources.connectionId, connectionId),
      ),
    )
    .orderBy(
      asc(schema.connectionResources.resourceId),
      asc(schema.connectionResources.kind),
    );
  const rows = await (policy.queryRows === null
    ? query
    : query.limit(policy.queryRows + 1));
  if (exceedsDataPolicy(rows.length, policy.queryRows))
    fail("data_source_row_limit", 413);
  const id = "resources:" + connectionId;
  const generationId =
    "resources:" + createHash("sha256").update(stable(rows)).digest("hex");
  const table: DataTable = {
    fields: RESOURCE_FIELDS.map((field) => ({ ...field })),
    rows,
    provenance: [{ datasetId: id, generationId }],
  };
  const view: SourceView = {
    id,
    name: connection.name + " / Resources",
    kind: "resources",
    fields: table.fields,
    generationId,
    rowCount: rows.length,
    schemaVersion: 1,
    aggregated: false,
    expiresAt: null,
    connectionId,
  };
  return { table, view };
}

/** One loader per serializable transaction pins each source generation once. */
export function createDataLoader(
  tx: Transaction,
  workspaceId: string,
  now: Date,
  options: {
    dependencies?: Dependencies;
    generations?: Record<string, string>;
    overrides?: Map<string, { version: number; graph: PreparationGraph }>;
    policy?: DataPolicy;
    /** Definition preview/publication only; never interpret a pending input as collected rows. */
    allowPendingSchemas?: boolean;
    /** Queries may expose known values as partial, with pending input identities. */
    allowPendingResults?: boolean;
  } = {},
) {
  const tables = new Map<string, DataTable>(),
    views = new Map<string, SourceView>(),
    visiting = new Set<string>();
  const dependencies: Dependencies = {
    prepared: { ...(options.dependencies?.prepared ?? {}) },
  };
  const generations: Record<string, string> = {};
  const bindings: Record<string, DataField[]> = {};
  const warnings = new Set<string>();
  const policy = options.policy ?? { ...DEFAULT_DATA_POLICY };
  const budget = new ProcessingBudget(policy.queryOperations, {
    rows: policy.queryRows,
    outputBytes: policy.queryOutputBytes,
  });
  const load = async (id: string): Promise<DataTable> => {
    const cached = tables.get(id);
    if (cached) return cached;
    if (visiting.has(id) || visiting.size >= 20) fail("data_dependency_cycle");
    visiting.add(id);
    let result: DataTable;
    if (id.startsWith("prepared:")) {
      const parts = id.split(":");
      if (parts.length !== 3 || !z.uuid().safeParse(parts[1]).success)
        fail("data_source_not_found", 404);
      const preparationId = parts[1]!,
        output = parts[2]!;
      const [parent] = await tx
        .select()
        .from(schema.dataPreparations)
        .where(
          and(
            eq(schema.dataPreparations.workspaceId, workspaceId),
            eq(schema.dataPreparations.id, preparationId),
          ),
        );
      if (!parent) fail("data_source_not_found", 404);
      const override = options.overrides?.get(preparationId);
      const version =
        override?.version ??
        dependencies.prepared[preparationId] ??
        parent.publishedVersion;
      if (!version) fail("data_source_not_published", 409);
      const [published] = override
        ? []
        : await tx
            .select()
            .from(schema.dataPreparationVersions)
            .where(
              and(
                eq(schema.dataPreparationVersions.workspaceId, workspaceId),
                eq(schema.dataPreparationVersions.preparationId, preparationId),
                eq(schema.dataPreparationVersions.version, version),
              ),
            );
      if (!override && !published) fail("data_source_not_found", 404);
      const graph =
        override?.graph ?? preparationGraphSchema.parse(published!.graph);
      if (!graph.outputs.includes(output)) fail("data_source_not_found", 404);
      const nested = published?.dependencies as Dependencies | undefined;
      for (const [prepId, pinned] of Object.entries(nested?.prepared ?? {})) {
        if (
          dependencies.prepared[prepId] !== undefined &&
          dependencies.prepared[prepId] !== pinned
        )
          fail("data_dependency_version_conflict", 409);
        dependencies.prepared[prepId] = pinned;
      }
      dependencies.prepared[preparationId] = version;
      const inputs = new Map<string, DataTable>();
      for (const node of graph.nodes)
        if (node.type === "source")
          inputs.set(node.datasetId, await load(node.datasetId));
      const inputKey = createHash("sha256")
        .update(
          stable({
            engine: DATA_EXECUTION_VERSION,
            inputs: [...inputs.entries()].map(([source, table]) => ({
              source,
              provenance: table.provenance ?? [],
            })),
          }),
        )
        .digest("hex");
      const [cachedGeneration] =
        override || warnings.has("data_source_pending")
          ? []
          : await tx
              .select()
              .from(schema.dataPreparedGenerations)
              .where(
                and(
                  eq(schema.dataPreparedGenerations.workspaceId, workspaceId),
                  eq(
                    schema.dataPreparedGenerations.preparationId,
                    preparationId,
                  ),
                  eq(schema.dataPreparedGenerations.version, version),
                  eq(schema.dataPreparedGenerations.inputKey, inputKey),
                  ...(options.generations?.[id]
                    ? [
                        eq(
                          schema.dataPreparedGenerations.id,
                          options.generations[id]!,
                        ),
                      ]
                    : []),
                  gt(schema.dataPreparedGenerations.expiresAt, now),
                ),
              );
      if (options.generations?.[id] && !cachedGeneration)
        fail("data_snapshot_unavailable", 409);
      let preparedGenerationId = cachedGeneration?.id;
      if (cachedGeneration) {
        const cached = cachedGeneration.outputs as {
          tables: Record<string, DataTable>;
          warnings: string[];
        };
        result = cached.tables[output]!;
        cached.warnings.forEach((warning) => warnings.add(warning));
        // Reuse cannot outlive any authorized input, even if source policy changes.
        for (const input of inputs.values())
          if (
            input.expiresAt &&
            (!result.expiresAt ||
              new Date(input.expiresAt) < new Date(result.expiresAt))
          )
            result = { ...result, expiresAt: input.expiresAt };
      } else {
        const execution = executePreparation(graph, inputs, budget);
        execution.warnings.forEach((w) => warnings.add(w));
        result = execution.outputs[output]!;
        if (!override && !warnings.has("data_source_pending")) {
          const byteSize = Buffer.byteLength(JSON.stringify(execution.outputs));
          // The immutable key remains unique after its cache deadline. Reclaim
          // only this expired entry before rebuilding the same input vector.
          await tx
            .delete(schema.dataPreparedGenerations)
            .where(
              and(
                eq(schema.dataPreparedGenerations.workspaceId, workspaceId),
                eq(schema.dataPreparedGenerations.preparationId, preparationId),
                eq(schema.dataPreparedGenerations.version, version),
                eq(schema.dataPreparedGenerations.inputKey, inputKey),
                lte(schema.dataPreparedGenerations.expiresAt, now),
              ),
            );
          const [usage] = await tx
            .select({
              bytes: sql<string>`coalesce(sum(${schema.dataPreparedGenerations.byteSize}),0)`,
            })
            .from(schema.dataPreparedGenerations)
            .where(eq(schema.dataPreparedGenerations.workspaceId, workspaceId));
          if (
            !exceedsDataPolicy(byteSize, policy.maxPreparedGenerationBytes) &&
            !exceedsDataPolicy(
              Number(usage?.bytes ?? 0) + byteSize,
              policy.maxPreparedBytes,
            )
          ) {
            const expiresAt = Object.values(execution.outputs).reduce(
              (expiry, table) =>
                table.expiresAt && new Date(table.expiresAt) < expiry
                  ? new Date(table.expiresAt)
                  : expiry,
              new Date(
                policy.preparedCacheSeconds === null
                  ? "9999-12-31T23:59:59Z"
                  : now.getTime() + policy.preparedCacheSeconds * 1000,
              ),
            );
            const [created] = await tx
              .insert(schema.dataPreparedGenerations)
              .values({
                workspaceId,
                preparationId,
                version,
                inputKey,
                generations: { ...generations },
                outputs: {
                  tables: execution.outputs,
                  warnings: execution.warnings,
                },
                byteSize,
                expiresAt,
                createdAt: now,
              })
              .returning({ id: schema.dataPreparedGenerations.id });
            preparedGenerationId = created!.id;
          } else warnings.add("prepared_cache_capacity_reached");
        }
      }
      if (preparedGenerationId)
        result = {
          ...result,
          provenance: [
            ...(result.provenance ?? []),
            { datasetId: id, generationId: preparedGenerationId },
          ],
        };
      views.set(id, {
        id,
        name: outputName(parent.name, graph, output),
        kind: "prepared",
        fields: result.fields,
        generationId: preparedGenerationId ?? null,
        rowCount: result.rows.length,
        schemaVersion: version,
        aggregated: result.aggregated ?? false,
        expiresAt: result.expiresAt ?? null,
        connectionId: null,
      });
    } else if (id.startsWith("resources:")) {
      const connectionId = id.slice("resources:".length);
      if (!z.uuid().safeParse(connectionId).success)
        fail("data_source_not_found", 404);
      const catalog = await resourceCatalog(
        tx,
        workspaceId,
        connectionId,
        policy,
      );
      generations[id] = catalog.view.generationId!;
      if (
        options.generations?.[id] &&
        options.generations[id] !== generations[id]
      )
        fail("data_snapshot_unavailable", 409);
      result = catalog.table;
      views.set(id, catalog.view);
    } else if (id.startsWith("observation:")) {
      const parts = id.split(":");
      if (
        parts.length !== 3 ||
        !z.uuid().safeParse(parts[1]).success ||
        !z.uuid().safeParse(parts[2]).success
      )
        fail("data_source_not_found", 404);
      const read = await readObservationDataset(tx, {
        workspaceId,
        connectionId: parts[1]!,
        metricDefinitionId: parts[2]!,
        from: new Date("0001-01-01T00:00:00Z"),
        toExclusive: new Date("9999-12-31T23:59:59Z"),
        limit: policy.queryRows,
      });
      if (!read) fail("data_source_not_found", 404);
      if (read.truncated) fail("data_source_row_limit", 413);
      const fields: DataField[] = read.dataset.definition.fields.map((f) => ({
        ...f,
      }));
      if (read.dataset.unit === "currency_minor") {
        const amount = fields.find((f) => f.id === "value")!,
          currency = fields.find((f) => f.name === "currency");
        if (currency) {
          amount.type = "integer";
          amount.unit = "currency_minor";
          amount.currencyField = currency.id;
          currency.nullable = false;
        }
      } else {
        fields.find((f) => f.id === "value")!.unit = read.dataset.unit;
      }
      const fingerprint = createHash("sha256")
        .update(stable(read.rows))
        .digest("hex");
      generations[id] = "legacy:" + fingerprint;
      if (
        options.generations?.[id] &&
        options.generations[id] !== generations[id]
      )
        fail("data_snapshot_unavailable", 409);
      result = {
        fields,
        rows: read.rows,
        aggregated: true,
        provenance: [{ datasetId: id, generationId: generations[id]! }],
      };
      views.set(id, {
        id,
        name: read.dataset.definition.name,
        kind: "observations",
        fields,
        generationId: generations[id]!,
        rowCount: read.rows.length,
        schemaVersion: 1,
        aggregated: true,
        expiresAt: null,
        connectionId: read.dataset.connectionId,
      });
    } else {
      if (!z.uuid().safeParse(id).success) fail("data_source_not_found", 404);
      const [dataset] = await tx
        .select()
        .from(schema.dataDatasets)
        .where(
          and(
            eq(schema.dataDatasets.workspaceId, workspaceId),
            eq(schema.dataDatasets.id, id),
          ),
        );
      if (!dataset) fail("data_source_not_found", 404);
      const requested = options.generations?.[id];
      const [generation] = await tx
        .select()
        .from(schema.dataGenerations)
        .where(
          and(
            eq(schema.dataGenerations.workspaceId, workspaceId),
            eq(schema.dataGenerations.datasetId, id),
            ...(requested ? [eq(schema.dataGenerations.id, requested)] : []),
          ),
        )
        .orderBy(desc(schema.dataGenerations.sequence))
        .limit(1);
      if (!generation) {
        // A source that once published data is never reinterpreted as a first
        // import after retention/GC. Snapshot fallback must also stay exact.
        if (dataset.hasPublishedData)
          fail("data_source_history_unavailable", 409);
        if (
          (!options.allowPendingSchemas && !options.allowPendingResults) ||
          requested
        )
          fail("data_source_pending", 409);
        const [version] = await tx
          .select()
          .from(schema.dataSchemaVersions)
          .where(
            and(
              eq(schema.dataSchemaVersions.workspaceId, workspaceId),
              eq(schema.dataSchemaVersions.datasetId, id),
            ),
          )
          .orderBy(desc(schema.dataSchemaVersions.version))
          .limit(1);
        if (!version) fail("data_schema_not_found", 409);
        const definition = sourceDatasetSchema.parse(version.definition);
        const pending: DataTable = {
          fields: definition.fields.map((field) => ({ ...field })),
          rows: [],
          pendingSources: [id],
        };
        validateDataTable(pending, budget);
        warnings.add("data_source_pending");
        bindings[id] = pending.fields;
        views.set(id, {
          id,
          name: dataset.name,
          kind: dataset.kind as "source" | "manual",
          fields: pending.fields,
          generationId: null,
          rowCount: null,
          schemaVersion: version.version,
          aggregated: false,
          expiresAt: null,
          connectionId: dataset.connectionId,
        });
        visiting.delete(id);
        tables.set(id, pending);
        return pending;
      }
      if (generation.expiresAt !== null && generation.expiresAt <= now)
        fail("data_source_expired", 409);
      const [version] = await tx
        .select()
        .from(schema.dataSchemaVersions)
        .where(
          and(
            eq(schema.dataSchemaVersions.workspaceId, workspaceId),
            eq(schema.dataSchemaVersions.datasetId, id),
            eq(schema.dataSchemaVersions.version, generation.schemaVersion),
          ),
        );
      if (!version) fail("data_schema_not_found", 409);
      const definition = sourceDatasetSchema.parse(version.definition);
      const recordQuery = tx
        .select()
        .from(schema.dataRecords)
        .where(
          and(
            eq(schema.dataRecords.workspaceId, workspaceId),
            eq(schema.dataRecords.generationId, generation.id),
            or(
              isNull(schema.dataRecords.expiresAt),
              gt(schema.dataRecords.expiresAt, now),
            ),
            ...(policy.maxRetentionDays !== null
              ? [
                  gt(
                    schema.dataRecords.collectedAt,
                    new Date(
                      Math.max(
                        -62135596800000,
                        now.getTime() - policy.maxRetentionDays * 86400000,
                      ),
                    ),
                  ),
                ]
              : []),
          ),
        )
        .orderBy(asc(schema.dataRecords.recordKey));
      const records = await (policy.queryRows === null
        ? recordQuery
        : recordQuery.limit(policy.queryRows + 1));
      if (exceedsDataPolicy(records.length, policy.queryRows))
        fail("data_source_row_limit", 413);
      if (records.length !== generation.rowCount) {
        if (requested) fail("data_snapshot_expired", 409);
        warnings.add("retained_source_history_incomplete");
      }
      const expiry = records.reduce<Date | null>((min, row) => {
        const policyExpiry =
          policy.maxRetentionDays === null
            ? null
            : new Date(
                Math.min(
                  253402300799000,
                  row.collectedAt.getTime() +
                    policy.maxRetentionDays * 86400000,
                ),
              );
        for (const candidate of [row.expiresAt, policyExpiry])
          if (candidate !== null && (min === null || candidate < min))
            min = candidate;
        return min;
      }, generation.expiresAt);
      result = {
        fields: definition.fields.map((f) => ({ ...f })),
        rows: records.map((row) => row.values as Record<string, unknown>),
        provenance: [{ datasetId: id, generationId: generation.id }],
        ...(expiry ? { expiresAt: expiry.toISOString() } : {}),
      };
      generations[id] = generation.id;
      views.set(id, {
        id,
        name: dataset.name,
        kind: dataset.kind as "source" | "manual",
        fields: result.fields,
        generationId: generation.id,
        rowCount: records.length,
        schemaVersion: generation.schemaVersion,
        aggregated: false,
        expiresAt: expiry?.toISOString() ?? null,
        connectionId: dataset.connectionId,
      });
    }
    validateDataTable(result, budget);
    bindings[id] = result.fields;
    visiting.delete(id);
    tables.set(id, result);
    return result;
  };
  return {
    load,
    tables,
    views,
    dependencies,
    generations,
    bindings,
    warnings,
    budget,
  };
}

export function createDataService(
  db: Pick<Database, "transaction">,
  clock: () => Date = () => new Date(),
  defaults: DataPolicy = { ...DEFAULT_DATA_POLICY },
) {
  const policies = new WeakMap<Transaction, DataPolicy>();
  const policyFor = (tx: Transaction) => policies.get(tx)!;
  const loadFor: typeof createDataLoader = (
    tx,
    workspaceId,
    now,
    options = {},
  ) =>
    createDataLoader(tx, workspaceId, now, {
      ...options,
      policy: policyFor(tx),
    });
  const run = async <T>(
    actor: DataActor,
    fn: (tx: Transaction, now: Date) => Promise<T>,
  ) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await withWorkspace(
          db,
          { workspaceId: actor.workspaceId, userId: actor.callerId },
          async (tx) => {
            const { policy } = await resolveDataPolicy(
              tx,
              actor.workspaceId,
              defaults,
            );
            policies.set(tx, policy);
            await tx.execute(
              sql`select set_config('statement_timeout', ${String(policy.queryTimeoutMs ?? 0)}, true)`,
            );
            return fn(tx, clock());
          },
          { isolationLevel: "serializable" },
        );
      } catch (error) {
        if (
          attempt < 2 &&
          (hasSqlstate(error, "40001") || hasSqlstate(error, "40P01"))
        )
          continue;
        if (
          error instanceof DataServiceError ||
          error instanceof DataProcessingError
        )
          throw error;
        if (error instanceof DatasetStoreError)
          fail(
            error.code,
            error.code.includes("conflict")
              ? 409
              : error.code.includes("quota") || error.code.includes("limit")
                ? 413
                : 400,
          );
        if (
          hasSqlstate(error, "40001") ||
          hasSqlstate(error, "40P01") ||
          hasSqlstate(error, "23505")
        )
          fail("version_conflict", 409);
        fail("data_storage_failed", 503);
      }
    }
    return fail("version_conflict", 409);
  };
  const audit = async (
    tx: Transaction,
    actor: DataActor,
    action: string,
    target: string,
    metadata: Record<string, unknown> = {},
  ) =>
    insertAuditEvent(tx, {
      workspaceId: actor.workspaceId,
      actorUserId: actor.callerId,
      action,
      target,
      metadata,
    });
  const listSources = (actor: DataActor) =>
    run(actor, async (tx, now) => {
      const items: SourceView[] = [];
      const roots = await tx
        .select()
        .from(schema.dataDatasets)
        .where(eq(schema.dataDatasets.workspaceId, actor.workspaceId))
        .orderBy(asc(schema.dataDatasets.createdAt));
      for (const d of roots) {
        const [generation] = await tx
          .select()
          .from(schema.dataGenerations)
          .where(
            and(
              eq(schema.dataGenerations.workspaceId, actor.workspaceId),
              eq(schema.dataGenerations.datasetId, d.id),
            ),
          )
          .orderBy(desc(schema.dataGenerations.sequence))
          .limit(1);
        const [version] = await tx
          .select()
          .from(schema.dataSchemaVersions)
          .where(
            and(
              eq(schema.dataSchemaVersions.workspaceId, actor.workspaceId),
              eq(schema.dataSchemaVersions.datasetId, d.id),
              ...(generation
                ? [
                    eq(
                      schema.dataSchemaVersions.version,
                      generation.schemaVersion,
                    ),
                  ]
                : []),
            ),
          )
          .orderBy(desc(schema.dataSchemaVersions.version))
          .limit(1);
        if (!version) continue;
        const definition = sourceDatasetSchema.parse(version.definition);
        items.push({
          id: d.id,
          name: d.name,
          kind: d.kind as "source" | "manual",
          fields: definition.fields,
          generationId: generation?.id ?? null,
          rowCount: generation?.rowCount ?? null,
          schemaVersion: definition.version,
          aggregated: false,
          expiresAt: generation?.expiresAt?.toISOString() ?? null,
          connectionId: d.connectionId,
        });
      }
      const namedConnections = await tx
        .selectDistinct({ id: schema.connectionResources.connectionId })
        .from(schema.connectionResources)
        .where(eq(schema.connectionResources.workspaceId, actor.workspaceId));
      for (const connection of namedConnections)
        items.push(
          (
            await resourceCatalog(
              tx,
              actor.workspaceId,
              connection.id,
              policyFor(tx),
            )
          ).view,
        );
      for (const legacy of await listObservationDatasets(
        tx,
        actor.workspaceId,
        { limit: policyFor(tx).queryRows },
      ))
        items.push({
          id: legacy.id,
          name: legacy.definition.name,
          kind: "observations",
          fields: legacy.definition.fields,
          generationId: null,
          rowCount: null,
          schemaVersion: 1,
          aggregated: true,
          expiresAt: null,
          connectionId: legacy.connectionId,
        });
      const prepared = await tx
        .select({
          parent: schema.dataPreparations,
          version: schema.dataPreparationVersions,
        })
        .from(schema.dataPreparations)
        .innerJoin(
          schema.dataPreparationVersions,
          and(
            eq(
              schema.dataPreparationVersions.preparationId,
              schema.dataPreparations.id,
            ),
            eq(
              schema.dataPreparationVersions.workspaceId,
              schema.dataPreparations.workspaceId,
            ),
            eq(
              schema.dataPreparationVersions.version,
              schema.dataPreparations.publishedVersion,
            ),
          ),
        )
        .where(eq(schema.dataPreparations.workspaceId, actor.workspaceId));
      for (const { parent, version } of prepared)
        for (const [node, output] of Object.entries(
          version.outputSchemas as Record<string, OutputSchema>,
        ))
          items.push({
            id: "prepared:" + parent.id + ":" + node,
            name: outputName(
              parent.name,
              preparationGraphSchema.parse(version.graph),
              node,
            ),
            kind: "prepared",
            fields: output.fields,
            generationId: null,
            rowCount: null,
            schemaVersion: version.version,
            aggregated: output.aggregated ?? false,
            expiresAt: null,
            connectionId: null,
          });
      void now;
      return { sources: items };
    });
  const findPreparation = async (
    tx: Transaction,
    workspaceId: string,
    id: string,
    lock = false,
  ) => {
    const q = tx
      .select()
      .from(schema.dataPreparations)
      .where(
        and(
          eq(schema.dataPreparations.workspaceId, workspaceId),
          eq(schema.dataPreparations.id, id),
        ),
      );
    const [row] = await (lock ? q.for("update") : q);
    if (!row) fail("data_preparation_not_found", 404);
    return row;
  };

  const executeGraph = async (
    tx: Transaction,
    workspaceId: string,
    now: Date,
    graph: PreparationGraph,
    loader = loadFor(tx, workspaceId, now),
  ) => {
    const inputs = new Map<string, DataTable>();
    for (const n of graph.nodes)
      if (n.type === "source")
        inputs.set(n.datasetId, await loader.load(n.datasetId));
    const output = executePreparation(graph, inputs, loader.budget);
    return { loader, output };
  };
  return {
    listSources,
    previewModel: (
      actor: DataActor,
      definition: SemanticModelDefinition,
      query: DataModelQuery,
      draft?: DraftContext,
    ) =>
      run(actor, async (tx, now) => {
        if (query.pageToken || query.pinPages)
          fail("data_page_preview_unsupported");
        const row = draft
          ? await findDataModel(tx, actor.workspaceId, draft.id)
          : null;
        if (row && row.version !== draft!.version)
          fail("version_conflict", 409);
        const restored = row?.restoredFromVersion
          ? await modelPublication(
              tx,
              actor.workspaceId,
              row.id,
              row.restoredFromVersion,
            )
          : null;
        const parsed = semanticModelDefinitionSchema.parse(definition),
          loader = loadFor(tx, actor.workspaceId, now, {
            allowPendingSchemas: true,
            ...(restored
              ? { dependencies: restored.dependencies as Dependencies }
              : {}),
          });
        for (const source of parsed.datasets) await loader.load(source);
        if (restored)
          checkSchemaBindings(
            restored.schemaBindings as Record<string, DataField[]>,
            loader.bindings,
            true,
          );
        const result = querySemanticModel(
          parsed,
          loader.tables,
          { ...query, now: now.toISOString() },
          loader.budget,
        );
        return {
          ...result,
          ...(loader.warnings.has("data_source_pending")
            ? { rows: [], totalRows: 0 }
            : {}),
          releaseId: null,
          stale: false,
          warnings: [...loader.warnings, ...result.warnings],
        };
      }),
    preview: (
      actor: DataActor,
      id: string,
      limit = 100,
      draft?: DraftContext,
    ) =>
      run(actor, async (tx, now) => {
        const row = draft
          ? await findPreparation(tx, actor.workspaceId, draft.id)
          : null;
        if (row && row.version !== draft!.version)
          fail("version_conflict", 409);
        const restored = row?.restoredFromVersion
          ? await preparationPublication(
              tx,
              actor.workspaceId,
              row.id,
              row.restoredFromVersion,
            )
          : null;
        const loader = loadFor(
            tx,
            actor.workspaceId,
            now,
            restored
              ? { dependencies: restored.dependencies as Dependencies }
              : {},
          ),
          table = await loader.load(id);
        return {
          fields: table.fields,
          rows: table.rows.slice(0, limit),
          truncated: table.rows.length > limit,
          warnings: [...loader.warnings],
        };
      }),
    readManual: (
      actor: DataActor,
      id: string,
      input: z.infer<typeof manualDatasetReadInputSchema>,
    ) =>
      run(actor, async (tx, now) => {
        const [dataset] = await tx
          .select()
          .from(schema.dataDatasets)
          .where(
            and(
              eq(schema.dataDatasets.workspaceId, actor.workspaceId),
              eq(schema.dataDatasets.id, id),
              eq(schema.dataDatasets.kind, "manual"),
            ),
          );
        if (!dataset) fail("data_source_not_found", 404);
        const [generation] = await tx
          .select()
          .from(schema.dataGenerations)
          .where(
            and(
              eq(schema.dataGenerations.workspaceId, actor.workspaceId),
              eq(schema.dataGenerations.datasetId, id),
              ...(input.generationId
                ? [eq(schema.dataGenerations.id, input.generationId)]
                : []),
            ),
          )
          .orderBy(desc(schema.dataGenerations.sequence))
          .limit(1);
        if (input.generationId && !generation)
          fail("data_snapshot_unavailable", 409);
        if (dataset.hasPublishedData && !generation)
          fail("data_source_history_unavailable", 409);
        if (generation?.expiresAt && generation.expiresAt <= now)
          fail("data_source_expired", 409);
        const [version] = await tx
          .select()
          .from(schema.dataSchemaVersions)
          .where(
            and(
              eq(schema.dataSchemaVersions.workspaceId, actor.workspaceId),
              eq(schema.dataSchemaVersions.datasetId, id),
              ...(generation
                ? [
                    eq(
                      schema.dataSchemaVersions.version,
                      generation.schemaVersion,
                    ),
                  ]
                : []),
            ),
          )
          .orderBy(desc(schema.dataSchemaVersions.version))
          .limit(1);
        if (!version) fail("data_schema_not_found", 409);
        const definition = sourceDatasetSchema.parse(version.definition),
          policy = policyFor(tx);
        if (!generation)
          return {
            definition,
            generationId: null,
            records: [],
            total: 0,
            offset: input.offset,
          };
        const eligible = and(
          eq(schema.dataRecords.workspaceId, actor.workspaceId),
          eq(schema.dataRecords.generationId, generation.id),
          or(
            isNull(schema.dataRecords.expiresAt),
            gt(schema.dataRecords.expiresAt, now),
          ),
          ...(policy.maxRetentionDays === null
            ? []
            : [
                gt(
                  schema.dataRecords.collectedAt,
                  new Date(
                    Math.max(
                      -62135596800000,
                      now.getTime() - policy.maxRetentionDays * 86400000,
                    ),
                  ),
                ),
              ]),
        );
        const [count] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(schema.dataRecords)
          .where(eligible);
        // Never copy an expired subset into a fresh editable snapshot.
        if (count?.count !== generation.rowCount)
          fail("data_source_expired", 409);
        const rows = await tx
          .select({ values: schema.dataRecords.values })
          .from(schema.dataRecords)
          .where(eligible)
          .orderBy(asc(schema.dataRecords.recordKey))
          .offset(input.offset)
          .limit(Math.min(input.limit, policy.queryRows ?? input.limit));
        const records: Array<{ values: Record<string, unknown> }> = [];
        let bytes = Buffer.byteLength(JSON.stringify(definition)) + 256;
        const maximum = Math.min(
          512 * 1024,
          policy.queryOutputBytes ?? Infinity,
        );
        for (const row of rows) {
          const record = { values: row.values as Record<string, unknown> },
            size = Buffer.byteLength(JSON.stringify(record));
          if (bytes + size > maximum) {
            if (!records.length) fail("data_output_limit", 413);
            break;
          }
          records.push(record);
          bytes += size;
        }
        return {
          definition,
          generationId: generation.id,
          records,
          total: generation.rowCount,
          offset: input.offset,
        };
      }),
    saveManualPage: (
      actor: DataActor,
      input: z.infer<typeof manualDatasetPageInputSchema>,
    ) =>
      run(actor, async (tx, now) => {
        const [dataset] = await tx
          .select()
          .from(schema.dataDatasets)
          .where(
            and(
              eq(schema.dataDatasets.workspaceId, actor.workspaceId),
              eq(schema.dataDatasets.kind, "manual"),
              input.datasetId
                ? eq(schema.dataDatasets.id, input.datasetId)
                : eq(schema.dataDatasets.key, input.definition.key),
            ),
          )
          .for("update");
        if (input.datasetId && !dataset) fail("data_source_not_found", 404);
        if (dataset && dataset.key !== input.definition.key)
          fail("data_source_identity_changed", 409);
        const [generation] = dataset
          ? await tx
              .select()
              .from(schema.dataGenerations)
              .where(
                and(
                  eq(schema.dataGenerations.workspaceId, actor.workspaceId),
                  eq(schema.dataGenerations.datasetId, dataset.id),
                ),
              )
              .orderBy(desc(schema.dataGenerations.sequence))
              .limit(1)
          : [];
        if (
          (generation?.id ?? null) !== input.generationId &&
          generation?.refreshKey !== input.refreshId
        )
          fail("version_conflict", 409);
        if (dataset?.hasPublishedData && !generation)
          fail("data_source_history_unavailable", 409);
        const [refresh] = dataset
          ? await tx
              .select({ version: schema.dataRefreshes.schemaVersion })
              .from(schema.dataRefreshes)
              .where(
                and(
                  eq(schema.dataRefreshes.workspaceId, actor.workspaceId),
                  eq(schema.dataRefreshes.datasetId, dataset.id),
                  eq(schema.dataRefreshes.refreshKey, input.refreshId),
                ),
              )
          : [];
        const [latestSchema] =
          dataset && !refresh
            ? await tx
                .select({ version: schema.dataSchemaVersions.version })
                .from(schema.dataSchemaVersions)
                .where(
                  and(
                    eq(
                      schema.dataSchemaVersions.workspaceId,
                      actor.workspaceId,
                    ),
                    eq(schema.dataSchemaVersions.datasetId, dataset.id),
                  ),
                )
                .orderBy(desc(schema.dataSchemaVersions.version))
                .limit(1)
            : [];
        // Staged edits reserve immutable schema versions. A cancelled proposal
        // must not prevent a later editor from creating a different definition.
        const definition = {
          ...input.definition,
          version: refresh?.version ?? (latestSchema?.version ?? 0) + 1,
        };
        const result = await ingestDatasetPage(tx, {
          workspaceId: actor.workspaceId,
          connectionId: null,
          kind: "manual",
          definition,
          page: {
            datasetKey: input.definition.key,
            schemaVersion: definition.version,
            refreshKey: input.refreshId,
            pageKey: "page-" + input.page,
            previousPageKey: input.page ? "page-" + (input.page - 1) : null,
            complete: input.complete,
            records: input.records,
          },
          now,
          policyDefaults: policyFor(tx),
        });
        if (input.complete && !result.replayed) {
          await tx
            .update(schema.dataDatasets)
            .set({ name: definition.name })
            .where(
              and(
                eq(schema.dataDatasets.workspaceId, actor.workspaceId),
                eq(schema.dataDatasets.id, result.datasetId),
                eq(schema.dataDatasets.kind, "manual"),
              ),
            );
          await audit(tx, actor, "data.manual_saved", result.datasetId);
        }
        return {
          datasetId: result.datasetId,
          generationId: result.generationId,
        };
      }),
    saveManual: (
      actor: DataActor,
      input: {
        definition: SourceDatasetDefinition;
        records: Array<{ values: Record<string, unknown>; deleted?: boolean }>;
        generationId?: string | null;
      },
      datasetId?: string,
    ) =>
      run(actor, async (tx, now) => {
        if (input.definition.mode !== "snapshot")
          fail("data_manual_snapshot_required");
        if (!datasetId) {
          const [existing] = await tx
            .select({ id: schema.dataDatasets.id })
            .from(schema.dataDatasets)
            .where(
              and(
                eq(schema.dataDatasets.workspaceId, actor.workspaceId),
                eq(schema.dataDatasets.kind, "manual"),
                eq(schema.dataDatasets.key, input.definition.key),
              ),
            );
          if (existing) fail("data_source_key_taken", 409);
        }
        if (datasetId) {
          const [existing] = await tx
            .select()
            .from(schema.dataDatasets)
            .where(
              and(
                eq(schema.dataDatasets.workspaceId, actor.workspaceId),
                eq(schema.dataDatasets.id, datasetId),
                eq(schema.dataDatasets.kind, "manual"),
              ),
            );
          if (!existing) fail("data_source_not_found", 404);
          if (existing.key !== input.definition.key)
            fail("data_source_identity_changed", 409);
          const [current] = await tx
            .select()
            .from(schema.dataGenerations)
            .where(
              and(
                eq(schema.dataGenerations.workspaceId, actor.workspaceId),
                eq(schema.dataGenerations.datasetId, datasetId),
              ),
            )
            .orderBy(desc(schema.dataGenerations.sequence))
            .limit(1);
          if (input.generationId !== current?.id) fail("version_conflict", 409);
        }
        let result: {
          datasetId: string;
          generationId: string | null;
          replayed: boolean;
        } | null = null;
        const refreshKey = randomUUID();
        const chunks = Math.max(1, Math.ceil(input.records.length / 1000));
        for (let page = 0; page < chunks; page++)
          result = await ingestDatasetPage(tx, {
            workspaceId: actor.workspaceId,
            connectionId: null,
            kind: "manual",
            definition: input.definition,
            page: {
              datasetKey: input.definition.key,
              schemaVersion: input.definition.version,
              refreshKey,
              pageKey: "page-" + page,
              previousPageKey: page ? "page-" + (page - 1) : null,
              records: input.records.slice(page * 1000, page * 1000 + 1000),
              complete: page === chunks - 1,
            },
            now,
            policyDefaults: defaults,
          });
        if (!result?.generationId) fail("data_publish_failed", 409);
        await audit(tx, actor, "data.manual_published", result.datasetId);
        return {
          datasetId: result.datasetId,
          generationId: result.generationId,
        };
      }),
    listPreparations: (actor: DataActor) =>
      run(actor, async (tx) => ({
        preparations: (
          await tx
            .select()
            .from(schema.dataPreparations)
            .where(eq(schema.dataPreparations.workspaceId, actor.workspaceId))
            .orderBy(asc(schema.dataPreparations.name))
        ).map(preparationView),
      })),
    getPreparation: (actor: DataActor, id: string) =>
      run(actor, async (tx) => ({
        preparation: preparationView(
          await findPreparation(tx, actor.workspaceId, id),
        ),
      })),
    preparationInputs: (actor: DataActor, id: string, expected: number) =>
      run(actor, async (tx, now) => {
        const row = await findPreparation(tx, actor.workspaceId, id);
        if (row.version !== expected) fail("version_conflict", 409);
        const restored = row.restoredFromVersion
          ? await preparationPublication(
              tx,
              actor.workspaceId,
              id,
              row.restoredFromVersion,
            )
          : null;
        const loader = loadFor(tx, actor.workspaceId, now, {
          allowPendingSchemas: true,
          ...(restored
            ? { dependencies: restored.dependencies as Dependencies }
            : {}),
        });
        const inputs = [
          ...new Set(
            preparationGraphSchema
              .parse(row.graph)
              .nodes.filter((node) => node.type === "source")
              .map((node) => node.datasetId),
          ),
        ];
        for (const input of inputs) await loader.load(input);
        return { sources: [...loader.views.values()] };
      }),
    preparationHistory: (
      actor: DataActor,
      id: string,
      input: { beforeVersion?: number; limit: number },
    ) =>
      run(actor, async (tx) => {
        const current = await findPreparation(tx, actor.workspaceId, id);
        const versions = await tx
          .select({
            version: schema.dataPreparationVersions.version,
            createdAt: schema.dataPreparationVersions.createdAt,
          })
          .from(schema.dataPreparationVersions)
          .where(
            and(
              eq(schema.dataPreparationVersions.workspaceId, actor.workspaceId),
              eq(schema.dataPreparationVersions.preparationId, id),
              ...(input.beforeVersion
                ? [
                    lt(
                      schema.dataPreparationVersions.version,
                      input.beforeVersion,
                    ),
                  ]
                : []),
            ),
          )
          .orderBy(desc(schema.dataPreparationVersions.version))
          .limit(input.limit + 1);
        const page = versions.slice(0, input.limit);
        return {
          versions: page.map((v) => ({
            version: v.version,
            createdAt: v.createdAt.toISOString(),
            active: v.version === current.publishedVersion,
          })),
          nextBeforeVersion:
            versions.length > input.limit ? page.at(-1)!.version : null,
        };
      }),
    restorePreparation: (
      actor: DataActor,
      id: string,
      input: { version: number; publishedVersion: number },
    ) =>
      run(actor, async (tx, now) => {
        const current = await findPreparation(tx, actor.workspaceId, id, true);
        if (current.version !== input.version) fail("version_conflict", 409);
        const publication = await preparationPublication(
          tx,
          actor.workspaceId,
          id,
          input.publishedVersion,
        );
        const graph = preparationGraphSchema.parse(publication.graph);
        // Re-authorize and validate current retained data using historical definition pins.
        await executeGraph(
          tx,
          actor.workspaceId,
          now,
          graph,
          loadFor(tx, actor.workspaceId, now, {
            allowPendingSchemas: true,
            dependencies: publication.dependencies as Dependencies,
          }),
        );
        const [updated] = await tx
          .update(schema.dataPreparations)
          .set({
            graph,
            restoredFromVersion: publication.version,
            version: current.version + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.dataPreparations.workspaceId, actor.workspaceId),
              eq(schema.dataPreparations.id, id),
            ),
          )
          .returning();
        await audit(tx, actor, "data.preparation_restored", id, {
          fromVersion: publication.version,
          draftVersion: updated!.version,
        });
        return { preparation: preparationView(updated!) };
      }),
    savePreparation: (
      actor: DataActor,
      input: {
        name: string;
        graph: PreparationGraph;
        version?: number;
        adoptLatestInputs?: boolean;
      },
      id?: string,
    ) =>
      run(actor, async (tx, now) => {
        const graph = preparationGraphSchema.parse(input.graph);
        if (id) {
          const current = await findPreparation(
            tx,
            actor.workspaceId,
            id,
            true,
          );
          if (input.version !== current.version) fail("version_conflict", 409);
          const [row] = await tx
            .update(schema.dataPreparations)
            .set({
              name: input.name,
              graph,
              ...(input.adoptLatestInputs ? { restoredFromVersion: null } : {}),
              version: current.version + 1,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.dataPreparations.workspaceId, actor.workspaceId),
                eq(schema.dataPreparations.id, id),
              ),
            )
            .returning();
          await audit(tx, actor, "data.preparation_updated", id);
          return { preparation: preparationView(row!) };
        }
        const count = await tx
          .select({ id: schema.dataPreparations.id })
          .from(schema.dataPreparations)
          .where(eq(schema.dataPreparations.workspaceId, actor.workspaceId));
        if (exceedsDataPolicy(count.length + 1, policyFor(tx).maxPreparations))
          fail("data_preparation_limit", 413);
        const [row] = await tx
          .insert(schema.dataPreparations)
          .values({
            workspaceId: actor.workspaceId,
            name: input.name,
            graph,
            updatedAt: now,
          })
          .returning();
        await audit(tx, actor, "data.preparation_created", row!.id);
        return { preparation: preparationView(row!) };
      }),
    previewPreparation: (
      actor: DataActor,
      graph: PreparationGraph,
      draft?: DraftContext,
    ) =>
      run(actor, async (tx, now) => {
        const row = draft
          ? await findPreparation(tx, actor.workspaceId, draft.id)
          : null;
        if (row && row.version !== draft!.version)
          fail("version_conflict", 409);
        const restored = row?.restoredFromVersion
          ? await preparationPublication(
              tx,
              actor.workspaceId,
              row.id,
              row.restoredFromVersion,
            )
          : null;
        const { loader, output } = await executeGraph(
          tx,
          actor.workspaceId,
          now,
          preparationGraphSchema.parse(graph),
          loadFor(tx, actor.workspaceId, now, {
            allowPendingSchemas: true,
            ...(restored
              ? { dependencies: restored.dependencies as Dependencies }
              : {}),
          }),
        );
        const pending = loader.warnings.has("data_source_pending");
        return {
          outputs: Object.fromEntries(
            Object.entries(output.outputs).map(([id, table]) => [
              id,
              {
                fields: table.fields,
                rows: pending ? [] : table.rows.slice(0, 100),
                truncated: !pending && table.rows.length > 100,
              },
            ]),
          ),
          warnings: [...loader.warnings, ...output.warnings],
          rejectedRows: output.rejectedRows,
        };
      }),
    publishPreparation: (actor: DataActor, id: string, expected: number) =>
      run(actor, async (tx, now) => {
        const row = await findPreparation(tx, actor.workspaceId, id, true);
        if (row.version !== expected) fail("version_conflict", 409);
        if (row.publishedVersion === expected)
          return { preparation: preparationView(row) };
        const restored = row.restoredFromVersion
          ? await preparationPublication(
              tx,
              actor.workspaceId,
              id,
              row.restoredFromVersion,
            )
          : null;
        const graph = preparationGraphSchema.parse(row.graph),
          { loader, output } = await executeGraph(
            tx,
            actor.workspaceId,
            now,
            graph,
            loadFor(tx, actor.workspaceId, now, {
              allowPendingSchemas: true,
              ...(restored
                ? { dependencies: restored.dependencies as Dependencies }
                : {}),
            }),
          );
        if (
          graph.nodes.some(
            (node) =>
              node.type === "source" &&
              node.datasetId.startsWith("prepared:" + id + ":"),
          )
        )
          fail("data_dependency_cycle");
        await tx.insert(schema.dataPreparationVersions).values({
          preparationId: id,
          workspaceId: actor.workspaceId,
          version: row.version,
          graph,
          outputSchemas: Object.fromEntries(
            Object.entries(output.outputs).map(([key, table]) => [
              key,
              {
                fields: table.fields,
                rowCount: table.rows.length,
                aggregated: table.aggregated ?? false,
              },
            ]),
          ),
          dependencies: loader.dependencies,
          createdAt: now,
        });
        const publishedLoader = loadFor(tx, actor.workspaceId, now, {
          allowPendingSchemas: true,
          dependencies: {
            prepared: { ...loader.dependencies.prepared, [id]: row.version },
          },
        });
        for (const output of graph.outputs)
          await publishedLoader.load("prepared:" + id + ":" + output);
        const [updated] = await tx
          .update(schema.dataPreparations)
          .set({ publishedVersion: row.version, updatedAt: now })
          .where(
            and(
              eq(schema.dataPreparations.workspaceId, actor.workspaceId),
              eq(schema.dataPreparations.id, id),
            ),
          )
          .returning();
        await audit(tx, actor, "data.preparation_published", id);
        return { preparation: preparationView(updated!) };
      }),
    listModels: (actor: DataActor) =>
      run(actor, async (tx) => ({
        models: (
          await tx
            .select()
            .from(schema.dataModels)
            .where(eq(schema.dataModels.workspaceId, actor.workspaceId))
            .orderBy(asc(schema.dataModels.name))
        ).map(modelView),
      })),
    getModel: (actor: DataActor, id: string) =>
      run(actor, async (tx) => ({
        model: modelView(await findDataModel(tx, actor.workspaceId, id)),
      })),
    modelInputs: (actor: DataActor, id: string, expected: number) =>
      run(actor, async (tx, now) => {
        const row = await findDataModel(tx, actor.workspaceId, id);
        if (row.version !== expected) fail("version_conflict", 409);
        const restored = row.restoredFromVersion
          ? await modelPublication(
              tx,
              actor.workspaceId,
              id,
              row.restoredFromVersion,
            )
          : null;
        const definition = semanticModelDefinitionSchema.parse(row.definition);
        const loader = loadFor(tx, actor.workspaceId, now, {
          allowPendingSchemas: true,
          ...(restored
            ? { dependencies: restored.dependencies as Dependencies }
            : {}),
        });
        for (const input of definition.datasets) await loader.load(input);
        if (restored)
          checkSchemaBindings(
            restored.schemaBindings as Record<string, DataField[]>,
            loader.bindings,
            true,
          );
        return { sources: [...loader.views.values()] };
      }),
    modelHistory: (
      actor: DataActor,
      id: string,
      input: { beforeVersion?: number; limit: number },
    ) =>
      run(actor, async (tx) => {
        const current = await findDataModel(tx, actor.workspaceId, id);
        const versions = await tx
          .select({
            version: schema.dataModelReleases.version,
            createdAt: schema.dataModelReleases.createdAt,
          })
          .from(schema.dataModelReleases)
          .where(
            and(
              eq(schema.dataModelReleases.workspaceId, actor.workspaceId),
              eq(schema.dataModelReleases.modelId, id),
              ...(input.beforeVersion
                ? [lt(schema.dataModelReleases.version, input.beforeVersion)]
                : []),
            ),
          )
          .orderBy(desc(schema.dataModelReleases.version))
          .limit(input.limit + 1);
        const page = versions.slice(0, input.limit);
        return {
          versions: page.map((v) => ({
            version: v.version,
            createdAt: v.createdAt.toISOString(),
            active: v.version === current.publishedVersion,
          })),
          nextBeforeVersion:
            versions.length > input.limit ? page.at(-1)!.version : null,
        };
      }),
    restoreModel: (
      actor: DataActor,
      id: string,
      input: { version: number; publishedVersion: number },
    ) =>
      run(actor, async (tx, now) => {
        const current = await findDataModel(tx, actor.workspaceId, id, true);
        if (current.version !== input.version) fail("version_conflict", 409);
        const publication = await modelPublication(
          tx,
          actor.workspaceId,
          id,
          input.publishedVersion,
        );
        const definition = semanticModelDefinitionSchema.parse(
          publication.definition,
        );
        const loader = loadFor(tx, actor.workspaceId, now, {
          allowPendingSchemas: true,
          dependencies: publication.dependencies as Dependencies,
        });
        for (const source of definition.datasets) await loader.load(source);
        checkSchemaBindings(
          publication.schemaBindings as Record<string, DataField[]>,
          loader.bindings,
        );
        validateSemanticModel(
          definition,
          loader.tables,
          now.toISOString(),
          loader.budget,
        );
        const [updated] = await tx
          .update(schema.dataModels)
          .set({
            definition,
            restoredFromVersion: publication.version,
            version: current.version + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.dataModels.workspaceId, actor.workspaceId),
              eq(schema.dataModels.id, id),
            ),
          )
          .returning();
        await audit(tx, actor, "data.model_restored", id, {
          fromVersion: publication.version,
          draftVersion: updated!.version,
        });
        return { model: modelView(updated!) };
      }),
    saveModel: (
      actor: DataActor,
      input: {
        name: string;
        definition: SemanticModelDefinition;
        version?: number;
        adoptLatestInputs?: boolean;
      },
      id?: string,
    ) =>
      run(actor, async (tx, now) => {
        const definition = semanticModelDefinitionSchema.parse(
          input.definition,
        );
        if (id) {
          const row = await findDataModel(tx, actor.workspaceId, id, true);
          if (input.version !== row.version) fail("version_conflict", 409);
          const [updated] = await tx
            .update(schema.dataModels)
            .set({
              name: input.name,
              definition,
              ...(input.adoptLatestInputs ? { restoredFromVersion: null } : {}),
              version: row.version + 1,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.dataModels.workspaceId, actor.workspaceId),
                eq(schema.dataModels.id, id),
              ),
            )
            .returning();
          await audit(tx, actor, "data.model_updated", id);
          return { model: modelView(updated!) };
        }
        const count = await tx
          .select({ id: schema.dataModels.id })
          .from(schema.dataModels)
          .where(eq(schema.dataModels.workspaceId, actor.workspaceId));
        if (exceedsDataPolicy(count.length + 1, policyFor(tx).maxModels))
          fail("data_model_limit", 413);
        const [row] = await tx
          .insert(schema.dataModels)
          .values({
            workspaceId: actor.workspaceId,
            name: input.name,
            definition,
            updatedAt: now,
          })
          .returning();
        await audit(tx, actor, "data.model_created", row!.id);
        return { model: modelView(row!) };
      }),
    publishModel: (actor: DataActor, id: string, expected: number) =>
      run(actor, async (tx, now) => {
        const row = await findDataModel(tx, actor.workspaceId, id, true);
        if (row.version !== expected) fail("version_conflict", 409);
        if (row.publishedVersion === expected) return { model: modelView(row) };
        const restored = row.restoredFromVersion
          ? await modelPublication(
              tx,
              actor.workspaceId,
              id,
              row.restoredFromVersion,
            )
          : null;
        const definition = semanticModelDefinitionSchema.parse(row.definition),
          loader = loadFor(tx, actor.workspaceId, now, {
            allowPendingSchemas: true,
            ...(restored
              ? { dependencies: restored.dependencies as Dependencies }
              : {}),
          });
        for (const source of definition.datasets) await loader.load(source);
        if (restored)
          checkSchemaBindings(
            restored.schemaBindings as Record<string, DataField[]>,
            loader.bindings,
            true,
          );
        validateSemanticModel(
          definition,
          loader.tables,
          now.toISOString(),
          loader.budget,
        );
        await tx.insert(schema.dataModelReleases).values({
          workspaceId: actor.workspaceId,
          modelId: id,
          version: row.version,
          definition,
          dependencies: loader.dependencies,
          schemaBindings: loader.bindings,
          createdAt: now,
        });
        const [updated] = await tx
          .update(schema.dataModels)
          .set({ publishedVersion: row.version, updatedAt: now })
          .where(
            and(
              eq(schema.dataModels.workspaceId, actor.workspaceId),
              eq(schema.dataModels.id, id),
            ),
          )
          .returning();
        await audit(tx, actor, "data.model_published", id);
        return { model: modelView(updated!) };
      }),
    query: (
      actor: DataActor,
      id: string,
      query: DataModelQuery,
      preview = false,
    ) =>
      run(actor, async (tx, now) => {
        return queryDataModel(
          tx,
          actor.workspaceId,
          id,
          query,
          now,
          policyFor(tx),
          preview,
        );
      }),
  };
}

async function findDataModel(
  tx: Transaction,
  workspaceId: string,
  id: string,
  lock = false,
) {
  const q = tx
    .select()
    .from(schema.dataModels)
    .where(
      and(
        eq(schema.dataModels.workspaceId, workspaceId),
        eq(schema.dataModels.id, id),
      ),
    );
  const [row] = await (lock ? q.for("update") : q);
  if (!row) fail("data_model_not_found", 404);
  return row;
}

/** Internal query entry for dashboard/device transactions. Caller supplies an authorized workspace. */
export async function queryDataModel(
  tx: Transaction,
  workspaceId: string,
  id: string,
  query: DataModelQuery,
  now: Date,
  policy: DataPolicy,
  preview = false,
): Promise<DataModelQueryResult> {
  const continuation = query.pageToken ? readPageToken(query.pageToken) : null;
  if ((continuation || query.pinPages) && preview)
    fail("data_page_preview_unsupported");
  if (continuation && query.offset !== undefined)
    fail("data_page_offset_conflict");
  const { pageToken: _pageToken, pinPages: _pinPages, ...queryInputs } = query;
  const executionQuery = {
    ...queryInputs,
    ...(continuation ? { offset: continuation.offset } : {}),
  };
  const { offset: _offset, ...pageInputs } = queryInputs;
  const pageQueryKey = createHash("sha256")
    .update(
      stable({
        engine: DATA_EXECUTION_VERSION,
        query: { ...pageInputs, limit: query.limit ?? 1000 },
      }),
    )
    .digest("hex");
  // Clamp to the latest representable deadline: the policy allows lifetimes
  // up to MAX_SAFE_INTEGER seconds, which would otherwise be an Invalid Date.
  const snapshotDeadline = () =>
    new Date(
      policy.querySnapshotSeconds === null
        ? MAX_SNAPSHOT_EXPIRY
        : Math.min(
            MAX_SNAPSHOT_EXPIRY,
            now.getTime() + policy.querySnapshotSeconds * 1000,
          ),
    );
  const snapshotExpiry = (
    snapshot: typeof schema.dataModelQuerySnapshots.$inferSelect,
  ) =>
    new Date(
      Math.min(
        snapshot.expiresAt.getTime(),
        policy.querySnapshotSeconds === null
          ? Infinity
          : snapshot.updatedAt.getTime() + policy.querySnapshotSeconds * 1000,
      ),
    );
  const model = await findDataModel(tx, workspaceId, id);
  if (!preview && !model.publishedVersion)
    fail("data_model_not_published", 409);
  const [release] = preview
    ? []
    : await tx
        .select()
        .from(schema.dataModelReleases)
        .where(
          and(
            eq(schema.dataModelReleases.workspaceId, workspaceId),
            eq(schema.dataModelReleases.modelId, id),
            continuation
              ? eq(schema.dataModelReleases.id, continuation.releaseId)
              : eq(schema.dataModelReleases.version, model.publishedVersion!),
          ),
        );
  if (!preview && !release)
    fail(
      continuation ? "data_page_unavailable" : "data_model_not_published",
      409,
    );
  const restored =
    preview && model.restoredFromVersion
      ? await modelPublication(tx, workspaceId, id, model.restoredFromVersion)
      : null;
  const definition = semanticModelDefinitionSchema.parse(
    preview ? model.definition : release!.definition,
  );
  const evaluate = async (generations?: Record<string, string>) => {
    const loader = createDataLoader(tx, workspaceId, now, {
      policy,
      allowPendingResults: true,
      ...(generations ? { generations } : {}),
      ...(release || restored
        ? { dependencies: (release ?? restored)!.dependencies as Dependencies }
        : {}),
    });
    for (const source of definition.datasets) await loader.load(source);
    if (release || restored)
      checkSchemaBindings(
        (release ?? restored)!.schemaBindings as Record<string, DataField[]>,
        loader.bindings,
        !release,
      );
    const result = querySemanticModel(
      definition,
      loader.tables,
      { ...executionQuery, now: now.toISOString() },
      loader.budget,
    );
    const retainedInputs = result.provenance.filter(
      (source) =>
        !source.datasetId.startsWith("resources:") &&
        !source.datasetId.startsWith("prepared:"),
    );
    const rawGenerations = retainedInputs
      .map((source) => source.generationId)
      .filter((id) => z.uuid().safeParse(id).success);
    const stamps = rawGenerations.length
      ? await tx
          .select({ at: schema.dataGenerations.createdAt })
          .from(schema.dataGenerations)
          .where(
            and(
              eq(schema.dataGenerations.workspaceId, workspaceId),
              inArray(schema.dataGenerations.id, rawGenerations),
            ),
          )
      : [];
    const receivedAt =
      !result.pendingSources?.length &&
      stamps.length === retainedInputs.length &&
      stamps.length
        ? new Date(
            Math.min(...stamps.map((stamp) => stamp.at.getTime())),
          ).toISOString()
        : null;
    const expiries = [...loader.tables.values()]
      .flatMap((table) => (table.expiresAt ? [table.expiresAt] : []))
      .sort();
    return {
      loader,
      result: {
        ...result,
        receivedAt,
        expiresAt: expiries[0] ?? null,
        releaseId: release?.id ?? null,
        stale: false,
        warnings: [
          ...new Set(
            [...loader.warnings]
              .filter(
                (warning) =>
                  warning !== "data_source_pending" ||
                  result.pendingSources?.length,
              )
              .concat(result.warnings),
          ),
        ],
      },
    };
  };
  const pageResult = (
    result: Awaited<ReturnType<typeof evaluate>>["result"],
    sessionId: string,
    expiresAt: Date,
  ) => ({
    ...result,
    ...(result.offset + result.rows.length < result.totalRows
      ? {
          nextPageToken: writePageToken({
            releaseId: release!.id,
            sessionId,
            offset: result.offset + result.rows.length,
          }),
          pageExpiresAt: expiresAt.toISOString(),
        }
      : {}),
  });
  if (continuation) {
    const [snapshot] = await tx
      .select()
      .from(schema.dataModelQuerySnapshots)
      .where(
        and(
          eq(schema.dataModelQuerySnapshots.workspaceId, workspaceId),
          eq(schema.dataModelQuerySnapshots.releaseId, release!.id),
          eq(
            schema.dataModelQuerySnapshots.queryKey,
            "page:" + continuation.sessionId + ":" + pageQueryKey,
          ),
          gt(schema.dataModelQuerySnapshots.expiresAt, now),
        ),
      );
    if (
      !snapshot ||
      policy.querySnapshotCount === 0 ||
      snapshotExpiry(snapshot) <= now
    )
      fail("data_page_unavailable", 409);
    // No fallback, renewal or current-generation substitution on a continuation.
    // Any pinned input that is no longer available (expired or deleted source,
    // pruned history, changed schema) ends the session with one stable code;
    // starting a new query reports the underlying cause.
    let execution: Awaited<ReturnType<typeof evaluate>>;
    try {
      execution = await evaluate(
        snapshot.generations as Record<string, string>,
      );
    } catch (error) {
      if (
        error instanceof DataProcessingError ||
        (error instanceof DataServiceError &&
          (error.status === 404 || error.status === 409))
      )
        fail("data_page_unavailable", 409);
      throw error;
    }
    if (execution.loader.warnings.has("data_source_pending"))
      fail("data_page_unavailable", 409);
    return pageResult(
      execution.result,
      continuation.sessionId,
      snapshotExpiry(snapshot),
    );
  }
  const queryKey = createHash("sha256")
    .update(stable({ engine: DATA_EXECUTION_VERSION, query: queryInputs }))
    .digest("hex");
  let execution: Awaited<ReturnType<typeof evaluate>>;
  try {
    execution = await evaluate();
  } catch (error) {
    // No SQL failures or removed sources are hidden by a previous snapshot.
    // The source IDs are re-authorized by the loader on every fallback.
    const recoverable =
      error instanceof DataProcessingError ||
      (error instanceof DataServiceError &&
        [
          "data_model_schema_changed",
          "data_source_pending",
          "data_schema_not_found",
          "data_source_row_limit",
          "data_dependency_version_conflict",
        ].includes(error.code));
    if (!release || !recoverable) throw error;
    const [snapshot] = await tx
      .select()
      .from(schema.dataModelQuerySnapshots)
      .where(
        and(
          eq(schema.dataModelQuerySnapshots.workspaceId, workspaceId),
          eq(schema.dataModelQuerySnapshots.releaseId, release.id),
          eq(schema.dataModelQuerySnapshots.queryKey, queryKey),
          gt(schema.dataModelQuerySnapshots.expiresAt, now),
        ),
      );
    if (
      !snapshot ||
      policy.querySnapshotCount === 0 ||
      snapshotExpiry(snapshot) <= now
    )
      throw error;
    const fallback = await evaluate(
      snapshot.generations as Record<string, string>,
    );
    return {
      ...fallback.result,
      stale: true,
      error: error.code,
      warnings: [
        ...fallback.result.warnings,
        "using_last_valid_source_snapshot",
        ...(query.pinPages ? ["immutable_pagination_unavailable"] : []),
      ],
    };
  }
  let result: ReturnType<typeof pageResult> = execution.result;
  if (release && !execution.result.pendingSources?.length) {
    // Cache only generation identities, never a second copy of source rows.
    // Limit cache cardinality and lifetime independently of source retention.
    // Reclaim expired identities before admission, including deadlines shortened
    // by the current policy. Active sessions are never evicted or renewed here.
    await tx
      .delete(schema.dataModelQuerySnapshots)
      .where(
        and(
          eq(schema.dataModelQuerySnapshots.workspaceId, workspaceId),
          eq(schema.dataModelQuerySnapshots.releaseId, release.id),
          or(
            lte(schema.dataModelQuerySnapshots.expiresAt, now),
            ...(policy.querySnapshotSeconds !== null
              ? [
                  lte(
                    schema.dataModelQuerySnapshots.updatedAt,
                    new Date(
                      Math.max(
                        -62135596800000,
                        now.getTime() - policy.querySnapshotSeconds * 1000,
                      ),
                    ),
                  ),
                ]
              : []),
          ),
        ),
      );
    const existing = await tx
      .select({ queryKey: schema.dataModelQuerySnapshots.queryKey })
      .from(schema.dataModelQuerySnapshots)
      .where(
        and(
          eq(schema.dataModelQuerySnapshots.workspaceId, workspaceId),
          eq(schema.dataModelQuerySnapshots.releaseId, release.id),
        ),
      );
    // Page sessions and last-valid snapshots have separate capacity, each
    // bounded by querySnapshotCount, so pinned clients cannot crowd out the
    // fallback snapshots that ordinary and dashboard queries rely on.
    const sessionCount = existing.filter((s) =>
      s.queryKey.startsWith("page:"),
    ).length;
    const snapshotCount = existing.length - sessionCount;
    if (
      query.pinPages &&
      execution.result.offset + execution.result.rows.length <
        execution.result.totalRows
    ) {
      if (
        !execution.loader.warnings.has("data_source_pending") &&
        !execution.loader.warnings.has("retained_source_history_incomplete") &&
        [...execution.loader.views.values()].every(
          (source) =>
            source.kind !== "prepared" || source.generationId !== null,
        ) &&
        !exceedsDataPolicy(sessionCount + 1, policy.querySnapshotCount) &&
        policy.querySnapshotSeconds !== 0
      ) {
        const sessionId = randomUUID();
        const generations = { ...execution.loader.generations };
        for (const table of execution.loader.tables.values())
          for (const source of table.provenance ?? [])
            if (source.datasetId.startsWith("prepared:"))
              generations[source.datasetId] = source.generationId;
        const preparedIds = Object.entries(generations)
          .filter(([id]) => id.startsWith("prepared:"))
          .map(([, generation]) => generation);
        const preparedExpiries = preparedIds.length
          ? await tx
              .select({ expiresAt: schema.dataPreparedGenerations.expiresAt })
              .from(schema.dataPreparedGenerations)
              .where(
                and(
                  eq(schema.dataPreparedGenerations.workspaceId, workspaceId),
                  inArray(schema.dataPreparedGenerations.id, preparedIds),
                ),
              )
          : [];
        const expiresAt = [...execution.loader.tables.values()].reduce(
          (expiry, table) =>
            table.expiresAt && new Date(table.expiresAt) < expiry
              ? new Date(table.expiresAt)
              : expiry,
          snapshotDeadline(),
        );
        for (const prepared of preparedExpiries)
          if (prepared.expiresAt < expiresAt)
            expiresAt.setTime(prepared.expiresAt.getTime());
        await tx.insert(schema.dataModelQuerySnapshots).values({
          workspaceId,
          releaseId: release.id,
          queryKey: "page:" + sessionId + ":" + pageQueryKey,
          generations,
          expiresAt,
          updatedAt: now,
        });
        result = pageResult(execution.result, sessionId, expiresAt);
      } else {
        result = {
          ...execution.result,
          warnings: [
            ...execution.result.warnings,
            "immutable_pagination_unavailable",
          ],
        };
      }
    }
    if (
      policy.querySnapshotCount !== 0 &&
      policy.querySnapshotSeconds !== 0 &&
      (!exceedsDataPolicy(snapshotCount + 1, policy.querySnapshotCount) ||
        existing.some((s) => s.queryKey === queryKey))
    ) {
      const expiresAt = [...execution.loader.tables.values()].reduce(
        (expiry, table) =>
          table.expiresAt && new Date(table.expiresAt) < expiry
            ? new Date(table.expiresAt)
            : expiry,
        snapshotDeadline(),
      );
      await tx
        .insert(schema.dataModelQuerySnapshots)
        .values({
          workspaceId: workspaceId,
          releaseId: release.id,
          queryKey,
          generations: execution.loader.generations,
          expiresAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.dataModelQuerySnapshots.releaseId,
            schema.dataModelQuerySnapshots.queryKey,
          ],
          set: {
            generations: execution.loader.generations,
            expiresAt,
            updatedAt: now,
          },
          setWhere: eq(schema.dataModelQuerySnapshots.workspaceId, workspaceId),
        });
    }
  }
  if (
    query.pinPages &&
    result.offset + result.rows.length < result.totalRows &&
    !result.nextPageToken &&
    !result.warnings.includes("immutable_pagination_unavailable")
  )
    return {
      ...result,
      warnings: [...result.warnings, "immutable_pagination_unavailable"],
    };
  return result;
}
