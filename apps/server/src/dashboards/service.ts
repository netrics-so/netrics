import {
  barWidgetOptionsSchema,
  compareWidgetOptionsSchema,
  gaugeWidgetOptionsSchema,
  tableWidgetOptionsSchema,
  clockWidgetOptionsSchema,
  countdownWidgetOptionsSchema,
  imageWidgetOptionsSchema,
  lineWidgetOptionsSchema,
  metricWidgetOptionsSchema,
  statusWidgetOptionsSchema,
  textWidgetOptionsSchema,
  type CreateDashboardRequest,
  type Dashboard as DashboardView,
  type DashboardSettings as DashboardSettingsView,
  type DashboardSettingsInput,
  type DashboardTileInput,
  type DashboardWidget,
  type DashboardWidgetInputParsed,
  type DuplicateDashboardRequest,
  type ReplaceDashboardRequest,
  type ScreenFormatKey,
} from "@netrics/contracts";
import {
  connectionHasResource,
  deleteDashboard,
  findConnectionMetric,
  findResourceNames,
  findDashboard,
  findGoal,
  findImageIds,
  findProject,
  insertAuditEvent,
  insertDashboard,
  listConnectionIds,
  listDashboards,
  metricWidgets,
  replaceDashboard,
  resourceNameKey,
  hasSqlstate,
  withWorkspace,
  type Dashboard,
  type DashboardSettings,
  type DashboardSlide,
  type DashboardWidgetRow,
  type Database,
  type SlideInput,
  type Transaction,
  type WidgetInput,
} from "@netrics/database";
import {
  CURRENCY_DIMENSION,
  DEFAULT_DASHBOARD_SETTINGS,
  DEFAULT_LOCALE,
  DEFAULT_THEME_KEY,
  RESOURCE_DIMENSION,
  checkAccentContrast,
  STUDIO_LIMITS,
  compareUnitsProblem,
  compatibleAggregations,
  dataWidgetCost,
  isCurrencyCode,
  isDataWidgetType,
  isPerCurrencyUnit,
  legacyLayout,
  slideLayoutProblem,
  tileLabel,
  type Aggregation,
  type Locale,
  type MetricKind,
  type ScreenFormat,
  type SlideTransition,
  type WidgetType,
} from "@netrics/domain";

import { resolveThemeTokens } from "../themes/service.js";
import { presentSummaries } from "./summaries.js";
import { copyLayouts, rebaseSlides, resolveSlideLayouts } from "./layouts.js";
import {
  dashboardFormatWarnings,
  loadReadabilityInputs,
} from "./readability.js";
import {
  findAllResourcesNames,
  tileAllResourcesName,
} from "../metrics/query.js";

/**
 * Dashboard use cases (#49; slides and widgets since ADR 0015). A data
 * widget (or tile) can only show a metric its connection provides, with an
 * aggregation that fits the metric's kind; widgets lie inside the grid,
 * keep their type's minimum size and do not overlap.
 */

export interface Actor {
  workspaceId: string;
  callerId: string;
  /** The caller's language: labels in responses use it (ADR 0016). */
  locale?: Locale;
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 404 | 409; error: string };

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail<T>(status: 400 | 404 | 409, error: string): Result<T> {
  return { ok: false, status, error };
}

const NOT_FOUND = "dashboard_not_found";

type DataWidgetRow = DashboardWidgetRow & {
  connectionId: string;
  metricKey: string;
};

function isDataRow(widget: DashboardWidgetRow): widget is DataWidgetRow {
  return isDataWidgetType(widget.type) && widget.connectionId !== null;
}

function dimensionsOf(widget: DashboardWidgetRow): Record<string, string> {
  return widget.dimensions as Record<string, string>;
}

/**
 * A compare widget's denominator as a binding row of its own (same id,
 * title and period), so it is named and labelled like any binding; null
 * for every other widget.
 */
function denominatorOf(widget: DashboardWidgetRow): DataWidgetRow | null {
  if (
    widget.denominatorConnectionId === null ||
    widget.denominatorMetricKey === null
  ) {
    return null;
  }
  return {
    ...widget,
    connectionId: widget.denominatorConnectionId,
    metricKey: widget.denominatorMetricKey,
    aggregation: widget.denominatorAggregation,
    dimensions: widget.denominatorDimensions,
    displayCurrency: null,
  };
}

/** Options as stored, with each type's defaults filled in. */
function optionsOf(widget: DashboardWidgetRow) {
  const options = widget.options as Record<string, unknown>;
  switch (widget.type as WidgetType) {
    case "metric":
      return metricWidgetOptionsSchema.parse(options);
    case "line":
      return lineWidgetOptionsSchema.parse(options);
    case "bar":
      return barWidgetOptionsSchema.parse(options);
    case "table":
      return tableWidgetOptionsSchema.parse(options);
    case "compare":
      return compareWidgetOptionsSchema.parse(options);
    case "gauge":
      return gaugeWidgetOptionsSchema.parse(options);
    case "image":
      return imageWidgetOptionsSchema.parse(options);
    case "text":
      return textWidgetOptionsSchema.parse(options);
    case "clock":
      return clockWidgetOptionsSchema.parse(options);
    case "status":
      return statusWidgetOptionsSchema.parse(options);
    case "countdown":
      return countdownWidgetOptionsSchema.parse(options);
  }
}

function settingsOf(dashboard: Dashboard): DashboardSettingsView {
  return {
    showHeader: dashboard.showHeader,
    autoAdvance: dashboard.autoAdvance,
    defaultSlideSeconds: dashboard.defaultSlideSeconds,
    transition: dashboard.transition as SlideTransition,
    themeBuiltin: dashboard.themeBuiltin,
    themeId: dashboard.themeId,
    accentColor: dashboard.accentColor,
    logoImageId: dashboard.logoImageId,
  };
}

/**
 * The dashboard as the API returns it, with the names of the resources its
 * data widgets show (#194, #208), and its metric widgets as `tiles` for the
 * expand/contract window.
 */
export async function presentDashboard(
  tx: Transaction,
  workspaceId: string,
  dashboard: Dashboard,
  locale: Locale = DEFAULT_LOCALE,
): Promise<DashboardView> {
  const data = dashboard.slides.flatMap((slide) =>
    slide.widgets.filter(isDataRow),
  );
  // A compare widget's denominator is labelled like a binding of its own.
  const denominators = data.flatMap((widget) => {
    const denominator = denominatorOf(widget);
    return denominator ? [denominator] : [];
  });
  const names = await findResourceNames(
    tx,
    workspaceId,
    [...data, ...denominators].flatMap((widget) => {
      const resourceId = dimensionsOf(widget)[RESOURCE_DIMENSION];
      return resourceId === undefined
        ? []
        : [{ connectionId: widget.connectionId, resourceId }];
    }),
  );
  // "Downloads · All apps" for a widget that adds up several (#208), in
  // the caller's language ("Alle Apps", #268).
  const scopes = await findAllResourcesNames(
    tx,
    workspaceId,
    [...data, ...denominators].map((widget) => ({
      connectionId: widget.connectionId,
      metricKey: widget.metricKey,
      dimensions: dimensionsOf(widget),
    })),
    locale,
  );
  const binding = (widget: DataWidgetRow) => {
    const dimensions = dimensionsOf(widget);
    const resourceId = dimensions[RESOURCE_DIMENSION];
    return {
      connectionId: widget.connectionId,
      metricKey: widget.metricKey,
      aggregation: widget.aggregation as Aggregation,
      period: widget.period as DashboardView["tiles"][number]["period"],
      dimensions,
      displayCurrency: widget.displayCurrency,
      resourceName:
        resourceId === undefined
          ? null
          : (names.get(resourceNameKey(widget.connectionId, resourceId)) ??
            null),
      allResourcesName: tileAllResourcesName(scopes, {
        connectionId: widget.connectionId,
        metricKey: widget.metricKey,
        dimensions,
      }),
    };
  };
  // Readability per format (ADR 0017 §6, #280), labelled as screens show
  // the widgets, in the reader's language.
  const readability = await loadReadabilityInputs(
    tx,
    workspaceId,
    dashboard,
    locale,
    (widget, metricName) => {
      if (!isDataRow(widget)) return null;
      const { dimensions, resourceName, allResourcesName } = binding(widget);
      return tileLabel({
        title: widget.title,
        metricName,
        dimensions,
        resourceName,
        allResourcesName,
      });
    },
  );
  const warnings = dashboardFormatWarnings(dashboard, readability);
  const present = (widget: DashboardWidgetRow): DashboardWidget => {
    const base = {
      id: widget.id,
      x: widget.x,
      y: widget.y,
      w: widget.w,
      h: widget.h,
      title: widget.title,
    };
    if (isDataRow(widget)) {
      const denominator = denominatorOf(widget);
      if (widget.type === "compare" && denominator) {
        const side = binding(denominator);
        return {
          type: "compare",
          ...base,
          ...binding(widget),
          denominator: {
            connectionId: side.connectionId,
            metricKey: side.metricKey,
            aggregation: side.aggregation,
            dimensions: side.dimensions,
            resourceName: side.resourceName,
            allResourcesName: side.allResourcesName,
          },
          options: compareWidgetOptionsSchema.parse(widget.options),
        };
      }
      return {
        type: widget.type,
        ...base,
        ...binding(widget),
        options: optionsOf(widget),
      } as DashboardWidget;
    }
    if (widget.type === "gauge") {
      const goalId =
        widget.goalId !== null && readability.goalNames.has(widget.goalId)
          ? widget.goalId
          : null;
      return {
        type: "gauge",
        ...base,
        goalId,
        goalName: goalId === null ? null : readability.goalNames.get(goalId)!,
        options: gaugeWidgetOptionsSchema.parse(widget.options),
      };
    }
    if (widget.type === "image") {
      return {
        type: "image",
        ...base,
        imageId: widget.imageId!,
        options: imageWidgetOptionsSchema.parse(widget.options),
      };
    }
    if (widget.type === "status") {
      return {
        type: "status",
        ...base,
        options: statusWidgetOptionsSchema.parse(widget.options),
      };
    }
    if (widget.type === "countdown") {
      return {
        type: "countdown",
        ...base,
        options: countdownWidgetOptionsSchema.parse(widget.options),
      };
    }
    return widget.type === "text"
      ? {
          type: "text",
          ...base,
          text: widget.text ?? "",
          options: textWidgetOptionsSchema.parse(widget.options),
        }
      : {
          type: "clock",
          ...base,
          options: clockWidgetOptionsSchema.parse(widget.options),
        };
  };
  return {
    id: dashboard.id,
    name: dashboard.name,
    projectId: dashboard.projectId,
    version: dashboard.version,
    createdAt: dashboard.createdAt.toISOString(),
    updatedAt: dashboard.updatedAt.toISOString(),
    settings: settingsOf(dashboard),
    primaryFormat: dashboard.primaryFormat as ScreenFormatKey,
    slides: dashboard.slides.map((slide) => ({
      id: slide.id,
      position: slide.position,
      name: slide.name,
      durationSeconds: slide.durationSeconds,
      enabled: slide.enabled,
      background:
        slide.backgroundImageId === null
          ? null
          : { imageId: slide.backgroundImageId, dim: slide.backgroundDim },
      widgets: slide.widgets.map(present),
      layouts: slide.layouts.map((layout) => ({
        format: layout.format as ScreenFormatKey,
        pages: layout.pages,
        placements: layout.placements.map((placement) => ({
          widgetId: placement.widgetId,
          page: placement.page,
          x: placement.x,
          y: placement.y,
          w: placement.w,
          h: placement.h,
          hidden: placement.hidden,
          autoPlaced: placement.autoPlaced,
        })),
      })),
      formatWarnings: warnings.get(slide.id) ?? [],
    })),
    tiles: metricWidgets(dashboard.slides, { enabledOnly: false })
      .filter(isDataRow)
      .map((widget, position) => {
        const { resourceName, allResourcesName, ...rest } = binding(widget);
        return {
          id: widget.id,
          position,
          ...rest,
          title: widget.title,
          resourceName,
          allResourcesName,
        };
      }),
  };
}

interface Binding {
  connectionId: string;
  metricKey: string;
  aggregation?: Aggregation | undefined;
  period: string;
  dimensions?: Record<string, string> | undefined;
  displayCurrency?: string | null | undefined;
}

interface ValidBinding {
  connectionId: string;
  metricKey: string;
  aggregation: string;
  period: string;
  dimensions: Record<string, string>;
  displayCurrency: string | null;
  /** The metric's dimension keys. */
  metricDimensions: readonly string[];
  /** The metric's unit ("count", "currency_minor"). */
  unit: string;
}

/**
 * A tile's, data widget's or goal's metric, checked against the workspace.
 */
export async function validateBinding(
  tx: Transaction,
  workspaceId: string,
  binding: Binding,
): Promise<Result<ValidBinding>> {
  const metric = await findConnectionMetric(
    tx,
    workspaceId,
    binding.connectionId,
    binding.metricKey,
  );
  if (!metric) {
    return fail(400, "tile_metric_not_found");
  }
  const compatible = compatibleAggregations(
    metric.kind as MetricKind,
    metric.aggregations as Aggregation[],
  );
  const aggregation = binding.aggregation ?? compatible[0];
  if (!aggregation || !compatible.includes(aggregation)) {
    return fail(400, "aggregation_not_supported");
  }
  const dimensions = binding.dimensions ?? {};
  if (Object.keys(dimensions).some((key) => !metric.dimensions.includes(key))) {
    return fail(400, "unknown_dimension");
  }
  // A per-currency amount shows one currency exactly (ADR 0014), or is
  // converted into its own display currency, or follows the workspace's
  // (#191): never two of these at once.
  const currency = dimensions[CURRENCY_DIMENSION];
  const perCurrency = isPerCurrencyUnit(metric.unit);
  if (perCurrency && currency !== undefined && !isCurrencyCode(currency)) {
    return fail(400, "currency_required");
  }
  const displayCurrency = binding.displayCurrency ?? null;
  if (displayCurrency !== null && (!perCurrency || currency !== undefined)) {
    return fail(400, "currency_choice_conflict");
  }
  // One resource is a resource of its own connection (#194).
  const resource = dimensions[RESOURCE_DIMENSION];
  if (
    resource !== undefined &&
    !(await connectionHasResource(
      tx,
      workspaceId,
      binding.connectionId,
      resource,
    ))
  ) {
    return fail(400, "unknown_resource");
  }
  return ok({
    connectionId: binding.connectionId,
    metricKey: binding.metricKey,
    aggregation,
    period: binding.period,
    dimensions,
    displayCurrency,
    metricDimensions: metric.dimensions,
    unit: metric.unit,
  });
}

const EMPTY_WIDGET_DATA = {
  connectionId: null,
  metricKey: null,
  aggregation: null,
  period: null,
  dimensions: {},
  displayCurrency: null,
  text: null,
  imageId: null,
  goalId: null,
} as const;

/**
 * What checking a status board's sources needs (ADR 0019 section 7): the
 * workspace's connections, loaded once per save, and the sources the saved
 * dashboard's boards named, so one deleted since drops out instead of
 * failing the save.
 */
interface StatusSources {
  connections(): Promise<ReadonlySet<string>>;
  stored: ReadonlySet<string>;
}

function statusSourcesOf(
  tx: Transaction,
  workspaceId: string,
  stored: Dashboard | null,
): StatusSources {
  let loaded: Promise<ReadonlySet<string>> | null = null;
  const named = new Set<string>();
  for (const slide of stored?.slides ?? []) {
    for (const widget of slide.widgets) {
      if (widget.type !== "status") continue;
      const ids = statusWidgetOptionsSchema.safeParse(widget.options).data
        ?.connectionIds;
      for (const id of ids ?? []) named.add(id);
    }
  }
  return {
    connections() {
      loaded ??= listConnectionIds(tx, workspaceId).then((ids) => new Set(ids));
      return loaded;
    },
    stored: named,
  };
}

/**
 * A status board's sources as stored: each a connection of the workspace.
 * One the saved dashboard named and that is gone since is dropped (all of
 * them gone: every source, null); any other unknown one is refused.
 */
async function validateStatusSources(
  ids: readonly string[] | null,
  sources: StatusSources,
): Promise<Result<string[] | null>> {
  if (ids === null) return ok(null);
  const connections = await sources.connections();
  const kept: string[] = [];
  for (const id of new Set(ids)) {
    if (connections.has(id)) kept.push(id);
    else if (!sources.stored.has(id)) return fail(400, "connection_not_found");
  }
  return ok(kept.length > 0 ? kept : null);
}

async function validateWidget(
  tx: Transaction,
  workspaceId: string,
  widget: DashboardWidgetInputParsed,
  sources: StatusSources,
): Promise<Result<WidgetInput>> {
  const base = {
    id: widget.id ?? null,
    type: widget.type,
    x: widget.x,
    y: widget.y,
    w: widget.w,
    h: widget.h,
    title: widget.title ?? null,
  };
  if (widget.type === "image") {
    // That the image is one of this workspace is checked with the
    // dashboard's other images (checkImages).
    return ok({
      ...base,
      ...EMPTY_WIDGET_DATA,
      imageId: widget.imageId,
      options: widget.options,
    });
  }
  if (widget.type === "status") {
    const connectionIds = await validateStatusSources(
      widget.options.connectionIds,
      sources,
    );
    if (!connectionIds.ok) {
      return connectionIds;
    }
    return ok({
      ...base,
      ...EMPTY_WIDGET_DATA,
      options: { ...widget.options, connectionIds: connectionIds.value },
    });
  }
  if (widget.type === "gauge") {
    // A goal of this workspace, or none: a goal deleted since the client
    // loaded the dashboard is stored as null, so the dashboard still saves
    // and the gauge shows "Goal deleted" (ADR 0019 section 5).
    const goal =
      widget.goalId === null
        ? null
        : await findGoal(tx, workspaceId, widget.goalId);
    return ok({
      ...base,
      ...EMPTY_WIDGET_DATA,
      goalId: goal?.id ?? null,
      options: widget.options,
    });
  }
  // No binding. A countdown's target may have passed: it still saves
  // (ADR 0019 section 8; the Studio shows `countdown_passed`).
  if (
    widget.type === "text" ||
    widget.type === "clock" ||
    widget.type === "countdown"
  ) {
    return ok({
      ...base,
      ...EMPTY_WIDGET_DATA,
      text: widget.type === "text" ? widget.text : null,
      options: widget.options,
    });
  }
  if (widget.type === "compare") {
    return validateCompare(tx, workspaceId, widget, base);
  }
  const binding = await validateBinding(tx, workspaceId, widget);
  if (!binding.ok) {
    return binding;
  }
  const { metricDimensions, unit: _unit, ...valid } = binding.value;
  if (
    widget.type === "bar" &&
    !metricDimensions.includes(widget.options.groupBy)
  ) {
    return fail(400, "unknown_dimension");
  }
  // A table groups like a bar chart, never by currency (ADR 0019 §6).
  if (
    widget.type === "table" &&
    (!metricDimensions.includes(widget.options.groupBy) ||
      widget.options.groupBy === CURRENCY_DIMENSION)
  ) {
    return fail(400, "unknown_dimension");
  }
  return ok({
    ...base,
    ...valid,
    text: null,
    imageId: null,
    goalId: null,
    options: widget.options,
  });
}

/**
 * A compare widget (ADR 0019 section 10): the numerator and the
 * denominator each checked as a binding over the shared period, then the
 * units against the format and the shared display currency
 * (`compareUnitsProblem`: 400 compare_units_incompatible or
 * currency_choice_conflict).
 */
async function validateCompare(
  tx: Transaction,
  workspaceId: string,
  widget: Extract<DashboardWidgetInputParsed, { type: "compare" }>,
  base: Pick<WidgetInput, "id" | "type" | "x" | "y" | "w" | "h" | "title">,
): Promise<Result<WidgetInput>> {
  // The display currency is checked below for both sides together: it
  // converts whichever side is a per-currency amount without a filter.
  const numerator = await validateBinding(tx, workspaceId, {
    ...widget,
    displayCurrency: null,
  });
  if (!numerator.ok) {
    return numerator;
  }
  const denominator = await validateBinding(tx, workspaceId, {
    ...widget.denominator,
    period: widget.period,
    displayCurrency: null,
  });
  if (!denominator.ok) {
    return denominator;
  }
  const displayCurrency = widget.displayCurrency ?? null;
  const problem = compareUnitsProblem({
    numerator: numerator.value,
    denominator: denominator.value,
    displayCurrency,
    format: widget.options.format,
  });
  if (problem) {
    return fail(400, problem);
  }
  const {
    metricDimensions: _numeratorDimensions,
    unit: _numeratorUnit,
    ...valid
  } = numerator.value;
  return ok({
    ...base,
    ...valid,
    displayCurrency,
    text: null,
    imageId: null,
    goalId: null,
    options: widget.options,
    denominator: {
      connectionId: denominator.value.connectionId,
      metricKey: denominator.value.metricKey,
      aggregation: denominator.value.aggregation,
      dimensions: denominator.value.dimensions,
    },
  });
}

/**
 * Slides as sent, checked: limits, layout in the primary format's grid,
 * every data widget's metric, and the custom layouts (ADR 0017), completed
 * against the widgets. `stored` is the saved dashboard on replace: a slide
 * sent without `layouts` keeps its stored ones.
 */
async function validateSlides(
  tx: Transaction,
  workspaceId: string,
  slides: NonNullable<ReplaceDashboardRequest["slides"]>,
  primary: ScreenFormat,
  stored: Dashboard | null = null,
): Promise<Result<SlideInput[]>> {
  // A compare widget runs two metric queries and counts twice; a goal
  // widget once (ADR 0019 section 2).
  const dataWidgets = slides
    .flatMap((slide) => slide.widgets)
    .reduce((sum, widget) => sum + dataWidgetCost(widget.type), 0);
  if (dataWidgets > STUDIO_LIMITS.dataWidgets) {
    return fail(400, "too_many_data_widgets");
  }
  const valid: SlideInput[] = [];
  const storedSlides = new Map(
    (stored?.slides ?? []).map((slide) => [slide.id, slide]),
  );
  const sources = statusSourcesOf(tx, workspaceId, stored);
  for (const slide of slides) {
    const problem = slideLayoutProblem(slide.widgets, primary);
    if (problem) {
      return fail(400, problem);
    }
    const widgets: WidgetInput[] = [];
    for (const widget of slide.widgets) {
      const checked = await validateWidget(tx, workspaceId, widget, sources);
      if (!checked.ok) {
        return checked;
      }
      widgets.push(checked.value);
    }
    // The first slide with a stored id keeps it, and its layouts.
    const own = slide.id ? storedSlides.get(slide.id) : undefined;
    if (slide.id) {
      storedSlides.delete(slide.id);
    }
    const layouts = resolveSlideLayouts({
      widgets,
      requested: slide.layouts,
      stored: own ?? null,
      primary,
    });
    if (!layouts.ok) {
      return layouts;
    }
    valid.push({
      id: slide.id ?? null,
      name: slide.name ?? null,
      durationSeconds: slide.durationSeconds ?? null,
      enabled: slide.enabled ?? true,
      backgroundImageId: slide.background?.imageId ?? null,
      backgroundDim: slide.background?.dim ?? 0,
      widgets,
      layouts: layouts.value,
    });
  }
  return ok(valid);
}

const DEFAULT_METRIC_OPTIONS = metricWidgetOptionsSchema.parse({});

/**
 * The automatic layout of `count` tiles (legacyLayout, #215) as one list in
 * reading order, and how many slides it takes (at least one).
 */
function automaticLayout(count: number) {
  const slides = legacyLayout(count);
  return {
    slideCount: slides.length,
    placements: slides.flatMap((placements, slide) =>
      placements.map((placement) => ({ slide, ...placement })),
    ),
  };
}

/**
 * Tiles as slides: metric widgets in the automatic layout (legacyLayout),
 * reusing the given slide ids by position.
 */
async function tilesToSlides(
  tx: Transaction,
  workspaceId: string,
  tiles: readonly DashboardTileInput[],
  slideIds: readonly string[] = [],
): Promise<Result<SlideInput[]>> {
  const { placements, slideCount } = automaticLayout(tiles.length);
  const slides: SlideInput[] = [];
  for (let slide = 0; slide < slideCount; slide++) {
    slides.push({
      id: slideIds[slide] ?? null,
      name: null,
      durationSeconds: null,
      enabled: true,
      backgroundImageId: null,
      backgroundDim: 0,
      widgets: [],
    });
  }
  for (const [index, tile] of tiles.entries()) {
    const binding = await validateBinding(tx, workspaceId, tile);
    if (!binding.ok) {
      return binding;
    }
    const { metricDimensions: _, unit: _unit, ...valid } = binding.value;
    const { slide, x, y, w, h } = placements[index]!;
    slides[slide]!.widgets.push({
      type: "metric",
      x,
      y,
      w,
      h,
      title: tile.title ?? null,
      ...valid,
      text: null,
      imageId: null,
      goalId: null,
      options: { ...DEFAULT_METRIC_OPTIONS },
    });
  }
  return ok(slides);
}

/**
 * Whether the dashboard is still a tile dashboard: metric widgets with
 * default options in the automatic layout, on plain slides. Only then may
 * a legacy `tiles` save replace it without losing anything.
 */
function isTileDashboard(slides: readonly DashboardSlide[]): boolean {
  const widgets = slides.flatMap((slide) =>
    slide.widgets.map((widget) => ({ slide: slide.position, widget })),
  );
  const { placements, slideCount } = automaticLayout(widgets.length);
  if (
    slides.length !== slideCount ||
    slides.some(
      (slide, index) =>
        slide.position !== index ||
        slide.name !== null ||
        slide.durationSeconds !== null ||
        slide.backgroundImageId !== null ||
        !slide.enabled,
    )
  ) {
    return false;
  }
  return widgets.every(({ slide, widget }, index) => {
    const place = placements[index]!;
    const options = metricWidgetOptionsSchema.safeParse(widget.options);
    return (
      widget.type === "metric" &&
      options.success &&
      options.data.showSparkline === DEFAULT_METRIC_OPTIONS.showSparkline &&
      options.data.showChange === DEFAULT_METRIC_OPTIONS.showChange &&
      Object.keys(widget.options as object).every(
        (key) => key in DEFAULT_METRIC_OPTIONS,
      ) &&
      slide === place.slide &&
      widget.x === place.x &&
      widget.y === place.y &&
      widget.w === place.w &&
      widget.h === place.h
    );
  });
}

const EMPTY_SLIDE: SlideInput = {
  name: null,
  durationSeconds: null,
  enabled: true,
  backgroundImageId: null,
  backgroundDim: 0,
  widgets: [],
};

type ThemeSettings = Pick<
  DashboardSettings,
  "themeBuiltin" | "themeId" | "accentColor"
>;

/** Splits the theme fields off the settings a request sends. */
function splitSettings(input: DashboardSettingsInput | undefined): {
  rest: Partial<DashboardSettings>;
  theme: Partial<ThemeSettings>;
} {
  const { themeBuiltin, themeId, accentColor, ...rest } = input ?? {};
  return { rest, theme: { themeBuiltin, themeId, accentColor } };
}

/**
 * The theme and accent a request sets (#216): a custom theme must be the
 * workspace's, and a brand accent must stay readable on the theme's surface
 * (ADR 0015, section 6). `current` is the saved dashboard, whose choice
 * applies where the request leaves something out; null on create.
 */
async function chooseTheme(
  tx: Transaction,
  workspaceId: string,
  request: Partial<ThemeSettings>,
  current: ThemeSettings | null,
): Promise<Result<Partial<ThemeSettings>>> {
  const choice: Partial<ThemeSettings> = {};
  if (request.themeBuiltin != null) {
    choice.themeBuiltin = request.themeBuiltin;
    choice.themeId = null;
  } else if (request.themeId != null) {
    choice.themeBuiltin = null;
    choice.themeId = request.themeId;
  }
  if (request.accentColor !== undefined) {
    choice.accentColor = request.accentColor;
  }
  const changesTheme = choice.themeId !== undefined;
  const ref = changesTheme
    ? { themeBuiltin: choice.themeBuiltin!, themeId: choice.themeId! }
    : {
        themeBuiltin: current ? current.themeBuiltin : DEFAULT_THEME_KEY,
        themeId: current ? current.themeId : null,
      };
  const accent =
    choice.accentColor !== undefined
      ? choice.accentColor
      : (current?.accentColor ?? null);
  if (!changesTheme && accent === null) {
    return ok(choice);
  }
  const tokens = await resolveThemeTokens(tx, workspaceId, ref);
  if (!tokens) {
    return fail(404, "theme_not_found");
  }
  if (accent !== null && checkAccentContrast(accent, tokens).level === "fail") {
    return fail(400, "contrast_too_low");
  }
  return ok(choice);
}

const IMAGE_REFERENCE_KEYS = [
  "dashboards_logo_image_fk",
  "dashboard_slides_background_image_fk",
  "dashboard_widgets_image_fk",
];

/** A foreign key violation on one of the image references. */
function isImageReferenceError(error: unknown): boolean {
  if (!hasSqlstate(error, "23503")) {
    return false;
  }
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 8; depth += 1) {
    const constraint = (current as { constraint_name?: unknown })
      .constraint_name;
    if (
      (typeof constraint === "string" &&
        IMAGE_REFERENCE_KEYS.includes(constraint)) ||
      IMAGE_REFERENCE_KEYS.some(
        (key) => current instanceof Error && current.message.includes(key),
      )
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * Whether every image a dashboard uses (logo, slide backgrounds, image
 * widgets) is an image of this workspace (#217). The composite foreign keys
 * enforce the same; this answers 400 image_not_found instead of failing.
 */
async function checkImages(
  tx: Transaction,
  workspaceId: string,
  logoImageId: string | null | undefined,
  slides: readonly SlideInput[],
): Promise<boolean> {
  const wanted = new Set<string>();
  if (logoImageId) {
    wanted.add(logoImageId);
  }
  for (const slide of slides) {
    if (slide.backgroundImageId) {
      wanted.add(slide.backgroundImageId);
    }
    for (const widget of slide.widgets) {
      if (widget.imageId) {
        wanted.add(widget.imageId);
      }
    }
  }
  if (wanted.size === 0) {
    return true;
  }
  const found = await findImageIds(tx, workspaceId, [...wanted]);
  return [...wanted].every((id) => found.has(id));
}

async function checkProject(
  tx: Transaction,
  workspaceId: string,
  projectId: string | null | undefined,
): Promise<boolean> {
  return !projectId || (await findProject(tx, workspaceId, projectId)) !== null;
}

/** A stored compare widget's denominator, to copy it; else null. */
function denominatorInputOf(
  widget: DashboardWidgetRow,
): WidgetInput["denominator"] {
  const denominator = denominatorOf(widget);
  return denominator
    ? {
        connectionId: denominator.connectionId,
        metricKey: denominator.metricKey,
        aggregation: denominator.aggregation!,
        dimensions: dimensionsOf(denominator),
      }
    : null;
}

function counts(dashboard: Dashboard) {
  return {
    tileCount: metricWidgets(dashboard.slides, { enabledOnly: false }).length,
    slideCount: dashboard.slides.length,
    widgetCount: dashboard.slides.reduce(
      (sum, slide) => sum + slide.widgets.length,
      0,
    ),
  };
}

export function createDashboardService(deps: { db: Database }) {
  const inWorkspace = <T>(actor: Actor, run: (tx: Transaction) => Promise<T>) =>
    withWorkspace(
      deps.db,
      { workspaceId: actor.workspaceId, userId: actor.callerId },
      run,
    );

  /**
   * A dashboard write. An image it uses may be deleted by a concurrent
   * request after checkImages; the deferred image keys then refuse the
   * commit (23503), which is answered like a missing image (#217).
   */
  const writeInWorkspace = async (
    actor: Actor,
    run: (tx: Transaction) => Promise<Result<DashboardView>>,
  ): Promise<Result<DashboardView>> => {
    try {
      return await inWorkspace(actor, run);
    } catch (error) {
      if (isImageReferenceError(error)) {
        return fail<DashboardView>(400, "image_not_found");
      }
      throw error;
    }
  };

  return {
    list(actor: Actor) {
      return inWorkspace(actor, async (tx) =>
        presentSummaries(
          tx,
          actor.workspaceId,
          await listDashboards(tx, actor.workspaceId),
        ),
      );
    },

    get(actor: Actor, dashboardId: string) {
      return inWorkspace(actor, async (tx) => {
        const dashboard = await findDashboard(
          tx,
          actor.workspaceId,
          dashboardId,
        );
        return dashboard
          ? ok(
              await presentDashboard(
                tx,
                actor.workspaceId,
                dashboard,
                actor.locale,
              ),
            )
          : fail<DashboardView>(404, NOT_FOUND);
      });
    },

    create(actor: Actor, body: CreateDashboardRequest) {
      return writeInWorkspace(actor, async (tx) => {
        if (!(await checkProject(tx, actor.workspaceId, body.projectId))) {
          return fail<DashboardView>(404, "project_not_found");
        }
        const primary = (body.primaryFormat ?? "16x9") as ScreenFormat;
        if (body.tiles && primary !== "16x9") {
          // Tiles are laid out on the 16x9 grid (legacyLayout).
          return fail<DashboardView>(400, "tiles_primary_format");
        }
        const slides = body.slides
          ? await validateSlides(tx, actor.workspaceId, body.slides, primary)
          : body.tiles
            ? await tilesToSlides(tx, actor.workspaceId, body.tiles)
            : ok([EMPTY_SLIDE]);
        if (!slides.ok) {
          return slides;
        }
        const { rest, theme: themeRequest } = splitSettings(body.settings);
        const theme = await chooseTheme(
          tx,
          actor.workspaceId,
          themeRequest,
          null,
        );
        if (!theme.ok) {
          return theme;
        }
        if (
          !(await checkImages(
            tx,
            actor.workspaceId,
            body.settings?.logoImageId,
            slides.value,
          ))
        ) {
          return fail<DashboardView>(400, "image_not_found");
        }
        const dashboard = await insertDashboard(tx, actor.workspaceId, {
          name: body.name,
          projectId: body.projectId ?? null,
          settings: {
            ...DEFAULT_DASHBOARD_SETTINGS,
            ...rest,
            ...theme.value,
          },
          primaryFormat: primary,
          slides: slides.value.length > 0 ? slides.value : [EMPTY_SLIDE],
        });
        await insertAuditEvent(tx, {
          workspaceId: actor.workspaceId,
          actorUserId: actor.callerId,
          action: "dashboard.created",
          target: dashboard.id,
          metadata: { name: dashboard.name },
        });
        return ok(
          await presentDashboard(
            tx,
            actor.workspaceId,
            dashboard,
            actor.locale,
          ),
        );
      });
    },

    replace(actor: Actor, dashboardId: string, body: ReplaceDashboardRequest) {
      return writeInWorkspace(actor, async (tx) => {
        if (!(await checkProject(tx, actor.workspaceId, body.projectId))) {
          return fail<DashboardView>(404, "project_not_found");
        }
        const current = await findDashboard(tx, actor.workspaceId, dashboardId);
        if (!current) {
          return fail<DashboardView>(404, NOT_FOUND);
        }
        const primary = current.primaryFormat as ScreenFormat;
        let slides: Result<SlideInput[]>;
        if (body.tiles) {
          // Legacy save: only over a tile dashboard, so a stale tab of the
          // tile editor cannot flatten a studio dashboard (ADR 0015).
          if (current.version !== body.version) {
            return fail<DashboardView>(409, "version_conflict");
          }
          if (
            primary !== "16x9" ||
            body.primaryFormat !== undefined ||
            !isTileDashboard(current.slides)
          ) {
            return fail<DashboardView>(409, "studio_dashboard");
          }
          slides = await tilesToSlides(
            tx,
            actor.workspaceId,
            body.tiles,
            current.slides.map((slide) => slide.id),
          );
        } else {
          slides = await validateSlides(
            tx,
            actor.workspaceId,
            body.slides ?? [],
            primary,
            current,
          );
          // A new primary format re-bases the slides (ADR 0017 section 4).
          const target = body.primaryFormat as ScreenFormat | undefined;
          if (slides.ok && target !== undefined && target !== primary) {
            slides = rebaseSlides(slides.value, primary, target);
          }
        }
        if (!slides.ok) {
          return slides;
        }
        const { rest, theme: themeRequest } = splitSettings(body.settings);
        let themeSettings: Partial<ThemeSettings> = {};
        if (Object.values(themeRequest).some((value) => value !== undefined)) {
          const theme = await chooseTheme(
            tx,
            actor.workspaceId,
            themeRequest,
            current,
          );
          if (!theme.ok) {
            return theme;
          }
          themeSettings = theme.value;
        }
        if (
          !(await checkImages(
            tx,
            actor.workspaceId,
            body.settings?.logoImageId,
            slides.value,
          ))
        ) {
          return fail<DashboardView>(400, "image_not_found");
        }
        const result = await replaceDashboard(
          tx,
          actor.workspaceId,
          dashboardId,
          body.version,
          {
            name: body.name,
            projectId: body.projectId,
            ...(body.settings
              ? { settings: { ...rest, ...themeSettings } }
              : {}),
            ...(body.primaryFormat
              ? { primaryFormat: body.primaryFormat }
              : {}),
            slides: slides.value.length > 0 ? slides.value : [EMPTY_SLIDE],
          },
        );
        if (result.status === "not_found") {
          return fail<DashboardView>(404, NOT_FOUND);
        }
        if (result.status === "version_conflict") {
          return fail<DashboardView>(409, "version_conflict");
        }
        await insertAuditEvent(tx, {
          workspaceId: actor.workspaceId,
          actorUserId: actor.callerId,
          action: "dashboard.updated",
          target: dashboardId,
          metadata: {
            name: result.dashboard.name,
            version: result.dashboard.version,
            ...counts(result.dashboard),
            ...(result.dashboard.primaryFormat !== primary
              ? {
                  primaryFormat: {
                    from: primary,
                    to: result.dashboard.primaryFormat,
                  },
                }
              : {}),
          },
        });
        return ok(
          await presentDashboard(
            tx,
            actor.workspaceId,
            result.dashboard,
            actor.locale,
          ),
        );
      });
    },

    duplicate(
      actor: Actor,
      dashboardId: string,
      body: DuplicateDashboardRequest,
    ) {
      return writeInWorkspace(actor, async (tx) => {
        const source = await findDashboard(tx, actor.workspaceId, dashboardId);
        if (!source) {
          return fail<DashboardView>(404, NOT_FOUND);
        }
        const name = body.name ?? `${source.name} (copy)`.slice(0, 100);
        const copy = await insertDashboard(tx, actor.workspaceId, {
          name,
          projectId: source.projectId,
          settings: settingsOf(source),
          primaryFormat: source.primaryFormat,
          slides: source.slides.map((slide) => ({
            name: slide.name,
            durationSeconds: slide.durationSeconds,
            enabled: slide.enabled,
            backgroundImageId: slide.backgroundImageId,
            backgroundDim: slide.backgroundDim,
            widgets: slide.widgets.map((widget) => ({
              type: widget.type,
              x: widget.x,
              y: widget.y,
              w: widget.w,
              h: widget.h,
              title: widget.title,
              connectionId: widget.connectionId,
              metricKey: widget.metricKey,
              aggregation: widget.aggregation,
              period: widget.period,
              dimensions: dimensionsOf(widget),
              displayCurrency: widget.displayCurrency,
              text: widget.text,
              imageId: widget.imageId,
              goalId: widget.goalId,
              options: widget.options as Record<string, unknown>,
              denominator: denominatorInputOf(widget),
            })),
            layouts: copyLayouts(slide),
          })),
        });
        await insertAuditEvent(tx, {
          workspaceId: actor.workspaceId,
          actorUserId: actor.callerId,
          action: "dashboard.duplicated",
          target: copy.id,
          metadata: { name, sourceId: dashboardId },
        });
        return ok(
          await presentDashboard(tx, actor.workspaceId, copy, actor.locale),
        );
      });
    },

    remove(actor: Actor, dashboardId: string) {
      return inWorkspace(actor, async (tx) => {
        const existing = await findDashboard(
          tx,
          actor.workspaceId,
          dashboardId,
        );
        if (!existing) {
          return fail<null>(404, NOT_FOUND);
        }
        await deleteDashboard(tx, actor.workspaceId, dashboardId);
        await insertAuditEvent(tx, {
          workspaceId: actor.workspaceId,
          actorUserId: actor.callerId,
          action: "dashboard.deleted",
          target: dashboardId,
          metadata: { name: existing.name },
        });
        return ok(null);
      });
    },
  };
}
