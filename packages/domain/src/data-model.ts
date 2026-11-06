import {
  compileRowExpression,
  dataFail,
  ProcessingBudget,
  type DataExpression,
  type DataCell,
  type DataField,
  type DataRow,
  compareDataValues,
  validateDataValue,
} from "./data-expression.js";
import {
  aggregateData,
  dataKey,
  validateDataTable,
  type AggregateDefinition,
  type DataTable,
} from "./data-preparation.js";
import {
  addCivilDays,
  civilDaysInclusive,
  expressionReferences as references,
  isWindowedMeasure,
  measureDependencies,
  measureLookbackDays,
  modelQueryTimeRange,
  offsetInterval,
  rollingWindowStart,
  validateWindowDefinition,
  windowCell,
  windowChange,
  windowNeedsTimeGrouping,
  type ModelOffsetUnit,
  type ModelWindowUnit,
  type WindowedMeasure,
} from "./data-model-windows.js";

export interface ModelRelationship {
  id: string;
  from: { datasetId: string; fieldId: string };
  to: { datasetId: string; fieldId: string };
  cardinality: "many_to_one" | "one_to_one";
}
export interface ModelDimension {
  id: string;
  name: string;
  datasetId: string;
  fieldId: string;
  /** Presentation only: filters and grouping continue to use fieldId's stable value. */
  labelFieldId?: string;
  timeAlignment?: "reporting_date" | "instant";
}
export type ModelMeasure = {
  id: string;
  name: string;
  requiredDimensions?: string[];
} & (
  | { kind: "aggregate"; datasetId: string; aggregate: AggregateDefinition }
  | { kind: "formula"; expression: DataExpression }
  /** Re-aggregates the base aggregate's rows over the window ending on each date. */
  | {
      kind: "rolling";
      baseMeasureId: string;
      timeDimensionId: string;
      window: { unit: ModelWindowUnit; length: number };
    }
  /** The base measure over an earlier interval, or the change against it. */
  | {
      kind: "period_offset";
      baseMeasureId: string;
      timeDimensionId: string;
      offset: { unit: ModelOffsetUnit; length: number };
      output: "value" | "change" | "percent_change";
    }
);
export interface SemanticModelDefinition {
  version: 1;
  datasets: string[];
  relationships: ModelRelationship[];
  dimensions: ModelDimension[];
  measures: ModelMeasure[];
}
export interface ModelQuery {
  measureIds: string[];
  groupBy: string[];
  filter?: DataExpression;
  now?: string;
  limit?: number;
  offset?: number;
  /** "last" pages from the end of the ordered groups: offset counts groups
   * skipped from the end, and rows are still returned in ascending order, so a
   * time series shows its most recent points. */
  window?: "first" | "last";
}
export interface ModelMeasureResult extends DataCell {
  status: "ok" | "missing" | "partial";
  /** period_offset only: the inclusive interval compared with. */
  comparedTo?: { from: string; to: string };
}

/** One display name per typed identity; names never join or merge records. */
export function dimensionValueLabels(
  dimension: ModelDimension,
  table: DataTable,
  budget = new ProcessingBudget(),
): Map<string, string> {
  const labels = new Map<string, string>();
  if (!dimension.labelFieldId) return labels;
  const field = table.fields.find(
    (field) => field.id === dimension.labelFieldId,
  );
  if (!field || field.type !== "string")
    dataFail("model_dimension_label_invalid");
  for (const row of table.rows) {
    budget.tick();
    const label = row[dimension.labelFieldId];
    if (
      label === null ||
      label === undefined ||
      row[dimension.fieldId] === null
    )
      continue;
    if (typeof label !== "string") dataFail("model_dimension_label_invalid");
    const key = dataKey(table.fields, row, [dimension.fieldId]);
    if (labels.has(key) && labels.get(key) !== label)
      dataFail("model_dimension_label_conflict");
    labels.set(key, label);
  }
  return labels;
}
function scalarKey(table: DataTable, row: DataRow, fieldId: string): string {
  return JSON.stringify(
    JSON.parse(dataKey(table.fields, row, [fieldId]))[0][1],
  );
}

/** A required grain can also be fixed to one value by a conjunctive filter. */
function singleValueDimensions(expression?: DataExpression): Set<string> {
  const result = new Set<string>();
  if (!expression || expression.kind !== "call") return result;
  if (expression.fn === "and") {
    for (const arg of expression.args)
      for (const id of singleValueDimensions(arg)) result.add(id);
  } else if (
    ["eq", "in"].includes(expression.fn) &&
    expression.args.length === 2
  ) {
    const [a, b] = expression.args;
    if (
      a?.kind === "field" &&
      b?.kind === "literal" &&
      b.value !== null &&
      (expression.fn === "eq" ||
        (b.type === "json" &&
          Array.isArray(b.value) &&
          b.value.length === 1 &&
          b.value[0] !== null))
    )
      result.add(a.fieldId);
    else if (
      expression.fn === "eq" &&
      b?.kind === "field" &&
      a?.kind === "literal" &&
      a.value !== null
    )
      result.add(b.fieldId);
  }
  return result;
}

/** Include the grain of formula dependencies when describing a reusable measure. */
export function measureRequiredDimensions(
  model: SemanticModelDefinition,
  ids: string[],
): string[] {
  const dimensions = new Set<string>(),
    done = new Set<string>(),
    visiting = new Set<string>();
  const visit = (id: string) => {
    if (done.has(id)) return;
    if (visiting.has(id)) dataFail("model_measure_cycle");
    const measure = model.measures.find((measure) => measure.id === id);
    if (!measure) dataFail("model_measure_not_found");
    visiting.add(id);
    for (const dimension of measure.requiredDimensions ?? [])
      dimensions.add(dimension);
    // Rolling and day/week offsets are only defined per date.
    if (isWindowedMeasure(measure) && windowNeedsTimeGrouping(measure))
      dimensions.add(measure.timeDimensionId);
    for (const dependency of measureDependencies(measure)) visit(dependency);
    visiting.delete(id);
    done.add(id);
  };
  ids.forEach(visit);
  return [...dimensions];
}

/** Aggregate each fact separately at the shared grain. Never join fact rows together. */
export function querySemanticModel(
  model: SemanticModelDefinition,
  sources: ReadonlyMap<string, DataTable>,
  query: ModelQuery,
  budget = new ProcessingBudget(),
) {
  if (
    model.version !== 1 ||
    model.datasets.length > 100 ||
    model.dimensions.length > 100 ||
    model.measures.length > 100 ||
    model.relationships.length > 100 ||
    !query.measureIds.length ||
    query.measureIds.length > 50 ||
    query.groupBy.length > 10
  )
    dataFail("model_limits_invalid");
  const dimensions = new Map(model.dimensions.map((d) => [d.id, d])),
    measures = new Map(model.measures.map((m) => [m.id, m]));
  if (
    dimensions.size !== model.dimensions.length ||
    measures.size !== model.measures.length ||
    new Set(model.datasets).size !== model.datasets.length ||
    new Set(query.measureIds).size !== query.measureIds.length ||
    new Set(query.groupBy).size !== query.groupBy.length
  )
    dataFail("model_ids_not_unique");
  const limit = query.limit ?? 1000;
  const offset = query.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0)
    dataFail("model_result_offset_invalid");
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    dataFail("model_result_limit_invalid");
  if (query.window !== undefined && !["first", "last"].includes(query.window))
    dataFail("model_result_window_invalid");
  const usedDatasets = new Set<string>();
  const now = query.now ?? new Date().toISOString();
  validateDataValue("timestamp", now, false);
  const table = (id: string) => {
    if (!model.datasets.includes(id))
      return dataFail("model_dataset_not_declared");
    const data = sources.get(id);
    if (!data) return dataFail("model_dataset_unavailable");

    return data;
  };
  const useData = (id: string) => {
    const data = table(id);
    usedDatasets.add(id);
    if (data.expiresAt) {
      validateDataValue("timestamp", data.expiresAt, false);
      if (compareDataValues("timestamp", data.expiresAt, now) <= 0)
        dataFail("model_dataset_expired");
    }
    return data;
  };
  const field = (datasetId: string, fieldId: string) => {
    const f = table(datasetId).fields.find((f) => f.id === fieldId);
    if (!f) return dataFail("model_field_not_found", fieldId);
    return f;
  };
  const relationships = new Map(model.relationships.map((r) => [r.id, r]));
  if (relationships.size !== model.relationships.length)
    dataFail("model_relationship_ids_not_unique");
  for (const r of model.relationships) {
    const a = field(r.from.datasetId, r.from.fieldId),
      b = field(r.to.datasetId, r.to.fieldId);
    if (a.type !== b.type || a.type === "json" || a.unit !== b.unit)
      dataFail("model_relationship_type_mismatch");
  }
  const checked = new Set<string>(),
    checking = new Set<string>();
  const checkCycle = (id: string) => {
    if (checking.has(id)) dataFail("model_relationship_cycle");
    if (checked.has(id)) return;
    checking.add(id);
    for (const r of model.relationships.filter((r) => r.from.datasetId === id))
      checkCycle(r.to.datasetId);
    checking.delete(id);
    checked.add(id);
  };
  model.datasets.forEach(checkCycle);
  const findPath = (from: string, to: string): ModelRelationship[] => {
    const paths: ModelRelationship[][] = [];
    const walk = (
      at: string,
      path: ModelRelationship[],
      visiting: Set<string>,
    ) => {
      if (visiting.has(at)) dataFail("model_relationship_cycle");
      if (at === to) {
        paths.push(path);
        return;
      }
      const next = new Set(visiting).add(at);
      for (const r of model.relationships.filter(
        (r) => r.from.datasetId === at,
      ))
        walk(r.to.datasetId, [...path, r], next);
    };
    walk(from, [], new Set());
    if (paths.length !== 1)
      dataFail(
        paths.length
          ? "model_filter_path_ambiguous"
          : "model_dimension_incompatible",
      );
    return paths[0]!;
  };
  const required = new Set([
    ...query.groupBy,
    ...(query.filter ? [...references(query.filter)] : []),
  ]);
  const dimensionFields: DataField[] = [];
  for (const id of required) {
    const d = dimensions.get(id);
    if (!d) dataFail("model_dimension_not_found", id);
    const f = field(d.datasetId, d.fieldId);
    if (f.type === "json") dataFail("model_dimension_json_unsupported");
    if (f.type === "date" && !d.timeAlignment)
      dataFail("model_date_alignment_required");
    dimensionFields.push({ ...f, id: d.id, name: d.name, nullable: true });
  }
  const filter = query.filter
    ? compileRowExpression(query.filter, dimensionFields)
    : undefined;
  if (filter && filter.result.type !== "boolean")
    dataFail("model_filter_boolean_required");
  const neededDatasets = new Set<string>(),
    visiting = new Set<string>(),
    validatedMeasures = new Set<string>(),
    windowed: WindowedMeasure[] = [];
  const fixedDimensions = singleValueDimensions(query.filter);
  const discover = (id: string) => {
    if (validatedMeasures.has(id)) return;
    if (visiting.has(id)) dataFail("model_measure_cycle");
    const m = measures.get(id);
    if (!m) dataFail("model_measure_not_found", id);
    const grain = m.requiredDimensions ?? [];
    if (
      grain.length > 10 ||
      new Set(grain).size !== grain.length ||
      grain.some((dimension) => !dimensions.has(dimension))
    )
      dataFail("model_measure_grain_invalid");
    if (
      grain.some(
        (dimension) =>
          !query.groupBy.includes(dimension) && !fixedDimensions.has(dimension),
      )
    )
      dataFail("model_measure_scope_required");
    visiting.add(id);
    if (m.kind === "aggregate") {
      table(m.datasetId);
      neededDatasets.add(m.datasetId);
    } else if (m.kind === "formula")
      for (const ref of references(m.expression)) discover(ref);
    else {
      validateWindowDefinition(m);
      const base = measures.get(m.baseMeasureId);
      if (!base) dataFail("model_measure_not_found", m.baseMeasureId);
      if (m.kind === "rolling" && base.kind !== "aggregate")
        dataFail("model_window_base_aggregate_required", m.id);
      const d = dimensions.get(m.timeDimensionId);
      if (!d) dataFail("model_dimension_not_found", m.timeDimensionId);
      if (
        field(d.datasetId, d.fieldId).type !== "date" ||
        d.timeAlignment !== "reporting_date"
      )
        dataFail("model_window_date_dimension_required", m.id);
      windowed.push(m);
      discover(m.baseMeasureId);
    }
    visiting.delete(id);
    validatedMeasures.add(id);
  };
  query.measureIds.forEach(discover);
  // Windowed measures read rows before the requested range: split the time
  // range out of the filter, admit [from − lookback, to] and output [from, to].
  let windowPlan:
    | {
        dimensionId: string;
        from: string | null;
        to: string | null;
        lowest: string | null;
        grouped: boolean;
        rangeDays: number;
        partitionBy: string[];
        residual?: ReturnType<typeof compileRowExpression>;
      }
    | undefined;
  if (windowed.length) {
    const dimensionId = windowed[0]!.timeDimensionId;
    if (windowed.some((m) => m.timeDimensionId !== dimensionId))
      dataFail("model_window_time_dimension_conflict");
    const grouped = query.groupBy.includes(dimensionId);
    if (!grouped && windowed.some(windowNeedsTimeGrouping))
      dataFail("model_window_time_grouping_required", dimensionId);
    const { range, residual } = modelQueryTimeRange(query.filter, dimensionId);
    const closed = range.from !== null && range.to !== null;
    if (
      !closed &&
      (!grouped ||
        windowed.some(
          (m) => m.kind === "period_offset" && m.offset.unit === "range",
        ))
    )
      dataFail("model_window_time_range_required", dimensionId);
    const rangeDays = closed
      ? Math.max(1, civilDaysInclusive(range.from!, range.to!))
      : 0;
    const lookback =
      measureLookbackDays(model, query.measureIds, rangeDays).get(
        dimensionId,
      ) ?? 0;
    const compiled = residual
      ? compileRowExpression(residual, dimensionFields)
      : undefined;
    windowPlan = {
      dimensionId,
      from: range.from,
      to: range.to,
      lowest: range.from === null ? null : addCivilDays(range.from, -lookback),
      grouped,
      rangeDays,
      partitionBy: query.groupBy.filter((id) => id !== dimensionId),
      ...(compiled ? { residual: compiled } : {}),
    };
  }
  const indexes = new Map<string, Map<string, DataRow>>();
  const index = (relationship: ModelRelationship) => {
    const existing = indexes.get(relationship.id);
    if (existing) return existing;
    const destination = useData(relationship.to.datasetId),
      lookup = new Map<string, DataRow>();
    validateDataTable(destination, budget);
    for (const row of destination.rows) {
      budget.tick();
      if (row[relationship.to.fieldId] === null) continue;
      const key = scalarKey(destination, row, relationship.to.fieldId);
      if (lookup.has(key)) dataFail("model_relationship_cardinality_violation");
      lookup.set(key, row);
    }
    if (relationship.cardinality === "one_to_one") {
      const source = useData(relationship.from.datasetId),
        seen = new Set<string>();
      for (const row of source.rows) {
        if (row[relationship.from.fieldId] === null) continue;
        const key = scalarKey(source, row, relationship.from.fieldId);
        if (seen.has(key)) dataFail("model_relationship_cardinality_violation");
        seen.add(key);
      }
    }
    indexes.set(relationship.id, lookup);
    return lookup;
  };
  // Publishing and ungrouped previews must catch invalid mappings too.
  model.relationships.forEach(index);
  const grouped = new Map<string, Map<string, DataRow[]>>(),
    groupValues = new Map<string, DataRow>();
  const pendingByDataset = new Map<string, Set<string>>();
  // Windowed queries: dataset → partition → date → rows, and each dataset's
  // earliest retained date (before any filter).
  const buckets = new Map<string, Map<string, Map<string, DataRow[]>>>(),
    earliest = new Map<string, string>();
  if (!query.groupBy.length) groupValues.set("[]", {});
  for (const datasetId of neededDatasets) {
    const source = useData(datasetId);
    const pending = new Set(source.pendingSources ?? []);
    pendingByDataset.set(datasetId, pending);
    validateDataTable(source, budget);
    const paths = new Map<string, ModelRelationship[]>();
    for (const id of required) {
      const d = dimensions.get(id)!;
      const path = findPath(datasetId, d.datasetId);
      for (const step of path)
        for (const source of table(step.to.datasetId).pendingSources ?? [])
          pending.add(source);
      paths.set(id, path);
      path.forEach(index);
    }
    const groups = new Map<string, DataRow[]>();
    grouped.set(datasetId, groups);
    for (const row of source.rows) {
      budget.tick();
      const values: DataRow = {};
      for (const id of required) {
        const d = dimensions.get(id)!;
        let current: DataRow | undefined = row;
        for (const r of paths.get(id)!) {
          if (!current || current[r.from.fieldId] === null) {
            current = undefined;
            break;
          }
          current = index(r).get(
            scalarKey(table(r.from.datasetId), current, r.from.fieldId),
          );
        }
        values[id] = current?.[d.fieldId] ?? null;
      }
      if (windowPlan) {
        const date = values[windowPlan.dimensionId] as string | null;
        if (date !== null) {
          const first = earliest.get(datasetId);
          if (first === undefined || date < first)
            earliest.set(datasetId, date);
        }
        if (
          windowPlan.residual &&
          windowPlan.residual.evaluate(values, budget).value !== true
        )
          continue;
        if (
          date === null ||
          (windowPlan.lowest !== null && date < windowPlan.lowest) ||
          (windowPlan.to !== null && date > windowPlan.to)
        )
          continue;
        const partition = dataKey(
          dimensionFields,
          values,
          windowPlan.partitionBy,
        );
        const datasetBuckets =
          buckets.get(datasetId) ?? new Map<string, Map<string, DataRow[]>>();
        buckets.set(datasetId, datasetBuckets);
        const dates = datasetBuckets.get(partition) ?? new Map();
        datasetBuckets.set(partition, dates);
        const rows = dates.get(date) ?? [];
        rows.push(row);
        dates.set(date, rows);
        // Lookback rows feed windows only; they never form output groups.
        if (windowPlan.from !== null && date < windowPlan.from) continue;
      } else if (filter && filter.evaluate(values, budget).value !== true)
        continue;
      const group = dataKey(dimensionFields, values, query.groupBy);
      if (!groupValues.has(group))
        groupValues.set(
          group,
          Object.fromEntries(query.groupBy.map((id) => [id, values[id]])),
        );
      if (windowPlan) continue;
      const members = groups.get(group) ?? [];
      members.push(row);
      groups.set(group, members);
    }
  }
  const results: Array<{
    dimensions: DataRow;
    dimensionLabels?: Record<string, string>;
    measures: Record<string, ModelMeasureResult>;
  }> = [];
  const displayLabels = new Map(
    [...required].map((id) => {
      const dimension = dimensions.get(id)!;
      return [
        id,
        dimensionValueLabels(dimension, table(dimension.datasetId), budget),
      ] as const;
    }),
  );
  const orderedGroups = [...groupValues].sort(([, a], [, b]) => {
    budget.tick();
    for (const id of query.groupBy) {
      const av = a[id],
        bv = b[id];
      if (av === null && bv === null) continue;
      if (av === null) return 1;
      if (bv === null) return -1;
      const type = dimensionFields.find((field) => field.id === id)!.type;
      const comparison = compareDataValues(type, av, bv);
      if (comparison) return comparison;
    }
    return 0;
  });
  const start =
    query.window === "last"
      ? Math.max(0, orderedGroups.length - offset - limit)
      : offset;
  const end =
    query.window === "last"
      ? Math.max(0, orderedGroups.length - offset)
      : offset + limit;
  const formulaCell = (
    expression: DataExpression,
    dependencies: ReadonlyArray<readonly [string, ModelMeasureResult]>,
  ): DataCell => {
    const row: DataRow = {},
      fields: DataField[] = [];
    const usedIds = new Set(dependencies.map(([ref]) => ref));
    for (const [ref, result] of dependencies) {
      const f: DataField = {
        id: ref,
        name: measures.get(ref)!.name,
        type: result.type,
        nullable: true,
        ...(result.unit ? { unit: result.unit } : {}),
      };
      if (result.currency) {
        let currencyId = ref + ".currency";
        while (usedIds.has(currencyId)) currencyId += ".currency";
        usedIds.add(currencyId);
        f.currencyField = currencyId;
        row[currencyId] = result.currency;
        fields.push({
          id: currencyId,
          name: "Currency",
          type: "string",
          nullable: false,
        });
      }
      fields.push(f);
      row[ref] = result.value;
    }
    return compileRowExpression(expression, fields).evaluate(row, budget);
  };
  // Windowed evaluation: each measure at (partition, interval), cached across
  // groups so neighbouring dates and offsets reuse results.
  type WindowedResult = ModelMeasureResult & { incomplete?: true };
  const windowCache = new Map<string, WindowedResult>(),
    sortedDates = new Map<Map<string, DataRow[]>, string[]>();
  const rowsIn = (
    datasetId: string,
    partition: string,
    from: string,
    to: string,
  ): DataRow[] => {
    const dates = buckets.get(datasetId)?.get(partition);
    if (!dates) return [];
    let sorted = sortedDates.get(dates);
    if (!sorted) {
      sorted = [...dates.keys()].sort();
      budget.tick(sorted.length);
      sortedDates.set(dates, sorted);
    }
    let low = 0,
      high = sorted.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (sorted[middle]! < from) low = middle + 1;
      else high = middle;
    }
    const rows: DataRow[] = [];
    for (let i = low; i < sorted.length && sorted[i]! <= to; i++) {
      const bucket = dates.get(sorted[i]!)!;
      budget.tick(bucket.length + 1);
      for (const row of bucket) rows.push(row);
    }
    return rows;
  };
  const evaluateWindowed = (
    partition: string,
    id: string,
    from: string,
    to: string,
    derived: boolean,
  ): WindowedResult => {
    const cacheKey = JSON.stringify([partition, id, from, to, derived]);
    const cached = windowCache.get(cacheKey);
    if (cached) return cached;
    const m = measures.get(id)!;
    budget.tick();
    let cell: DataCell,
      partial: boolean,
      incomplete = false,
      comparedTo: { from: string; to: string } | undefined;
    if (m.kind === "aggregate") {
      const { partial: waiting, ...aggregated } = aggregateData(
        {
          ...table(m.datasetId),
          rows: rowsIn(m.datasetId, partition, from, to),
          pendingSources: [...(pendingByDataset.get(m.datasetId) ?? [])],
        },
        m.aggregate,
        budget,
      );
      cell = aggregated;
      partial = !!waiting;
      if (derived) {
        // A window or compared interval reaching before retained history.
        const first = earliest.get(m.datasetId);
        incomplete = first === undefined || from < first;
        if (incomplete) budget.warnings.add("model_window_history_incomplete");
      }
    } else if (m.kind === "formula") {
      const dependencies = [...references(m.expression)].map(
        (ref) =>
          [ref, evaluateWindowed(partition, ref, from, to, derived)] as const,
      );
      cell = formulaCell(m.expression, dependencies);
      partial = dependencies.some(([, result]) => result.status !== "ok");
      incomplete = dependencies.some(([, result]) => result.incomplete);
    } else if (m.kind === "rolling") {
      const base = evaluateWindowed(
        partition,
        m.baseMeasureId,
        rollingWindowStart(to, m.window),
        to,
        true,
      );
      cell = windowCell(base);
      partial = base.status === "partial";
      incomplete = !!base.incomplete;
    } else {
      comparedTo = offsetInterval(from, to, m.offset, windowPlan!.rangeDays);
      const previous = evaluateWindowed(
        partition,
        m.baseMeasureId,
        comparedTo.from,
        comparedTo.to,
        true,
      );
      if (m.output === "value") {
        cell = windowCell(previous);
        partial = previous.status === "partial";
        incomplete = !!previous.incomplete;
      } else {
        const current = evaluateWindowed(
          partition,
          m.baseMeasureId,
          from,
          to,
          derived,
        );
        cell = windowChange(m.id, m.output, current, previous, budget);
        partial = [current, previous].some((r) => r.status === "partial");
        incomplete = !!(current.incomplete || previous.incomplete);
      }
    }
    // Incomplete history is partial, never missing or zero.
    const status: ModelMeasureResult["status"] = incomplete
      ? "partial"
      : cell.value === null
        ? "missing"
        : partial
          ? "partial"
          : "ok";
    const result: WindowedResult = {
      ...cell,
      status,
      ...(comparedTo ? { comparedTo } : {}),
      ...(incomplete ? { incomplete: true as const } : {}),
    };
    windowCache.set(cacheKey, result);
    return result;
  };
  const windowedMeasure = (values: DataRow, id: string): ModelMeasureResult => {
    const w = windowPlan!;
    const date = w.grouped ? (values[w.dimensionId] as string) : undefined;
    const { incomplete: _incomplete, ...result } = evaluateWindowed(
      dataKey(dimensionFields, values, w.partitionBy),
      id,
      date ?? w.from!,
      date ?? w.to!,
      false,
    );
    return result;
  };
  for (const [key, values] of orderedGroups.slice(start, end)) {
    const computed = new Map<string, ModelMeasureResult>();
    const evaluate = (id: string): ModelMeasureResult => {
      const cached = computed.get(id);
      if (cached) return cached;
      const m = measures.get(id)!;
      budget.tick();
      let cell: DataCell,
        status: ModelMeasureResult["status"] = "ok";
      if (m.kind === "aggregate") {
        const { partial, ...aggregated } = aggregateData(
          {
            ...table(m.datasetId),
            rows: grouped.get(m.datasetId)?.get(key) ?? [],
            pendingSources: [...(pendingByDataset.get(m.datasetId) ?? [])],
          },
          m.aggregate,
          budget,
        );
        cell = aggregated;
        if (partial) status = "partial";
      } else {
        // Windowed measures are evaluated by evaluateWindowed only.
        if (m.kind !== "formula") return dataFail("model_window_unsupported");
        const dependencies = [...references(m.expression)].map(
          (ref) => [ref, evaluate(ref)] as const,
        );
        cell = formulaCell(m.expression, dependencies);
        if (dependencies.some(([, result]) => result.status !== "ok"))
          status = "partial";
      }
      if (cell.value === null) status = "missing";
      const result = { ...cell, status };
      computed.set(id, result);
      return result;
    };
    const labels = Object.fromEntries(
      query.groupBy.flatMap((id) => {
        const dimension = dimensions.get(id)!;
        const label = displayLabels
          .get(id)!
          .get(
            dataKey(
              table(dimension.datasetId).fields,
              { [dimension.fieldId]: values[id] },
              [dimension.fieldId],
            ),
          );
        return label === undefined ? [] : [[id, label]];
      }),
    );
    results.push({
      dimensions: values,
      ...(Object.keys(labels).length ? { dimensionLabels: labels } : {}),
      measures: Object.fromEntries(
        query.measureIds.map((id) => [
          id,
          windowPlan ? windowedMeasure(values, id) : evaluate(id),
        ]),
      ),
    });
  }
  const lineage = new Map<
    string,
    { datasetId: string; generationId: string }
  >();
  for (const datasetId of usedDatasets)
    for (const p of table(datasetId).provenance ?? [])
      lineage.set(p.datasetId + ":" + p.generationId, p);
  // Label only literal filter values; never copy the whole dimension into a result.
  const literals = new Set<string>();
  const collectLiterals = (expression: DataExpression) => {
    if (expression.kind === "literal") {
      const values =
        expression.type === "json" && Array.isArray(expression.value)
          ? expression.value
          : [expression.value];
      for (const value of values) literals.add(JSON.stringify(value));
    } else if (expression.kind === "call")
      expression.args.forEach(collectLiterals);
  };
  if (query.filter) collectLiterals(query.filter);
  const filterValueLabels: Array<{
    dimensionId: string;
    value: unknown;
    label: string;
  }> = [];
  for (const id of query.filter ? references(query.filter) : []) {
    const dimension = dimensions.get(id)!;
    if (!dimension.labelFieldId) continue;
    const source = table(dimension.datasetId),
      labels = displayLabels.get(id)!,
      seen = new Set<string>();
    for (const row of source.rows) {
      budget.tick();
      const value = row[dimension.fieldId],
        key = JSON.stringify(value);
      if (!literals.has(key) || seen.has(key)) continue;
      seen.add(key);
      const label = labels.get(
        dataKey(source.fields, row, [dimension.fieldId]),
      );
      if (label !== undefined)
        filterValueLabels.push({ dimensionId: id, value, label });
    }
  }
  return {
    rows: results,
    ...(filterValueLabels.length ? { filterValueLabels } : {}),
    ...([...pendingByDataset.values()].some((pending) => pending.size)
      ? {
          pendingSources: [
            ...new Set(
              [...pendingByDataset.values()].flatMap((pending) => [...pending]),
            ),
          ],
        }
      : {}),
    totalRows: orderedGroups.length,
    offset: start,
    warnings: [...budget.warnings],
    operations: budget.operations,
    provenance: [...lineage.values()],
    appliedFilter: query.filter ?? null,
    groupBy: query.groupBy,
  };
}

/** Publication validates schemas, expressions and actual mapping cardinality.
 * A model containing multiple currencies is valid; an incompatible unfiltered
 * total is refused when that query is requested, not by banning the model.
 */
export function validateSemanticModel(
  model: SemanticModelDefinition,
  sources: ReadonlyMap<string, DataTable>,
  now: string,
  budget = new ProcessingBudget(),
): void {
  const schemas = new Map(
    [...sources].map(([id, table]) => [id, { fields: table.fields, rows: [] }]),
  );
  for (const dimension of model.dimensions) {
    const source = sources.get(dimension.datasetId);
    if (source) dimensionValueLabels(dimension, source, budget);
    const field = schemas
      .get(dimension.datasetId)
      ?.fields.find((field) => field.id === dimension.fieldId);
    if (!model.datasets.includes(dimension.datasetId) || !field)
      dataFail("model_field_not_found", dimension.fieldId);
    if (field.type === "json") dataFail("model_dimension_json_unsupported");
    if (field.type === "date" && !dimension.timeAlignment)
      dataFail("model_date_alignment_required");
  }
  for (const measure of model.measures) {
    const grain = measure.requiredDimensions ?? [];
    if (
      grain.length > 10 ||
      new Set(grain).size !== grain.length ||
      grain.some(
        (id) => !model.dimensions.some((dimension) => dimension.id === id),
      )
    )
      dataFail("model_measure_grain_invalid");
    if (isWindowedMeasure(measure)) {
      const dimension = model.dimensions.find(
        (dimension) => dimension.id === measure.timeDimensionId,
      );
      if (!dimension)
        dataFail("model_dimension_not_found", measure.timeDimensionId);
      const field = schemas
        .get(dimension.datasetId)
        ?.fields.find((field) => field.id === dimension.fieldId);
      if (
        field?.type !== "date" ||
        dimension.timeAlignment !== "reporting_date"
      )
        dataFail("model_window_date_dimension_required", measure.id);
    }
  }
  const unguarded = {
    ...model,
    measures: model.measures.map(
      ({ requiredDimensions: _grain, ...measure }) => measure,
    ),
  };
  // Windowed measures (and formulas over them) are only defined per date or
  // over a closed range: probe them grouped by their time dimension.
  const probes = new Map<string | undefined, string[]>();
  const windowedModel = model.measures.some(isWindowedMeasure);
  for (const measure of model.measures) {
    const dimension = windowedModel
      ? [...measureLookbackDays(model, [measure.id]).keys()][0]
      : undefined;
    probes.set(dimension, [...(probes.get(dimension) ?? []), measure.id]);
  }
  for (const [dimension, ids] of probes)
    for (let offset = 0; offset < ids.length; offset += 50)
      querySemanticModel(
        unguarded,
        schemas,
        {
          measureIds: ids.slice(offset, offset + 50),
          groupBy: dimension ? [dimension] : [],
          ...(dimension
            ? {
                filter: {
                  kind: "call" as const,
                  fn: "eq" as const,
                  args: [
                    { kind: "field" as const, fieldId: dimension },
                    {
                      kind: "literal" as const,
                      type: "date" as const,
                      value: "2000-01-01",
                    },
                  ],
                },
              }
            : {}),
          now,
        },
        budget,
      );
  for (const table of sources.values()) validateDataTable(table, budget);
  const datasetId = model.datasets[0];
  if (!datasetId) dataFail("model_dataset_not_declared");
  querySemanticModel(
    {
      ...model,
      measures: [
        {
          id: "__validate_rows",
          name: "Validation",
          kind: "aggregate",
          datasetId,
          aggregate: { id: "__validate_rows", name: "Validation", op: "count" },
        },
      ],
    },
    sources,
    { measureIds: ["__validate_rows"], groupBy: [], now },
    budget,
  );
}
