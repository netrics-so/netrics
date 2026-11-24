import {
  clockWidgetOptionsSchema,
  statusWidgetOptionsSchema,
  stateWidgetOptionsSchema,
  countdownWidgetOptionsSchema,
  measureWidgetBindingSchema,
  measureWidgetOptionsSchema,
  semanticModelDefinitionSchema,
  tableWidgetOptionsSchema,
  textWidgetOptionsSchema,
  type FormatWarning,
} from "@netrics/contracts";
import {
  findGoalsByIds,
  findImages,
  findWorkspace,
  listConnectionIds,
  listWorkspaceMetrics,
  type Dashboard,
  type DashboardWidgetRow,
  type Transaction,
} from "@netrics/database";
import {
  countdownLabel,
  effectiveFontScale,
  isDataWidgetType,
  isScreenFormat,
  measureSampleSuffix,
  slideFormatWarnings,
  sourcesLabel,
  zonedInstant,
  type CustomLayout,
  type DataField,
  type Locale,
  type ReadabilityWidget,
  type ScreenFormat,
  type StudioWidgetType,
} from "@netrics/domain";

import { resolveThemeTokens } from "../themes/service.js";
import { measureUnits } from "./data.js";
import { publishedReleases, type PublishedRelease } from "./model-sources.js";

/**
 * Readability per format for the dashboard API (ADR 0017 section 6, #280):
 * every slide checked in every format, auto or custom, with the labels as
 * the screens show them in the reader's language. Pure domain checks over
 * what the read already loaded, plus a few small queries (the metric
 * names, the theme, the logo's size, and with measure tables their models'
 * column names).
 */

/** What the checks need besides the dashboard: loaded once per read. */
export interface ReadabilityInputs {
  fontScale: number;
  logoAspect: number | null;
  /** Slides with a logo of their own (#707): its aspect, by slide id. */
  slideLogoAspects?: ReadonlyMap<string, number | null>;
  /**
   * The workspace's time zone: clocks and countdowns without their own
   * use it.
   */
  timeZone: string;
  /** The reader's language: a countdown's label without a title. */
  locale: Locale;
  /** The moment of the read: whether a countdown's target has passed. */
  now: Date;
  /** The label of a data widget, as screens show it. */
  labelOf(widget: DashboardWidgetRow): string | null;
  /** A status board's label without a title ("Sources"). */
  sourcesLabel: string;
  /** The workspace's connections: what a board of every source lists. */
  sourceCount: number;
  /** The names of the goals the dashboard's goal widgets show, by id. */
  goalNames: ReadonlyMap<string, string>;
  /**
   * A measure table's column heads (#768): its grouped dimensions' and its
   * measures' names in its model's published release; null when unknown.
   */
  columnsOf?(widget: DashboardWidgetRow): string[] | null;
  /**
   * What follows a measure value view's values for its first measure's
   * unit (`measureUnitSuffix`, #835); unknown: "".
   */
  valueSuffixOf?(widget: DashboardWidgetRow): string;
}

/** The models whose releases the checks read: tables and split values. */
function readabilityModels(dashboard: Dashboard) {
  const tableModels = new Set<string>(),
    splitModels = new Set<string>();
  for (const slide of dashboard.slides)
    for (const widget of slide.widgets) {
      if (widget.type !== "measure" || widget.modelId === null) continue;
      const view = measureWidgetOptionsSchema.safeParse(widget.options).data
        ?.view;
      const groups =
        measureWidgetBindingSchema.safeParse(widget.modelBinding).data?.groupBy
          .length ?? 0;
      if (view === "table") tableModels.add(widget.modelId);
      if (view === "value" && groups > 0) splitModels.add(widget.modelId);
    }
  return { tableModels, splitModels };
}

/** The models `loadReadabilityInputs` needs the published releases of. */
export function readabilityModelIds(dashboard: Dashboard): string[] {
  const { tableModels, splitModels } = readabilityModels(dashboard);
  return [...new Set([...tableModels, ...splitModels])];
}

export async function loadReadabilityInputs(
  tx: Transaction,
  workspaceId: string,
  dashboard: Dashboard,
  locale: Locale,
  label: (widget: DashboardWidgetRow, metricName: string) => string | null,
  /**
   * The published releases of `readabilityModelIds`, when the caller has
   * read them already with others (presentDashboard); else read here.
   */
  releases?: ReadonlyMap<string, PublishedRelease>,
): Promise<ReadabilityInputs> {
  const hasData = dashboard.slides.some((slide) =>
    slide.widgets.some((widget) => isDataWidgetType(widget.type)),
  );
  // The metric names in the reader's language (#257), as the Studio and
  // the screens label untitled widgets.
  const names = new Map<string, string>();
  if (hasData) {
    for (const metric of await listWorkspaceMetrics(tx, workspaceId, locale)) {
      names.set(`${metric.connectionId}|${metric.key}`, metric.name);
    }
  }
  // Goal widgets are labelled with their goal's name (ADR 0019 §2).
  const goals = await findGoalsByIds(
    tx,
    workspaceId,
    dashboard.slides.flatMap((slide) =>
      slide.widgets.flatMap((widget) =>
        widget.type === "gauge" && widget.goalId !== null
          ? [widget.goalId]
          : [],
      ),
    ),
  );
  const goalNames = new Map(
    [...goals.values()].map((goal) => [goal.id, goal.name]),
  );
  // The models of measure tables (their column heads, #768) and of value
  // views with a grouping (their units, #835): each published release read
  // once, in one query, and each model's units probed once.
  const { tableModels, splitModels } = readabilityModels(dashboard);
  const modelIds = [...new Set([...tableModels, ...splitModels])];
  const modelNames = new Map<string, Map<string, string>>();
  const units = new Map<string, Map<string, string | undefined>>();
  if (modelIds.length) {
    const found =
      releases ?? (await publishedReleases(tx, workspaceId, modelIds));
    for (const id of modelIds) {
      const release = found.get(id);
      if (!release) continue;
      const row = { id, ...release };
      const definition = row.definition as {
        dimensions?: { id: string; name: string }[];
        measures?: { id: string; name: string }[];
      };
      modelNames.set(
        row.id,
        new Map(
          [
            ...(definition.dimensions ?? []),
            ...(definition.measures ?? []),
          ].map((entry) => [entry.id, entry.name]),
        ),
      );
      if (splitModels.has(row.id)) {
        const parsed = semanticModelDefinitionSchema.safeParse(row.definition);
        // A release that no longer parses: the check counts no unit.
        if (parsed.success)
          units.set(
            row.id,
            measureUnits(
              parsed.data,
              row.bindings as Record<string, DataField[]>,
            ),
          );
      }
    }
  }
  const tokens = await resolveThemeTokens(tx, workspaceId, dashboard);
  let logoAspect: number | null = null;
  const slideLogoAspects = new Map<string, number | null>();
  const logoIds = dashboard.showHeader
    ? [
        ...new Set(
          [
            dashboard.logoImageId,
            ...dashboard.slides.map((slide) => slide.logoImageId),
          ].filter((id): id is string => id !== null),
        ),
      ]
    : [];
  if (logoIds.length) {
    const logos = new Map(
      (await findImages(tx, workspaceId, logoIds)).map((logo) => [
        logo.id,
        logo.width > 0 && logo.height > 0 ? logo.width / logo.height : null,
      ]),
    );
    logoAspect = dashboard.logoImageId
      ? (logos.get(dashboard.logoImageId) ?? null)
      : null;
    for (const slide of dashboard.slides)
      if (slide.logoImageId)
        slideLogoAspects.set(slide.id, logos.get(slide.logoImageId) ?? null);
  }
  const hasZoneLine = dashboard.slides.some((slide) =>
    slide.widgets.some(
      (widget) =>
        widget.type === "clock" &&
        clockWidgetOptionsSchema.safeParse(widget.options).data?.showZone ===
          true,
    ),
  );
  const hasCountdown = dashboard.slides.some((slide) =>
    slide.widgets.some((widget) => widget.type === "countdown"),
  );
  const timeZone =
    hasZoneLine || hasCountdown
      ? ((await findWorkspace(tx, workspaceId))?.timeZone ?? "UTC")
      : "UTC";
  // A board of every source lists every connection (ADR 0019 section 7).
  const listsAll = dashboard.slides.some((slide) =>
    slide.widgets.some(
      (widget) =>
        widget.type === "status" &&
        (statusWidgetOptionsSchema.safeParse(widget.options).data
          ?.connectionIds ?? null) === null,
    ),
  );
  const sourceCount = listsAll
    ? (await listConnectionIds(tx, workspaceId)).length
    : 0;
  return {
    fontScale: effectiveFontScale(tokens?.fontScale),
    logoAspect,
    slideLogoAspects,
    timeZone,
    sourcesLabel: sourcesLabel(locale),
    sourceCount,
    goalNames,
    locale,
    now: new Date(),
    columnsOf(widget) {
      const names = widget.modelId ? modelNames.get(widget.modelId) : undefined;
      const binding = measureWidgetBindingSchema.safeParse(
        widget.modelBinding,
      ).data;
      if (!names || !binding) return null;
      const labels = measureWidgetOptionsSchema.safeParse(widget.options).data
        ?.labels;
      return [...binding.groupBy, ...binding.measureIds].map(
        (id) => labels?.[id] ?? names.get(id) ?? id,
      );
    },
    valueSuffixOf(widget) {
      const binding = measureWidgetBindingSchema.safeParse(
        widget.modelBinding,
      ).data;
      const unit =
        widget.modelId && binding
          ? units.get(widget.modelId)?.get(binding.measureIds[0]!)
          : undefined;
      return measureSampleSuffix(unit, locale);
    },
    labelOf(widget) {
      // A latest review has no metric (ADR 0019 section 12).
      if (widget.type === "review") {
        return label(widget, "");
      }
      if (widget.connectionId === null || widget.metricKey === null) {
        return null;
      }
      return label(
        widget,
        names.get(`${widget.connectionId}|${widget.metricKey}`) ??
          widget.metricKey,
      );
    },
  };
}

/** The readability warnings of each slide, by slide id. */
export function dashboardFormatWarnings(
  dashboard: Dashboard,
  inputs: ReadabilityInputs,
): Map<string, FormatWarning[]> {
  const primaryFormat: ScreenFormat = isScreenFormat(dashboard.primaryFormat)
    ? dashboard.primaryFormat
    : "16x9";
  const context = {
    primaryFormat,
    fontScale: inputs.fontScale,
    showHeader: dashboard.showHeader,
    dashboardName: dashboard.name,
    logoAspect: inputs.logoAspect,
    now: inputs.now,
  };
  const result = new Map<string, FormatWarning[]>();
  for (const slide of dashboard.slides) {
    const widgets: ReadabilityWidget[] = slide.widgets.map((widget) => {
      const type = widget.type as StudioWidgetType;
      const base = {
        id: widget.id,
        type,
        x: widget.x,
        y: widget.y,
        w: widget.w,
        h: widget.h,
      };
      if (type === "table") {
        return {
          ...base,
          label: inputs.labelOf(widget),
          rows: tableWidgetOptionsSchema.safeParse(widget.options).data?.limit,
        };
      }
      if (type === "measure") {
        // A measure table's rows above its footer lines (#768).
        const options = measureWidgetOptionsSchema.safeParse(
          widget.options,
        ).data;
        const groups =
          measureWidgetBindingSchema.safeParse(widget.modelBinding).data
            ?.groupBy.length ?? 0;
        return {
          ...base,
          label: widget.title,
          rows: options?.view === "table" ? options.limit : null,
          // A value view with a grouping: a total with its split (#784).
          splitLines:
            options?.view === "value" && groups > 0 ? options.limit : null,
          valueSuffix: inputs.valueSuffixOf?.(widget) ?? "",
          columns: inputs.columnsOf?.(widget) ?? null,
        };
      }
      // A latest-items widget's label is its title, as a measure's (#810).
      if (type === "items") return { ...base, label: widget.title };
      if (type === "state") {
        // A state list's rows: its limit; "+N more" past them (#875).
        const options = stateWidgetOptionsSchema.safeParse(widget.options).data;
        return {
          ...base,
          label: widget.title,
          rows: options?.layout === "list" ? options.limit : null,
        };
      }
      if (isDataWidgetType(type) || type === "review") {
        return { ...base, label: inputs.labelOf(widget) };
      }
      if (type === "status") {
        const options = statusWidgetOptionsSchema.safeParse(
          widget.options,
        ).data;
        return {
          ...base,
          label: widget.title ?? inputs.sourcesLabel,
          rows: options?.connectionIds?.length ?? inputs.sourceCount,
        };
      }
      if (type === "gauge") {
        const goalName =
          widget.goalId === null
            ? undefined
            : inputs.goalNames.get(widget.goalId);
        return {
          ...base,
          label: widget.title ?? goalName ?? null,
          goalMissing: goalName === undefined,
        };
      }
      if (type === "text") {
        return {
          ...base,
          text: widget.text,
          textSize: textWidgetOptionsSchema.parse(widget.options).size,
        };
      }
      if (type === "clock") {
        const clock = clockWidgetOptionsSchema.safeParse(widget.options).data;
        return {
          ...base,
          clock: clock
            ? {
                showDate: clock.showDate,
                dateStyle: clock.dateStyle,
                zone: clock.showZone
                  ? (clock.timeZone ?? inputs.timeZone)
                  : null,
              }
            : null,
        };
      }
      if (type === "countdown") {
        const countdown = countdownWidgetOptionsSchema.safeParse(
          widget.options,
        ).data;
        return {
          ...base,
          label: countdownLabel(widget.title, inputs.locale),
          countdown: {
            targetAt: countdown
              ? (zonedInstant(
                  countdown.target,
                  countdown.timeZone ?? inputs.timeZone,
                )?.toISOString() ?? null)
              : null,
          },
        };
      }
      return base;
    });
    const layouts: Partial<Record<ScreenFormat, CustomLayout>> = {};
    for (const layout of slide.layouts) {
      if (!isScreenFormat(layout.format)) continue;
      layouts[layout.format] = {
        pages: layout.pages,
        placements: layout.placements.map((placement) => ({
          id: placement.widgetId,
          page: placement.page,
          x: placement.x,
          y: placement.y,
          w: placement.w,
          h: placement.h,
          hidden: placement.hidden,
          autoPlaced: placement.autoPlaced,
        })),
      };
    }
    result.set(
      slide.id,
      slideFormatWarnings(
        { name: slide.name, widgets, layouts },
        inputs.slideLogoAspects?.has(slide.id)
          ? {
              ...context,
              logoAspect: inputs.slideLogoAspects.get(slide.id) ?? null,
            }
          : context,
      ),
    );
  }
  return result;
}
