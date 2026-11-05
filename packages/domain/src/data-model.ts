import {
  compileRowExpression,
  dataFail,
  ProcessingBudget,
  PROCESSING_LIMITS,
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
  timeAlignment?: "reporting_date" | "instant";
}
export type ModelMeasure = { id: string; name: string } & (
  | { kind: "aggregate"; datasetId: string; aggregate: AggregateDefinition }
  | { kind: "formula"; expression: DataExpression }
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
}
export interface ModelMeasureResult extends DataCell {
  status: "ok" | "missing" | "partial";
}
function references(expression: DataExpression): Set<string> {
  const result = new Set<string>(),
    stack: Array<[DataExpression, number]> = [[expression, 0]];
  let nodes = 0;
  while (stack.length) {
    const [item, depth] = stack.pop()!;
    if (++nodes > PROCESSING_LIMITS.nodes || depth > PROCESSING_LIMITS.depth)
      dataFail("expression_complexity_limit");
    if (item.kind === "field") result.add(item.fieldId);
    else if (item.kind === "call") {
      if (item.args.length > 20) dataFail("expression_arity_invalid");
      for (const arg of item.args) stack.push([arg, depth + 1]);
    } else if (item.kind !== "literal") dataFail("expression_invalid");
  }
  return result;
}
function scalarKey(table: DataTable, row: DataRow, fieldId: string): string {
  return JSON.stringify(
    JSON.parse(dataKey(table.fields, row, [fieldId]))[0][1],
  );
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
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    dataFail("model_result_limit_invalid");
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
    validatedMeasures = new Set<string>();
  const discover = (id: string) => {
    if (validatedMeasures.has(id)) return;
    if (visiting.has(id)) dataFail("model_measure_cycle");
    const m = measures.get(id);
    if (!m) dataFail("model_measure_not_found", id);
    visiting.add(id);
    if (m.kind === "aggregate") {
      table(m.datasetId);
      neededDatasets.add(m.datasetId);
    } else for (const ref of references(m.expression)) discover(ref);
    visiting.delete(id);
    validatedMeasures.add(id);
  };
  query.measureIds.forEach(discover);
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
  const grouped = new Map<string, Map<string, DataRow[]>>(),
    groupValues = new Map<string, DataRow>();
  if (!query.groupBy.length) groupValues.set("[]", {});
  for (const datasetId of neededDatasets) {
    const source = useData(datasetId);
    validateDataTable(source, budget);
    const paths = new Map<string, ModelRelationship[]>();
    for (const id of required) {
      const d = dimensions.get(id)!;
      const path = findPath(datasetId, d.datasetId);
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
      if (filter && filter.evaluate(values, budget).value !== true) continue;
      const group = dataKey(dimensionFields, values, query.groupBy);
      if (!groupValues.has(group))
        groupValues.set(
          group,
          Object.fromEntries(query.groupBy.map((id) => [id, values[id]])),
        );
      const members = groups.get(group) ?? [];
      members.push(row);
      groups.set(group, members);
      if (groupValues.size > limit) dataFail("model_result_limit_exceeded");
    }
  }
  const results: Array<{
    dimensions: DataRow;
    measures: Record<string, ModelMeasureResult>;
  }> = [];
  for (const [key, values] of groupValues) {
    const computed = new Map<string, ModelMeasureResult>();
    const evaluate = (id: string): ModelMeasureResult => {
      const cached = computed.get(id);
      if (cached) return cached;
      const m = measures.get(id)!;
      budget.tick();
      let cell: DataCell,
        status: ModelMeasureResult["status"] = "ok";
      if (m.kind === "aggregate")
        cell = aggregateData(
          {
            ...table(m.datasetId),
            rows: grouped.get(m.datasetId)?.get(key) ?? [],
          },
          m.aggregate,
          budget,
        );
      else {
        const dependencies = [...references(m.expression)].map(
            (ref) => [ref, evaluate(ref)] as const,
          ),
          row: DataRow = {},
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
        cell = compileRowExpression(m.expression, fields).evaluate(row, budget);
        if (dependencies.some(([, result]) => result.status !== "ok"))
          status = "partial";
      }
      if (cell.value === null) status = "missing";
      const result = { ...cell, status };
      computed.set(id, result);
      return result;
    };
    results.push({
      dimensions: values,
      measures: Object.fromEntries(
        query.measureIds.map((id) => [id, evaluate(id)]),
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
  return {
    rows: results,
    warnings: [...budget.warnings],
    operations: budget.operations,
    provenance: [...lineage.values()],
    appliedFilter: query.filter ?? null,
    groupBy: query.groupBy,
  };
}
