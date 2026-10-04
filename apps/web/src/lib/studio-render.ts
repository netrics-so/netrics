import {
  STUDIO_LINE_HEIGHT,
  STUDIO_REFERENCE_CANVAS,
  STUDIO_SPACING,
  STUDIO_TEXT_MINIMUMS,
  fitTextSize,
  labelParts,
  widgetRect,
  widgetTypeScale,
  wrappedLineCount,
  type StudioFontWeight,
  type StudioPlacement,
  type StudioTypeScale,
  type StudioWidgetType,
} from "@netrics/domain";

// How the web renders a studio slide (ADR 0015, section 8). Every position
// and text size comes from studioLayout in @netrics/domain, computed in
// canvas units at the 1080p reference canvas, so web and tvOS place and
// size text the same way. The canvas turns units into pixels with one CSS
// variable (--u: canvas height / 1080), so 720p, 1080p and 4K read alike.

/** Line height of titles, labels and small text. */
export const LINE_HEIGHT = STUDIO_LINE_HEIGHT;
/** Line height of a value or the clock: tight, figures have no descenders. */
export const VALUE_LINE_HEIGHT = 1;
/** Space between the parts of a widget, in units. */
export const STACK_GAP = 8;

/** A length in canvas units as CSS. */
export function u(units: number): string {
  return `calc(var(--u) * ${round(units)})`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function percent(part: number, whole: number): string {
  return `${round((part / whole) * 100 * 1000) / 1000}%`;
}

/**
 * A widget's box on the canvas as percentages of the canvas: widgetRect at
 * the reference canvas, which scales linearly with any 16:9 canvas.
 */
export function widgetBoxStyle(
  placement: StudioPlacement,
  showHeader: boolean,
): { left: string; top: string; width: string; height: string } {
  const rect = widgetRect(placement, STUDIO_REFERENCE_CANVAS, showHeader);
  const { width, height } = STUDIO_REFERENCE_CANVAS;
  return {
    left: percent(rect.x, width),
    top: percent(rect.y, height),
    width: percent(rect.width, width),
    height: percent(rect.height, height),
  };
}

/**
 * A placement as a slide renders it. On a screen other than the classic
 * 16:9 canvas (ADR 0017) the canvas adds the widget's box in units, since
 * the format's grid and a stretched screen give it other proportions.
 */
export interface ScreenPlacement extends StudioPlacement {
  unitBox?: { width: number; height: number } | null;
}

/** A widget's content box in units: its rect less the widget padding. */
export function contentBox(
  placement: ScreenPlacement,
  showHeader: boolean,
): { width: number; height: number } {
  if (placement.unitBox) {
    return {
      width: placement.unitBox.width - 2 * STUDIO_SPACING.widgetPadding,
      height: placement.unitBox.height - 2 * STUDIO_SPACING.widgetPadding,
    };
  }
  const rect = widgetRect(placement, STUDIO_REFERENCE_CANVAS, showHeader);
  return {
    width: rect.width - 2 * STUDIO_SPACING.widgetPadding,
    height: rect.height - 2 * STUDIO_SPACING.widgetPadding,
  };
}

export interface FittedLabel {
  text: string;
  /** Font size in units. */
  size: number;
  /** Lines the text takes at that size (at most two). */
  lines: number;
  /**
   * The text needs more than two lines even at its minimum: the renderer
   * ends the second line with an ellipsis and keeps the full text in a
   * tooltip and the accessible name. The studio flags this case
   * (`studioLayout.fits`), so it is a last resort, never silent.
   */
  truncated: boolean;
}

/**
 * A title, resource name or bar label wrapped to at most two lines: at its
 * size when it fits, else shrunk step by step down to `floor`, and only then
 * truncated (ADR 0015, section 8).
 */
export function fitLabel(
  text: string,
  maxWidth: number,
  bounds: { size: number; floor: number; weight?: StudioFontWeight },
  maxLines = 2,
): FittedLabel {
  const weight = bounds.weight ?? "semibold";
  const floor = Math.min(bounds.floor, bounds.size);
  for (let size = bounds.size; size > floor; size -= 1) {
    const lines = wrappedLineCount(text, maxWidth, size, weight);
    if (lines <= maxLines) {
      return { text, size, lines, truncated: false };
    }
  }
  const lines = wrappedLineCount(text, maxWidth, floor, weight);
  return {
    text,
    size: floor,
    lines: Math.min(lines, maxLines),
    truncated: lines > maxLines,
  };
}

export interface WidgetLabelLayout {
  title: FittedLabel;
  resource: FittedLabel | null;
  /** Height of the label block in units. */
  height: number;
}

/**
 * A data widget's label ("Downloads · Wurfel") as a title and a resource
 * line, each at most two lines (semibold, at the type scale's sizes).
 */
export function labelLayout(
  label: string,
  width: number,
  sizes: StudioTypeScale,
): WidgetLabelLayout {
  const parts = labelParts(label);
  const title = fitLabel(parts.title, width, {
    size: sizes.title ?? STUDIO_TEXT_MINIMUMS.title,
    floor: STUDIO_TEXT_MINIMUMS.title,
  });
  const resource =
    parts.resource === null
      ? null
      : fitLabel(parts.resource, width, {
          size: sizes.resource ?? STUDIO_TEXT_MINIMUMS.resource,
          floor: STUDIO_TEXT_MINIMUMS.resource,
        });
  const height =
    title.lines * title.size * LINE_HEIGHT +
    (resource ? resource.lines * resource.size * LINE_HEIGHT : 0);
  return { title, resource, height };
}

export interface FittedValue {
  text: string;
  /** Font size in units. */
  size: number;
}

/**
 * A value at the largest size between its bounds that fits on one line,
 * switching to the compact form (12.3K) before going below the minimum.
 * Values are never truncated: when even the compact form does not fit at
 * the minimum it stays at the minimum and may overflow the padding.
 */
export function fitValue(
  full: string,
  compact: string,
  maxWidth: number,
  bounds: { min: number; max: number },
): FittedValue {
  const max = Math.max(bounds.min, bounds.max);
  const fullSize = fitTextSize(full, maxWidth, {
    min: bounds.min,
    max,
    weight: "semibold",
  });
  if (fullSize !== null) {
    return { text: full, size: fullSize };
  }
  const compactSize = fitTextSize(compact, maxWidth, {
    min: bounds.min,
    max,
    weight: "semibold",
  });
  return { text: compact, size: compactSize ?? bounds.min };
}

/** The type scale of a widget on a slide. */
export function typeScaleFor(
  type: StudioWidgetType,
  placement: StudioPlacement,
  fontScale: number,
  showHeader: boolean,
): StudioTypeScale {
  return widgetTypeScale(type, placement, { fontScale, showHeader });
}

/** Lines a secondary text takes in the widget at a size (at least one). */
function linesOf(text: string | null, width: number, size: number): number {
  return text ? Math.max(1, wrappedLineCount(text, width, size)) : 0;
}

export interface MetricWidgetLayout {
  label: WidgetLabelLayout;
  /** The period and aggregation line ("Last 7 days · Total"). */
  showPeriod: boolean;
  value: FittedValue;
  /**
   * The change line as shown: "▲ +8% vs previous 7 days" when it fits on
   * one line, else "▲ +8%"; null when it is off or there is no room.
   */
  changeText: string | null;
  /**
   * The comparison ("vs previous 30 days") on its own line under a short
   * change line, when it fits on one line at a readable size and there is
   * room; else null.
   */
  comparisonText: string | null;
  /** Sizes in units; `comparison` is the comparison line's. */
  sizes: { small: number; change: number; comparison: number };
  /** Height left for the sparkline in units; 0 hides it. */
  sparkline: number;
  /** The connection's name under the numbers (a notice always shows). */
  showSource: boolean;
}

/** Below this height in units a sparkline says nothing; it is left out. */
export const MIN_SPARKLINE_HEIGHT = 40;

/**
 * What a metric widget shows at its size. The label, the value and a status
 * notice always show. The rest is added by importance while there is room:
 * the change line, the period line, the comparison, the sparkline, then
 * the connection's name.
 *
 * The comparison stays whenever it fits at a readable size: on the change
 * line when the whole line fits on one line at the change size, else on a
 * line of its own under the change ("▼ −28%" / "vs previous 30 days") at
 * the change size or, narrower, the smallest readable size. Only when it
 * fits neither way, or the widget has no height left, does the change
 * show alone.
 */
export function metricWidgetLayout(input: {
  label: string;
  value: { full: string; compact: string };
  periodText: string;
  /**
   * The change with and without its comparison, and the comparison alone
   * (null when there is none to keep); null when the change is off.
   */
  change: { full: string; short: string; comparison: string | null } | null;
  /** A stale or failure notice, always shown. */
  noticeText: string | null;
  sourceText: string | null;
  placement: StudioPlacement;
  showHeader: boolean;
  fontScale: number;
  showSparkline: boolean;
}): MetricWidgetLayout {
  const box = contentBox(input.placement, input.showHeader);
  const sizes = typeScaleFor(
    "metric",
    input.placement,
    input.fontScale,
    input.showHeader,
  );
  const label = labelLayout(input.label, box.width, sizes);
  const small = sizes.any ?? STUDIO_TEXT_MINIMUMS.any;
  const change = sizes.change ?? STUDIO_TEXT_MINIMUMS.change;
  const height = (text: string | null, size: number) =>
    linesOf(text, box.width, size) * size * LINE_HEIGHT;
  const valueMin = sizes.valueMin ?? STUDIO_TEXT_MINIMUMS.value;
  const valueMax = sizes.valueMax ?? valueMin;

  // Always shown: label, value (at least its minimum), notice.
  let used =
    label.height +
    STACK_GAP +
    height(input.noticeText, small) +
    valueMin * VALUE_LINE_HEIGHT;
  const fits = (extra: number) => used + extra <= box.height;

  // One line: when the whole change would wrap, the comparison moves to a
  // line of its own below.
  const oneLine =
    input.change !== null && linesOf(input.change.full, box.width, change) <= 1;
  const changeText = input.change
    ? oneLine
      ? input.change.full
      : input.change.short
    : null;
  const changeHeight = changeText ? change * LINE_HEIGHT : 0;
  const showChange = changeText !== null && fits(changeHeight);
  if (showChange) used += changeHeight;

  const period = height(input.periodText, small);
  const showPeriod = fits(period);
  if (showPeriod) used += period;

  const comparison =
    showChange && !oneLine ? (input.change?.comparison ?? null) : null;
  const comparisonSize = comparison
    ? ([change, small].find(
        (size) => wrappedLineCount(comparison, box.width, size) <= 1,
      ) ?? null)
    : null;
  let showComparison = false;
  if (comparisonSize !== null && fits(comparisonSize * LINE_HEIGHT)) {
    showComparison = true;
    used += comparisonSize * LINE_HEIGHT;
  }

  // A sparkline of at least the minimum height, with the name under it.
  const source = input.noticeText ? 0 : height(input.sourceText, small);
  const sparkMin = STACK_GAP + MIN_SPARKLINE_HEIGHT;
  let showSparkline = false;
  let showSource = false;
  if (input.showSparkline && fits(sparkMin + source)) {
    showSparkline = true;
    showSource = source > 0;
    used += sparkMin + source;
  } else if (input.showSparkline && fits(sparkMin)) {
    showSparkline = true;
    used += sparkMin;
  } else if (source > 0 && fits(source)) {
    showSource = true;
    used += source;
  }

  // The value grows into what is left, up to its maximum; the sparkline
  // takes the rest.
  const extra = Math.max(0, box.height - used);
  const value = fitValue(input.value.full, input.value.compact, box.width, {
    min: valueMin,
    max: Math.min(valueMax, valueMin + extra / VALUE_LINE_HEIGHT),
  });
  used += (value.size - valueMin) * VALUE_LINE_HEIGHT;
  const sparkline = showSparkline
    ? MIN_SPARKLINE_HEIGHT + Math.max(0, box.height - used)
    : 0;

  return {
    label,
    showPeriod,
    value,
    changeText: showChange ? changeText : null,
    comparisonText: showComparison ? comparison : null,
    sizes: { small, change, comparison: comparisonSize ?? change },
    sparkline,
    showSource,
  };
}

export interface ChartWidgetLayout {
  label: WidgetLabelLayout;
  /** The headline value of a line widget; null for a bar widget. */
  value: FittedValue | null;
  /** Sizes in units. */
  sizes: { small: number; axis: number; resource: number };
  /** Height of the chart (or the bars) in units, and its width. */
  chart: { width: number; height: number };
}

/**
 * A line or bar widget: the label, a line widget's value (between its
 * bounds), a status notice, and the chart in the rest of the widget.
 */
export function chartWidgetLayout(input: {
  type: "line" | "bar";
  label: string;
  value: { full: string; compact: string } | null;
  noticeText: string | null;
  placement: StudioPlacement;
  showHeader: boolean;
  fontScale: number;
}): ChartWidgetLayout {
  const box = contentBox(input.placement, input.showHeader);
  const sizes = typeScaleFor(
    input.type,
    input.placement,
    input.fontScale,
    input.showHeader,
  );
  const label = labelLayout(input.label, box.width, sizes);
  const small = sizes.any ?? STUDIO_TEXT_MINIMUMS.any;
  let used =
    label.height +
    STACK_GAP +
    linesOf(input.noticeText, box.width, small) * small * LINE_HEIGHT;
  let value: FittedValue | null = null;
  if (input.value) {
    const valueMin = sizes.valueMin ?? STUDIO_TEXT_MINIMUMS.value;
    value = fitValue(input.value.full, input.value.compact, box.width, {
      min: valueMin,
      max: sizes.valueMax ?? valueMin,
    });
    used += value.size * VALUE_LINE_HEIGHT + STACK_GAP;
  }
  return {
    label,
    value,
    sizes: {
      small,
      axis: sizes.axis ?? STUDIO_TEXT_MINIMUMS.axis,
      resource: sizes.resource ?? STUDIO_TEXT_MINIMUMS.resource,
    },
    chart: { width: box.width, height: Math.max(0, box.height - used) },
  };
}
