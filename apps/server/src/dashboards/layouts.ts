import type { DashboardSlideInput } from "@netrics/contracts";
import type {
  DashboardSlide,
  SlideInput,
  SlideLayoutInput,
  WidgetInput,
} from "@netrics/database";
import {
  completeCustomLayout,
  reflowSlide,
  validateCustomLayout,
  type CustomLayout,
  type CustomLayoutProblemCode,
  type CustomPlacement,
  type LayoutWidget,
  type ScreenFormat,
  type StudioWidgetType,
} from "@netrics/domain";

/**
 * Custom layouts on save (ADR 0017 sections 4 and 8). The domain checks and
 * completes a layout (validateCustomLayout, completeCustomLayout, #274);
 * this module ties layouts to the widgets of a save. Placements name
 * widgets by the ids a request sends; in between, a widget is known by its
 * index in the slide (`#0`, `#1`, …), because new widgets have no id until
 * they are written.
 */

type Result<T> =
  { ok: true; value: T } | { ok: false; status: 400 | 409; error: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(status: 400 | 409, error: string): Result<T> => ({
  ok: false,
  status,
  error,
});

type RequestedLayout = NonNullable<DashboardSlideInput["layouts"]>[number];

const key = (index: number) => `#${index}`;

/**
 * What a layout looks like after a primary edit, resolved by
 * completeCustomLayout rather than refused (#274's recommendation).
 */
const TOLERATED_PROBLEMS = new Set<CustomLayoutProblemCode>([
  "widget_missing",
  "unknown_widget",
]);
const indexOf = (widgetKey: string) => Number(widgetKey.slice(1));

/** A slide's widgets as the domain's layout functions take them. */
function layoutWidgets(
  widgets: readonly Pick<WidgetInput, "type" | "x" | "y" | "w" | "h">[],
): LayoutWidget[] {
  return widgets.map((widget, index) => ({
    id: key(index),
    type: widget.type as StudioWidgetType,
    x: widget.x,
    y: widget.y,
    w: widget.w,
    h: widget.h,
  }));
}

/** A completed layout as the database stores it. */
function toInput(format: ScreenFormat, layout: CustomLayout): SlideLayoutInput {
  return {
    format,
    pages: layout.pages,
    placements: layout.placements.map(({ id, ...placement }) => ({
      ...placement,
      widget: indexOf(id),
    })),
  };
}

/**
 * The custom layouts a slide is saved with, completed against its widgets
 * in the primary format (the sync rules of ADR 0017 section 4).
 *
 * - `requested` (the slide's `layouts` as sent): checked as sent (pages,
 *   each widget once, grid, minimum sizes, overlaps per page; 400
 *   `layout_<problem>`), except for the normal state of a layout after a
 *   primary edit: placements of widgets the slide no longer has are
 *   dropped, and widgets without a placement (new ones are sent without an
 *   id) are placed automatically and flagged.
 * - Missing `requested`: the stored layouts of the same slide (`stored`)
 *   are kept, for a client from before ADR 0017. Their placements follow
 *   the widgets by id; widgets that are gone drop out, new ones and ones
 *   whose placement no longer fits are placed automatically, flagged.
 */
export function resolveSlideLayouts(input: {
  widgets: readonly WidgetInput[];
  requested: readonly RequestedLayout[] | undefined;
  stored: DashboardSlide | null;
  primary: ScreenFormat;
}): Result<SlideLayoutInput[]> {
  const { widgets, requested, stored, primary } = input;
  const all = layoutWidgets(widgets);
  const primaryLayout = { format: primary, widgets: all };
  // The first widget with a given id wins, as when the save keeps ids.
  const byId = new Map<string, number>();
  widgets.forEach((widget, index) => {
    if (widget.id && !byId.has(widget.id)) {
      byId.set(widget.id, index);
    }
  });
  const layouts: SlideLayoutInput[] = [];
  if (requested === undefined) {
    for (const layout of stored?.layouts ?? []) {
      const format = layout.format as ScreenFormat;
      if (format === primary) {
        continue;
      }
      const placements: CustomPlacement[] = layout.placements.flatMap(
        ({ widgetId, ...placement }) => {
          const index = byId.get(widgetId);
          return index === undefined ? [] : [{ ...placement, id: key(index) }];
        },
      );
      const completed = completeCustomLayout(
        { pages: layout.pages, placements },
        primaryLayout,
        format,
      );
      layouts.push(toInput(format, completed));
    }
    return ok(layouts);
  }
  const formats = new Set<ScreenFormat>();
  for (const layout of requested) {
    const format = layout.format;
    if (format === primary) {
      return fail(400, "layout_primary_format");
    }
    if (formats.has(format)) {
      return fail(400, "layout_duplicate_format");
    }
    formats.add(format);
    // Widgets the slide does not have keep their (unmatched) id, so the
    // domain reports them as unknown, like a deleted widget.
    const placements: CustomPlacement[] = layout.placements.map(
      ({ widgetId, ...placement }) => {
        const index = byId.get(widgetId);
        return {
          ...placement,
          hidden: placement.hidden ?? false,
          autoPlaced: placement.autoPlaced ?? false,
          id: index === undefined ? widgetId : key(index),
        };
      },
    );
    const custom: CustomLayout = { pages: layout.pages, placements };
    const problem = validateCustomLayout(custom, all, format).find(
      ({ code }) => !TOLERATED_PROBLEMS.has(code),
    );
    if (problem) {
      return fail(400, `layout_${problem.code}`);
    }
    layouts.push(
      toInput(format, completeCustomLayout(custom, primaryLayout, format)),
    );
  }
  return ok(layouts);
}

/**
 * Re-bases slides on another primary format (ADR 0017 section 4): the
 * chosen format's layout (custom, else auto) becomes the widgets'
 * placements and the old primary becomes a custom layout of its format.
 * Lossless, so refused when the chosen layout has continuation pages (409
 * format_has_overflow) or hides widgets (409 format_has_hidden_widgets).
 */
export function rebaseSlides(
  slides: readonly SlideInput[],
  from: ScreenFormat,
  to: ScreenFormat,
): Result<SlideInput[]> {
  const rebased: SlideInput[] = [];
  for (const slide of slides) {
    const layouts = slide.layouts ?? [];
    const custom = layouts.find((layout) => layout.format === to);
    let placements: Array<{
      widget: number;
      x: number;
      y: number;
      w: number;
      h: number;
    }>;
    if (custom) {
      if (custom.pages > 1) {
        return fail(409, "format_has_overflow");
      }
      if (custom.placements.some((placement) => placement.hidden)) {
        return fail(409, "format_has_hidden_widgets");
      }
      placements = custom.placements;
    } else {
      const pages = reflowSlide(layoutWidgets(slide.widgets), from, to);
      if (pages.length > 1) {
        return fail(409, "format_has_overflow");
      }
      placements = (pages[0] ?? []).map(({ id, ...placement }) => ({
        ...placement,
        widget: indexOf(id),
      }));
    }
    const at = new Map(
      placements.map((placement) => [placement.widget, placement]),
    );
    const old: SlideLayoutInput = {
      format: from,
      pages: 1,
      placements: slide.widgets.map((widget, index) => ({
        widget: index,
        page: 0,
        x: widget.x,
        y: widget.y,
        w: widget.w,
        h: widget.h,
        hidden: false,
        autoPlaced: false,
      })),
    };
    rebased.push({
      ...slide,
      widgets: slide.widgets.map((widget, index) => {
        const placement = at.get(index)!;
        return {
          ...widget,
          x: placement.x,
          y: placement.y,
          w: placement.w,
          h: placement.h,
        };
      }),
      // An empty slide is the same in every format: no layout to keep.
      layouts: [
        ...layouts.filter((layout) => layout.format !== to),
        ...(slide.widgets.length > 0 ? [old] : []),
      ],
    });
  }
  return ok(rebased);
}

/** Stored layouts as a new dashboard's input (duplicate). */
export function copyLayouts(slide: DashboardSlide): SlideLayoutInput[] {
  const index = new Map(slide.widgets.map((widget, i) => [widget.id, i]));
  return slide.layouts.map((layout) => ({
    format: layout.format,
    pages: layout.pages,
    placements: layout.placements.flatMap(({ widgetId, ...placement }) => {
      const widget = index.get(widgetId);
      return widget === undefined ? [] : [{ ...placement, widget }];
    }),
  }));
}
