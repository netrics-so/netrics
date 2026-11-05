import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, sql, or, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  sourceDatasetSchema,
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
function fail(code: string, status: 400 | 404 | 409 | 413 | 503 = 400): never {
  throw new DataServiceError(code, status);
}
export interface DataActor {
  workspaceId: string;
  callerId: string;
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
  kind: "source" | "manual" | "observations" | "prepared";
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
    updatedAt: row.updatedAt.toISOString(),
  };
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
      const [cachedGeneration] = override
        ? []
        : await tx
            .select()
            .from(schema.dataPreparedGenerations)
            .where(
              and(
                eq(schema.dataPreparedGenerations.workspaceId, workspaceId),
                eq(schema.dataPreparedGenerations.preparationId, preparationId),
                eq(schema.dataPreparedGenerations.version, version),
                eq(schema.dataPreparedGenerations.inputKey, inputKey),
                gt(schema.dataPreparedGenerations.expiresAt, now),
              ),
            );
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
        if (!override) {
          const byteSize = Buffer.byteLength(JSON.stringify(execution.outputs));
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
      if (!generation) fail("data_source_pending", 409);
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
  db: Database,
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
  ) =>
    insertAuditEvent(tx, {
      workspaceId: actor.workspaceId,
      actorUserId: actor.callerId,
      action,
      target,
      metadata: {},
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
      for (const legacy of await listObservationDatasets(tx, actor.workspaceId))
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
  const findModel = async (
    tx: Transaction,
    workspaceId: string,
    id: string,
    lock = false,
  ) => {
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
      query: Omit<ModelQuery, "now">,
    ) =>
      run(actor, async (tx, now) => {
        const parsed = semanticModelDefinitionSchema.parse(definition),
          loader = loadFor(tx, actor.workspaceId, now);
        for (const source of parsed.datasets) await loader.load(source);
        const result = querySemanticModel(
          parsed,
          loader.tables,
          { ...query, now: now.toISOString() },
          loader.budget,
        );
        return {
          ...result,
          releaseId: null,
          stale: false,
          warnings: [...loader.warnings, ...result.warnings],
        };
      }),
    preview: (actor: DataActor, id: string, limit = 100) =>
      run(actor, async (tx, now) => {
        const loader = loadFor(tx, actor.workspaceId, now),
          table = await loader.load(id);
        return {
          fields: table.fields,
          rows: table.rows.slice(0, limit),
          truncated: table.rows.length > limit,
          warnings: [...loader.warnings],
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
    savePreparation: (
      actor: DataActor,
      input: { name: string; graph: PreparationGraph; version?: number },
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
    previewPreparation: (actor: DataActor, graph: PreparationGraph) =>
      run(actor, async (tx, now) => {
        const { loader, output } = await executeGraph(
          tx,
          actor.workspaceId,
          now,
          preparationGraphSchema.parse(graph),
        );
        return {
          outputs: Object.fromEntries(
            Object.entries(output.outputs).map(([id, table]) => [
              id,
              {
                fields: table.fields,
                rows: table.rows.slice(0, 100),
                truncated: table.rows.length > 100,
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
        const graph = preparationGraphSchema.parse(row.graph),
          { loader, output } = await executeGraph(
            tx,
            actor.workspaceId,
            now,
            graph,
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
        model: modelView(await findModel(tx, actor.workspaceId, id)),
      })),
    saveModel: (
      actor: DataActor,
      input: {
        name: string;
        definition: SemanticModelDefinition;
        version?: number;
      },
      id?: string,
    ) =>
      run(actor, async (tx, now) => {
        const definition = semanticModelDefinitionSchema.parse(
          input.definition,
        );
        if (id) {
          const row = await findModel(tx, actor.workspaceId, id, true);
          if (input.version !== row.version) fail("version_conflict", 409);
          const [updated] = await tx
            .update(schema.dataModels)
            .set({
              name: input.name,
              definition,
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
        const row = await findModel(tx, actor.workspaceId, id, true);
        if (row.version !== expected) fail("version_conflict", 409);
        if (row.publishedVersion === expected) return { model: modelView(row) };
        const definition = semanticModelDefinitionSchema.parse(row.definition),
          loader = loadFor(tx, actor.workspaceId, now);
        for (const source of definition.datasets) await loader.load(source);
        for (let offset = 0; offset < definition.measures.length; offset += 50)
          querySemanticModel(
            definition,
            loader.tables,
            {
              measureIds: definition.measures
                .slice(offset, offset + 50)
                .map((m) => m.id),
              groupBy: [],
              now: now.toISOString(),
            },
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
      query: Omit<ModelQuery, "now">,
      preview = false,
    ) =>
      run(actor, async (tx, now) => {
        const model = await findModel(tx, actor.workspaceId, id);
        if (!preview && !model.publishedVersion)
          fail("data_model_not_published", 409);
        const [release] = preview
          ? []
          : await tx
              .select()
              .from(schema.dataModelReleases)
              .where(
                and(
                  eq(schema.dataModelReleases.workspaceId, actor.workspaceId),
                  eq(schema.dataModelReleases.modelId, id),
                  eq(schema.dataModelReleases.version, model.publishedVersion!),
                ),
              );
        if (!preview && !release) fail("data_model_not_published", 409);
        const definition = semanticModelDefinitionSchema.parse(
          preview ? model.definition : release!.definition,
        );
        const evaluate = async (generations?: Record<string, string>) => {
          const loader = loadFor(tx, actor.workspaceId, now, {
            ...(generations ? { generations } : {}),
            ...(release
              ? { dependencies: release.dependencies as Dependencies }
              : {}),
          });
          for (const source of definition.datasets) await loader.load(source);
          if (release)
            for (const [source, pinned] of Object.entries(
              release.schemaBindings as Record<string, DataField[]>,
            )) {
              const actual = loader.bindings[source];
              if (
                !actual ||
                pinned.some((field) => {
                  const next = actual.find((f) => f.id === field.id);
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
          const result = querySemanticModel(
            definition,
            loader.tables,
            { ...query, now: now.toISOString() },
            loader.budget,
          );
          return {
            loader,
            result: {
              ...result,
              releaseId: release?.id ?? null,
              stale: false,
              warnings: [...loader.warnings, ...result.warnings],
            },
          };
        };
        const queryKey = createHash("sha256")
          .update(stable({ engine: DATA_EXECUTION_VERSION, query }))
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
                eq(
                  schema.dataModelQuerySnapshots.workspaceId,
                  actor.workspaceId,
                ),
                eq(schema.dataModelQuerySnapshots.releaseId, release.id),
                eq(schema.dataModelQuerySnapshots.queryKey, queryKey),
                gt(schema.dataModelQuerySnapshots.expiresAt, now),
              ),
            );
          if (!snapshot) throw error;
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
            ],
          };
        }
        if (release) {
          // Cache only generation identities, never a second copy of source rows.
          // Limit cache cardinality and lifetime independently of source retention.
          const existing = await tx
            .select({ queryKey: schema.dataModelQuerySnapshots.queryKey })
            .from(schema.dataModelQuerySnapshots)
            .where(
              and(
                eq(
                  schema.dataModelQuerySnapshots.workspaceId,
                  actor.workspaceId,
                ),
                eq(schema.dataModelQuerySnapshots.releaseId, release.id),
              ),
            );
          if (
            !exceedsDataPolicy(
              existing.length + 1,
              policyFor(tx).querySnapshotCount,
            ) ||
            existing.some((s) => s.queryKey === queryKey)
          ) {
            const expiresAt = [...execution.loader.tables.values()].reduce(
              (expiry, table) =>
                table.expiresAt && new Date(table.expiresAt) < expiry
                  ? new Date(table.expiresAt)
                  : expiry,
              new Date(
                policyFor(tx).querySnapshotSeconds === null
                  ? "9999-12-31T23:59:59Z"
                  : now.getTime() + policyFor(tx).querySnapshotSeconds! * 1000,
              ),
            );
            await tx
              .insert(schema.dataModelQuerySnapshots)
              .values({
                workspaceId: actor.workspaceId,
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
                setWhere: eq(
                  schema.dataModelQuerySnapshots.workspaceId,
                  actor.workspaceId,
                ),
              });
          }
        }
        return execution.result;
      }),
  };
}
