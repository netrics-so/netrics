import {
  barWidgetOptionsSchema,
  clockWidgetOptionsSchema,
  compareWidgetOptionsSchema,
  countdownWidgetOptionsSchema,
  createDashboardRequestSchema,
  dashboardDataFilterSchema,
  gaugeWidgetOptionsSchema,
  imageWidgetOptionsSchema,
  lineWidgetOptionsSchema,
  measureWidgetBindingSchema,
  measureWidgetOptionsSchema,
  metricWidgetOptionsSchema,
  reviewWidgetOptionsSchema,
  statusWidgetOptionsSchema,
  tableWidgetOptionsSchema,
  textWidgetOptionsSchema,
  type CreateDashboardRequest,
} from "@netrics/contracts";
import {
  DEFAULT_DASHBOARD_SETTINGS,
  DEFAULT_THEME_KEY,
  type PreparationGraph,
  type SemanticModelDefinition,
} from "@netrics/domain";
import type { z } from "zod";
import type { Dashboard } from "@netrics/database";
import type { StoreTemplateKey } from "./store-template.js";

/**
 * Store-template records as comparable items (template updates, 11E): each
 * preparation step, model measure, dimension and relationship, and each
 * dashboard setting, shared filter, slide and widget is one item under a
 * symbolic reference. Record and dataset ids are replaced by template keys,
 * so the same content of two installs (or of one install's original,
 * current and next state) compares equal. Record names are never items:
 * they are the customer's.
 */
export type ItemKind =
  | "step"
  | "output"
  | "measure"
  | "dimension"
  | "relationship"
  | "widget"
  | "filter"
  | "slide"
  | "settings";
export type ItemRef = `${StoreTemplateKey}#${ItemKind}:${string}`;
/** Values are canonical JSON: keys sorted, no undefined. */
export type Items = Map<ItemRef, unknown>;

export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .flatMap((key) => {
          const entry = (value as Record<string, unknown>)[key];
          return entry === undefined ? [] : [[key, canonical(entry)]];
        }),
    );
  return value;
}

/** The record key of an item reference. */
export const recordKeyOf = (ref: string) => ref.slice(0, ref.indexOf("#"));
/** `step`, `widget`, ... of an item reference. */
export const itemKindOf = (ref: string) => {
  const item = ref.slice(ref.indexOf("#") + 1);
  return item.slice(0, item.indexOf(":")) as ItemKind;
};

/**
 * `prepared:<id>:<out>`, dataset ids and model ids become
 * `ref:<key>[:<out>]` using the install's id → key map. Output names have
 * no colon, so an id is everything between `prepared:` and the last colon
 * (placeholder ids `new:<key>` included).
 */
export function symbolize(
  value: unknown,
  idsToKeys: Map<string, string>,
): unknown {
  if (typeof value === "string") {
    const key = idsToKeys.get(value);
    if (key !== undefined) return `ref:${key}`;
    if (value.startsWith("prepared:")) {
      const rest = value.slice("prepared:".length),
        cut = rest.lastIndexOf(":");
      const prepared = cut > 0 ? idsToKeys.get(rest.slice(0, cut)) : undefined;
      if (prepared !== undefined)
        return `ref:${prepared}:${rest.slice(cut + 1)}`;
    }
    return value;
  }
  if (Array.isArray(value))
    return value.map((entry) => symbolize(entry, idsToKeys));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        symbolize(entry, idsToKeys),
      ]),
    );
  return value;
}

const ref = (key: StoreTemplateKey, kind: ItemKind, id: string): ItemRef =>
  `${key}#${kind}:${id}`;

export function preparationItems(
  key: StoreTemplateKey,
  graph: PreparationGraph,
  idsToKeys: Map<string, string>,
): Items {
  const items: Items = new Map();
  for (const node of graph.nodes) {
    const { id, ...rest } = node;
    items.set(ref(key, "step", id), canonical(symbolize(rest, idsToKeys)));
  }
  graph.outputs.forEach((output, index) =>
    items.set(ref(key, "output", String(index)), output),
  );
  return items;
}

/**
 * Replaces each of the model's datasets by `datasets[<index>]`. Items store
 * positions, not datasets: an item "unchanged in all three states" has the
 * same position text, even when the dataset at that position differs (which
 * the update resolves per state, see modelFromItems). That is exact for the
 * store models, which read one dataset; revisit for templates whose models
 * read several. customerReplacement and the identity rule in slotOf rest on
 * the same single-dataset assumption: with one dataset a list position is
 * unambiguous, with several a swap and a remove-and-append look alike.
 */
function datasetSlots(value: unknown, datasets: unknown[]): unknown {
  if (typeof value === "string") {
    const index = datasets.indexOf(value);
    return index === -1 ? value : `datasets[${index}]`;
  }
  if (Array.isArray(value))
    return value.map((entry) => datasetSlots(entry, datasets));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [
        name,
        datasetSlots(entry, datasets),
      ]),
    );
  return value;
}

/**
 * Measures, dimensions and relationships, whose dataset references point at
 * the model's `datasets` by position: which preparation that is depends on
 * the app scope (one source or an append tree), so it is the single scope
 * item `settings:datasets`.
 */
export function modelItems(
  key: StoreTemplateKey,
  def: SemanticModelDefinition,
  idsToKeys: Map<string, string>,
): Items {
  const items: Items = new Map();
  const datasets = symbolize(def.datasets, idsToKeys) as unknown[];
  const slot = (value: unknown) =>
    canonical(datasetSlots(symbolize(value, idsToKeys), datasets));
  for (const measure of def.measures)
    items.set(ref(key, "measure", measure.id), slot(measure));
  for (const dimension of def.dimensions)
    items.set(ref(key, "dimension", dimension.id), slot(dimension));
  def.relationships.forEach((relationship, index) =>
    items.set(ref(key, "relationship", String(index)), slot(relationship)),
  );
  items.set(ref(key, "settings", "datasets"), canonical(datasets));
  return items;
}

/** A value an update cannot turn back into a real reference. */
export class UnresolvableReference extends Error {
  constructor(readonly value: string) {
    super("store_update_unmergeable");
  }
}
/** A record whose merged items cannot be rebuilt; `refs` are the items. */
export class UnmergeableRecord extends Error {
  constructor(
    readonly key: StoreTemplateKey,
    readonly refs: string[],
  ) {
    super("store_update_unmergeable");
  }
}

/**
 * The inverse of symbolize: `ref:<key>` becomes the key's record id and
 * `ref:<key>:<out>` `prepared:<id>:<out>`, with `ids` holding a real id for
 * every key (new records created before their dependants). A whole key
 * wins over key plus output, like an exact id wins in symbolize. Throws
 * UnresolvableReference for a `ref:` no key resolves: writing it would
 * store a reference to nothing.
 */
export function desymbolize(
  value: unknown,
  ids: Readonly<Record<string, string>>,
): unknown {
  if (typeof value === "string") {
    if (!value.startsWith("ref:")) return value;
    const rest = value.slice("ref:".length);
    if (Object.hasOwn(ids, rest)) return ids[rest]!;
    const cut = rest.lastIndexOf(":"),
      key = rest.slice(0, cut);
    if (cut > 0 && Object.hasOwn(ids, key))
      return `prepared:${ids[key]!}:${rest.slice(cut + 1)}`;
    throw new UnresolvableReference(value);
  }
  if (Array.isArray(value))
    return value.map((entry) => desymbolize(entry, ids));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [
        name,
        desymbolize(entry, ids),
      ]),
    );
  return value;
}

/**
 * The ids of `present` in order: the customer's order, with each id only
 * the template has placed right after the id before it in the template's
 * order (first when none is before it).
 */
export function mergeOrder(
  current: readonly string[],
  next: readonly string[],
  present: ReadonlySet<string>,
): string[] {
  const order = current.filter((id) => present.has(id));
  let previous: string | undefined;
  for (const id of next) {
    if (!present.has(id)) continue;
    if (!order.includes(id))
      order.splice(
        previous === undefined ? 0 : order.indexOf(previous) + 1,
        0,
        id,
      );
    previous = id;
  }
  for (const id of present) if (!order.includes(id)) order.push(id);
  return order;
}

/** The ids of one item kind of a record in `items`, with their values. */
function itemsOf(items: Items, key: StoreTemplateKey, kind: ItemKind) {
  const prefix = `${key}#${kind}:`;
  return new Map(
    [...items]
      .filter(([itemRef]) => itemRef.startsWith(prefix))
      .map(([itemRef, value]) => [itemRef.slice(prefix.length), value]),
  );
}
const byIndex = (values: Map<string, unknown>) =>
  [...values].sort(([a], [b]) => Number(a) - Number(b));

/**
 * Resolves the items of one record; every item that cannot be resolved is
 * collected, then the whole record is refused (UnmergeableRecord).
 */
function resolver(key: StoreTemplateKey) {
  const failed: string[] = [];
  return {
    resolve(itemRef: string, fn: () => unknown): unknown {
      try {
        return fn();
      } catch (error) {
        if (!(error instanceof UnresolvableReference)) throw error;
        failed.push(itemRef);
        return undefined;
      }
    },
    done() {
      if (failed.length) throw new UnmergeableRecord(key, failed);
    },
  };
}

/**
 * A preparation graph from (merged) items, with real ids: steps in the
 * current graph's order, template additions after their predecessor.
 */
export function preparationFromItems(
  key: StoreTemplateKey,
  items: Items,
  order: { current: PreparationGraph | null; next: PreparationGraph | null },
  ids: Readonly<Record<string, string>>,
): PreparationGraph {
  const steps = itemsOf(items, key, "step"),
    check = resolver(key);
  const nodes = mergeOrder(
    order.current?.nodes.map((node) => node.id) ?? [],
    order.next?.nodes.map((node) => node.id) ?? [],
    new Set(steps.keys()),
  ).map((id) => ({
    id,
    ...(check.resolve(ref(key, "step", id), () =>
      desymbolize(steps.get(id), ids),
    ) as object),
  }));
  check.done();
  return {
    version: 1,
    nodes: nodes as PreparationGraph["nodes"],
    outputs: byIndex(itemsOf(items, key, "output")).map(
      ([, value]) => value,
    ) as string[],
  };
}

export type DatasetLists = {
  original: readonly unknown[];
  current: readonly unknown[];
  next: readonly unknown[];
};
const indexIn = (list: readonly unknown[], value: unknown) =>
  list.findIndex((entry) => JSON.stringify(entry) === JSON.stringify(value));

/** The metric a store preparation reference is for (`ref:preparation:…`). */
function metricOf(dataset: unknown): string | undefined {
  if (typeof dataset !== "string") return undefined;
  return (
    /^ref:preparation:source:[^:]+:([^:]+)/.exec(dataset)?.[1] ??
    /^ref:preparation:append:([^:]+):/.exec(dataset)?.[1]
  );
}

/**
 * The customer's dataset in place of a template dataset they replaced, only
 * when that reading is unambiguous: the dataset is in the original, not in
 * the customer's model; the customer's model has as many datasets as the
 * original and exactly one of its own, at the dataset's original position;
 * and that position is not the end of a longer list (there, their own
 * dataset reads just as well as removed-and-appended). Undefined otherwise:
 * the customer kept it, removed it, or it is unclear, and they choose.
 */
export function customerReplacement(
  lists: DatasetLists,
  dataset: unknown,
): unknown {
  const position = indexIn(lists.original, dataset);
  if (position === -1 || indexIn(lists.current, dataset) !== -1)
    return undefined;
  const own = lists.current.filter(
    (entry) => indexIn(lists.original, entry) === -1,
  );
  const replacement = lists.current[position];
  const last = lists.current.length - 1;
  return lists.current.length === lists.original.length &&
    own.length === 1 &&
    indexIn(own, replacement) === 0 &&
    (position < last || lists.current.length === 1)
    ? replacement
    : undefined;
}

/**
 * The first template dataset the customer removed from their model (without
 * replacing it) that a value of the new template reads, as in the new
 * template's list; undefined when it reads none. Taking that value would add
 * the dataset back, so the customer chooses (store-template-merge.ts).
 */
export function removedDatasetRead(
  lists: DatasetLists,
  value: unknown,
): unknown {
  for (const index of slotsIn(value)) {
    const dataset = lists.next[index];
    if (
      index < lists.next.length &&
      indexIn(lists.original, dataset) !== -1 &&
      indexIn(lists.current, dataset) === -1 &&
      customerReplacement(lists, dataset) === undefined
    )
      return dataset;
  }
  return undefined;
}

/**
 * A model's datasets after an update: the new template's datasets (app
 * scope), without those the customer removed or replaced (in the original,
 * not in their model) unless a value taken from the new template reads one
 * the customer removed (`readByTemplate`, which they chose); then the
 * customer's own datasets (in neither the original nor the new template) in
 * the customer's order, so what reads them keeps working. Values are
 * symbolic, as in `settings:datasets`.
 */
export function mergeDatasets(
  lists: DatasetLists,
  readByTemplate: readonly unknown[] = [],
): unknown[] {
  const merged = lists.next.filter(
    (dataset) =>
      indexIn(lists.original, dataset) === -1 ||
      indexIn(lists.current, dataset) !== -1 ||
      (indexIn(readByTemplate, dataset) !== -1 &&
        customerReplacement(lists, dataset) === undefined),
  );
  for (const dataset of lists.current)
    if (
      indexIn(lists.original, dataset) === -1 &&
      indexIn(merged, dataset) === -1
    )
      merged.push(dataset);
  return merged;
}

/**
 * The dataset an item's `datasets[<index>]` reads after the update, or
 * undefined.
 *
 * A template value's slot is in the new template's list; a template dataset
 * the customer replaced reads the customer's dataset instead.
 *
 * A customer value's slot is in the customer's list and keeps reading the
 * same dataset wherever the merged list has it; only a true replacement
 * follows the template by position: the original dataset is gone from the
 * new template, and the new template's dataset at its original position is
 * one the original did not have and is for the same metric (e.g. one source
 * becomes an append tree). Anything else would silently re-point the value,
 * so it does not resolve.
 */
function slotOf(
  index: number,
  fromNext: boolean,
  lists: DatasetLists,
  merged: readonly unknown[],
): unknown {
  const list = fromNext ? lists.next : lists.current;
  if (index >= list.length) return undefined;
  const dataset = list[index];
  if (fromNext) {
    const replacement = customerReplacement(lists, dataset);
    if (replacement !== undefined)
      return indexIn(merged, replacement) !== -1 ? replacement : undefined;
  }
  if (indexIn(merged, dataset) !== -1) return dataset;
  if (fromNext) return undefined;
  const position = indexIn(lists.original, dataset),
    replacement = lists.next[position];
  if (
    position !== -1 &&
    position < lists.next.length &&
    indexIn(lists.next, dataset) === -1 &&
    indexIn(lists.original, replacement) === -1 &&
    indexIn(merged, replacement) !== -1 &&
    metricOf(dataset) !== undefined &&
    metricOf(dataset) === metricOf(replacement)
  )
    return replacement;
  return undefined;
}

const SLOT = /^datasets\[(\d+)\]$/;
/** Replaces each `datasets[<index>]` by the dataset `slot` finds for it. */
function unslot(value: unknown, slot: (index: number) => unknown): unknown {
  if (typeof value === "string") {
    const match = SLOT.exec(value);
    return match ? slot(Number(match[1])) : value;
  }
  if (Array.isArray(value)) return value.map((entry) => unslot(entry, slot));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [name, unslot(entry, slot)]),
    );
  return value;
}
/** The slot indexes `datasets[<index>]` a value reads. */
function slotsIn(value: unknown): number[] {
  if (typeof value === "string") {
    const match = SLOT.exec(value);
    return match ? [Number(match[1])] : [];
  }
  if (Array.isArray(value)) return value.flatMap(slotsIn);
  if (value !== null && typeof value === "object")
    return Object.values(value).flatMap(slotsIn);
  return [];
}

/**
 * A model definition from (merged) items, with real ids: measures and
 * dimensions in the current definition's order, template additions after
 * their predecessor. Its datasets are mergeDatasets of the three states,
 * and each item's dataset slots are read against the state its value came
 * from (`fromNext`: the new template's). Without `sources`, the record's
 * own `settings:datasets` item is every state's list.
 */
export function modelFromItems(
  key: StoreTemplateKey,
  items: Items,
  order: {
    current: SemanticModelDefinition | null;
    next: SemanticModelDefinition | null;
  },
  ids: Readonly<Record<string, string>>,
  sources?: {
    datasets: DatasetLists;
    fromNext: (itemRef: string) => boolean;
  },
): SemanticModelDefinition {
  const datasetsRef = ref(key, "settings", "datasets");
  const own = (items.get(datasetsRef) as unknown[] | undefined) ?? [];
  const lists = sources?.datasets ?? { original: own, current: own, next: own };
  const fromNext = (itemRef: string) => sources?.fromNext(itemRef) ?? true;
  // The datasets the new template's values read (the list itself aside).
  const readByTemplate = [...items]
    .filter(([itemRef]) => itemRef !== datasetsRef && fromNext(itemRef))
    .flatMap(([, value]) => slotsIn(value))
    .map((index) => lists.next[index]);
  const merged = mergeDatasets(lists, readByTemplate),
    check = resolver(key);
  const resolve = (itemRef: string, value: unknown) =>
    check.resolve(itemRef, () =>
      desymbolize(
        unslot(value, (index) => {
          const dataset = slotOf(index, fromNext(itemRef), lists, merged);
          if (dataset === undefined)
            throw new UnresolvableReference(`datasets[${index}]`);
          return dataset;
        }),
        ids,
      ),
    );
  const ordered = (kind: "measure" | "dimension") => {
    const values = itemsOf(items, key, kind);
    const ofKind = (def: SemanticModelDefinition | null) =>
      (kind === "measure" ? def?.measures : def?.dimensions)?.map(
        (entry) => entry.id,
      ) ?? [];
    return mergeOrder(
      ofKind(order.current),
      ofKind(order.next),
      new Set(values.keys()),
    ).map((id) => resolve(ref(key, kind, id), values.get(id)));
  };
  const definition = {
    version: 1 as const,
    datasets: check.resolve(datasetsRef, () =>
      desymbolize(merged, ids),
    ) as string[],
    relationships: byIndex(itemsOf(items, key, "relationship")).map(
      ([index, value]) => resolve(ref(key, "relationship", index), value),
    ) as SemanticModelDefinition["relationships"],
    dimensions: ordered("dimension") as SemanticModelDefinition["dimensions"],
    measures: ordered("measure") as SemanticModelDefinition["measures"],
  };
  check.done();
  return definition;
}

/**
 * The item refs of a record that a validation issue path points at (e.g.
 * `nodes.3.expression` → that step), or the path itself when no item does.
 */
export function itemRefOfPath(
  key: StoreTemplateKey,
  record: PreparationGraph | SemanticModelDefinition,
  path: readonly PropertyKey[],
): string {
  // A root-level issue (e.g. the record as a whole) names the record.
  if (path.length === 0) return key;
  const [part, index] = path;
  const at = typeof index === "number" ? index : Number(index);
  if ("nodes" in record) {
    if (part === "nodes" && record.nodes[at])
      return ref(key, "step", record.nodes[at].id);
    if (part === "outputs" && Number.isInteger(at))
      return ref(key, "output", String(at));
  } else {
    if (part === "measures" && record.measures[at])
      return ref(key, "measure", record.measures[at].id);
    if (part === "dimensions" && record.dimensions[at])
      return ref(key, "dimension", record.dimensions[at].id);
    if (part === "relationships" && Number.isInteger(at))
      return ref(key, "relationship", String(at));
    if (part === "datasets") return ref(key, "settings", "datasets");
  }
  return path.map(String).join(".");
}

export interface NormalizedDashboard {
  /** Dashboard-level settings without name, project, version, timestamps. */
  settings: Record<string, unknown>;
  /** Shared filters by id; the app filter's fixed value is `app.fixedValue`. */
  filters: Record<string, unknown>;
  /** By slide key (`slide:<template index>`), or `custom:<slideId>`. */
  slides: Record<string, unknown>;
  /**
   * By widget key, or `custom:<widgetId>` for the customer's widgets; `slide`
   * is the key of the slide the widget is on.
   */
  widgets: Record<string, { slide: string; value: unknown }>;
}

const optionSchemas: Record<string, z.ZodType> = {
  measure: measureWidgetOptionsSchema,
  metric: metricWidgetOptionsSchema,
  line: lineWidgetOptionsSchema,
  bar: barWidgetOptionsSchema,
  table: tableWidgetOptionsSchema,
  compare: compareWidgetOptionsSchema,
  gauge: gaugeWidgetOptionsSchema,
  image: imageWidgetOptionsSchema,
  text: textWidgetOptionsSchema,
  clock: clockWidgetOptionsSchema,
  status: statusWidgetOptionsSchema,
  countdown: countdownWidgetOptionsSchema,
  review: reviewWidgetOptionsSchema,
};
/** Parsed with its defaults when it parses; as stored otherwise. */
function withDefaults(schema: z.ZodType | undefined, value: unknown) {
  const parsed = schema?.safeParse(value ?? {});
  return parsed?.success ? parsed.data : value;
}
const empty = (value: unknown) =>
  value === null ||
  value === undefined ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0);
/** Drops null, undefined and empty entries, so absent and empty compare equal. */
const compact = (value: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => !empty(entry)),
  );

/**
 * A widget as stored (camelCase columns, from findDashboard or a migrated
 * snapshot): its content without id, slide, dashboard, workspace or the
 * per-format layouts. Missing columns read as their defaults, so a snapshot
 * of an older shape still reads.
 */
function widgetValue(row: Record<string, unknown>): unknown {
  const type = String(row.type);
  const binding = row.modelBinding ?? null;
  return compact({
    type,
    x: row.x,
    y: row.y,
    w: row.w,
    h: row.h,
    title: row.title,
    binding:
      binding === null
        ? null
        : type === "measure"
          ? withDefaults(measureWidgetBindingSchema, binding)
          : binding,
    filterExclusions: row.filterExclusions,
    options: withDefaults(optionSchemas[type], row.options),
    connectionId: row.connectionId,
    metricKey: row.metricKey,
    aggregation: row.aggregation,
    period: row.period,
    dimensions: row.dimensions,
    displayCurrency: row.displayCurrency,
    text: row.text,
    imageId: row.imageId,
    goalId: row.goalId,
    denominatorConnectionId: row.denominatorConnectionId,
    denominatorMetricKey: row.denominatorMetricKey,
    denominatorAggregation: row.denominatorAggregation,
    denominatorDimensions: row.denominatorDimensions,
  });
}

function filtersOf(
  filters: unknown,
  idsToKeys: Map<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const raw of Array.isArray(filters) ? filters : []) {
    const parsed = dashboardDataFilterSchema.safeParse(raw);
    const filter = (parsed.success ? parsed.data : raw) as Record<
      string,
      unknown
    >;
    const id = String(filter.id);
    if (id === "app") {
      const { fixedValue, ...rest } = filter;
      result[id] = symbolize(rest, idsToKeys);
      if (!empty(fixedValue)) result["app.fixedValue"] = fixedValue;
    } else result[id] = symbolize(filter, idsToKeys);
  }
  return result;
}

const slideValue = (slide: Record<string, unknown>) =>
  compact({
    name: slide.name,
    durationSeconds: slide.durationSeconds,
    enabled: slide.enabled ?? true,
    backgroundImageId: slide.backgroundImageId,
    backgroundDim: slide.backgroundDim || null,
  });

/** Dashboard rows as stored: findDashboard's result or a migrated snapshot. */
export type DashboardRowsLike = Record<string, unknown> & {
  slides: readonly (Record<string, unknown> & {
    widgets: readonly Record<string, unknown>[];
  })[];
};

/**
 * The dashboard as stored. Template widgets and slides are keyed by
 * `widgetKeys` (widget or slide id → `widget:<name>` / `slide:<index>`); the
 * others are `custom:<id>`, so a slide the customer inserts or moves never
 * shifts the template's.
 */
export function normalizeDashboard(
  dashboard: Dashboard | DashboardRowsLike,
  widgetKeys: Record<string, string>,
  idsToKeys: Map<string, string>,
): NormalizedDashboard {
  const view = dashboard as unknown as DashboardRowsLike;
  const settings = compact({
    showHeader: view.showHeader ?? DEFAULT_DASHBOARD_SETTINGS.showHeader,
    autoAdvance: view.autoAdvance ?? DEFAULT_DASHBOARD_SETTINGS.autoAdvance,
    defaultSlideSeconds:
      view.defaultSlideSeconds ??
      DEFAULT_DASHBOARD_SETTINGS.defaultSlideSeconds,
    transition: view.transition ?? DEFAULT_DASHBOARD_SETTINGS.transition,
    themeBuiltin:
      view.themeBuiltin === undefined ? DEFAULT_THEME_KEY : view.themeBuiltin,
    themeId: view.themeId,
    accentColor: view.accentColor,
    logoImageId: view.logoImageId,
    primaryFormat: view.primaryFormat ?? "16x9",
  });
  const slides: NormalizedDashboard["slides"] = {},
    widgets: NormalizedDashboard["widgets"] = {};
  const ordered = [...view.slides].sort(
    (a, b) => Number(a.position ?? 0) - Number(b.position ?? 0),
  );
  for (const slide of ordered) {
    const slideKey =
      widgetKeys[String(slide.id)] ?? `custom:${String(slide.id)}`;
    slides[slideKey] = slideValue(slide);
    for (const widget of slide.widgets) {
      const id = String(widget.id);
      widgets[widgetKeys[id] ?? `custom:${id}`] = {
        slide: slideKey,
        value: symbolize(widgetValue(widget), idsToKeys),
      };
    }
  }
  return {
    settings,
    filters: filtersOf(view.dataFilters, idsToKeys),
    slides,
    widgets,
  };
}

/**
 * Adds slide keys to a dashboard's template keys that have none (installs
 * made before slides were keyed, and baselines): a template slide is a slide
 * that holds keyed template widgets, in position order, at most
 * `templateSlides` of them. Every other slide stays the customer's
 * (`custom:<id>`), however much it looks like the template's, so a slide the
 * customer inserted in front never takes the template slide's place.
 */
export function withSlideKeys(
  widgetKeys: Record<string, string>,
  slides: readonly object[],
  templateSlides: number,
): Record<string, string> {
  if (Object.values(widgetKeys).some((key) => key.startsWith("slide:")))
    return widgetKeys;
  const keys = { ...widgetKeys };
  (
    slides as readonly {
      id?: unknown;
      position?: unknown;
      widgets?: unknown;
    }[]
  )
    .filter(
      (slide) =>
        Array.isArray(slide.widgets) &&
        slide.widgets.some((widget: { id?: unknown }) =>
          widgetKeys[String(widget.id)]?.startsWith("widget:"),
        ),
    )
    .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
    .slice(0, templateSlides)
    .forEach((slide, index) => {
      keys[String(slide.id)] = `slide:${index}`;
    });
  return keys;
}

const camel = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()),
      value,
    ]),
  );

/**
 * A dashboard as the 0072 migration stored it (`to_jsonb` rows, snake_case
 * columns). Only the columns are renamed; the values are read like the rows
 * findDashboard returns, with missing columns as their defaults.
 */
export function normalizeLegacyDashboard(
  snapshot: {
    dashboard: Record<string, unknown>;
    slides: (Record<string, unknown> & { widgets?: unknown })[];
  },
  widgetKeys: Record<string, string>,
  idsToKeys: Map<string, string>,
): NormalizedDashboard {
  return normalizeDashboard(
    {
      ...camel(snapshot.dashboard),
      slides: (Array.isArray(snapshot.slides) ? snapshot.slides : []).map(
        (slide) => ({
          ...camel(slide),
          widgets: (Array.isArray(slide.widgets) ? slide.widgets : []).map(
            (widget: Record<string, unknown>) => camel(widget),
          ),
        }),
      ),
    },
    widgetKeys,
    idsToKeys,
  );
}

/**
 * A dashboard the template builds (a create request), read as the dashboard
 * service would store it. `widgetKeys` are the keys of its widgets in
 * reading order (slide, then y, then x).
 */
export function normalizeTemplateDashboard(
  request: CreateDashboardRequest,
  widgetKeys: string[],
  idsToKeys: Map<string, string>,
): NormalizedDashboard {
  const parsed = createDashboardRequestSchema.parse(request);
  const settings = parsed.settings ?? {};
  const theme =
    settings.themeBuiltin === undefined && settings.themeId === undefined
      ? { themeBuiltin: DEFAULT_THEME_KEY, themeId: null }
      : {
          themeBuiltin: settings.themeBuiltin ?? null,
          themeId: settings.themeId ?? null,
        };
  const keys = [...widgetKeys];
  return normalizeDashboard(
    {
      dataFilters: settings.dataFilters ?? [],
      showHeader: settings.showHeader,
      autoAdvance: settings.autoAdvance,
      defaultSlideSeconds: settings.defaultSlideSeconds,
      transition: settings.transition,
      ...theme,
      accentColor: settings.accentColor ?? null,
      logoImageId: settings.logoImageId ?? null,
      primaryFormat: parsed.primaryFormat,
      slides: (parsed.slides ?? []).map((slide, position) => ({
        id: `template:slide:${position}`,
        position,
        name: slide.name ?? null,
        durationSeconds: slide.durationSeconds ?? null,
        enabled: slide.enabled ?? true,
        backgroundImageId: slide.background?.imageId ?? null,
        backgroundDim: slide.background?.dim ?? 0,
        widgets: [...slide.widgets]
          .sort((a, b) => a.y - b.y || a.x - b.x)
          .map((widget) => {
            const key = keys.shift();
            if (key === undefined)
              throw new Error("store template widgets differ from their keys");
            const input = widget as Record<string, unknown>;
            const denominator = input.denominator as
              Record<string, unknown> | undefined;
            return {
              ...input,
              id: `template:${key}`,
              modelBinding:
                widget.type === "measure"
                  ? widget.binding
                  : (input.measure ?? null),
              denominatorConnectionId: denominator?.connectionId,
              denominatorMetricKey: denominator?.metricKey,
              denominatorAggregation: denominator?.aggregation,
              denominatorDimensions: denominator?.dimensions,
            };
          }),
      })),
    },
    // Each template widget's and slide's stand-in id maps to its key.
    Object.fromEntries([
      ...widgetKeys.map((key) => [`template:${key}`, key]),
      ...(parsed.slides ?? []).map((_, index) => [
        `template:slide:${index}`,
        `slide:${index}`,
      ]),
    ]),
    idsToKeys,
  );
}

export function dashboardItems(
  key: StoreTemplateKey,
  d: NormalizedDashboard,
): Items {
  const items: Items = new Map();
  for (const [name, value] of Object.entries(d.settings))
    items.set(ref(key, "settings", name), canonical(value));
  for (const [id, value] of Object.entries(d.filters))
    items.set(ref(key, "filter", id), canonical(value));
  for (const [slideKey, value] of Object.entries(d.slides))
    items.set(
      ref(
        key,
        "slide",
        slideKey.startsWith("slide:")
          ? slideKey.slice("slide:".length)
          : slideKey,
      ),
      canonical(value),
    );
  for (const [widgetKey, { slide, value }] of Object.entries(d.widgets)) {
    const id = widgetKey.startsWith("widget:")
      ? widgetKey.slice("widget:".length)
      : widgetKey;
    items.set(
      ref(key, "widget", id),
      canonical({ slide, ...(value as object) }),
    );
  }
  return items;
}

/** A dashboard item's name back as the key normalizeDashboard uses. */
const slideKeyOf = (id: string) =>
  id.startsWith("custom:") ? id : `slide:${id}`;
const widgetKeyOf = (id: string) =>
  id.startsWith("custom:") ? id : `widget:${id}`;

/** The ids of one item kind of a dashboard, in the items' order. */
const idsOf = (items: Items, key: StoreTemplateKey, kind: ItemKind) => [
  ...itemsOf(items, key, kind).keys(),
];

/**
 * The inverse of dashboardItems, with real ids (desymbolize): a dashboard
 * from (merged) items. Filters and slides are in the current dashboard's
 * order, with the template's additions after their predecessor in the
 * template's order (mergeOrder); `slide:<index>` and `widget:<name>` are
 * the template's, `custom:<id>` the customer's. Throws UnmergeableRecord
 * with every item whose references resolve to nothing.
 */
export function dashboardFromItems(
  key: StoreTemplateKey,
  items: Items,
  order: { current: Items; next: Items },
  ids: Readonly<Record<string, string>>,
): NormalizedDashboard {
  const { resolve, done } = resolver(key);
  const real = (kind: ItemKind, id: string, value: unknown) =>
    resolve(ref(key, kind, id), () => desymbolize(value, ids));
  const ordered = (kind: ItemKind) => {
    const present = itemsOf(items, key, kind);
    return mergeOrder(
      idsOf(order.current, key, kind),
      idsOf(order.next, key, kind),
      new Set(present.keys()),
    ).map((id) => [id, present.get(id)] as const);
  };
  const result: NormalizedDashboard = {
    settings: {},
    filters: {},
    slides: {},
    widgets: {},
  };
  for (const [name, value] of itemsOf(items, key, "settings"))
    result.settings[name] = real("settings", name, value);
  for (const [id, value] of ordered("filter"))
    result.filters[id] = real("filter", id, value);
  for (const [id, value] of ordered("slide"))
    result.slides[slideKeyOf(id)] = real("slide", id, value);
  for (const [id, value] of itemsOf(items, key, "widget")) {
    const { slide, ...rest } = value as { slide: string } & object;
    result.widgets[widgetKeyOf(id)] = {
      slide,
      value: real("widget", id, rest),
    };
  }
  done();
  return result;
}

/**
 * App-scope parts (Global Constraints): the new template's value, not a
 * conflict. Whole append preparations (except parts the customer edited,
 * which they decide on), a model's datasets and the app filter's fixed
 * value; the source preparations of a connection the install gained or lost
 * are scope too, which only comparing the states can tell
 * (store-template-merge.ts).
 */
export function isScopeItem(ref: ItemRef | string): boolean {
  const key = recordKeyOf(ref),
    item = ref.slice(ref.indexOf("#") + 1);
  if (key.startsWith("preparation:append:")) return true;
  if (key.startsWith("model:") && item === "settings:datasets") return true;
  return key.startsWith("dashboard:") && item === "filter:app.fixedValue";
}
