import {
  SCREEN_FORMATS,
  STUDIO_HEADER_BAND,
  STUDIO_WIDGET_TYPES,
  completeCustomLayout,
  formatFor,
  placementRect,
  screenFrame,
  slideLayoutFor,
  type CustomLayout,
  type LayoutPlacement,
  type LayoutWidget,
  type ScreenFormat,
  type StudioPlacement,
  type StudioRect,
  type StudioWidgetType,
} from "@netrics/domain";

import { widgetBoxStyle } from "./studio-render";

// Screen view on any screen (ADR 0017, sections 2, 3 and 11): the format
// from the real size, the slide's layout for that format (the primary, a
// custom layout or the auto reflow, with continuation pages) and where the
// header and widgets go on the screen. Pure, so it is tested without a
// browser; SlideCanvas and SlidePlayer measure the screen and render this.

export interface ScreenSize {
  width: number;
  height: number;
}

/** A widget as the layout needs it: id, type and primary placement. */
export interface ScreenWidget extends StudioPlacement {
  id: string;
  type: string;
}

/** A slide's custom layouts as the dashboard document carries them. */
export type SlideLayouts = ReadonlyArray<{
  format: ScreenFormat;
  pages: number;
  placements: ReadonlyArray<
    StudioPlacement & {
      widgetId: string;
      page: number;
      hidden: boolean;
      autoPlaced?: boolean;
    }
  >;
}>;

/** A usable measured size: both sides positive and finite. */
export function usableSize(size: ScreenSize | null | undefined): boolean {
  return (
    !!size &&
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width > 0 &&
    size.height > 0
  );
}

/** The screen's format, `16x9` until it has a usable size. */
export function screenFormatOf(
  size: ScreenSize | null | undefined,
): ScreenFormat {
  return size && usableSize(size) ? formatFor(size.width, size.height) : "16x9";
}

/**
 * A widget type the layout knows: a type from a newer server is laid out
 * as the smallest widget (its box shows a notice, ADR 0015 section 7).
 */
function layoutType(type: string): StudioWidgetType {
  return (STUDIO_WIDGET_TYPES as readonly string[]).includes(type)
    ? (type as StudioWidgetType)
    : "image";
}

/** The widgets as the layout functions take them. */
export function layoutWidgets(
  widgets: readonly ScreenWidget[],
): LayoutWidget[] {
  return widgets.map(({ id, type, x, y, w, h }) => ({
    id,
    type: layoutType(type),
    x,
    y,
    w,
    h,
  }));
}

/**
 * The slide's stored custom layout for `format`, completed against its
 * current widgets as the server would on save (a draft may have widgets
 * the stored layout does not know: they are placed and flagged for
 * review); null in the primary format or without a custom layout.
 */
export function completedLayout(
  primary: readonly LayoutWidget[],
  options: {
    primaryFormat: ScreenFormat;
    format: ScreenFormat;
    layouts?: SlideLayouts | null;
  },
): CustomLayout | null {
  const { primaryFormat, format } = options;
  const stored =
    format === primaryFormat
      ? undefined
      : options.layouts?.find((layout) => layout.format === format);
  return stored
    ? completeCustomLayout(
        {
          pages: stored.pages,
          placements: stored.placements.map((placement) => ({
            id: placement.widgetId,
            page: placement.page,
            x: placement.x,
            y: placement.y,
            w: placement.w,
            h: placement.h,
            hidden: placement.hidden,
            autoPlaced: placement.autoPlaced ?? false,
          })),
        },
        { format: primaryFormat, widgets: primary },
        format,
      )
    : null;
}

/**
 * The pages of a slide on a screen of `format` (ADR 0017, sections 3 and
 * 4): one page in the primary format; else the slide's custom layout for
 * the format, completed against its current widgets as the server would
 * (a draft in Play may have widgets the stored layout does not know), or
 * the auto reflow. Hidden widgets are left out; every page has at least
 * nothing, so a slide always has one page.
 */
export function slidePages(
  widgets: readonly ScreenWidget[],
  options: {
    primaryFormat: ScreenFormat;
    format: ScreenFormat;
    layouts?: SlideLayouts | null;
  },
): LayoutPlacement[][] {
  const { primaryFormat, format } = options;
  const primary = layoutWidgets(widgets);
  const pages = slideLayoutFor({
    widgets: primary,
    primaryFormat,
    format,
    custom: completedLayout(primary, options),
  });
  return pages.length > 0 ? pages : [[]];
}

/** "2/3" for the second of three pages; null for a single page. */
export function pageLabel(page: number, pages: number): string | null {
  return pages > 1 ? `${page + 1}/${pages}` : null;
}

/** A box on the screen as CSS, in percentages of the screen. */
export interface ScreenBox {
  left: string;
  top: string;
  width: string;
  height: string;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function percent(part: number, whole: number): string {
  return `${round((part / whole) * 100 * 1000) / 1000}%`;
}

function boxOf(rect: StudioRect, screen: ScreenSize): ScreenBox {
  return {
    left: percent(rect.x, screen.width),
    top: percent(rect.y, screen.height),
    width: percent(rect.width, screen.width),
    height: percent(rect.height, screen.height),
  };
}

/**
 * How far a 16:9 screen may be from 16:9 and still render exactly as
 * before ADR 0017 (a measured box rounds to whole pixels).
 */
const IDENTITY_TOLERANCE = 0.01;

/**
 * True when the screen renders exactly as before ADR 0017: the `16x9`
 * format on a 16:9 screen (or one not measured yet). Positions are then
 * the 16:9 percentages and the unit `100cqw / 1920`, unchanged.
 */
export function isClassicCanvas(
  screen: ScreenSize | null,
  format: ScreenFormat,
): boolean {
  if (format !== "16x9") return false;
  if (!screen || !usableSize(screen)) return true;
  const aspect = screen.width / screen.height;
  return Math.abs(aspect / (16 / 9) - 1) <= IDENTITY_TOLERANCE;
}

/** A widget's place on the screen and its content room in units. */
export interface WidgetGeometry {
  box: ScreenBox;
  /**
   * The widget's box in units when it differs from its box at the 16:9
   * reference canvas (another format, a stretched grid); null for the
   * classic canvas, where widgets measure themselves as before.
   */
  unitBox: { width: number; height: number } | null;
}

export interface CanvasGeometry {
  format: ScreenFormat;
  /** Rendered exactly as before ADR 0017 (see `isClassicCanvas`). */
  classic: boolean;
  /** Pixels per unit, null on the classic canvas (CSS computes it). */
  unit: number | null;
  /**
   * The header band, null without the header: its height alone on the
   * classic canvas (the band spans the width, as before).
   */
  header: ScreenBox | { height: string } | null;
  widget(placement: StudioPlacement): WidgetGeometry;
}

/**
 * Where a slide goes on a screen of `screen` (CSS pixels) in `format`
 * (ADR 0017, section 2): the format's grid over the whole screen, stretched
 * at most 4/3, else the capped canvas centred (the screen's background, the
 * theme's, shows as bars). Without a measured size the format's reference
 * canvas stands in.
 */
export function canvasGeometry(
  screen: ScreenSize | null,
  format: ScreenFormat,
  showHeader: boolean,
): CanvasGeometry {
  if (isClassicCanvas(screen, format)) {
    return {
      format,
      classic: true,
      unit: null,
      header: showHeader ? { height: `${STUDIO_HEADER_BAND * 100}%` } : null,
      widget: (placement) => ({
        box: widgetBoxStyle(placement, showHeader),
        unitBox: null,
      }),
    };
  }
  const size =
    screen && usableSize(screen) ? screen : SCREEN_FORMATS[format].reference;
  const frame = screenFrame(size, format, showHeader);
  return {
    format,
    classic: false,
    unit: frame.unit,
    header: frame.header ? boxOf(frame.header, size) : null,
    widget: (placement) => {
      const rect = placementRect(placement, frame);
      return {
        box: boxOf(rect, size),
        unitBox: {
          width: rect.width / frame.unit,
          height: rect.height / frame.unit,
        },
      };
    },
  };
}
