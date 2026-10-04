import type { DashboardWidget } from "@netrics/contracts";
import {
  STUDIO_GRID,
  STUDIO_LABEL_MAX_LINES,
  isDataWidget,
  studioLayout,
  type StudioLabelFit,
} from "@netrics/domain";

import type { StudioDocument } from "./studio-document";

// Readability warnings on the Studio canvas (ADR 0015, section 8; #241): a
// data widget whose title or resource line would need more than two lines
// at 1080p, and so be cut off on the TVs. The rule is studioLayout's
// labelFit, the same one the tvOS app and the web renderers use, so the
// canvas warns exactly where screens truncate.

export interface UnreadableLabel {
  slideId: string;
  widgetId: string;
  label: string;
  fit: StudioLabelFit;
  /** The narrowest width (cells, at the same height) that fits, or null. */
  fitsAtWidth: number | null;
  /** What to do about it, for the badge and screen readers. */
  hint: string;
}

/**
 * The narrowest width from the widget's own up to the full grid at which
 * its label fits, or null when even a full-width widget truncates it.
 */
export function widthToFit(
  label: string,
  widget: Pick<DashboardWidget, "type" | "w" | "h">,
  fontScale: number,
): number | null {
  for (let w = widget.w; w <= STUDIO_GRID.columns; w++) {
    if (studioLayout.fits(label, { ...widget, w }, { fontScale })) {
      return w;
    }
  }
  return null;
}

function hintFor(
  fit: StudioLabelFit,
  fitsAtWidth: number | null,
  hasCustomTitle: boolean,
): string {
  const which =
    fit.titleLines > STUDIO_LABEL_MAX_LINES ? "The title" : "The resource name";
  const cut = `${which} is cut off on TVs.`;
  const wider =
    fitsAtWidth !== null ? `make it ${fitsAtWidth} cells wide` : null;
  const shorter =
    fit.titleLines > STUDIO_LABEL_MAX_LINES
      ? hasCustomTitle
        ? "shorten the title"
        : "set a shorter title"
      : null;
  const fixes = [wider, shorter].filter(Boolean).join(" or ");
  return fixes
    ? `${cut} ${fixes[0]!.toUpperCase()}${fixes.slice(1)}.`
    : `${cut} Show fewer resources in it.`;
}

/**
 * Every data widget in `document` whose label truncates at its size.
 * `labelOf` gives the label as the renderers show it ("Downloads · Wurfel");
 * `fontScale` is the theme's.
 */
export function unreadableLabels(
  document: StudioDocument,
  labelOf: (widget: DashboardWidget) => string,
  fontScale: number,
): UnreadableLabel[] {
  const found: UnreadableLabel[] = [];
  for (const slide of document.slides) {
    for (const widget of slide.widgets) {
      if (!isDataWidget(widget.type)) {
        continue;
      }
      const label = labelOf(widget);
      const fit = studioLayout.labelFit(label, widget, { fontScale });
      if (fit.fits) {
        continue;
      }
      const fitsAtWidth = widthToFit(label, widget, fontScale);
      found.push({
        slideId: slide.id,
        widgetId: widget.id,
        label,
        fit,
        fitsAtWidth,
        hint: hintFor(fit, fitsAtWidth, Boolean(widget.title?.trim())),
      });
    }
  }
  return found;
}

/** Unreadable labels per slide id, for the slide rail. */
export function unreadableCounts(
  labels: readonly UnreadableLabel[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const label of labels) {
    counts.set(label.slideId, (counts.get(label.slideId) ?? 0) + 1);
  }
  return counts;
}
