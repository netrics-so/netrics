import { and, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import {
  dashboardDataFiltersSchema,
  dashboardFilterExclusionSchema,
  measureWidgetBindingSchema,
  measureWidgetOptionsSchema,
  semanticModelDefinitionSchema,
  slideFilterScopeSchema,
  type DashboardWidgetData,
} from "@netrics/contracts";
import {
  dashboardModelQuery,
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
  type DataField,
  type DataPolicy,
  type DashboardDataFilter,
  type DashboardFilterValue,
  type DeviceFilterScope,
  type MeasureWidgetBinding,
  type SlideFilterScope,
  followsSlideScopeResource,
  slideScopeResource,
  RESOURCE_DIMENSION,
} from "@netrics/domain";
import {
  schema,
  resolveDataPolicy,
  type Transaction,
  type DashboardWidgetRow,
  projectFilterSql,
  type ProjectFilter,
} from "@netrics/database";
import {
  createDataLoader,
  queryDataModel,
  DataServiceError,
} from "../data/service.js";
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
    return { id: dimension.id, name: dimension.name, type: field.type };
  });
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
        return {
          id,
          name,
          ...(requiredDimensions.length ? { requiredDimensions } : {}),
          ...(perDateDimensions.length ? { perDateDimensions } : {}),
          ...(measureIsPercentChange(definition, id)
            ? { percentChange: true as const }
            : {}),
        };
      }),
      dimensions,
    },
  };
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
      config: schema.connections.config,
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
        inArray(schema.connections.id, connections),
      ),
    );
  return rows.map((row) => {
    const selection = (row.config as Record<string, unknown>).resourceSelection;
    const status: NonNullable<
      DashboardWidgetData["sourceHealth"]
    >[number]["status"] =
      row.authState && row.authState !== "ok"
        ? (row.authState as "auth_failed" | "needs_reauthorization" | "outage")
        : Array.isArray(selection) && selection.length === 0
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
export async function validateDashboardMeasure(
  tx: Transaction,
  workspaceId: string,
  filters: DashboardDataFilter[],
  binding: MeasureWidgetBinding,
  options: { view: "value" | "table" | "bar" | "line"; limit: number },
  /** The scope of the widget's slide (#707): a range there can give a
   * window its period. */
  slideScope: SlideFilterScope = {},
) {
  validateMeasureView(options.view, binding);
  // A declared click target must be a filter this widget follows, on a
  // dimension it is grouped by; otherwise clicking would silently do nothing.
  if (binding.interaction)
    measureInteractionDimension(filters, binding, options.view);
  const model = await publishedModel(tx, workspaceId, binding.modelId);
  for (const filter of filters) {
    const mapping = filter.mappings.find(
      (mapping) => mapping.modelId === binding.modelId,
    );
    if (
      mapping &&
      model.metadata.dimensions.find(
        (dimension) => dimension.id === mapping.dimensionId,
      )?.type !== filter.type
    )
      throw new DataServiceError("dashboard_filter_type_changed");
  }
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
  return model.metadata;
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
 * A slide's widgets as screens read them (#707): a metric, line, bar, table
 * or review widget that follows the slide's scope reads the resource the
 * scope names (slideScopeResource). Others, and widgets whose scope would
 * conflict with their own resource (refused on save), are unchanged.
 */
export function slideScopedWidgets(slide: {
  scope?: unknown;
  widgets: readonly DashboardWidgetRow[];
}): DashboardWidgetRow[] {
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
    options: { view: "value" | "table" | "bar" | "line"; limit: number };
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
  const exclusions = input.binding.exclusions.filter((exclusion) => {
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
  try {
    return await tx.transaction(async (savepoint) => {
      const metadata = await validateDashboardMeasure(
        savepoint,
        workspaceId,
        filters,
        input.binding,
        input.options,
        slideScope,
      );
      // One resolution of the model's sources for its warnings and its
      // freshness, so both name the same connections (#721).
      const sources = await modelSourceDatasets(
        savepoint,
        workspaceId,
        await publishedModel(savepoint, workspaceId, input.binding.modelId),
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
      const query = dashboardModelQuery(
        filters,
        values,
        input.binding,
        input.options.limit,
        measureViewWindow(
          input.options.view,
          metadata.dimensions.find(
            (dimension) => dimension.id === input.binding.groupBy[0],
          )?.type,
        ),
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
        metadata,
        result,
        error: null,
        exclusions,
        ...(fresh.freshness ? { freshness: fresh.freshness } : {}),
      };
    });
  } catch (error) {
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
  for (const slide of slides)
    for (const widget of slide.widgets) {
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
