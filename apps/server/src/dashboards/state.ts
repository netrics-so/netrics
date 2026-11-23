import { sql } from "drizzle-orm";
import type {
  StateWidgetData,
  StateWidgetItem,
  StateWidgetOptions,
} from "@netrics/contracts";
import {
  normalizeServiceState,
  querySemanticModel,
  sortServiceStateItems,
  stateModelQuery,
  stateModelWithCount,
  DEFAULT_DATA_POLICY,
  SERVICE_STATE_VALUE_MAX,
  type DashboardDataFilter,
  type DashboardFilterValue,
  type DataPolicy,
  type DeviceFilterScope,
  type SlideFilterScope,
  type StateWidgetBinding,
} from "@netrics/domain";
import {
  resolveDataPolicy,
  type Transaction,
  rethrowWorkspaceGone,
} from "@netrics/database";
import { DataServiceError, queryDataModel } from "../data/service.js";
import {
  activeExclusions,
  checkFilterMappings,
  publishedModel,
  safeDataError,
} from "./data.js";
import {
  sourceFreshnessDependencies,
  type FreshnessReader,
  type WidgetFreshnessResult,
} from "./freshness.js";
import { modelSourceDatasets } from "./model-sources.js";

/** Item names are cut to this many characters, with "…". */
export const STATE_NAME_MAX = 200;

/**
 * A state widget's binding against its published model (#875): the name a
 * string dimension, the state a string or boolean, the changed-at a date
 * or timestamp, the rolled-back flag a boolean, every named dimension the
 * model's, and the dashboard's filters apply as on a measure widget.
 * Throws DataServiceError (or the model's DataProcessingError) with the
 * code a save answers.
 */
export async function validateDashboardState(
  tx: Transaction,
  workspaceId: string,
  filters: DashboardDataFilter[],
  binding: StateWidgetBinding,
  slideScope: SlideFilterScope = {},
) {
  const model = await publishedModel(tx, workspaceId, binding.modelId);
  const dimension = (id: string) => {
    const found = model.metadata.dimensions.find(
      (dimension) => dimension.id === id,
    );
    if (!found) throw new DataServiceError("state_dimension_unknown");
    return found;
  };
  if (dimension(binding.nameDimensionId).type !== "string")
    throw new DataServiceError("state_name_dimension_invalid");
  const state = dimension(binding.stateDimensionId);
  if (state.type !== "string" && state.type !== "boolean")
    throw new DataServiceError("state_state_dimension_invalid");
  if (binding.changedAtDimensionId) {
    const changed = dimension(binding.changedAtDimensionId);
    if (changed.type !== "date" && changed.type !== "timestamp")
      throw new DataServiceError("state_changed_dimension_invalid");
  }
  if (
    binding.rolledBackDimensionId &&
    dimension(binding.rolledBackDimensionId).type !== "boolean"
  )
    throw new DataServiceError("state_rolled_back_dimension_invalid");
  checkFilterMappings(filters, binding.modelId, model.metadata.dimensions);
  // The shape and filter paths against the published schema, without rows.
  const { model: definition, query } = stateModelQuery(
    model.definition,
    filters,
    {},
    binding,
    null,
    {},
    slideScope,
  );
  querySemanticModel(
    definition,
    new Map(
      Object.entries(model.bindings).map(([id, fields]) => [
        id,
        { fields, rows: [] },
      ]),
    ),
    query,
  );
  return model;
}

/** A value as text of at most `max` characters, cut with "…". */
function cut(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : String(value);
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/**
 * The rows of a state query as widget items: each state normalized with
 * the widget's overrides, "rolled back" only on up, ordered not healthy
 * first (`sortServiceStateItems`). Pure, for the server and its tests.
 */
export function stateItemsOf(
  rows: ReadonlyArray<{
    dimensions: Record<string, unknown>;
    dimensionLabels?: Record<string, string>;
  }>,
  binding: StateWidgetBinding,
  options: Pick<StateWidgetOptions, "states">,
): StateWidgetItem[] {
  const items = rows.map((row): StateWidgetItem => {
    const raw = row.dimensions[binding.stateDimensionId];
    const state = normalizeServiceState(raw, options.states);
    const rolled = binding.rolledBackDimensionId
      ? row.dimensions[binding.rolledBackDimensionId] === true
      : false;
    return {
      name: cut(
        row.dimensionLabels?.[binding.nameDimensionId] ??
          row.dimensions[binding.nameDimensionId],
        STATE_NAME_MAX,
      ),
      state,
      rolledBack: state === "up" && rolled,
      changedAt: binding.changedAtDimensionId
        ? cut(row.dimensions[binding.changedAtDimensionId], 40)
        : null,
      value: cut(raw, SERVICE_STATE_VALUE_MAX),
    };
  });
  return sortServiceStateItems(items);
}

/**
 * The items of a state widget (#875), not healthy first: at most the
 * list's `limit` (the single form: one), with `total` counting every
 * match. One widget never fails the dashboard: any error answers `no_data`
 * with its code.
 */
export async function queryDashboardState(
  tx: Transaction,
  workspaceId: string,
  input: {
    id: string;
    binding: StateWidgetBinding;
    options: StateWidgetOptions;
  },
  filters: DashboardDataFilter[],
  values: Record<string, DashboardFilterValue>,
  now: Date,
  defaults: DataPolicy = DEFAULT_DATA_POLICY,
  /** A paired screen's fixed scope (#500); browsers have none. */
  deviceScope: DeviceFilterScope = {},
  /** The scope of the widget's slide (#707). */
  slideScope: SlideFilterScope = {},
  /** Reads the model's sources' freshness (ADR 0025); absent: none. */
  freshnessReader?: FreshnessReader,
): Promise<StateWidgetData> {
  let fresh: WidgetFreshnessResult = { overdue: false };
  const exclusions = activeExclusions(
    filters,
    values,
    slideScope,
    input.binding.exclusions,
  );
  try {
    return await tx.transaction(async (savepoint) => {
      const release = await validateDashboardState(
        savepoint,
        workspaceId,
        filters,
        input.binding,
        slideScope,
      );
      if (freshnessReader) {
        const sources = await modelSourceDatasets(
          savepoint,
          workspaceId,
          release,
        );
        fresh = await freshnessReader.read(
          savepoint,
          await sourceFreshnessDependencies(
            savepoint,
            workspaceId,
            sources.all,
            slideScope,
            input.binding.exclusions,
            deviceScope,
            { now, defaults, cache: freshnessReader.scopeMappings },
            input.binding.filter,
            { filters, values },
          ),
        );
      }
      const { policy } = await resolveDataPolicy(
        savepoint,
        workspaceId,
        defaults,
      );
      await savepoint.execute(
        sql`select set_config('statement_timeout', ${String(policy.queryTimeoutMs ?? 0)}, true)`,
      );
      const single = input.options.layout === "single";
      const { query } = stateModelQuery(
        release.definition,
        filters,
        values,
        input.binding,
        single ? input.options.item : null,
        deviceScope,
        slideScope,
      );
      const result = await queryDataModel(
        savepoint,
        workspaceId,
        input.binding.modelId,
        query,
        now,
        policy,
        false,
        undefined,
        true,
        (definition) => stateModelWithCount(definition, input.binding),
      );
      const all = stateItemsOf(result.rows, input.binding, input.options);
      const items = all.slice(0, single ? 1 : input.options.limit);
      return {
        widgetId: input.id,
        status: items.length ? ("ok" as const) : ("no_data" as const),
        items,
        total: all.length,
        error: null,
        exclusions,
        ...(fresh.freshness ? { freshness: fresh.freshness } : {}),
      };
    });
  } catch (error) {
    rethrowWorkspaceGone(error);
    return {
      widgetId: input.id,
      status: "no_data",
      items: [],
      total: 0,
      error: safeDataError(error),
      exclusions,
      ...(fresh.freshness ? { freshness: fresh.freshness } : {}),
    };
  }
}
