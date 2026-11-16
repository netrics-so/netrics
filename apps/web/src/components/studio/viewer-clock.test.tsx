import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeviceSlide, DeviceWidget } from "@netrics/contracts";
import { BUILTIN_THEMES } from "@netrics/domain";

import { DeviceScrollWidget } from "@/components/scroll/device-scroll-widget";
import { renderI18n } from "@/lib/i18n/test-render";
import { viewerTimeZone } from "@/lib/viewer-time-zone";

import { LiveClockWidget } from "./clock-widget";
import { DeviceWidgetView, type DeviceWidgetEnv } from "./device-widget";
import { SlideCanvas } from "./slide-canvas";

// #736, ADR 0025 §8: every time a viewer reads is in the viewer's zone, the
// browser's. The workspace's zone (here UTC, the old default) only counts
// data days. 16:34 UTC is 17:34 in Berlin. The viewer's zone is given to
// the render (as hydration would hand over to the browser's), so the
// results do not depend on the machine's zone.

const NOW = new Date("2026-11-16T16:34:00Z");
const BERLIN = "Europe/Berlin";
const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// The payload's (the workspace's) zone: UTC.
const env: DeviceWidgetEnv = {
  timeZone: "UTC",
  fontScale: 1,
  showHeader: true,
  images: new Map(),
};

const clock = (
  n: number,
  options: { timeZone: string; followsViewer?: true },
): Extract<DeviceWidget, { type: "clock" }> => ({
  type: "clock",
  id: ID(n),
  x: 0,
  y: 0,
  w: 4,
  h: 2,
  label: null,
  options: { showDate: false, hour12: false, ...options },
});

const slide = (widgets: DeviceWidget[]): DeviceSlide => ({
  id: ID(100),
  name: "Sales",
  durationSec: 10,
  background: null,
  widgets,
});

const text = (html: string) => html.replace(/<[^>]+>/g, " ");
const SIZE = { width: 360, rootPx: 16 };

describe("clocks in the viewer's zone (#736)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the header clock in the viewer's zone, not the workspace's", () => {
    // The header once carried the workspace's zone for its clock; a caller
    // that still passes it must not move the clock.
    const header = {
      name: "Wurfel",
      slideName: "Sales",
      logoImageId: null,
      timeZone: "UTC",
    };
    const html = renderI18n(
      <SlideCanvas
        slide={slide([])}
        tokens={BUILTIN_THEMES.netrics_dark.tokens}
        showHeader
        header={header}
        images={env.images}
        renderWidget={(widget) => (
          <DeviceWidgetView widget={widget} env={env} />
        )}
      />,
      "en",
      BERLIN,
    );
    expect(html).toMatch(/class="studio-header-clock"[^>]*>17:34</);
  });

  it("shows a clock widget without its own zone in the viewer's", () => {
    const widget = clock(1, { timeZone: "UTC", followsViewer: true });
    const screen = renderI18n(
      <DeviceWidgetView widget={widget} env={env} />,
      "en",
      BERLIN,
    );
    expect(text(screen)).toContain("17:34");
    // Scroll view: the same rule.
    const scroll = renderI18n(
      <DeviceScrollWidget widget={widget} env={env} size={SIZE} />,
      "en",
      BERLIN,
    );
    expect(text(scroll)).toContain("17:34");
  });

  it("keeps a clock widget's own zone", () => {
    const widget = clock(2, { timeZone: "Asia/Tokyo" });
    for (const html of [
      renderI18n(<DeviceWidgetView widget={widget} env={env} />, "en", BERLIN),
      renderI18n(
        <DeviceScrollWidget widget={widget} env={env} size={SIZE} />,
        "en",
        BERLIN,
      ),
    ]) {
      expect(text(html)).toContain("01:34");
    }
  });

  it("shows a Studio clock without a zone in the viewer's", () => {
    const html = renderI18n(
      <LiveClockWidget
        options={{ showDate: false, hour12: false }}
        timeZone={null}
        placement={{ x: 0, y: 0, w: 4, h: 2 }}
        showHeader
        fontScale={1}
      />,
      "en",
      BERLIN,
    );
    expect(text(html)).toContain("17:34");
  });

  it("renders a stable zone until the browser's is known", () => {
    // The server and hydration render UTC, whatever the server's zone.
    const html = renderI18n(
      <DeviceWidgetView
        widget={clock(3, { timeZone: "Asia/Tokyo", followsViewer: true })}
        env={env}
      />,
    );
    expect(text(html)).toContain("16:34");
  });
});

describe("the browser's zone", () => {
  const saved = process.env.TZ;
  afterEach(() => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  });

  it("is the zone the runtime reports", () => {
    for (const zone of ["Europe/Berlin", "Pacific/Auckland"]) {
      process.env.TZ = zone;
      expect(viewerTimeZone()).toBe(zone);
    }
  });
});
