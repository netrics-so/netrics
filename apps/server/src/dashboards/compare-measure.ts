import { and, eq, inArray } from "drizzle-orm";
import {
  compareMeasureBindingSchema,
  semanticModelDefinitionSchema,
  type CompareMeasureReading,
  type ConnectionStateView,
  type DashboardWidgetData,
  type DeviceTileStatus,
} from "@netrics/contracts";
import {
  findBackfillingConnectionIds,
  findWorkspace,
  listConnections,
  schema,
  type Transaction,
} from "@netrics/database";
import {
  DEFAULT_DATA_POLICY,
  amountCurrency,
  compareMeasureFilter,
  compareMeasureWindows,
  compareRatioUnit,
  compareUnitsProblem,
  type CompareFormat,
  currencyExponent,
  type CompareMeasureBinding,
  type DataPolicy,
  type Period,
} from "@netrics/domain";

import { toStateView } from "../connections/present.js";
import { tileStatus } from "../devices/dashboard.js";
import {
  publishedModel,
  queryDashboardMeasure,
  safeDataError,
} from "./data.js";

// A compare widget bound to the measures its compare was compiled into
// (#507). It stays a compare widget: its period's current and previous
// windows (resolvePeriod, as its metric queries read daily metrics) become
// two closed date ranges on the model's date dimension, and the published
// numerator, denominator and ratio are read for each through the dashboard
// measure path (published release, policy, query timeout). Change and
// points stay the screens' (`compareChange`). A measure that cannot be read
// is an error with no values: it never falls back to the widget's metrics.

/** Why a bound compare widget has no values, beyond the data API's codes. */
export const COMPARE_BINDING_ERRORS = [
  /** The model is not one of the workspace's. */
  "compare_measure_model_not_found",
  /** A measure or the date dimension is not the model's. */
  "compare_measure_not_found",
  /** The date dimension is not a date. */
  "compare_measure_date_required",
  /** A measure's value is not a number. */
  "compare_measure_not_numeric",
  /** A stored binding that does not parse. */
  "compare_measure_binding_invalid",
] as const;

/**
 * A binding as saved (#507): the model is one of the workspace's, and its
 * measures and date dimension are the model's own, in its draft or its
 * published release (one compiled by POST …/data/compare-measures is a
 * draft until published; until then the widget shows the typed error).
 * Returns the error, or null.
 */
export async function compareBindingProblem(
  tx: Transaction,
  workspaceId: string,
  binding: CompareMeasureBinding,
): Promise<(typeof COMPARE_BINDING_ERRORS)[number] | null> {
  const [model] = await tx
    .select({
      definition: schema.dataModels.definition,
      publishedVersion: schema.dataModels.publishedVersion,
    })
    .from(schema.dataModels)
    .where(
      and(
        eq(schema.dataModels.workspaceId, workspaceId),
        eq(schema.dataModels.id, binding.modelId),
      ),
    );
  if (!model) return "compare_measure_model_not_found";
  const definitions = [model.definition];
  if (model.publishedVersion !== null) {
    const [release] = await tx
      .select({ definition: schema.dataModelReleases.definition })
      .from(schema.dataModelReleases)
      .where(
        and(
          eq(schema.dataModelReleases.workspaceId, workspaceId),
          eq(schema.dataModelReleases.modelId, binding.modelId),
          eq(schema.dataModelReleases.version, model.publishedVersion),
        ),
      );
    if (release) definitions.push(release.definition);
  }
  const owns = definitions.some((raw) => {
    const definition = semanticModelDefinitionSchema.safeParse(raw).data;
    if (!definition) return false;
    const measures = new Set(definition.measures.map((measure) => measure.id));
    return (
      Object.values(binding.measureIds).every((id) => measures.has(id)) &&
      definition.dimensions.some(
        (dimension) => dimension.id === binding.dateDimensionId,
      )
    );
  });
  return owns ? null : "compare_measure_not_found";
}

/**
 * The connections a published model reads, also through the preparations
 * it depends on (a compiled compare reads two observation datasets through
 * its generated preparation).
 */
async function modelConnections(
  tx: Transaction,
  workspaceId: string,
  modelId: string,
): Promise<string[]> {
  const [release] = await tx
    .select({
      bindings: schema.dataModelReleases.schemaBindings,
      dependencies: schema.dataModelReleases.dependencies,
    })
    .from(schema.dataModels)
    .innerJoin(
      schema.dataModelReleases,
      and(
        eq(schema.dataModelReleases.modelId, schema.dataModels.id),
        eq(schema.dataModelReleases.workspaceId, workspaceId),
        eq(
          schema.dataModelReleases.version,
          schema.dataModels.publishedVersion,
        ),
      ),
    )
    .where(
      and(
        eq(schema.dataModels.workspaceId, workspaceId),
        eq(schema.dataModels.id, modelId),
      ),
    );
  if (!release) return [];
  const datasets = new Set(
    Object.keys(release.bindings as Record<string, unknown>),
  );
  const prepared = Object.entries(
    (release.dependencies as { prepared?: Record<string, number> }).prepared ??
      {},
  );
  for (const [preparationId, version] of prepared) {
    const [row] = await tx
      .select({ graph: schema.dataPreparationVersions.graph })
      .from(schema.dataPreparationVersions)
      .where(
        and(
          eq(schema.dataPreparationVersions.workspaceId, workspaceId),
          eq(schema.dataPreparationVersions.preparationId, preparationId),
          eq(schema.dataPreparationVersions.version, version),
        ),
      );
    const nodes = (row?.graph as { nodes?: unknown[] } | undefined)?.nodes;
    for (const node of Array.isArray(nodes) ? nodes : [])
      if (
        node &&
        typeof node === "object" &&
        "type" in node &&
        node.type === "source" &&
        "datasetId" in node &&
        typeof node.datasetId === "string"
      )
        datasets.add(node.datasetId);
  }
  const uuid = /^[0-9a-f-]{36}$/i;
  const connections = new Set<string>();
  const raw: string[] = [];
  for (const id of datasets) {
    if (id.startsWith("observation:") || id.startsWith("resources:")) {
      const connectionId = id.split(":")[1];
      if (connectionId && uuid.test(connectionId))
        connections.add(connectionId);
    } else if (uuid.test(id)) raw.push(id);
  }
  if (raw.length)
    for (const dataset of await tx
      .select({ connectionId: schema.dataDatasets.connectionId })
      .from(schema.dataDatasets)
      .where(
        and(
          eq(schema.dataDatasets.workspaceId, workspaceId),
          inArray(schema.dataDatasets.id, raw),
        ),
      ))
      if (dataset.connectionId) connections.add(dataset.connectionId);
  return [...connections];
}

/** The workspace's connection health, loaded once per payload. */
export interface CompareSourceContext {
  states: ReadonlyMap<string, ConnectionStateView>;
  names: ReadonlyMap<string, string>;
  backfilling: ReadonlySet<string>;
}

export async function loadCompareSources(
  tx: Transaction,
  workspaceId: string,
): Promise<CompareSourceContext> {
  const connections = await listConnections(tx, workspaceId);
  return {
    states: new Map(
      connections.map(({ row, state }) => [row.id, toStateView(state)]),
    ),
    names: new Map(connections.map(({ row }) => [row.id, row.name])),
    backfilling: await findBackfillingConnectionIds(tx, workspaceId),
  };
}

/** Worst last, as the compare widget's two sides are ranked. */
const SEVERITY: readonly DeviceTileStatus[] = [
  "ok",
  "stale",
  "backfilling",
  "no_data",
  "outage",
  "auth_failed",
];
const worse = (a: DeviceTileStatus, b: DeviceTileStatus) =>
  SEVERITY.indexOf(a) >= SEVERITY.indexOf(b) ? a : b;

type Cell = { value: number | null; unit: string | null };

/** A measure's cell as a compare operand; null when it is not a number. */
function operandOf(
  data: DashboardWidgetData,
  measureId: string,
): Cell | "not_numeric" {
  const cell = data.result?.rows[0]?.measures[measureId];
  // Compare amounts are minor units of their currency ("EUR_minor"), as
  // metric queries give them: an amount in major units ("currency") is
  // scaled, one in minor units relabelled. Any other number without a unit
  // is a plain count, so screens show it (a null unit is a failed query).
  // Also an amount per unit ("currency/count"): its scale is the amount's.
  const major =
    cell?.unit?.split("/")[0] === "currency" && Boolean(cell.currency);
  const unit = cell?.currency
    ? `${cell.currency}_minor`
    : (cell?.unit ?? "count");
  if (!cell || cell.value === null || cell.value === undefined)
    return { value: null, unit };
  if (!["integer", "number", "decimal"].includes(cell.type))
    return "not_numeric";
  const value = Number(cell.value);
  if (!Number.isFinite(value)) return "not_numeric";
  return {
    value: major ? value * 10 ** currencyExponent(cell.currency!) : value,
    unit,
  };
}

/**
 * A bound compare widget's numbers: the published numerator, denominator
 * and ratio over the period's current window, and the ratio over its
 * previous window. Status and `updatedAt` are those of the model's sources,
 * ranked as the widget ranks its two sides.
 */
export async function readCompareMeasure(
  tx: Transaction,
  workspaceId: string,
  /** `measure` as stored; one that does not parse is an error. */
  widget: {
    id: string;
    period: Period;
    measure: unknown;
    /** The widget's format, which the measures' units must suit. */
    format: CompareFormat;
  },
  now: Date,
  options: {
    policy?: DataPolicy;
    locale?: "en" | "de";
    sources?: CompareSourceContext;
  } = {},
): Promise<CompareMeasureReading> {
  const workspace = await findWorkspace(tx, workspaceId);
  const dates = compareMeasureWindows(
    widget.period,
    now,
    workspace?.timeZone ?? "UTC",
  );
  const parsed = compareMeasureBindingSchema.safeParse(widget.measure);
  const measure = parsed.data;
  const ids = measure?.measureIds ?? {
    numerator: "numerator",
    denominator: "denominator",
    ratio: "ratio",
  };
  const read = (
    measure: CompareMeasureBinding,
    range: { from: string; to: string },
  ) =>
    queryDashboardMeasure(
      tx,
      workspaceId,
      {
        id: widget.id,
        binding: {
          modelId: measure.modelId,
          measureIds: [ids.numerator, ids.denominator, ids.ratio],
          groupBy: [],
          filter: compareMeasureFilter(measure.dateDimensionId, range),
          exclusions: [],
        },
        options: { view: "table", limit: 1 },
      },
      // A compare widget follows no shared filter, and no screen scope:
      // scoped screens do not get it (followsDeviceScope).
      [],
      {},
      now,
      options.policy ?? DEFAULT_DATA_POLICY,
      options.locale ?? "en",
    );
  const failed = (error: string): CompareMeasureReading => ({
    widgetId: widget.id,
    status: "outage",
    error,
    updatedAt: null,
    expiresAt: null,
    sources: [],
    numerator: { label: ids.numerator, value: null, unit: null },
    denominator: { label: ids.denominator, value: null, unit: null },
    ratio: { value: null, previousValue: null },
    unit: null,
    dates,
  });
  if (!measure) return failed("compare_measure_binding_invalid");
  // The windows are dates: the published date dimension must be one.
  let dimensionType: string | undefined;
  try {
    const model = await tx.transaction((savepoint) =>
      publishedModel(savepoint, workspaceId, measure.modelId),
    );
    dimensionType = model.metadata.dimensions.find(
      (dimension) => dimension.id === measure.dateDimensionId,
    )?.type;
  } catch (error) {
    return failed(safeDataError(error));
  }
  if (dimensionType === undefined) return failed("model_dimension_not_found");
  if (dimensionType !== "date") return failed("compare_measure_date_required");
  const current = await read(measure, dates.current);
  if (current.error !== null || !current.metadata)
    return failed(current.error ?? "data_storage_failed");
  const previous = await read(measure, dates.previous);
  if (previous.error !== null) return failed(previous.error);
  const numerator = operandOf(current, ids.numerator);
  const denominator = operandOf(current, ids.denominator);
  const ratio = operandOf(current, ids.ratio);
  const previousRatio = operandOf(previous, ids.ratio);
  if (
    numerator === "not_numeric" ||
    denominator === "not_numeric" ||
    ratio === "not_numeric" ||
    previousRatio === "not_numeric"
  )
    return failed("compare_measure_not_numeric");
  // The units rule of the widget (ADR 0019 section 10) on the measures it
  // reads: the inline metrics it was checked with on save are not them.
  if (
    compareUnitsProblem({
      numerator: { unit: numerator.unit ?? "count", dimensions: {} },
      denominator: { unit: denominator.unit ?? "count", dimensions: {} },
      displayCurrency: null,
      format: widget.format,
    }) !== null
  )
    return failed("compare_units_incompatible");
  // The change compares the ratio with itself over the previous window:
  // amounts in another currency there cannot be compared.
  if (
    ratio.value !== null &&
    previousRatio.value !== null &&
    amountCurrency(ratio.unit ?? "") !==
      amountCurrency(previousRatio.unit ?? "")
  )
    return failed("compare_units_incompatible");

  const sources =
    options.sources ?? (await loadCompareSources(tx, workspaceId));
  const connections = (
    await modelConnections(tx, workspaceId, measure.modelId)
  ).filter((id) => sources.states.has(id));
  // Which source supplies which operand is the model's business, so each
  // source is ranked by its health alone (as one with data), and a missing
  // operand is the loading history of a source that has none yet, or else no
  // data: what the inline widget's side without a value shows, without
  // marking a populated source as empty (#507 review).
  const sourceStatus = (id: string, hasData: boolean) =>
    tileStatus(
      sources.states.get(id) ?? null,
      hasData,
      now,
      sources.backfilling.has(id),
    );
  let status: DeviceTileStatus = connections
    .map((id) => sourceStatus(id, true))
    .reduce(worse, "ok");
  if (numerator.value === null || denominator.value === null)
    status = worse(
      status,
      connections.some((id) => sourceStatus(id, false) === "backfilling")
        ? "backfilling"
        : "no_data",
    );
  if (current.status === "stale" || previous.status === "stale")
    status = worse(status, "stale");
  const synced = connections.map(
    (id) => sources.states.get(id)?.lastSuccessAt ?? null,
  );
  const name = (id: string) =>
    current.metadata!.measures.find((entry) => entry.id === id)?.name ?? id;
  return {
    widgetId: widget.id,
    status,
    error: null,
    updatedAt:
      synced.length === 0 || synced.some((at) => at === null)
        ? null
        : synced.reduce((a, b) =>
            new Date(a!).getTime() <= new Date(b!).getTime() ? a : b,
          )!,
    // Values over retention-limited data go with it (#507 review).
    expiresAt:
      [current.result?.expiresAt, previous.result?.expiresAt]
        .filter((at): at is string => typeof at === "string")
        .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null,
    sources: connections
      .map((id) => sources.names.get(id)!)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    numerator: { label: name(ids.numerator), ...numerator },
    denominator: { label: name(ids.denominator), ...denominator },
    ratio: { value: ratio.value, previousValue: previousRatio.value },
    unit: compareRatioUnit(numerator.unit, denominator.unit),
    dates,
  };
}
