import type {
  CompareMeasurePreview,
  CompareMeasureRequest,
  CompareMeasureResponse,
} from "@netrics/contracts";
import { compareMeasureRequestSchema } from "@netrics/contracts";
import {
  findConnectionMetric,
  listObservationDatasets,
  retryOnSerializationFailure,
  withWorkspace,
  DatasetStoreError,
  type Database,
  type Transaction,
} from "@netrics/database";
import {
  COMPARE_DATE_DIMENSION,
  COMPARE_MEASURE_IDS,
  COMPARE_PREPARATION_OUTPUT,
  CURRENCY_DIMENSION,
  DEFAULT_DATA_POLICY,
  compatibleAggregations,
  compileCompareMeasure,
  isPerCurrencyUnit,
  type Aggregation,
  type CompareMeasureSide,
  type DataPolicy,
  type Granularity,
  type Locale,
  type MetricKind,
} from "@netrics/domain";
import {
  createDataService,
  DataServiceError,
  datasetStoreStatus,
  isDataConflict,
  isRetryableDataConflict,
  observationFields,
  type DataActor,
} from "./service.js";

function reject(
  code: string,
  status: 400 | 404 | 409 | 413 | 503 = 400,
): never {
  throw new DataServiceError(code, status);
}

/** A side of the compare, read from its connection's metric catalog. */
async function compareSide(
  tx: Transaction,
  workspaceId: string,
  binding: {
    connectionId: string;
    metricKey: string;
    aggregation?: Aggregation | undefined;
    dimensions?: Record<string, string> | undefined;
  },
): Promise<CompareMeasureSide> {
  const metric = await findConnectionMetric(
    tx,
    workspaceId,
    binding.connectionId,
    binding.metricKey,
  );
  if (!metric) reject("compare_source_unavailable", 404);
  // The widget's own rule (metrics query): a compatible aggregation, the
  // first one by default.
  const aggregations = compatibleAggregations(
    metric.kind as MetricKind,
    metric.aggregations as Aggregation[],
  );
  const aggregation = binding.aggregation ?? aggregations[0];
  if (!aggregation || !aggregations.includes(aggregation))
    reject("aggregation_not_supported");
  const [dataset] = await listObservationDatasets(tx, workspaceId, {
    connectionId: binding.connectionId,
    metricKey: binding.metricKey,
  });
  if (!dataset) reject("compare_source_unavailable", 404);
  const fields = observationFields(dataset);
  const dimensionFields: Record<string, string> = {};
  for (const field of fields)
    if (field.id.startsWith("dimension."))
      dimensionFields[field.name] = field.id;
  return {
    datasetId: dataset.id,
    name: metric.name,
    kind: metric.kind as MetricKind,
    granularity: metric.granularity as Granularity,
    unit: metric.unit,
    aggregation,
    dimensions: binding.dimensions ?? {},
    dimensionFields,
    currencyFieldId:
      fields.find((field) => field.id === "value")?.currencyField ?? null,
  };
}

/** The caller, with the language the generated names are created in. */
type CompareMeasureActor = DataActor & { locale?: Locale };

/** Both sides read and compiled, or the typed refusal thrown. */
async function compileRequest(
  tx: Transaction,
  workspaceId: string,
  input: ReturnType<typeof compareMeasureRequestSchema.parse>,
  locale: Locale | undefined,
) {
  const numerator = await compareSide(tx, workspaceId, input);
  const denominator = await compareSide(tx, workspaceId, input.denominator);
  const compiled = compileCompareMeasure({
    name: input.name,
    period: input.period,
    format: input.format,
    numerator,
    denominator,
    currency: input.currency ?? null,
    locale,
  });
  if (!compiled.ok) reject(compiled.error);
  // The pinned currency counts only where a side has no currency filter.
  const pinned = [numerator, denominator].some(
    (side) =>
      isPerCurrencyUnit(side.unit) &&
      side.dimensions[CURRENCY_DIMENSION] === undefined,
  );
  return { compiled, currency: pinned ? (input.currency ?? null) : null };
}

/**
 * Save a compare widget as a reusable measure (#506): a generated
 * preparation, published so a model can read it, and a draft model with
 * the ratio and its change. Nothing that screens show changes until the
 * model is published and something is bound to it.
 */
export function createCompareMeasureService(deps: {
  db: Database;
  now?: () => Date;
  policy?: DataPolicy;
}) {
  const now = deps.now ?? (() => new Date()),
    defaults = deps.policy ?? DEFAULT_DATA_POLICY;
  return {
    /**
     * What `create` would make of the request (#508), read in a read-only
     * transaction: nothing is saved, and a refusal is the same.
     */
    async preview(
      actor: CompareMeasureActor,
      request: CompareMeasureRequest,
    ): Promise<CompareMeasurePreview> {
      const input = compareMeasureRequestSchema.parse(request);
      return withWorkspace(
        deps.db,
        { workspaceId: actor.workspaceId, userId: actor.callerId },
        async (tx) => {
          const { compiled, currency } = await compileRequest(
            tx,
            actor.workspaceId,
            input,
            actor.locale,
          );
          const model = compiled.model(
            `prepared:preview:${COMPARE_PREPARATION_OUTPUT}`,
          );
          const named = (id: string) => ({
            id,
            name: model.measures.find((measure) => measure.id === id)!.name,
          });
          return {
            preparation: {
              name: input.name,
              steps: compiled.preparation.nodes.map((node) => ({
                id: node.id,
                type: node.type,
              })),
            },
            model: { name: input.name },
            dateDimensionId: COMPARE_DATE_DIMENSION,
            measures: {
              numerator: named(COMPARE_MEASURE_IDS.numerator),
              denominator: named(COMPARE_MEASURE_IDS.denominator),
              ratio: named(COMPARE_MEASURE_IDS.ratio),
              previous: named(COMPARE_MEASURE_IDS.previous),
              change: named(COMPARE_MEASURE_IDS.change),
            },
            currency,
          };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },
    async create(
      actor: CompareMeasureActor,
      request: CompareMeasureRequest,
    ): Promise<CompareMeasureResponse> {
      const input = compareMeasureRequestSchema.parse(request);
      try {
        return await retryOnSerializationFailure(
          () =>
            withWorkspace(
              deps.db,
              { workspaceId: actor.workspaceId, userId: actor.callerId },
              async (tx) => {
                const { compiled } = await compileRequest(
                  tx,
                  actor.workspaceId,
                  input,
                  actor.locale,
                );
                const data = createDataService(tx, now, defaults);
                const saved = await data.savePreparation(actor, {
                  name: input.name,
                  graph: compiled.preparation,
                });
                await data.publishPreparation(
                  actor,
                  saved.preparation.id,
                  saved.preparation.version,
                );
                const datasetId = `prepared:${saved.preparation.id}:${COMPARE_PREPARATION_OUTPUT}`;
                const model = await data.saveModel(actor, {
                  name: input.name,
                  definition: compiled.model(datasetId),
                });
                return {
                  preparationId: saved.preparation.id,
                  datasetId,
                  modelId: model.model.id,
                  modelVersion: model.model.version,
                  dateDimensionId: COMPARE_DATE_DIMENSION,
                  measures: { ...COMPARE_MEASURE_IDS },
                };
              },
              { isolationLevel: "serializable" },
            ),
          {
            retryable: isRetryableDataConflict,
          },
        );
      } catch (error) {
        if (isDataConflict(error)) reject("version_conflict", 409);
        if (error instanceof DatasetStoreError)
          reject(error.code, datasetStoreStatus(error.code));
        throw error;
      }
    },
  };
}
