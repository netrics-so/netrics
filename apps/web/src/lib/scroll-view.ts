import {
  fitTextSize,
  SCROLL_CHART_MIN_HEIGHT,
  labelParts,
  scrollLayout,
  wrappedLineCount,
  type LayoutWidget,
  type ScrollLayout,
} from "@netrics/domain";

import { fitValue, type FittedValue } from "./studio-render";

// The scroll view of a dashboard (ADR 0017, section 5): each enabled slide
// as a section, its widgets in the primary layout's reading order over 1–3
// columns (scrollLayout in @netrics/domain, shared with the later apps).
//
// Text uses the same unit as the slides, but tied to the browser's root
// size instead of the canvas: `--u` is 1rem / 32, so the TV minimums become
// the web's rem scale (24 units = 0.75rem, 32 = 1rem, 64 = 2rem) and follow
// the browser's text size and zoom.

/** Units per rem in scroll view (`--u: calc(1rem / 32)`). */
export const SCROLL_UNITS_PER_REM = 32;

/** Gap between cards, and the card padding, in CSS px. */
export const SCROLL_GAP = 12;
export const SCROLL_CARD_PADDING = 16;
/** A section's padding around its grid (room for its backdrop), in CSS px. */
export const SCROLL_SECTION_PADDING = 12;

/** Scroll view text sizes in units (÷ 32 = rem). */
export const SCROLL_TYPE = {
  /** The label's metric (title) and resource line. */
  title: 30,
  resource: 26,
  /** Period, notices, the source and axis labels. */
  small: 24,
  change: 26,
  /** A value shrinks from max to min, then goes compact. */
  valueMin: 48,
  valueMax: 72,
  clock: 64,
  date: 26,
  /** Text widget sizes by its size option. */
  text: { body: 32, heading: 44, display: 64 },
} as const;

/** One section of the scroll view: an enabled slide and its layout. */
export interface ScrollSection<S> {
  slide: S;
  /** The slide's position in the dashboard ("Slide 2" for a nameless one). */
  index: number;
  layout: ScrollLayout;
}

/**
 * The scroll view's sections for a view `width` CSS px wide: enabled slides
 * in order (disabled ones are skipped, as on screens), each with every
 * widget laid out by `scrollLayout`.
 */
export function scrollSections<
  S extends { enabled: boolean; widgets: readonly LayoutWidget[] },
>(slides: readonly S[], width: number): Array<ScrollSection<S>> {
  return slides.flatMap((slide, index) =>
    slide.enabled
      ? [{ slide, index, layout: scrollLayout(slide.widgets, width) }]
      : [],
  );
}

/**
 * Width in CSS px of an item spanning `span` of the layout's columns: the
 * content less the section's padding, shared by the columns and gaps.
 */
export function scrollItemWidth(
  layout: Pick<ScrollLayout, "columns" | "contentWidth">,
  span: number,
): number {
  const grid = layout.contentWidth - 2 * SCROLL_SECTION_PADDING;
  const column = (grid - SCROLL_GAP * (layout.columns - 1)) / layout.columns;
  return Math.max(0, column * span + SCROLL_GAP * (span - 1));
}

/** A card's inner width in units, for a card `width` px wide. */
export function cardUnits(width: number, rootPx: number): number {
  const inner = Math.max(0, width - 2 * SCROLL_CARD_PADDING - 2);
  return (inner * SCROLL_UNITS_PER_REM) / (rootPx > 0 ? rootPx : 16);
}

/**
 * A value in a card `units` wide: as large as fits between the scroll
 * bounds, then the compact form (12.3K) before it goes below the minimum.
 */
export function scrollValue(
  value: { full: string; compact: string },
  units: number,
): FittedValue {
  return fitValue(value.full, value.compact, units, {
    min: SCROLL_TYPE.valueMin,
    max: SCROLL_TYPE.valueMax,
  });
}

/**
 * Lines a data widget's label takes in a card `units` wide in scroll view.
 * The label always wraps in full (never truncated, no line limit); this
 * is what the browser is expected to need, for tests and checks.
 */
export function scrollLabelLines(
  label: string,
  units: number,
): { title: number; resource: number } {
  const parts = labelParts(label);
  return {
    title: wrappedLineCount(parts.title, units, SCROLL_TYPE.title, "semibold"),
    resource:
      parts.resource === null
        ? 0
        : wrappedLineCount(
            parts.resource,
            units,
            SCROLL_TYPE.resource,
            "semibold",
          ),
  };
}

/** A chart's height in CSS px: 16:9 of its width, at least 200 px. */
export function scrollChartHeight(width: number): number {
  return Math.max(SCROLL_CHART_MIN_HEIGHT, Math.round((width * 9) / 16));
}

/** The clock's size in units: as large as fits, at most `SCROLL_TYPE.clock`. */
export function scrollClockSize(time: string, units: number): number {
  // Widest digits, so the size does not change from minute to minute.
  const sample = time.replace(/\d/g, "0");
  return (
    fitTextSize(sample, units, {
      min: SCROLL_TYPE.valueMin,
      max: SCROLL_TYPE.clock,
      weight: "semibold",
    }) ?? SCROLL_TYPE.valueMin
  );
}
