import { currencyExponent } from "./currency.js";
import {
  compareDataValues,
  exactDecimal,
  dataFail,
  validateDataValue,
  type DataExpression,
  type DataType,
} from "./data-expression.js";
import { compareMeasureFilter } from "./compare-measure.js";
import {
  isMappableServiceStateValue,
  serviceStateClassifier,
  serviceStateKey,
  serviceStateRank,
  type ServiceState,
} from "./service-state.js";
import type {
  ModelQuery,
  ModelQueryOrder,
  SemanticModelDefinition,
} from "./data-model.js";
import { isTimeGrain, TIME_GRAINS, type TimeGrain } from "./time-grain.js";

export type DashboardFilterType = Exclude<DataType, "json">;
export type DashboardFilterValue =
  | { kind: "values"; values: unknown[] }
  | { kind: "range"; from: unknown | null; to: unknown | null }
  | null;
export interface DashboardDataFilter {
  id: string;
  name: string;
  type: DashboardFilterType;
  mode: "values" | "range";
  mappings: Array<{ modelId: string; dimensionId: string }>;
  defaultValue: DashboardFilterValue;
  /** Fixed scopes are conjoined with viewer choices, never replaced by them. */
  fixedValue?: DashboardFilterValue;
}
/**
 * A paired screen's fixed scope (#500): per shared dashboard filter, the
 * values or range the screen may show. Conjoined with the filter's saved
 * choice and its dashboard-wide fixed scope, like `fixedValue`; it can only
 * narrow what the screen shows, never widen it.
 */
export type DeviceFilterScope = Readonly<
  Record<string, Exclude<DashboardFilterValue, null>>
>;
export interface DashboardFilterExclusion {
  filterId: string;
  reason: string;
}
export interface MeasureWidgetBinding {
  modelId: string;
  measureIds: string[];
  groupBy: string[];
  /**
   * Per grouped date or timestamp dimension, the calendar bucket it is
   * grouped into (#838, ADR 0028): "new items per day" of a timestamp. The
   * group's value is the bucket's first day, a date; a timestamp's day is
   * its day in the workspace time zone. Absent: the dimension's own values.
   */
  groupByGrain?: Record<string, TimeGrain>;
  filter?: DataExpression;
  exclusions: DashboardFilterExclusion[];
  /** Declared chart-to-filter interaction: selecting a category, point or
   * row value sets this shared filter (ADR 0022). Viewer-side only; the
   * server evaluates the resulting choice like any other. */
  interaction?: MeasureWidgetInteraction;
}
export interface MeasureWidgetInteraction {
  filterId: string;
}
export const DASHBOARD_MEASURE_VIEWS = [
  "value",
  "table",
  "bar",
  "line",
] as const;
export type DashboardMeasureView = (typeof DASHBOARD_MEASURE_VIEWS)[number];

const field = (fieldId: string): DataExpression => ({ kind: "field", fieldId });
const literal = (
  type: DashboardFilterType,
  value: unknown,
): DataExpression => ({
  kind: "literal",
  type,
  value,
});
function combine(
  fn: "and" | "or",
  parts: DataExpression[],
): DataExpression | undefined {
  if (!parts.length) return undefined;
  if (parts.length === 1) return parts[0];
  const middle = Math.ceil(parts.length / 2);
  return {
    kind: "call",
    fn,
    args: [
      combine(fn, parts.slice(0, middle))!,
      combine(fn, parts.slice(middle))!,
    ],
  };
}
function predicate(
  filter: DashboardDataFilter,
  dimensionId: string,
  value: DashboardFilterValue,
): DataExpression | undefined {
  if (value === null) return undefined;
  if (value.kind !== filter.mode)
    dataFail("dashboard_filter_value_invalid", filter.id);
  const comparison = (
    fn: "eq" | "gte" | "lte",
    raw: unknown,
  ): DataExpression => {
    validateDataValue(filter.type, raw, false);
    return {
      kind: "call",
      fn,
      args: [field(dimensionId), literal(filter.type, raw)],
    };
  };
  if (value.kind === "values") {
    if (!value.values.length) return undefined;
    for (const raw of value.values) validateDataValue(filter.type, raw, true);
    const nonnull = value.values.filter((raw) => raw !== null);
    const parts: DataExpression[] = nonnull.length
      ? [
          {
            kind: "call",
            fn: "in",
            args: [
              field(dimensionId),
              { kind: "literal", type: "json", value: nonnull },
            ],
          },
        ]
      : [];
    if (value.values.includes(null))
      parts.push({ kind: "call", fn: "is_null", args: [field(dimensionId)] });
    return combine("or", parts);
  }
  if (filter.type === "boolean")
    dataFail("dashboard_filter_range_invalid", filter.id);
  const parts: DataExpression[] = [];
  if (value.from !== null) parts.push(comparison("gte", value.from));
  if (value.to !== null) parts.push(comparison("lte", value.to));
  if (
    value.from !== null &&
    value.to !== null &&
    compareDataValues(filter.type, value.from, value.to) > 0
  )
    dataFail("dashboard_filter_range_invalid", filter.id);
  return combine("and", parts);
}

/**
 * Checks a screen's fixed scope against the dashboard's filters: every
 * entry names a filter, matches its mode and type, and restricts something.
 * An entry that would not restrict (an empty list, an open range) is refused
 * rather than read as "everything".
 */
export function validateDeviceFilterScope(
  filters: readonly DashboardDataFilter[],
  scope: DeviceFilterScope,
): void {
  validateFilterScope(filters, scope, "device");
}

/**
 * A slide's scope (#707): per shared dashboard filter, the values or range
 * every widget on the slide applies, as a fixed value of that slide. The
 * same shape and rules as a screen's fixed scope.
 */
export type SlideFilterScope = DeviceFilterScope;

/** Checks a slide's scope like a screen's (`slide_scope_*` codes). */
export function validateSlideFilterScope(
  filters: readonly DashboardDataFilter[],
  scope: SlideFilterScope,
): void {
  validateFilterScope(filters, scope, "slide");
}

function validateFilterScope(
  filters: readonly DashboardDataFilter[],
  scope: DeviceFilterScope,
  of: "device" | "slide",
): void {
  for (const [filterId, value] of Object.entries(scope)) {
    const filter = filters.find((filter) => filter.id === filterId);
    if (!filter) dataFail(`${of}_scope_filter_unknown`, filterId);
    let restricts: DataExpression | undefined;
    try {
      restricts = predicate(filter, filter.id, value);
    } catch {
      dataFail(`${of}_scope_value_invalid`, filterId);
    }
    if (!restricts) dataFail(`${of}_scope_value_invalid`, filterId);
  }
}

/**
 * Whether a slide's scope and a screen's fixed scope leave nothing to show
 * for some filter they both set: no common value, or ranges that do not
 * overlap (#707). Such a slide is about something the screen may not show;
 * screens skip it instead of showing it empty. Both scopes are taken as
 * valid for `filters` (validateSlideFilterScope, validateDeviceFilterScope).
 */
export function slideScopeConflicts(
  filters: readonly DashboardDataFilter[],
  slide: SlideFilterScope,
  screen: DeviceFilterScope,
): boolean {
  return filters.some((filter) => {
    const a = Object.hasOwn(slide, filter.id) ? slide[filter.id] : undefined;
    const b = Object.hasOwn(screen, filter.id) ? screen[filter.id] : undefined;
    if (!a || !b) return false;
    if (a.kind === "values" && b.kind === "values")
      return !a.values.some((value) =>
        b.values.some((other) =>
          // As the query compares them: by the filter's type ("1.0" is
          // "1.00"); null (unmatched) only matches null.
          value === null || other === null
            ? value === other
            : compareDataValues(filter.type, value, other) === 0,
        ),
      );
    if (a.kind === "range" && b.kind === "range") {
      const before = (to: unknown, from: unknown) =>
        to !== null &&
        from !== null &&
        compareDataValues(filter.type, to, from) < 0;
      return before(a.to, b.from) || before(b.to, a.from);
    }
    return false;
  });
}

/**
 * The source-app identity of a connection's resource,
 * `<connectionId>:<resourceId>`: what the App Portfolio template's app
 * filter holds for an app that is not grouped into a product.
 */
export function connectionResourceKey(
  connectionId: string,
  resourceId: string,
): string {
  return `${connectionId}:${resourceId}`;
}

const RESOURCE_KEY =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(.+)$/i;

/**
 * How a widget that reads a connection's metrics (metric, line, bar,
 * table, latest review) follows its slide's scope (#707). Such widgets
 * cannot apply model filters; they follow a scoped filter only through
 * their `resource` dimension, when the widget does not exclude the filter
 * and its values all name apps, exactly one of them of the widget's
 * connection. A value names apps as a connection resource
 * (connectionResourceKey) or, through `apps`, as a linked product
 * (`product:<id>`, #777) that stands for its member apps. Values that name
 * other connections' resources are rows that connection cannot have.
 *
 * `follows` lists the filters the widget follows that way, so they need no
 * exclusion; `resource` is the resource they pick, or undefined when none
 * does. `conflict` is true when they pick different resources, or one other
 * than the widget's own `ownResource`: the widget would show nothing.
 */
/** The widgets that follow a slide's scope through their resource (#707). */
export function followsSlideScopeResource(type: string): boolean {
  return ["metric", "line", "bar", "table", "review"].includes(type);
}

export function slideScopeResource(
  scope: SlideFilterScope,
  connectionId: string,
  exclusions: readonly DashboardFilterExclusion[],
  ownResource?: string,
  /** App keys (connectionResourceKey) per value that names a product. */
  apps: ProductApps = NO_PRODUCT_APPS,
): { follows: string[]; resource?: string; conflict: boolean } {
  const follows: string[] = [],
    picked = new Set<string>();
  for (const [filterId, value] of Object.entries(scope)) {
    if (
      value.kind !== "values" ||
      exclusions.some((exclusion) => exclusion.filterId === filterId)
    )
      continue;
    const named = value.values.map((raw) => namedApps(raw, apps));
    if (!named.length || named.some((keys) => keys === null || !keys.length))
      continue;
    const own = new Set<string>();
    for (const key of named.flat()) {
      const [, connection, resource] = RESOURCE_KEY.exec(key!)!;
      if (connection!.toLowerCase() === connectionId.toLowerCase())
        own.add(resource!);
    }
    if (own.size !== 1) continue;
    follows.push(filterId);
    picked.add([...own][0]!);
  }
  const [resource] = picked;
  return {
    follows,
    ...(resource !== undefined ? { resource } : {}),
    conflict:
      picked.size > 1 ||
      (resource !== undefined &&
        ownResource !== undefined &&
        ownResource !== resource),
  };
}

/**
 * The member apps of each linked product a scope value can name, as app
 * keys (connectionResourceKey): a map, or the record an API response
 * carries.
 */
export type ProductApps =
  | ReadonlyMap<string, readonly string[]>
  | Readonly<Record<string, readonly string[]>>;

const NO_PRODUCT_APPS: ProductApps = new Map();

/** The app keys a scope value names; null when it names no app. */
function namedApps(raw: unknown, apps: ProductApps): string[] | null {
  if (typeof raw !== "string") return null;
  if (RESOURCE_KEY.test(raw)) return [raw];
  const keys: readonly string[] | undefined =
    apps instanceof Map
      ? (apps as ReadonlyMap<string, readonly string[]>).get(raw)
      : Object.hasOwn(apps, raw)
        ? (apps as Readonly<Record<string, readonly string[]>>)[raw]
        : undefined;
  return keys?.filter((key) => RESOURCE_KEY.test(key)) ?? null;
}

/**
 * The resources of a connection a scope leaves a widget's freshness (#767,
 * ADR 0025 section 6): what a slide's or a screen's scope picks among the
 * apps of one connection a measure widget's model reads.
 *
 * A filter picks apps when the widget does not exclude it and each of its
 * values names apps: a connection resource (connectionResourceKey), or a
 * value `apps` resolves to them (a linked product's `product:<id>`, through
 * the install's mapping table). Its resources of this connection are the
 * apps its values name there; none when they name only other connections'
 * apps, which then add nothing to the widget's freshness. Filters with any
 * other value pick nothing (they are not about apps). Two filters that pick
 * apps leave the apps both pick.
 *
 * Undefined: no filter picks apps, so every selected resource counts.
 */
export function scopedFreshnessResources(
  scope: SlideFilterScope,
  connectionId: string,
  exclusions: readonly DashboardFilterExclusion[],
  /** App keys (connectionResourceKey) per value that names a product. */
  apps: ProductApps = NO_PRODUCT_APPS,
): string[] | undefined {
  let picked: Set<string> | undefined;
  for (const [filterId, value] of Object.entries(scope)) {
    if (
      value.kind !== "values" ||
      !value.values.length ||
      exclusions.some((exclusion) => exclusion.filterId === filterId)
    )
      continue;
    const named = value.values.map((raw) => namedApps(raw, apps));
    if (named.some((keys) => keys === null || !keys.length)) continue;
    const own = new Set<string>();
    for (const key of named.flat()) {
      const [, connection, resource] = RESOURCE_KEY.exec(key!)!;
      if (connection!.toLowerCase() === connectionId.toLowerCase())
        own.add(resource!);
    }
    picked = picked
      ? new Set([...picked].filter((resource) => own.has(resource)))
      : own;
  }
  return picked && [...picked];
}

/**
 * No filter disappears silently. Unmapped widgets must declare an exclusion.
 * `scope` is a paired screen's fixed scope: like a fixed value it is
 * conjoined with every choice and can never be excluded, and a scope the
 * dashboard's filters no longer support fails instead of being dropped.
 * `slide` is the widget's slide's scope (#707): conjoined too, but a widget
 * that excludes a filter ignores the slide's value for it as well.
 */
export function dashboardModelQuery(
  filters: readonly DashboardDataFilter[],
  values: Readonly<Record<string, DashboardFilterValue>>,
  binding: MeasureWidgetBinding,
  limit = 1000,
  window: ModelQuery["window"] = "first",
  scope: DeviceFilterScope = {},
  /** The widget's slide's scope (#707). */
  slide: SlideFilterScope = {},
  /** A table's top N (#768): its groups by one of its measures. */
  order?: ModelQueryOrder,
): Omit<ModelQuery, "now"> {
  const ids = new Set(filters.map((filter) => filter.id));
  if (ids.size !== filters.length) dataFail("dashboard_filter_ids_not_unique");
  if (Object.keys(values).some((id) => !ids.has(id)))
    dataFail("dashboard_filter_unknown");
  validateDeviceFilterScope(filters, scope);
  validateSlideFilterScope(filters, slide);
  const exclusions = new Set<string>();
  for (const exclusion of binding.exclusions) {
    if (
      !ids.has(exclusion.filterId) ||
      exclusions.has(exclusion.filterId) ||
      !exclusion.reason.trim()
    )
      dataFail("dashboard_filter_exclusion_invalid", exclusion.filterId);
    exclusions.add(exclusion.filterId);
  }
  const parts: DataExpression[] = binding.filter ? [binding.filter] : [];
  for (const filter of filters) {
    const mappings = filter.mappings.filter(
      (mapping) => mapping.modelId === binding.modelId,
    );
    if (mappings.length > 1)
      dataFail("dashboard_filter_mapping_ambiguous", filter.id);
    const screen = Object.hasOwn(scope, filter.id)
      ? scope[filter.id]
      : undefined;
    if (exclusions.has(filter.id)) {
      if (filter.fixedValue !== undefined && filter.fixedValue !== null)
        dataFail("dashboard_filter_fixed_scope_required", filter.id);
      if (screen) dataFail("device_scope_not_applicable", filter.id);
      continue;
    }
    const mapping = mappings[0];
    if (!mapping) dataFail("dashboard_filter_not_applicable", filter.id);
    // Validate defaults too, so switching back to reset can never reveal a broken filter.
    predicate(filter, mapping.dimensionId, filter.defaultValue);
    const chosen = Object.hasOwn(values, filter.id)
      ? values[filter.id]!
      : filter.defaultValue;
    const selected = predicate(filter, mapping.dimensionId, chosen);
    if (selected) parts.push(selected);
    if (filter.fixedValue !== undefined) {
      const fixed = predicate(filter, mapping.dimensionId, filter.fixedValue);
      if (fixed) parts.push(fixed);
    }
    if (screen) parts.push(predicate(filter, mapping.dimensionId, screen)!);
    // The slide's scope is a fixed value of the slide; an exclusion skips
    // it above, like the filter's choices.
    const scoped = Object.hasOwn(slide, filter.id)
      ? slide[filter.id]
      : undefined;
    if (scoped) parts.push(predicate(filter, mapping.dimensionId, scoped)!);
  }
  const filter = combine("and", parts);
  return {
    measureIds: binding.measureIds,
    groupBy: binding.groupBy,
    ...(binding.groupByGrain && Object.keys(binding.groupByGrain).length
      ? { groupByGrain: binding.groupByGrain }
      : {}),
    limit,
    ...(window === "last" ? { window } : {}),
    ...(order ? { orderBy: order } : {}),
    ...(filter ? { filter } : {}),
  };
}

/**
 * A latest-items widget's binding (#810): a published model's dimensions
 * for each item's image (a string field with role "image"), title,
 * optional subtitle and time (a date or timestamp, newest first).
 */
export interface ItemsWidgetBinding {
  modelId: string;
  imageDimensionId: string;
  titleDimensionId: string;
  subtitleDimensionId?: string;
  timeDimensionId: string;
  filter?: DataExpression;
  exclusions: DashboardFilterExclusion[];
}

/** Internal measure id the items query adds to the model: a row count over
 * the image dimension's dataset. */
export const ITEMS_COUNT_MEASURE_ID = "__items_count";

/**
 * A copy of the model with the items widget's internal count measure: rows
 * of the image dimension's dataset (#810).
 */
export function itemsModelWithCount(
  model: SemanticModelDefinition,
  binding: Pick<ItemsWidgetBinding, "imageDimensionId">,
): SemanticModelDefinition {
  const image = model.dimensions.find(
    (dimension) => dimension.id === binding.imageDimensionId,
  );
  if (!image) dataFail("items_dimension_unknown", binding.imageDimensionId);
  if (model.measures.some((measure) => measure.id === ITEMS_COUNT_MEASURE_ID))
    dataFail("model_ids_not_unique");
  return {
    ...model,
    measures: [
      ...model.measures,
      {
        id: ITEMS_COUNT_MEASURE_ID,
        name: "items",
        kind: "aggregate",
        datasetId: image.datasetId,
        aggregate: { id: ITEMS_COUNT_MEASURE_ID, name: "items", op: "count" },
      },
    ],
  };
}

/** The dimensions an items widget groups by, in query order. */
export function itemsGroupBy(binding: ItemsWidgetBinding): string[] {
  return [
    binding.timeDimensionId,
    binding.imageDimensionId,
    binding.titleDimensionId,
    ...(binding.subtitleDimensionId ? [binding.subtitleDimensionId] : []),
  ];
}

/**
 * The newest items of a model (#810): a copy of the model with an internal
 * count measure, and the query grouped by time, image, title and subtitle,
 * the last `count` groups of the time order. Items without a time are left
 * out (they would sort last, so newest). Filters, exclusions, the screen's
 * and the slide's scopes apply as in `dashboardModelQuery`. Rows come back
 * oldest first; the caller reverses them so the newest item leads.
 */
export function itemsModelQuery(
  model: SemanticModelDefinition,
  filters: readonly DashboardDataFilter[],
  values: Readonly<Record<string, DashboardFilterValue>>,
  binding: ItemsWidgetBinding,
  count: number,
  scope?: DeviceFilterScope,
  slide?: SlideFilterScope,
): { model: SemanticModelDefinition; query: Omit<ModelQuery, "now"> } {
  const withCount = itemsModelWithCount(model, binding);
  const timed: DataExpression = {
    kind: "call",
    fn: "not",
    args: [
      {
        kind: "call",
        fn: "is_null",
        args: [field(binding.timeDimensionId)],
      },
    ],
  };
  const query = dashboardModelQuery(
    filters,
    values,
    {
      modelId: binding.modelId,
      measureIds: [ITEMS_COUNT_MEASURE_ID],
      groupBy: itemsGroupBy(binding),
      filter: binding.filter
        ? { kind: "call", fn: "and", args: [binding.filter, timed] }
        : timed,
      exclusions: binding.exclusions,
    },
    count,
    "last",
    scope,
    slide,
  );
  return { model: withCount, query };
}

/**
 * A state widget's binding (#875, ADR 0019 section 15): a published
 * model's dimensions for each item's name and state (a string, or a
 * boolean health flag), and optionally the time the state last changed (a
 * date or timestamp) and a "rolled back" flag (a boolean, a qualifier on
 * up).
 */
export interface StateWidgetBinding {
  modelId: string;
  nameDimensionId: string;
  stateDimensionId: string;
  changedAtDimensionId?: string;
  rolledBackDimensionId?: string;
  filter?: DataExpression;
  exclusions: DashboardFilterExclusion[];
}

/** The internal measure a state query names: the rows of a group, on the
 * state's dataset (the query needs one measure; it is read for the page
 * only). */
export const STATE_ROWS_MEASURE_ID = "__state_rows";
/** The most items a state widget's list query returns, most urgent first. */
export const STATE_QUERY_MAX = 500;
/** The most distinct state values the Studio's discovery reads. */
export const STATE_DISCOVERY_MAX = 100;

/**
 * The model a state query runs against (#875, #900): the published
 * dimensions and datasets, the model's own measures left out (a state
 * query reads none, and they would count toward the model's 100), and one
 * internal count on the state's dataset.
 */
export function stateQueryModel(
  model: SemanticModelDefinition,
  binding: Pick<StateWidgetBinding, "stateDimensionId">,
): SemanticModelDefinition {
  const state = model.dimensions.find(
    (dimension) => dimension.id === binding.stateDimensionId,
  );
  if (!state) dataFail("state_dimension_unknown", binding.stateDimensionId);
  return {
    ...model,
    measures: [
      {
        id: STATE_ROWS_MEASURE_ID,
        name: "rows",
        kind: "aggregate",
        datasetId: state.datasetId,
        aggregate: { id: STATE_ROWS_MEASURE_ID, name: "rows", op: "count" },
      },
    ],
  };
}

/**
 * An item's rank from its grouped values (#900): the index in
 * `SERVICE_STATE_TIERS` of its state, read by the widget's one
 * normalization (`serviceStateClassifier`), and its rollback flag, which
 * qualifies only an up; the flag may come from any dataset the state's
 * reaches (a joined one too), since it is a grouped value.
 */
export function stateItemRank(
  binding: Pick<
    StateWidgetBinding,
    "stateDimensionId" | "rolledBackDimensionId"
  >,
  overrides: Readonly<Record<string, ServiceState>> = {},
): (values: Readonly<Record<string, unknown>>) => number {
  const classify = serviceStateClassifier(overrides);
  return (values) => {
    const state = classify(values[binding.stateDimensionId]);
    const rolledBack =
      binding.rolledBackDimensionId !== undefined &&
      values[binding.rolledBackDimensionId] === true;
    return serviceStateRank(state, state === "up" && rolledBack);
  };
}

/** The dimensions a state widget groups by, in query order: one item per
 * distinct name, state, changed-at and rollback flag. */
export function stateGroupBy(binding: StateWidgetBinding): string[] {
  return [
    binding.nameDimensionId,
    binding.stateDimensionId,
    ...(binding.changedAtDimensionId ? [binding.changedAtDimensionId] : []),
    ...(binding.rolledBackDimensionId ? [binding.rolledBackDimensionId] : []),
  ];
}

/**
 * What a state query reads (#875, #900): `items` (default) the items
 * ranked over every match, at most `limit`, with every item counted per
 * rank; `sourceValues` the distinct state values, one spelling of each
 * `serviceStateKey` the Studio can map (unknown and mappable,
 * `isMappableServiceStateValue`) ranked 0 and first, at most `limit`
 * distinct ones (#900).
 */
export interface StateQueryRead {
  kind?: "items" | "sourceValues";
  limit?: number;
}

/** A widget's overrides as a stable text, naming its ranking. */
const overridesKey = (overrides: Readonly<Record<string, ServiceState>>) =>
  JSON.stringify(
    Object.entries(overrides).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

/**
 * A state widget's query (#875, #900): the state model
 * (`stateQueryModel`) and the query `read` asks for. Every group is ranked
 * by its own values (`stateItemRank`, the semantic layer's internal
 * `rank`), ties by the name as shown, case-insensitively, before any
 * limit, and counted per rank, so the items, their total and the counts
 * share one grain. `item` (the single form's chosen name) keeps that item
 * only. Filters, exclusions, the screen's and the slide's scopes apply as
 * in `dashboardModelQuery`.
 */
export function stateModelQuery(
  model: SemanticModelDefinition,
  filters: readonly DashboardDataFilter[],
  values: Readonly<Record<string, DashboardFilterValue>>,
  binding: StateWidgetBinding,
  item: string | null = null,
  scope?: DeviceFilterScope,
  slide?: SlideFilterScope,
  read: StateQueryRead = {},
  overrides: Readonly<Record<string, ServiceState>> = {},
): { model: SemanticModelDefinition; query: Omit<ModelQuery, "now"> } {
  const internal = stateQueryModel(model, binding);
  const parts: DataExpression[] = [];
  if (binding.filter) parts.push(binding.filter);
  if (item !== null)
    parts.push({
      kind: "call",
      fn: "eq",
      args: [field(binding.nameDimensionId), literal("string", item)],
    });
  const discovery = read.kind === "sourceValues";
  const classify = serviceStateClassifier(overrides);
  const query = dashboardModelQuery(
    filters,
    values,
    {
      modelId: binding.modelId,
      measureIds: [STATE_ROWS_MEASURE_ID],
      groupBy: discovery ? [binding.stateDimensionId] : stateGroupBy(binding),
      ...(parts.length ? { filter: combine("and", parts)! } : {}),
      exclusions: binding.exclusions,
    },
    read.limit ?? (discovery ? STATE_DISCOVERY_MAX : STATE_QUERY_MAX),
    "first",
    scope,
    slide,
  );
  return {
    model: internal,
    query: {
      ...query,
      rank: discovery
        ? {
            key: `state-values:${overridesKey(overrides)}`,
            // One spelling per key (#900): the first of each in the
            // groups' order ranks 0, its other spellings after it, so the
            // limit counts distinct values.
            ranker: () => {
              const seen = new Set<string>();
              return (group) => {
                const value = group[binding.stateDimensionId];
                if (
                  !isMappableServiceStateValue(value) ||
                  classify(value) !== "unknown"
                )
                  return 2;
                const key = serviceStateKey(String(value));
                if (seen.has(key)) return 1;
                seen.add(key);
                return 0;
              };
            },
            tieBreak: binding.stateDimensionId,
          }
        : {
            key: `state-items:${overridesKey(overrides)}`,
            ranker: () => stateItemRank(binding, overrides),
            tieBreak: binding.nameDimensionId,
          },
    },
  };
}

/** A measure widget's options as far as they reach its binding (#768). */
export interface MeasureTableOptions {
  view: DashboardMeasureView;
  order?: ModelQueryOrder;
  labels?: Record<string, string>;
}

/**
 * The order a measure widget's query applies (#768): a table's, by one of
 * the measures it shows. An order on another view (a chart keeps its
 * dimension order, a time series its latest points) or by a measure the
 * binding no longer has is ignored, never refused.
 */
export function measureQueryOrder(
  binding: Pick<MeasureWidgetBinding, "measureIds">,
  options: MeasureTableOptions,
): ModelQueryOrder | undefined {
  const order = options.order;
  return order &&
    options.view === "table" &&
    binding.measureIds.includes(order.measureId)
    ? order
    : undefined;
}

/**
 * A measure widget's options after its binding or view changed (#768): the
 * order only while it is a table of that measure, the column labels only
 * for the dimensions and measures it still shows.
 */
export function measureOptionsForBinding<O extends MeasureTableOptions>(
  binding: Pick<MeasureWidgetBinding, "measureIds" | "groupBy">,
  options: O,
): O {
  const { order: _order, labels, ...rest } = options;
  const order = measureQueryOrder(binding, options);
  const shown = new Set([...binding.groupBy, ...binding.measureIds]);
  const kept = labels
    ? Object.fromEntries(Object.entries(labels).filter(([id]) => shown.has(id)))
    : {};
  return {
    ...rest,
    ...(order ? { order } : {}),
    ...(Object.keys(kept).length ? { labels: kept } : {}),
  } as O;
}

/**
 * Whether a grain changes a dimension's values (#838): a date is its own
 * day, so "day" on a date is no grain at all.
 */
export function timeGrainBuckets(type: DataType, grain: TimeGrain): boolean {
  return !(type === "date" && grain === "day");
}

/**
 * The dimensions the chosen measures are read per value of, from the
 * published catalog (`fixedGrainDimensions`, the model's
 * modelMeasureFixedGrainDimensions): a grain may not bucket them.
 */
export function measureFixedGrainDimensions(
  measures: readonly { id: string; fixedGrainDimensions?: string[] }[],
  measureIds: readonly string[],
): Set<string> {
  return new Set(
    measures
      .filter((measure) => measureIds.includes(measure.id))
      .flatMap((measure) => measure.fixedGrainDimensions ?? []),
  );
}

/**
 * The grains a grouped dimension can take with these measures (#838), for
 * Studio's choices and the server's validation alike: none unless it is a
 * date or timestamp; none that would bucket a dimension the measures are
 * read per value of (a date keeps "day", which is the date itself).
 */
export function allowedTimeGrains(
  dimension: { id: string; type: DataType },
  fixed: ReadonlySet<string>,
): TimeGrain[] {
  const { type } = dimension;
  if (type !== "date" && type !== "timestamp") return [];
  return TIME_GRAINS.filter(
    (grain) => !fixed.has(dimension.id) || !timeGrainBuckets(type, grain),
  );
}

/**
 * A binding with its time grains in their one stored form (#838). A grain
 * goes with its dimension, so one that is no longer grouped by (unticked,
 * or dropped by a view that shows fewer dimensions) is removed with it.
 * With the model's `dimensions`: "day" on a date, which changes nothing, is
 * no grain. With `reset`, the dimensions the chosen measures are read per
 * value of: a grain they no longer allow is removed (Studio, when such a
 * measure is added); without it, such a grain stays for validation to
 * refuse.
 */
export function measureBindingGrains<
  B extends Pick<MeasureWidgetBinding, "groupBy" | "groupByGrain">,
>(
  binding: B,
  model?: {
    dimensions: readonly { id: string; type: DataType }[];
    reset?: ReadonlySet<string>;
  },
): B {
  const { groupByGrain, ...rest } = binding;
  const kept = Object.entries(groupByGrain ?? {}).filter(([id, grain]) => {
    if (!binding.groupBy.includes(id)) return false;
    const dimension = model?.dimensions.find((entry) => entry.id === id);
    if (!dimension) return true;
    if (!timeGrainBuckets(dimension.type, grain)) return false;
    return (
      !model?.reset || allowedTimeGrains(dimension, model.reset).includes(grain)
    );
  });
  return (
    kept.length ? { ...rest, groupByGrain: Object.fromEntries(kept) } : rest
  ) as B;
}

/**
 * The first grain of a binding its measures do not allow (#838), if any: a
 * dimension that is no date or timestamp is left to the query's own check.
 */
export function unsupportedMeasureGrain(
  binding: Pick<MeasureWidgetBinding, "groupByGrain">,
  dimensions: readonly { id: string; type: DataType }[],
  fixed: ReadonlySet<string>,
): string | undefined {
  return Object.entries(binding.groupByGrain ?? {}).find(([id, grain]) => {
    const dimension = dimensions.find((entry) => entry.id === id);
    return (
      dimension !== undefined &&
      (dimension.type === "date" || dimension.type === "timestamp") &&
      !allowedTimeGrains(dimension, fixed).includes(grain)
    );
  })?.[0];
}

/**
 * A model's dimensions as a widget's result carries them (#838): one
 * grouped by a time grain holds dates (the first day of each bucket),
 * whatever the dimension's own type, so every client words, sorts and
 * charts it as the date it is.
 */
export function measureResultDimensions<
  D extends { id: string; type: DataType },
>(
  dimensions: readonly D[],
  binding: Pick<MeasureWidgetBinding, "groupByGrain">,
): D[] {
  const grains = binding.groupByGrain ?? {};
  return dimensions.map((dimension) =>
    Object.hasOwn(grains, dimension.id) && dimension.type === "timestamp"
      ? { ...dimension, type: "date" as const }
      : dimension,
  );
}

/** Time-ordered charts show the most recent `limit` points (still ascending);
 * tables and categorical charts show the first page of the ordered groups. */
export function measureViewWindow(
  view: DashboardMeasureView,
  groupByType: DataType | undefined,
): NonNullable<ModelQuery["window"]> {
  return (view === "line" || view === "bar") &&
    (groupByType === "date" || groupByType === "timestamp")
    ? "last"
    : "first";
}

export function validateMeasureView(
  view: DashboardMeasureView,
  binding: MeasureWidgetBinding,
): void {
  if (
    !binding.measureIds.length ||
    !new Set(binding.measureIds).size ||
    new Set(binding.measureIds).size !== binding.measureIds.length ||
    new Set(binding.groupBy).size !== binding.groupBy.length
  )
    dataFail("dashboard_measure_binding_invalid");
  for (const [id, grain] of Object.entries(binding.groupByGrain ?? {}))
    if (!binding.groupBy.includes(id) || !isTimeGrain(grain))
      dataFail("dashboard_measure_grain_invalid", id);
  // A value is one measure; grouped, it is a total with its split (#784).
  if (view === "value" && binding.measureIds.length !== 1)
    dataFail("dashboard_measure_value_grain_invalid");
  if (
    (view === "bar" || view === "line") &&
    (binding.measureIds.length !== 1 || binding.groupBy.length !== 1)
  )
    dataFail("dashboard_measure_chart_grain_invalid");
}

/**
 * The grouping dimension a declared interaction reads its value from: the
 * dimension the filter maps to for this widget's model. Every unsupported
 * combination fails with its own code instead of a click doing nothing.
 */
export function measureInteractionDimension(
  filters: readonly DashboardDataFilter[],
  binding: MeasureWidgetBinding,
  view: DashboardMeasureView,
): string {
  const filterId = binding.interaction?.filterId;
  if (filterId === undefined) dataFail("dashboard_interaction_missing");
  if (view === "value")
    dataFail("dashboard_interaction_view_unsupported", filterId);
  const filter = filters.find((filter) => filter.id === filterId);
  if (!filter) dataFail("dashboard_interaction_filter_unknown", filterId);
  if (binding.exclusions.some((exclusion) => exclusion.filterId === filterId))
    dataFail("dashboard_interaction_filter_excluded", filterId);
  const mappings = filter.mappings.filter(
    (mapping) => mapping.modelId === binding.modelId,
  );
  if (
    mappings.length !== 1 ||
    !binding.groupBy.includes(mappings[0]!.dimensionId)
  )
    dataFail("dashboard_interaction_dimension_not_grouped", filterId);
  // A click would set the filter to a bucket's first day, not to a value of
  // the dimension (#838).
  if (Object.hasOwn(binding.groupByGrain ?? {}, mappings[0]!.dimensionId))
    dataFail("dashboard_interaction_grain_unsupported", filterId);
  return mappings[0]!.dimensionId;
}

/** The filter choice a click on `value` makes, or null when the value cannot
 * be chosen (a missing value has no range). */
export function measureInteractionValue(
  filter: DashboardDataFilter,
  value: unknown,
): Exclude<DashboardFilterValue, null> | null {
  if (value === undefined) return null;
  if (filter.mode === "values") return { kind: "values", values: [value] };
  return value === null ? null : { kind: "range", from: value, to: value };
}

/** Whether the current choice is what clicking `value` sets, compared by the
 * filter's type as filters are evaluated ("1.0" = "1.00", equal instants at
 * different fractional precision). Missing values only match missing ones. */
export function measureInteractionSelected(
  filter: DashboardDataFilter,
  current: DashboardFilterValue,
  value: unknown,
): boolean {
  if (value === undefined || current === null || current.kind !== filter.mode)
    return false;
  const same = (chosen: unknown) => {
    if (chosen === null || value === null) return chosen === value;
    try {
      return compareDataValues(filter.type, chosen, value) === 0;
    } catch {
      return false;
    }
  };
  return current.kind === "values"
    ? current.values.length === 1 && same(current.values[0])
    : value !== null &&
        current.from !== null &&
        current.to !== null &&
        same(current.from) &&
        same(current.to);
}

/** Exact presentation amount, without ever converting a decimal to a float. */
export function displayMeasureAmount(
  value: unknown,
  unit: string | undefined,
  currency: string | undefined,
): unknown {
  if (
    value === null ||
    value === undefined ||
    unit !== "currency_minor" ||
    !currency
  )
    return value;
  const exponent = currencyExponent(currency);
  return exactDecimal("divide", String(value), String(10 ** exponent));
}

/**
 * Fraction digits a value of a measure unit is shown with (#619): an average
 * rating reads as 4.29 rather than every digit of 4.2857…; the stored and
 * exported value stays exact. Units not listed show every digit.
 */
export const MEASURE_UNIT_FRACTION_DIGITS: Readonly<Record<string, number>> = {
  stars: 2,
};

/**
 * The most fraction digits a measure's single value (the value view, its
 * total and split lines) shows when its unit sets none and it is no amount
 * of money (#835): an average of 9.448387… reads as 9.45. Tables and charts
 * keep every digit (#619); the stored and exported value stays exact.
 */
export const MEASURE_VALUE_FRACTION_DIGITS = 2;

/**
 * Units that are codes, never words after a value (#835): a plain count,
 * amounts of money (their currency is shown), shares and ranks.
 */
export function isMeasureUnitCode(unit: string): boolean {
  return (
    unit === "count" ||
    unit === "currency" ||
    unit === "ratio" ||
    unit === "position" ||
    unit.endsWith("_minor")
  );
}

/**
 * Connector units in German; other units (and every unit in English) read
 * as they are named. tvOS: `DataFormat.unitWords`.
 */
export const MEASURE_UNIT_WORDS_DE: Readonly<Record<string, string>> = {
  clicks: "Klicks",
  downloads: "Downloads",
  events: "Ereignisse",
  impressions: "Impressionen",
  installs: "Installationen",
  pageviews: "Seitenaufrufe",
  purchases: "Käufe",
  reviews: "Bewertungen",
  signups: "Registrierungen",
  taps: "Taps",
  updates: "Updates",
  views: "Aufrufe",
  visitors: "Besucher",
};

/**
 * What follows a measure's value for its unit (#619, #835): "%" for
 * percent, " ★" for stars, nothing for a code or no unit, else a space and
 * the unit's word in `locale` ("1,284 downloads", "1.284 Downloads",
 * "9.45 °C").
 */
export function measureUnitSuffix(
  unit: string | undefined,
  locale: string,
): string {
  if (!unit || isMeasureUnitCode(unit)) return "";
  if (unit === "percent") return "%";
  if (unit === "stars") return " ★";
  return ` ${measureUnitWords(unit, locale)}`;
}

/** A currency code as long as most, standing in for an amount's currency. */
const SAMPLE_CURRENCY = "EUR";

/**
 * What follows a measure's sample values in the readability check (#835):
 * what screens show after them. An amount of money ("currency",
 * "currency_minor", "EUR_minor", a formula over amounts) shows its
 * currency code, never the unit's words; any other unit its suffix.
 */
export function measureSampleSuffix(
  unit: string | undefined,
  locale: string,
): string {
  if (unit === "currency" || unit?.endsWith("_minor"))
    return ` ${SAMPLE_CURRENCY}`;
  return measureUnitSuffix(unit, locale);
}

/**
 * A unit's words in `locale` (#835): a combined unit from a formula
 * ("installs/impressions", "clicks × views", "taps*days") is translated
 * part by part, its separators kept; a part without a word stays as it is.
 */
export function measureUnitWords(unit: string, locale: string): string {
  if (!locale.toLowerCase().startsWith("de")) return unit;
  return unit
    .split(/(\s*[/×*]\s*)/)
    .map((part, index) =>
      index % 2 === 1 ? part : (MEASURE_UNIT_WORDS_DE[part] ?? part),
    )
    .join("");
}

/**
 * A decimal string rounded to at most `digits` fraction digits, half away
 * from zero, trailing zeros dropped; computed on the digits, never through a
 * float. Text that is no plain decimal is returned unchanged.
 */
export function roundDecimalText(raw: string, digits: number): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) return raw;
  const [, sign = "", whole = "0", given = ""] = match;
  const fraction = given.padEnd(digits + 1, "0");
  const scaled =
    BigInt(whole + fraction.slice(0, digits)) +
    (fraction.charCodeAt(digits) >= 53 /* "5" */ ? 1n : 0n);
  const text = scaled.toString().padStart(digits + 1, "0");
  const integer = text.slice(0, text.length - digits);
  const rest = text.slice(text.length - digits).replace(/0+$/, "");
  const result = `${integer}${rest ? `.${rest}` : ""}`;
  return sign && /[1-9]/.test(result) ? `-${result}` : result;
}

/**
 * A date or timestamp value as people read it (#619): a calendar day
 * ("YYYY-MM-DD") in the locale's medium date style, the same day in every
 * time zone; a timestamp adds the time of day in `timeZone` (the viewer's
 * when omitted). Null when the value is no valid date of that type.
 */
export function formatDataDate(
  value: unknown,
  type: string,
  locale: string,
  timeZone?: string,
): string | null {
  if (typeof value !== "string") return null;
  if (type === "date") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    // setUTCFullYear keeps a year before 100 the year it is (Date.UTC
    // reads 1 as 1901). The year 0 would read as the year 1: as stored.
    const date = new Date(0);
    date.setUTCFullYear(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
    );
    if (date.toISOString().slice(0, 10) !== value || match[1] === "0000")
      return null;
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeZone: "UTC",
    }).format(date);
  }
  if (type === "timestamp") {
    const time = Date.parse(value);
    if (!Number.isFinite(time) || !/^\d{4}-\d{2}-\d{2}T/.test(value))
      return null;
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timeZone ? { timeZone } : {}),
    }).format(new Date(time));
  }
  return null;
}

/** A measure cell as model queries return it (modelMeasureCellSchema). */
export interface MeasureSplitCell {
  value: unknown;
  type: DataType;
  unit?: string;
  currency?: string;
  status: "ok" | "missing" | "partial";
}

/**
 * The total of a value view with a grouping (a total with its split,
 * #784): the measure summed over every group, one cell per currency and
 * unit, in the order they first appear. Only an aggregate that adds up
 * (sum or count) over a complete result has one; otherwise undefined, and
 * screens show the groups alone. Groups without a value add nothing; a
 * partial group makes its total partial. Exact: decimals add as text.
 */
export function measureSplitTotals(
  measure:
    | {
        kind: string;
        aggregate?: { op: string };
      }
    | undefined,
  measureId: string,
  result: {
    rows: readonly { measures: Readonly<Record<string, MeasureSplitCell>> }[];
    totalRows?: number | undefined;
  },
): MeasureSplitCell[] | undefined {
  if (
    !measure ||
    measure.kind !== "aggregate" ||
    !["sum", "count"].includes(measure.aggregate?.op ?? "")
  )
    return undefined;
  if ((result.totalRows ?? result.rows.length) > result.rows.length)
    return undefined;
  const totals = new Map<string, MeasureSplitCell>();
  for (const row of result.rows) {
    const cell = row.measures[measureId];
    if (!cell || cell.value === null || cell.value === undefined) continue;
    // Plain decimal text only (no exponents), as exactDecimal reads it.
    if (
      (typeof cell.value !== "number" && typeof cell.value !== "string") ||
      !/^-?\d+(?:\.\d+)?$/.test(String(cell.value))
    )
      return undefined;
    const key = `${cell.currency ?? ""}\u0000${cell.unit ?? ""}`;
    const current = totals.get(key);
    if (!current) {
      totals.set(key, {
        value: cell.value,
        type: cell.type,
        ...(cell.unit !== undefined ? { unit: cell.unit } : {}),
        ...(cell.currency !== undefined ? { currency: cell.currency } : {}),
        status: cell.status === "partial" ? "partial" : "ok",
      });
      continue;
    }
    // A sum past the processing limits leaves the widget without a total,
    // never fails it.
    let sum: string | null;
    try {
      sum = exactDecimal("add", String(current.value), String(cell.value));
    } catch {
      return undefined;
    }
    if (sum === null) return undefined;
    // Numbers stay numbers (integers within the safe range), text stays text.
    const numbers =
      typeof current.value === "number" && typeof cell.value === "number";
    const value = numbers ? Number(sum) : sum;
    if (numbers && !Number.isSafeInteger(Math.trunc(value as number)))
      return undefined;
    totals.set(key, {
      ...current,
      value,
      status:
        current.status === "partial" || cell.status === "partial"
          ? "partial"
          : "ok",
    });
  }
  return totals.size ? [...totals.values()] : undefined;
}

/**
 * A measure widget's own period (#784) as a filter on the model's
 * reporting-date dimension: `from <= day <= to`, joined to the binding's
 * own filter. The model needs such a dimension; otherwise the widget
 * fails with `dashboard_measure_period_unsupported`.
 */
export function measurePeriodBinding<B extends MeasureWidgetBinding>(
  binding: B,
  dimensions: readonly { id: string; timeAlignment?: string }[],
  range: { from: string; to: string } | null,
): B {
  if (!range) return binding;
  const day = dimensions.find(
    (dimension) => dimension.timeAlignment === "reporting_date",
  );
  if (!day) dataFail("dashboard_measure_period_unsupported");
  // The same date range a compare widget reads its windows with.
  const period = compareMeasureFilter(day.id, range);
  return {
    ...binding,
    filter: binding.filter
      ? { kind: "call", fn: "and", args: [binding.filter, period] }
      : period,
  };
}
