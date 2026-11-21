import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeviceWidget, ItemsWidgetOptions } from "@netrics/contracts";

import { renderI18n } from "@/lib/i18n/test-render";

import { DeviceWidgetView, deviceItemViews } from "./device-widget";
import {
  ItemsWidgetView,
  itemTime,
  itemsGridLayout,
  startRotation,
  workspaceItemViews,
  type ItemsWidgetItemView,
} from "./items-widget";

// The latest-items widget on the web (#810): Studio canvas, kiosk and
// scroll view draw the same view.

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SHA = "a".repeat(64);

const options = (patch: Partial<ItemsWidgetOptions> = {}) => ({
  layout: "grid" as const,
  count: 3,
  rotateSeconds: 8,
  imageFit: "cover" as const,
  showTime: true,
  ...patch,
});

const items: ItemsWidgetItemView[] = ["f", "e", "d", "c", "b"].map(
  (title, index) => ({
    title,
    subtitle: null,
    time: `2026-11-0${6 - index}`,
    image:
      index < 2
        ? {
            src: `/v1/workspaces/w/images/${ID(index)}/content?v=${SHA}`,
            width: 4,
            height: 3,
          }
        : null,
  }),
);

const render = (
  patch: Partial<ItemsWidgetOptions> = {},
  list = items,
  locale: "en" | "de" = "en",
) =>
  renderI18n(
    <ItemsWidgetView
      label="Photos"
      items={list}
      options={options(patch)}
      status={list.length ? "ok" : "no_data"}
      placement={{ x: 0, y: 0, w: 12, h: 8 }}
      showHeader
      fontScale={1}
      audience="viewer"
      timeZone="UTC"
    />,
    locale,
  );

const titles = (html: string) =>
  [...html.matchAll(/class="sw-items-title"[^>]*>([^<]*)</g)].map(
    (match) => match[1],
  );

afterEach(() => {
  vi.useRealTimers();
});

describe("latest items widget view (#810)", () => {
  it("renders the newest items first as a grid, at most count", () => {
    expect(titles(render())).toEqual(["f", "e", "d"]);
    expect(titles(render({ count: 10 }))).toEqual(["f", "e", "d", "c", "b"]);
  });

  it("shows as many as fit a small widget", () => {
    // A 3 × 3 widget has room for one column of tiles.
    const layout = itemsGridLayout({
      width: 300,
      height: 300,
      textHeight: 80,
      count: 6,
      items: 6,
    });
    expect(layout.columns).toBe(1);
    expect(layout.shown).toBeLessThan(6);
    expect(layout.shown).toBeGreaterThanOrEqual(1);
  });

  it("shows one item at a time and advances after rotateSeconds", () => {
    expect(titles(render({ layout: "rotate" }))).toEqual(["f"]);
    vi.useFakeTimers();
    let index = 0;
    const stop = startRotation(3, 8, (advance) => {
      index = advance(index);
    });
    vi.advanceTimersByTime(7_999);
    expect(index).toBe(0);
    vi.advanceTimersByTime(1);
    expect(index).toBe(1);
    vi.advanceTimersByTime(16_000);
    expect(index).toBe(0);
    stop();
    vi.advanceTimersByTime(8_000);
    expect(index).toBe(0);
    // One item never rotates.
    const single = vi.fn();
    startRotation(1, 3, single)();
    vi.advanceTimersByTime(10_000);
    expect(single).not.toHaveBeenCalled();
  });

  it("does not animate under prefers-reduced-motion", () => {
    const css = readFileSync(
      new URL("../../app/globals.css", import.meta.url),
      "utf8",
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.sw-items-rotate \.sw-items-tile \{\s*animation: none;/,
    );
    expect(render({ layout: "rotate" })).not.toContain("transition");
  });

  it("shows a placeholder tile for an item without an image", () => {
    const html = render({ count: 3 });
    expect(html.match(/sw-items-noimage/g)).toHaveLength(1);
    expect(html).toContain('aria-label="No image"');
    expect(render({ count: 3 }, items, "de")).toContain(
      'aria-label="Kein Bild"',
    );
  });

  it("says when there are no items yet", () => {
    expect(render({}, [])).toContain("No items yet");
    expect(render({}, [], "de")).toContain("Noch keine Einträge");
  });

  it("loads images only from netrics URLs", () => {
    const studio = workspaceItemViews("w", {
      widgetId: ID(9),
      status: "ok",
      items: [
        {
          title: "x",
          subtitle: null,
          time: null,
          image: { id: ID(1), sha256: SHA, width: 2, height: 2 },
        },
      ],
      error: null,
      exclusions: [],
    });
    const widget: Extract<DeviceWidget, { type: "items" }> = {
      type: "items",
      id: ID(8),
      x: 0,
      y: 0,
      w: 12,
      h: 8,
      label: "Photos",
      options: options(),
      data: {
        status: "ok",
        items: [
          { title: "a", subtitle: null, time: null, imageId: ID(1) },
          // Not among the screen's images: the placeholder.
          { title: "b", subtitle: null, time: null, imageId: ID(2) },
        ],
      },
    };
    const images = new Map([
      [ID(1), { id: ID(1), url: "blob:kiosk/1", width: 2, height: 2 }],
    ]);
    expect(deviceItemViews(widget, images).map((item) => item.image)).toEqual([
      { src: "blob:kiosk/1", width: 2, height: 2 },
      null,
    ]);
    const html =
      render({}, studio) +
      renderI18n(
        <DeviceWidgetView
          widget={widget}
          env={{ timeZone: "UTC", fontScale: 1, showHeader: true, images }}
        />,
      );
    const sources = [...html.matchAll(/<img[^>]*src="([^"]*)"/g)].map(
      (match) => match[1]!,
    );
    expect(sources).toHaveLength(2);
    for (const src of sources)
      expect(src).toMatch(/^(\/v1\/workspaces\/|blob:)/);
  });

  it("words a date as the date and a timestamp relative to now", () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    expect(itemTime("2026-11-05", "en", "UTC", now)).toBe("Nov 5, 2026");
    expect(itemTime("2026-11-10T10:00:00Z", "en", "UTC", now)).toBe(
      "2 hr. ago",
    );
    expect(itemTime("2026-11-10T10:00:00Z", "de", "UTC", now)).toBe(
      "vor 2 Std.",
    );
    expect(itemTime(null, "en", "UTC", now)).toBeNull();
  });
});
