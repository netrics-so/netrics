import {
  compileRowExpression,
  compareDataValues,
  dataFail,
  exactDecimal,
  ProcessingBudget,
  PROCESSING_LIMITS,
  validateDataValue,
  DataProcessingError,
  type DataCell,
  type DataExpression,
  type DataField,
  type DataRow,
  type DataType,
} from "./data-expression.js";

export interface DataProvenance {
  datasetId: string;
  generationId: string;
}
export interface DataTable {
  fields: DataField[];
  rows: DataRow[];
  provenance?: DataProvenance[];
  expiresAt?: string;
  aggregated?: boolean;
  /** Declared inputs that have never completed an import; distinct from empty data. */
  pendingSources?: string[];
}
export type AggregateOperation =
  | "sum"
  | "count"
  | "distinct_count"
  | "avg"
  | "min"
  | "max"
  | "last"
  | "any"
  | "all";
export interface AggregateDefinition {
  id: string;
  name: string;
  op: AggregateOperation;
  fieldId?: string;
  orderBy?: string;
  filter?: DataExpression;
}
export type PreparationNode = { id: string } & (
  | { type: "source"; datasetId: string }
  | { type: "select"; input: string; fields: string[] }
  | { type: "rename"; input: string; names: Record<string, string> }
  | { type: "filter"; input: string; expression: DataExpression }
  | {
      type: "calculate";
      input: string;
      fieldId: string;
      name: string;
      expression: DataExpression;
    }
  | {
      type: "cast";
      input: string;
      fieldId: string;
      to: DataType;
      onError: "reject" | "null";
    }
  | {
      type: "replace";
      input: string;
      fieldId: string;
      from: unknown;
      to: unknown;
    }
  | {
      type: "deduplicate";
      input: string;
      keys: string[];
      keep: "first" | "last";
    }
  | {
      type: "append";
      inputs: string[];
      /** Explicitly project/align source columns; omitted inputs keep their IDs. */
      columnMappings?: Record<string, Record<string, string>>;
    }
  | {
      type: "join";
      left: string;
      right: string;
      keys: Array<{ left: string; right: string }>;
      mode: "inner" | "left";
      cardinality: "many_to_one" | "one_to_one";
      rightPrefix: string;
      rightNamePrefix?: string;
    }
  | {
      type: "group";
      input: string;
      keys: string[];
      aggregates: AggregateDefinition[];
    }
);
export interface PreparationGraph {
  version: 1;
  nodes: PreparationNode[];
  outputs: string[];
}

export function assertDataFields(fields: readonly DataField[]): void {
  if (
    !fields.length ||
    fields.length > PROCESSING_LIMITS.fields ||
    new Set(fields.map((f) => f.id)).size !== fields.length
  )
    dataFail("data_schema_invalid");
  for (const field of fields) {
    if (
      !/^[a-z][a-z0-9_.-]{0,99}$/.test(field.id) ||
      ["constructor", "prototype", "__proto__"].includes(field.id) ||
      !field.name ||
      field.name.length > 100
    )
      dataFail("data_field_invalid");
    if (
      field.currencyField &&
      !fields.some((f) => f.id === field.currencyField && f.type === "string")
    )
      dataFail("data_currency_field_missing");
  }
}
export function validateDataTable(
  table: DataTable,
  budget = new ProcessingBudget(),
): void {
  assertDataFields(table.fields);
  if (table.rows.length > budget.maxRows) dataFail("data_row_limit");
  let bytes = 0;
  for (const row of table.rows) {
    budget.tick();
    if (Object.keys(row).length !== table.fields.length)
      dataFail("data_row_schema_mismatch");
    for (const field of table.fields) {
      budget.tick();
      if (!Object.hasOwn(row, field.id))
        dataFail("data_field_missing", field.id);
      validateDataValue(field.type, row[field.id], field.nullable);
    }
    bytes += new TextEncoder().encode(JSON.stringify(row)).length;
    if (bytes > budget.maxOutputBytes) dataFail("data_output_limit");
  }
}
export function dataKey(
  fields: readonly DataField[],
  row: DataRow,
  keys: readonly string[],
): string {
  return JSON.stringify(
    keys.map((id) => {
      const field = fields.find((f) => f.id === id);
      if (!field) dataFail("data_field_not_found", id);
      const value = row[id];
      if (value === null) return [id, null];
      if (field.type === "json") dataFail("data_json_key_unsupported", id);
      if (field.type === "decimal")
        return [id, exactDecimal("add", String(value), "0")];
      if (field.type === "timestamp")
        return [
          id,
          String(value).replace(
            /(?:\.([0-9]+))?Z$/,
            (_m, f: string | undefined) => "." + (f ?? "").padEnd(9, "0") + "Z",
          ),
        ];
      return [id, value];
    }),
  );
}
function fieldOf(table: DataTable, id: string): DataField {
  const field = table.fields.find((f) => f.id === id);
  if (!field) return dataFail("data_field_not_found", id);
  return field;
}
function keysValid(table: DataTable, keys: string[]) {
  if (!keys.length || new Set(keys).size !== keys.length)
    dataFail("data_keys_invalid");
  keys.forEach((key) => {
    if (fieldOf(table, key).type === "json")
      dataFail("data_json_key_unsupported", key);
  });
}
function sourceContext(
  tables: DataTable[],
): Pick<
  DataTable,
  "provenance" | "expiresAt" | "aggregated" | "pendingSources"
> {
  const refs = new Map<string, DataProvenance>();
  let expiry: string | undefined;
  for (const table of tables) {
    for (const p of table.provenance ?? [])
      refs.set(p.datasetId + ":" + p.generationId, p);
    if (
      table.expiresAt &&
      (!expiry || compareDataValues("timestamp", table.expiresAt, expiry) < 0)
    )
      expiry = table.expiresAt;
  }
  return {
    provenance: [...refs.values()],
    aggregated: tables.some((table) => table.aggregated),
    ...(tables.some((table) => table.pendingSources?.length)
      ? {
          pendingSources: [
            ...new Set(tables.flatMap((table) => table.pendingSources ?? [])),
          ],
        }
      : {}),
    ...(expiry ? { expiresAt: expiry } : {}),
  };
}
export function aggregateData(
  table: DataTable,
  definition: AggregateDefinition,
  budget = new ProcessingBudget(),
): DataCell & { partial?: true } {
  const field = definition.fieldId
    ? fieldOf(table, definition.fieldId)
    : undefined;
  if (definition.op !== "count" && !field) dataFail("aggregate_field_required");
  if (
    ["sum", "avg"].includes(definition.op) &&
    field &&
    !["integer", "number", "decimal"].includes(field.type)
  )
    dataFail("aggregate_numeric_required");
  if (["any", "all"].includes(definition.op) && field?.type !== "boolean")
    dataFail("aggregate_boolean_required");
  if (field?.type === "json" && definition.op !== "count")
    dataFail("aggregate_json_unsupported");
  const filter = definition.filter
    ? compileRowExpression(definition.filter, table.fields)
    : undefined;
  if (filter && filter.result.type !== "boolean")
    dataFail("data_filter_boolean_required");
  const rows = filter
    ? table.rows.filter((row) => {
        budget.tick();
        return filter.evaluate(row, budget).value === true;
      })
    : table.rows;
  const nonNull = field ? rows.filter((row) => row[field.id] !== null) : rows;
  const values = field ? nonNull.map((row) => row[field.id]) : [];
  let type: DataType = field?.type ?? "integer",
    value: unknown = null,
    lastRow: DataRow | undefined;
  budget.tick(rows.length + 1);
  if (field)
    for (const row of rows)
      validateDataValue(field.type, row[field.id], field.nullable);
  switch (definition.op) {
    case "count":
      value = field ? nonNull.length : rows.length;
      type = "integer";
      break;
    case "distinct_count":
      value = new Set(
        nonNull.map((row) => dataKey(table.fields, row, [field!.id])),
      ).size;
      type = "integer";
      break;
    case "sum":
    case "avg": {
      if (field?.type === "number") {
        type = "number";
        value = values.length
          ? values.reduce<number>((total, v) => total + (v as number), 0)
          : null;
        if (definition.op === "avg" && values.length)
          value = (value as number) / values.length;
      } else {
        type = "decimal";
        let total = "0";
        for (const v of values)
          total = exactDecimal("add", total, String(v), budget)!;
        value = values.length
          ? definition.op === "avg"
            ? exactDecimal("divide", total, String(values.length), budget)
            : total
          : null;
      }
      break;
    }
    case "min":
    case "max":
      for (const v of values)
        if (
          value === null ||
          (definition.op === "min"
            ? compareDataValues(type, v, value) < 0
            : compareDataValues(type, v, value) > 0)
        )
          value = v;
      break;
    case "last": {
      if (!definition.orderBy) dataFail("aggregate_order_required");
      const order = fieldOf(table, definition.orderBy);
      if (!["date", "timestamp"].includes(order.type))
        dataFail("aggregate_order_time_required");
      for (const row of rows) {
        const at = row[order.id];
        if (at === null) continue;
        const comparison = lastRow
          ? compareDataValues(order.type, at, lastRow[order.id])
          : 1;
        if (comparison > 0) {
          lastRow = row;
          value = row[field!.id];
        } else if (
          comparison === 0 &&
          (dataKey(table.fields, row, [field!.id]) !==
            dataKey(table.fields, lastRow!, [field!.id]) ||
            (field?.currencyField &&
              row[field.currencyField] !== lastRow![field.currencyField]))
        )
          dataFail("aggregate_latest_ambiguous");
      }
      break;
    }
    case "any":
      type = "boolean";
      value = values.includes(true)
        ? true
        : rows.length === 0 || rows.some((row) => row[field!.id] === null)
          ? null
          : false;
      break;
    case "all":
      type = "boolean";
      value = values.includes(false)
        ? false
        : rows.length === 0 || rows.some((row) => row[field!.id] === null)
          ? null
          : true;
      break;
    default:
      dataFail("aggregate_operation_unknown");
  }
  const preservesUnit = !["count", "distinct_count", "any", "all"].includes(
    definition.op,
  );
  let currency: string | undefined;
  if (field?.currencyField && preservesUnit) {
    const selected =
      definition.op === "last"
        ? lastRow && value !== null
          ? [lastRow]
          : []
        : nonNull;
    const currencies = new Set(
      selected.map((row) => row[field.currencyField!]),
    );
    if (currencies.size > 1) dataFail("aggregate_currency_mixed");
    const c = [...currencies][0];
    if (c !== undefined && (typeof c !== "string" || !/^[A-Z]{3}$/.test(c)))
      dataFail("data_currency_invalid");
    currency = c as string | undefined;
  }
  const waiting = !!table.pendingSources?.length;
  if (waiting) {
    budget.warnings.add("data_source_pending");
    if (
      !rows.length ||
      (definition.op === "any" && value !== true) ||
      (definition.op === "all" && value !== false)
    )
      value = null;
  }
  validateDataValue(type, value, true);
  const missing =
    value !== null &&
    ["sum", "avg", "min", "max"].includes(definition.op) &&
    nonNull.length < rows.length;
  if (missing) budget.warnings.add("aggregate_missing_inputs");
  const partial = value !== null && (missing || waiting);
  return {
    value,
    type,
    ...(preservesUnit && field?.unit ? { unit: field.unit } : {}),
    ...(preservesUnit && currency ? { currency } : {}),
    ...(partial ? { partial: true as const } : {}),
  };
}

export function executePreparation(
  graph: PreparationGraph,
  sources: ReadonlyMap<string, DataTable>,
  budget = new ProcessingBudget(),
  onNode?: (node: PreparationNode, output: DataTable) => void,
) {
  if (
    graph.version !== 1 ||
    !graph.nodes.length ||
    graph.nodes.length > PROCESSING_LIMITS.steps ||
    !graph.outputs.length ||
    graph.outputs.length > 20
  )
    dataFail("preparation_graph_invalid");
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  if (nodes.size !== graph.nodes.length) dataFail("preparation_node_duplicate");
  const done = new Map<string, DataTable>(),
    visiting = new Set<string>();
  let rejectedRows = 0;
  const execute = (id: string): DataTable => {
    const cached = done.get(id);
    if (cached) return cached;
    const node = nodes.get(id);
    if (!node) return dataFail("preparation_input_not_found");
    if (visiting.has(id)) dataFail("preparation_cycle");
    visiting.add(id);
    budget.tick();
    let output: DataTable;
    if (node.type === "source") {
      const source = sources.get(node.datasetId);
      if (!source) return dataFail("preparation_source_not_found");
      output = {
        ...source,
        fields: source.fields.map((f) => ({ ...f })),
        rows: source.rows.map((row) => ({ ...row })),
      };
    } else if (node.type === "append") {
      if (node.inputs.length < 2 || node.inputs.length > 20)
        dataFail("preparation_append_inputs_invalid");
      // Reading one input twice silently doubles its rows.
      if (new Set(node.inputs).size !== node.inputs.length)
        dataFail("preparation_append_inputs_duplicate");
      if (
        Object.keys(node.columnMappings ?? {}).some(
          (id) => !node.inputs.includes(id),
        )
      )
        dataFail("preparation_append_mapping_input_invalid");
      const inputs = node.inputs.map((id) => {
          const input = execute(id);
          if (!node.columnMappings || !Object.hasOwn(node.columnMappings, id))
            return input;
          const mapping = node.columnMappings[id]!,
            entries = Object.entries(mapping),
            fields = entries.map(([sourceId, targetId]) => {
              budget.tick();
              const field = fieldOf(input, sourceId);
              if (
                field.currencyField &&
                !Object.hasOwn(mapping, field.currencyField)
              )
                dataFail("preparation_currency_field_required");
              return {
                ...field,
                id: targetId,
                ...(field.currencyField
                  ? { currencyField: mapping[field.currencyField]! }
                  : {}),
              };
            });
          assertDataFields(fields);
          return {
            ...input,
            fields,
            rows: input.rows.map((row) => {
              budget.tick(entries.length);
              return Object.fromEntries(
                entries.map(([sourceId, targetId]) => [
                  targetId,
                  row[sourceId],
                ]),
              );
            }),
          };
        }),
        fields = new Map<string, DataField>();
      for (const input of inputs)
        for (const field of input.fields) {
          const previous = fields.get(field.id);
          if (
            previous &&
            (previous.type !== field.type ||
              previous.unit !== field.unit ||
              previous.currencyField !== field.currencyField)
          )
            dataFail("preparation_append_schema_mismatch");
          fields.set(field.id, {
            ...(previous ?? field),
            nullable: field.nullable || previous?.nullable === true,
          });
        }
      for (const field of fields.values())
        if (
          inputs.some((input) => !input.fields.some((f) => f.id === field.id))
        )
          field.nullable = true;
      output = {
        fields: [...fields.values()],
        rows: inputs.flatMap((t) =>
          t.rows.map((row) =>
            Object.fromEntries(
              [...fields.keys()].map((id) => [id, row[id] ?? null]),
            ),
          ),
        ),
        ...sourceContext(inputs),
      };
    } else if (node.type === "join") {
      const left = execute(node.left),
        right = execute(node.right);
      if (!node.keys.length || node.keys.length > 10 || !node.rightPrefix)
        dataFail("preparation_join_keys_invalid");
      const leftKeys = node.keys.map((k) => k.left),
        rightKeys = node.keys.map((k) => k.right);
      keysValid(left, leftKeys);
      keysValid(right, rightKeys);
      node.keys.forEach((pair) => {
        const a = fieldOf(left, pair.left),
          b = fieldOf(right, pair.right);
        if (a.type !== b.type || a.unit !== b.unit)
          dataFail("preparation_join_type_mismatch");
      });
      const index = new Map<string, DataRow>();
      // Normalize key field IDs positionally; source field names need not match.
      const key = (table: DataTable, row: DataRow, keys: string[]) =>
        JSON.stringify(
          keys.map((k) => JSON.parse(dataKey(table.fields, row, [k]))[0][1]),
        );
      for (const row of right.rows) {
        budget.tick();
        if (rightKeys.some((k) => row[k] === null)) continue;
        const k = key(right, row, rightKeys);
        if (index.has(k)) dataFail("preparation_join_cardinality_violation");
        index.set(k, row);
      }
      const seenLeft = new Set<string>();
      const rightFields = right.fields.map((f) => ({
        ...f,
        id: node.rightPrefix + f.id,
        name: node.rightNamePrefix
          ? (node.rightNamePrefix + f.name).slice(0, 100)
          : f.name,
        nullable: node.mode === "left" || f.nullable,
        ...(f.currencyField
          ? { currencyField: node.rightPrefix + f.currencyField }
          : {}),
      }));
      output = {
        fields: [...left.fields, ...rightFields],
        rows: [],
        ...sourceContext([left, right]),
      };
      assertDataFields(output.fields);
      for (const row of left.rows) {
        budget.tick();
        const hasNull = leftKeys.some((k) => row[k] === null),
          k = key(left, row, leftKeys);
        if (!hasNull && node.cardinality === "one_to_one" && seenLeft.has(k))
          dataFail("preparation_join_cardinality_violation");
        seenLeft.add(k);
        const match = hasNull ? undefined : index.get(k);
        if (!match && node.mode === "inner") continue;
        const joined = { ...row };
        right.fields.forEach((f) => {
          joined[node.rightPrefix + f.id] = match?.[f.id] ?? null;
        });
        output.rows.push(joined);
      }
    } else {
      const input = execute(node.input);
      output = {
        ...input,
        fields: input.fields.map((f) => ({ ...f })),
        rows: input.rows.map((row) => ({ ...row })),
      };
      if (node.type === "select") {
        keysValid(input, node.fields);
        output.fields = node.fields.map((id) => ({ ...fieldOf(input, id) }));
        for (const f of output.fields)
          if (f.currencyField && !node.fields.includes(f.currencyField))
            dataFail("preparation_currency_field_required");
        output.rows = input.rows.map((row) =>
          Object.fromEntries(node.fields.map((id) => [id, row[id]])),
        );
      } else if (node.type === "rename") {
        for (const [id, name] of Object.entries(node.names)) {
          fieldOf(input, id);
          if (!name || name.length > 100) dataFail("data_field_invalid");
          output.fields.find((f) => f.id === id)!.name = name;
        }
      } else if (node.type === "filter") {
        const filter = compileRowExpression(node.expression, input.fields);
        if (filter.result.type !== "boolean")
          dataFail("data_filter_boolean_required");
        output.rows = input.rows
          .filter((row) => filter.evaluate(row, budget).value === true)
          .map((row) => ({ ...row }));
      } else if (node.type === "calculate") {
        if (input.fields.some((f) => f.id === node.fieldId))
          dataFail("preparation_field_exists");
        const expression = compileRowExpression(node.expression, input.fields);
        const currencyId =
          expression.result.currencyField || expression.result.currency
            ? node.fieldId.slice(0, 90) + ".currency"
            : undefined;
        const field: DataField = {
          id: node.fieldId,
          name: node.name,
          type: expression.result.type,
          nullable: expression.result.nullable,
          ...(expression.result.unit ? { unit: expression.result.unit } : {}),
          ...(currencyId ? { currencyField: currencyId } : {}),
        };
        output.fields.push(field);
        if (currencyId)
          output.fields.push({
            id: currencyId,
            name: node.name.slice(0, 91) + " currency",
            type: "string",
            nullable: true,
          });
        output.rows = input.rows.map((row) => {
          const result = expression.evaluate(row, budget);
          return {
            ...row,
            [node.fieldId]: result.value,
            ...(currencyId ? { [currencyId]: result.currency ?? null } : {}),
          };
        });
      } else if (node.type === "cast") {
        const original = fieldOf(input, node.fieldId);
        const expression = compileRowExpression(
          {
            kind: "call",
            fn: ("to_" + node.to) as "to_string",
            args: [{ kind: "field", fieldId: node.fieldId }],
          },
          input.fields,
        );
        if (original.unit)
          dataFail("preparation_unit_cast_requires_calculation");
        output.fields = output.fields.map((f) =>
          f.id === node.fieldId
            ? {
                ...f,
                type: node.to,
                nullable: f.nullable || node.onError === "null",
              }
            : f,
        );
        output.rows = input.rows.map((row) => {
          try {
            return {
              ...row,
              [node.fieldId]: expression.evaluate(row, budget).value,
            };
          } catch (error) {
            if (
              node.onError !== "null" ||
              !(error instanceof DataProcessingError) ||
              ![
                "data_cast_invalid",
                "decimal_invalid",
                "data_boolean_invalid",
                "data_date_invalid",
                "data_timestamp_invalid",
                "data_integer_invalid",
                "data_number_invalid",
                "data_string_required",
              ].includes(error.code)
            )
              throw error;
            rejectedRows++;
            return { ...row, [node.fieldId]: null };
          }
        });
      } else if (node.type === "replace") {
        const field = fieldOf(input, node.fieldId);
        validateDataValue(field.type, node.from, true);
        validateDataValue(field.type, node.to, field.nullable);
        output.rows = input.rows.map((row) => {
          budget.tick();
          const value = row[field.id];
          const equal =
            value === null
              ? node.from === null
              : node.from !== null &&
                compareDataValues(field.type, value, node.from) === 0;
          return { ...row, [field.id]: equal ? node.to : value };
        });
      } else if (node.type === "deduplicate") {
        keysValid(input, node.keys);
        const unique = new Map<string, DataRow>();
        for (const row of input.rows) {
          budget.tick();
          const key = dataKey(input.fields, row, node.keys);
          if (node.keep === "last" || !unique.has(key))
            unique.set(key, { ...row });
        }
        rejectedRows += input.rows.length - unique.size;
        output.rows = [...unique.values()];
      } else if (node.type === "group") {
        if (node.keys.length) keysValid(input, node.keys);
        if (!node.aggregates.length || node.aggregates.length > 50)
          dataFail("preparation_aggregate_limit");
        const groups = new Map<string, DataRow[]>();
        if (!node.keys.length) groups.set("[]", []);
        for (const row of input.rows) {
          budget.tick();
          const key = dataKey(input.fields, row, node.keys);
          const group = groups.get(key) ?? [];
          group.push(row);
          groups.set(key, group);
        }
        output = {
          fields: node.keys.map((k) => ({ ...fieldOf(input, k) })),
          rows: [],
          ...sourceContext([input]),
          aggregated: true,
        };
        const resultTypes = node.aggregates.map((a) =>
          aggregateData({ ...input, rows: [] }, a, budget),
        );
        node.aggregates.forEach((a, index) => {
          const cell = resultTypes[index]!;
          const field = a.fieldId ? fieldOf(input, a.fieldId) : undefined;
          const money =
            field?.currencyField &&
            !["count", "distinct_count", "any", "all"].includes(a.op);
          output.fields.push({
            id: a.id,
            name: a.name,
            type: cell.type,
            nullable: true,
            ...(cell.unit ? { unit: cell.unit } : {}),
            ...(money ? { currencyField: a.id + ".currency" } : {}),
          });
          if (money)
            output.fields.push({
              id: a.id + ".currency",
              name: a.name + " currency",
              type: "string",
              nullable: true,
            });
        });
        assertDataFields(output.fields);
        for (const rows of groups.values()) {
          const result: DataRow = Object.fromEntries(
            node.keys.map((k) => [k, rows[0]![k]]),
          );
          node.aggregates.forEach((a) => {
            const cell = aggregateData({ ...input, rows }, a, budget);
            result[a.id] = cell.value;
            if (output.fields.some((f) => f.id === a.id + ".currency"))
              result[a.id + ".currency"] = cell.currency ?? null;
          });
          output.rows.push(result);
        }
      } else return dataFail("preparation_operation_unknown");
    }
    validateDataTable(output, budget);
    visiting.delete(id);
    done.set(id, output);
    onNode?.(node, output);
    return output;
  };
  for (const node of graph.nodes) execute(node.id);
  const outputs = Object.fromEntries(
    graph.outputs.map((id) => [id, execute(id)]),
  );
  return {
    outputs,
    operations: budget.operations,
    warnings: [...budget.warnings],
    rejectedRows,
  };
}
