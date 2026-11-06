import { and, eq, sql } from "drizzle-orm";
import {
  dashboardDataFiltersSchema,
  measureWidgetBindingSchema,
  measureWidgetOptionsSchema,
  semanticModelDefinitionSchema,
  type DashboardWidgetData,
} from "@netrics/contracts";
import {
  dashboardModelQuery,
  compareDataValues,
  querySemanticModel,
  validateMeasureView,
  DataProcessingError,
  DEFAULT_DATA_POLICY,
  type DataField,
  type DataPolicy,
  type DashboardDataFilter,
  type DashboardFilterValue,
  type MeasureWidgetBinding,
} from "@netrics/domain";
import {
  schema,
  resolveDataPolicy,
  type Transaction,
  type DashboardWidgetRow,
} from "@netrics/database";
import {
  createDataLoader,
  queryDataModel,
  DataServiceError,
} from "../data/service.js";

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
      measures: definition.measures.map(({ id, name }) => ({ id, name })),
      dimensions,
    },
  };
}
export async function publishedModels(tx: Transaction, workspaceId: string) {
  const rows = await tx
    .select({ id: schema.dataModels.id })
    .from(schema.dataModels)
    .where(
      and(
        eq(schema.dataModels.workspaceId, workspaceId),
        sql`${schema.dataModels.publishedVersion} is not null`,
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
export async function validateDashboardMeasure(
  tx: Transaction,
  workspaceId: string,
  filters: DashboardDataFilter[],
  binding: MeasureWidgetBinding,
  options: { view: "value" | "table" | "bar" | "line"; limit: number },
) {
  validateMeasureView(options.view, binding);
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
  const query = dashboardModelQuery(filters, {}, binding, options.limit);
  // Validate the shape and filter paths using the published schema, even with no current rows.
  const tables = new Map(
    Object.entries(model.bindings).map(([id, fields]) => [
      id,
      { fields, rows: [] },
    ]),
  );
  querySemanticModel(model.definition, tables, query);
  if (options.view === "bar" || options.view === "line") {
    const ungrouped = querySemanticModel(model.definition, tables, {
      ...query,
      groupBy: [],
    });
    const measure = ungrouped.rows[0]?.measures[binding.measureIds[0]!];
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
): Promise<DashboardWidgetData> {
  try {
    return await tx.transaction(async (savepoint) => {
      const metadata = await validateDashboardMeasure(
        savepoint,
        workspaceId,
        filters,
        input.binding,
        input.options,
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
      const selection = (value: DashboardFilterValue | undefined): string =>
        !value
          ? ""
          : value.kind === "range"
            ? `${String(value.from ?? "…")} – ${String(value.to ?? "…")}`
            : value.values
                .map((value) =>
                  value === null
                    ? "—"
                    : typeof value === "boolean"
                      ? locale === "de"
                        ? value
                          ? "Wahr"
                          : "Falsch"
                        : value
                          ? "True"
                          : "False"
                      : String(value),
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
          const chosen = selection(
              Object.hasOwn(values, filter.id)
                ? values[filter.id]
                : filter.defaultValue,
            ),
            fixed = selection(filter.fixedValue);
          const text = [chosen, fixed].filter(Boolean).join(" ∩ ");
          return text ? [`${filter.name}: ${text}`] : [];
        });
      return {
        scope,
        status: result.stale
          ? ("stale" as const)
          : result.rows.some((row) =>
                Object.values(row.measures).some((cell) => cell.value !== null),
              )
            ? ("ok" as const)
            : ("no_data" as const),
        widgetId: input.id,
        metadata,
        result,
        error: null,
        exclusions: input.binding.exclusions,
      };
    });
  } catch (error) {
    return {
      status: "outage",
      widgetId: input.id,
      metadata: null,
      result: null,
      error: safeDataError(error),
      exclusions: input.binding.exclusions,
    };
  }
}
export async function queryDashboardData(
  tx: Transaction,
  workspaceId: string,
  widgets: readonly DashboardWidgetRow[],
  rawFilters: unknown,
  values: Record<string, DashboardFilterValue>,
  now: Date,
  defaults?: DataPolicy,
  locale: "en" | "de" = "en",
) {
  const filters = dashboardDataFiltersSchema.parse(rawFilters);
  const ids = new Set(filters.map((filter) => filter.id));
  if (Object.keys(values).some((key) => !ids.has(key)))
    throw new DataServiceError("dashboard_filter_unknown");
  const results = [];
  for (const widget of widgets) {
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
  const unique = new Map<string, unknown>(),
    search = input.search.toLowerCase();
  for (const row of table.rows) {
    loader.budget.tick();
    const value = row[dimension.fieldId] ?? null;
    if (
      !search ||
      String(value ?? "")
        .toLowerCase()
        .includes(search)
    )
      unique.set(JSON.stringify(value), value);
  }
  const values = [...unique.values()].sort((a, b) =>
    a === null
      ? b === null
        ? 0
        : 1
      : b === null
        ? -1
        : compareDataValues(field.type, a, b),
  );
  return {
    values: values.slice(input.offset, input.offset + input.limit),
    total: values.length,
    offset: input.offset,
  };
}
