import { sql } from "drizzle-orm";
import type {
  StateWidgetData,
  StateWidgetItem,
  StateWidgetOptions,
} from "@netrics/contracts";
import {
  isKnownServiceStateValue,
  normalizeServiceState,
  querySemanticModel,
  serviceStateCounts,
  serviceStateKey,
  sortServiceStateItems,
  stateModelQuery,
  stateModelWithCount,
  DEFAULT_DATA_POLICY,
  SERVICE_STATE_OVERRIDES_MAX,
  SERVICE_STATE_VALUE_MAX,
  STATE_QUERY_MAX,
  type ServiceState,
  type StateQueryRead,
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
  // One field per role: a name that is also the state would group twice
  // (review).
  const named = [
    binding.nameDimensionId,
    binding.stateDimensionId,
    binding.changedAtDimensionId,
    binding.rolledBackDimensionId,
  ].filter((id): id is string => id !== undefined);
  if (new Set(named).size !== named.length)
    throw new DataServiceError("state_dimensions_not_distinct");
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

/**
 * A state widget's status (review of #875): `stale` when its rows are a
 * last valid snapshot or a source is overdue (ADR 0025 section 8), so an
 * old "Up" never reads as current; `no_data` without items.
 */
export function stateWidgetStatus(input: {
  items: number;
  stale: boolean;
  overdue: boolean;
}): "ok" | "no_data" | "stale" {
  if (input.items === 0) return "no_data";
  return input.stale || input.overdue ? "stale" : "ok";
}

/**
 * How the items are read (review of #875): the distinct state values split
 * into those that are not up (read first; null is unknown) and those that
 * are, and the values no built-in word knows, for the Studio's mapping.
 */
export function stateReadPlan(
  values: readonly unknown[],
  overrides: Readonly<Record<string, ServiceState>>,
): {
  urgent: unknown[];
  urgentNull: boolean;
  healthy: unknown[];
  sourceValues: string[];
} {
  const urgent: unknown[] = [];
  const healthy: unknown[] = [];
  const sourceValues: string[] = [];
  const keys = new Set<string>();
  let urgentNull = false;
  for (const value of values) {
    if (value === null || value === undefined) {
      urgentNull = true;
      continue;
    }
    (normalizeServiceState(value, overrides) === "up" ? healthy : urgent).push(
      value,
    );
    if (
      !isKnownServiceStateValue(value) &&
      (typeof value === "string" || typeof value === "number") &&
      sourceValues.length < SERVICE_STATE_OVERRIDES_MAX
    ) {
      const text = cut(value, SERVICE_STATE_VALUE_MAX)!;
      const key = serviceStateKey(text);
      if (key !== "" && !keys.has(key)) {
        keys.add(key);
        sourceValues.push(text);
      }
    }
  }
  return { urgent, urgentNull, healthy, sourceValues };
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
      const run = (read: StateQueryRead) =>
        queryDataModel(
          savepoint,
          workspaceId,
          input.binding.modelId,
          stateModelQuery(
            release.definition,
            filters,
            values,
            input.binding,
            single ? input.options.item : null,
            deviceScope,
            slideScope,
            read,
          ).query,
          now,
          policy,
          false,
          undefined,
          true,
          (definition) => stateModelWithCount(definition, input.binding),
        );
      // Ranked before the read limit (review): the distinct state values
      // first, then the items in a state that is not up, then the rest, so
      // no outage falls past STATE_QUERY_MAX behind healthy items.
      const distinct = await run({ statesOnly: true });
      const plan = stateReadPlan(
        distinct.rows.map(
          (row) => row.dimensions[input.binding.stateDimensionId],
        ),
        input.options.states,
      );
      const urgent =
        plan.urgent.length || plan.urgentNull
          ? await run({
              stateValues: plan.urgent,
              includeNull: plan.urgentNull,
            })
          : null;
      const room = STATE_QUERY_MAX - (urgent?.rows.length ?? 0);
      const healthy = plan.healthy.length
        ? await run({ stateValues: plan.healthy, limit: Math.max(1, room) })
        : null;
      const all = stateItemsOf(
        [...(urgent?.rows ?? []), ...(room > 0 ? (healthy?.rows ?? []) : [])],
        input.binding,
        input.options,
      );
      const counts = serviceStateCounts(all);
      // Healthy items past the read limit are up all the same.
      counts.up += Math.max(
        0,
        (healthy?.totalRows ?? 0) -
          (room > 0 ? (healthy?.rows.length ?? 0) : 0),
      );
      const items = all.slice(0, single ? 1 : input.options.limit);
      return {
        widgetId: input.id,
        status: stateWidgetStatus({
          items: items.length,
          stale: [distinct, urgent, healthy].some((read) => read?.stale),
          overdue: fresh.overdue,
        }),
        items,
        total: (urgent?.totalRows ?? 0) + (healthy?.totalRows ?? 0),
        counts,
        sourceValues: plan.sourceValues,
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
      counts: serviceStateCounts([]),
      sourceValues: [],
      error: safeDataError(error),
      exclusions,
      ...(fresh.freshness ? { freshness: fresh.freshness } : {}),
    };
  }
}
