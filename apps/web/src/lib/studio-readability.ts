import type { DashboardWidget } from "@netrics/contracts";
import {
  STUDIO_GRID,
  STUDIO_LABEL_MAX_LINES,
  isDataWidget,
  studioLayout,
  type Locale,
  type StudioLabelFit,
} from "@netrics/domain";

import { webTranslator } from "./i18n/catalogs";
import type { StudioDocument } from "./studio-document";
import { textWidgetLayout } from "./studio-widgets";

// Readability warnings on the Studio canvas (ADR 0015, section 8; #241): a
// data widget whose title or resource line would need more than two lines
// at 1080p, and so be cut off on the TVs. The rule is studioLayout's
// labelFit, the same one the tvOS app and the web renderers use, so the
// canvas warns exactly where screens truncate.
//
// Text widgets too: text that does not fit its box even at body size is cut
// off at the bottom. That is textWidgetLayout's `overflow` (wrappedLineCount
// over the parsed blocks), the flag the web renderer sets as data-overflow
// and the tvOS TextLayout computes the same way.

export interface UnreadableLabel {
  /** A data widget's title or resource line, or a text widget's text. */
  kind: "label" | "text";
  slideId: string;
  widgetId: string;
  label: string;
  fit: StudioLabelFit;
  /** The narrowest width (cells, at the same height) that fits, or null. */
  fitsAtWidth: number | null;
  /** Text widgets: the smallest size (cells) that fits, or null. */
  fitsAtSize?: { w: number; h: number } | null;
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
  locale: Locale,
): string {
  const t = webTranslator(locale, "studio.readability");
  const titleCut = fit.titleLines > STUDIO_LABEL_MAX_LINES;
  const cut = titleCut ? t("titleCut") : t("resourceCut");
  const title = !titleCut ? "none" : hasCustomTitle ? "shorten" : "set";
  const fix =
    fitsAtWidth !== null
      ? t("wider", { width: fitsAtWidth, title })
      : title !== "none"
        ? t("shorterTitle", { title })
        : t("fewerResources");
  return `${cut} ${fix}`;
}

/** Whether a text widget's text overflows its box (as screens render it). */
export function textOverflows(
  widget: { text: string; options: { size: "body" | "heading" | "display" } },
  size: { w: number; h: number },
  fontScale: number,
  showHeader: boolean,
): boolean {
  return textWidgetLayout({
    text: widget.text,
    size: widget.options.size,
    placement: { x: 0, y: 0, ...size },
    fontScale,
    showHeader,
  }).overflow;
}

/**
 * The smallest size, from the widget's own up to the full grid, at which
 * its text fits: fewest cells, then the shorter one. Null when even the
 * whole slide is too small.
 */
export function textSizeToFit(
  widget: {
    text: string;
    options: { size: "body" | "heading" | "display" };
    w: number;
    h: number;
  },
  fontScale: number,
  showHeader: boolean,
): { w: number; h: number } | null {
  let best: { w: number; h: number } | null = null;
  for (let h = widget.h; h <= STUDIO_GRID.rows; h++) {
    for (let w = widget.w; w <= STUDIO_GRID.columns; w++) {
      if (best && w * h > best.w * best.h) break;
      if (textOverflows(widget, { w, h }, fontScale, showHeader)) continue;
      if (!best || w * h < best.w * best.h) best = { w, h };
      break;
    }
  }
  return best;
}

function textHint(
  fitsAtSize: { w: number; h: number } | null,
  locale: Locale,
): string {
  const t = webTranslator(locale, "studio.readability");
  return fitsAtSize
    ? t("textCutResize", { w: fitsAtSize.w, h: fitsAtSize.h })
    : t("textCut");
}

/**
 * Every data widget in `document` whose label truncates at its size, and
 * every text widget whose text is cut off.
 * `labelOf` gives the label as the renderers show it ("Downloads · Wurfel");
 * `fontScale` is the theme's.
 */
export function unreadableLabels(
  document: StudioDocument,
  labelOf: (widget: DashboardWidget) => string,
  fontScale: number,
  locale: Locale,
): UnreadableLabel[] {
  const found: UnreadableLabel[] = [];
  for (const slide of document.slides) {
    for (const widget of slide.widgets) {
      if (widget.type === "text") {
        const showHeader = document.settings.showHeader;
        if (!textOverflows(widget, widget, fontScale, showHeader)) {
          continue;
        }
        const fitsAtSize = textSizeToFit(widget, fontScale, showHeader);
        found.push({
          kind: "text",
          slideId: slide.id,
          widgetId: widget.id,
          label: widget.text,
          fit: { fits: false, titleLines: 0, resourceLines: 0 },
          fitsAtWidth: null,
          fitsAtSize,
          hint: textHint(fitsAtSize, locale),
        });
        continue;
      }
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
        kind: "label",
        slideId: slide.id,
        widgetId: widget.id,
        label,
        fit,
        fitsAtWidth,
        hint: hintFor(fit, fitsAtWidth, Boolean(widget.title?.trim()), locale),
      });
    }
  }
  return found;
}

/** Cut-off labels and texts per slide id, for the slide rail. */
export function unreadableCounts(
  labels: readonly UnreadableLabel[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const label of labels) {
    counts.set(label.slideId, (counts.get(label.slideId) ?? 0) + 1);
  }
  return counts;
}
