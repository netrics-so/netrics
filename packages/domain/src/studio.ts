import {
  findOverlaps,
  isInsideGrid,
  meetsMinimumSize,
  type StudioPlacement,
} from "./studio-layout.js";

// Dashboard Studio model (ADR 0015 sections 1–4): what the server stores
// and validates. Placement rules, sizes and the tile migration's automatic
// layout live in studio-layout.ts (#215), shared with tvOS.

/** Widget types the server accepts (image follows with #217). */
export const WIDGET_TYPES = ["metric", "line", "bar", "text", "clock"] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

/** Widgets that show a metric of a connection. */
export const DATA_WIDGET_TYPES = ["metric", "line", "bar"] as const;
export type DataWidgetType = (typeof DATA_WIDGET_TYPES)[number];

export function isDataWidgetType(type: string): type is DataWidgetType {
  return (DATA_WIDGET_TYPES as readonly string[]).includes(type);
}

/** Server-validated limits; they bound payload size and query cost. */
export const STUDIO_LIMITS = {
  slides: 12,
  widgetsPerSlide: 16,
  dataWidgets: 48,
  textLength: 500,
  slideNameLength: 60,
  widgetTitleLength: 100,
} as const;

/** How long a slide stays on screen (seconds). */
export const SLIDE_SECONDS = { min: 5, max: 3600, default: 20 } as const;

export const SLIDE_TRANSITIONS = ["none", "fade"] as const;
export type SlideTransition = (typeof SLIDE_TRANSITIONS)[number];

/** Settings of a new or migrated dashboard. */
export const DEFAULT_DASHBOARD_SETTINGS = {
  showHeader: true,
  autoAdvance: true,
  defaultSlideSeconds: SLIDE_SECONDS.default,
  transition: "fade",
} as const satisfies {
  showHeader: boolean;
  autoAdvance: boolean;
  defaultSlideSeconds: number;
  transition: SlideTransition;
};

/** Reading order on a slide: top to bottom, then left to right. */
export function compareReadingOrder(
  a: StudioPlacement,
  b: StudioPlacement,
): number {
  return a.y - b.y || a.x - b.x;
}

export type SlideLayoutProblem =
  "widget_out_of_bounds" | "widget_too_small" | "widgets_overlap";

/**
 * Why a slide's widgets cannot be placed as given, or null when they fit:
 * each inside the grid, at least its type's minimum size, none overlapping.
 */
export function slideLayoutProblem(
  widgets: ReadonlyArray<StudioPlacement & { type: WidgetType }>,
): SlideLayoutProblem | null {
  if (!widgets.every(isInsideGrid)) {
    return "widget_out_of_bounds";
  }
  if (!widgets.every((widget) => meetsMinimumSize(widget.type, widget))) {
    return "widget_too_small";
  }
  return findOverlaps(widgets).length > 0 ? "widgets_overlap" : null;
}
