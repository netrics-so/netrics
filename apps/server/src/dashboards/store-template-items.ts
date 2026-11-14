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

/** Replaces each of the model's datasets by `datasets[<index>]`. */
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

export interface NormalizedDashboard {
  /** Dashboard-level settings without name, project, version, timestamps. */
  settings: Record<string, unknown>;
  /** Shared filters by id; the app filter's fixed value is `app.fixedValue`. */
  filters: Record<string, unknown>;
  /** By position. */
  slides: Record<string, unknown>;
  /** By widget key, or `custom:<widgetId>` for the customer's widgets. */
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
 * The dashboard as stored. Template widgets are keyed by `widgetKeys`
 * (widget id → widget key); the others are `custom:<widgetId>`.
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
    const position = String(slide.position ?? 0);
    slides[position] = slideValue(slide);
    for (const widget of slide.widgets) {
      const id = String(widget.id);
      widgets[widgetKeys[id] ?? `custom:${id}`] = {
        slide: position,
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
    // Each template widget's stand-in id maps to its key.
    Object.fromEntries(widgetKeys.map((key) => [`template:${key}`, key])),
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
  for (const [position, value] of Object.entries(d.slides))
    items.set(ref(key, "slide", position), canonical(value));
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

/**
 * App-scope parts (Global Constraints): never conflicts, always the new
 * template's value. Whole append preparations, a model's datasets and the
 * app filter's fixed value; that a per-connection source preparation exists
 * at all is scope too, which only the comparison of whole records can tell
 * (store-template-merge.ts).
 */
export function isScopeItem(ref: ItemRef | string): boolean {
  const key = recordKeyOf(ref),
    item = ref.slice(ref.indexOf("#") + 1);
  if (key.startsWith("preparation:append:")) return true;
  if (key.startsWith("model:") && item === "settings:datasets") return true;
  return key.startsWith("dashboard:") && item === "filter:app.fixedValue";
}
