/**
 * Layout and readability rules for Dashboard Studio slides (ADR 0015,
 * section 8): where widgets go on a canvas, how large their text is, whether
 * a label fits, the automatic layout for migrated tiles, the text widget's
 * markdown-lite and the compact number form.
 *
 * Written once here and ported to Swift (apps/netrics-tv/NetricsKit,
 * StudioLayout.swift). Both test suites run the same vectors
 * (packages/domain/test-vectors/studio-layout.json), so keep every function
 * pure and its arithmetic in the same order on both sides.
 *
 * Sizes are in canvas units: u = canvas height / 1080, so 1080p and 4K read
 * the same. Functions that take a canvas answer in canvas pixels; the type
 * scale answers in units (multiply by `canvasUnit`).
 */

export type StudioWidgetType =
  | "metric"
  | "line"
  | "bar"
  | "image"
  | "text"
  | "clock"
  | "table"
  | "status"
  | "compare"
  | "countdown"
  | "gauge"
  | "review"
  | "measure";

export const STUDIO_WIDGET_TYPES: readonly StudioWidgetType[] = [
  "metric",
  "line",
  "bar",
  "image",
  "text",
  "clock",
  "table",
  "status",
  "compare",
  "countdown",
  "gauge",
  "review",
  "measure",
];

/** A widget's cells: 0-based column and row, width and height in cells. */
export interface StudioPlacement {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StudioCanvas {
  width: number;
  height: number;
}

export interface StudioRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Every slide: a 16:9 canvas with 12 columns × 8 rows. */
export const STUDIO_GRID = { columns: 12, rows: 8 } as const;

/** The canvas the units are defined on, and `fits` measures at. */
export const STUDIO_REFERENCE_CANVAS: StudioCanvas = {
  width: 1920,
  height: 1080,
};

/** The dashboard header's band, as a share of the canvas height. */
export const STUDIO_HEADER_BAND = 0.07;

/**
 * Spacing in canvas units: around the grid, between cells, and inside a
 * widget (its text never comes closer to the widget's edge).
 */
export const STUDIO_SPACING = {
  padding: 32,
  gap: 16,
  widgetPadding: 24,
} as const;

/** The smallest widget per type, chosen so the minimum text sizes fit. */
export const STUDIO_MIN_WIDGET_SIZE: Readonly<
  Record<StudioWidgetType, { w: number; h: number }>
> = {
  metric: { w: 3, h: 2 },
  line: { w: 4, h: 3 },
  bar: { w: 4, h: 3 },
  image: { w: 1, h: 1 },
  text: { w: 2, h: 1 },
  clock: { w: 2, h: 1 },
  table: { w: 4, h: 4 },
  status: { w: 3, h: 3 },
  // Two five-character operands at 48 u and the separator (ADR 0019 §10).
  compare: { w: 4, h: 3 },
  countdown: { w: 3, h: 2 },
  gauge: { w: 3, h: 3 },
  review: { w: 4, h: 3 },
  measure: { w: 4, h: 3 },
};

/** Widgets with a title and resource line (bound to a metric). */
export function isDataWidget(type: StudioWidgetType): boolean {
  return (
    type === "metric" ||
    type === "line" ||
    type === "bar" ||
    type === "table" ||
    type === "compare"
  );
}

/**
 * Widgets that show a label (a title, and a resource line for metric-bound
 * types), which `labelFit` checks (ADR 0019 section 2). Every new type with
 * a label joins here; image, text and clock have none.
 */
export function hasWidgetLabel(type: StudioWidgetType): boolean {
  return type !== "image" && type !== "text" && type !== "clock";
}

// ---------------------------------------------------------------------------
// Grid → rect

export function canvasUnit(canvas: StudioCanvas): number {
  return canvas.height / STUDIO_REFERENCE_CANVAS.height;
}

export interface StudioFrame {
  /** Canvas pixels per unit. */
  unit: number;
  /** The header band, null without the header. */
  header: StudioRect | null;
  /** The area the 12 × 8 cells and their gaps fill. */
  grid: StudioRect;
}

/**
 * The header band (7 % of the height, when shown) and the grid area below
 * it, inset by the padding on every side.
 */
export function studioFrame(
  canvas: StudioCanvas,
  showHeader: boolean,
): StudioFrame {
  const unit = canvasUnit(canvas);
  const headerHeight = showHeader ? canvas.height * STUDIO_HEADER_BAND : 0;
  const padding = STUDIO_SPACING.padding * unit;
  return {
    unit,
    header: showHeader
      ? { x: 0, y: 0, width: canvas.width, height: headerHeight }
      : null,
    grid: {
      x: padding,
      y: headerHeight + padding,
      width: canvas.width - 2 * padding,
      height: canvas.height - headerHeight - 2 * padding,
    },
  };
}

/** A widget's rect in canvas pixels. */
export function widgetRect(
  placement: StudioPlacement,
  canvas: StudioCanvas,
  showHeader: boolean,
): StudioRect {
  const { unit, grid } = studioFrame(canvas, showHeader);
  const gap = STUDIO_SPACING.gap * unit;
  const cellWidth =
    (grid.width - gap * (STUDIO_GRID.columns - 1)) / STUDIO_GRID.columns;
  const cellHeight =
    (grid.height - gap * (STUDIO_GRID.rows - 1)) / STUDIO_GRID.rows;
  return {
    x: grid.x + placement.x * (cellWidth + gap),
    y: grid.y + placement.y * (cellHeight + gap),
    width: placement.w * cellWidth + (placement.w - 1) * gap,
    height: placement.h * cellHeight + (placement.h - 1) * gap,
  };
}

// ---------------------------------------------------------------------------
// Screen formats (ADR 0017, sections 1 and 2)

/** The five format classes; `16x9` is the default primary format. */
export type ScreenFormat = "16x9" | "21x9" | "4x3" | "3x4" | "9x16";

/** Every format key, widest first. */
export const SCREEN_FORMAT_KEYS: readonly ScreenFormat[] = [
  "21x9",
  "16x9",
  "4x3",
  "3x4",
  "9x16",
];

export interface ScreenFormatSpec {
  key: ScreenFormat;
  /** Grid columns and rows. */
  columns: number;
  rows: number;
  /** The canvas units are defined on (its short edge is always 1080). */
  reference: StudioCanvas;
}

/**
 * Grid and reference canvas per format. A cell is about the same size in
 * units everywhere, so minimum widget sizes and row heights carry over;
 * `16x9` is exactly `STUDIO_GRID` and `STUDIO_REFERENCE_CANVAS`.
 */
export const SCREEN_FORMATS: Readonly<Record<ScreenFormat, ScreenFormatSpec>> =
  {
    "16x9": {
      key: "16x9",
      columns: STUDIO_GRID.columns,
      rows: STUDIO_GRID.rows,
      reference: STUDIO_REFERENCE_CANVAS,
    },
    "21x9": {
      key: "21x9",
      columns: 16,
      rows: 8,
      reference: { width: 2520, height: 1080 },
    },
    "4x3": {
      key: "4x3",
      columns: 9,
      rows: 8,
      reference: { width: 1440, height: 1080 },
    },
    "3x4": {
      key: "3x4",
      columns: 6,
      rows: 10,
      reference: { width: 1080, height: 1440 },
    },
    "9x16": {
      key: "9x16",
      columns: 6,
      rows: 14,
      reference: { width: 1080, height: 1920 },
    },
  };

/** The largest grid of any format (database checks use it). */
export const SCREEN_FORMAT_MAX_GRID = { columns: 16, rows: 14 } as const;

export function isScreenFormat(value: unknown): value is ScreenFormat {
  return (
    typeof value === "string" &&
    (SCREEN_FORMAT_KEYS as readonly string[]).includes(value)
  );
}

/**
 * The format of a screen of this size (CSS pixels or points, after any
 * rotation): the closest aspect ratio on a log scale. Boundaries are the
 * geometric means of neighbours, rounded: 2.04, 1.54, 1.00 and 0.65. An
 * unusable size (zero, negative, not finite) is `16x9`.
 */
export function formatFor(width: number, height: number): ScreenFormat {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return "16x9";
  }
  const aspect = width / height;
  if (aspect >= 2.04) return "21x9";
  if (aspect >= 1.54) return "16x9";
  if (aspect >= 1) return "4x3";
  if (aspect >= 0.65) return "3x4";
  return "9x16";
}

export type ScreenSizeClass = "compact" | "regular" | "large";

/**
 * Size class by the short edge: compact below 600 (phones), regular below
 * 1100 (tablets, small windows), else large (desktops, TVs). It picks the
 * default display mode and the scroll view columns, never a screen view
 * layout.
 */
export function sizeClassFor(width: number, height: number): ScreenSizeClass {
  const short = Math.min(width, height);
  if (!(short >= 600)) return "compact";
  if (short < 1100) return "regular";
  return "large";
}

/** A grid stretches at most this much against its format's aspect ratio. */
export const SCREEN_MAX_STRETCH = 4 / 3;

export interface ScreenFrame {
  format: ScreenFormat;
  columns: number;
  rows: number;
  /** Screen pixels per unit: min(width / refWidth, height / refHeight). */
  unit: number;
  /**
   * The area the slide fills: the whole screen, or the stretch-capped
   * canvas centred on it (letterboxed in the theme's background colour).
   */
  canvas: StudioRect;
  /** The header band (0.07 × 1080 units high), null without the header. */
  header: StudioRect | null;
  /** The area the cells and their gaps fill. */
  grid: StudioRect;
}

/**
 * Where a format's grid goes on a real screen in screen view: the grid
 * fills the screen (inset by the padding, below the header band), so cells
 * stretch in the screen's longer direction, at most by 4/3; beyond that the
 * capped canvas is centred. At a 16:9 screen and `16x9` this is exactly
 * `studioFrame`.
 */
export function screenFrame(
  screen: StudioCanvas,
  format: ScreenFormat,
  showHeader: boolean,
): ScreenFrame {
  const spec = SCREEN_FORMATS[format];
  const reference = STUDIO_REFERENCE_CANVAS.height;
  // The unit's length on the screen, computed so that a screen of the
  // format's exact aspect gives its short edge without rounding error.
  const unitLength = Math.min(
    (screen.width * reference) / spec.reference.width,
    (screen.height * reference) / spec.reference.height,
  );
  const unit = unitLength / reference;
  const width = Math.min(
    screen.width,
    spec.reference.width * unit * SCREEN_MAX_STRETCH,
  );
  const height = Math.min(
    screen.height,
    spec.reference.height * unit * SCREEN_MAX_STRETCH,
  );
  const x = (screen.width - width) / 2;
  const y = (screen.height - height) / 2;
  const headerHeight = showHeader ? unitLength * STUDIO_HEADER_BAND : 0;
  const padding = STUDIO_SPACING.padding * unit;
  return {
    format,
    columns: spec.columns,
    rows: spec.rows,
    unit,
    canvas: { x, y, width, height },
    header: showHeader ? { x, y, width, height: headerHeight } : null,
    grid: {
      x: x + padding,
      y: y + headerHeight + padding,
      width: width - 2 * padding,
      height: height - headerHeight - 2 * padding,
    },
  };
}

/** A placement's rect in screen pixels, on a frame from `screenFrame`. */
export function placementRect(
  placement: StudioPlacement,
  frame: ScreenFrame,
): StudioRect {
  const { unit, grid, columns, rows } = frame;
  const gap = STUDIO_SPACING.gap * unit;
  const cellWidth = (grid.width - gap * (columns - 1)) / columns;
  const cellHeight = (grid.height - gap * (rows - 1)) / rows;
  return {
    x: grid.x + placement.x * (cellWidth + gap),
    y: grid.y + placement.y * (cellHeight + gap),
    width: placement.w * cellWidth + (placement.w - 1) * gap,
    height: placement.h * cellHeight + (placement.h - 1) * gap,
  };
}

/** Whole cells, at least 1 × 1, inside the format's grid. */
export function isInsideFormatGrid(
  placement: StudioPlacement,
  format: ScreenFormat,
): boolean {
  const { x, y, w, h } = placement;
  const spec = SCREEN_FORMATS[format];
  return (
    [x, y, w, h].every(Number.isInteger) &&
    x >= 0 &&
    y >= 0 &&
    w >= 1 &&
    h >= 1 &&
    x + w <= spec.columns &&
    y + h <= spec.rows
  );
}

// ---------------------------------------------------------------------------
// Placement rules

/** Whole cells, at least 1 × 1, inside the 12 × 8 grid. */
export function isInsideGrid(placement: StudioPlacement): boolean {
  const { x, y, w, h } = placement;
  return (
    [x, y, w, h].every(Number.isInteger) &&
    x >= 0 &&
    y >= 0 &&
    w >= 1 &&
    h >= 1 &&
    x + w <= STUDIO_GRID.columns &&
    y + h <= STUDIO_GRID.rows
  );
}

export function meetsMinimumSize(
  type: StudioWidgetType,
  placement: StudioPlacement,
): boolean {
  const minimum = STUDIO_MIN_WIDGET_SIZE[type];
  return placement.w >= minimum.w && placement.h >= minimum.h;
}

export function placementsOverlap(
  a: StudioPlacement,
  b: StudioPlacement,
): boolean {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  );
}

/** Index pairs [i, j] (i < j) of placements that overlap, in order. */
export function findOverlaps(
  placements: readonly StudioPlacement[],
): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      if (placementsOverlap(placements[i]!, placements[j]!)) {
        pairs.push([i, j]);
      }
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Type scale

/** Minimum text sizes in units (at u = 1), before the theme's fontScale. */
export const STUDIO_TEXT_MINIMUMS = {
  any: 24,
  title: 30,
  resource: 30,
  change: 28,
  axis: 24,
  body: 32,
  heading: 56,
  display: 96,
  value: 64,
  clock: 56,
  /** The clock's zone line (ADR 0019, section 9). */
  zone: 24,
  /** Table rows (ADR 0019 section 13). */
  cell: 28,
  /** Table column heads, in caps. */
  columnHead: 24,
  /** A compare widget's two numbers (ADR 0019 section 10). */
  operand: 48,
  /** A review's title and body (ADR 0019 section 12). */
  review: 32,
  /** A review's five stars. */
  stars: 28,
} as const;

/** The theme font scales (ADR 0015, section 6). */
export const STUDIO_FONT_SCALES = [1, 1.15, 1.3] as const;

/** A fontScale never lowers a minimum: anything below 1 (or not a number) is 1. */
export function effectiveFontScale(fontScale: number | undefined): number {
  return fontScale !== undefined && Number.isFinite(fontScale) && fontScale > 1
    ? fontScale
    : 1;
}

/**
 * Text roles of a widget, in units. `valueMin`/`valueMax` bound a data
 * widget's value (renderers fit it between them, then switch to the compact
 * form, see `fitTextSize`); `clockMin`/`clockMax` the clock's time,
 * `date` its date and `zone` its zone line.
 */
export type StudioTextRole =
  | "any"
  | "title"
  | "resource"
  | "change"
  | "axis"
  | "body"
  | "heading"
  | "display"
  | "valueMin"
  | "valueMax"
  | "clockMin"
  | "clockMax"
  | "date"
  | "zone"
  | "cell"
  | "columnHead"
  | "operand"
  | "review"
  | "stars";

export type StudioTypeScale = Partial<Record<StudioTextRole, number>>;

/** Share of a widget's content height the value may take at most. */
const VALUE_HEIGHT_SHARE: Readonly<Record<"metric" | "line" | "bar", number>> =
  {
    metric: 0.36,
    line: 0.2,
    bar: 0.2,
  };
const CLOCK_HEIGHT_SHARE = 0.6;
/** Share of a compare widget's content height its ratio may take at most. */
const COMPARE_VALUE_HEIGHT_SHARE = 0.3;
/** Share of a countdown's content height its numbers may take at most. */
const COUNTDOWN_HEIGHT_SHARE = 0.6;

/** Content height of a widget in units: its height less the padding. */
function contentHeight(
  placement: StudioPlacement,
  showHeader: boolean,
): number {
  const rect = widgetRect(placement, STUDIO_REFERENCE_CANVAS, showHeader);
  return rect.height - 2 * STUDIO_SPACING.widgetPadding;
}

/**
 * The text sizes of a widget of this type and size, in units. Every size is
 * its minimum times the font scale; the value and the clock grow with the
 * widget's height, never below their minimum.
 */
export function widgetTypeScale(
  type: StudioWidgetType,
  placement: StudioPlacement,
  options: { fontScale?: number; showHeader?: boolean } = {},
): StudioTypeScale {
  const scale = effectiveFontScale(options.fontScale);
  const showHeader = options.showHeader ?? true;
  const m = STUDIO_TEXT_MINIMUMS;
  const any = m.any * scale;
  switch (type) {
    case "metric":
    case "line":
    case "bar": {
      const valueMin = m.value * scale;
      const valueMax = Math.max(
        valueMin,
        contentHeight(placement, showHeader) * VALUE_HEIGHT_SHARE[type],
      );
      const sizes: StudioTypeScale = {
        any,
        title: m.title * scale,
        resource: m.resource * scale,
      };
      if (type === "metric") {
        sizes.change = m.change * scale;
      } else {
        sizes.axis = m.axis * scale;
      }
      sizes.valueMin = valueMin;
      sizes.valueMax = valueMax;
      return sizes;
    }
    case "image":
      return { any };
    case "text":
      return {
        any,
        body: m.body * scale,
        heading: m.heading * scale,
        display: m.display * scale,
      };
    case "measure":
    case "table":
      return {
        any,
        title: m.title * scale,
        resource: m.resource * scale,
        columnHead: m.columnHead * scale,
        cell: m.cell * scale,
      };
    case "review":
      return {
        any,
        title: m.title * scale,
        resource: m.resource * scale,
        stars: m.stars * scale,
        review: m.review * scale,
      };
    case "status":
      return {
        any,
        title: m.title * scale,
        resource: m.resource * scale,
        cell: m.cell * scale,
      };
    case "compare": {
      // The ratio is the value (ADR 0019 section 10).
      const valueMin = m.value * scale;
      return {
        any,
        title: m.title * scale,
        resource: m.resource * scale,
        change: m.change * scale,
        operand: m.operand * scale,
        valueMin,
        valueMax: Math.max(
          valueMin,
          contentHeight(placement, showHeader) * COMPARE_VALUE_HEIGHT_SHARE,
        ),
      };
    }
    case "gauge":
      // The value sits inside the ring, which `gaugeLayout` sizes.
      return {
        any,
        title: m.title * scale,
        resource: m.resource * scale,
        change: m.change * scale,
        valueMin: m.value * scale,
        valueMax: Math.max(
          m.value * scale,
          contentHeight(placement, showHeader) * VALUE_HEIGHT_SHARE.metric,
        ),
      };
    case "countdown": {
      // ADR 0019 section 8: numbers in the value role, unit letters in the
      // change role, the text when reached at heading size.
      const valueMin = m.value * scale;
      return {
        any,
        title: m.title * scale,
        resource: m.resource * scale,
        change: m.change * scale,
        heading: m.heading * scale,
        valueMin,
        valueMax: Math.max(
          valueMin,
          contentHeight(placement, showHeader) * COUNTDOWN_HEIGHT_SHARE,
        ),
      };
    }
    case "clock": {
      const clockMin = m.clock * scale;
      return {
        any,
        clockMin,
        clockMax: Math.max(
          clockMin,
          contentHeight(placement, showHeader) * CLOCK_HEIGHT_SHARE,
        ),
        date: m.title * scale,
        zone: m.zone * scale,
      };
    }
  }
}

export type StudioTextSize = "body" | "heading" | "display";

/**
 * A text widget's sizes in units for its `size` option: paragraphs at the
 * option's size, `#` 1.5 times and `##` 1.25 times that, headings never
 * below the heading minimum (56) and 40.
 */
export function textWidgetSizes(
  size: StudioTextSize,
  fontScale?: number,
): { paragraph: number; heading1: number; heading2: number } {
  const scale = effectiveFontScale(fontScale);
  const paragraph = STUDIO_TEXT_MINIMUMS[size] * scale;
  return {
    paragraph,
    heading1: Math.max(paragraph * 1.5, STUDIO_TEXT_MINIMUMS.heading * scale),
    heading2: Math.max(paragraph * 1.25, 40 * scale),
  };
}

// ---------------------------------------------------------------------------
// Text measurement (conservative)

export type StudioFontWeight = "regular" | "semibold" | "bold";

const WEIGHT_FACTOR: Readonly<Record<StudioFontWeight, number>> = {
  regular: 1,
  semibold: 1.05,
  bold: 1.08,
};

const NARROW = new Set([..."iljI|!.,:;'`"]);
const SEMI_NARROW = new Set([..."ftr()[]{}/\\-"]);
const WIDE = new Set([..."MWmw@%&—"]);

/**
 * A glyph's advance in em, deliberately on the wide side of common UI sans
 * fonts (SF Pro, Inter, system-ui), so an estimate that fits also fits on
 * the screen. Unknown characters (non-Latin, emoji) count as a full em.
 */
export function glyphEm(char: string): number {
  if (char === " ") return 0.3;
  if (NARROW.has(char)) return 0.32;
  if (SEMI_NARROW.has(char)) return 0.42;
  if (WIDE.has(char)) return 0.95;
  if (char >= "A" && char <= "Z") return 0.72;
  if (char >= "0" && char <= "9") return 0.62;
  if (char >= "a" && char <= "z") return 0.6;
  const code = char.codePointAt(0)!;
  // Other printable ASCII (punctuation, symbols).
  if (code >= 0x21 && code <= 0x7e) return 0.6;
  return 1;
}

/** Estimated width of a single line of text, per Unicode code point. */
export function estimateTextWidth(
  text: string,
  fontSize: number,
  weight: StudioFontWeight = "regular",
): number {
  let em = 0;
  for (const char of text) {
    em += glyphEm(char);
  }
  return em * fontSize * WEIGHT_FACTOR[weight];
}

/**
 * How many lines the text takes when wrapped greedily at spaces into
 * `maxWidth`; a word longer than a line breaks between characters. 0 for
 * blank text.
 */
export function wrappedLineCount(
  text: string,
  maxWidth: number,
  fontSize: number,
  weight: StudioFontWeight = "regular",
  /** The width of a text; by default the conservative estimate. */
  widthOf: (
    text: string,
    fontSize: number,
    weight: StudioFontWeight,
  ) => number = estimateTextWidth,
): number {
  const words = text.split(" ").filter((word) => word !== "");
  const space = widthOf(" ", fontSize, weight);
  let lines = 0;
  let current = 0;
  let empty = true;
  for (const word of words) {
    const width = widthOf(word, fontSize, weight);
    if (!empty && current + space + width <= maxWidth) {
      current = current + space + width;
      continue;
    }
    if (!empty) {
      lines += 1;
      current = 0;
      empty = true;
    }
    if (width <= maxWidth) {
      current = width;
      empty = false;
      continue;
    }
    for (const char of word) {
      const charWidth = widthOf(char, fontSize, weight);
      if (!empty && current + charWidth > maxWidth) {
        lines += 1;
        current = 0;
      }
      current = current + charWidth;
      empty = false;
    }
  }
  if (!empty) {
    lines += 1;
  }
  return lines;
}

/**
 * The largest size from `max` down to `min` at which the text fits on one
 * line of `maxWidth`, or null when it does not fit even at `min` (then the
 * renderer switches a value to its compact form).
 */
export function fitTextSize(
  text: string,
  maxWidth: number,
  bounds: { min: number; max: number; weight?: StudioFontWeight },
): number | null {
  const widthAtOne = estimateTextWidth(text, 1, bounds.weight ?? "regular");
  const size =
    widthAtOne > 0 ? Math.min(bounds.max, maxWidth / widthAtOne) : bounds.max;
  return size >= bounds.min ? size : null;
}

// ---------------------------------------------------------------------------
// Label fit

/** Lines a title or the resource line may take before it would truncate. */
export const STUDIO_LABEL_MAX_LINES = 2;

/**
 * A label split into the metric and the resource it is about
 * ("Downloads · Wurfel" → "Downloads", "Wurfel"; `tileLabel` joins them with
 * " · "). A label without the separator, such as a custom title, is all
 * title.
 */
export function labelParts(label: string): {
  title: string;
  resource: string | null;
} {
  const at = label.indexOf(" · ");
  if (at < 0) return { title: label, resource: null };
  const title = label.slice(0, at).trim();
  const resource = label.slice(at + 3).trim();
  if (title === "" || resource === "") return { title: label, resource: null };
  return { title, resource };
}

export interface StudioLabelFit {
  fits: boolean;
  titleLines: number;
  resourceLines: number;
}

/**
 * How a data widget's label wraps at the format's reference canvas (1080p
 * at `16x9`, the default): the title and the resource line (both semibold,
 * at their minimum times the font scale) in the widget's width less its
 * padding. Widgets without a label always fit. A stretched screen only ever
 * gives a cell more room than the reference (ADR 0017, section 2).
 */
export function labelFit(
  label: string,
  widget: { type: StudioWidgetType; w: number; h: number },
  options: { fontScale?: number; format?: ScreenFormat } = {},
): StudioLabelFit {
  if (!hasWidgetLabel(widget.type)) {
    return { fits: true, titleLines: 0, resourceLines: 0 };
  }
  const scale = effectiveFontScale(options.fontScale);
  const format = options.format ?? "16x9";
  const rect = placementRect(
    { x: 0, y: 0, w: widget.w, h: widget.h },
    screenFrame(SCREEN_FORMATS[format].reference, format, true),
  );
  const width = rect.width - 2 * STUDIO_SPACING.widgetPadding;
  const parts = labelParts(label);
  const titleLines = wrappedLineCount(
    parts.title,
    width,
    STUDIO_TEXT_MINIMUMS.title * scale,
    "semibold",
  );
  const resourceLines =
    parts.resource === null
      ? 0
      : wrappedLineCount(
          parts.resource,
          width,
          STUDIO_TEXT_MINIMUMS.resource * scale,
          "semibold",
        );
  return {
    fits:
      titleLines <= STUDIO_LABEL_MAX_LINES &&
      resourceLines <= STUDIO_LABEL_MAX_LINES,
    titleLines,
    resourceLines,
  };
}

/** Whether the widget shows its label without truncating it. */
export function labelFits(
  label: string,
  widget: { type: StudioWidgetType; w: number; h: number },
  options: { fontScale?: number; format?: ScreenFormat } = {},
): boolean {
  return labelFit(label, widget, options).fits;
}

// ---------------------------------------------------------------------------
// Table (ADR 0019 section 6)

/** Line height of a table's text, as `STUDIO_LINE_HEIGHT`. */
const TABLE_LINE_HEIGHT = 1.15;

/** A table's spacing in units. */
export const TABLE_SPACING = {
  /** Between the label, the subtitle, the column heads and the footer. */
  stack: 8,
  /** Above every row: the row pitch is the cell line plus this. */
  rowGap: 12,
  /** Between the label, value and change columns. */
  columnGap: 16,
} as const;

/** The widest change the Δ column reserves room for. */
export const TABLE_CHANGE_SAMPLE = "+999 %";

/**
 * Below this share of the content width the label column is too narrow
 * for full values: the value column switches to the compact form.
 */
export const TABLE_MIN_LABEL_SHARE = 0.4;

export interface TableLayoutInput {
  /** The widget's label as screens show it ("Page views · netrics.so"). */
  label: string;
  /** The content box in units: the widget's rect less its padding. */
  width: number;
  height: number;
  fontScale?: number;
  /** The rows' values as shown, full and compact ("12,345", "12.3K"). */
  values?: ReadonlyArray<{ full: string; compact: string }>;
  /** The Δ column (`showChange`); default true. */
  showChange?: boolean;
}

export interface TableLayout {
  /** Text sizes in units; `cellMin` is what a row label shrinks to. */
  sizes: {
    title: number;
    resource: number;
    subtitle: number;
    columnHead: number;
    cell: number;
    cellMin: number;
  };
  /** Lines of the title (1–2) and of the resource line (0–2). */
  titleLines: number;
  resourceLines: number;
  /** Label, subtitle, column heads and their gaps, in units. */
  headHeight: number;
  /** The footer line and its gap, in units. */
  footerHeight: number;
  /** A row's line plus the gap above it, in units. */
  rowPitch: number;
  /** Rows that fit between the column heads and the footer. */
  rowCapacity: number;
  /** Column widths in units; `change` is 0 without the Δ column. */
  columns: { label: number; value: number; change: number; gap: number };
  /** The values are shown in their compact form. */
  compact: boolean;
}

/**
 * A table widget's layout: the label (title and resource line, at most two
 * lines each), the subtitle ("Top 5 · Last 30 days"), the column heads
 * (24 u, caps), the rows (cell role, 28 u, each a line plus a 12 u gap)
 * and the footer. `rowCapacity` is how many rows fit; a screen shows
 * `min(limit, rows, rowCapacity)`. The value column is as wide as the
 * widest value (the compact forms when the full ones would leave the label
 * column under 40 % of the width), the Δ column as wide as "+999 %", the
 * label column takes the rest.
 */
export function tableLayout(input: TableLayoutInput): TableLayout {
  const scale = effectiveFontScale(input.fontScale);
  const m = STUDIO_TEXT_MINIMUMS;
  const sizes = {
    title: m.title * scale,
    resource: m.resource * scale,
    subtitle: m.any * scale,
    columnHead: m.columnHead * scale,
    cell: m.cell * scale,
    cellMin: m.any * scale,
  };
  const width = Math.max(0, input.width);
  const parts = labelParts(input.label);
  const titleLines = Math.min(
    STUDIO_LABEL_MAX_LINES,
    Math.max(1, wrappedLineCount(parts.title, width, sizes.title, "semibold")),
  );
  const resourceLines =
    parts.resource === null
      ? 0
      : Math.min(
          STUDIO_LABEL_MAX_LINES,
          Math.max(
            1,
            wrappedLineCount(parts.resource, width, sizes.resource, "semibold"),
          ),
        );
  const headHeight =
    titleLines * sizes.title * TABLE_LINE_HEIGHT +
    resourceLines * sizes.resource * TABLE_LINE_HEIGHT +
    TABLE_SPACING.stack +
    sizes.subtitle * TABLE_LINE_HEIGHT +
    TABLE_SPACING.stack +
    sizes.columnHead * TABLE_LINE_HEIGHT;
  const footerHeight = TABLE_SPACING.stack + sizes.subtitle * TABLE_LINE_HEIGHT;
  const rowPitch = sizes.cell * TABLE_LINE_HEIGHT + TABLE_SPACING.rowGap;
  const rowCapacity = Math.max(
    0,
    Math.floor((input.height - headHeight - footerHeight) / rowPitch),
  );

  const gap = TABLE_SPACING.columnGap;
  const change =
    (input.showChange ?? true)
      ? estimateTextWidth(TABLE_CHANGE_SAMPLE, sizes.cell, "semibold")
      : 0;
  const widest = (compactForm: boolean) => {
    let max = 0;
    for (const entry of input.values ?? []) {
      const text = compactForm ? entry.compact : entry.full;
      max = Math.max(max, estimateTextWidth(text, sizes.cell, "semibold"));
    }
    return max;
  };
  const reserved = (value: number) =>
    value + gap + (change > 0 ? change + gap : 0);
  let value = widest(false);
  let compact = false;
  if (width - reserved(value) < width * TABLE_MIN_LABEL_SHARE) {
    const compactWidth = widest(true);
    if (compactWidth < value) {
      value = compactWidth;
      compact = true;
    }
  }
  return {
    sizes,
    titleLines,
    resourceLines,
    headHeight,
    footerHeight,
    rowPitch,
    rowCapacity,
    columns: {
      label: Math.max(0, width - reserved(value)),
      value,
      change,
      gap,
    },
    compact,
  };
}

// ---------------------------------------------------------------------------
// Measure table (ADR 0022)

/**
 * A measure widget's sizes in units, as both renderers draw it (`.sw-measure`
 * in the web's globals.css, `MeasureWidgetView` on tvOS): the title (36,
 * semibold, at most two lines), a 12 unit gap between its parts, the table's
 * rows (28 with 10 units of padding above and below and a hairline, the
 * column heads the same) and the footer lines (24; the freshness line at
 * line height 1.3). Line height is 1.15 elsewhere, as on the canvas.
 */
export const MEASURE_TABLE_METRICS = {
  title: 36,
  gap: 12,
  cell: 28,
  /** Padding above and below a cell. */
  cellPadding: 20,
  /** A row's hairline is drawn inside it (an inset shadow): no height. */
  border: 0,
  footer: 24,
  lineHeight: 1.15,
  freshnessLineHeight: 1.3,
} as const;

/**
 * The footer lines a measure table on a screen keeps room for under its
 * rows when its actual lines are not known (the readability check), each
 * as long as it commonly gets (German, the longer language) and wrapped at
 * the widget's width: the "N of M groups" line, and the freshness line
 * (ADR 0025), which never wraps and stands in for the source refresh line
 * (#769). Screens fit their rows to the lines they actually show
 * (`measureTableRowsShown`).
 */
export const MEASURE_TABLE_FOOTER_SAMPLES: readonly (string | null)[] = [
  "20 von 200 Gruppen werden angezeigt.",
  null,
];

/**
 * A cell as long as a row's label commonly is (a store's or an app's
 * name): where a column is narrower, its rows wrap to as many lines as the
 * sample, at most four (both renderers wrap cells). An estimate: longer
 * labels wrap further.
 */
export const MEASURE_TABLE_CELL_SAMPLE = "Apple App Store";

export interface MeasureTableLayout {
  titleLines: number;
  /** Lines of the column heads and of a row (`MEASURE_TABLE_CELL_SAMPLE`). */
  headLines: number;
  rowLines: number;
  /** Title, column heads, footer lines and the gaps between them, in units. */
  fixedHeight: number;
  /** One row of `rowLines` lines with its padding and border, in units. */
  rowPitch: number;
  /** Rows of `rowLines` lines that fit under the heads, above the footer. */
  rowCapacity: number;
}

/**
 * The characters of a measure table's text with their widths in em (#768),
 * regular and semibold, per renderer: IBM Plex Sans on web screens, the
 * system font on netrics TV (tabular digits, at the sizes it draws: 24, 28
 * and 36 units at every theme font scale, 1080p and 4K, plus 0.5 % for
 * its tracking at small sizes), rounded up to 0.001 em. Kerning only narrows a text, so the sums never fall short.
 * Other characters, and bold, take the conservative estimate. NetricsKit
 * has the same tables (StudioLayout.measureGlyph*).
 */
export const MEASURE_GLYPH_CHARS: readonly string[] = [
  ..." !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ·★€£¥–—…’‘“”•",
];
export const MEASURE_GLYPH_EMS = {
  web: {
    regular: [
      0.236, 0.284, 0.419, 0.713, 0.598, 0.927, 0.694, 0.242, 0.335, 0.335,
      0.45, 0.6, 0.272, 0.399, 0.272, 0.383, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6,
      0.6, 0.6, 0.6, 0.292, 0.292, 0.6, 0.6, 0.6, 0.477, 0.891, 0.641, 0.653,
      0.621, 0.671, 0.583, 0.559, 0.695, 0.707, 0.4, 0.51, 0.634, 0.501, 0.812,
      0.707, 0.708, 0.606, 0.708, 0.64, 0.581, 0.572, 0.678, 0.609, 0.891,
      0.613, 0.593, 0.58, 0.317, 0.383, 0.317, 0.6, 0.565, 0.6, 0.534, 0.58,
      0.504, 0.58, 0.549, 0.324, 0.528, 0.568, 0.25, 0.25, 0.527, 0.272, 0.873,
      0.568, 0.56, 0.58, 0.58, 0.367, 0.487, 0.351, 0.568, 0.492, 0.768, 0.508,
      0.499, 0.464, 0.343, 0.314, 0.343, 0.6, 0.641, 0.641, 0.641, 0.641, 0.641,
      0.641, 0.907, 0.621, 0.583, 0.583, 0.583, 0.583, 0.4, 0.4, 0.4, 0.4,
      0.674, 0.707, 0.708, 0.708, 0.708, 0.708, 0.708, 0.708, 0.678, 0.678,
      0.678, 0.678, 0.593, 0.606, 0.64, 0.534, 0.534, 0.534, 0.534, 0.534,
      0.534, 0.864, 0.504, 0.549, 0.549, 0.549, 0.549, 0.25, 0.25, 0.25, 0.25,
      0.555, 0.568, 0.56, 0.56, 0.56, 0.56, 0.56, 0.568, 0.568, 0.568, 0.568,
      0.568, 0.499, 0.58, 0.499, 0.326, 1.016, 0.625, 0.595, 0.605, 0.588, 0.78,
      0.803, 0.273, 0.273, 0.475, 0.474, 0.396,
    ],
    semibold: [
      0.236, 0.31, 0.472, 0.656, 0.601, 0.961, 0.714, 0.261, 0.338, 0.338,
      0.557, 0.6, 0.299, 0.402, 0.299, 0.438, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6,
      0.6, 0.6, 0.6, 0.319, 0.319, 0.6, 0.6, 0.6, 0.494, 0.9, 0.673, 0.663,
      0.643, 0.69, 0.6, 0.578, 0.712, 0.719, 0.423, 0.545, 0.678, 0.522, 0.817,
      0.719, 0.713, 0.642, 0.713, 0.664, 0.612, 0.581, 0.69, 0.638, 0.949,
      0.656, 0.633, 0.6, 0.329, 0.438, 0.329, 0.6, 0.559, 0.6, 0.559, 0.6,
      0.513, 0.6, 0.559, 0.351, 0.545, 0.588, 0.276, 0.276, 0.563, 0.294, 0.888,
      0.588, 0.563, 0.6, 0.6, 0.394, 0.499, 0.374, 0.588, 0.525, 0.82, 0.545,
      0.524, 0.503, 0.364, 0.377, 0.364, 0.6, 0.673, 0.673, 0.673, 0.673, 0.673,
      0.673, 0.951, 0.643, 0.6, 0.6, 0.6, 0.6, 0.423, 0.423, 0.423, 0.423,
      0.694, 0.719, 0.713, 0.713, 0.713, 0.713, 0.713, 0.713, 0.69, 0.69, 0.69,
      0.69, 0.633, 0.642, 0.677, 0.559, 0.559, 0.559, 0.559, 0.559, 0.559,
      0.864, 0.513, 0.559, 0.559, 0.559, 0.559, 0.276, 0.276, 0.276, 0.276,
      0.589, 0.588, 0.563, 0.563, 0.563, 0.563, 0.563, 0.571, 0.588, 0.588,
      0.588, 0.588, 0.524, 0.6, 0.524, 0.349, 1.035, 0.627, 0.586, 0.637, 0.588,
      0.78, 0.87, 0.293, 0.293, 0.518, 0.518, 0.42,
    ],
  },
  tv: {
    regular: [
      0.223, 0.282, 0.422, 0.622, 0.622, 0.837, 0.687, 0.269, 0.338, 0.338,
      0.419, 0.622, 0.234, 0.445, 0.234, 0.295, 0.622, 0.622, 0.622, 0.622,
      0.622, 0.622, 0.622, 0.622, 0.622, 0.622, 0.234, 0.234, 0.622, 0.622,
      0.622, 0.506, 0.893, 0.653, 0.622, 0.704, 0.696, 0.569, 0.545, 0.724,
      0.717, 0.24, 0.512, 0.618, 0.541, 0.849, 0.717, 0.749, 0.595, 0.749,
      0.616, 0.61, 0.598, 0.714, 0.648, 0.943, 0.652, 0.63, 0.634, 0.338, 0.295,
      0.338, 0.622, 0.544, 0.517, 0.519, 0.571, 0.518, 0.571, 0.529, 0.319,
      0.566, 0.556, 0.221, 0.22, 0.502, 0.219, 0.823, 0.544, 0.548, 0.567,
      0.566, 0.326, 0.482, 0.318, 0.544, 0.5, 0.733, 0.485, 0.503, 0.487, 0.338,
      0.231, 0.338, 0.622, 0.653, 0.653, 0.653, 0.653, 0.653, 0.653, 0.963,
      0.704, 0.569, 0.569, 0.569, 0.569, 0.24, 0.24, 0.24, 0.24, 0.719, 0.717,
      0.749, 0.749, 0.749, 0.749, 0.749, 0.747, 0.714, 0.714, 0.714, 0.714,
      0.63, 0.619, 0.56, 0.519, 0.519, 0.519, 0.519, 0.519, 0.519, 0.856, 0.518,
      0.529, 0.529, 0.529, 0.529, 0.221, 0.221, 0.221, 0.221, 0.558, 0.544,
      0.548, 0.548, 0.548, 0.548, 0.548, 0.548, 0.544, 0.544, 0.544, 0.544,
      0.503, 0.567, 0.503, 0.234, 1.035, 0.622, 0.622, 0.622, 0.544, 0.849,
      0.637, 0.234, 0.234, 0.386, 0.386, 0.445,
    ],
    semibold: [
      0.217, 0.314, 0.46, 0.643, 0.649, 0.892, 0.707, 0.281, 0.376, 0.376,
      0.448, 0.649, 0.254, 0.453, 0.254, 0.31, 0.649, 0.649, 0.649, 0.649,
      0.649, 0.649, 0.649, 0.649, 0.649, 0.649, 0.254, 0.254, 0.649, 0.649,
      0.649, 0.534, 0.901, 0.689, 0.644, 0.72, 0.71, 0.582, 0.558, 0.737, 0.736,
      0.265, 0.552, 0.651, 0.553, 0.869, 0.727, 0.763, 0.62, 0.763, 0.642,
      0.635, 0.611, 0.721, 0.678, 0.969, 0.684, 0.663, 0.643, 0.376, 0.31,
      0.376, 0.649, 0.575, 0.517, 0.547, 0.598, 0.546, 0.597, 0.556, 0.353,
      0.594, 0.585, 0.243, 0.243, 0.536, 0.244, 0.861, 0.575, 0.574, 0.594,
      0.594, 0.362, 0.513, 0.351, 0.575, 0.528, 0.781, 0.523, 0.536, 0.509,
      0.376, 0.248, 0.376, 0.649, 0.689, 0.689, 0.689, 0.689, 0.689, 0.689,
      0.986, 0.72, 0.582, 0.582, 0.582, 0.582, 0.265, 0.265, 0.265, 0.265, 0.73,
      0.727, 0.763, 0.763, 0.763, 0.763, 0.763, 0.759, 0.721, 0.721, 0.721,
      0.721, 0.663, 0.649, 0.612, 0.547, 0.547, 0.547, 0.547, 0.547, 0.547,
      0.882, 0.546, 0.556, 0.556, 0.556, 0.556, 0.243, 0.243, 0.243, 0.243,
      0.582, 0.575, 0.574, 0.574, 0.574, 0.574, 0.574, 0.574, 0.575, 0.575,
      0.575, 0.575, 0.536, 0.594, 0.536, 0.254, 1.053, 0.649, 0.649, 0.649,
      0.575, 0.869, 0.701, 0.254, 0.254, 0.43, 0.43, 0.453,
    ],
  },
} as const;

/**
 * Whose text a measure table counts: a web screen's, netrics TV's, or
 * (the readability check, for every screen) the wider of the two.
 */
export type MeasureFont = "web" | "tv" | "any";

const glyphMap = (ems: readonly number[]) =>
  new Map(MEASURE_GLYPH_CHARS.map((char, i) => [char, ems[i]!]));
const MEASURE_GLYPHS = {
  web: {
    regular: glyphMap(MEASURE_GLYPH_EMS.web.regular),
    semibold: glyphMap(MEASURE_GLYPH_EMS.web.semibold),
  },
  tv: {
    regular: glyphMap(MEASURE_GLYPH_EMS.tv.regular),
    semibold: glyphMap(MEASURE_GLYPH_EMS.tv.semibold),
  },
};

/** A measure table's text width in units (see `MEASURE_GLYPH_EMS`). */
export function measureTextWidth(
  text: string,
  fontSize: number,
  weight: StudioFontWeight = "regular",
  font: MeasureFont = "any",
): number {
  let width = 0;
  for (const char of text) {
    const web =
      weight === "bold" ? undefined : MEASURE_GLYPHS.web[weight].get(char);
    const tv =
      weight === "bold" ? undefined : MEASURE_GLYPHS.tv[weight].get(char);
    const em =
      web === undefined || tv === undefined
        ? undefined
        : font === "web"
          ? web
          : font === "tv"
            ? tv
            : Math.max(web, tv);
    width +=
      em === undefined
        ? estimateTextWidth(char, fontSize, weight)
        : em * fontSize;
  }
  return width;
}

interface MeasureTableBox {
  label: string;
  /** The content box in units: the widget's rect less its padding. */
  width: number;
  height: number;
  fontScale?: number;
  /** The column heads as shown: grouped dimensions', then measures' names. */
  columns?: readonly string[] | null;
  /**
   * Units per screen pixel (default 1, a 1080p canvas): every line of a row
   * may round up to a whole pixel when drawn (small screens, whose units
   * are fractions of a pixel), so each keeps that much room.
   */
  pixel?: number;
  /** Whose text widths to count (default: the wider of web and TV). */
  font?: MeasureFont;
}

/** The parts of a measure table's height (see `measureTableLayout`). */
function measureTableParts(input: MeasureTableBox) {
  const scale = effectiveFontScale(input.fontScale);
  const m = MEASURE_TABLE_METRICS;
  const width = Math.max(0, input.width);
  const title = m.title * scale,
    cell = m.cell * scale,
    footerSize = m.footer * scale;
  // Text measured with the calibrated widths (`measureTextWidth`).
  const wrap = (
    text: string,
    room: number,
    size: number,
    weight: StudioFontWeight = "regular",
  ) =>
    wrappedLineCount(text, Math.max(0, room), size, weight, (part, at, w) =>
      measureTextWidth(part, at, w, input.font),
    );
  const titleLines = Math.min(
    STUDIO_LABEL_MAX_LINES,
    Math.max(1, wrap(input.label, width, title, "semibold")),
  );
  const columns = input.columns?.length ? input.columns : null;
  // Both renderers give every column an even share (a fixed table layout).
  const pixel =
    input.pixel !== undefined && Number.isFinite(input.pixel) && input.pixel > 0
      ? input.pixel
      : 1;
  // A pixel less than the column: glyphs at a screen's small sizes may
  // round wider than their share (#768).
  const columnWidth = width / (columns?.length ?? 1) - m.cellPadding - pixel;
  const lines = (texts: readonly string[], weight: StudioFontWeight) =>
    Math.max(1, ...texts.map((text) => wrap(text, columnWidth, cell, weight)));
  const row = (count: number) =>
    count * (cell * m.lineHeight + pixel) + m.cellPadding + m.border;
  const footerLine = (text: string | null) =>
    m.gap +
    (text === null
      ? footerSize * m.freshnessLineHeight
      : Math.max(1, wrap(text, width, footerSize)) * footerSize * m.lineHeight);
  const headLines = columns ? lines(columns, "semibold") : 1;
  return {
    titleLines,
    headLines,
    lines,
    row,
    footerLine,
    /** Title, gap and column heads. */
    head: titleLines * title * m.lineHeight + m.gap + row(headLines),
  };
}

/**
 * A measure widget's table view in a content box (units), as the
 * readability check estimates it: the title (at most two lines), the
 * column heads wrapped at an even share of the width, rows that wrap as
 * `MEASURE_TABLE_CELL_SAMPLE` would in a column, and the footer lines
 * (`footer`, null for the one-line freshness line; by default
 * `MEASURE_TABLE_FOOTER_SAMPLES`). 0 rows when not even the heads and the
 * footer fit.
 */
export function measureTableLayout(
  input: MeasureTableBox & { footer?: readonly (string | null)[] },
): MeasureTableLayout {
  const parts = measureTableParts(input);
  const rowLines = input.columns?.length
    ? parts.lines([MEASURE_TABLE_CELL_SAMPLE], "regular")
    : 1;
  const rowPitch = parts.row(rowLines);
  const fixedHeight =
    parts.head +
    (input.footer ?? MEASURE_TABLE_FOOTER_SAMPLES).reduce<number>(
      (sum, line) => sum + parts.footerLine(line),
      0,
    );
  return {
    titleLines: parts.titleLines,
    headLines: parts.headLines,
    rowLines,
    fixedHeight,
    rowPitch,
    rowCapacity: Math.max(
      0,
      Math.floor((input.height - fixedHeight) / rowPitch + 1e-9),
    ),
  };
}

/**
 * The rows a measure table shows on a screen (#768), as both renderers fit
 * them: the first rows, each as tall as its cells wrap, while they fit
 * above the footer lines the widget shows (`footer`, null for the
 * freshness line). Rows give way first: the footer always fits when
 * anything does. When rows are left out (of those received, or of
 * `total`), the "N of M" line (`rowsLine`) joins the footer and is
 * counted. Pure and deterministic: the same input, the same rows.
 */
export function measureTableRowsShown(
  input: MeasureTableBox & {
    /** The rows' cells as shown, in column order. */
    rows: readonly (readonly string[])[];
    /** Every group the query has (`totalRows`); at least `rows.length`. */
    total: number;
    footer: readonly (string | null)[];
    rowsLine: (shown: number, total: number) => string;
  },
): { shown: number; rowsLine: string | null } {
  const parts = measureTableParts(input);
  const total = Math.max(input.total, input.rows.length);
  const fit = (footer: readonly (string | null)[]) => {
    let room =
      input.height -
      parts.head -
      footer.reduce<number>((sum, line) => sum + parts.footerLine(line), 0);
    let shown = 0;
    for (const row of input.rows) {
      room -= parts.row(parts.lines(row, "regular"));
      if (room < -1e-9) break;
      shown += 1;
    }
    return shown;
  };
  const all = fit(input.footer);
  if (all >= total) return { shown: total, rowsLine: null };
  // The line's own room comes from the rows; its wording barely changes
  // with the count, so measure it once at the count without it.
  const line = input.rowsLine(all, total);
  const shown = fit([...input.footer, line]);
  return { shown, rowsLine: input.rowsLine(shown, total) };
}

/**
 * A freshness line that lists several sources (#784, ADR 0025 section 8):
 * which of its forms a measure widget shows, given as `levels`, longest
 * first, each one or more lines (the last form: a line per source). The
 * first form whose every line fits the content width on one line at the
 * footer size, else the last. Screens count the chosen form's lines as
 * freshness lines (`null` in a footer); nothing is ever cut.
 */
export function freshnessLevelFit(
  levels: readonly (readonly string[])[],
  width: number,
  fontScale?: number,
  font: MeasureFont = "any",
): number {
  const size = MEASURE_TABLE_METRICS.footer * effectiveFontScale(fontScale);
  const index = levels.findIndex((lines) =>
    lines.every(
      (line) => measureTextWidth(line, size, "regular", font) <= width + 1e-9,
    ),
  );
  return index === -1 ? Math.max(0, levels.length - 1) : index;
}

/**
 * A measure value view with a grouping (#784): its total and a line per
 * group ("635", "App Store 412", "Google Play 223"), as both renderers draw
 * it: the title, the total (semibold, line height 1.1, from 84 units down
 * to 36 to fit the width and the room), the group lines (28, line height
 * 1.15, label and value on one line where they fit) and the footer lines.
 */
export const MEASURE_SPLIT_METRICS = {
  value: 84,
  valueMin: 36,
  valueLineHeight: 1.1,
} as const;

/**
 * What the readability check assumes of a total with its split, which it
 * checks without data: a seven-digit total and a store's line.
 */
export const MEASURE_SPLIT_SAMPLES = {
  total: "1.234.567",
  line: ["Google Play", "1.234.567"] as const,
} as const;

/**
 * How a total with its split fits its tile: the total's size, and the
 * group lines shown (lines give way when even the smallest total does not
 * fit; the "N of M" line then joins the footer). `fits`: every line shows
 * and the total is at least `valueMin`. Pure, as `measureTableRowsShown`.
 */
export function measureSplitLayout(
  input: MeasureTableBox & {
    /** The total as shown, null without one (the groups alone). */
    total: string | null;
    /** A group's line as shown: its label and its value. */
    lines: readonly (readonly [string, string])[];
    footer: readonly (string | null)[];
    rowsLine?: (shown: number, total: number) => string;
  },
): {
  valueSize: number;
  shown: number;
  rowsLine: string | null;
  fits: boolean;
} {
  const parts = measureTableParts(input);
  const scale = effectiveFontScale(input.fontScale);
  const m = MEASURE_TABLE_METRICS,
    v = MEASURE_SPLIT_METRICS;
  const width = Math.max(0, input.width);
  const pixel =
    input.pixel !== undefined && Number.isFinite(input.pixel) && input.pixel > 0
      ? input.pixel
      : 1;
  const cell = m.cell * scale;
  const head = parts.titleLines * m.title * scale * m.lineHeight + m.gap;
  const lineHeight = ([label, value]: readonly [string, string]) =>
    Math.max(
      1,
      wrappedLineCount(
        `${label} ${value}`,
        width - pixel,
        cell,
        "regular",
        (text, at, weight) => measureTextWidth(text, at, weight, input.font),
      ),
    ) *
    (cell * m.lineHeight + pixel);
  const totalWidth =
    input.total === null
      ? 0
      : measureTextWidth(input.total, 1, "semibold", input.font);
  const widest =
    totalWidth > 0 ? (width - pixel) / totalWidth : v.value * scale;
  const layout = (shown: number, footer: readonly (string | null)[]) => {
    const lines = input.lines
      .slice(0, shown)
      .reduce((sum, line) => sum + lineHeight(line), 0);
    const room =
      input.height -
      head -
      footer.reduce<number>((sum, line) => sum + parts.footerLine(line), 0) -
      (shown ? lines + m.gap : 0);
    if (input.total === null) return { valueSize: 0, ok: room >= -1e-9 };
    const valueSize = Math.min(
      v.value * scale,
      widest,
      (room - pixel) / v.valueLineHeight,
    );
    return { valueSize, ok: valueSize >= v.valueMin * scale - 1e-9 };
  };
  const all = input.lines.length;
  const full = layout(all, input.footer);
  if (full.ok)
    return {
      valueSize: Math.max(0, full.valueSize),
      shown: all,
      rowsLine: null,
      fits: true,
    };
  // Lines give way, from the end; "N of M" joins the footer.
  for (let shown = all - 1; shown >= 0; shown--) {
    const line = input.rowsLine?.(shown, all) ?? null;
    const footer = line === null ? input.footer : [...input.footer, line];
    const fitted = layout(shown, footer);
    if (fitted.ok || shown === 0)
      return {
        valueSize: Math.max(0, fitted.valueSize),
        shown,
        rowsLine: line,
        fits: false,
      };
  }
  return { valueSize: 0, shown: 0, rowsLine: null, fits: false };
}

/** Rows a table shows: its limit, its rows and the room, whichever is least. */
export function tableRowsShown(
  limit: number,
  rows: number,
  rowCapacity: number,
): number {
  return Math.max(0, Math.min(limit, rows, rowCapacity));
}

/**
 * A row label's size: the cell size when it fits the label column on one
 * line, else shrunk down to `cellMin` (24 u); `truncated` when even that
 * does not fit and the label ends with an ellipsis (data text, ADR 0019
 * section 2).
 */
export function tableRowLabel(
  text: string,
  labelWidth: number,
  sizes: { cell: number; cellMin: number },
): { size: number; truncated: boolean } {
  const size = fitTextSize(text, labelWidth, {
    min: sizes.cellMin,
    max: sizes.cell,
  });
  return size === null
    ? { size: sizes.cellMin, truncated: true }
    : { size, truncated: false };
}

export type TableChangeKind = "ratio" | "new" | "none";

/**
 * What a row's Δ shows: the ratio ("+12 %", "−3 %"); "new" when there is
 * no previous value (or it is zero) and the value is not zero; else "–".
 */
export function tableChangeKind(row: {
  value: number | null;
  previousValue: number | null;
  ratio: number | null;
}): TableChangeKind {
  if (row.ratio !== null && Number.isFinite(row.ratio)) return "ratio";
  if (
    row.value !== null &&
    row.value !== 0 &&
    (row.previousValue === null || row.previousValue === 0)
  ) {
    return "new";
  }
  return "none";
}

// ---------------------------------------------------------------------------
// Status board (ADR 0019 section 7)

/** A status board's spacing in units. */
export const STATUS_SPACING = {
  /** Between the rows and the footer. */
  stack: 8,
  /** Above every row: the row pitch is the cell line plus this. */
  rowGap: 12,
  /** Between the dot, the name and the age. */
  columnGap: 16,
  /** The health dot's diameter. */
  dot: 14,
} as const;

/** The widest age the age column reserves room for ("14 m", "3 h", "2 d"). */
export const STATUS_AGE_SAMPLE = "99 m";

export interface StatusLayoutInput {
  /** The widget's label as screens show it ("Sources"). */
  label: string;
  /** The content box in units: the widget's rect less its padding. */
  width: number;
  height: number;
  fontScale?: number;
  /** The age column (`showAge`); default true. */
  showAge?: boolean;
}

export interface StatusLayout {
  /** Text sizes in units; `cellMin` is what a name shrinks to. */
  sizes: {
    title: number;
    resource: number;
    cell: number;
    cellMin: number;
    age: number;
    footer: number;
  };
  /** Lines of the title (1–2) and of the resource line (0–2). */
  titleLines: number;
  resourceLines: number;
  /** The label, in units. */
  headHeight: number;
  /** The footer line and its gap, in units. */
  footerHeight: number;
  /** A row's line plus the gap above it, in units. */
  rowPitch: number;
  /** Rows that fit between the label and the footer ("+N more" included). */
  rowCapacity: number;
  /** Column widths in units; `age` is 0 without the age column. */
  columns: { dot: number; name: number; age: number; gap: number };
}

/**
 * A status board's layout: the label (title and resource line, at most two
 * lines each), the rows (a 14 u dot, the name in the cell role, 28 u, and
 * right-aligned the age, 24 u; each row a cell line plus a 12 u gap) and
 * the footer ("4 connected · 1 delayed"). At 16:9 a 3 × 3 board (404 ×
 * 295 u) fits five rows at font scale 1 and three at 1.3.
 */
export function statusLayout(input: StatusLayoutInput): StatusLayout {
  const scale = effectiveFontScale(input.fontScale);
  const m = STUDIO_TEXT_MINIMUMS;
  const sizes = {
    title: m.title * scale,
    resource: m.resource * scale,
    cell: m.cell * scale,
    cellMin: m.any * scale,
    age: m.any * scale,
    footer: m.any * scale,
  };
  const width = Math.max(0, input.width);
  const parts = labelParts(input.label);
  const titleLines = Math.min(
    STUDIO_LABEL_MAX_LINES,
    Math.max(1, wrappedLineCount(parts.title, width, sizes.title, "semibold")),
  );
  const resourceLines =
    parts.resource === null
      ? 0
      : Math.min(
          STUDIO_LABEL_MAX_LINES,
          Math.max(
            1,
            wrappedLineCount(parts.resource, width, sizes.resource, "semibold"),
          ),
        );
  const headHeight =
    titleLines * sizes.title * TABLE_LINE_HEIGHT +
    resourceLines * sizes.resource * TABLE_LINE_HEIGHT;
  const footerHeight = STATUS_SPACING.stack + sizes.footer * TABLE_LINE_HEIGHT;
  const rowPitch = sizes.cell * TABLE_LINE_HEIGHT + STATUS_SPACING.rowGap;
  const rowCapacity = Math.max(
    0,
    Math.floor((input.height - headHeight - footerHeight) / rowPitch),
  );
  const gap = STATUS_SPACING.columnGap;
  const dot = STATUS_SPACING.dot * scale;
  const age =
    (input.showAge ?? true)
      ? estimateTextWidth(STATUS_AGE_SAMPLE, sizes.age, "regular")
      : 0;
  return {
    sizes,
    titleLines,
    resourceLines,
    headHeight,
    footerHeight,
    rowPitch,
    rowCapacity,
    columns: {
      dot,
      name: Math.max(0, width - dot - gap - (age > 0 ? age + gap : 0)),
      age,
      gap,
    },
  };
}

/**
 * How many items a status board lists and what "+N more" says: every item
 * when they fit; else the first `rowCapacity − 1` and a last row "+N more"
 * for the rest. Items come attention first, so a problem is never the one
 * hidden while the board has a row for every problem.
 */
export function statusRowsShown(
  items: number,
  rowCapacity: number,
): { shown: number; more: number } {
  const count = Math.max(0, items);
  const capacity = Math.max(0, rowCapacity);
  if (count <= capacity) return { shown: count, more: 0 };
  if (capacity === 0) return { shown: 0, more: 0 };
  return { shown: capacity - 1, more: count - (capacity - 1) };
}

/** A name's size: the cell size, shrunk to `cellMin`, then an ellipsis. */
export function statusRowLabel(
  text: string,
  nameWidth: number,
  sizes: { cell: number; cellMin: number },
): { size: number; truncated: boolean } {
  return tableRowLabel(text, nameWidth, sizes);
}

export type StatusAgeUnit = "m" | "h" | "d";

/**
 * The age of a source's last successful sync, as the board shows it ("14
 * m", "3 h", "2 d"): whole minutes under an hour, whole hours under a day,
 * else whole days; null without a success. Screens compute it from
 * `lastSuccessAt` every minute.
 */
export function statusAge(
  lastSuccessAt: string | null,
  now: number,
): { amount: number; unit: StatusAgeUnit } | null {
  if (lastSuccessAt === null) return null;
  const at = Date.parse(lastSuccessAt);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 60) return { amount: minutes, unit: "m" };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { amount: hours, unit: "h" };
  return { amount: Math.floor(hours / 24), unit: "d" };
}

// ---------------------------------------------------------------------------
// Goal widget: a full ring (ADR 0019 section 5)

/** Line height of a gauge's text, as `STUDIO_LINE_HEIGHT`. */
const GAUGE_LINE_HEIGHT = 1.15;

/** The gauge's spacing and ring rules, in units. */
export const GAUGE_SPACING = {
  /** Between the label, target line, ring, progress line and footer. */
  stack: 8,
  /** Between the text column and the ring in the side layout. */
  side: 16,
  /** The ring is at least this wide (ADR 0019 §5 and §13). */
  ringMin: 160,
  /** Its stroke is this share of the diameter, at least `strokeMin`. */
  strokeShare: 0.1,
  strokeMin: 16,
  /** The value may take this share of the ring's inner diameter. */
  valueWidthShare: 0.86,
  /** Space before the suffix ("%"), as a share of its size. */
  suffixGap: 0.1,
  /** The side layout from this content aspect (width ÷ height) on. */
  sideAspect: 1.6,
} as const;

export interface GaugeLayoutInput {
  /** The label as screens show it (the title, or the goal's name). */
  label: string;
  /** The content box in units: the widget's rect less its padding. */
  width: number;
  height: number;
  fontScale?: number;
  /**
   * The text inside the ring, full and compact: the percent in progress
   * ("83", with "%" as `suffix`), the value once reached ("15,612",
   * "15.6K"). Sized on its widest digits, so a count-up keeps one size.
   */
  value?: { full: string; compact: string } | null;
  /** A smaller unit after the value ("%"), in the change role. */
  suffix?: string | null;
  /** The progress line as shown; it wraps to at most two lines. */
  progress?: string | null;
}

export interface GaugeLayout {
  /** `side`: the ring right of the text, from a 1.6:1 content box. */
  orientation: "stack" | "side";
  /** Text sizes in units. */
  sizes: {
    title: number;
    resource: number;
    /** The target line ("Goal 15,000"), resource role. */
    target: number;
    /** The progress line, change role. */
    progress: number;
    footer: number;
    /** The value inside the ring and its suffix. */
    value: number;
    suffix: number;
  };
  titleLines: number;
  resourceLines: number;
  /** The target line is shown (it goes second when height runs short). */
  showTarget: boolean;
  /** The footer is shown (it goes first). */
  showFooter: boolean;
  /** Lines of the progress line (1–2). */
  progressLines: number;
  /** The width of the text: the content width, or the side column. */
  textWidth: number;
  ring: { diameter: number; stroke: number };
  /** The value is shown in its compact form. */
  compact: boolean;
  /** The ring reaches its minimum of 160 u. */
  fits: boolean;
}

/**
 * A goal widget's layout: the label (title and resource line, at most two
 * lines each), the target line (resource role, one line), a full ring with
 * the value inside (its diameter what is left, at most the content width,
 * at least 160 u; stroke 10 % of it, at least 16 u), the progress line
 * (change role, at most two lines) and the footer. When the ring would be
 * under 160 u the footer goes first, then the target line. From a content
 * box 1.6 times as wide as high the ring sits right of the text, as high as
 * the box and at most half its width. The value inside is at least the
 * value minimum and as large as fits the ring's inner diameter, its compact
 * form when the full one does not fit, and only then smaller (the ring's
 * interior is the limit, never below the smallest text).
 */
export function gaugeLayout(input: GaugeLayoutInput): GaugeLayout {
  const scale = effectiveFontScale(input.fontScale);
  const m = STUDIO_TEXT_MINIMUMS;
  const width = Math.max(0, input.width);
  const height = Math.max(0, input.height);
  const base = {
    title: m.title * scale,
    resource: m.resource * scale,
    target: m.resource * scale,
    progress: m.change * scale,
    footer: m.any * scale,
  };
  const gap = GAUGE_SPACING.stack;
  const side = height > 0 && width >= GAUGE_SPACING.sideAspect * height;
  const sideDiameter = side
    ? Math.max(0, Math.min(height, (width - GAUGE_SPACING.side) / 2))
    : 0;
  const textWidth = side
    ? Math.max(0, width - sideDiameter - GAUGE_SPACING.side)
    : width;

  const parts = labelParts(input.label);
  const titleLines = Math.min(
    STUDIO_LABEL_MAX_LINES,
    Math.max(
      1,
      wrappedLineCount(parts.title, textWidth, base.title, "semibold"),
    ),
  );
  const resourceLines =
    parts.resource === null
      ? 0
      : Math.min(
          STUDIO_LABEL_MAX_LINES,
          Math.max(
            1,
            wrappedLineCount(
              parts.resource,
              textWidth,
              base.resource,
              "semibold",
            ),
          ),
        );
  const progressLines = Math.min(
    2,
    Math.max(
      1,
      input.progress
        ? wrappedLineCount(input.progress, textWidth, base.progress, "semibold")
        : 1,
    ),
  );
  const labelHeight =
    titleLines * base.title * GAUGE_LINE_HEIGHT +
    resourceLines * base.resource * GAUGE_LINE_HEIGHT;
  const targetHeight = base.target * GAUGE_LINE_HEIGHT;
  const progressHeight = progressLines * base.progress * GAUGE_LINE_HEIGHT;
  const footerHeight = base.footer * GAUGE_LINE_HEIGHT;

  /** The text's height with these parts (the ring and its gap aside). */
  const textHeight = (target: boolean, footer: boolean) =>
    labelHeight +
    (target ? gap + targetHeight : 0) +
    gap +
    progressHeight +
    (footer ? gap + footerHeight : 0);
  const ringRoom = (target: boolean, footer: boolean) =>
    side
      ? sideDiameter
      : Math.min(width, height - textHeight(target, footer) - gap);
  const fitsWith = (target: boolean, footer: boolean) =>
    side
      ? textHeight(target, footer) <= height &&
        sideDiameter >= GAUGE_SPACING.ringMin
      : ringRoom(target, footer) >= GAUGE_SPACING.ringMin;
  // The footer goes first, then the target line.
  const candidates: Array<[boolean, boolean]> = [
    [true, true],
    [true, false],
    [false, false],
  ];
  const [showTarget, showFooter] = candidates.find(([target, footer]) =>
    fitsWith(target, footer),
  ) ?? [false, false];
  const diameter = Math.max(0, ringRoom(showTarget, showFooter));
  const ring = {
    diameter,
    stroke: Math.max(
      GAUGE_SPACING.strokeMin,
      diameter * GAUGE_SPACING.strokeShare,
    ),
  };

  // The value inside the ring.
  const valueMin = m.value * scale;
  const anyMin = m.any * scale;
  const suffixSize = base.progress;
  const inner = Math.max(0, diameter - 2 * ring.stroke);
  // The suffix follows the value after a tenth of its size ("83%").
  const suffixWidth = input.suffix
    ? estimateTextWidth(input.suffix, suffixSize, "semibold") +
      suffixSize * GAUGE_SPACING.suffixGap
    : 0;
  const room = Math.max(0, inner * GAUGE_SPACING.valueWidthShare - suffixWidth);
  const valueMax = Math.max(valueMin, inner * 0.45);
  // Widest digits, so a count-up and tomorrow's value keep one size.
  const sized = (text: string, min: number) =>
    fitTextSize(text.replace(/\d/g, "0"), room, {
      min,
      max: valueMax,
      weight: "semibold",
    });
  let value = valueMin;
  let compact = false;
  if (input.value) {
    const full = sized(input.value.full, valueMin);
    const short =
      input.value.compact === input.value.full
        ? null
        : sized(input.value.compact, valueMin);
    if (full !== null) {
      value = full;
    } else if (short !== null) {
      value = short;
      compact = true;
    } else {
      // The ring's interior is the limit: the compact form as large as it
      // fits there, never below the smallest text.
      value = Math.max(anyMin, sized(input.value.compact, 0) ?? anyMin);
      compact = input.value.compact !== input.value.full;
    }
  }
  return {
    orientation: side ? "side" : "stack",
    sizes: { ...base, value, suffix: suffixSize },
    titleLines,
    resourceLines,
    showTarget,
    showFooter,
    progressLines,
    textWidth,
    ring,
    compact,
    fits: diameter >= GAUGE_SPACING.ringMin,
  };
}

// ---------------------------------------------------------------------------
// Latest review (ADR 0019 section 12)

/** Line height of a review's label, stars row and author line. */
const REVIEW_LINE_HEIGHT = 1.15;
/** Line height of a review's title and body (design 4b: 1.3; kept tighter). */
const REVIEW_TEXT_LINE_HEIGHT = 1.25;

/** A review's spacing and fixed sizes in units. */
export const REVIEW_SPACING = {
  /** Between the label, the stars row, the text and the author line. */
  stack: 8,
  /** The app icon's edge (not scaled with the font). */
  icon: 48,
  /** Between the icon and the stars. */
  iconGap: 12,
  /** Between two stars. */
  starGap: 4,
} as const;

/** Stars a review shows, filled up to its rating. */
export const REVIEW_STARS = 5;

export interface ReviewLayoutInput {
  /** The widget's label as screens show it ("Latest review · Wurfel"). */
  label: string;
  /** The content box in units: the widget's rect less its padding. */
  width: number;
  height: number;
  fontScale?: number;
  /** An app icon is shown in the stars row. */
  icon: boolean;
  /** The review's title and body; null or blank: none. */
  title: string | null;
  body: string | null;
  /** A notice line (stale) below the author line. */
  notice?: boolean;
}

export interface ReviewLayout {
  /** Text sizes in units. */
  sizes: {
    title: number;
    resource: number;
    stars: number;
    review: number;
    author: number;
  };
  /** Lines of the label's title (1–2) and resource line (0–2). */
  titleLines: number;
  resourceLines: number;
  /** The icon's edge in units, 0 without one. */
  icon: number;
  /** The stars row: the icon or the stars, whichever is taller. */
  starsRowHeight: number;
  /** One line of the review's title or body, in units. */
  textLine: number;
  /** The review's title is shown (one line, may end with an ellipsis). */
  showTitle: boolean;
  /** The title is wider than the content box: it ends with an ellipsis. */
  titleTruncated: boolean;
  /** Body lines shown: as many as the text takes and the room allows. */
  bodyLines: number;
  /** The body takes more lines than shown: the last one ends with "…". */
  bodyTruncated: boolean;
}

function reviewText(text: string | null): string | null {
  return text === null || text.trim() === "" ? null : text.trim();
}

/**
 * A latest-review widget's layout: the label (title and resource line, at
 * most two lines each), the stars row (the app icon, 48 u, when set, and
 * five stars, 28 u), the review's title (32 u semibold, one line) and body
 * (32 u, the lines that fit, then an ellipsis: data text, ADR 0019 section
 * 2), and the author line (24 u). Without a title the body takes its room.
 * At the minimum 4 × 3 (560 × 295 u at 16:9, font scale 1) the label, the
 * stars row, the title, two body lines and the author line fit.
 */
export function reviewLayout(input: ReviewLayoutInput): ReviewLayout {
  const scale = effectiveFontScale(input.fontScale);
  const m = STUDIO_TEXT_MINIMUMS;
  const sizes = {
    title: m.title * scale,
    resource: m.resource * scale,
    stars: m.stars * scale,
    review: m.review * scale,
    author: m.any * scale,
  };
  const width = Math.max(0, input.width);
  const parts = labelParts(input.label);
  const titleLines = Math.min(
    STUDIO_LABEL_MAX_LINES,
    Math.max(1, wrappedLineCount(parts.title, width, sizes.title, "semibold")),
  );
  const resourceLines =
    parts.resource === null
      ? 0
      : Math.min(
          STUDIO_LABEL_MAX_LINES,
          Math.max(
            1,
            wrappedLineCount(parts.resource, width, sizes.resource, "semibold"),
          ),
        );
  const icon = input.icon ? REVIEW_SPACING.icon : 0;
  const starsRowHeight = Math.max(icon, sizes.stars * REVIEW_LINE_HEIGHT);
  const textLine = sizes.review * REVIEW_TEXT_LINE_HEIGHT;
  const smallLine = sizes.author * REVIEW_LINE_HEIGHT;
  const fixed =
    titleLines * sizes.title * REVIEW_LINE_HEIGHT +
    resourceLines * sizes.resource * REVIEW_LINE_HEIGHT +
    REVIEW_SPACING.stack +
    starsRowHeight +
    REVIEW_SPACING.stack +
    REVIEW_SPACING.stack +
    smallLine +
    (input.notice === true ? REVIEW_SPACING.stack + smallLine : 0);
  const title = reviewText(input.title);
  const body = reviewText(input.body);
  let room = Math.max(0, input.height - fixed);
  const showTitle = title !== null && room >= textLine;
  if (showTitle) room -= textLine;
  const capacity = Math.max(0, Math.floor(room / textLine));
  const wanted =
    body === null ? 0 : wrappedLineCount(body, width, sizes.review, "regular");
  const bodyLines = Math.min(wanted, capacity);
  return {
    sizes,
    titleLines,
    resourceLines,
    icon,
    starsRowHeight,
    textLine,
    showTitle,
    titleTruncated:
      showTitle && estimateTextWidth(title!, sizes.review, "semibold") > width,
    bodyLines,
    bodyTruncated: wanted > bodyLines,
  };
}

/** Filled stars of a rating: rounded into 0–5. */
export function reviewStarsFilled(rating: number): number {
  if (!Number.isFinite(rating)) return 0;
  return Math.min(REVIEW_STARS, Math.max(0, Math.round(rating)));
}

// ---------------------------------------------------------------------------
// Legacy layout (tile migration, #214)

/** Tiles per slide: at most 4 columns × 4 rows keep the 3 × 2 minimum. */
export const LEGACY_MAX_COLUMNS = 4;
export const LEGACY_MAX_ROWS = 4;
export const LEGACY_TILES_PER_SLIDE = LEGACY_MAX_COLUMNS * LEGACY_MAX_ROWS;

const TARGET_TILE_ASPECT = 1.2;
const EMPTY_CELL_COST = 0.5;

/**
 * Columns and rows for `tiles` tiles on one 16:9 screen, as the TV layout
 * picks them (`tvGrid`, apps/web/src/lib/tv-grid.ts): cells closest to
 * 1.2:1, an empty cell costing 0.5. Restricted to at most 4 × 4; for more
 * than 16 tiles it is the grid of the first, full slide.
 */
export function legacyGrid(tiles: number): { columns: number; rows: number } {
  // A slide holds at most 16 tiles; more go on further slides.
  const count = Math.min(Math.floor(tiles), LEGACY_TILES_PER_SLIDE);
  if (count <= 1) return { columns: 1, rows: 1 };
  const screenAspect = 16 / 9;
  let best = { columns: 0, rows: 0, score: Number.POSITIVE_INFINITY };
  for (
    let columns = 1;
    columns <= Math.min(count, LEGACY_MAX_COLUMNS);
    columns++
  ) {
    const rows = Math.ceil(count / columns);
    if (rows > LEGACY_MAX_ROWS) continue;
    const tileAspect = (screenAspect * rows) / columns;
    const empty = columns * rows - count;
    const score =
      Math.abs(Math.log(tileAspect / TARGET_TILE_ASPECT)) +
      EMPTY_CELL_COST * empty;
    if (score < best.score) {
      best = { columns, rows, score };
    }
  }
  return { columns: best.columns, rows: best.rows };
}

/**
 * Placements for `tiles` migrated tiles in reading order, one array per
 * slide: up to 16 per slide, the rest on further slides. Columns split the
 * 12 columns evenly; rows split the 8 rows at floor(i × 8 / rows) (3 rows
 * are 2, 3 and 3 high). No tiles is one empty slide.
 */
export function legacyLayout(tiles: number): StudioPlacement[][] {
  const count = Math.max(0, Math.floor(tiles));
  if (count === 0) return [[]];
  const slides: StudioPlacement[][] = [];
  for (let start = 0; start < count; start += LEGACY_TILES_PER_SLIDE) {
    const onSlide = Math.min(LEGACY_TILES_PER_SLIDE, count - start);
    const { columns, rows } = legacyGrid(onSlide);
    const width = STUDIO_GRID.columns / columns;
    const rowStart = (row: number) =>
      Math.floor((row * STUDIO_GRID.rows) / rows);
    const placements: StudioPlacement[] = [];
    for (let index = 0; index < onSlide; index++) {
      const row = Math.floor(index / columns);
      const column = index % columns;
      placements.push({
        x: column * width,
        y: rowStart(row),
        w: width,
        h: rowStart(row + 1) - rowStart(row),
      });
    }
    slides.push(placements);
  }
  return slides;
}

// ---------------------------------------------------------------------------
// Markdown-lite (text widget)

export interface StudioTextSpan {
  text: string;
  bold: boolean;
  italic: boolean;
}

export type StudioTextBlock =
  | { kind: "heading"; level: 1 | 2; spans: StudioTextSpan[] }
  | { kind: "paragraph"; lines: StudioTextSpan[][] };

function isBlank(char: string | undefined): boolean {
  return char === undefined || char === " " || char === "\t";
}

/**
 * Inline emphasis: `**bold**` and `*italic*`. A marker opens only before a
 * non-blank character and closes only after one, with text in between;
 * anything unmatched stays literal. Bold may hold italic and the other way
 * round, but not the same style again.
 */
function parseInline(
  text: string,
  bold: boolean,
  italic: boolean,
): StudioTextSpan[] {
  const spans: StudioTextSpan[] = [];
  let literal = "";
  const flush = () => {
    if (literal !== "") {
      spans.push({ text: literal, bold, italic });
      literal = "";
    }
  };
  let i = 0;
  while (i < text.length) {
    if (!bold && text.startsWith("**", i) && !isBlank(text[i + 2])) {
      const close = findClose(text, i + 2, "**");
      if (close > i + 2) {
        flush();
        spans.push(...parseInline(text.slice(i + 2, close), true, italic));
        i = close + 2;
        continue;
      }
    }
    if (
      !italic &&
      text[i] === "*" &&
      text[i + 1] !== "*" &&
      !isBlank(text[i + 1])
    ) {
      const close = findClose(text, i + 1, "*");
      if (close > i + 1) {
        flush();
        spans.push(...parseInline(text.slice(i + 1, close), bold, true));
        i = close + 1;
        continue;
      }
    }
    literal += text[i];
    i += 1;
  }
  flush();
  return spans;
}

/**
 * The first closing marker at or after `from` that follows a non-blank
 * character. A single `*` never closes on a `**` (that is bold), and a `**`
 * pair inside an italic run is skipped as a whole.
 */
function findClose(text: string, from: number, marker: "*" | "**"): number {
  let j = from;
  while (j < text.length) {
    if (marker === "*" && text.startsWith("**", j)) {
      const inner = text.indexOf("**", j + 2);
      j = inner < 0 ? j + 2 : inner + 2;
      continue;
    }
    if (text.startsWith(marker, j) && !isBlank(text[j - 1]) && j > from) {
      // "***" closes bold with its last two stars, after an inner italic.
      return marker === "**" && text.startsWith("***", j) ? j + 1 : j;
    }
    j += 1;
  }
  return -1;
}

/** Adjacent spans with the same style become one. */
function mergeSpans(spans: StudioTextSpan[]): StudioTextSpan[] {
  const merged: StudioTextSpan[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && last.bold === span.bold && last.italic === span.italic) {
      last.text += span.text;
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/**
 * The text widget's markdown-lite: blank lines separate paragraphs, a line
 * break inside a paragraph stays a line break, a line starting with `# ` or
 * `## ` is a heading, and `**bold**` and `*italic*` style text. Everything
 * else is literal text; nothing is ever HTML. Lines are trimmed of spaces
 * and tabs.
 */
export function parseTextWidget(source: string): StudioTextBlock[] {
  const blocks: StudioTextBlock[] = [];
  let paragraph: StudioTextSpan[][] | null = null;
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  for (const raw of lines) {
    const line = raw.replace(/^[ \t]+|[ \t]+$/g, "");
    if (line === "") {
      paragraph = null;
      continue;
    }
    const heading = line.startsWith("## ") ? 2 : line.startsWith("# ") ? 1 : 0;
    if (heading !== 0) {
      const text = line.slice(heading + 1).replace(/^[ \t]+/, "");
      if (text !== "") {
        blocks.push({
          kind: "heading",
          level: heading,
          spans: mergeSpans(parseInline(text, false, false)),
        });
        paragraph = null;
        continue;
      }
    }
    const spans = mergeSpans(parseInline(line, false, false));
    if (paragraph === null) {
      paragraph = [spans];
      blocks.push({ kind: "paragraph", lines: paragraph });
    } else {
      paragraph.push(spans);
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Compact numbers

const COMPACT_SUFFIXES = ["", "K", "M", "B", "T"] as const;

function trimFraction(digits: string): string {
  return digits.includes(".") ? digits.replace(/\.?0+$/, "") : digits;
}

/**
 * The compact form of a number, as the dashboard formats values from
 * 10,000 up (en-US compact notation, at most one decimal, rounded half away
 * from zero): 12.3K, 4.2M, 1.5B; 999,950 is 1M. Below 1,000 it is the plain
 * number: no decimals from 100, at most two below. Renderers use it for
 * smaller values too when the full form does not fit.
 */
export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const magnitude = Math.abs(value);
  if (magnitude < 1000) {
    const digits = magnitude >= 100 ? 0 : 2;
    const factor = 10 ** digits;
    const rounded = Math.round(magnitude * factor) / factor;
    if (rounded >= 1000) return `${sign}1K`;
    const text = trimFraction(rounded.toFixed(digits));
    return text === "0" ? "0" : `${sign}${text}`;
  }
  let tier = 1;
  while (
    tier < COMPACT_SUFFIXES.length - 1 &&
    magnitude >= 1000 ** (tier + 1)
  ) {
    tier += 1;
  }
  let tenths = Math.round((magnitude * 10) / 1000 ** tier);
  if (tenths >= 10000 && tier < COMPACT_SUFFIXES.length - 1) {
    tier += 1;
    tenths = Math.round((magnitude * 10) / 1000 ** tier);
  }
  const whole = Math.floor(tenths / 10);
  const fraction = tenths % 10;
  return `${sign}${whole}${fraction === 0 ? "" : `.${fraction}`}${COMPACT_SUFFIXES[tier]}`;
}

// ---------------------------------------------------------------------------
// Clock: zone line and content layout (ADR 0019, section 9)

/** How the clock shows the date: "Sat 4 Oct" or "Saturday, 4 October". */
export type ClockDateStyle = "short" | "long";

/**
 * The widest date of each style in English and German by the width
 * estimate, so whether the date fits does not change from day to day. The
 * domain tests check every day of a year in both languages against them.
 */
export const CLOCK_DATE_SAMPLES: Readonly<Record<ClockDateStyle, string>> = {
  short: "Mo., 16. März",
  long: "Donnerstag, 10. September",
};

/** The widest offset the zone line can show, for the fit. */
const ZONE_OFFSET_SAMPLE = "UTC−00:00";

/** Line height of the clock's date and zone line (STUDIO_LINE_HEIGHT). */
const CLOCK_LINE_HEIGHT = 1.15;

/**
 * The city of an IANA zone: its last part with underscores as spaces
 * ("America/Argentina/Buenos_Aires" → "Buenos Aires"); null for zones that
 * name no place ("UTC", "Etc/GMT+3", "EST").
 */
export function zoneCity(timeZone: string): string | null {
  if (timeZone.startsWith("Etc/") || !timeZone.includes("/")) return null;
  const last = timeZone.slice(timeZone.lastIndexOf("/") + 1);
  const city = last.replaceAll("_", " ").trim();
  return city === "" ? null : city;
}

/**
 * The zone's offset from UTC in minutes at `now`, east positive; null for
 * a zone the runtime does not know.
 */
export function zoneOffsetMinutes(timeZone: string, now: Date): number | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    }).formatToParts(now);
  } catch {
    return null;
  }
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value ?? Number.NaN);
  const local = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  if (!Number.isFinite(local)) return null;
  const utc = Math.floor(now.getTime() / 1000) * 1000;
  return Math.round((local - utc) / 60_000);
}

/** "UTC+2", "UTC+5:30", "UTC−3" (a minus sign), "UTC". */
export function formatUtcOffset(minutes: number): string {
  if (minutes === 0) return "UTC";
  const sign = minutes > 0 ? "+" : "−";
  const total = Math.abs(minutes);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return `UTC${sign}${hours}${rest === 0 ? "" : `:${String(rest).padStart(2, "0")}`}`;
}

/**
 * The clock's zone line: "Berlin · UTC+2" (the offset at `now`, so it
 * follows daylight saving time), "UTC" for `Etc/UTC`, "UTC−3" for
 * `Etc/GMT+3`. Never an abbreviation ("CEST"): those differ between ICU
 * and Foundation and by locale. A zone the runtime does not know shows its
 * city (or its name) alone.
 */
export function zoneLabel(timeZone: string, now: Date): string {
  const city = zoneCity(timeZone);
  const minutes = zoneOffsetMinutes(timeZone, now);
  if (minutes === null) return city ?? timeZone;
  const offset = formatUtcOffset(minutes);
  return city === null ? offset : `${city} · ${offset}`;
}

/** The widest zone line of the zone, for the fit: "Berlin · UTC−00:00". */
export function zoneLabelSample(timeZone: string): string {
  const city = zoneCity(timeZone);
  return city === null ? ZONE_OFFSET_SAMPLE : `${city} · ${ZONE_OFFSET_SAMPLE}`;
}

export interface ClockLayoutInput {
  /** Cells of the widget (its type scale). */
  placement: StudioPlacement;
  /** The content box in units (the format's, or the 16:9 reference's). */
  box: { width: number; height: number };
  fontScale?: number;
  showHeader?: boolean;
  /** The time as shown ("14:05", "2:05 PM"); digits count as the widest. */
  time: string;
  showDate: boolean;
  dateStyle: ClockDateStyle;
  /** The zone of the zone line, or null without one (`showZone` off). */
  zone: string | null;
}

export interface ClockLayout {
  /** The time's size in units: at least the clock minimum, as large as fits. */
  time: number;
  /** The date's size, or null when it is off or does not fit. */
  date: number | null;
  /** The zone line's size, or null when it is off or does not fit. */
  zone: number | null;
  /** A part that is on does not fit (the Studio's `clock_parts_hidden`). */
  hidden: boolean;
}

/**
 * The clock's content (ADR 0019, section 9): the time at least 56 units and
 * as large as fits, the date (30, down to 24 to fit its widest sample) and
 * the zone line (24). When the lines do not fit beside the time at its
 * minimum, the zone line goes first, then the date. Uses samples, never the
 * day's text, so the result is the same every day and in the Studio.
 */
export function clockLayout(input: ClockLayoutInput): ClockLayout {
  const scale = effectiveFontScale(input.fontScale);
  const sizes = widgetTypeScale("clock", input.placement, {
    fontScale: scale,
    showHeader: input.showHeader ?? true,
  });
  const box = input.box;
  const timeMin = sizes.clockMin!;
  const dateSize = input.showDate
    ? fitTextSize(CLOCK_DATE_SAMPLES[input.dateStyle], box.width, {
        min: sizes.any!,
        max: sizes.date!,
      })
    : null;
  const zoneSize =
    input.zone !== null &&
    estimateTextWidth(zoneLabelSample(input.zone), sizes.zone!) <= box.width
      ? sizes.zone!
      : null;
  const linesHeight = (date: boolean, zone: boolean) =>
    (date && dateSize !== null ? dateSize * CLOCK_LINE_HEIGHT : 0) +
    (zone && zoneSize !== null ? zoneSize * CLOCK_LINE_HEIGHT : 0);
  const fits = (date: boolean, zone: boolean) =>
    (!date || dateSize !== null) &&
    (!zone || zoneSize !== null) &&
    timeMin + linesHeight(date, zone) <= box.height;
  // The zone line goes first, then the date.
  const wantZone = input.zone !== null;
  const candidates: Array<[boolean, boolean]> = [
    [input.showDate, wantZone],
    [input.showDate, false],
    [false, false],
  ];
  const [showDate, showZone] = candidates.find(([date, zone]) =>
    fits(date, zone),
  ) ?? [false, false];
  const used = linesHeight(showDate, showZone);
  const max = Math.max(timeMin, Math.min(sizes.clockMax!, box.height - used));
  // Widest digits, so the size does not change from minute to minute.
  const sample = input.time.replace(/\d/g, "0");
  const time =
    fitTextSize(sample, box.width, { min: timeMin, max, weight: "semibold" }) ??
    timeMin;
  return {
    time,
    date: showDate ? dateSize : null,
    zone: showZone ? zoneSize : null,
    hidden: showDate !== input.showDate || showZone !== wantZone,
  };
}

// ---------------------------------------------------------------------------
// Countdown (ADR 0019, section 8)

/** The years a countdown's target may lie in. */
export const COUNTDOWN_TARGET_YEARS = { min: 2000, max: 2100 } as const;

const COUNTDOWN_TARGET_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export interface CountdownTargetParts {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * A countdown's target, a local date and time `YYYY-MM-DDTHH:mm`, as its
 * parts; null unless it is a real date (no 30 February) and time in the
 * years 2000–2100.
 */
export function parseCountdownTarget(
  target: string,
): CountdownTargetParts | null {
  const match = COUNTDOWN_TARGET_PATTERN.exec(target);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (
    year < COUNTDOWN_TARGET_YEARS.min ||
    year > COUNTDOWN_TARGET_YEARS.max ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59
  ) {
    return null;
  }
  // The day exists in the month (leap years included).
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day, hour, minute };
}

const DAY_MS = 86_400_000;

/**
 * The instant of a local date and time in a zone: a countdown's `targetAt`
 * in UTC. A time that does not exist (a spring-forward gap) moves forward
 * by the gap: 02:30 on the night Berlin goes from 02:00 to 03:00 is 03:30.
 * A time that exists twice (fall back) takes the earlier offset, so the
 * first 02:30. Null for a target `parseCountdownTarget` refuses; a zone the
 * runtime does not know counts as UTC.
 */
export function zonedInstant(target: string, timeZone: string): Date | null {
  const parts = parseCountdownTarget(target);
  if (!parts) return null;
  const local = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
  );
  const offsetAt = (instant: number) =>
    zoneOffsetMinutes(timeZone, new Date(instant)) ?? 0;
  // A zone changes its offset at most once within a day either side.
  const before = offsetAt(local - DAY_MS);
  const after = offsetAt(local + DAY_MS);
  let found: number | null = null;
  for (const offset of [before, after]) {
    const instant = local - offset * 60_000;
    if (offsetAt(instant) === offset && (found === null || instant < found)) {
      found = instant;
    }
  }
  // In a gap neither offset matches: the offset before the change lands
  // the time after it.
  return new Date(found ?? local - before * 60_000);
}

export type CountdownUnit = "d" | "h" | "m";

/** One number of the time left and its unit: "14" and "h". */
export interface CountdownGroup {
  /** The number as shown: "2", "05" after a larger unit, "< 1". */
  value: string;
  unit: CountdownUnit;
}

export interface CountdownParts {
  /** At or after the target: the widget shows its text when reached. */
  done: boolean;
  /** "2 d 14 h 05 m" as groups; empty once done. */
  groups: CountdownGroup[];
}

/**
 * A screen's minute tick lands just after the minute starts; this much
 * late still counts as on the minute, so 09:00:00.3 to a 10:00 target
 * reads "1 h 00 m", not "59 m".
 */
const COUNTDOWN_TICK_TOLERANCE_MS = 1000;

/**
 * The time left from `now` to `targetAt` in whole minutes: "2 d 14 h 05 m"
 * from one day on, "14 h 05 m" below that, "41 m" below an hour, "< 1 m"
 * in the last minute and done at the target. Numbers after a larger unit
 * have two digits.
 */
export function countdownParts(now: Date, targetAt: Date): CountdownParts {
  const left = targetAt.getTime() - now.getTime();
  if (!(left > 0)) return { done: true, groups: [] };
  const total = Math.floor((left + COUNTDOWN_TICK_TOLERANCE_MS) / 60_000);
  if (total < 1) return { done: false, groups: [{ value: "< 1", unit: "m" }] };
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  const two = (value: number) => String(value).padStart(2, "0");
  if (days > 0) {
    return {
      done: false,
      groups: [
        { value: String(days), unit: "d" },
        { value: two(hours), unit: "h" },
        { value: two(minutes), unit: "m" },
      ],
    };
  }
  if (hours > 0) {
    return {
      done: false,
      groups: [
        { value: String(hours), unit: "h" },
        { value: two(minutes), unit: "m" },
      ],
    };
  }
  return { done: false, groups: [{ value: String(minutes), unit: "m" }] };
}

/** "2 d 14 h 05 m": the groups with their unit letters (English by default). */
export function countdownText(
  groups: readonly CountdownGroup[],
  units: Readonly<Record<CountdownUnit, string>> = { d: "d", h: "h", m: "m" },
): string {
  return groups.map((group) => `${group.value} ${units[group.unit]}`).join(" ");
}

/** Unit letters are a third of the numbers' size, never below the change role. */
export const COUNTDOWN_UNIT_SHARE = 1 / 3;
/** Between a number and its unit letter, as a share of the numbers' size. */
export const COUNTDOWN_UNIT_GAP = 0.08;
/** Between two groups, as a share of the numbers' size. */
export const COUNTDOWN_GROUP_GAP = 0.3;
/** Space between the label, the time left and the target line, in units. */
const COUNTDOWN_STACK_GAP = 8;
/** Line height of the label, the target line and the text when reached. */
const COUNTDOWN_LINE_HEIGHT = 1.15;

export interface CountdownLayoutInput {
  /** Cells of the widget (its type scale). */
  placement: StudioPlacement;
  /** The content box in units (the format's, or the 16:9 reference's). */
  box: { width: number; height: number };
  fontScale?: number;
  showHeader?: boolean;
  /** The label as shown: the title, or the localised "Countdown". */
  label: string;
  /**
   * The time left with the unit letters in the screen's language ("14",
   * "Std"); empty once done. Digits count as the widest.
   */
  groups: ReadonlyArray<{ value: string; unit: string }>;
  /** The target line ("Tue 7 Oct · 10:00"), or null when it is off. */
  target: string | null;
  /** Once done: the text when reached ("Now"); else null. */
  doneText: string | null;
}

export interface CountdownLayout {
  /** Sizes in units. `value` is the numbers', `unit` their letters'. */
  sizes: {
    title: number;
    resource: number;
    target: number;
    value: number;
    unit: number;
    done: number;
  };
  /** Lines of the title (1–2) and of the resource line (0–2). */
  titleLines: number;
  resourceLines: number;
  /** Between a number and its letter, and between groups, in units. */
  unitGap: number;
  groupGap: number;
  /** The target line is on and fits below the time left. */
  showTarget: boolean;
  /** Lines the text when reached takes at `sizes.done`; 0 before. */
  doneLines: number;
}

/**
 * The countdown's content (ADR 0019, section 8): the label, the time left
 * as numbers (the value role: at least 64 units and as large as fits, sized
 * on their widest digits) with unit letters a third of their size (at least
 * the change role, 28), and the target line (24) below; once done, the text
 * when reached at heading size (56, smaller only to fit the box) instead of
 * the numbers. The target line goes when the numbers at their minimum leave
 * no room for it.
 */
export function countdownLayout(input: CountdownLayoutInput): CountdownLayout {
  const scale = effectiveFontScale(input.fontScale);
  const sizes = widgetTypeScale("countdown", input.placement, {
    fontScale: scale,
    showHeader: input.showHeader ?? true,
  });
  const width = Math.max(0, input.box.width);
  const height = input.box.height;
  const title = sizes.title!;
  const resource = sizes.resource!;
  const target = sizes.any!;
  const unitMin = sizes.change!;
  const valueMin = sizes.valueMin!;
  const heading = sizes.heading!;

  const parts = labelParts(input.label);
  const titleLines = Math.min(
    STUDIO_LABEL_MAX_LINES,
    Math.max(1, wrappedLineCount(parts.title, width, title, "semibold")),
  );
  const resourceLines =
    parts.resource === null
      ? 0
      : Math.min(
          STUDIO_LABEL_MAX_LINES,
          Math.max(
            1,
            wrappedLineCount(parts.resource, width, resource, "semibold"),
          ),
        );
  const labelHeight =
    titleLines * title * COUNTDOWN_LINE_HEIGHT +
    resourceLines * resource * COUNTDOWN_LINE_HEIGHT;
  const targetHeight = COUNTDOWN_STACK_GAP + target * COUNTDOWN_LINE_HEIGHT;
  const done = input.doneText !== null;

  // What the target line needs beside the label and the smallest middle.
  const middleMin = done ? heading * COUNTDOWN_LINE_HEIGHT : valueMin;
  const showTarget =
    input.target !== null &&
    labelHeight + COUNTDOWN_STACK_GAP + middleMin + targetHeight <= height;
  const middle =
    height -
    labelHeight -
    COUNTDOWN_STACK_GAP -
    (showTarget ? targetHeight : 0);

  // The text when reached: heading size, wrapped, smaller only to fit.
  let doneSize = heading;
  let doneLines = 0;
  if (done) {
    const text = input.doneText ?? "";
    const floor = Math.min(target, heading);
    const linesAt = (size: number) =>
      Math.max(1, wrappedLineCount(text, width, size, "semibold"));
    doneSize = floor;
    for (let size = heading; size > floor; size -= 1) {
      if (linesAt(size) * size * COUNTDOWN_LINE_HEIGHT <= middle) {
        doneSize = size;
        break;
      }
    }
    doneLines = linesAt(doneSize);
  }

  // The numbers: W(v) = a·v + b·max(unitMin, k·v) for the widest digits.
  let numbers = 0;
  let letters = 0;
  for (const group of input.groups) {
    numbers += estimateTextWidth(
      group.value.replace(/\d/g, "0"),
      1,
      "semibold",
    );
    letters += estimateTextWidth(group.unit, 1);
  }
  const count = input.groups.length;
  const a =
    count === 0
      ? 0
      : numbers +
        COUNTDOWN_UNIT_GAP * count +
        COUNTDOWN_GROUP_GAP * (count - 1);
  const b = letters;
  const k = COUNTDOWN_UNIT_SHARE;
  const valueMax = Math.max(valueMin, Math.min(sizes.valueMax!, middle));
  let value = valueMax;
  if (a > 0) {
    const knee = unitMin / k;
    const fit =
      a * knee + b * unitMin <= width
        ? width / (a + b * k)
        : (width - b * unitMin) / a;
    value = Math.max(valueMin, Math.min(valueMax, fit));
  }
  const unit = Math.max(unitMin, k * value);
  return {
    sizes: {
      title,
      resource,
      target,
      value,
      unit,
      done: doneSize,
    },
    titleLines,
    resourceLines,
    unitGap: COUNTDOWN_UNIT_GAP * value,
    groupGap: COUNTDOWN_GROUP_GAP * value,
    showTarget,
    doneLines,
  };
}

/** The module as one object, as ADR 0015 names it (`studioLayout.fits`). */
export const studioLayout = {
  canvasUnit,
  studioFrame,
  widgetRect,
  formatFor,
  sizeClassFor,
  screenFrame,
  placementRect,
  isInsideFormatGrid,
  isInsideGrid,
  meetsMinimumSize,
  placementsOverlap,
  findOverlaps,
  widgetTypeScale,
  textWidgetSizes,
  estimateTextWidth,
  wrappedLineCount,
  fitTextSize,
  labelParts,
  labelFit,
  fits: labelFits,
  tableLayout,
  tableRowsShown,
  tableRowLabel,
  tableChangeKind,
  statusLayout,
  statusRowsShown,
  statusRowLabel,
  statusAge,
  gaugeLayout,
  reviewLayout,
  reviewStarsFilled,
  legacyGrid,
  legacyLayout,
  parseTextWidget,
  compactNumber,
  zoneLabel,
  clockLayout,
  zonedInstant,
  countdownParts,
  countdownLayout,
} as const;
