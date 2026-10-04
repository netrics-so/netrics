import type { DashboardWidget, Device } from "@netrics/contracts";
import {
  countdownLabel,
  effectiveFontScale,
  formatFor,
  formatWarnings,
  isDataWidgetType,
  zonedInstant,
  type FormatWarningItem,
  type Locale,
  type ReadabilityWidget,
  type ScreenFormat,
} from "@netrics/domain";

import {
  completedLayout,
  layoutWidgets,
  type ScreenSize,
  type SlideLayouts,
} from "./screen-view";

// The Studio's format switcher and device-frame previews (ADR 0017,
// section 10; #283): which formats it offers and in which order, the
// devices each is previewed on, how a device frame fits the stage, the
// state of each format (primary, auto, custom, warnings) for the draft,
// and the switcher's own state. Pure, so it is tested without a browser.
//
// The primary format is edited on the canvas; another format is edited
// once the slide has a custom layout there (#284), else it is a preview
// with "Customize". `isEditableTarget` is the one switch.

/** A screen format in screen view, or the scroll view (phones, tablets). */
export type PreviewTarget = ScreenFormat | "scroll";

/** The formats after the primary, in the switcher's order (section 10). */
export const PREVIEW_FORMAT_ORDER: readonly ScreenFormat[] = [
  "16x9",
  "9x16",
  "21x9",
  "4x3",
  "3x4",
];

/** The switcher's chips: the primary first, the other formats, scroll view. */
export function previewTargets(primaryFormat: ScreenFormat): PreviewTarget[] {
  return [
    primaryFormat,
    ...PREVIEW_FORMAT_ORDER.filter((format) => format !== primaryFormat),
    "scroll",
  ];
}

/**
 * True when the Studio edits the slide in this target: always in the
 * primary format; in another format when the slide is arranged by hand
 * there (ADR 0017 section 4). Scroll view is always automatic.
 */
export function isEditableTarget(
  target: PreviewTarget,
  primaryFormat: ScreenFormat,
  slide?: { layouts?: SlideLayouts | null } | null,
): boolean {
  if (target === primaryFormat) return true;
  if (target === "scroll") return false;
  return slide?.layouts?.some((layout) => layout.format === target) ?? false;
}

// ---------------------------------------------------------------------------
// Devices and frames

export type DeviceKind = "tv" | "monitor" | "tablet" | "phone";

export type PreviewDeviceId =
  | "tv"
  | "tv-portrait"
  | "monitor-wide"
  | "monitor"
  | "monitor-portrait"
  | "tablet-landscape"
  | "tablet-portrait"
  | "phone";

/** A device a format is previewed on: its frame and its screen in CSS px. */
export interface PreviewDevice {
  id: PreviewDeviceId;
  kind: DeviceKind;
  /** The screen as the renderer measures it (CSS px, after rotation). */
  screen: ScreenSize;
}

/**
 * Every device by id. TVs and monitors use their format's reference
 * canvas; tablets and phones a common real size (iPad Air, iPhone 15), so
 * their screens stretch the grid as the real ones do (section 2).
 */
export const PREVIEW_DEVICES: Readonly<Record<PreviewDeviceId, PreviewDevice>> =
  {
    tv: { id: "tv", kind: "tv", screen: { width: 1920, height: 1080 } },
    "tv-portrait": {
      id: "tv-portrait",
      kind: "tv",
      screen: { width: 1080, height: 1920 },
    },
    "monitor-wide": {
      id: "monitor-wide",
      kind: "monitor",
      screen: { width: 2560, height: 1080 },
    },
    monitor: {
      id: "monitor",
      kind: "monitor",
      screen: { width: 1440, height: 1080 },
    },
    "monitor-portrait": {
      id: "monitor-portrait",
      kind: "monitor",
      screen: { width: 1080, height: 1440 },
    },
    "tablet-landscape": {
      id: "tablet-landscape",
      kind: "tablet",
      screen: { width: 1180, height: 820 },
    },
    "tablet-portrait": {
      id: "tablet-portrait",
      kind: "tablet",
      screen: { width: 820, height: 1180 },
    },
    phone: { id: "phone", kind: "phone", screen: { width: 390, height: 844 } },
  };

/** The devices of each target, the default first. */
export const TARGET_DEVICES: Readonly<
  Record<PreviewTarget, readonly PreviewDeviceId[]>
> = {
  "16x9": ["tv"],
  "9x16": ["tv-portrait", "phone"],
  "21x9": ["monitor-wide"],
  "4x3": ["monitor", "tablet-landscape"],
  "3x4": ["monitor-portrait", "tablet-portrait"],
  scroll: ["phone", "tablet-portrait"],
};

/** Bezels as a share of the screen's short side: top, right, bottom, left. */
const BEZELS: Readonly<
  Record<DeviceKind, readonly [number, number, number, number]>
> = {
  tv: [0.022, 0.022, 0.03, 0.022],
  monitor: [0.025, 0.025, 0.06, 0.025],
  tablet: [0.06, 0.06, 0.06, 0.06],
  phone: [0.05, 0.04, 0.05, 0.04],
};

/** Corner radius of the frame as a share of the screen's short side. */
const RADII: Readonly<Record<DeviceKind, number>> = {
  tv: 0.008,
  monitor: 0.012,
  tablet: 0.07,
  phone: 0.14,
};

export interface FrameLayout {
  /** Screen pixels to stage pixels (at most 1: never larger than real). */
  scale: number;
  /** The frame's outer size on the stage. */
  width: number;
  height: number;
  /** The bezel on the stage: top, right, bottom, left. */
  bezel: { top: number; right: number; bottom: number; left: number };
  radius: number;
  /** The screen's size on the stage. */
  screen: ScreenSize;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * How a device's frame fits into `available` stage pixels: the screen and
 * its bezel scaled together, keeping the device's proportions, never above
 * its real size. The renderer works at the device's real screen size and
 * is scaled by `scale`, so the preview is what the screen shows.
 */
export function frameLayout(
  device: PreviewDevice,
  available: ScreenSize,
): FrameLayout {
  const { width, height } = device.screen;
  const short = Math.min(width, height);
  const [top, right, bottom, left] = BEZELS[device.kind].map(
    (share) => share * short,
  ) as [number, number, number, number];
  const outerWidth = width + left + right;
  const outerHeight = height + top + bottom;
  const scale = Math.max(
    0,
    Math.min(1, available.width / outerWidth, available.height / outerHeight),
  );
  return {
    scale,
    width: round2(outerWidth * scale),
    height: round2(outerHeight * scale),
    bezel: {
      top: round2(top * scale),
      right: round2(right * scale),
      bottom: round2(bottom * scale),
      left: round2(left * scale),
    },
    radius: round2(RADII[device.kind] * short * scale),
    screen: { width: round2(width * scale), height: round2(height * scale) },
  };
}

// ---------------------------------------------------------------------------
// The draft's warnings per format

/** What the checks need of the dashboard besides its slides. */
export interface DraftReadabilityContext {
  primaryFormat: ScreenFormat;
  fontScale: number;
  showHeader: boolean;
  dashboardName: string;
  logoAspect: number | null;
  /** The workspace's time zone, for clocks and countdowns without their own. */
  timeZone?: string;
  /** The Studio's language: a countdown's label without a title. */
  locale?: Locale;
  /** Now, for countdowns whose target has passed (default: the call's time). */
  now?: Date;
  /**
   * A data widget's label as screens show it ("Downloads · Wurfel"); a
   * status board's title or "Sources".
   */
  labelOf(widget: DashboardWidget): string | null;
  /** The workspace's connections: what a board of every source lists. */
  sourceCount?: number;
}

/** A slide of the draft, with the custom layouts stored for it. */
export interface DraftSlide {
  id: string;
  name: string | null;
  widgets: readonly DashboardWidget[];
  layouts?: SlideLayouts | null;
}

function readabilityWidget(
  widget: DashboardWidget,
  context: DraftReadabilityContext,
): ReadabilityWidget {
  const [base] = layoutWidgets([widget]);
  if (isDataWidgetType(widget.type)) {
    return { ...base!, label: context.labelOf(widget) };
  }
  if (widget.type === "status") {
    return {
      ...base!,
      label: context.labelOf(widget),
      rows: widget.options.connectionIds?.length ?? context.sourceCount ?? 0,
    };
  }
  if (widget.type === "text") {
    return {
      ...base!,
      text: widget.text,
      textSize: widget.options.size,
    };
  }
  if (widget.type === "clock") {
    return {
      ...base!,
      clock: {
        showDate: widget.options.showDate,
        dateStyle: widget.options.dateStyle,
        zone: widget.options.showZone
          ? (widget.options.timeZone ?? context.timeZone ?? "UTC")
          : null,
      },
    };
  }
  if (widget.type === "countdown") {
    return {
      ...base!,
      label: countdownLabel(widget.title, context.locale ?? "en"),
      countdown: {
        targetAt:
          zonedInstant(
            widget.options.target,
            widget.options.timeZone ?? context.timeZone ?? "UTC",
          )?.toISOString() ?? null,
      },
    };
  }
  return base!;
}

/**
 * The readability warnings of a draft slide in every screen format, as the
 * server computes them for the saved version (#280), so the switcher shows
 * unsaved changes. Stored custom layouts are completed against the draft's
 * widgets first: a widget added since shows up "to review".
 */
export function draftFormatWarnings(
  slide: DraftSlide,
  context: DraftReadabilityContext,
): FormatWarningItem[] {
  const widgets = slide.widgets.map((widget) =>
    readabilityWidget(widget, context),
  );
  const readability = {
    primaryFormat: context.primaryFormat,
    fontScale: effectiveFontScale(context.fontScale),
    showHeader: context.showHeader,
    dashboardName: context.dashboardName,
    logoAspect: context.logoAspect,
    now: context.now ?? new Date(),
  };
  return PREVIEW_FORMAT_ORDER.flatMap((format) => {
    const custom = completedLayout(widgets, {
      primaryFormat: context.primaryFormat,
      format,
      layouts: slide.layouts,
    });
    return formatWarnings(
      {
        name: slide.name,
        widgets,
        layouts: custom ? { [format]: custom } : {},
      },
      format,
      readability,
    );
  });
}

// ---------------------------------------------------------------------------
// Chip states

export type TargetLayoutKind = "primary" | "auto" | "custom";

export interface TargetStatus {
  target: PreviewTarget;
  layout: TargetLayoutKind;
  /** Slides with a custom layout in this format. */
  customSlides: number;
  /** `attention` warnings other than widgets to review, on every slide. */
  attention: number;
  /** Widgets placed automatically in a custom layout, waiting for review. */
  toReview: number;
  /** `info` warnings (continuation pages, hidden widgets). */
  info: number;
  /** Paired screens that report this format (and mode). */
  screens: number;
}

/**
 * Formats used by paired screens (ADR 0017 section 7): each active device
 * with a reported screen counts for its format in screen view, or for the
 * scroll view.
 */
export function screensByTarget(
  devices: ReadonlyArray<Pick<Device, "screen" | "revokedAt">> | null,
): Map<PreviewTarget, number> {
  const counts = new Map<PreviewTarget, number>();
  for (const device of devices ?? []) {
    const screen = device.screen;
    if (device.revokedAt || !screen) continue;
    const target: PreviewTarget =
      screen.mode === "scroll"
        ? "scroll"
        : (screen.format ?? formatFor(screen.width, screen.height));
    counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  return counts;
}

/** The state of every chip, in the switcher's order. */
export function targetStatuses(input: {
  primaryFormat: ScreenFormat;
  slides: ReadonlyArray<{ layouts?: SlideLayouts | null }>;
  warnings: readonly FormatWarningItem[];
  screens?: ReadonlyMap<PreviewTarget, number>;
}): TargetStatus[] {
  return previewTargets(input.primaryFormat).map((target) => {
    const customSlides =
      target === "scroll" || target === input.primaryFormat
        ? 0
        : input.slides.filter((slide) =>
            slide.layouts?.some((layout) => layout.format === target),
          ).length;
    const own = input.warnings.filter((warning) => warning.format === target);
    return {
      target,
      layout:
        target === input.primaryFormat
          ? "primary"
          : customSlides > 0
            ? "custom"
            : "auto",
      customSlides,
      attention: own.filter(
        (warning) =>
          warning.severity === "attention" &&
          warning.code !== "widget_to_review",
      ).length,
      toReview: own.filter((warning) => warning.code === "widget_to_review")
        .length,
      info: own.filter((warning) => warning.severity === "info").length,
      screens: input.screens?.get(target) ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// The switcher's state

export interface FormatViewState {
  target: PreviewTarget;
  /** The device chosen per target (else its first). */
  devices: Partial<Record<PreviewTarget, PreviewDeviceId>>;
  /** The page shown (0-based) of a slide on several pages. */
  page: number;
  /** "All formats": every target side by side. */
  overview: boolean;
}

export type FormatViewAction =
  | { type: "select"; target: PreviewTarget }
  | { type: "device"; device: PreviewDeviceId }
  | { type: "page"; page: number }
  | { type: "overview"; on: boolean }
  /** Another slide was selected: back to its first page. */
  | { type: "slideChanged" };

export function initialFormatView(
  primaryFormat: ScreenFormat,
): FormatViewState {
  return { target: primaryFormat, devices: {}, page: 0, overview: false };
}

export function formatViewReducer(
  state: FormatViewState,
  action: FormatViewAction,
): FormatViewState {
  switch (action.type) {
    case "select":
      return { ...state, target: action.target, page: 0, overview: false };
    case "device":
      if (!TARGET_DEVICES[state.target].includes(action.device)) return state;
      return {
        ...state,
        devices: { ...state.devices, [state.target]: action.device },
      };
    case "page":
      return { ...state, page: Math.max(0, Math.floor(action.page)) };
    case "overview":
      return { ...state, overview: action.on };
    case "slideChanged":
      return state.page === 0 ? state : { ...state, page: 0 };
  }
}

/** The device a target is previewed on. */
export function deviceOf(
  state: Pick<FormatViewState, "devices">,
  target: PreviewTarget,
): PreviewDevice {
  const chosen = state.devices[target];
  const ids = TARGET_DEVICES[target];
  return PREVIEW_DEVICES[chosen && ids.includes(chosen) ? chosen : ids[0]!];
}

/** The index a key moves to in a tablist of `count` (arrows wrap). */
export function tabKeyTarget(
  key: string,
  index: number,
  count: number,
): number | null {
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (index + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
