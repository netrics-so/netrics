import {
  clockWidgetOptionsSchema,
  statusWidgetOptionsSchema,
  countdownWidgetOptionsSchema,
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
  slideFormatWarnings,
  sourcesLabel,
  zonedInstant,
  type CustomLayout,
  type Locale,
  type ReadabilityWidget,
  type ScreenFormat,
  type StudioWidgetType,
} from "@netrics/domain";

import { resolveThemeTokens } from "../themes/service.js";

/**
 * Readability per format for the dashboard API (ADR 0017 section 6, #280):
 * every slide checked in every format, auto or custom, with the labels as
 * the screens show them in the reader's language. Pure domain checks over
 * what the read already loaded, plus at most three small queries (the
 * metric names, the theme, the logo's size).
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
}

export async function loadReadabilityInputs(
  tx: Transaction,
  workspaceId: string,
  dashboard: Dashboard,
  locale: Locale,
  label: (widget: DashboardWidgetRow, metricName: string) => string | null,
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
