/**
 * Layout and readability rules for Dashboard Studio slides (ADR 0015,
 * section 8): where widgets go on a canvas, how large their text is, whether
 * a label fits, the automatic layout for migrated tiles, the text widget's
 * markdown-lite and the compact number form.
 *
 * Written once here and ported to Swift (apps/tvos/NetricsKit,
 * StudioLayout.swift). Both test suites run the same vectors
 * (packages/domain/test-vectors/studio-layout.json), so keep every function
 * pure and its arithmetic in the same order on both sides.
 *
 * Sizes are in canvas units: u = canvas height / 1080, so 1080p and 4K read
 * the same. Functions that take a canvas answer in canvas pixels; the type
 * scale answers in units (multiply by `canvasUnit`).
 */

export type StudioWidgetType =
  "metric" | "line" | "bar" | "image" | "text" | "clock";

export const STUDIO_WIDGET_TYPES: readonly StudioWidgetType[] = [
  "metric",
  "line",
  "bar",
  "image",
  "text",
  "clock",
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
};

/** Widgets with a title and resource line (bound to a metric). */
export function isDataWidget(type: StudioWidgetType): boolean {
  return type === "metric" || type === "line" || type === "bar";
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
 * form, see `fitTextSize`); `clockMin`/`clockMax` the clock's time.
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
  | "date";

export type StudioTypeScale = Partial<Record<StudioTextRole, number>>;

/** Share of a widget's content height the value may take at most. */
const VALUE_HEIGHT_SHARE: Readonly<Record<"metric" | "line" | "bar", number>> =
  {
    metric: 0.36,
    line: 0.2,
    bar: 0.2,
  };
const CLOCK_HEIGHT_SHARE = 0.6;

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
): number {
  const words = text.split(" ").filter((word) => word !== "");
  const space = estimateTextWidth(" ", fontSize, weight);
  let lines = 0;
  let current = 0;
  let empty = true;
  for (const word of words) {
    const width = estimateTextWidth(word, fontSize, weight);
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
      const charWidth = estimateTextWidth(char, fontSize, weight);
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
 * How a data widget's label wraps at 1080p: the title and the resource line
 * (both semibold, at their minimum times the font scale) in the widget's
 * width less its padding. Widgets without a label always fit.
 */
export function labelFit(
  label: string,
  widget: { type: StudioWidgetType; w: number; h: number },
  options: { fontScale?: number } = {},
): StudioLabelFit {
  if (!isDataWidget(widget.type)) {
    return { fits: true, titleLines: 0, resourceLines: 0 };
  }
  const scale = effectiveFontScale(options.fontScale);
  const rect = widgetRect(
    { x: 0, y: 0, w: widget.w, h: widget.h },
    STUDIO_REFERENCE_CANVAS,
    true,
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
  options: { fontScale?: number } = {},
): boolean {
  return labelFit(label, widget, options).fits;
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

/** The module as one object, as ADR 0015 names it (`studioLayout.fits`). */
export const studioLayout = {
  canvasUnit,
  studioFrame,
  widgetRect,
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
  legacyGrid,
  legacyLayout,
  parseTextWidget,
  compactNumber,
} as const;
