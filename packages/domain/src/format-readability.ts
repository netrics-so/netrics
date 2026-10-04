/**
 * Readability per screen format (ADR 0017, section 6): the rules of ADR
 * 0015 section 8, checked for a slide in every format, auto or custom.
 *
 * `formatWarnings` is what the dashboard API returns per slide and the
 * Studio shows as badges per format. It is pure and cheap (a few hundred
 * width estimates per slide), so the server computes it on every GET.
 *
 * The text widget fit (`textWidgetFit`) and the header fit (`headerFit`)
 * are the renderers' rules too: the web renders text widgets with
 * `textWidgetFit`, and the header rule for narrow formats (the dashboard
 * name wraps to two lines before it shrinks, the slide name is dropped
 * before the name is cut) is specified here for both renderers.
 */
import {
  slideLayoutFor,
  studioReadingOrder,
  type CustomLayout,
  type LayoutPlacement,
  type LayoutWidget,
} from "./screen-formats.js";
import {
  SCREEN_FORMATS,
  clockLayout,
  SCREEN_FORMAT_KEYS,
  STUDIO_MIN_WIDGET_SIZE,
  STUDIO_SPACING,
  estimateTextWidth,
  hasWidgetLabel,
  isInsideFormatGrid,
  labelFit,
  parseTextWidget,
  placementRect,
  screenFrame,
  tableLayout,
  textWidgetSizes,
  wrappedLineCount,
  type ClockDateStyle,
  type ScreenFormat,
  type StudioPlacement,
  type StudioTextBlock,
  type StudioTextSize,
} from "./studio-layout.js";

/** Line height of titles, labels and text, as a multiple of the size. */
export const STUDIO_LINE_HEIGHT = 1.15;

// ---------------------------------------------------------------------------
// Text widgets

/** A widget's content box in units at the format's reference canvas. */
export function contentBoxIn(
  placement: StudioPlacement,
  format: ScreenFormat,
  showHeader: boolean,
): { width: number; height: number } {
  const rect = placementRect(
    placement,
    screenFrame(SCREEN_FORMATS[format].reference, format, showHeader),
  );
  return {
    width: rect.width - 2 * STUDIO_SPACING.widgetPadding,
    height: rect.height - 2 * STUDIO_SPACING.widgetPadding,
  };
}

const SMALLER: Readonly<Record<StudioTextSize, StudioTextSize | null>> = {
  display: "heading",
  heading: "body",
  body: null,
};

function spansText(spans: ReadonlyArray<{ text: string }>): string {
  return spans.map((span) => span.text).join("");
}

/** The height of text blocks wrapped into `width`, in units. */
export function textBlocksHeight(
  blocks: readonly StudioTextBlock[],
  width: number,
  sizes: { paragraph: number; heading1: number; heading2: number },
): number {
  let height = 0;
  blocks.forEach((block, index) => {
    if (index > 0) height += sizes.paragraph * 0.5;
    if (block.kind === "heading") {
      const size = block.level === 1 ? sizes.heading1 : sizes.heading2;
      height +=
        wrappedLineCount(spansText(block.spans), width, size, "bold") *
        size *
        STUDIO_LINE_HEIGHT;
      return;
    }
    for (const line of block.lines) {
      height +=
        Math.max(
          1,
          wrappedLineCount(spansText(line), width, sizes.paragraph, "bold"),
        ) *
        sizes.paragraph *
        STUDIO_LINE_HEIGHT;
    }
  });
  return height;
}

export interface TextWidgetFit {
  blocks: StudioTextBlock[];
  /** The size the text is shown at. */
  size: StudioTextSize;
  sizes: { paragraph: number; heading1: number; heading2: number };
  /** Even body size does not fit: the end is cut off (the Studio warns). */
  overflow: boolean;
}

/**
 * A text widget's blocks and sizes at the format's reference canvas
 * (`16x9`, 1080p, by default): its size option when the text fits
 * (estimated with the conservative glyph widths, bold), else the next
 * smaller option down to body. Never below the minimums.
 */
export function textWidgetFit(input: {
  text: string;
  size: StudioTextSize;
  placement: StudioPlacement;
  fontScale: number;
  showHeader: boolean;
  format?: ScreenFormat;
}): TextWidgetFit {
  const blocks = parseTextWidget(input.text);
  const box = contentBoxIn(
    input.placement,
    input.format ?? "16x9",
    input.showHeader,
  );
  let size: StudioTextSize = input.size;
  for (;;) {
    const sizes = textWidgetSizes(size, input.fontScale);
    const fits = textBlocksHeight(blocks, box.width, sizes) <= box.height;
    const next = SMALLER[size];
    if (fits || next === null) {
      return { blocks, size, sizes, overflow: !fits };
    }
    size = next;
  }
}

// ---------------------------------------------------------------------------
// Header

/** The header's sizes in units (both renderers). */
export const STUDIO_HEADER_METRICS = {
  /** The dashboard name, semibold. */
  name: 36,
  /** The slide name and the clock. */
  meta: 30,
  /** Left and right padding. */
  padding: 32,
  /** Between logo, names and the clock. */
  gap: 20,
  /** At least this much space before the clock. */
  clockSpace: 24,
  /** The logo's height. */
  logo: 48,
} as const;

/** Formats whose header may wrap the dashboard name to two lines. */
export const NARROW_HEADER_FORMATS: readonly ScreenFormat[] = ["3x4", "9x16"];

/** The widest clock text the header reserves room for. */
const CLOCK_SAMPLE = "12:00 PM";

export interface HeaderFit {
  /** The width the names share, in units. */
  width: number;
  /** Lines the dashboard name takes at its full size. */
  nameLines: number;
  /** 1, or 2 in narrow formats. */
  maxNameLines: number;
  /** The slide name fits beside a one-line dashboard name; else dropped. */
  showSlideName: boolean;
  /** The dashboard name shows in full at its size (no shrinking or cut). */
  fits: boolean;
}

/**
 * How the header fits at the format's reference canvas: the logo (48 units
 * high, at its aspect ratio), the dashboard name (36, semibold), the slide
 * name (30) and the clock (30, room for "12:00 PM") with the paddings and
 * gaps. In narrow formats (`3x4`, `9x16`) the dashboard name wraps to two
 * lines before it shrinks; the slide name is shown only when it fits in
 * full beside a one-line name, so it is dropped before the name is cut.
 */
export function headerFit(input: {
  name: string;
  slideName: string | null;
  format: ScreenFormat;
  /** Width / height of the logo image, or null without a logo. */
  logoAspect: number | null;
}): HeaderFit {
  const m = STUDIO_HEADER_METRICS;
  const aspect =
    input.logoAspect !== null &&
    Number.isFinite(input.logoAspect) &&
    input.logoAspect > 0
      ? input.logoAspect
      : null;
  const width =
    SCREEN_FORMATS[input.format].reference.width -
    2 * m.padding -
    (aspect === null ? 0 : m.logo * aspect + m.gap) -
    (2 * m.gap + m.clockSpace) -
    estimateTextWidth(CLOCK_SAMPLE, m.meta);
  const maxNameLines = NARROW_HEADER_FORMATS.includes(input.format) ? 2 : 1;
  const name = input.name.trim();
  const nameLines = Math.max(
    1,
    wrappedLineCount(name, Math.max(0, width), m.name, "semibold"),
  );
  const slideName = input.slideName?.trim() ?? "";
  const showSlideName =
    slideName !== "" &&
    nameLines === 1 &&
    estimateTextWidth(name, m.name, "semibold") +
      m.gap +
      estimateTextWidth(slideName, m.meta) <=
      width;
  return {
    width,
    nameLines,
    maxNameLines,
    showSlideName,
    fits: width > 0 && nameLines <= maxNameLines,
  };
}

// ---------------------------------------------------------------------------
// Warnings per format

export type FormatWarningCode =
  /** A data widget's title or resource line would need more than two lines. */
  | "label_cut"
  /** A text widget's text does not fit even at body size. */
  | "text_cut"
  /** The slide needs continuation pages in the format (see `pages`). */
  | "continues"
  /** The widget is hidden in the format's custom layout. */
  | "widget_hidden"
  /** The widget was placed automatically in the custom layout: to review. */
  | "widget_to_review"
  /** A custom placement is below its type's minimum (the server refuses these). */
  | "widget_too_small"
  /** The dashboard name does not fit the header. */
  | "header_name_cut"
  /** A clock's date or zone line does not fit, so the screen leaves it out. */
  | "clock_parts_hidden"
  /** A table's `limit` exceeds the rows that fit (see `rows`). */
  | "rows_cut";

export const FORMAT_WARNING_CODES: readonly FormatWarningCode[] = [
  "label_cut",
  "text_cut",
  "continues",
  "widget_hidden",
  "widget_to_review",
  "widget_too_small",
  "header_name_cut",
  "clock_parts_hidden",
  "rows_cut",
];

/**
 * `attention`: something on the screen is cut off, too small or waits for
 * review: the Studio counts these ("3 formats need attention"). `info`: a
 * consequence of the layout the Studio shows without alarm (continuation
 * pages, which are never truncation, widgets the user hid, and clock
 * lines left out for room).
 */
export type FormatWarningSeverity = "attention" | "info";

export const FORMAT_WARNING_SEVERITY: Readonly<
  Record<FormatWarningCode, FormatWarningSeverity>
> = {
  label_cut: "attention",
  text_cut: "attention",
  continues: "info",
  widget_hidden: "info",
  widget_to_review: "attention",
  widget_too_small: "attention",
  header_name_cut: "attention",
  clock_parts_hidden: "info",
  // Tables (ADR 0019 section 6); a status board's will be info.
  rows_cut: "attention",
};

export interface FormatWarningItem {
  format: ScreenFormat;
  code: FormatWarningCode;
  severity: FormatWarningSeverity;
  /** The widget concerned, or null for the slide (pages, header). */
  widgetId: string | null;
  /** `continues`: how many pages the slide takes; else null. */
  pages: number | null;
  /** `rows_cut`: the rows shown of the rows asked for ("4 of 8"); else null. */
  rows: { shown: number; limit: number } | null;
}

/** A widget of a slide as the checks need it. */
export interface ReadabilityWidget extends LayoutWidget {
  /** Data widgets: the label as screens show it ("Downloads · Wurfel"). */
  label?: string | null;
  /** Text widgets: the text and its size option. */
  text?: string | null;
  textSize?: StudioTextSize | null;
  /**
   * Clock widgets: the date and zone line options, the zone resolved (the
   * widget's, else the workspace's); null without a zone line.
   */
  clock?: {
    showDate: boolean;
    dateStyle: ClockDateStyle;
    zone: string | null;
  } | null;
  /** Tables: the rows asked for (`limit`). */
  rows?: number | null;
}

export interface ReadabilitySlide {
  name: string | null;
  /** Placed in the primary format. */
  widgets: readonly ReadabilityWidget[];
  /** Custom layouts by format. */
  layouts: Partial<Record<ScreenFormat, CustomLayout>>;
}

export interface ReadabilityContext {
  primaryFormat: ScreenFormat;
  /** The theme's font scale. */
  fontScale: number;
  showHeader: boolean;
  /** The dashboard's name, for the header. */
  dashboardName: string;
  /** The logo's width / height, null without a logo. */
  logoAspect: number | null;
}

/**
 * The readability warnings of a slide in one format, in a stable order:
 * the header, continuation pages, then the widgets in the primary's reading
 * order (hidden, to review, too small, label, text or rows cut off,
 * clock lines left out).
 * Labels, text and table rows are measured at the format's reference
 * canvas with the size the widget has in that format's layout (auto or
 * custom).
 */
export function formatWarnings(
  slide: ReadabilitySlide,
  format: ScreenFormat,
  context: ReadabilityContext,
): FormatWarningItem[] {
  const warnings: FormatWarningItem[] = [];
  const warn = (
    code: FormatWarningCode,
    widgetId: string | null,
    pages: number | null = null,
    rows: FormatWarningItem["rows"] = null,
  ) =>
    warnings.push({
      format,
      code,
      severity: FORMAT_WARNING_SEVERITY[code],
      widgetId,
      pages,
      rows,
    });

  if (
    context.showHeader &&
    !headerFit({
      name: context.dashboardName,
      slideName: slide.name,
      format,
      logoAspect: context.logoAspect,
    }).fits
  ) {
    warn("header_name_cut", null);
  }

  const custom =
    format === context.primaryFormat ? null : (slide.layouts[format] ?? null);
  const pages = slideLayoutFor({
    widgets: slide.widgets,
    primaryFormat: context.primaryFormat,
    format,
    custom,
  });
  if (pages.length > 1) {
    warn("continues", null, Math.min(pages.length, 99));
  }

  const placed = new Map<string, LayoutPlacement>();
  for (const page of pages) {
    for (const placement of page) placed.set(placement.id, placement);
  }
  const customById = new Map(
    (custom?.placements ?? []).map((placement) => [placement.id, placement]),
  );

  for (const widget of studioReadingOrder(slide.widgets)) {
    const own = customById.get(widget.id);
    if (own?.hidden) {
      warn("widget_hidden", widget.id);
      continue;
    }
    if (own?.autoPlaced) {
      warn("widget_to_review", widget.id);
    }
    const placement = placed.get(widget.id);
    if (!placement) continue;
    const minimum = STUDIO_MIN_WIDGET_SIZE[widget.type];
    if (
      own &&
      (placement.w < minimum.w ||
        placement.h < minimum.h ||
        !isInsideFormatGrid(placement, format))
    ) {
      warn("widget_too_small", widget.id);
    }
    if (hasWidgetLabel(widget.type) && widget.label) {
      const fit = labelFit(
        widget.label,
        { type: widget.type, w: placement.w, h: placement.h },
        { fontScale: context.fontScale, format },
      );
      if (!fit.fits) warn("label_cut", widget.id);
    }
    if (widget.type === "table" && widget.rows) {
      const box = contentBoxIn(placement, format, context.showHeader);
      const { rowCapacity } = tableLayout({
        label: widget.label ?? "",
        width: box.width,
        height: box.height,
        fontScale: context.fontScale,
      });
      if (widget.rows > rowCapacity) {
        warn("rows_cut", widget.id, null, {
          shown: rowCapacity,
          limit: widget.rows,
        });
      }
    } else if (widget.type === "text" && widget.text) {
      const fit = textWidgetFit({
        text: widget.text,
        size: widget.textSize ?? "body",
        placement,
        fontScale: context.fontScale,
        showHeader: context.showHeader,
        format,
      });
      if (fit.overflow) warn("text_cut", widget.id);
    } else if (widget.type === "clock" && widget.clock) {
      const fit = clockLayout({
        placement,
        box: contentBoxIn(placement, format, context.showHeader),
        fontScale: context.fontScale,
        showHeader: context.showHeader,
        time: "00:00",
        ...widget.clock,
      });
      if (fit.hidden) warn("clock_parts_hidden", widget.id);
    }
  }
  return warnings;
}

/**
 * Every format's warnings for a slide, formats in `SCREEN_FORMAT_KEYS`
 * order (widest first).
 */
export function slideFormatWarnings(
  slide: ReadabilitySlide,
  context: ReadabilityContext,
): FormatWarningItem[] {
  return SCREEN_FORMAT_KEYS.flatMap((format) =>
    formatWarnings(slide, format, context),
  );
}

/**
 * The formats with at least one `attention` warning on any slide, in
 * `SCREEN_FORMAT_KEYS` order ("3 formats need attention").
 */
export function formatsNeedingAttention(
  slides: ReadonlyArray<{
    formatWarnings: ReadonlyArray<{
      format: ScreenFormat;
      severity: FormatWarningSeverity;
    }>;
  }>,
): ScreenFormat[] {
  const found = new Set<ScreenFormat>();
  for (const slide of slides) {
    for (const warning of slide.formatWarnings) {
      if (warning.severity === "attention") found.add(warning.format);
    }
  }
  return SCREEN_FORMAT_KEYS.filter((format) => found.has(format));
}
