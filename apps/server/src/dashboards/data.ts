import { and, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import {
  dashboardDataFiltersSchema,
  dashboardFilterExclusionSchema,
  itemsWidgetBindingSchema,
  itemsWidgetOptionsSchema,
  stateWidgetBindingSchema,
  stateWidgetOptionsSchema,
  measureWidgetBindingSchema,
  measureWidgetOptionsSchema,
  semanticModelDefinitionSchema,
  slideFilterScopeSchema,
  type DashboardWidgetData,
} from "@netrics/contracts";
import {
  dashboardModelQuery,
  measureQueryOrder,
  measureSplitTotals,
  measurePeriodBinding,
  compareMeasureWindows,
  measureViewWindow,
  compareDataValues,
  dimensionValueLabels,
  dataKey,
  formatDataDate,
  measureInteractionDimension,
  measureIsPercentChange,
  measureLookbackDays,
  measurePerDateDimensions,
  measureRequiredDimensions,
  measureTypeProbe,
  querySemanticModel,
  validateMeasureView,
  DataProcessingError,
  DEFAULT_DATA_POLICY,
  type DataCell,
  type DataField,
  type SemanticModelDefinition,
  type DataPolicy,
  type DashboardDataFilter,
  type DashboardFilterExclusion,
  type DashboardFilterValue,
  type DeviceFilterScope,
  type MeasureWidgetBinding,
  type SlideFilterScope,
  followsSlideScopeResource,
  measureResultDimensions,
  measureBindingGrains,
  measureFixedGrainDimensions,
  modelMeasureFixedGrainDimensions,
  unsupportedMeasureGrain,
  type ProductApps,
  slideScopeResource,
  RESOURCE_DIMENSION,
} from "@netrics/domain";
import {
  schema,
  findWorkspace,
  resolveDataPolicy,
  type Transaction,
  type DashboardWidgetRow,
  projectFilterSql,
  type ProjectFilter,
  notDraftConnection,
  collectsNoResources,
  rethrowWorkspaceGone,
} from "@netrics/database";
import {
  createDataLoader,
  queryDataModel,
  DataServiceError,
} from "../data/service.js";
import {
  mappedProductApps,
  sourceFreshnessDependencies,
  type ScopeMappingCache,
  type ScopeRead,
  type FreshnessReader,
  type WidgetFreshnessResult,
} from "./freshness.js";
import { queryDashboardItems } from "./items.js";
import { queryDashboardState } from "./state.js";
import {
  modelSourceConnections,
  modelSourceDatasets,
  publishedReleases,
  releasesSourceDatasets,
  type ModelRelease,
  type ModelSourceDatasets,
} from "./model-sources.js";

export async function publishedModel(
  tx: Transaction,
  workspaceId: string,
  modelId: string,
) {
  const [row] = await tx
    .select({ name: schema.dataModels.name, release: schema.dataModelReleases })
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
  if (!row) throw new DataServiceError("data_model_not_published", 404);
  const definition = semanticModelDefinitionSchema.parse(
    row.release.definition,
  );
  const bindings = row.release.schemaBindings as Record<string, DataField[]>;
  const dimensions = definition.dimensions.map((dimension) => {
    const field = bindings[dimension.datasetId]?.find(
      (field) => field.id === dimension.fieldId,
    );
    if (!field) throw new DataServiceError("data_model_schema_changed", 409);
    return {
      id: dimension.id,
      name: dimension.name,
      type: field.type,
      // An image URL field (#810): what a latest-items widget shows.
      ...(field.role === "image" ? { role: "image" as const } : {}),
    };
  });
  // One probe for every measure's unit (#835).
  const units = measureUnits(definition, bindings);
  return {
    definition,
    dependencies: row.release.dependencies as {
      prepared: Record<string, number>;
    },
    bindings,
    metadata: {
      modelId,
      modelName: row.name,
      measures: definition.measures.map((measure) => {
        const { id, name } = measure;
        const requiredDimensions = measureRequiredDimensions(definition, [id]);
        const perDateDimensions = measurePerDateDimensions(definition, [id]);
        const fixedGrainDimensions = modelMeasureFixedGrainDimensions(
          definition,
          [id],
        );
        const unit = units.get(id);
        return {
          id,
          name,
          ...(requiredDimensions.length ? { requiredDimensions } : {}),
          ...(perDateDimensions.length ? { perDateDimensions } : {}),
          ...(fixedGrainDimensions.length ? { fixedGrainDimensions } : {}),
          ...(measureIsPercentChange(definition, id)
            ? { percentChange: true as const }
            : {}),
          ...(unit ? { unit } : {}),
        };
      }),
      dimensions,
    },
  };
}
/**
 * The unit each of a model's measures carries (#835), by the model's
 * static type probe of its published schema: one probe for every measure;
 * only when it refuses one, each on its own. An amount of money reads
 * "currency": screens show its currency, never a unit's words. Undefined:
 * none, or a measure the probe refuses (a query then says why).
 */
export function measureUnits(
  definition: SemanticModelDefinition,
  bindings: Record<string, DataField[]>,
  probe: typeof measureTypeProbe = measureTypeProbe,
): Map<string, string | undefined> {
  const tables = new Map(
    Object.entries(bindings).map(([dataset, fields]) => [dataset, { fields }]),
  );
  const ids = definition.measures.map((measure) => measure.id);
  const unitOf = (cell: DataCell | undefined) =>
    cell?.currency || cell?.unit === "currency" ? "currency" : cell?.unit;
  try {
    const cells = probe(definition, tables, ids);
    return new Map(ids.map((id) => [id, unitOf(cells.get(id))]));
  } catch (caught) {
    rethrowWorkspaceGone(caught);
    return new Map(
      ids.map((id) => {
        try {
          return [id, unitOf(probe(definition, tables, [id]).get(id))];
        } catch (caught) {
          rethrowWorkspaceGone(caught);
          return [id, undefined];
        }
      }),
    );
  }
}
export async function publishedModels(
  tx: Transaction,
  workspaceId: string,
  /** Narrows to a project (#572); absent: every published model. */
  filter: ProjectFilter = {},
) {
  const rows = await tx
    .select({ id: schema.dataModels.id })
    .from(schema.dataModels)
    .where(
      and(
        eq(schema.dataModels.workspaceId, workspaceId),
        sql`${schema.dataModels.publishedVersion} is not null`,
        projectFilterSql(schema.dataModels.projectId, workspaceId, filter),
      ),
    );
  const models = [];
  for (const row of rows)
    models.push((await publishedModel(tx, workspaceId, row.id)).metadata);
  return { models };
}
export function safeDataError(error: unknown): string {
  return error instanceof DataServiceError ||
    error instanceof DataProcessingError
    ? error.code
    : "data_storage_failed";
}

/**
 * The health of each connection a model reads, once per connection: those
 * it binds and those its preparations read, as its freshness resolves them
 * (#721).
 */
async function modelSourceHealth(
  tx: Transaction,
  workspaceId: string,
  sources: ModelSourceDatasets,
): Promise<NonNullable<DashboardWidgetData["sourceHealth"]>> {
  const connections = (await modelSourceConnections(tx, workspaceId, sources))
    .all;
  if (!connections.length) return [];
  const rows = await tx
    .select({
      id: schema.connections.id,
      name: schema.connections.name,
      // Collects nothing: an explicit empty selection (#782).
      paused: collectsNoResources(
        sql`${schema.connections.config}`,
        sql`${schema.connections.connectorId}`,
      ).mapWith(Boolean),
      setupPending: schema.connections.setupPending,
      authState: schema.connectionState.authState,
      failures: schema.connectionState.consecutiveFailures,
      lastSuccess: schema.connectionState.lastSuccessAt,
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
  return rows.map((row) => {
    const status: NonNullable<
      DashboardWidgetData["sourceHealth"]
    >[number]["status"] =
      row.authState && row.authState !== "ok"
        ? (row.authState as "auth_failed" | "needs_reauthorization" | "outage")
        : row.paused
          ? "paused"
          : (row.failures ?? 0) > 0
            ? "outage"
            : row.setupPending || !row.lastSuccess
              ? "pending"
              : "ok";
    return {
      connectionId: row.id,
      name: row.name,
      status,
      lastSuccessAt: row.lastSuccess?.toISOString() ?? null,
    };
  });
}
/**
 * A model-bound widget's filter mappings against its published model's
 * dimensions: a filter mapped to a dimension of another type than the
 * filter's is refused (`dashboard_filter_type_changed`). Measure and
 * latest-items widgets (#810) share it.
 */
export function checkFilterMappings(
  filters: readonly DashboardDataFilter[],
  modelId: string,
  dimensions: ReadonlyArray<{ id: string; type: string }>,
): void {
  for (const filter of filters) {
    const mapping = filter.mappings.find(
      (mapping) => mapping.modelId === modelId,
    );
    if (
      mapping &&
      dimensions.find((dimension) => dimension.id === mapping.dimensionId)
        ?.type !== filter.type
    )
      throw new DataServiceError("dashboard_filter_type_changed");
  }
}

/**
 * The exclusions a model-bound widget lists: those that leave out a filter
 * with a choice (its value or default, its fixed value, or the slide's
 * scope). Measure and latest-items widgets (#810) share it.
 */
export function activeExclusions(
  filters: readonly DashboardDataFilter[],
  values: Readonly<Record<string, DashboardFilterValue>>,
  slideScope: SlideFilterScope,
  exclusions: readonly DashboardFilterExclusion[],
): DashboardFilterExclusion[] {
  return exclusions.filter((exclusion) => {
    const filter = filters.find((filter) => filter.id === exclusion.filterId);
    if (!filter) return false;
    const value = Object.hasOwn(values, filter.id)
      ? values[filter.id]
      : filter.defaultValue;
    const slide = Object.hasOwn(slideScope, filter.id)
      ? slideScope[filter.id]
      : undefined;
    return [value, filter.fixedValue, slide].some(
      (value) =>
        value &&
        (value.kind === "values"
          ? value.values.length > 0
          : value.from !== null || value.to !== null),
    );
  });
}

/** A measure widget's options, as stored (view, limit, a table's order). */
type MeasureWidgetOptions = z.output<typeof measureWidgetOptionsSchema>;
export async function validateDashboardMeasure(
  tx: Transaction,
  workspaceId: string,
  filters: DashboardDataFilter[],
  input: MeasureWidgetBinding,
  options: MeasureWidgetOptions,
  /** The scope of the widget's slide (#707): a range there can give a
   * window its period. */
  slideScope: SlideFilterScope = {},
): Promise<{
  metadata: Awaited<ReturnType<typeof publishedModel>>["metadata"];
  /** The binding as it is stored. */
  binding: MeasureWidgetBinding;
}> {
  validateMeasureView(options.view, input);
  const model = await publishedModel(tx, workspaceId, input.modelId);
  // Time grains in their one stored form (#838): "day" on a date is none.
  const binding = measureBindingGrains(input, model.metadata);
  // A grain may not bucket a dimension its measures are read per value of:
  // the rule Studio offers its choices by.
  const unsupported = unsupportedMeasureGrain(
    binding,
    model.metadata.dimensions,
    measureFixedGrainDimensions(model.metadata.measures, binding.measureIds),
  );
  if (unsupported !== undefined)
    throw new DataServiceError("dashboard_measure_grain_unsupported");
  // A declared click target must be a filter this widget follows, on a
  // dimension it is grouped by; otherwise clicking would silently do nothing.
  if (binding.interaction)
    measureInteractionDimension(filters, binding, options.view);
  // A widget's own period (#784) reads the model's reporting-date dimension.
  if (
    options.period &&
    !model.definition.dimensions.some(
      (dimension) => dimension.timeAlignment === "reporting_date",
    )
  )
    throw new DataServiceError("dashboard_measure_period_unsupported");
  checkFilterMappings(filters, binding.modelId, model.metadata.dimensions);
  // Windows read one date range. A list filter on their date can select
  // several dates or "no date", which no window can read, so refuse it here
  // rather than on every viewer's query. Range filters always give a range;
  // a viewer clearing one is a per-widget state (see queryDashboardMeasure).
  const windowDimensions = new Set(
    measureLookbackDays(model.definition, binding.measureIds).keys(),
  );
  if (
    windowDimensions.size &&
    filters.some(
      (filter) =>
        filter.mode === "values" &&
        !binding.exclusions.some(
          (exclusion) => exclusion.filterId === filter.id,
        ) &&
        filter.mappings.some(
          (mapping) =>
            mapping.modelId === binding.modelId &&
            windowDimensions.has(mapping.dimensionId),
        ),
    )
  )
    throw new DataServiceError("dashboard_filter_window_unsupported");
  const query = dashboardModelQuery(
    filters,
    {},
    binding,
    options.limit,
    "first",
    {},
    slideScope,
    // An order the binding or view no longer fits is ignored (#768).
    measureQueryOrder(binding, options),
  );
  // Validate the shape and filter paths using the published schema, even with no current rows.
  const tables = new Map(
    Object.entries(model.bindings).map(([id, fields]) => [
      id,
      { fields, rows: [] },
    ]),
  );
  querySemanticModel(model.definition, tables, query);
  if (options.view === "bar" || options.view === "line") {
    // The model's own static probe: types, units and currencies as queries
    // return them, without a grain or the time grouping windows need.
    const measureId = binding.measureIds[0]!;
    const measure = measureTypeProbe(model.definition, tables, [measureId]).get(
      measureId,
    );
    if (measure && !["integer", "number", "decimal"].includes(measure.type))
      throw new DataServiceError("dashboard_measure_numeric_required");
    if (options.view === "line") {
      const dimension = model.metadata.dimensions.find(
        (dimension) => dimension.id === binding.groupBy[0],
      );
      if (
        !dimension ||
        (dimension.type !== "date" && dimension.type !== "timestamp")
      )
        throw new DataServiceError("dashboard_measure_time_required");
    }
  }
  return { metadata: model.metadata, binding };
}
/**
 * A stored slide's scope (#707). Saves validate it against the dashboard's
 * filters; the column holds a JSON object (a check constraint), so only a
 * scope that no longer parses reads as none.
 */
export function slideScopeOf(slide: {
  scope?: unknown;
}): z.infer<typeof slideFilterScopeSchema> {
  return slideFilterScopeSchema.safeParse(slide.scope ?? {}).data ?? {};
}

/**
 * What product scopes are resolved with, the same wherever a dashboard is
 * read, saved or sent to a screen: the deployment's data policy
 * (NETRICS_DATA_POLICY; the workspace's own overrides are resolved on
 * top) and its clock. Absent: the built-in defaults and the system clock.
 */
export interface ProductScopeInputs {
  policy?: DataPolicy | undefined;
  now?: (() => Date) | undefined;
}

/** The models a dashboard's shared filters map to, each once. */
export function mappedModelIds(
  filters: readonly DashboardDataFilter[],
): string[] {
  return [
    ...new Set(
      filters.flatMap((filter) =>
        filter.mappings.map((mapping) => mapping.modelId),
      ),
    ),
  ];
}

/**
 * The member apps of the linked products a dashboard's slide scopes can
 * name (#777), for connection widgets, which have no model of their own:
 * a `product:<id>` is a value of a shared filter, so it is resolved through
 * the models the dashboard's filters map to (`modelIds`), exactly as a
 * measure widget's freshness resolves it (mappedProductApps: the
 * store-template install's mapping table among a model's datasets).
 * Another install's mapping, which none of these models reads, never
 * counts. The releases and their preparations are each one query, or
 * none with `releases`, which a shown dashboard has read already (#835).
 * `only` narrows it to those products; without any to resolve nothing is
 * read. A model or mapping that cannot be read resolves nothing (the
 * widgets then show every app, as without the scope), and the
 * transaction's statement timeout is left as it was.
 *
 * The one entry point of the dashboard read, save validation, the
 * Studio's route and the device payload: each passes the deployment's
 * policy and clock (`ProductScopeInputs`), so a mapping one of them cannot
 * read under the configured limits is one none of them resolves.
 */
export async function dashboardProductApps(
  tx: Transaction,
  workspaceId: string,
  modelIds: readonly string[],
  inputs: ProductScopeInputs,
  options: {
    /** Only these products; none: nothing is read. */
    only?: ReadonlySet<string>;
    /** The models' published releases, when read already (#835). */
    releases?: ReadonlyMap<string, ModelRelease>;
    /** The mapping tables the response has read (a device payload). */
    cache?: ScopeMappingCache;
  } = {},
): Promise<Map<string, string[]>> {
  const { only, releases } = options;
  const read: ScopeRead = {
    now: inputs.now?.() ?? new Date(),
    ...(inputs.policy ? { defaults: inputs.policy } : {}),
    ...(options.cache ? { cache: options.cache } : {}),
  };
  if (!modelIds.length || only?.size === 0) return new Map();
  try {
    return await tx.transaction(async (savepoint) => {
      const found =
        releases ?? (await publishedReleases(savepoint, workspaceId, modelIds));
      const ids = await releasesSourceDatasets(
        savepoint,
        workspaceId,
        modelIds.flatMap((id) => {
          const release = found.get(id);
          return release ? [release] : [];
        }),
      );
      const [{ timeout } = { timeout: "0" }] = await savepoint.execute<{
        timeout: string;
      }>(sql`select current_setting('statement_timeout') as timeout`);
      const apps = await mappedProductApps(savepoint, workspaceId, ids, read);
      await savepoint.execute(
        sql`select set_config('statement_timeout', ${timeout}, true)`,
      );
      return new Map(
        [...apps].filter(([product]) => !only || only.has(product)),
      );
    });
  } catch (caught) {
    rethrowWorkspaceGone(caught);
    return new Map();
  }
}

/**
 * A slide's widgets as screens read them (#707): a metric, line, bar, table
 * or review widget that follows the slide's scope reads the resource the
 * scope names (slideScopeResource), a linked product's member app of its
 * connection through `apps` (#777). Others, and widgets whose scope would
 * conflict with their own resource (refused on save), are unchanged.
 */
export function slideScopedWidgets(
  slide: {
    scope?: unknown;
    widgets: readonly DashboardWidgetRow[];
  },
  apps?: ProductApps,
): DashboardWidgetRow[] {
  const scope = slideScopeOf(slide);
  if (!Object.keys(scope).length) return [...slide.widgets];
  return slide.widgets.map((widget) => {
    if (!followsSlideScopeResource(widget.type) || !widget.connectionId)
      return widget;
    const dimensions = widget.dimensions as Record<string, string>;
    const scoped = slideScopeResource(
      scope,
      widget.connectionId,
      exclusionsSchema.safeParse(widget.filterExclusions).data ?? [],
      dimensions[RESOURCE_DIMENSION],
      apps,
    );
    return scoped.resource !== undefined && !scoped.conflict
      ? {
          ...widget,
          dimensions: { ...dimensions, [RESOURCE_DIMENSION]: scoped.resource },
        }
      : widget;
  });
}
const exclusionsSchema = dashboardFilterExclusionSchema.array();

export async function queryDashboardMeasure(
  tx: Transaction,
  workspaceId: string,
  input: {
    id: string;
    binding: MeasureWidgetBinding;
    options: MeasureWidgetOptions;
  },
  filters: DashboardDataFilter[],
  values: Record<string, DashboardFilterValue>,
  now: Date,
  defaults: DataPolicy = DEFAULT_DATA_POLICY,
  locale: "en" | "de" = "en",
  /** A paired screen's fixed scope (#500); browsers have none. */
  deviceScope: DeviceFilterScope = {},
  /** The scope of the widget's slide (#707). */
  slideScope: SlideFilterScope = {},
  /** Reads the model's sources' freshness (ADR 0025); absent: none. */
  freshnessReader?: FreshnessReader,
): Promise<DashboardWidgetData> {
  let sourceHealth: DashboardWidgetData["sourceHealth"];
  let fresh: WidgetFreshnessResult = { overdue: false };
  const exclusions = activeExclusions(
    filters,
    values,
    slideScope,
    input.binding.exclusions,
  );
  try {
    return await tx.transaction(async (savepoint) => {
      const { metadata } = await validateDashboardMeasure(
        savepoint,
        workspaceId,
        filters,
        input.binding,
        input.options,
        slideScope,
      );
      // One resolution of the model's sources for its warnings and its
      // freshness, so both name the same connections (#721).
      const release = await publishedModel(
        savepoint,
        workspaceId,
        input.binding.modelId,
      );
      const sources = await modelSourceDatasets(
        savepoint,
        workspaceId,
        release,
      );
      sourceHealth = await modelSourceHealth(savepoint, workspaceId, sources);
      if (freshnessReader)
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
      const { policy } = await resolveDataPolicy(
        savepoint,
        workspaceId,
        defaults,
      );
      await savepoint.execute(
        sql`select set_config('statement_timeout', ${String(policy.queryTimeoutMs ?? 0)}, true)`,
      );
      // The widget's own period (#784): the workspace's days, as
      // connection widgets read theirs.
      const binding = input.options.period
        ? measurePeriodBinding(
            input.binding,
            release.definition.dimensions,
            compareMeasureWindows(
              input.options.period,
              now,
              (await findWorkspace(savepoint, workspaceId))?.timeZone ?? "UTC",
            ).current,
          )
        : input.binding;
      const query = dashboardModelQuery(
        filters,
        values,
        binding,
        input.options.limit,
        measureViewWindow(
          input.options.view,
          metadata.dimensions.find(
            (dimension) => dimension.id === input.binding.groupBy[0],
          )?.type,
        ),
        deviceScope,
        slideScope,
        measureQueryOrder(input.binding, input.options),
      );
      const result = await queryDataModel(
        savepoint,
        workspaceId,
        input.binding.modelId,
        query,
        now,
        policy,
      );
      if (input.options.view === "bar" || input.options.view === "line") {
        const currencies = new Set(
          result.rows.flatMap((row) =>
            Object.values(row.measures).flatMap((cell) =>
              cell.value !== null && cell.currency ? [cell.currency] : [],
            ),
          ),
        );
        if (currencies.size > 1)
          throw new DataServiceError("dashboard_measure_currency_incompatible");
      }
      // Days in the locale's date format (#619); a timestamp has no viewer
      // time zone here, so it reads in UTC and says so.
      const shown = (type: string, value: unknown): string => {
        const date = formatDataDate(value, type, locale, "UTC");
        return date === null
          ? String(value)
          : type === "timestamp"
            ? `${date} UTC`
            : date;
      };
      const selection = (
        type: string,
        value: DashboardFilterValue | undefined,
        dimensionId?: string,
      ): string =>
        !value
          ? ""
          : value.kind === "range"
            ? value.from === null && value.to === null
              ? ""
              : `${value.from == null ? "…" : shown(type, value.from)} – ${value.to == null ? "…" : shown(type, value.to)}`
            : value.values
                .map(
                  (value) =>
                    result.filterValueLabels?.find(
                      (entry) =>
                        entry.dimensionId === dimensionId &&
                        JSON.stringify(entry.value) === JSON.stringify(value),
                    )?.label ??
                    (value === null
                      ? "—"
                      : typeof value === "boolean"
                        ? locale === "de"
                          ? value
                            ? "Wahr"
                            : "Falsch"
                          : value
                            ? "True"
                            : "False"
                        : shown(type, value)),
                )
                .join(", ");
      const scope = filters
        .filter(
          (filter) =>
            !input.binding.exclusions.some(
              (exclusion) => exclusion.filterId === filter.id,
            ),
        )
        .flatMap((filter) => {
          const dimensionId = filter.mappings.find(
            (mapping) => mapping.modelId === input.binding.modelId,
          )?.dimensionId;
          const chosen = selection(
              filter.type,
              Object.hasOwn(values, filter.id)
                ? values[filter.id]
                : filter.defaultValue,
              dimensionId,
            ),
            fixed = selection(filter.type, filter.fixedValue, dimensionId),
            screen = selection(
              filter.type,
              Object.hasOwn(deviceScope, filter.id)
                ? deviceScope[filter.id]
                : undefined,
              dimensionId,
            ),
            slide = selection(
              filter.type,
              Object.hasOwn(slideScope, filter.id)
                ? slideScope[filter.id]
                : undefined,
              dimensionId,
            );
          const text = [chosen, fixed, screen, slide]
            .filter(Boolean)
            .join(" ∩ ");
          return text ? [`${filter.name}: ${text}`] : [];
        });
      // A value view with a grouping: its total with the split (#784).
      const totals =
        input.options.view === "value" && input.binding.groupBy.length
          ? measureSplitTotals(
              release.definition.measures.find(
                (measure) => measure.id === input.binding.measureIds[0],
              ),
              input.binding.measureIds[0]!,
              result,
            )
          : undefined;
      const status = result.stale
        ? ("stale" as const)
        : result.rows.some((row) =>
              Object.values(row.measures).some((cell) => cell.value !== null),
            )
          ? ("ok" as const)
          : ("no_data" as const);
      return {
        sourceHealth,
        scope,
        // A provider overdue by a day is the existing warning (ADR 0025 §7).
        status: status === "ok" && fresh.overdue ? "stale" : status,
        widgetId: input.id,
        // A dimension grouped by a time grain holds dates (#838).
        metadata: {
          ...metadata,
          dimensions: measureResultDimensions(
            metadata.dimensions,
            input.binding,
          ),
        },
        result,
        error: null,
        exclusions,
        ...(fresh.freshness ? { freshness: fresh.freshness } : {}),
        ...(totals ? { totals } : {}),
      };
    });
  } catch (error) {
    rethrowWorkspaceGone(error);
    const code = safeDataError(error);
    return {
      ...(sourceHealth ? { sourceHealth } : {}),
      // A comparison over the selected period has nothing to compare while
      // the viewer's date range is open: no data for this filter, not an
      // outage of its sources.
      status:
        code === "model_window_time_range_required" ? "no_data" : "outage",
      widgetId: input.id,
      metadata: null,
      result: null,
      error: code,
      exclusions,
      ...(fresh.freshness ? { freshness: fresh.freshness } : {}),
    };
  }
}
export async function queryDashboardData(
  tx: Transaction,
  workspaceId: string,
  /** The slides' widgets, each with its slide's scope (#707). */
  slides: readonly {
    scope: unknown;
    widgets: readonly DashboardWidgetRow[];
  }[],
  rawFilters: unknown,
  values: Record<string, DashboardFilterValue>,
  now: Date,
  defaults?: DataPolicy,
  locale: "en" | "de" = "en",
  /** Reads the widgets' freshness (ADR 0025); absent: none. */
  freshnessReader?: FreshnessReader,
) {
  const filters = dashboardDataFiltersSchema.parse(rawFilters);
  const ids = new Set(filters.map((filter) => filter.id));
  if (Object.keys(values).some((key) => !ids.has(key)))
    throw new DataServiceError("dashboard_filter_unknown");
  const results = [];
  const items = [];
  const states = [];
  for (const slide of slides)
    for (const widget of slide.widgets) {
      if (widget.type === "state") {
        states.push(
          await queryDashboardState(
            tx,
            workspaceId,
            {
              id: widget.id,
              binding: stateWidgetBindingSchema.parse(widget.modelBinding),
              options: stateWidgetOptionsSchema.parse(widget.options),
            },
            filters,
            values,
            now,
            defaults,
            {},
            slideScopeOf(slide),
            freshnessReader,
          ),
        );
        continue;
      }
      if (widget.type === "items") {
        items.push(
          await queryDashboardItems(
            tx,
            workspaceId,
            {
              id: widget.id,
              binding: itemsWidgetBindingSchema.parse(widget.modelBinding),
              options: itemsWidgetOptionsSchema.parse(widget.options),
            },
            filters,
            values,
            now,
            defaults,
            {},
            slideScopeOf(slide),
            freshnessReader,
          ),
        );
        continue;
      }
      if (widget.type !== "measure") continue;
      results.push(
        await queryDashboardMeasure(
          tx,
          workspaceId,
          {
            id: widget.id,
            binding: measureWidgetBindingSchema.parse(widget.modelBinding),
            options: measureWidgetOptionsSchema.parse(widget.options),
          },
          filters,
          values,
          now,
          defaults,
          locale,
          {},
          slideScopeOf(slide),
          freshnessReader,
        ),
      );
    }
  return {
    widgets: results,
    items,
    states,
    values: Object.fromEntries(
      filters.map((filter) => [
        filter.id,
        Object.hasOwn(values, filter.id)
          ? values[filter.id]!
          : filter.defaultValue,
      ]),
    ),
  };
}

export async function dashboardDimensionValues(
  tx: Transaction,
  workspaceId: string,
  modelId: string,
  dimensionId: string,
  input: { search: string; offset: number; limit: number },
  now: Date,
  defaults = DEFAULT_DATA_POLICY,
) {
  const model = await publishedModel(tx, workspaceId, modelId);
  const dimension = model.definition.dimensions.find(
    (dimension) => dimension.id === dimensionId,
  );
  if (!dimension) throw new DataServiceError("model_dimension_not_found", 404);
  const { policy } = await resolveDataPolicy(tx, workspaceId, defaults);
  await tx.execute(
    sql`select set_config('statement_timeout', ${String(policy.queryTimeoutMs ?? 0)}, true)`,
  );
  const loader = createDataLoader(tx, workspaceId, now, {
    policy,
    dependencies: model.dependencies,
    allowPendingResults: true,
  });
  const table = await loader.load(dimension.datasetId);
  const field = table.fields.find((field) => field.id === dimension.fieldId);
  if (
    !field ||
    field.type !==
      model.metadata.dimensions.find((field) => field.id === dimensionId)?.type
  )
    throw new DataServiceError("data_model_schema_changed", 409);
  if (field.type === "json")
    throw new DataServiceError("model_dimension_json_unsupported");
  const labels = dimensionValueLabels(dimension, table, loader.budget);
  const unique = new Map<string, { value: unknown; label: string }>(),
    search = input.search.toLowerCase();
  for (const row of table.rows) {
    loader.budget.tick();
    const value = row[dimension.fieldId] ?? null;
    const label =
      labels.get(dataKey(table.fields, row, [dimension.fieldId])) ??
      String(value ?? "");
    if (
      !search ||
      String(value ?? "")
        .toLowerCase()
        .includes(search) ||
      label.toLowerCase().includes(search)
    )
      unique.set(JSON.stringify(value), { value, label });
  }
  const values = [...unique.values()].sort(({ value: a }, { value: b }) =>
    a === null
      ? b === null
        ? 0
        : 1
      : b === null
        ? -1
        : compareDataValues(field.type, a, b),
  );
  return {
    values: values
      .slice(input.offset, input.offset + input.limit)
      .map((entry) => entry.value),
    ...(dimension.labelFieldId
      ? {
          labels: values
            .slice(input.offset, input.offset + input.limit)
            .map((entry) => entry.label),
        }
      : {}),
    total: values.length,
    offset: input.offset,
  };
}
