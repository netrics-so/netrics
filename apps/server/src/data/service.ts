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
import { CUSTOM_API_CONNECTOR_ID } from "@netrics/connectors/custom-api";
import {
  sourceDatasetSchema,
  manualDatasetReadInputSchema,
  manualDatasetPageInputSchema,
  preparationGraphSchema,
  semanticModelDefinitionSchema,
  SOURCE_HISTORY_INCOMPLETE_WARNING,
  type DataImpact,
  type DataImpactTarget,
  type DataUsers,
  type SourceDatasetDefinition,
} from "@netrics/contracts";
import {
  can,
  type WorkspaceRole,
  DataProcessingError,
  DATA_EXECUTION_VERSION,
  ProcessingBudget,
  executePreparation,
  querySemanticModel,
  semanticModelFieldReferences,
  preparationFieldReferences,
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
  attributeDataError,
} from "@netrics/domain";
import {
  withWorkspace,
  schema,
  findProject,
  projectFilterSql,
  ingestDatasetPage,
  listObservationCatalog,
  readObservationDataset,
  insertAuditEvent,
  DatasetStoreError,
  hasSqlstate,
  isSerializationFailure,
  isTransactionHandle,
  retryOnSerializationFailure,
  resolveDataPolicy,
  sourceHistoryIncomplete,
  isPooledDatabase,
  processSessionLocks,
  SessionLockQueue,
  SessionLockTimeoutError,
  withSessionAdvisoryLock,
  type Database,
  type ProjectFilter,
  type TableLocks,
  type Transaction,
  notDraftConnection,
} from "@netrics/database";
import {
  collectDataImpact,
  collectDataUsers,
  loadImpactGraph,
  redactDataImpact,
} from "./impact.js";

export class DataServiceError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: 400 | 404 | 409 | 413 | 503 = 400,
    /** Id of the preparation step (PreparationNode.id) whose work failed. */
    public readonly nodeId?: string,
  ) {
    super(code);
    this.name = "DataServiceError";
  }
}
/**
 * Deleting a model (#671) waits for every transaction writing data_models,
 * and holds off new ones, before its snapshot. A dashboard save takes ROW
 * EXCLUSIVE on data_models before it checks shared-filter mappings
 * (lockModelsForMappings), which have no foreign key: so the delete's
 * check sees every mapping saved before it, and a save after it finds the
 * model gone. A row lock alone would not do: a serializable delete whose
 * snapshot predates the save's commit would still read the dashboards
 * without the new mapping. While the delete waits for its lock, Postgres
 * queues every later ROW EXCLUSIVE request on data_models behind it (model
 * saves, installs, dashboard saves with mappings, in every workspace), so
 * the wait is kept short: past 1 s the delete answers 409 version_conflict
 * and the customer tries again.
 */
export const MODEL_DELETE_LOCK = {
  tables: [schema.dataModels],
  mode: "share row exclusive",
  timeoutMs: 1_000,
} satisfies TableLocks;
/**
 * Takes ROW EXCLUSIVE on data_models, the lock every model write takes, so
 * a concurrent model delete (MODEL_DELETE_LOCK) runs entirely before or
 * after the caller's mapping checks. A read committed caller's next
 * statements see a delete that committed while it waited. A serializable
 * caller (createUpdatedDashboardCopy) may already hold an older snapshot;
 * then SSI fails it with 40001 instead of writing a mapping to a deleted
 * model, and its retry reads the model as gone.
 */
export async function lockModelsForMappings(tx: Transaction) {
  await tx.execute(sql`lock table ${schema.dataModels} in row exclusive mode`);
}
/** A preparation or model to delete is still used (409 data_in_use, #671). */
export class DataInUseError extends DataServiceError {
  constructor(readonly usedBy: DataUsers) {
    super("data_in_use", 409);
    this.name = "DataInUseError";
  }
}
/**
 * A conflict of a transaction that composes the data service (store
 * templates, compare measures): a serialization failure or deadlock, or the
 * version_conflict the composed service answers for one.
 */
export function isDataConflict(error: unknown): boolean {
  return (
    isSerializationFailure(error) ||
    (error instanceof DataServiceError && error.code === "version_conflict")
  );
}
/**
 * Retry policy for such transactions (#598): serialization failures with
 * the full backoff; a version_conflict, which may also be a lasting one
 * (the composed service answers it for stale versions too), as before only
 * twice more.
 */
export function isRetryableDataConflict(
  error: unknown,
  index: number,
): boolean {
  return isSerializationFailure(error) || (index < 2 && isDataConflict(error));
}
/**
 * `error` without the step id it names. Step ids are local to one graph, so
 * an error from an upstream preparation's graph must not leave it with one:
 * the consuming graph attributes it to its own source step, and model routes
 * report no step.
 */
function withoutStep(error: unknown): unknown {
  if (error instanceof DataProcessingError && error.nodeId !== undefined)
    return new DataProcessingError(error.code, error.fieldId);
  if (error instanceof DataServiceError && error.nodeId !== undefined)
    return new DataServiceError(error.code, error.status);
  return error;
}
const MAX_SNAPSHOT_EXPIRY = Date.parse("9999-12-31T23:59:59Z");
/**
 * Source-picker bound for the legacy observation catalog, independent of the
 * query row budget. A larger catalog is listed truncated, never refused.
 */
export const DATA_SOURCE_CATALOG_ENTRIES = 10_000;
const LEGACY_PAGE_KEY_PATTERN =
  "^page:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{64}$";
/** Longest wait for page-session admission when the policy has no query timeout. */
const PAGE_ADMISSION_WAIT_MS = 30_000;
function fail(code: string, status: 400 | 404 | 409 | 413 | 503 = 400): never {
  throw new DataServiceError(code, status);
}
/**
 * A dataset's newest generation, or the requested one: the generation every
 * reader of a dataset reads (callers decide what an expired one means).
 */
export async function currentGeneration(
  tx: Transaction,
  workspaceId: string,
  datasetId: string,
  requested?: string,
) {
  const [generation] = await tx
    .select()
    .from(schema.dataGenerations)
    .where(
      and(
        eq(schema.dataGenerations.workspaceId, workspaceId),
        eq(schema.dataGenerations.datasetId, datasetId),
        ...(requested ? [eq(schema.dataGenerations.id, requested)] : []),
      ),
    )
    .orderBy(desc(schema.dataGenerations.sequence))
    .limit(1);
  return generation;
}

/**
 * The records of a generation a reader may return: not past their stored
 * expiry and, under the policy's retention ceiling, collected within it.
 * The data loader, manual-table reads and bounded aggregates over records
 * (the store template's product identity) share it.
 */
export function readableRecords(
  workspaceId: string,
  generationId: string,
  now: Date,
  policy: Pick<DataPolicy, "maxRetentionDays">,
) {
  return and(
    eq(schema.dataRecords.workspaceId, workspaceId),
    eq(schema.dataRecords.generationId, generationId),
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
/**
 * The key a snapshot's generation map holds next to a source's pinned
 * generation when that source's history was incomplete as it was pinned
 * (#635). A pinned read says what the source was then, not what its
 * connection's backfill says now: a page session that started before the
 * backfill finished still lacks the history on its later pages. Never a
 * dataset id, so generation lookups and pin checks ignore it.
 */
const historyIncompletePin = (datasetId: string) =>
  "history_incomplete:" + datasetId;
/** The generation map a snapshot stores: the pins and their history marks. */
function snapshotGenerations(
  loader: {
    generations: Readonly<Record<string, string>>;
    historyIncomplete: ReadonlySet<string>;
  },
  generations: Record<string, string> = { ...loader.generations },
): Record<string, string> {
  for (const id of loader.historyIncomplete)
    if (generations[id]) generations[historyIncompletePin(id)] = "1";
  return generations;
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
/**
 * Custom API connections by id → name (#834): their datasets are named by
 * stream ("Records"), so the listing prefixes the connection's name to tell
 * two connections apart.
 */
async function customApiConnectionNames(
  tx: Transaction,
  workspaceId: string,
  connectionId?: string | null,
): Promise<Map<string, string>> {
  if (connectionId === null) return new Map();
  const rows = await tx
    .select({ id: schema.connections.id, name: schema.connections.name })
    .from(schema.connections)
    .where(
      and(
        eq(schema.connections.workspaceId, workspaceId),
        eq(schema.connections.connectorId, CUSTOM_API_CONNECTOR_ID),
        ...(connectionId ? [eq(schema.connections.id, connectionId)] : []),
      ),
    );
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** A dataset's name as listed: "<connection> · <stream>" for a custom API. */
function sourceName(
  dataset: { name: string; connectionId: string | null },
  customApiNames: ReadonlyMap<string, string>,
): string {
  const connection =
    dataset.connectionId === null
      ? undefined
      : customApiNames.get(dataset.connectionId);
  return connection ? `${connection} · ${dataset.name}` : dataset.name;
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
  /** Listed, but larger than the workspace query row budget can load. */
  rowLimitExceeded?: boolean;
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
    projectId: row.projectId,
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
    projectId: row.projectId,
    version: row.version,
    publishedVersion: row.publishedVersion,
    restoredFromVersion: row.restoredFromVersion,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * A prepared source's preparation and output, as the loader reads
 * "prepared:<id>:<output>"; null for any other source or a malformed one.
 */
function preparedSource(
  id: string,
): { preparationId: string; output: string } | null {
  if (!id.startsWith("prepared:")) return null;
  const parts = id.split(":");
  if (parts.length !== 3 || !z.uuid().safeParse(parts[1]).success) return null;
  return { preparationId: parts[1]!, output: parts[2]! };
}
function preparationSources(graph: unknown): string[] {
  return preparationGraphSchema
    .parse(graph)
    .nodes.flatMap((node) => (node.type === "source" ? [node.datasetId] : []));
}
function modelSources(definition: unknown): string[] {
  return semanticModelDefinitionSchema.parse(definition).datasets;
}
interface StoredRelease {
  content: unknown;
  dependencies: unknown;
}
/**
 * How a draft differs from its live release by content (#697): its
 * definition (the name is not part of a release), and the dependencies
 * publishing it would record, resolved by the loader's own code: a restored
 * draft starts from that release's pins, others read the current published
 * versions. So a republished input marks its readers, and a saved draft
 * equal to the release (every save bumps the version) is not marked.
 * Inputs that no longer resolve, or a missing release, count as changed.
 */
async function differsFromRelease(
  tx: Transaction,
  workspaceId: string,
  draft: { content: unknown; sources: readonly string[] },
  release: StoredRelease | undefined,
  /** The release the draft was restored from; null when not restored. */
  restored: StoredRelease | undefined | null,
  shared: Pick<SharedLoads, "preparations" | "versions">,
): Promise<{ definition: boolean; inputs: boolean }> {
  if (!release) return { definition: true, inputs: true };
  const definition = stable(draft.content) !== stable(release.content);
  if (restored === undefined) return { definition, inputs: true };
  let effective: Dependencies;
  try {
    effective = await resolveDependencies(
      tx,
      workspaceId,
      draft.sources,
      (restored?.dependencies as Dependencies | null) ?? undefined,
      shared,
    );
  } catch (error) {
    if (error instanceof DataServiceError) return { definition, inputs: true };
    throw error;
  }
  return {
    definition,
    inputs:
      stable(effective.prepared) !==
      stable((release.dependencies as Dependencies | null)?.prepared ?? {}),
  };
}
type DraftRow = {
  id: string;
  publishedVersion: number | null;
  restoredFromVersion: number | null;
};
/**
 * `hasUnpublishedChanges` for each draft: loads the live and restored
 * releases and the published versions of the preparations they read, in
 * one query each.
 */
async function unpublishedChanges(
  tx: Transaction,
  workspaceId: string,
  rows: readonly (DraftRow & { content: unknown; sources: string[] })[],
  loadReleases: (
    keys: [string, number][],
  ) => Promise<
    { id: string; version: number; content: unknown; dependencies: unknown }[]
  >,
): Promise<{ hasUnpublishedChanges: boolean; inputsDiffer: boolean }[]> {
  const keys = rows.flatMap((row): [string, number][] =>
    row.publishedVersion
      ? [
          [row.id, row.publishedVersion],
          ...(row.restoredFromVersion &&
          row.restoredFromVersion !== row.publishedVersion
            ? [[row.id, row.restoredFromVersion] as [string, number]]
            : []),
        ]
      : [],
  );
  const releases = new Map(
    (keys.length ? await loadReleases(keys) : []).map((r) => [
      r.id + ":" + r.version,
      r,
    ]),
  );
  // Preparation rows and versions, read once for the whole list.
  const shared = { preparations: new Map(), versions: new Map() };
  const changed: { hasUnpublishedChanges: boolean; inputsDiffer: boolean }[] =
    [];
  for (const row of rows) {
    const differs = row.publishedVersion
      ? await differsFromRelease(
          tx,
          workspaceId,
          row,
          releases.get(row.id + ":" + row.publishedVersion),
          row.restoredFromVersion
            ? releases.get(row.id + ":" + row.restoredFromVersion)
            : null,
          shared,
        )
      : { definition: false, inputs: false };
    changed.push({
      hasUnpublishedChanges: differs.definition || differs.inputs,
      inputsDiffer: differs.inputs,
    });
  }
  return changed;
}
async function preparationViews(
  tx: Transaction,
  workspaceId: string,
  rows: (typeof schema.dataPreparations.$inferSelect)[],
) {
  const t = schema.dataPreparationVersions;
  const changed = await unpublishedChanges(
    tx,
    workspaceId,
    rows.map((row) => ({
      ...row,
      content: row.graph,
      sources: row.publishedVersion ? preparationSources(row.graph) : [],
    })),
    (keys) =>
      tx
        .select({
          id: t.preparationId,
          version: t.version,
          content: t.graph,
          dependencies: t.dependencies,
        })
        .from(t)
        .where(
          and(
            eq(t.workspaceId, workspaceId),
            or(
              ...keys.map(([id, version]) =>
                and(eq(t.preparationId, id), eq(t.version, version)),
              ),
            ),
          ),
        ),
  );
  return rows.map((row, i) => ({
    ...preparationView(row),
    ...changed[i]!,
  }));
}
async function modelViews(
  tx: Transaction,
  workspaceId: string,
  rows: (typeof schema.dataModels.$inferSelect)[],
) {
  const t = schema.dataModelReleases;
  const changed = await unpublishedChanges(
    tx,
    workspaceId,
    rows.map((row) => ({
      ...row,
      content: row.definition,
      sources: row.publishedVersion ? modelSources(row.definition) : [],
    })),
    (keys) =>
      tx
        .select({
          id: t.modelId,
          version: t.version,
          content: t.definition,
          dependencies: t.dependencies,
        })
        .from(t)
        .where(
          and(
            eq(t.workspaceId, workspaceId),
            or(
              ...keys.map(([id, version]) =>
                and(eq(t.modelId, id), eq(t.version, version)),
              ),
            ),
          ),
        ),
  );
  return rows.map((row, i) => ({
    ...modelView(row),
    ...changed[i]!,
  }));
}
/**
 * A view straight after publishing: the draft is its live release, read
 * through the inputs just pinned, so it differs in neither definition nor
 * inputs. Spares the publish path the resolution the lists run (#697).
 */
function publishedView<T extends object>(
  view: T,
): T & { hasUnpublishedChanges: boolean; inputsDiffer: boolean } {
  return { ...view, hasUnpublishedChanges: false, inputsDiffer: false };
}
async function preparationViewIn(
  tx: Transaction,
  workspaceId: string,
  row: typeof schema.dataPreparations.$inferSelect,
) {
  return (await preparationViews(tx, workspaceId, [row]))[0]!;
}
async function modelViewIn(
  tx: Transaction,
  workspaceId: string,
  row: typeof schema.dataModels.$inferSelect,
) {
  return (await modelViews(tx, workspaceId, [row]))[0]!;
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
) {
  for (const [source, fields] of Object.entries(pinned)) {
    const nextFields = actual[source];
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

/** Draft edits retain historical meaning only for fields still affecting this model. */
function checkRestoredModelBindings(
  pinned: Record<string, DataField[]>,
  loader: ReturnType<typeof createDataLoader>,
  definition: SemanticModelDefinition,
): void {
  const required = semanticModelFieldReferences(definition);
  const processed = new Map<string, Set<string>>();
  const pending = [...required.keys()];
  while (pending.length) {
    const source = pending.shift()!;
    const fields = required.get(source)!;
    const previous = processed.get(source);
    // Money metadata is an implicit input, including for a newly added field.
    // Both schemas matter: a changed companion identity must not hide the old pin.
    for (const id of fields)
      for (const schema of [pinned[source], loader.bindings[source]]) {
        const currency = schema?.find(
          (field) => field.id === id,
        )?.currencyField;
        if (currency) fields.add(currency);
      }
    if (
      previous &&
      fields.size === previous.size &&
      [...fields].every((field) => previous.has(field))
    )
      continue;
    processed.set(source, new Set(fields));
    const oldFields = pinned[source];
    const actual = loader.bindings[source];
    if (oldFields) {
      if (!actual) fail("data_model_schema_changed", 409);
      for (const field of oldFields) {
        if (!fields.has(field.id)) continue;
        const current = actual.find((candidate) => candidate.id === field.id);
        if (
          !current ||
          current.type !== field.type ||
          current.unit !== field.unit ||
          current.currencyField !== field.currencyField
        )
          fail("data_model_schema_changed", 409);
      }
    }
    const prepared = loader.preparedSources.get(source);
    if (!prepared) {
      // Every loaded prepared output must retain its exact historical graph,
      // whether its values were rebuilt or came from the prepared cache.
      if (actual && source.startsWith("prepared:"))
        fail("data_model_schema_changed", 409);
      continue;
    }
    let inputs: ReturnType<typeof preparationFieldReferences>;
    try {
      inputs = preparationFieldReferences(
        prepared.graph,
        loader.tables,
        prepared.outputId,
        fields,
        loader.budget,
      );
    } catch (error) {
      throw withoutStep(error);
    }
    for (const [input, dependencies] of inputs) {
      const existing = required.get(input);
      if (!existing) {
        required.set(input, new Set(dependencies));
        pending.push(input);
      } else {
        let changed = false;
        for (const field of dependencies)
          if (!existing.has(field)) {
            existing.add(field);
            changed = true;
          }
        if (changed) pending.push(input);
      }
    }
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
        notDraftConnection(),
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
  const generationId =
    "resources:" + createHash("sha256").update(stable(rows)).digest("hex");
  const view = resourceView(connectionId, connection.name, {
    generationId,
    rowCount: rows.length,
  });
  const table: DataTable = {
    fields: view.fields,
    rows,
    provenance: [{ datasetId: view.id, generationId }],
  };
  return { table, view };
}
function resourceView(
  connectionId: string,
  connectionName: string,
  state: Pick<SourceView, "generationId" | "rowCount" | "rowLimitExceeded">,
): SourceView {
  return {
    id: "resources:" + connectionId,
    name: connectionName + " / Resources",
    kind: "resources",
    fields: RESOURCE_FIELDS.map((field) => ({ ...field })),
    schemaVersion: 1,
    aggregated: false,
    expiresAt: null,
    connectionId,
    ...state,
  };
}

/** One loader per serializable transaction pins each source generation once. */
/**
 * The typed fields of a legacy observation dataset: amounts per currency
 * are integers in minor units bound to their `currency` dimension, other
 * values carry the metric's unit.
 */
export function observationFields(dataset: {
  unit: string;
  definition: { fields: readonly DataField[] };
}): DataField[] {
  const fields: DataField[] = dataset.definition.fields.map((f) => ({ ...f }));
  if (dataset.unit === "currency_minor") {
    const amount = fields.find((f) => f.id === "value")!,
      currency = fields.find((f) => f.name === "currency");
    if (currency) {
      amount.type = "integer";
      amount.unit = "currency_minor";
      amount.currencyField = currency.id;
      currency.nullable = false;
    }
  } else {
    fields.find((f) => f.id === "value")!.unit = dataset.unit;
  }
  return fields;
}

/**
 * The version a prepared source reads, as loading it does: an override, the
 * pin already recorded, or the preparation's published version. Records it
 * and the pins of that version in `dependencies` (#697: shared by the
 * loader and `resolveDependencies`, so both pin alike).
 */
async function resolvePreparedSource(
  tx: Transaction,
  workspaceId: string,
  id: string,
  dependencies: Dependencies,
  options: {
    overrides?: Map<string, { version: number; graph: PreparationGraph }>;
    shared?: Pick<SharedLoads, "preparations" | "versions">;
  },
) {
  const prepared = preparedSource(id);
  if (!prepared) fail("data_source_not_found", 404);
  const { preparationId, output } = prepared;
  const [parent] = options.shared?.preparations.has(preparationId)
    ? [options.shared.preparations.get(preparationId)!]
    : await tx
        .select()
        .from(schema.dataPreparations)
        .where(
          and(
            eq(schema.dataPreparations.workspaceId, workspaceId),
            eq(schema.dataPreparations.id, preparationId),
          ),
        );
  if (!parent) fail("data_source_not_found", 404);
  options.shared?.preparations.set(preparationId, parent);
  const override = options.overrides?.get(preparationId);
  const version =
    override?.version ??
    dependencies.prepared[preparationId] ??
    parent.publishedVersion;
  if (!version) fail("data_source_not_published", 409);
  const versionKey = preparationId + ":" + version;
  const [published] = override
    ? []
    : options.shared?.versions.has(versionKey)
      ? [options.shared.versions.get(versionKey)!]
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
  // Versions are immutable (UPDATE is revoked).
  if (published) options.shared?.versions.set(versionKey, published);
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
  return { preparationId, output, version, graph, override, parent };
}
/**
 * The dependencies publishing `sources` would record, without loading any
 * data: the loader's resolution of each prepared source, in the order
 * publishing loads them, into the sources of the versions they read.
 * `pins` are a restored release's (#697).
 */
async function resolveDependencies(
  tx: Transaction,
  workspaceId: string,
  sources: readonly string[],
  pins: Dependencies | undefined,
  shared: Pick<SharedLoads, "preparations" | "versions">,
): Promise<Dependencies> {
  const dependencies: Dependencies = { prepared: { ...pins?.prepared } };
  // As the loader: a source resolved once is done; `visiting` is the chain
  // being resolved, with the loader's cycle check and depth limit.
  const resolved = new Set<string>(),
    visiting = new Set<string>();
  const visit = async (id: string): Promise<void> => {
    if (!id.startsWith("prepared:") || resolved.has(id)) return;
    if (visiting.has(id) || visiting.size >= 20) fail("data_dependency_cycle");
    visiting.add(id);
    const { graph } = await resolvePreparedSource(
      tx,
      workspaceId,
      id,
      dependencies,
      { shared },
    );
    for (const node of graph.nodes)
      if (node.type === "source") await visit(node.datasetId);
    visiting.delete(id);
    resolved.add(id);
  };
  for (const source of sources) await visit(source);
  return dependencies;
}
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
    /** Last-valid fallback only: resource catalogs are current metadata with
     * no retained history, so a changed catalog fingerprint reads the current
     * catalog instead of refusing the pinned vector. Page continuations keep
     * the strict check. */
    currentResources?: boolean;
    /**
     * Loads shared with the other loaders of a batch (#668): source loads
     * (not prepared outputs), replayed while their rows are unexpired, never
     * for a pinned generation; and the preparation rows prepared outputs
     * read. The batch keeps them current (see createDataService).
     */
    shared?: SharedLoads;
    /**
     * A loader of the same transaction whose loads this one starts with: a
     * publication reads its new output through the inputs it just loaded
     * instead of loading them again (#668).
     */
    seed?: LoaderState;
  } = {},
) {
  const seed = options.seed;
  const tables = new Map<string, DataTable>(seed?.tables),
    preparedSources = new Map<
      string,
      { graph: PreparationGraph; outputId: string }
    >(seed?.preparedSources),
    views = new Map<string, SourceView>(seed?.views),
    visiting = new Set<string>();
  const dependencies: Dependencies = {
    prepared: { ...(options.dependencies?.prepared ?? {}) },
  };
  const generations: Record<string, string> = { ...seed?.generations };
  const bindings: Record<string, DataField[]> = { ...seed?.bindings };
  const warnings = new Set<string>(seed?.warnings);
  /** Sources whose connection's history is incomplete (#635). */
  const historyIncompleteSources = new Set<string>(seed?.historyIncomplete);
  const policy = options.policy ?? { ...DEFAULT_DATA_POLICY };
  const budget = new ProcessingBudget(policy.queryOperations, {
    rows: policy.queryRows,
    outputBytes: policy.queryOutputBytes,
  });
  const shareable = (id: string) =>
    options.shared && !id.startsWith("prepared:") && !options.generations?.[id]
      ? options.shared.sources
      : undefined;
  /**
   * Records a source load for the other loaders of the batch, with the
   * warnings of this source itself: not what the load added to this
   * loader's set, which may already hold them from another source.
   */
  const share = (
    id: string,
    table: DataTable,
    historyIncomplete = false,
    backfillIncomplete = false,
  ) =>
    shareable(id)?.set(id, {
      table,
      view: views.get(id)!,
      generationId: generations[id],
      warnings: [
        ...(table.pendingSources?.length ? ["data_source_pending"] : []),
        ...(historyIncomplete ? ["retained_source_history_incomplete"] : []),
        ...(backfillIncomplete ? [SOURCE_HISTORY_INCOMPLETE_WARNING] : []),
      ],
    });
  const load = async (id: string): Promise<DataTable> => {
    const cached = tables.get(id);
    if (cached) return cached;
    if (visiting.has(id) || visiting.size >= 20) fail("data_dependency_cycle");
    const shared = shareable(id)?.get(id);
    if (
      shared &&
      (!shared.table.pendingSources?.length ||
        options.allowPendingSchemas ||
        options.allowPendingResults) &&
      (!shared.table.expiresAt || new Date(shared.table.expiresAt) > now)
    ) {
      validateDataTable(shared.table, budget);
      shared.warnings.forEach((warning) => warnings.add(warning));
      if (shared.warnings.includes(SOURCE_HISTORY_INCOMPLETE_WARNING))
        historyIncompleteSources.add(id);
      if (shared.generationId) generations[id] = shared.generationId;
      views.set(id, shared.view);
      bindings[id] = shared.table.fields;
      tables.set(id, shared.table);
      return shared.table;
    }
    let historyIncomplete = false,
      backfillIncomplete = false;
    visiting.add(id);
    let result: DataTable;
    if (id.startsWith("prepared:")) {
      const { preparationId, output, version, graph, override, parent } =
        await resolvePreparedSource(tx, workspaceId, id, dependencies, options);
      preparedSources.set(id, { graph, outputId: output });
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
        let execution: ReturnType<typeof executePreparation>;
        try {
          execution = executePreparation(graph, inputs, budget);
        } catch (error) {
          throw withoutStep(error);
        }
        execution.warnings.forEach((w) => warnings.add(w));
        result = execution.outputs[output]!;
        if (!override && !warnings.has("data_source_pending")) {
          const byteSize = Buffer.byteLength(JSON.stringify(execution.outputs));
          // The immutable key remains unique after its cache deadline. Reclaim
          // only this expired entry before rebuilding the same input vector.
          // Concurrent readers may build the same entry; one of them caches it
          // and the others return their equal result uncached.
          const stored = await cacheWrite(tx, async (tx) => {
            await tx
              .delete(schema.dataPreparedGenerations)
              .where(
                and(
                  eq(schema.dataPreparedGenerations.workspaceId, workspaceId),
                  eq(
                    schema.dataPreparedGenerations.preparationId,
                    preparationId,
                  ),
                  eq(schema.dataPreparedGenerations.version, version),
                  eq(schema.dataPreparedGenerations.inputKey, inputKey),
                  lte(schema.dataPreparedGenerations.expiresAt, now),
                ),
              );
            const usage =
              policy.maxPreparedBytes === null
                ? undefined
                : await preparedWorkspaceBytes(tx, workspaceId);
            if (
              !exceedsDataPolicy(byteSize, policy.maxPreparedGenerationBytes) &&
              !exceedsDataPolicy(
                (usage ?? 0) + byteSize,
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
              return created!.id;
            }
            return "capacity" as const;
          });
          if (stored === "capacity")
            warnings.add("prepared_cache_capacity_reached");
          else if (stored) preparedGenerationId = stored;
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
        options.generations[id] !== generations[id] &&
        !options.currentResources
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
      const fields = observationFields(read.dataset);
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
      const generation = await currentGeneration(
        tx,
        workspaceId,
        id,
        requested,
      );
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
          name: sourceName(
            dataset,
            await customApiConnectionNames(
              tx,
              workspaceId,
              dataset.connectionId,
            ),
          ),
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
        share(id, pending);
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
        .where(readableRecords(workspaceId, generation.id, now, policy))
        .orderBy(asc(schema.dataRecords.recordKey));
      const records = await (policy.queryRows === null
        ? recordQuery
        : recordQuery.limit(policy.queryRows + 1));
      if (exceedsDataPolicy(records.length, policy.queryRows))
        fail("data_source_row_limit", 413);
      if (records.length !== generation.rowCount) {
        if (requested) fail("data_snapshot_expired", 409);
        warnings.add("retained_source_history_incomplete");
        historyIncomplete = true;
      }
      // A connection's history still loading or not read by a backfill
      // yet (#635): earlier days may be missing, not zero. A pinned
      // generation is as incomplete as it was when it was pinned.
      if (
        dataset.kind === "source" &&
        dataset.connectionId &&
        (requested
          ? options.generations?.[historyIncompletePin(id)] !== undefined
          : await sourceHistoryIncomplete(tx, {
              workspaceId,
              connectionId: dataset.connectionId,
              key: dataset.key,
              schemaVersion: generation.schemaVersion,
            }))
      ) {
        warnings.add(SOURCE_HISTORY_INCOMPLETE_WARNING);
        historyIncompleteSources.add(id);
        backfillIncomplete = true;
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
        name: sourceName(
          dataset,
          await customApiConnectionNames(tx, workspaceId, dataset.connectionId),
        ),
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
    share(id, result, historyIncomplete, backfillIncomplete);
    return result;
  };
  return {
    load,
    tables,
    preparedSources,
    views,
    dependencies,
    generations,
    bindings,
    warnings,
    historyIncomplete: historyIncompleteSources,
    budget,
  };
}

/** What a loader has loaded; a later loader can start with it. */
interface LoaderState {
  tables: ReadonlyMap<string, DataTable>;
  preparedSources: ReadonlyMap<
    string,
    { graph: PreparationGraph; outputId: string }
  >;
  views: ReadonlyMap<string, SourceView>;
  generations: Readonly<Record<string, string>>;
  bindings: Readonly<Record<string, DataField[]>>;
  warnings: ReadonlySet<string>;
  historyIncomplete?: ReadonlySet<string>;
}
/** Loads shared by the loaders of one batch (#668). */
export interface SharedLoads {
  sources: Map<
    string,
    {
      table: DataTable;
      view: SourceView;
      generationId: string | undefined;
      warnings: string[];
    }
  >;
  preparations: Map<string, typeof schema.dataPreparations.$inferSelect>;
  versions: Map<string, typeof schema.dataPreparationVersions.$inferSelect>;
}

/** The status of a dataset-store error: conflict 409, quota or limit 413. */
export function datasetStoreStatus(code: string): 400 | 409 | 413 {
  return code.includes("conflict")
    ? 409
    : code.includes("quota") || code.includes("limit")
      ? 413
      : 400;
}

export function createDataService(
  db: Pick<Database, "transaction">,
  clock: () => Date = () => new Date(),
  defaults: DataPolicy = { ...DEFAULT_DATA_POLICY },
  /** In-memory queue for page-session admission; one per process by default. */
  pageAdmissions: SessionLockQueue = processSessionLocks,
  options: {
    /**
     * Many calls composed into one caller transaction, for one actor (a
     * template install, #668). `db` must be that transaction. The workspace
     * context, data policy and statement timeout are set by the first call
     * only, later calls run without a savepoint of their own (any failure
     * fails the caller's transaction, as a conflict already does), and
     * loaders share their source loads until a manual save changes a source.
     */
    batch?: boolean;
  } = {},
) {
  if (options.batch && !isTransactionHandle(db))
    throw new Error("a batch data service runs in a caller's transaction");
  const policies = new WeakMap<Transaction, DataPolicy>();
  const policyFor = (tx: Transaction) => policies.get(tx)!;
  let batch: { actor: DataActor; shared: SharedLoads } | undefined;
  const loadFor: typeof createDataLoader = (
    tx,
    workspaceId,
    now,
    loaderOptions = {},
  ) =>
    createDataLoader(tx, workspaceId, now, {
      ...loaderOptions,
      ...(batch ? { shared: batch.shared } : {}),
      policy: policyFor(tx),
    });
  /** Sources changed: later loads read them again. */
  const sourcesChanged = () => batch?.shared.sources.clear();
  /** A preparation row changed: later loads read it again. */
  const preparationChanged = (id: string) =>
    batch?.shared.preparations.delete(id);
  /**
   * Runs `fn` in a workspace transaction on `handle`, serializable unless
   * `isolationLevel` says otherwise, retrying serialization failures and
   * deadlocks with jittered backoff (#598). On a transaction handle (a
   * service composed into a caller's transaction) it runs once: the failure
   * dooms the caller's transaction, whose own retry starts over.
   */
  const run = async <T>(
    actor: DataActor,
    fn: (tx: Transaction, now: Date) => Promise<T>,
    handle: Pick<Database, "transaction"> = db,
    isolationLevel: "serializable" | "read committed" = "serializable",
    /** Table locks taken before the snapshot (withWorkspace lockTables). */
    lockTables?: TableLocks,
  ): Promise<T> => {
    // Locks taken before the snapshot need a transaction of their own: a
    // batch or a caller's transaction already has its snapshot, so the
    // lock would come too late and protect nothing (#671).
    if (lockTables && (options.batch || isTransactionHandle(handle)))
      throw new Error(
        "table locks before the snapshot need a transaction of their own",
      );
    if (
      batch &&
      (batch.actor.workspaceId !== actor.workspaceId ||
        batch.actor.callerId !== actor.callerId)
    )
      throw new Error("a batch data service serves one actor");
    try {
      if (options.batch && handle === db) {
        const tx = db as Transaction;
        if (!batch) {
          await withWorkspace(
            tx,
            { workspaceId: actor.workspaceId, userId: actor.callerId },
            async (context) => {
              const { policy } = await resolveDataPolicy(
                context,
                actor.workspaceId,
                defaults,
              );
              policies.set(tx, policy);
              await context.execute(
                sql`select set_config('statement_timeout', ${String(policy.queryTimeoutMs ?? 0)}, true)`,
              );
            },
          );
          batch = {
            actor,
            shared: {
              sources: new Map(),
              preparations: new Map(),
              versions: new Map(),
            },
          };
        }
        return await fn(tx, clock());
      }
      return await retryOnSerializationFailure(
        () =>
          withWorkspace(
            handle,
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
            { isolationLevel, ...(lockTables ? { lockTables } : {}) },
          ),
        isTransactionHandle(handle) ? { attempts: 1 } : {},
      );
    } catch (error) {
      // Before the store's codes: an exhausted conflict is a conflict, also
      // when the dataset store redacted it to dataset_storage_failed.
      // A composed service leaves it to the caller's retry as it is.
      if (isSerializationFailure(error)) {
        if (isTransactionHandle(handle)) throw error;
        fail("version_conflict", 409);
      }
      if (
        error instanceof DataServiceError ||
        error instanceof DataProcessingError
      )
        throw error;
      if (error instanceof DatasetStoreError)
        fail(error.code, datasetStoreStatus(error.code));
      if (hasSqlstate(error, "23505")) fail("version_conflict", 409);
      // A table lock not granted in time (lockTables): busy, try again.
      if (hasSqlstate(error, "55P03")) fail("version_conflict", 409);
      return fail("data_storage_failed", 503);
    }
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
  const listSources = (actor: DataActor, filter: ProjectFilter = {}) =>
    run(actor, async (tx, now) => {
      const items: SourceView[] = [];
      const roots = await tx
        .select()
        .from(schema.dataDatasets)
        .where(eq(schema.dataDatasets.workspaceId, actor.workspaceId))
        .orderBy(asc(schema.dataDatasets.createdAt));
      const customApiNames = await customApiConnectionNames(
        tx,
        actor.workspaceId,
      );
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
          name: sourceName(d, customApiNames),
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
      // Listing counts resource names instead of loading them, so one
      // oversized catalog is flagged rather than failing the whole picker.
      const namedConnections = await tx
        .select({
          id: schema.connectionResources.connectionId,
          name: schema.connections.name,
          rows: sql<number>`count(*)::int`,
        })
        .from(schema.connectionResources)
        .innerJoin(
          schema.connections,
          and(
            eq(schema.connections.id, schema.connectionResources.connectionId),
            eq(
              schema.connections.workspaceId,
              schema.connectionResources.workspaceId,
            ),
          ),
        )
        .where(eq(schema.connectionResources.workspaceId, actor.workspaceId))
        .groupBy(
          schema.connectionResources.connectionId,
          schema.connections.name,
        )
        .orderBy(asc(schema.connectionResources.connectionId));
      for (const connection of namedConnections) {
        const rowCount = Number(connection.rows);
        items.push(
          resourceView(connection.id, connection.name, {
            generationId: null,
            rowCount,
            ...(exceedsDataPolicy(rowCount, policyFor(tx).queryRows)
              ? { rowLimitExceeded: true }
              : {}),
          }),
        );
      }
      const legacyCatalog = await listObservationCatalog(
        tx,
        actor.workspaceId,
        DATA_SOURCE_CATALOG_ENTRIES,
      );
      for (const legacy of legacyCatalog.entries)
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
      return {
        sources: await filterSourcesByProject(
          tx,
          actor.workspaceId,
          items,
          new Map(prepared.map(({ parent }) => [parent.id, parent.projectId])),
          filter,
        ),
        ...(legacyCatalog.truncated ? { truncated: true } : {}),
      };
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

  /**
   * A project a data item may be assigned to: one of this workspace's
   * unarchived projects. Unknown, another workspace's and archived projects
   * answer alike (no existence oracle).
   */
  const assignableProject = async (
    tx: Transaction,
    workspaceId: string,
    projectId: string,
  ) => {
    const project = await findProject(tx, workspaceId, projectId);
    if (!project || project.archivedAt !== null) fail("project_not_found", 404);
    return project.id;
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
        try {
          inputs.set(n.datasetId, await loader.load(n.datasetId));
        } catch (error) {
          if (error instanceof DataServiceError && error.nodeId === undefined)
            throw new DataServiceError(error.code, error.status, n.id);
          throw attributeDataError(error, n.id);
        }
    const output = executePreparation(graph, inputs, loader.budget);
    return { loader, output };
  };
  /**
   * Moves a preparation or model to a project, or to none (#572). Metadata
   * only: version, publishedVersion and updatedAt stay, so no draft is
   * created and published dashboards and screens show the same data.
   */
  const setProject = (
    actor: DataActor,
    kind: "preparation" | "model",
    id: string,
    projectId: string | null,
  ) =>
    run(actor, async (tx) => {
      const current =
        kind === "preparation"
          ? await findPreparation(tx, actor.workspaceId, id, true)
          : await findDataModel(tx, actor.workspaceId, id, true);
      // The current project needs no check, so a no-op move to a project
      // archived since still answers 200.
      const target =
        projectId === null || projectId === current.projectId
          ? projectId
          : await assignableProject(tx, actor.workspaceId, projectId);
      if (current.projectId !== target)
        await audit(tx, actor, `data.${kind}_project_changed`, id, {
          from: current.projectId,
          to: target,
        });
      if (kind === "preparation") {
        preparationChanged(id);
        const [row] = await tx
          .update(schema.dataPreparations)
          .set({ projectId: target })
          .where(
            and(
              eq(schema.dataPreparations.workspaceId, actor.workspaceId),
              eq(schema.dataPreparations.id, id),
            ),
          )
          .returning();
        return {
          preparation: await preparationViewIn(tx, actor.workspaceId, row!),
        };
      }
      const [row] = await tx
        .update(schema.dataModels)
        .set({ projectId: target })
        .where(
          and(
            eq(schema.dataModels.workspaceId, actor.workspaceId),
            eq(schema.dataModels.id, id),
          ),
        )
        .returning();
      return { model: await modelViewIn(tx, actor.workspaceId, row!) };
    });
  /**
   * What depends on a preparation, model or some of a model's measures
   * (11C), for the publish confirmation. Workspace-wide: an item's project
   * never hides a consequence. Lists what the caller may open and counts
   * the rest. Never blocks publishing.
   */
  const impact = (
    actor: DataActor & { role: WorkspaceRole },
    target: DataImpactTarget,
  ) =>
    // A read-only scan: read committed, so it never forces serialization
    // retries on concurrent writers.
    run(
      actor,
      async (tx): Promise<DataImpact> => {
        if (target.kind === "preparation")
          await findPreparation(tx, actor.workspaceId, target.id);
        else {
          const model = await findDataModel(tx, actor.workspaceId, target.id);
          if (target.kind === "measure") {
            const definition = semanticModelDefinitionSchema.safeParse(
              model.definition,
            );
            if (
              target.measureIds.some(
                (id) => !definition.data?.measures.some((m) => m.id === id),
              )
            )
              fail("data_measure_not_found", 404);
          }
        }
        const graph = await loadImpactGraph(tx, actor.workspaceId);
        return redactDataImpact(collectDataImpact(graph, target), {
          data: can(actor.role, "data:edit"),
          dashboards: can(actor.role, "dashboards:view"),
          screens: can(actor.role, "devices:view"),
        });
      },
      db,
      "read committed",
    );
  /**
   * The store-template installs `id` belongs to (#671): a record of the
   * install that is not detached, of an install whose dashboard still
   * exists, or a draft of the install's open update. An install whose
   * dashboard was deleted shows nothing any more, and its next update
   * builds a record deleted since anew where the template still builds it
   * (store-template-updates.ts, computePlan); without that exception a
   * template item could never be deleted, as installs are never removed.
   */
  const templateUsers = async (
    tx: Transaction,
    workspaceId: string,
    kind: "preparation" | "model",
    id: string,
  ) => {
    const records = schema.dataTemplateRecords,
      installs = schema.dataTemplateInstalls,
      updates = schema.dataTemplateUpdates;
    const tracked = await tx
      .select({ requestId: records.requestId })
      .from(records)
      .where(
        and(
          eq(records.workspaceId, workspaceId),
          eq(records.recordId, id),
          eq(records.kind, kind),
          isNull(records.detachedAt),
        ),
      );
    const drafting = await tx
      .select({ requestId: updates.requestId })
      .from(updates)
      .where(
        and(
          eq(updates.workspaceId, workspaceId),
          isNull(updates.closedAt),
          sql`${updates.drafts} @> ${JSON.stringify([{ recordId: id }])}::jsonb`,
        ),
      );
    const requestIds = [
      ...new Set([...tracked, ...drafting].map((row) => row.requestId)),
    ];
    if (!requestIds.length) return [];
    const rows = await tx
      .select({
        requestId: installs.requestId,
        inputs: installs.inputs,
        dashboardName: schema.dashboards.name,
      })
      .from(installs)
      .leftJoin(
        records,
        and(
          eq(records.workspaceId, installs.workspaceId),
          eq(records.requestId, installs.requestId),
          eq(records.kind, "dashboard"),
          isNull(records.detachedAt),
        ),
      )
      .leftJoin(
        schema.dashboards,
        and(
          eq(schema.dashboards.workspaceId, workspaceId),
          eq(schema.dashboards.id, records.recordId),
        ),
      )
      .where(
        and(
          eq(installs.workspaceId, workspaceId),
          inArray(installs.requestId, requestIds),
        ),
      );
    const drafted = new Set(drafting.map((row) => row.requestId));
    const used = new Map<string, string>();
    for (const row of rows) {
      if (row.dashboardName === null && !drafted.has(row.requestId)) continue;
      const inputs = row.inputs as { name?: unknown } | null;
      used.set(
        row.requestId,
        row.dashboardName ??
          used.get(row.requestId) ??
          (typeof inputs?.name === "string" ? inputs.name : ""),
      );
    }
    return [...used]
      .map(([requestId, name]) => ({ requestId, name }))
      .sort((a, b) =>
        a.name < b.name
          ? -1
          : a.name > b.name
            ? 1
            : a.requestId < b.requestId
              ? -1
              : 1,
      );
  };
  /**
   * Deletes a preparation or model with its versions or releases and
   * drafts (#671); the prepared-output cache and query snapshots go with
   * them (cascade). Refused (409 data_in_use) while anything uses it,
   * naming what does. Items of archived projects can be deleted too.
   */
  const remove = (
    actor: DataActor & { role: WorkspaceRole },
    kind: "preparation" | "model",
    id: string,
  ) =>
    run(
      actor,
      async (tx) => {
        const row =
          kind === "preparation"
            ? await findPreparation(tx, actor.workspaceId, id, true)
            : await findDataModel(tx, actor.workspaceId, id, true);
        // Widgets the impact graph cannot read (a binding that no longer
        // parses) still hold the model's foreign key.
        const unreadable =
          kind === "model"
            ? await tx
                .select({ dashboardId: schema.dashboardWidgets.dashboardId })
                .from(schema.dashboardWidgets)
                .where(
                  and(
                    eq(schema.dashboardWidgets.workspaceId, actor.workspaceId),
                    eq(schema.dashboardWidgets.modelId, id),
                  ),
                )
            : [];
        const users = collectDataUsers(
          await loadImpactGraph(tx, actor.workspaceId),
          { kind, id },
          unreadable.map((widget) => widget.dashboardId),
        );
        const storeTemplates = await templateUsers(
          tx,
          actor.workspaceId,
          kind,
          id,
        );
        if (
          users.preparations.length ||
          users.models.length ||
          users.dashboards.length ||
          storeTemplates.length
        ) {
          const data = can(actor.role, "data:edit"),
            dashboards = can(actor.role, "dashboards:view");
          throw new DataInUseError({
            preparations: data ? users.preparations : [],
            models: data ? users.models : [],
            dashboards: dashboards ? users.dashboards : [],
            storeTemplates: dashboards ? storeTemplates : [],
            hidden: {
              preparations: data ? 0 : users.preparations.length,
              models: data ? 0 : users.models.length,
              dashboards: dashboards
                ? 0
                : users.dashboards.length + storeTemplates.length,
            },
          });
        }
        if (kind === "preparation") preparationChanged(id);
        try {
          if (kind === "preparation")
            await tx
              .delete(schema.dataPreparations)
              .where(
                and(
                  eq(schema.dataPreparations.workspaceId, actor.workspaceId),
                  eq(schema.dataPreparations.id, id),
                ),
              );
          else
            await tx
              .delete(schema.dataModels)
              .where(
                and(
                  eq(schema.dataModels.workspaceId, actor.workspaceId),
                  eq(schema.dataModels.id, id),
                ),
              );
        } catch (error) {
          // A widget saved concurrently holds the model's foreign key: a
          // conflict, and the next try names it.
          if (hasSqlstate(error, "23503")) fail("version_conflict", 409);
          throw error;
        }
        await audit(tx, actor, `data.${kind}_deleted`, id, {
          name: row.name,
          publishedVersion: row.publishedVersion,
        });
      },
      db,
      "serializable",
      kind === "model" ? MODEL_DELETE_LOCK : undefined,
    );
  return {
    listSources,
    setProject,
    impact,
    remove,
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
          checkRestoredModelBindings(
            restored.schemaBindings as Record<string, DataField[]>,
            loader,
            parsed,
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
        const generation = await currentGeneration(
          tx,
          actor.workspaceId,
          id,
          input.generationId,
        );
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
        const eligible = readableRecords(
          actor.workspaceId,
          generation.id,
          now,
          policy,
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
        sourcesChanged();
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
        sourcesChanged();
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
    listPreparations: (actor: DataActor, filter: ProjectFilter = {}) =>
      run(actor, async (tx) => ({
        preparations: await preparationViews(
          tx,
          actor.workspaceId,
          await tx
            .select()
            .from(schema.dataPreparations)
            .where(
              and(
                eq(schema.dataPreparations.workspaceId, actor.workspaceId),
                projectFilterSql(
                  schema.dataPreparations.projectId,
                  actor.workspaceId,
                  filter,
                ),
              ),
            )
            .orderBy(asc(schema.dataPreparations.name)),
        ),
      })),
    getPreparation: (actor: DataActor, id: string) =>
      run(actor, async (tx) => ({
        preparation: await preparationViewIn(
          tx,
          actor.workspaceId,
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
        preparationChanged(id);
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
        return {
          preparation: await preparationViewIn(tx, actor.workspaceId, updated!),
        };
      }),
    savePreparation: (
      actor: DataActor,
      input: {
        name: string;
        graph: PreparationGraph;
        version?: number;
        adoptLatestInputs?: boolean;
        /** Honoured on create only; a draft save never moves a project. */
        projectId?: string | null | undefined;
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
          preparationChanged(id);
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
          return {
            preparation: await preparationViewIn(tx, actor.workspaceId, row!),
          };
        }
        const count = await tx
          .select({ id: schema.dataPreparations.id })
          .from(schema.dataPreparations)
          .where(eq(schema.dataPreparations.workspaceId, actor.workspaceId));
        if (exceedsDataPolicy(count.length + 1, policyFor(tx).maxPreparations))
          fail("data_preparation_limit", 413);
        const projectId = input.projectId
          ? await assignableProject(tx, actor.workspaceId, input.projectId)
          : null;
        const [row] = await tx
          .insert(schema.dataPreparations)
          .values({
            workspaceId: actor.workspaceId,
            projectId,
            name: input.name,
            graph,
            updatedAt: now,
          })
          .returning();
        await audit(tx, actor, "data.preparation_created", row!.id);
        return {
          preparation: await preparationViewIn(tx, actor.workspaceId, row!),
        };
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
        let row = await findPreparation(tx, actor.workspaceId, id, true);
        if (row.version !== expected) fail("version_conflict", 409);
        // Publishing the published version again: a published preparation
        // keeps the versions of the preparations it reads, so when those were
        // published since, this publishes the same graph as a new version
        // reading their current versions. Otherwise (or for a restored
        // version, which keeps its inputs on purpose) nothing changes.
        const republish = row.publishedVersion === expected;
        if (republish && row.restoredFromVersion)
          return {
            preparation: publishedView(preparationView(row)),
          };
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
        if (republish) {
          const publication = await preparationPublication(
            tx,
            actor.workspaceId,
            id,
            expected,
          );
          if (
            stable(
              (publication.dependencies as Dependencies | null)?.prepared ?? {},
            ) === stable(loader.dependencies.prepared)
          )
            return {
              preparation: publishedView(preparationView(row)),
            };
          preparationChanged(id);
          const [bumped] = await tx
            .update(schema.dataPreparations)
            .set({ version: row.version + 1, updatedAt: now })
            .where(
              and(
                eq(schema.dataPreparations.workspaceId, actor.workspaceId),
                eq(schema.dataPreparations.id, id),
                eq(schema.dataPreparations.version, row.version),
              ),
            )
            .returning();
          if (!bumped) fail("version_conflict", 409);
          row = bumped;
        }
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
        // The new output through the inputs the graph just read: the same
        // pinned versions, so loading them again would read the same rows.
        const publishedLoader = loadFor(tx, actor.workspaceId, now, {
          allowPendingSchemas: true,
          dependencies: {
            prepared: { ...loader.dependencies.prepared, [id]: row.version },
          },
          seed: loader,
        });
        for (const output of graph.outputs)
          await publishedLoader.load("prepared:" + id + ":" + output);
        preparationChanged(id);
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
        return {
          preparation: publishedView(preparationView(updated!)),
        };
      }),
    listModels: (actor: DataActor, filter: ProjectFilter = {}) =>
      run(actor, async (tx) => ({
        models: await modelViews(
          tx,
          actor.workspaceId,
          await tx
            .select()
            .from(schema.dataModels)
            .where(
              and(
                eq(schema.dataModels.workspaceId, actor.workspaceId),
                projectFilterSql(
                  schema.dataModels.projectId,
                  actor.workspaceId,
                  filter,
                ),
              ),
            )
            .orderBy(asc(schema.dataModels.name)),
        ),
      })),
    getModel: (actor: DataActor, id: string) =>
      run(actor, async (tx) => ({
        model: await modelViewIn(
          tx,
          actor.workspaceId,
          await findDataModel(tx, actor.workspaceId, id),
        ),
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
        checkRestoredModelBindings(
          publication.schemaBindings as Record<string, DataField[]>,
          loader,
          definition,
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
        return { model: await modelViewIn(tx, actor.workspaceId, updated!) };
      }),
    saveModel: (
      actor: DataActor,
      input: {
        name: string;
        definition: SemanticModelDefinition;
        version?: number;
        adoptLatestInputs?: boolean;
        /** Honoured on create only; a draft save never moves a project. */
        projectId?: string | null | undefined;
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
          return { model: await modelViewIn(tx, actor.workspaceId, updated!) };
        }
        const count = await tx
          .select({ id: schema.dataModels.id })
          .from(schema.dataModels)
          .where(eq(schema.dataModels.workspaceId, actor.workspaceId));
        if (exceedsDataPolicy(count.length + 1, policyFor(tx).maxModels))
          fail("data_model_limit", 413);
        const projectId = input.projectId
          ? await assignableProject(tx, actor.workspaceId, input.projectId)
          : null;
        const [row] = await tx
          .insert(schema.dataModels)
          .values({
            workspaceId: actor.workspaceId,
            projectId,
            name: input.name,
            definition,
            updatedAt: now,
          })
          .returning();
        await audit(tx, actor, "data.model_created", row!.id);
        return { model: await modelViewIn(tx, actor.workspaceId, row!) };
      }),
    publishModel: (actor: DataActor, id: string, expected: number) =>
      run(actor, async (tx, now) => {
        let row = await findDataModel(tx, actor.workspaceId, id, true);
        if (row.version !== expected) fail("version_conflict", 409);
        // Publishing the published release again: as for a preparation, a
        // new release of the same definition when the preparations it reads
        // were published since; otherwise (or for a restored release, which
        // keeps its inputs) nothing changes.
        const republish = row.publishedVersion === expected;
        if (republish && row.restoredFromVersion)
          return { model: publishedView(modelView(row)) };
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
          checkRestoredModelBindings(
            restored.schemaBindings as Record<string, DataField[]>,
            loader,
            definition,
          );
        validateSemanticModel(
          definition,
          loader.tables,
          now.toISOString(),
          loader.budget,
        );
        if (republish) {
          const release = await modelPublication(
            tx,
            actor.workspaceId,
            id,
            expected,
          );
          if (
            stable(
              (release.dependencies as Dependencies | null)?.prepared ?? {},
            ) === stable(loader.dependencies.prepared)
          )
            return { model: publishedView(modelView(row)) };
          const [bumped] = await tx
            .update(schema.dataModels)
            .set({ version: row.version + 1, updatedAt: now })
            .where(
              and(
                eq(schema.dataModels.workspaceId, actor.workspaceId),
                eq(schema.dataModels.id, id),
                eq(schema.dataModels.version, row.version),
              ),
            )
            .returning();
          if (!bumped) fail("version_conflict", 409);
          row = bumped;
        }
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
        return { model: publishedView(modelView(updated!)) };
      }),
    query: async (
      actor: DataActor,
      id: string,
      query: DataModelQuery,
      preview = false,
    ) => {
      const execute =
        (admit: boolean | DeferredPageAdmission) =>
        (tx: Transaction, now: Date): Promise<DataModelQueryResult> =>
          queryDataModel(
            tx,
            actor.workspaceId,
            id,
            query,
            now,
            policyFor(tx),
            preview,
            "user:" + actor.callerId,
            admit,
          );
      // A new pinned query may admit a page session: it counts the release's
      // sessions, then inserts one. Serializable transactions doing that
      // concurrently aborted each other and could exhaust their retries with
      // version_conflict (#495), also across models and workspaces: reading
      // the snapshot table takes an SSI predicate lock that every other
      // admission's insert conflicts with (#516).
      //
      // So a first page runs in two steps under a database lock per model,
      // taken before either starts. The page is computed in a serializable
      // transaction that does not touch the snapshot table and commits first.
      // Admission then counts and inserts in a short read-committed
      // transaction: it sees every session committed by an earlier holder of
      // the lock, and both caps count only this model's release, so counts
      // stay exact while admissions of other models never conflict with it.
      // If admission fails, nothing of it commits and the request fails; a
      // session never exists without the page that pinned it. Generations
      // read by the page but pinned only by the later admission are kept by
      // prune's grace period, as for any request that reads a generation
      // before it commits the snapshot naming it.
      //
      // Waiters of this process queue in memory and hold no pool connection;
      // a wait longer than the workspace's query timeout ends in the refusal
      // instead.
      if (
        !query.pinPages ||
        query.pageToken ||
        preview ||
        !isPooledDatabase(db)
      )
        return run(actor, execute(true));
      const timeoutMs =
        (await run(actor, async (tx) => policyFor(tx).queryTimeoutMs)) ??
        PAGE_ADMISSION_WAIT_MS;
      try {
        return await withSessionAdvisoryLock(
          db,
          "data_page_sessions:" + id,
          async (lockedDb) => {
            const deferred: DeferredPageAdmission = {};
            const page = await run(actor, execute(deferred), lockedDb);
            const admit = deferred.admit;
            if (!admit) return page;
            return run(actor, (tx) => admit(tx), lockedDb, "read committed");
          },
          { timeoutMs, queue: pageAdmissions },
        );
      } catch (error) {
        if (!(error instanceof SessionLockTimeoutError)) throw error;
        return run(actor, execute(false));
      }
    },
  };
}

/**
 * Narrows the source list to a project (#572). A source follows its
 * connection's project, a prepared output its preparation's; reference
 * tables (manual) are workspace-wide and listed in every project (#644);
 * other sources without a connection count as unassigned.
 */
async function filterSourcesByProject(
  tx: Transaction,
  workspaceId: string,
  items: SourceView[],
  preparationProjects: Map<string, string | null>,
  filter: ProjectFilter,
): Promise<SourceView[]> {
  if (filter.project === undefined) return items;
  const connections = await tx
    .select({
      id: schema.connections.id,
      projectId: schema.connections.projectId,
    })
    .from(schema.connections)
    .where(
      and(
        eq(schema.connections.workspaceId, workspaceId),
        notDraftConnection(),
      ),
    );
  const connectionProjects = new Map(
    connections.map((row) => [row.id, row.projectId]),
  );
  const visible =
    filter.project === "all"
      ? new Set(
          (
            await tx
              .select({ id: schema.projects.id })
              .from(schema.projects)
              .where(
                and(
                  eq(schema.projects.workspaceId, workspaceId),
                  isNull(schema.projects.archivedAt),
                ),
              )
          ).map((row) => row.id),
        )
      : new Set([filter.project]);
  const unassignedVisible =
    filter.project === "all" || filter.unassigned === "include";
  return items.filter((item) => {
    // Reference tables are workspace-wide (#644): shared lookups such as
    // an app mapping, listed and offered inside every project.
    if (item.kind === "manual") return true;
    const projectId = item.id.startsWith("prepared:")
      ? (preparationProjects.get(item.id.split(":")[1]!) ?? null)
      : item.connectionId
        ? (connectionProjects.get(item.connectionId) ?? null)
        : null;
    return projectId === null ? unassignedVisible : visible.has(projectId);
  });
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

/**
 * Bytes of a workspace's prepared-output cache, for its capacity check. No
 * index leads with workspace_id, so this scans the whole table; in a
 * serializable transaction that is a predicate lock on every workspace's
 * entries, which each concurrent cache insert in any workspace conflicts
 * with. The caller asks only when the policy sets a prepared-cache quota
 * (none by default), instead of on every cache write (#598).
 */
async function preparedWorkspaceBytes(
  tx: Transaction,
  workspaceId: string,
): Promise<number> {
  const [usage] = await tx
    .select({
      bytes: sql<string>`coalesce(sum(${schema.dataPreparedGenerations.byteSize}),0)`,
    })
    .from(schema.dataPreparedGenerations)
    .where(eq(schema.dataPreparedGenerations.workspaceId, workspaceId));
  return Number(usage?.bytes ?? 0);
}
/** Best-effort write to the last-valid snapshot cache. Read paths (dashboards,
 * devices) run under repeatable read without retries; concurrent readers of
 * the same query update the same row, and the loser's serialization failure is
 * rolled back to a savepoint instead of failing the read. */
async function cacheWrite<T>(
  tx: Transaction,
  write: (tx: Transaction) => Promise<T>,
): Promise<T | undefined> {
  try {
    return await tx.transaction((savepoint) => write(savepoint));
  } catch (error) {
    if (
      !hasSqlstate(error, "40001") &&
      !hasSqlstate(error, "40P01") &&
      !hasSqlstate(error, "23505")
    )
      throw error;
    return undefined;
  }
}

/**
 * Lets queryDataModel leave page-session admission to a later transaction.
 * When the first page can start a session, `admit` is set; it counts the
 * release's sessions, inserts one when both caps allow it and returns the
 * final result. queryDataModel then returns the result without a token.
 */
export interface DeferredPageAdmission {
  admit?: (tx: Transaction) => Promise<DataModelQueryResult>;
}

/**
 * Internal query entry for authorized workspace transactions. Pinned paging
 * additionally requires a trusted principal identity, never a request field.
 */
export async function queryDataModel(
  tx: Transaction,
  workspaceId: string,
  id: string,
  query: DataModelQuery,
  now: Date,
  policy: DataPolicy,
  preview = false,
  pageOwner?: string,
  admit: boolean | DeferredPageAdmission = true,
  /**
   * Extends the published definition before the query runs: a latest-items
   * widget's internal count measure (#810). The query names what it adds,
   * so its snapshots never mix with plain queries.
   */
  extend?: (definition: SemanticModelDefinition) => SemanticModelDefinition,
): Promise<DataModelQueryResult> {
  if (typeof admit === "object") admit.admit = undefined;
  if ((query.pageToken || query.pinPages) && !pageOwner)
    fail("data_page_unavailable", 409);
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
  const callerPagePrefix = pageOwner
    ? "page:v2:" + createHash("sha256").update(pageOwner).digest("hex") + ":"
    : null;
  const pageSessionKey = (sessionId: string) =>
    callerPagePrefix! + sessionId + ":" + pageQueryKey;
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
  const parsed = semanticModelDefinitionSchema.parse(
    preview ? model.definition : release!.definition,
  );
  const definition = extend ? extend(parsed) : parsed;
  const evaluate = async (
    generations?: Record<string, string>,
    currentResources = false,
  ) => {
    const loader = createDataLoader(tx, workspaceId, now, {
      policy,
      allowPendingResults: true,
      currentResources,
      ...(generations ? { generations } : {}),
      ...(release || restored
        ? { dependencies: (release ?? restored)!.dependencies as Dependencies }
        : {}),
    });
    for (const source of definition.datasets) await loader.load(source);
    if (release)
      checkSchemaBindings(
        release.schemaBindings as Record<string, DataField[]>,
        loader.bindings,
      );
    else if (restored)
      checkRestoredModelBindings(
        restored.schemaBindings as Record<string, DataField[]>,
        loader,
        definition,
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
            pageSessionKey(continuation.sessionId),
          ),
          gt(schema.dataModelQuerySnapshots.expiresAt, now),
        ),
      );
    if (
      !snapshot ||
      policy.querySnapshotCount === 0 ||
      policy.queryPageSessionsPerCaller === 0 ||
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
      true,
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
  const finishPinned = (
    result: ReturnType<typeof pageResult>,
  ): DataModelQueryResult =>
    query.pinPages &&
    result.offset + result.rows.length < result.totalRows &&
    !result.nextPageToken &&
    !result.warnings.includes("immutable_pagination_unavailable")
      ? {
          ...result,
          warnings: [...result.warnings, "immutable_pagination_unavailable"],
        }
      : result;
  let result: ReturnType<typeof pageResult> = execution.result;
  if (release && !execution.result.pendingSources?.length) {
    // Cache only generation identities, never a second copy of source rows.
    // Limit cache cardinality and lifetime independently of source retention.
    // Reclaim expired identities before admission, including deadlines shortened
    // by the current policy. Old unowned sessions cannot be resumed safely;
    // retire only their exact known key format, preserving versioned formats.
    // Concurrent readers race on this maintenance; whichever commits first does it.
    const reclaim = (tx: Transaction) =>
      cacheWrite(tx, (tx) =>
        tx
          .delete(schema.dataModelQuerySnapshots)
          .where(
            and(
              eq(schema.dataModelQuerySnapshots.workspaceId, workspaceId),
              eq(schema.dataModelQuerySnapshots.releaseId, release.id),
              or(
                sql`${schema.dataModelQuerySnapshots.queryKey} ~ ${LEGACY_PAGE_KEY_PATTERN}`,
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
          ),
      );
    const identities = (tx: Transaction) =>
      tx
        .select({ queryKey: schema.dataModelQuerySnapshots.queryKey })
        .from(schema.dataModelQuerySnapshots)
        .where(
          and(
            eq(schema.dataModelQuerySnapshots.workspaceId, workspaceId),
            eq(schema.dataModelQuerySnapshots.releaseId, release.id),
          ),
        );
    const refused = () => ({
      ...execution.result,
      warnings: [
        ...execution.result.warnings,
        "immutable_pagination_unavailable",
      ],
    });
    const deferred = typeof admit === "object";
    // A deferred admission (#516) leaves the snapshot table to its own
    // transaction: reading it here would make this serializable transaction
    // conflict with every other admission (SSI predicate locks).
    const existing = deferred ? [] : (await reclaim(tx), await identities(tx));
    const snapshotCount = existing.filter(
      (s) => !s.queryKey.startsWith("page:"),
    ).length;
    if (
      query.pinPages &&
      execution.result.offset + execution.result.rows.length <
        execution.result.totalRows
    ) {
      if (
        admit &&
        !execution.loader.warnings.has("data_source_pending") &&
        !execution.loader.warnings.has("retained_source_history_incomplete") &&
        [...execution.loader.views.values()].every(
          (source) =>
            source.kind !== "prepared" || source.generationId !== null,
        ) &&
        policy.querySnapshotSeconds !== 0
      ) {
        const generations = snapshotGenerations(execution.loader);
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
        // Counts the release's sessions and inserts one. Both caps count this
        // one release, so whoever orders admissions of the release (the
        // serializable transaction itself, or the caller's per-model lock for
        // a deferred admission) makes them exact.
        const admitSession = async (
          tx: Transaction,
          existing: { queryKey: string }[],
        ) => {
          const sessionCount = existing.filter((s) =>
            s.queryKey.startsWith("page:"),
          ).length;
          const callerSessionCount = existing.filter((s) =>
            s.queryKey.startsWith(callerPagePrefix!),
          ).length;
          if (
            exceedsDataPolicy(
              callerSessionCount + 1,
              policy.queryPageSessionsPerCaller,
            ) ||
            exceedsDataPolicy(sessionCount + 1, policy.querySnapshotCount)
          )
            return refused();
          const sessionId = randomUUID();
          await tx.insert(schema.dataModelQuerySnapshots).values({
            workspaceId,
            releaseId: release.id,
            queryKey: pageSessionKey(sessionId),
            generations,
            expiresAt,
            updatedAt: now,
          });
          return pageResult(execution.result, sessionId, expiresAt);
        };
        if (typeof admit === "object") {
          admit.admit = async (tx) =>
            finishPinned(
              await admitSession(tx, (await reclaim(tx), await identities(tx))),
            );
          return execution.result;
        }
        result = await admitSession(tx, existing);
      } else {
        result = refused();
      }
    }
    if (
      !query.pinPages &&
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
      // A concurrent reader of the same query records an equivalent fallback,
      // so a serialization conflict here must not fail this read.
      await cacheWrite(tx, (tx) =>
        tx
          .insert(schema.dataModelQuerySnapshots)
          .values({
            workspaceId: workspaceId,
            releaseId: release.id,
            queryKey,
            generations: snapshotGenerations(execution.loader),
            expiresAt,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              schema.dataModelQuerySnapshots.releaseId,
              schema.dataModelQuerySnapshots.queryKey,
            ],
            set: {
              generations: snapshotGenerations(execution.loader),
              expiresAt,
              updatedAt: now,
            },
            setWhere: eq(
              schema.dataModelQuerySnapshots.workspaceId,
              workspaceId,
            ),
          }),
      );
    }
  }
  return finishPinned(result);
}
