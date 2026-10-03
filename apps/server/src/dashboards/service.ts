import {
  barWidgetOptionsSchema,
  clockWidgetOptionsSchema,
  lineWidgetOptionsSchema,
  metricWidgetOptionsSchema,
  textWidgetOptionsSchema,
  type CreateDashboardRequest,
  type Dashboard as DashboardView,
  type DashboardSettings as DashboardSettingsView,
  type DashboardTileInput,
  type DashboardWidget,
  type DashboardWidgetInputParsed,
  type DuplicateDashboardRequest,
  type ReplaceDashboardRequest,
} from "@netrics/contracts";
import {
  connectionHasResource,
  deleteDashboard,
  findConnectionMetric,
  findResourceNames,
  findDashboard,
  findProject,
  insertAuditEvent,
  insertDashboard,
  listDashboards,
  metricWidgets,
  replaceDashboard,
  resourceNameKey,
  withWorkspace,
  type Dashboard,
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
  RESOURCE_DIMENSION,
  STUDIO_LIMITS,
  compatibleAggregations,
  isCurrencyCode,
  isDataWidgetType,
  isPerCurrencyUnit,
  legacyLayout,
  slideLayoutProblem,
  type Aggregation,
  type MetricKind,
  type SlideTransition,
  type WidgetType,
} from "@netrics/domain";

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
    case "text":
      return textWidgetOptionsSchema.parse(options);
    case "clock":
      return clockWidgetOptionsSchema.parse(options);
  }
}

function settingsOf(dashboard: Dashboard): DashboardSettingsView {
  return {
    showHeader: dashboard.showHeader,
    autoAdvance: dashboard.autoAdvance,
    defaultSlideSeconds: dashboard.defaultSlideSeconds,
    transition: dashboard.transition as SlideTransition,
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
): Promise<DashboardView> {
  const data = dashboard.slides.flatMap((slide) =>
    slide.widgets.filter(isDataRow),
  );
  const names = await findResourceNames(
    tx,
    workspaceId,
    data.flatMap((widget) => {
      const resourceId = dimensionsOf(widget)[RESOURCE_DIMENSION];
      return resourceId === undefined
        ? []
        : [{ connectionId: widget.connectionId, resourceId }];
    }),
  );
  // "Downloads · All apps" for a widget that adds up several (#208).
  const scopes = await findAllResourcesNames(
    tx,
    workspaceId,
    data.map((widget) => ({
      connectionId: widget.connectionId,
      metricKey: widget.metricKey,
      dimensions: dimensionsOf(widget),
    })),
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
      return {
        type: widget.type,
        ...base,
        ...binding(widget),
        options: optionsOf(widget),
      } as DashboardWidget;
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
    slides: dashboard.slides.map((slide) => ({
      id: slide.id,
      position: slide.position,
      name: slide.name,
      durationSeconds: slide.durationSeconds,
      enabled: slide.enabled,
      widgets: slide.widgets.map(present),
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
}

/** A tile's or data widget's metric, checked against the workspace. */
async function validateBinding(
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
} as const;

async function validateWidget(
  tx: Transaction,
  workspaceId: string,
  widget: DashboardWidgetInputParsed,
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
  if (widget.type === "text" || widget.type === "clock") {
    return ok({
      ...base,
      ...EMPTY_WIDGET_DATA,
      text: widget.type === "text" ? widget.text : null,
      options: widget.options,
    });
  }
  const binding = await validateBinding(tx, workspaceId, widget);
  if (!binding.ok) {
    return binding;
  }
  const { metricDimensions, ...valid } = binding.value;
  if (
    widget.type === "bar" &&
    !metricDimensions.includes(widget.options.groupBy)
  ) {
    return fail(400, "unknown_dimension");
  }
  return ok({ ...base, ...valid, text: null, options: widget.options });
}

/** Slides as sent, checked: limits, layout and every data widget's metric. */
async function validateSlides(
  tx: Transaction,
  workspaceId: string,
  slides: NonNullable<ReplaceDashboardRequest["slides"]>,
): Promise<Result<SlideInput[]>> {
  const dataWidgets = slides
    .flatMap((slide) => slide.widgets)
    .filter((widget) => isDataWidgetType(widget.type)).length;
  if (dataWidgets > STUDIO_LIMITS.dataWidgets) {
    return fail(400, "too_many_data_widgets");
  }
  const valid: SlideInput[] = [];
  for (const slide of slides) {
    const problem = slideLayoutProblem(slide.widgets);
    if (problem) {
      return fail(400, problem);
    }
    const widgets: WidgetInput[] = [];
    for (const widget of slide.widgets) {
      const checked = await validateWidget(tx, workspaceId, widget);
      if (!checked.ok) {
        return checked;
      }
      widgets.push(checked.value);
    }
    valid.push({
      id: slide.id ?? null,
      name: slide.name ?? null,
      durationSeconds: slide.durationSeconds ?? null,
      enabled: slide.enabled ?? true,
      widgets,
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
      widgets: [],
    });
  }
  for (const [index, tile] of tiles.entries()) {
    const binding = await validateBinding(tx, workspaceId, tile);
    if (!binding.ok) {
      return binding;
    }
    const { metricDimensions: _, ...valid } = binding.value;
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
  widgets: [],
};

async function checkProject(
  tx: Transaction,
  workspaceId: string,
  projectId: string | null | undefined,
): Promise<boolean> {
  return !projectId || (await findProject(tx, workspaceId, projectId)) !== null;
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

  return {
    list(actor: Actor) {
      return inWorkspace(actor, async (tx) =>
        (await listDashboards(tx, actor.workspaceId)).map((summary) => ({
          ...summary,
          updatedAt: summary.updatedAt.toISOString(),
        })),
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
          ? ok(await presentDashboard(tx, actor.workspaceId, dashboard))
          : fail<DashboardView>(404, NOT_FOUND);
      });
    },

    create(actor: Actor, body: CreateDashboardRequest) {
      return inWorkspace(actor, async (tx) => {
        if (!(await checkProject(tx, actor.workspaceId, body.projectId))) {
          return fail<DashboardView>(404, "project_not_found");
        }
        const slides = body.slides
          ? await validateSlides(tx, actor.workspaceId, body.slides)
          : body.tiles
            ? await tilesToSlides(tx, actor.workspaceId, body.tiles)
            : ok([EMPTY_SLIDE]);
        if (!slides.ok) {
          return slides;
        }
        const dashboard = await insertDashboard(tx, actor.workspaceId, {
          name: body.name,
          projectId: body.projectId ?? null,
          settings: { ...DEFAULT_DASHBOARD_SETTINGS, ...body.settings },
          slides: slides.value.length > 0 ? slides.value : [EMPTY_SLIDE],
        });
        await insertAuditEvent(tx, {
          workspaceId: actor.workspaceId,
          actorUserId: actor.callerId,
          action: "dashboard.created",
          target: dashboard.id,
          metadata: { name: dashboard.name },
        });
        return ok(await presentDashboard(tx, actor.workspaceId, dashboard));
      });
    },

    replace(actor: Actor, dashboardId: string, body: ReplaceDashboardRequest) {
      return inWorkspace(actor, async (tx) => {
        if (!(await checkProject(tx, actor.workspaceId, body.projectId))) {
          return fail<DashboardView>(404, "project_not_found");
        }
        let slides: Result<SlideInput[]>;
        if (body.tiles) {
          // Legacy save: only over a tile dashboard, so a stale tab of the
          // tile editor cannot flatten a studio dashboard (ADR 0015).
          const current = await findDashboard(
            tx,
            actor.workspaceId,
            dashboardId,
          );
          if (!current) {
            return fail<DashboardView>(404, NOT_FOUND);
          }
          if (current.version !== body.version) {
            return fail<DashboardView>(409, "version_conflict");
          }
          if (!isTileDashboard(current.slides)) {
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
          );
        }
        if (!slides.ok) {
          return slides;
        }
        const result = await replaceDashboard(
          tx,
          actor.workspaceId,
          dashboardId,
          body.version,
          {
            name: body.name,
            projectId: body.projectId,
            ...(body.settings ? { settings: body.settings } : {}),
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
          },
        });
        return ok(
          await presentDashboard(tx, actor.workspaceId, result.dashboard),
        );
      });
    },

    duplicate(
      actor: Actor,
      dashboardId: string,
      body: DuplicateDashboardRequest,
    ) {
      return inWorkspace(actor, async (tx) => {
        const source = await findDashboard(tx, actor.workspaceId, dashboardId);
        if (!source) {
          return fail<DashboardView>(404, NOT_FOUND);
        }
        const name = body.name ?? `${source.name} (copy)`.slice(0, 100);
        const copy = await insertDashboard(tx, actor.workspaceId, {
          name,
          projectId: source.projectId,
          settings: settingsOf(source),
          slides: source.slides.map((slide) => ({
            name: slide.name,
            durationSeconds: slide.durationSeconds,
            enabled: slide.enabled,
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
              options: widget.options as Record<string, unknown>,
            })),
          })),
        });
        await insertAuditEvent(tx, {
          workspaceId: actor.workspaceId,
          actorUserId: actor.callerId,
          action: "dashboard.duplicated",
          target: copy.id,
          metadata: { name, sourceId: dashboardId },
        });
        return ok(await presentDashboard(tx, actor.workspaceId, copy));
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
