import type { SlideLayout } from "@netrics/contracts";
import {
  CUSTOM_LAYOUT_MAX_PAGES,
  completeCustomLayout,
  placementsOverlap,
  reflowSlide,
  type CustomLayout,
  type CustomPlacement,
  type ScreenFormat,
  type StudioPlacement,
  type WidgetType,
} from "@netrics/domain";

import {
  completedLayout,
  layoutWidgets,
  type ScreenWidget,
} from "./screen-view";
import {
  nearestFreePlacement,
  nudgePlacement,
  placementBlocker,
  resizePlacement,
  samePlacement,
  type PlacementBlocker,
} from "./studio-grid";

// Custom layouts in the Studio (ADR 0017 section 4, #284): a slide's
// hand-arranged layout in a format other than the primary, edited as the
// draft's `layouts` and saved with the document. Every edit starts from the
// stored layout completed against the draft's widgets (as the server does
// on save), so widgets added to the primary since are placed and flagged
// first. Pure, so the reducer and its tests need no browser.

/** What the layout functions need of a slide. */
export interface LayoutSlide {
  widgets: readonly ScreenWidget[];
  /** Custom layouts; missing: none known (every format auto). */
  layouts?: readonly SlideLayout[];
}

/** The slide's stored custom layout in `format`, if any. */
export function storedLayout(
  slide: LayoutSlide,
  format: ScreenFormat,
): SlideLayout | undefined {
  return slide.layouts?.find((layout) => layout.format === format);
}

/** True when the slide is arranged by hand in `format` (never the primary). */
export function hasCustomLayout(
  slide: LayoutSlide,
  primaryFormat: ScreenFormat,
  format: ScreenFormat,
): boolean {
  return format !== primaryFormat && storedLayout(slide, format) !== undefined;
}

/**
 * The slide's custom layout in `format`, completed against its widgets in
 * the primary (new widgets placed and flagged, deleted ones gone); null in
 * the primary or when the format is automatic.
 */
export function customLayoutOf(
  slide: LayoutSlide,
  primaryFormat: ScreenFormat,
  format: ScreenFormat,
): CustomLayout | null {
  return completedLayout(layoutWidgets(slide.widgets), {
    primaryFormat,
    format,
    layouts: slide.layouts ?? null,
  });
}

/**
 * "Customize": the format's current automatic layout as a custom layout,
 * with nothing flagged. Continuation pages become pages; beyond the eighth
 * the rest is placed (or hidden) as the sync rules place a new widget.
 */
export function autoAsCustom(
  slide: LayoutSlide,
  primaryFormat: ScreenFormat,
  format: ScreenFormat,
): CustomLayout {
  const widgets = layoutWidgets(slide.widgets);
  const pages = reflowSlide(widgets, primaryFormat, format).slice(
    0,
    CUSTOM_LAYOUT_MAX_PAGES,
  );
  return completeCustomLayout(
    {
      pages: Math.max(1, pages.length),
      placements: pages.flatMap((page, index) =>
        page.map((placement) => ({
          ...placement,
          page: index,
          hidden: false,
          autoPlaced: false,
        })),
      ),
    },
    { format: primaryFormat, widgets },
    format,
  );
}

/** A custom layout as the dashboard document carries it. */
export function toSlideLayout(
  format: ScreenFormat,
  custom: CustomLayout,
): SlideLayout {
  return {
    format,
    pages: custom.pages,
    placements: custom.placements.map(({ id, ...placement }) => ({
      widgetId: id,
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

/** The slide's layouts with `format` set to `custom`, or removed (null). */
export function withLayout(
  layouts: readonly SlideLayout[] | undefined,
  format: ScreenFormat,
  custom: CustomLayout | null,
): SlideLayout[] {
  const others = (layouts ?? []).filter((layout) => layout.format !== format);
  return custom ? [...others, toSlideLayout(format, custom)] : others;
}

/**
 * The layouts a Save sends for a slide: each custom layout completed
 * against the draft's widgets, so the server accepts it as sent (a widget
 * whose type changed below its placement is re-placed and flagged). The
 * primary's own format is never sent.
 */
export function layoutsForSave(
  slide: LayoutSlide,
  primaryFormat: ScreenFormat,
): SlideLayout[] {
  return (slide.layouts ?? []).flatMap((layout) => {
    if (layout.format === primaryFormat) return [];
    const custom = customLayoutOf(slide, primaryFormat, layout.format);
    return custom ? [toSlideLayout(layout.format, custom)] : [];
  });
}

/** The layouts of a copied slide, its widgets renamed by `ids`. */
export function copyLayouts(
  layouts: readonly SlideLayout[] | undefined,
  ids: ReadonlyMap<string, string>,
): SlideLayout[] | undefined {
  return layouts?.map((layout) => ({
    ...layout,
    placements: layout.placements.flatMap((placement) => {
      const widgetId = ids.get(placement.widgetId);
      return widgetId ? [{ ...placement, widgetId }] : [];
    }),
  }));
}

/** The layouts without a deleted widget's placements. */
export function withoutWidget(
  layouts: readonly SlideLayout[] | undefined,
  widgetId: string,
): SlideLayout[] | undefined {
  return layouts?.map((layout) => ({
    ...layout,
    placements: layout.placements.filter(
      (placement) => placement.widgetId !== widgetId,
    ),
  }));
}

/** Visible placements on a page, in the layout's order. */
export function pagePlacements(
  custom: CustomLayout,
  page: number,
): CustomPlacement[] {
  return custom.placements.filter(
    (placement) => !placement.hidden && placement.page === page,
  );
}

/** Widgets hidden in the format. */
export function hiddenPlacements(custom: CustomLayout): CustomPlacement[] {
  return custom.placements.filter((placement) => placement.hidden);
}

/** Widgets placed automatically and not yet reviewed (visible ones). */
export function reviewPlacements(custom: CustomLayout): CustomPlacement[] {
  return custom.placements.filter(
    (placement) => placement.autoPlaced && !placement.hidden,
  );
}

// ---------------------------------------------------------------------------
// Edits. Each returns the new layout, or why it was refused.

export type LayoutEditError =
  | { kind: "unknown" }
  | { kind: "blocked"; blocker: PlacementBlocker; otherId: string | null }
  | { kind: "cannotMove" }
  | { kind: "minimumSize" }
  | { kind: "atEdge" }
  | { kind: "pageLimit" }
  | { kind: "lastPage" }
  | { kind: "pageNotEmpty" }
  | { kind: "noRoom" };

export type LayoutEdit =
  | { ok: true; layout: CustomLayout; placement: CustomPlacement | null }
  | { ok: false; error: LayoutEditError };

const refuse = (error: LayoutEditError): LayoutEdit => ({ ok: false, error });

function replacePlacement(
  custom: CustomLayout,
  next: CustomPlacement,
): CustomLayout {
  return {
    ...custom,
    placements: custom.placements.map((placement) =>
      placement.id === next.id ? next : placement,
    ),
  };
}

function othersOnPage(
  custom: CustomLayout,
  id: string,
  page: number,
): CustomPlacement[] {
  return pagePlacements(custom, page).filter((other) => other.id !== id);
}

export type LayoutMove =
  | { kind: "place"; placement: StudioPlacement }
  | { kind: "nudge"; dx: number; dy: number }
  | { kind: "resize"; dw: number; dh: number };

/**
 * A widget moved or resized in the format (a drag, the arrow keys): the
 * same rules as on the primary (inside the grid, minimum size, no overlap
 * on its page). Moving or resizing clears the review flag.
 */
export function moveInLayout(
  custom: CustomLayout,
  id: string,
  type: WidgetType,
  format: ScreenFormat,
  move: LayoutMove,
): LayoutEdit {
  const current = custom.placements.find((placement) => placement.id === id);
  if (!current || current.hidden) return refuse({ kind: "unknown" });
  const others = othersOnPage(custom, id, current.page);
  let target: StudioPlacement | null;
  if (move.kind === "nudge") {
    target = nudgePlacement(current, move.dx, move.dy, others, format);
    if (!target) return refuse({ kind: "cannotMove" });
  } else if (move.kind === "resize") {
    target = resizePlacement(current, move.dw, move.dh, type, format);
    if (!target) {
      return refuse({
        kind: move.dw < 0 || move.dh < 0 ? "minimumSize" : "atEdge",
      });
    }
  } else {
    const { x, y, w, h } = move.placement;
    target = { x, y, w, h };
  }
  if (samePlacement(current, target)) {
    return { ok: true, layout: custom, placement: current };
  }
  const blocker = placementBlocker(target, type, others, format);
  const sameSize = current.w === target.w && current.h === target.h;
  if (blocker && !(blocker.kind === "tooSmall" && sameSize)) {
    return refuse({
      kind: "blocked",
      blocker,
      otherId: blocker.kind === "overlap" ? others[blocker.index]!.id : null,
    });
  }
  const next: CustomPlacement = { ...current, ...target, autoPlaced: false };
  return { ok: true, layout: replacePlacement(custom, next), placement: next };
}

/** One more page, at the end (at most 8). */
export function addPage(custom: CustomLayout): LayoutEdit {
  if (custom.pages >= CUSTOM_LAYOUT_MAX_PAGES) {
    return refuse({ kind: "pageLimit" });
  }
  return {
    ok: true,
    layout: { ...custom, pages: custom.pages + 1 },
    placement: null,
  };
}

/**
 * A page removed: only an empty one (hidden widgets on it move to the
 * first page, still hidden), never the last remaining page. Later pages
 * move up.
 */
export function removePage(custom: CustomLayout, page: number): LayoutEdit {
  if (custom.pages <= 1) return refuse({ kind: "lastPage" });
  if (page < 0 || page >= custom.pages) return refuse({ kind: "unknown" });
  if (pagePlacements(custom, page).length > 0) {
    return refuse({ kind: "pageNotEmpty" });
  }
  return {
    ok: true,
    layout: {
      pages: custom.pages - 1,
      placements: custom.placements.map((placement) =>
        placement.page === page
          ? { ...placement, page: 0 }
          : placement.page > page
            ? { ...placement, page: placement.page - 1 }
            : placement,
      ),
    },
    placement: null,
  };
}

/**
 * Where a widget goes on `page`: its own cells when they are free, else the
 * nearest free spot at its size or its minimum; null without room.
 */
function spotOn(
  custom: CustomLayout,
  placement: CustomPlacement,
  type: WidgetType,
  format: ScreenFormat,
  page: number,
): StudioPlacement | null {
  const others = othersOnPage(custom, placement.id, page);
  if (!placementBlocker(placement, type, others, format)) {
    const { x, y, w, h } = placement;
    return { x, y, w, h };
  }
  return nearestFreePlacement(placement, type, others, format);
}

/** A widget moved to another page of the format, near where it was. */
export function moveToPage(
  custom: CustomLayout,
  id: string,
  type: WidgetType,
  format: ScreenFormat,
  page: number,
): LayoutEdit {
  const current = custom.placements.find((placement) => placement.id === id);
  if (!current || page < 0 || page >= custom.pages) {
    return refuse({ kind: "unknown" });
  }
  if (current.page === page && !current.hidden) {
    return { ok: true, layout: custom, placement: current };
  }
  const spot = spotOn(custom, current, type, format, page);
  if (!spot) return refuse({ kind: "noRoom" });
  const next: CustomPlacement = {
    ...current,
    ...spot,
    page,
    hidden: false,
    autoPlaced: false,
  };
  return { ok: true, layout: replacePlacement(custom, next), placement: next };
}

/**
 * Hidden in the format (its cells are kept for when it comes back), or
 * shown again: on its page where its cells are free, else the nearest free
 * spot there, else on another page with room. Either way it is reviewed.
 */
export function setHidden(
  custom: CustomLayout,
  id: string,
  type: WidgetType,
  format: ScreenFormat,
  hidden: boolean,
  preferredPage?: number,
): LayoutEdit {
  const current = custom.placements.find((placement) => placement.id === id);
  if (!current) return refuse({ kind: "unknown" });
  if (hidden) {
    const next = { ...current, hidden: true, autoPlaced: false };
    return {
      ok: true,
      layout: replacePlacement(custom, next),
      placement: next,
    };
  }
  if (!current.hidden) {
    return { ok: true, layout: custom, placement: current };
  }
  const first =
    preferredPage !== undefined &&
    preferredPage >= 0 &&
    preferredPage < custom.pages
      ? preferredPage
      : current.page;
  const pages = [
    first,
    ...Array.from({ length: custom.pages }, (_, page) => page).filter(
      (page) => page !== first,
    ),
  ];
  for (const page of pages) {
    const spot = spotOn(custom, current, type, format, page);
    if (spot) {
      const next: CustomPlacement = {
        ...current,
        ...spot,
        page,
        hidden: false,
        autoPlaced: false,
      };
      return {
        ok: true,
        layout: replacePlacement(custom, next),
        placement: next,
      };
    }
  }
  return refuse({ kind: "noRoom" });
}

/** "Looks good": the review flag of one widget (or of all) cleared. */
export function confirmPlacements(
  custom: CustomLayout,
  id: string | null,
): CustomLayout {
  return {
    ...custom,
    placements: custom.placements.map((placement) =>
      placement.autoPlaced && (id === null || placement.id === id)
        ? { ...placement, autoPlaced: false }
        : placement,
    ),
  };
}

// ---------------------------------------------------------------------------
// Changing the primary format (re-base, ADR 0017 section 4)

export type RebaseBlocker = "overflow" | "hidden";

/**
 * Why a format cannot become the primary, per slide: its layout there
 * (custom, else auto) continues on more pages, or hides widgets. The
 * server refuses the same (409 format_has_overflow,
 * format_has_hidden_widgets).
 */
export function rebaseBlockers(
  slides: ReadonlyArray<LayoutSlide & { id: string }>,
  primaryFormat: ScreenFormat,
  format: ScreenFormat,
): Array<{ slideId: string; reason: RebaseBlocker }> {
  if (format === primaryFormat) return [];
  return slides.flatMap(
    (
      slide,
    ): Array<{
      slideId: string;
      reason: RebaseBlocker;
    }> => {
      const custom = customLayoutOf(slide, primaryFormat, format);
      if (custom) {
        if (custom.pages > 1)
          return [{ slideId: slide.id, reason: "overflow" }];
        if (custom.placements.some((placement) => placement.hidden)) {
          return [{ slideId: slide.id, reason: "hidden" }];
        }
        return [];
      }
      const pages = reflowSlide(
        layoutWidgets(slide.widgets),
        primaryFormat,
        format,
      );
      return pages.length > 1
        ? [{ slideId: slide.id, reason: "overflow" }]
        : [];
    },
  );
}

/** True when two placements of a page overlap (for tests and checks). */
export function pageHasOverlap(custom: CustomLayout, page: number): boolean {
  const shown = pagePlacements(custom, page);
  return shown.some((a, i) =>
    shown.some((b, j) => j > i && placementsOverlap(a, b)),
  );
}
