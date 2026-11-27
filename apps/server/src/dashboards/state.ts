import { and, eq, inArray, sql } from "drizzle-orm";
import type {
  StateWidgetData,
  StateWidgetItem,
  StateWidgetOptions,
} from "@netrics/contracts";
import {
  isMappableServiceStateValue,
  querySemanticModel,
  serviceStateCounts,
  serviceStateKey,
  sourceItemStatus,
  stateModelQuery,
  stateQueryModel,
  DEFAULT_DATA_POLICY,
  SERVICE_STATE_OVERRIDES_MAX,
  SERVICE_STATE_TIERS,
  SERVICE_STATE_VALUE_MAX,
  type ServiceStateCounts,
  type SourceStateInput,
  type StateQueryRead,
  type DashboardDataFilter,
  type DashboardFilterValue,
  type DataPolicy,
  type DeviceFilterScope,
  type SlideFilterScope,
  type StateWidgetBinding,
} from "@netrics/domain";
import {
  notDraftConnection,
  resolveDataPolicy,
  schema,
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
import {
  modelSourceConnections,
  modelSourceDatasets,
  type ModelSourceDatasets,
} from "./model-sources.js";

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
 * Whether a model's sources leave its states out of date (#875 final
 * review, ADR 0025 section 8): a connection that fails, lost its grant or
 * last synced more than three poll intervals ago (`sourceItemStatus`)
 * still serves its last generation as if current; the widget then warns.
 */
export function stateSourcesStale(
  sources: readonly SourceStateInput[],
  now: number,
): boolean {
  return sources.some((source) => {
    const status = sourceItemStatus(source, now);
    return (
      status === "auth_failed" || status === "outage" || status === "stale"
    );
  });
}

/** The sync state of the connections a model reads (source health). */
async function stateSourceStates(
  tx: Transaction,
  workspaceId: string,
  sources: ModelSourceDatasets,
): Promise<SourceStateInput[]> {
  const connections = (await modelSourceConnections(tx, workspaceId, sources))
    .all;
  if (!connections.length) return [];
  const rows = await tx
    .select({
      setupPending: schema.connections.setupPending,
      authState: schema.connectionState.authState,
      failures: schema.connectionState.consecutiveFailures,
      lastSuccess: schema.connectionState.lastSuccessAt,
      interval: schema.connectionState.pollIntervalSeconds,
    })
    .from(schema.connections)
    .leftJoin(
      schema.connectionState,
      and(
        eq(schema.connectionState.workspaceId, workspaceId),
        eq(schema.connectionState.connectionId, schema.connections.id),
      ),
    )
    .where(
      and(
        eq(schema.connections.workspaceId, workspaceId),
        notDraftConnection(),
        inArray(schema.connections.id, connections),
      ),
    );
  return rows.map((row) => ({
    health:
      row.authState && row.authState !== "ok"
        ? (row.authState as SourceStateInput["health"])
        : (row.failures ?? 0) > 0
          ? "outage"
          : row.lastSuccess
            ? "ok"
            : "pending",
    lastSuccessAt: row.lastSuccess?.toISOString() ?? null,
    pollIntervalSeconds: row.interval ?? 300,
    setupPending: row.setupPending,
  }));
}

/** A value as text of at most `max` characters, cut with "…". */
function cut(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : String(value);
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/**
 * The source values the Studio may map (#875, #900): distinct by
 * `serviceStateKey`, at most `SERVICE_STATE_OVERRIDES_MAX`, and only those
 * an override can key in full (`isMappableServiceStateValue`), as stored,
 * so discovery, storage and normalization use the same full key.
 */
export function stateSourceValues(values: readonly unknown[]): string[] {
  const keys = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!isMappableServiceStateValue(value)) continue;
    const text = String(value);
    const key = serviceStateKey(text);
    if (keys.has(key)) continue;
    keys.add(key);
    result.push(text);
    if (result.length >= SERVICE_STATE_OVERRIDES_MAX) break;
  }
  return result;
}

/**
 * The rows of a ranked state query as widget items, in the query's order:
 * each state from the rank the query gave its group
 * (`SERVICE_STATE_TIERS`), so order, state and counts always agree. Pure,
 * for the server and its tests.
 */
export function stateItemsOf(
  rows: ReadonlyArray<{
    dimensions: Record<string, unknown>;
    dimensionLabels?: Record<string, string>;
    rank?: number;
  }>,
  binding: StateWidgetBinding,
): StateWidgetItem[] {
  return rows.map((row): StateWidgetItem => {
    const tier =
      SERVICE_STATE_TIERS[row.rank ?? -1] ??
      SERVICE_STATE_TIERS.find((entry) => entry.state === "unknown")!;
    return {
      name: cut(
        row.dimensionLabels?.[binding.nameDimensionId] ??
          row.dimensions[binding.nameDimensionId],
        STATE_NAME_MAX,
      ),
      state: tier.state,
      rolledBack: tier.rolledBack,
      changedAt: binding.changedAtDimensionId
        ? cut(row.dimensions[binding.changedAtDimensionId], 40)
        : null,
      value: cut(
        row.dimensions[binding.stateDimensionId],
        SERVICE_STATE_VALUE_MAX,
      ),
    };
  });
}

/** Items per state from a ranked query's groups per rank (#900): the
 * same grain as its items and total. */
export function stateCountsOf(
  rankCounts: Readonly<Record<number, number>> | undefined,
): ServiceStateCounts {
  const counts = serviceStateCounts([]);
  SERVICE_STATE_TIERS.forEach((tier, rank) => {
    const groups = rankCounts?.[rank] ?? 0;
    counts[tier.state] += groups;
    if (tier.rolledBack) counts.rolledBack += groups;
  });
  return counts;
}
/**
 * The items of a state widget (#875), ranked inside the query over every
 * match (no limit applies before the most urgent come first): at most the
 * list's `limit` (the single form: one), `total` counting every match,
 * `counts` the matches per state. One widget never fails the dashboard:
 * any error answers `no_data` with its code.
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
      const sources = await modelSourceDatasets(
        savepoint,
        workspaceId,
        release,
      );
      if (freshnessReader) {
        fresh = await freshnessReader.read(
          savepoint,
          await sourceFreshnessDependencies(
            savepoint,
            workspaceId,
            sources.all,
            slideScope,
            input.binding.exclusions,
            deviceScope,
            {
              now,
              defaults,
              cache: freshnessReader.scopeMappings,
              defaultLinks: sources.defaultLinks,
            },
            input.binding.filter,
            { filters, values },
          ),
        );
      }
      const sourcesStale = stateSourcesStale(
        await stateSourceStates(savepoint, workspaceId, sources),
        now.getTime(),
      );
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
            input.options.states,
          ).query,
          now,
          policy,
          false,
          undefined,
          true,
          (definition) => stateQueryModel(definition, input.binding),
        );
      // Ranked and counted inside the query, over every item (#900): the
      // most urgent items first with every item counted per state, then
      // the values the Studio can map.
      const ranked = await run({
        limit: single ? 1 : input.options.limit,
      });
      const discovered = await run({ kind: "sourceValues" });
      const items = stateItemsOf(ranked.rows, input.binding);
      return {
        widgetId: input.id,
        status: stateWidgetStatus({
          items: items.length,
          stale:
            sourcesStale || [ranked, discovered].some((read) => read.stale),
          overdue: fresh.overdue,
        }),
        items,
        total: ranked.totalRows,
        counts: stateCountsOf(ranked.rankCounts),
        sourceValues: stateSourceValues(
          discovered.rows
            .filter((row) => row.rank === 0)
            .map((row) => row.dimensions[input.binding.stateDimensionId]),
        ),
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
