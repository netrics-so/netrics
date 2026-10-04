import type {
  ConnectionStateView,
  DashboardSettings,
  DashboardSlide,
  DashboardWidget,
  WorkspaceMetric,
} from "@netrics/contracts";
import {
  textWidgetFit,
  type Locale,
  type StudioTextSize,
  type TextWidgetFit,
} from "@netrics/domain";

import { webTranslator } from "./i18n/catalogs";
import type { ScreenPlacement } from "./studio-render";

// The studio's widgets as the web renders them (ADR 0015, sections 1–2).

/** The latest-review widget (ADR 0019 section 12). */
export type ReviewWidget = Extract<DashboardWidget, { type: "review" }>;

/** The image widget (#217). */
export type ImageWidget = Extract<DashboardWidget, { type: "image" }>;

/** Every widget a slide can hold. */
export type StudioWidget = DashboardWidget;

export type DataWidget = Extract<
  StudioWidget,
  { type: "metric" | "line" | "bar" | "table" | "compare" }
>;

/** A workspace image as the renderers need it (#217). */
export interface StudioImage {
  id: string;
  url: string;
  width: number;
  height: number;
}

export type StudioImages = ReadonlyMap<string, StudioImage>;

/** Where a signed-in browser loads an image's bytes (ADR 0015, section 5). */
export function imageContentUrl(
  workspaceId: string,
  image: { id: string; sha256: string },
): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/images/${encodeURIComponent(image.id)}/content?v=${encodeURIComponent(image.sha256)}`;
}

const ORIGIN_PROBE = "https://origin.invalid";

/**
 * The URL a page loads an image from: the API's own `url` when it is a
 * same-origin path under /v1/ (the web proxy serves it with the session
 * cookie), else the content URL built here. An absolute or
 * protocol-relative URL is never used, so a listing cannot point the page
 * at another origin.
 */
export function studioImageUrl(
  workspaceId: string,
  image: { id: string; sha256: string; url?: string | null },
): string {
  const url = image.url;
  if (url && url.startsWith("/v1/") && !url.includes("\\")) {
    try {
      const parsed = new URL(url, ORIGIN_PROBE);
      if (parsed.origin === ORIGIN_PROBE) {
        return parsed.pathname + parsed.search;
      }
    } catch {
      // Not a URL: fall through to the built one.
    }
  }
  return imageContentUrl(workspaceId, image);
}

/** A listed workspace image as the renderers need it. */
export function toStudioImage(
  workspaceId: string,
  image: {
    id: string;
    sha256: string;
    width: number;
    height: number;
    url?: string | null;
  },
): StudioImage {
  return {
    id: image.id,
    url: studioImageUrl(workspaceId, image),
    width: image.width,
    height: image.height,
  };
}

/** A slide's background image and dim (#217), or null. */
export function slideBackground(
  slide: Pick<DashboardSlide, "background">,
): { imageId: string; dim: number } | null {
  const background = slide.background;
  if (!background) {
    return null;
  }
  return {
    imageId: background.imageId,
    dim: Math.min(80, Math.max(0, background.dim)),
  };
}

/** The dashboard's logo image (#217), or null. */
export function logoImageId(
  settings: Pick<DashboardSettings, "logoImageId">,
): string | null {
  return settings.logoImageId;
}

/** Every image a dashboard's slides show: logo, backgrounds, widgets. */
export function referencedImageIds(dashboard: {
  settings: Pick<DashboardSettings, "logoImageId">;
  slides: ReadonlyArray<Pick<DashboardSlide, "background" | "widgets">>;
}): string[] {
  const ids = new Set<string>();
  const logo = logoImageId(dashboard.settings);
  if (logo) ids.add(logo);
  for (const slide of dashboard.slides) {
    const background = slideBackground(slide);
    if (background) ids.add(background.imageId);
    for (const widget of slide.widgets) {
      if (widget.type === "image") ids.add(widget.imageId);
      // A latest review's app icon (ADR 0019 section 12).
      if (widget.type === "review" && widget.imageId) ids.add(widget.imageId);
    }
  }
  return [...ids];
}

/** "Sales", or "Slide 2" for a slide without a name. */
export function slideTitle(
  slide: { name: string | null },
  index: number,
  locale: Locale,
): string {
  return (
    slide.name ??
    webTranslator(locale, "studio.document")("slide", { number: index + 1 })
  );
}

/** A text widget's blocks and sizes; see the domain's `textWidgetFit`. */
export type TextWidgetLayout = TextWidgetFit;

/**
 * A text widget's blocks and sizes at 1080p: its size option when the text
 * fits (estimated with the conservative glyph widths, bold), else the next
 * smaller option down to body. Never below the minimums. The rule is the
 * domain's, which the server's readability checks use per format (#280).
 */
export function textWidgetLayout(input: {
  text: string;
  size: StudioTextSize;
  placement: ScreenPlacement;
  fontScale: number;
  showHeader: boolean;
}): TextWidgetLayout {
  // Measured at the reference canvas of the placement's format, as the
  // Studio's readability check (ADR 0017 section 6).
  return textWidgetFit({ ...input, format: input.placement.format });
}

/** A connection as a widget's footer and status notice need it. */
export interface StudioConnection {
  name: string;
  state: ConnectionStateView;
  /** Setup not finished (ADR 0012): a status board lists it as failing. */
  setupPending?: boolean;
  /** The connector, where it matters (which connections have reviews). */
  connectorId?: string;
}

/** What live widgets read besides their own settings. */
export interface StudioEnv {
  workspaceId: string;
  /** The workspace's time zone: clocks and chart labels. */
  timeZone: string;
  /** The theme's text scale (1, 1.15 or 1.3). */
  fontScale: number;
  showHeader: boolean;
  /** Metrics by `${connectionId}|${metricKey}`. */
  metrics: ReadonlyMap<string, WorkspaceMetric>;
  connections: Readonly<Record<string, StudioConnection>>;
  images: StudioImages;
}

export function metricKeyOf(widget: {
  connectionId: string;
  metricKey: string;
}): string {
  return `${widget.connectionId}|${widget.metricKey}`;
}
