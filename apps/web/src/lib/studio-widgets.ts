import type {
  ConnectionStateView,
  DashboardSettings,
  DashboardSlide,
  DashboardWidget,
  WorkspaceMetric,
} from "@netrics/contracts";
import {
  parseTextWidget,
  textWidgetSizes,
  wrappedLineCount,
  type StudioPlacement,
  type StudioTextBlock,
  type StudioTextSize,
} from "@netrics/domain";

import { LINE_HEIGHT, contentBox } from "./studio-render";

// The studio's widgets as the web renders them (ADR 0015, sections 1–2).

/**
 * The image widget as ADR 0015 defines it. Images arrive with #217; until
 * the contract has the type this shape stands in, and once it does the
 * contract's own type is used.
 */
export interface ImageWidgetShape {
  type: "image";
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string | null;
  imageId: string;
  options: { fit: "contain" | "cover"; align: "start" | "center" | "end" };
}

type ContractImageWidget = Extract<DashboardWidget, { type: "image" }>;
export type ImageWidget = [ContractImageWidget] extends [never]
  ? ImageWidgetShape
  : ContractImageWidget;

/** Every widget a slide can hold. */
export type StudioWidget = DashboardWidget | ImageWidget;

export type DataWidget = Extract<
  StudioWidget,
  { type: "metric" | "line" | "bar" }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A slide's background image and dim (#217), or null. */
export function slideBackground(
  slide: DashboardSlide,
): { imageId: string; dim: number } | null {
  const background: unknown = (slide as { background?: unknown }).background;
  if (
    !isRecord(background) ||
    typeof background.imageId !== "string" ||
    typeof background.dim !== "number"
  ) {
    return null;
  }
  return {
    imageId: background.imageId,
    dim: Math.min(80, Math.max(0, background.dim)),
  };
}

/** The dashboard's logo image (#217), or null. */
export function logoImageId(settings: DashboardSettings): string | null {
  const id: unknown = (settings as { logoImageId?: unknown }).logoImageId;
  return typeof id === "string" ? id : null;
}

/** Every image a dashboard's slides show: logo, backgrounds, widgets. */
export function referencedImageIds(dashboard: {
  settings: DashboardSettings;
  slides: DashboardSlide[];
}): string[] {
  const ids = new Set<string>();
  const logo = logoImageId(dashboard.settings);
  if (logo) ids.add(logo);
  for (const slide of dashboard.slides) {
    const background = slideBackground(slide);
    if (background) ids.add(background.imageId);
    for (const widget of slide.widgets as StudioWidget[]) {
      if (widget.type === "image") ids.add(widget.imageId);
    }
  }
  return [...ids];
}

/** "Sales", or "Slide 2" for a slide without a name. */
export function slideTitle(slide: { name: string | null }, index: number) {
  return slide.name ?? `Slide ${index + 1}`;
}

/**
 * Whether the tile editor can still edit the dashboard: one slide with
 * metric widgets only, the shape a tile save keeps (ADR 0015, section 3).
 * Anything else is a studio dashboard, edited in the Studio (#223).
 */
export function isTileDashboard(dashboard: { slides: DashboardSlide[] }) {
  return (
    dashboard.slides.length <= 1 &&
    dashboard.slides.every((slide) =>
      (slide.widgets as StudioWidget[]).every(
        (widget) => widget.type === "metric",
      ),
    )
  );
}

const SMALLER: Record<StudioTextSize, StudioTextSize | null> = {
  display: "heading",
  heading: "body",
  body: null,
};

function spansText(spans: ReadonlyArray<{ text: string }>): string {
  return spans.map((span) => span.text).join("");
}

function blocksHeight(
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
        LINE_HEIGHT;
      return;
    }
    for (const line of block.lines) {
      height +=
        Math.max(
          1,
          wrappedLineCount(spansText(line), width, sizes.paragraph, "bold"),
        ) *
        sizes.paragraph *
        LINE_HEIGHT;
    }
  });
  return height;
}

export interface TextWidgetLayout {
  blocks: StudioTextBlock[];
  size: StudioTextSize;
  sizes: { paragraph: number; heading1: number; heading2: number };
  /** Even body size does not fit: the end is cut off (the studio warns). */
  overflow: boolean;
}

/**
 * A text widget's blocks and sizes: its size option when the text fits
 * (estimated with the conservative glyph widths, bold), else the next
 * smaller option down to body. Never below the minimums.
 */
export function textWidgetLayout(input: {
  text: string;
  size: StudioTextSize;
  placement: StudioPlacement;
  fontScale: number;
  showHeader: boolean;
}): TextWidgetLayout {
  const blocks = parseTextWidget(input.text);
  const box = contentBox(input.placement, input.showHeader);
  let size: StudioTextSize = input.size;
  for (;;) {
    const sizes = textWidgetSizes(size, input.fontScale);
    const fits = blocksHeight(blocks, box.width, sizes) <= box.height;
    const next = SMALLER[size];
    if (fits || next === null) {
      return { blocks, size, sizes, overflow: !fits };
    }
    size = next;
  }
}

/** A connection as a widget's footer and status notice need it. */
export interface StudioConnection {
  name: string;
  state: ConnectionStateView;
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
