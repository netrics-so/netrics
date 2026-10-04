import type { Dashboard, Device } from "@netrics/contracts";
import {
  BUILTIN_THEMES,
  DEFAULT_THEME_KEY,
  SCREEN_FORMATS,
  type ThemeTokens,
} from "@netrics/domain";

import { isScreenOnline } from "./app-nav";
import { resolveDashboardTheme } from "./studio-theme";

// The Screens page (#303): what a screen card shows, worked out on the
// server from the device list and the dashboards the screens show.

/** One widget of the previewed slide, in percent of the slide. */
export interface PreviewStub {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Text and image widgets are drawn quieter than data widgets. */
  quiet: boolean;
}

/**
 * A screen's thumbnail: the assigned dashboard's first slide as a
 * schematic in its theme's colours, without live data.
 */
export interface ScreenPreview {
  background: string;
  surface: string;
  border: string;
  muted: string;
  /** The slide's shape ("16 / 9"), from the dashboard's primary format. */
  aspectRatio: string;
  /** Narrower than 16:9: the slide fits the thumbnail's height. */
  tall: boolean;
  stubs: PreviewStub[];
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** The slide a screen starts with: the first enabled one, else the first. */
export function firstSlide(
  dashboard: Pick<Dashboard, "slides">,
): Dashboard["slides"][number] | null {
  const slides = dashboard.slides.toSorted((a, b) => a.position - b.position);
  return slides.find((slide) => slide.enabled) ?? slides[0] ?? null;
}

/**
 * The thumbnail of a dashboard: its first slide's widgets as placed in its
 * primary format, in its theme (a custom theme when given, else its
 * built-in). Without a dashboard: an empty netrics Dark slide.
 */
export function screenPreview(
  dashboard: Pick<Dashboard, "slides" | "settings" | "primaryFormat"> | null,
  customTheme: { name: string; tokens: ThemeTokens } | null = null,
): ScreenPreview {
  const tokens = dashboard
    ? resolveDashboardTheme(dashboard.settings, customTheme).tokens
    : BUILTIN_THEMES[DEFAULT_THEME_KEY].tokens;
  const format = SCREEN_FORMATS[dashboard?.primaryFormat ?? "16x9"];
  const slide = dashboard ? firstSlide(dashboard) : null;
  return {
    background: tokens.background,
    surface: tokens.surface,
    border: tokens.border,
    muted: tokens.muted,
    aspectRatio: `${format.reference.width} / ${format.reference.height}`,
    tall: format.reference.width / format.reference.height < 16 / 9,
    stubs: (slide?.widgets ?? []).map((widget) => ({
      left: round((widget.x / format.columns) * 100),
      top: round((widget.y / format.rows) * 100),
      width: round((widget.w / format.columns) * 100),
      height: round((widget.h / format.rows) * 100),
      quiet: widget.type === "text" || widget.type === "image",
    })),
  };
}

/** The dashboards the active screens show, each once. */
export function assignedDashboardIds(
  devices: readonly Pick<Device, "dashboardId" | "revokedAt">[],
): string[] {
  return [
    ...new Set(
      devices
        .filter((device) => device.revokedAt === null)
        .flatMap((device) => (device.dashboardId ? [device.dashboardId] : [])),
    ),
  ];
}

export interface ScreenCounts {
  /** Screens not revoked. */
  total: number;
  online: number;
  revoked: number;
}

export function countScreens(
  devices: readonly Pick<Device, "lastSeenAt" | "revokedAt">[],
  now: number = Date.now(),
): ScreenCounts {
  const revoked = devices.filter((device) => device.revokedAt !== null).length;
  return {
    total: devices.length - revoked,
    online: devices.filter((device) => isScreenOnline(device, now)).length,
    revoked,
  };
}
