import {
  dataFail,
  ProcessingBudget,
  PROCESSING_LIMITS,
  type DataExpression,
} from "./data-expression.js";
import {
  executePreparation,
  type AggregateDefinition,
  type DataTable,
  type PreparationGraph,
} from "./data-preparation.js";
import {
  measureRequiredDimensions,
  type SemanticModelDefinition,
} from "./data-model.js";

type References = Map<string, Set<string>>;

/** AST fields are source columns in row scope, but measure IDs in formula scope. */
function expressionFields(
  expression: DataExpression,
  budget?: ProcessingBudget,
) {
  const fields = new Set<string>();
  const stack: Array<[DataExpression, number]> = [[expression, 0]];
  let nodes = 0;
  while (stack.length) {
    const [item, depth] = stack.pop()!;
    budget?.tick();
    if (++nodes > PROCESSING_LIMITS.nodes || depth > PROCESSING_LIMITS.depth)
      dataFail("expression_complexity_limit");
    if (item.kind === "field") fields.add(item.fieldId);
    else if (item.kind === "call") {
      if (item.args.length > 20) dataFail("expression_arity_invalid");
      item.args.forEach((arg) => stack.push([arg, depth + 1]));
    } else if (item.kind !== "literal") dataFail("expression_invalid");
  }
  return fields;
}

function aggregateFields(
  aggregate: AggregateDefinition,
  budget?: ProcessingBudget,
) {
  const fields = aggregate.filter
    ? expressionFields(aggregate.filter, budget)
    : new Set<string>();
  if (aggregate.fieldId) fields.add(aggregate.fieldId);
  // Other aggregate operations do not read an inactive orderBy editor setting.
  if (aggregate.op === "last" && aggregate.orderBy)
    fields.add(aggregate.orderBy);
  return fields;
}

/** All retained model declarations matter, independently of a preview's selected measures. */
export function semanticModelFieldReferences(
  model: SemanticModelDefinition,
): References {
  if (
    model.datasets.length > 100 ||
    model.dimensions.length > 100 ||
    model.measures.length > 100 ||
    model.relationships.length > 100
  )
    dataFail("model_limits_invalid");
  // Use the canonical measure dependency traversal for missing references/cycles.
  measureRequiredDimensions(
    model,
    model.measures.map((measure) => measure.id),
  );
  const result: References = new Map(
    model.datasets.map((id) => [id, new Set()]),
  );
  const add = (datasetId: string, fieldId: string) => {
    const fields = result.get(datasetId);
    if (!fields) dataFail("model_dataset_not_declared");
    fields.add(fieldId);
  };
  for (const dimension of model.dimensions) {
    add(dimension.datasetId, dimension.fieldId);
    if (dimension.labelFieldId)
      add(dimension.datasetId, dimension.labelFieldId);
  }
  // The executor validates every declared relationship, even without grouping.
  for (const relationship of model.relationships) {
    add(relationship.from.datasetId, relationship.from.fieldId);
    add(relationship.to.datasetId, relationship.to.fieldId);
  }
  for (const measure of model.measures)
    if (measure.kind === "aggregate") {
      if (!result.has(measure.datasetId))
        dataFail("model_dataset_not_declared");
      for (const field of aggregateFields(measure.aggregate))
        add(measure.datasetId, field);
    }
  return result;
}

interface NodeReferences {
  /** Dataset presence plus predicates/keys that determine the output rows. */
  rows: References;
  fields: Map<string, References>;
  table: DataTable;
}

/**
 * Trace one output back to direct external source fields. Callers expand prepared
 * sources recursively using their pinned versions. Rows matter even for COUNT(*).
 * The canonical executor supplies validated node schemas; this sidecar never
 * evaluates source values or persists metadata in prepared tables/caches.
 */
export function preparationFieldReferences(
  graph: PreparationGraph,
  sources: ReadonlyMap<string, DataTable>,
  outputId: string,
  fields: ReadonlySet<string>,
  budget = new ProcessingBudget(),
): References {
  const nodes = new Map<string, NodeReferences>();
  const merge = (...inputs: References[]): References => {
    const result: References = new Map();
    for (const input of inputs)
      for (const [datasetId, fields] of input) {
        budget.tick();
        const target = result.get(datasetId) ?? new Set<string>();
        for (const field of fields) {
          budget.tick();
          target.add(field);
        }
        result.set(datasetId, target);
      }
    return result;
  };
  const input = (id: string) => {
    const value = nodes.get(id);
    if (!value) dataFail("preparation_input_not_found");
    return value;
  };
  const read = (value: NodeReferences, ids: Iterable<string>): References => {
    const result: References[] = [];
    const seen = new Set<string>();
    const pending = [...ids];
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      budget.tick();
      const field = value.table.fields.find((field) => field.id === id);
      const origins = value.fields.get(id);
      if (!field || !origins) dataFail("data_field_not_found", id);
      result.push(origins);
      if (field.currencyField) pending.push(field.currencyField);
    }
    return merge(...result);
  };
  const schemas = new Map(
    [...sources].map(([id, table]) => [id, { ...table, rows: [] }]),
  );
  executePreparation(graph, schemas, budget, (node, table) => {
    let rows: References;
    const fields = new Map<string, References>();
    if (node.type === "source") {
      rows = new Map([[node.datasetId, new Set()]]);
      for (const field of table.fields) {
        budget.tick();
        fields.set(field.id, new Map([[node.datasetId, new Set([field.id])]]));
      }
    } else if (node.type === "append") {
      rows = merge(...node.inputs.map((id) => input(id).rows));
      for (const field of table.fields) {
        const origins: References[] = [];
        for (const id of node.inputs) {
          const source = input(id);
          const mapping =
            node.columnMappings && Object.hasOwn(node.columnMappings, id)
              ? node.columnMappings[id]
              : undefined;
          const sourceId = mapping
            ? Object.keys(mapping).find((key) => mapping[key] === field.id)
            : field.id;
          if (sourceId && source.fields.has(sourceId))
            origins.push(read(source, [sourceId]));
        }
        fields.set(field.id, merge(...origins));
      }
    } else if (node.type === "join") {
      const left = input(node.left),
        right = input(node.right);
      rows = merge(
        left.rows,
        right.rows,
        read(
          left,
          node.keys.map((key) => key.left),
        ),
        read(
          right,
          node.keys.map((key) => key.right),
        ),
      );
      for (const field of left.table.fields)
        fields.set(field.id, read(left, [field.id]));
      for (const field of right.table.fields)
        fields.set(node.rightPrefix + field.id, read(right, [field.id]));
    } else {
      const source = input(node.input);
      rows = source.rows;
      if (node.type === "filter")
        rows = merge(
          rows,
          read(source, expressionFields(node.expression, budget)),
        );
      if (node.type === "deduplicate")
        rows = merge(rows, read(source, node.keys));
      if (node.type === "group") {
        rows = merge(rows, read(source, node.keys));
        for (const key of node.keys) fields.set(key, read(source, [key]));
        for (const aggregate of node.aggregates) {
          const origins = read(source, aggregateFields(aggregate, budget));
          fields.set(aggregate.id, origins);
          const currency = table.fields.find(
            (field) => field.id === aggregate.id,
          )?.currencyField;
          if (currency) fields.set(currency, origins);
        }
      } else {
        for (const field of table.fields) {
          const currency =
            node.type === "calculate"
              ? table.fields.find((field) => field.id === node.fieldId)
                  ?.currencyField
              : undefined;
          const calculated =
            node.type === "calculate" &&
            (field.id === node.fieldId || field.id === currency);
          fields.set(
            field.id,
            calculated
              ? read(source, expressionFields(node.expression, budget))
              : read(source, [field.id]),
          );
        }
      }
    }
    nodes.set(node.id, { rows, fields, table });
  });
  if (!graph.outputs.includes(outputId))
    dataFail("preparation_input_not_found");
  const output = input(outputId);
  return merge(output.rows, read(output, fields));
}
