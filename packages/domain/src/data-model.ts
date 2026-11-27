import {
  compileRowExpression,
  dataFail,
  DataProcessingError,
  carryDeferredRounding,
  deferRounding,
  ProcessingBudget,
  roundingMark,
  useDeferredRounding,
  type DataExpression,
  type DataType,
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
import { isValidTimeZone } from "./metrics.js";
import {
  isTimeGrain,
  timeGrainBucket,
  type GroupByGrain,
} from "./time-grain.js";

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
  /** Presentation: grouping uses fieldId's stable value; a filter may name a label (resolveLabelLiterals). */
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
  /**
   * Per grouped date or timestamp dimension, the calendar bucket it is
   * grouped into (#838, ADR 0028): the group's value is the bucket's first
   * day, a date. A timestamp's day is its day in `timeZone`. Filters still
   * compare the dimension's own values.
   */
  groupByGrain?: GroupByGrain;
  /** The zone timestamp grains read days in (the workspace's); UTC if absent. */
  timeZone?: string;
  filter?: DataExpression;
  now?: string;
  limit?: number;
  offset?: number;
  /** "last" pages from the end of the ordered groups: offset counts groups
   * skipped from the end, and rows are still returned in ascending order, so a
   * time series shows its most recent points. */
  window?: "first" | "last";
  /**
   * Groups ordered by one of `measureIds` (#768), groups without a value
   * last, ties in the groups' own order, before `limit` and `offset` page
   * them: a table's top N. Without it, groups follow their dimensions.
   */
  orderBy?: ModelQueryOrder;
  /** Internal: groups ranked by their own values (`ModelQueryRank`). */
  rank?: ModelQueryRank;
}
/**
 * Internal (state widget, #900): every group ranked by its own dimension
 * values, once per group and lowest first, before `limit` and `offset`
 * page them; ties by `tieBreak`'s shown name (its label, else its value),
 * case-insensitively, then exactly, nameless last, then in the groups'
 * own order. Each result row carries its rank, and `rankCounts` counts
 * every group per rank, so a page, its total and its counts share one
 * grain. `key` names the ranking in snapshot and page keys. `ranker`
 * makes the rank function of one run, which sees every group once, in the
 * groups' own order (it may remember what it saw). Never with `orderBy`
 * or windowed measures.
 */
export interface ModelQueryRank {
  key: string;
  ranker: () => (values: Readonly<DataRow>) => number;
  tieBreak?: string;
}
export interface ModelQueryOrder {
  measureId: string;
  direction: "asc" | "desc";
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

/** A filter text that names neither a value nor a display name (#627). */
export interface FilterValueNote {
  dimensionId: string;
  value: string;
  /** A value or display name that differs only in case or spacing. */
  suggestion?: string;
}

const looseText = (text: string) =>
  text.trim().replace(/\s+/g, " ").toLocaleLowerCase();

/**
 * Filters compare a dimension's stable value, but people type the label they
 * see (`[Store] = "Google Play"`). A string compared with a labelled
 * dimension that is not one of its values but is one of its labels stands for
 * the values shown with that label; a string that is a value keeps its
 * meaning, so filters written with values (dashboards) are unchanged. A
 * string that is neither is noted (with a near match, never applied), and a
 * label of several values is reported for the scope check.
 */
function resolveLabelLiterals(
  expression: DataExpression,
  dimensions: ReadonlyMap<string, ModelDimension>,
  tableFor: (datasetId: string) => DataTable,
  budget: ProcessingBudget,
): {
  expression: DataExpression;
  unknown: FilterValueNote[];
  /** Per dimension, a label that stands for several values, and how many. */
  several: Map<string, { label: string; count: number }>;
} {
  const unknown: FilterValueNote[] = [],
    several = new Map<string, { label: string; count: number }>();
  const indexes = new Map<
    string,
    {
      type: DataType;
      values: Set<string>;
      byLabel: Map<string, unknown[]>;
      rows: number;
    }
  >();
  const checkedValues = new Map<string, boolean>();
  /** Whether `literal` is a stable value; stops at the first matching row. */
  const isValue = (dimension: ModelDimension, literal: string) => {
    const key = JSON.stringify([dimension.id, literal]);
    const known =
      checkedValues.get(key) ??
      indexes.get(dimension.id)?.values.has(JSON.stringify(literal));
    if (known !== undefined) return known;
    const found = tableFor(dimension.datasetId).rows.some((row) => {
      budget.tick();
      return row[dimension.fieldId] === literal;
    });
    checkedValues.set(key, found);
    return found;
  };
  const index = (dimension: ModelDimension) => {
    const known = indexes.get(dimension.id);
    if (known) return known;
    const table = tableFor(dimension.datasetId),
      type =
        table.fields.find((field) => field.id === dimension.fieldId)?.type ??
        "string",
      values = new Set<string>(),
      byLabel = new Map<string, Map<string, unknown>>();
    for (const row of table.rows) {
      budget.tick();
      const value = row[dimension.fieldId],
        label = row[dimension.labelFieldId!];
      if (value === null || value === undefined) continue;
      const key = JSON.stringify(value);
      values.add(key);
      if (typeof label !== "string") continue;
      const labelled = byLabel.get(label) ?? new Map<string, unknown>();
      labelled.set(key, value);
      byLabel.set(label, labelled);
    }
    const built = {
      type,
      values,
      byLabel: new Map(
        [...byLabel].map(([label, keyed]) => [label, [...keyed.values()]]),
      ),
      rows: table.rows.length,
    };
    indexes.set(dimension.id, built);
    return built;
  };
  /** A value or label equal to `literal` but for case and spacing. */
  const nearMatch = (
    built: ReturnType<typeof index>,
    literal: string,
  ): string | undefined => {
    const loose = looseText(literal);
    for (const label of built.byLabel.keys())
      if (looseText(label) === loose) return label;
    for (const key of built.values) {
      const value: unknown = JSON.parse(key);
      if (typeof value === "string" && looseText(value) === loose) return value;
    }
    return undefined;
  };
  /** The values a label literal stands for, or undefined to keep it. */
  const labelValues = (fieldId: string, literal: unknown) => {
    const dimension = dimensions.get(fieldId);
    if (!dimension?.labelFieldId || typeof literal !== "string") return;
    if (isValue(dimension, literal)) return;
    const built = index(dimension);
    const matched = built.byLabel.get(literal);
    if (!matched) {
      // Schema-only probes have no rows to name anything.
      if (
        built.rows > 0 &&
        !unknown.some(
          (note) => note.dimensionId === fieldId && note.value === literal,
        )
      ) {
        const suggestion = nearMatch(built, literal);
        unknown.push({
          dimensionId: fieldId,
          value: literal,
          ...(suggestion !== undefined ? { suggestion } : {}),
        });
      }
      return;
    }
    if (matched.length > 1)
      several.set(fieldId, { label: literal, count: matched.length });
    return { type: built.type, values: matched };
  };
  const rewrite = (node: DataExpression): DataExpression => {
    if (node.kind !== "call") return node;
    const args = node.args.map(rewrite);
    const [a, b] = args;
    if ((node.fn === "eq" || node.fn === "ne") && args.length === 2) {
      const pair =
        a?.kind === "field" && b?.kind === "literal"
          ? ([a, b] as const)
          : b?.kind === "field" && a?.kind === "literal"
            ? ([b, a] as const)
            : undefined;
      const resolved =
        pair && pair[1].type === "string"
          ? labelValues(pair[0].fieldId, pair[1].value)
          : undefined;
      if (pair && resolved) {
        if (resolved.values.length === 1)
          return {
            kind: "call",
            fn: node.fn,
            args: [
              pair[0],
              {
                kind: "literal",
                type: resolved.type,
                value: resolved.values[0],
              },
            ],
          };
        const any: DataExpression = {
          kind: "call",
          fn: "in",
          args: [
            pair[0],
            { kind: "literal", type: "json", value: resolved.values },
          ],
        };
        return node.fn === "eq"
          ? any
          : { kind: "call", fn: "not", args: [any] };
      }
    }
    if (
      node.fn === "in" &&
      a?.kind === "field" &&
      b?.kind === "literal" &&
      b.type === "json" &&
      Array.isArray(b.value)
    ) {
      let changed = false;
      const value = b.value.flatMap((candidate: unknown) => {
        const resolved = labelValues(a.fieldId, candidate);
        if (!resolved) return [candidate];
        changed = true;
        return resolved.values;
      });
      if (changed)
        return {
          kind: "call",
          fn: "in",
          args: [a, { kind: "literal", type: "json", value }],
        };
    }
    return { ...node, args };
  };
  return { expression: rewrite(expression), unknown, several };
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

/**
 * What these measures need from a query, following every measure they read
 * as the query does: `grain` must be grouped by or fixed to one value by the
 * filter (requiredDimensions); `perDate` must be grouped by (the date of a
 * rolling or day/week comparison, which a filter cannot replace).
 */
function measureScope(
  model: SemanticModelDefinition,
  measureIds: readonly string[],
): { grain: Set<string>; perDate: Set<string>; window: Set<string> } {
  const measures = new Map(model.measures.map((m) => [m.id, m]));
  const seen = new Set<string>(),
    grain = new Set<string>(),
    perDate = new Set<string>(),
    window = new Set<string>();
  const visit = (id: string) => {
    const measure = measures.get(id);
    if (!measure || seen.has(id)) return;
    seen.add(id);
    for (const dimension of measure.requiredDimensions ?? [])
      grain.add(dimension);
    if (isWindowedMeasure(measure)) {
      window.add(measure.timeDimensionId);
      if (windowNeedsTimeGrouping(measure))
        perDate.add(measure.timeDimensionId);
    }
    measureDependencies(measure).forEach(visit);
  };
  measureIds.forEach(visit);
  return { grain, perDate, window };
}
const inModelOrder = (model: SemanticModelDefinition, ids: Set<string>) =>
  model.dimensions.map((d) => d.id).filter((id) => ids.has(id));

/**
 * The dimensions a query must group by (or, for requiredDimensions, fix to
 * one value with its filter) to read these measures. Ordered as the model
 * lists its dimensions; unknown measures and dimensions are left to the
 * query. The same set as the published catalog's measureRequiredDimensions,
 * which Studio binds with.
 */
export function modelMeasureScope(
  model: SemanticModelDefinition,
  measureIds: readonly string[],
): string[] {
  const { grain, perDate } = measureScope(model, measureIds);
  return inModelOrder(model, new Set([...grain, ...perDate]));
}

/**
 * The dimensions these measures are read per value of (#838): what they
 * require (modelMeasureScope) and the date their rolling windows and period
 * comparisons run on. A time grain that buckets such a dimension (a week,
 * a month, a timestamp's day) is refused by the query, so a widget's
 * validation and Studio's choices both read this one rule.
 */
export function modelMeasureFixedGrainDimensions(
  model: SemanticModelDefinition,
  measureIds: readonly string[],
): string[] {
  const { grain, perDate, window } = measureScope(model, measureIds);
  return inModelOrder(model, new Set([...grain, ...perDate, ...window]));
}

/** The part of modelMeasureScope only grouping satisfies: window dates. */
export function modelMeasureDateScope(
  model: SemanticModelDefinition,
  measureIds: readonly string[],
): string[] {
  return inModelOrder(model, measureScope(model, measureIds).perDate);
}

/** The required dimensions a query neither groups by nor (where allowed) fixes to one value. */
export function missingModelMeasureScope(
  model: SemanticModelDefinition,
  query: Pick<ModelQuery, "measureIds" | "groupBy" | "filter">,
): string[] {
  const fixed = singleValueDimensions(query.filter);
  const { perDate } = measureScope(model, query.measureIds);
  return modelMeasureScope(model, query.measureIds).filter(
    (id) => !query.groupBy.includes(id) && (perDate.has(id) || !fixed.has(id)),
  );
}

/**
 * The row fields a formula sees for its dependencies' cells: each currency
 * becomes a currency field next to the measure, under an id no other field uses.
 */
function formulaFields(
  dependencies: ReadonlyArray<readonly [string, DataCell]>,
  nameOf: (id: string) => string,
  hasCurrency: (cell: DataCell) => boolean,
): { measures: DataField[]; currencies: DataField[] } {
  const measures: DataField[] = [],
    currencies: DataField[] = [];
  const usedIds = new Set(dependencies.map(([ref]) => ref));
  for (const [ref, result] of dependencies) {
    const f: DataField = {
      id: ref,
      name: nameOf(ref),
      type: result.type,
      nullable: true,
      ...(result.unit ? { unit: result.unit } : {}),
    };
    if (hasCurrency(result)) {
      let currencyId = ref + ".currency";
      while (usedIds.has(currencyId)) currencyId += ".currency";
      usedIds.add(currencyId);
      f.currencyField = currencyId;
      currencies.push({
        id: currencyId,
        name: "Currency",
        type: "string",
        nullable: false,
      });
    }
    measures.push(f);
  }
  return { measures, currencies };
}

/** A formula over its dependencies' cells; currencies become currency fields. */
function evaluateFormula(
  expression: DataExpression,
  dependencies: ReadonlyArray<readonly [string, DataCell]>,
  nameOf: (id: string) => string,
  budget: ProcessingBudget,
): DataCell {
  const { measures, currencies } = formulaFields(
    dependencies,
    nameOf,
    (cell) => !!cell.currency,
  );
  const row: DataRow = {},
    sources: Record<string, DataCell> = {};
  dependencies.forEach(([ref, result], i) => {
    row[ref] = result.value;
    sources[ref] = result;
    const currencyField = measures[i]!.currencyField;
    if (currencyField) row[currencyField] = result.currency;
  });
  // The result's error bound lets the caller defer its rounding (#680).
  return compileRowExpression(expression, [...currencies, ...measures], {
    traceResult: true,
  }).evaluate(row, budget, sources);
}

/**
 * Each measure's probe cell (see `measureTypeProbe`); measures whose probe
 * fails are left out. One pass over the model when every measure checks.
 */
export function probeModelMeasures(
  model: SemanticModelDefinition,
  sources: ReadonlyMap<string, Pick<DataTable, "fields">>,
): Map<string, DataCell> {
  const ids = model.measures.map((m) => m.id);
  try {
    return measureTypeProbe(model, sources, ids);
  } catch {
    const cells = new Map<string, DataCell>();
    for (const id of ids)
      try {
        const cell = measureTypeProbe(model, sources, [id]).get(id);
        if (cell) cells.set(id, cell);
      } catch {
        // Not usable in a formula until the measure itself is fixed.
      }
    return cells;
  }
}

/**
 * The measures a formula measure may reference, as the row fields its formula
 * is checked against: every measure except `measureId` and those depending on
 * it (directly or through others), typed by its probe. A currency measure gets
 * a currency field, as it has whenever the query sees a currency. Measures
 * whose probe fails are left out. Pass `probed` (`probeModelMeasures`) to
 * type several measures' fields from one probe.
 */
export function formulaMeasureFields(
  model: SemanticModelDefinition,
  sources: ReadonlyMap<string, Pick<DataTable, "fields">>,
  measureId: string,
  probed: ReadonlyMap<string, DataCell> = probeModelMeasures(model, sources),
): DataField[] {
  // Everything that reaches measureId, by walking dependents backwards.
  const dependents = new Map<string, string[]>();
  for (const measure of model.measures)
    for (const dependency of measureDependencies(measure))
      dependents.set(dependency, [
        ...(dependents.get(dependency) ?? []),
        measure.id,
      ]);
  const excluded = new Set([measureId]),
    queue = [measureId];
  while (queue.length)
    for (const dependent of dependents.get(queue.shift()!) ?? [])
      if (!excluded.has(dependent)) {
        excluded.add(dependent);
        queue.push(dependent);
      }
  const names = new Map(model.measures.map((m) => [m.id, m.name]));
  const cells = model.measures
    .filter((m) => !excluded.has(m.id) && probed.has(m.id))
    .map((m) => [m.id, probed.get(m.id)!] as const);
  return formulaFields(
    cells,
    (id) => names.get(id)!,
    (cell) => !!cell.currency || cell.unit === "currency",
  ).measures;
}

/**
 * The type, unit and currency each measure has over no rows. Windowed outputs
 * derive theirs from the base, so formulas over rolling and offset measures
 * type-check without a date to evaluate them at.
 */
export function measureTypeProbe(
  model: SemanticModelDefinition,
  sources: ReadonlyMap<string, Pick<DataTable, "fields">>,
  ids: readonly string[],
  budget = new ProcessingBudget(),
): Map<string, DataCell> {
  const measures = new Map(model.measures.map((m) => [m.id, m]));
  const cells = new Map<string, DataCell>(),
    visiting = new Set<string>();
  const visit = (id: string): DataCell => {
    const cached = cells.get(id);
    if (cached) return cached;
    if (visiting.has(id)) dataFail("model_measure_cycle");
    const m = measures.get(id);
    if (!m) return dataFail("model_measure_not_found", id);
    visiting.add(id);
    budget.tick();
    let cell: DataCell;
    if (m.kind === "aggregate") {
      if (!model.datasets.includes(m.datasetId))
        dataFail("model_dataset_not_declared");
      const source = sources.get(m.datasetId);
      if (!source) dataFail("model_dataset_unavailable");
      const { partial: _partial, ...aggregated } = aggregateData(
        { fields: source.fields, rows: [] },
        m.aggregate,
        budget,
      );
      cell = aggregated;
    } else if (m.kind === "formula")
      cell = evaluateFormula(
        m.expression,
        [...references(m.expression)].map((ref) => [ref, visit(ref)] as const),
        (ref) => measures.get(ref)!.name,
        budget,
      );
    else {
      validateWindowDefinition(m);
      const base = visit(m.baseMeasureId);
      // change and percent_change check the base is numeric, as at query time.
      cell =
        m.kind === "period_offset" && m.output !== "value"
          ? windowChange(m.id, m.output, base, base, budget)
          : windowCell(base);
    }
    visiting.delete(id);
    cells.set(id, cell);
    return cell;
  };
  ids.forEach(visit);
  return cells;
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
  if (
    query.orderBy !== undefined &&
    (!query.measureIds.includes(query.orderBy.measureId) ||
      !["asc", "desc"].includes(query.orderBy.direction))
  )
    dataFail("model_result_order_invalid");
  if (
    query.rank !== undefined &&
    (query.orderBy !== undefined ||
      typeof query.rank.ranker !== "function" ||
      (query.rank.tieBreak !== undefined &&
        !query.groupBy.includes(query.rank.tieBreak)))
  )
    dataFail("model_result_order_invalid");
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
  // Time grains (#838): a grouped date or timestamp read as the first day of
  // its day, week or month. Groups are keyed, ordered and returned by that
  // date; `dimensionFields` keeps the dimension's own type for filters.
  const timeZone = query.timeZone ?? "UTC";
  const grainBuckets = new Map<string, (value: string) => string>();
  for (const [id, grain] of Object.entries(query.groupByGrain ?? {})) {
    if (!isValidTimeZone(timeZone)) dataFail("model_time_zone_invalid");
    if (!isTimeGrain(grain)) dataFail("model_group_grain_invalid", id);
    if (!query.groupBy.includes(id))
      dataFail("model_group_grain_not_grouped", id);
    const type = dimensionFields.find((field) => field.id === id)!.type;
    if (type !== "date" && type !== "timestamp")
      dataFail("model_group_grain_not_temporal", id);
    // A date is its own day.
    if (type === "date" && grain === "day") continue;
    grainBuckets.set(id, timeGrainBucket(type, grain, timeZone));
  }
  const groupFields = grainBuckets.size
    ? dimensionFields.map((field) =>
        grainBuckets.has(field.id)
          ? { ...field, type: "date" as const }
          : field,
      )
    : dimensionFields;
  /** The row's dimension values as its group shows them. */
  const groupedValues = (values: DataRow): DataRow => {
    if (!grainBuckets.size) return values;
    const bucketed = { ...values };
    for (const [id, bucket] of grainBuckets) {
      const value = values[id];
      if (value !== null && value !== undefined) {
        budget.tick();
        bucketed[id] = bucket(value as string);
      }
    }
    return bucketed;
  };
  const resolved = query.filter
    ? resolveLabelLiterals(
        query.filter,
        dimensions,
        (datasetId) => table(datasetId),
        budget,
      )
    : undefined;
  const queryFilter = resolved?.expression;
  if (resolved?.unknown.length)
    budget.warnings.add("model_filter_value_unknown");
  const filter = queryFilter
    ? compileRowExpression(queryFilter, dimensionFields)
    : undefined;
  if (filter && filter.result.type !== "boolean")
    dataFail("model_filter_boolean_required");
  const neededDatasets = new Set<string>(),
    visiting = new Set<string>(),
    validatedMeasures = new Set<string>(),
    windowed: WindowedMeasure[] = [];
  const fixedDimensions = singleValueDimensions(queryFilter);
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
    // A week or month holds several of the dimension's values: only the
    // dimension itself, or a filter fixing it, gives a measure its scope.
    const unscoped = grain.filter(
      (dimension) =>
        (!query.groupBy.includes(dimension) || grainBuckets.has(dimension)) &&
        !fixedDimensions.has(dimension),
    );
    // A display name of several values (two apps named alike) fixes none.
    const shared = unscoped.find((dimension) =>
      resolved?.several.has(dimension),
    );
    if (shared)
      throw new DataProcessingError(
        "model_filter_label_several_values",
        shared,
        undefined,
        resolved!.several.get(shared)!.count,
      );
    if (unscoped.length) dataFail("model_measure_scope_required");
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
    // Windows are evaluated per date of their dimension.
    if (grainBuckets.has(dimensionId))
      dataFail("model_group_grain_window_unsupported", dimensionId);
    const grouped = query.groupBy.includes(dimensionId);
    if (!grouped && windowed.some(windowNeedsTimeGrouping))
      dataFail("model_window_time_grouping_required", dimensionId);
    const { range, residual } = modelQueryTimeRange(queryFilter, dimensionId);
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
    undated = new Map<string, Map<string, DataRow[]>>(),
    earliest = new Map<string, string>();
  // A reversed closed range selects no dates: a windowed query then has no
  // rows at all, ungrouped too, rather than comparing a reversed interval.
  const emptyRange =
    windowPlan !== undefined &&
    windowPlan.from !== null &&
    windowPlan.to !== null &&
    windowPlan.from > windowPlan.to;
  if (!query.groupBy.length && !emptyRange) groupValues.set("[]", {});
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
      // The row's values as its group shows them (#838): bucketed once,
      // and only for a row no filter or window bound has excluded.
      let shown: DataRow;
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
        // Without a date bound the query keeps undated rows, as it would
        // without windowed measures; windows are only missing there.
        if (
          date === null
            ? windowPlan.from !== null || windowPlan.to !== null
            : (windowPlan.lowest !== null && date < windowPlan.lowest) ||
              (windowPlan.to !== null && date > windowPlan.to)
        )
          continue;
        shown = groupedValues(values);
        const partition = dataKey(groupFields, shown, windowPlan.partitionBy);
        if (date === null) {
          const datasetUndated =
            undated.get(datasetId) ?? new Map<string, DataRow[]>();
          undated.set(datasetId, datasetUndated);
          const rows = datasetUndated.get(partition) ?? [];
          rows.push(row);
          datasetUndated.set(partition, rows);
        } else {
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
        }
      } else if (filter && filter.evaluate(values, budget).value !== true)
        continue;
      else shown = groupedValues(values);
      const group = dataKey(groupFields, shown, query.groupBy);
      if (!groupValues.has(group))
        groupValues.set(
          group,
          Object.fromEntries(query.groupBy.map((id) => [id, shown[id]])),
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
    /** With `query.rank`: the group's rank. */
    rank?: number;
    measures: Record<string, ModelMeasureResult>;
  }> = [];
  // Display names of the dimensions that show or name values: the grouped
  // ones and those the filter reads. A bucketed dimension shows dates, not
  // its labelled values (#838), so only a filter on it reads its names; a
  // scan of its rows nothing uses would be charged to the budget.
  const filtered = new Set(queryFilter ? references(queryFilter) : []);
  const displayLabels = new Map(
    [...required]
      .filter((id) => !grainBuckets.has(id) || filtered.has(id))
      .map((id) => {
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
      const type = groupFields.find((field) => field.id === id)!.type;
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
  ): DataCell =>
    evaluateFormula(
      expression,
      dependencies,
      (id) => measures.get(id)!.name,
      budget,
    );
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
    const mark = roundingMark(budget);
    let cell: DataCell,
      computed: (DataCell & { partial?: true }) | undefined,
      // The base result this one shows unchanged (rolling, offset value).
      same: WindowedResult | undefined,
      partial: boolean,
      incomplete = false,
      comparedTo: { from: string; to: string } | undefined;
    if (m.kind === "aggregate") {
      computed = aggregateData(
        {
          ...table(m.datasetId),
          rows: rowsIn(m.datasetId, partition, from, to),
          pendingSources: [...(pendingByDataset.get(m.datasetId) ?? [])],
        },
        m.aggregate,
        budget,
      );
      const { partial: waiting, ...aggregated } = computed;
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
      cell = computed = formulaCell(m.expression, dependencies);
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
      same = base;
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
        same = previous;
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
        useDeferredRounding(budget, current);
        useDeferredRounding(budget, previous);
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
    if (computed) deferRounding(budget, mark, computed, result);
    else if (same) carryDeferredRounding(budget, same, result);
    windowCache.set(cacheKey, result);
    return result;
  };
  // The undated group of an unbounded query: measures without a window
  // aggregate its rows, windowed ones are missing.
  let typeProbe: Map<string, DataCell> | undefined;
  const undatedCache = new Map<string, ModelMeasureResult>();
  const evaluateUndated = (
    partition: string,
    id: string,
  ): ModelMeasureResult => {
    const cacheKey = JSON.stringify([partition, id]);
    const cached = undatedCache.get(cacheKey);
    if (cached) return cached;
    const m = measures.get(id)!;
    budget.tick();
    const mark = roundingMark(budget);
    let cell: DataCell,
      computed: (DataCell & { partial?: true }) | undefined,
      partial = false;
    if (m.kind === "aggregate") {
      computed = aggregateData(
        {
          ...table(m.datasetId),
          rows: undated.get(m.datasetId)?.get(partition) ?? [],
          pendingSources: [...(pendingByDataset.get(m.datasetId) ?? [])],
        },
        m.aggregate,
        budget,
      );
      const { partial: waiting, ...aggregated } = computed;
      cell = aggregated;
      partial = !!waiting;
    } else if (m.kind === "formula") {
      const dependencies = [...references(m.expression)].map(
        (ref) => [ref, evaluateUndated(partition, ref)] as const,
      );
      cell = computed = formulaCell(m.expression, dependencies);
      partial = dependencies.some(([, result]) => result.status !== "ok");
    } else {
      typeProbe ??= measureTypeProbe(model, sources, query.measureIds, budget);
      cell = { ...typeProbe.get(id)!, value: null };
    }
    const result: ModelMeasureResult = {
      ...cell,
      status: cell.value === null ? "missing" : partial ? "partial" : "ok",
    };
    if (computed) deferRounding(budget, mark, computed, result);
    undatedCache.set(cacheKey, result);
    return result;
  };
  const windowedMeasure = (
    values: DataRow,
    id: string,
    shown = true,
  ): ModelMeasureResult => {
    const w = windowPlan!;
    const date = w.grouped
      ? (values[w.dimensionId] as string | null)
      : undefined;
    if (date === null) {
      const undatedResult = evaluateUndated(
        dataKey(groupFields, values, w.partitionBy),
        id,
      );
      if (shown) useDeferredRounding(budget, undatedResult);
      return undatedResult;
    }
    const windowed = evaluateWindowed(
      dataKey(groupFields, values, w.partitionBy),
      id,
      date ?? w.from!,
      date ?? w.to!,
      false,
    );
    // Shown as it is: a deferred rounding warns (#680).
    if (shown) useDeferredRounding(budget, windowed);
    const { incomplete: _incomplete, ...result } = windowed;
    return result;
  };
  // Each group's measures, evaluated once: ordering by a measure (#768)
  // reads the groups it then leaves out, and those never warn.
  const groupCaches = new Map<string, Map<string, ModelMeasureResult>>();
  const evaluatorOf = (key: string) => {
    let cache = groupCaches.get(key);
    if (!cache) groupCaches.set(key, (cache = new Map()));
    const groupCache = cache;
    const evaluate = (id: string): ModelMeasureResult => {
      const cache = groupCache;
      const cached = cache.get(id);
      if (cached) return cached;
      const m = measures.get(id)!;
      budget.tick();
      const mark = roundingMark(budget);
      let cell: DataCell,
        computed: DataCell & { partial?: true },
        status: ModelMeasureResult["status"] = "ok";
      if (m.kind === "aggregate") {
        computed = aggregateData(
          {
            ...table(m.datasetId),
            rows: grouped.get(m.datasetId)?.get(key) ?? [],
            pendingSources: [...(pendingByDataset.get(m.datasetId) ?? [])],
          },
          m.aggregate,
          budget,
        );
        const { partial, ...aggregated } = computed;
        cell = aggregated;
        if (partial) status = "partial";
      } else {
        // Windowed measures are evaluated by evaluateWindowed only.
        if (m.kind !== "formula") return dataFail("model_window_unsupported");
        const dependencies = [...references(m.expression)].map(
          (ref) => [ref, evaluate(ref)] as const,
        );
        cell = computed = formulaCell(m.expression, dependencies);
        if (dependencies.some(([, result]) => result.status !== "ok"))
          status = "partial";
      }
      if (cell.value === null) status = "missing";
      const result = { ...cell, status };
      deferRounding(budget, mark, computed, result);
      cache.set(id, result);
      return result;
    };
    return evaluate;
  };
  if (query.orderBy) {
    const { measureId, direction } = query.orderBy;
    const sign = direction === "desc" ? -1 : 1;
    const valueOf = new Map(
      orderedGroups.map(([key, values]) => {
        const cell = windowPlan
          ? windowedMeasure(values, measureId, false)
          : evaluatorOf(key)(measureId);
        return [key, cell] as const;
      }),
    );
    const position = new Map(
      orderedGroups.map(([key], index) => [key, index] as const),
    );
    // Numbers by value; amounts by value within a currency, currencies by
    // code (amounts in different currencies are never compared).
    orderedGroups.sort(([a], [b]) => {
      budget.tick();
      const left = valueOf.get(a)!,
        right = valueOf.get(b)!;
      const missing =
        Number(left.value === null || left.value === undefined) -
        Number(right.value === null || right.value === undefined);
      if (missing) return missing;
      if (left.value !== null && left.value !== undefined) {
        const currency = (left.currency ?? "").localeCompare(
          right.currency ?? "",
          "und",
        );
        if (currency) return currency;
        if (left.type === right.type && left.type !== "json") {
          const comparison = compareDataValues(
            left.type,
            left.value,
            right.value,
          );
          if (comparison) return sign * comparison;
        }
      }
      return position.get(a)! - position.get(b)!;
    });
  }
  // Ranked by the groups' own values (#900): each group once, every group
  // counted, before the page is cut.
  let rankOf: Map<string, number> | undefined;
  let rankCounts: Record<number, number> | undefined;
  if (query.rank) {
    if (windowPlan) dataFail("model_result_order_invalid");
    const { tieBreak } = query.rank;
    const of = query.rank.ranker();
    rankOf = new Map();
    rankCounts = {};
    for (const [key, values] of orderedGroups) {
      budget.tick();
      const rank = of(values);
      if (!Number.isSafeInteger(rank)) dataFail("model_result_order_invalid");
      rankOf.set(key, rank);
      rankCounts[rank] = (rankCounts[rank] ?? 0) + 1;
    }
    const tieDimension = tieBreak ? dimensions.get(tieBreak)! : undefined;
    const nameOf = (values: DataRow): string | null => {
      if (!tieDimension) return null;
      const value = values[tieDimension.id];
      if (value === null || value === undefined) return null;
      const label = displayLabels
        .get(tieDimension.id)
        ?.get(
          dataKey(
            table(tieDimension.datasetId).fields,
            { [tieDimension.fieldId]: value },
            [tieDimension.fieldId],
          ),
        );
      return label ?? String(value);
    };
    const keyed = orderedGroups.map(([key, values], position) => {
      const name = nameOf(values);
      return {
        entry: [key, values] as [string, DataRow],
        rank: rankOf!.get(key)!,
        name,
        folded: name?.toLowerCase() ?? null,
        position,
      };
    });
    keyed.sort((a, b) => {
      budget.tick();
      if (a.rank !== b.rank) return a.rank - b.rank;
      if ((a.name === null) !== (b.name === null))
        return a.name === null ? 1 : -1;
      if (a.folded !== b.folded) return a.folded! < b.folded! ? -1 : 1;
      if (a.name !== b.name) return a.name! < b.name! ? -1 : 1;
      return a.position - b.position;
    });
    // In place, element by element: spreading every group into one call
    // overflows the argument limit on large models (#900).
    keyed.forEach((k, index) => (orderedGroups[index] = k.entry));
  }
  for (const [key, values] of orderedGroups.slice(start, end)) {
    const evaluate = evaluatorOf(key);
    const labels = Object.fromEntries(
      query.groupBy.flatMap((id) => {
        // A bucket is a date, not one of the dimension's labelled values.
        if (grainBuckets.has(id)) return [];
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
      ...(rankOf ? { rank: rankOf.get(key)! } : {}),
      ...(Object.keys(labels).length ? { dimensionLabels: labels } : {}),
      measures: Object.fromEntries(
        query.measureIds.map((id) => {
          if (windowPlan) return [id, windowedMeasure(values, id)];
          const result = evaluate(id);
          // Shown as it is: a deferred rounding warns (#680).
          useDeferredRounding(budget, result);
          return [id, result];
        }),
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
  if (queryFilter) collectLiterals(queryFilter);
  const filterValueLabels: Array<{
    dimensionId: string;
    value: unknown;
    label: string;
  }> = [];
  for (const id of filtered) {
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
    ...(resolved?.unknown.length ? { filterValueNotes: resolved.unknown } : {}),
    ...([...pendingByDataset.values()].some((pending) => pending.size)
      ? {
          pendingSources: [
            ...new Set(
              [...pendingByDataset.values()].flatMap((pending) => [...pending]),
            ),
          ],
        }
      : {}),
    ...(rankCounts ? { rankCounts } : {}),
    totalRows: orderedGroups.length,
    offset: start,
    warnings: [...budget.warnings],
    operations: budget.operations,
    provenance: [...lineage.values()],
    appliedFilter: queryFilter ?? null,
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
  // The grouped probes above see no dates over empty tables, so type-check
  // windowed measures and formulas over them statically.
  if (windowedModel)
    measureTypeProbe(
      unguarded,
      schemas,
      model.measures.map((measure) => measure.id),
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
