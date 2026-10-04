import { describe, expect, it } from "vitest";

import type { DeviceSlide, DeviceWidget } from "@netrics/contracts";
import { BUILTIN_THEMES } from "@netrics/domain";

import { RotatedScreen } from "@/components/screen-rotation";
import { renderI18n } from "@/lib/i18n/test-render";
import { slidePages, type ScreenSize } from "@/lib/screen-view";
import { widgetBoxStyle } from "@/lib/studio-render";

import { DeviceWidgetView, type DeviceWidgetEnv } from "./device-widget";
import { SlidePlayer } from "./slide-player";

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tokens = BUILTIN_THEMES.netrics_dark.tokens;
const LOGO = ID(90);

const data = {
  period: "last_7_days" as const,
  aggregation: "sum" as const,
  unit: "count",
  conversion: null,
  kind: "delta" as const,
  granularity: "day" as const,
  better: "higher" as const,
  status: "ok" as const,
  updatedAt: "2026-10-01T10:00:00.000Z",
};

const widgets: DeviceWidget[] = [
  {
    type: "metric",
    id: ID(1),
    x: 0,
    y: 0,
    w: 4,
    h: 3,
    label: "Downloads · Wurfel",
    options: { showSparkline: true, showChange: true },
    data: {
      ...data,
      value: 1234,
      change: { previousValue: 1000, delta: 234, ratio: 0.234 },
      spark: [1, 2, 3],
    },
  },
  {
    type: "line",
    id: ID(2),
    x: 4,
    y: 0,
    w: 8,
    h: 4,
    label: "Revenue",
    options: { showPrevious: true, showAxis: true },
    data: {
      ...data,
      value: 30,
      change: { previousValue: 20, delta: 10, ratio: 0.5 },
      buckets: [
        "2026-09-29T00:00:00.000Z",
        "2026-09-30T00:00:00.000Z",
        "2026-10-01T00:00:00.000Z",
      ],
      values: [10, null, 20],
      previous: [5, 6, 9],
    },
  },
  {
    type: "bar",
    id: ID(3),
    x: 0,
    y: 4,
    w: 6,
    h: 4,
    label: "Downloads by country",
    options: { groupBy: "territory", limit: 5 },
    data: {
      ...data,
      groupBy: "territory",
      bars: [
        { key: "DE", label: "Germany", value: 812 },
        { key: "US", label: "United States", value: 400 },
      ],
      others: { label: "Others", value: 50, groups: 3 },
    },
  },
  {
    type: "image",
    id: ID(4),
    x: 6,
    y: 4,
    w: 2,
    h: 2,
    label: "Wurfel icon",
    imageId: LOGO,
    options: { fit: "contain", align: "center" },
  },
  {
    type: "text",
    id: ID(5),
    x: 8,
    y: 4,
    w: 4,
    h: 2,
    label: null,
    text: "## Wurfel\n<b>not html</b>",
    options: { size: "body", align: "start" },
  },
  {
    type: "clock",
    id: ID(6),
    x: 8,
    y: 6,
    w: 4,
    h: 2,
    label: null,
    options: { showDate: true, hour12: false, timeZone: "Europe/Berlin" },
  },
];

const images = new Map([
  [LOGO, { id: LOGO, url: "blob:kiosk/1", width: 512, height: 512 }],
]);
const env: DeviceWidgetEnv = {
  timeZone: "Europe/Berlin",
  fontScale: 1,
  showHeader: true,
  images,
};

function slide(n: number, name: string, list: DeviceWidget[]): DeviceSlide {
  return {
    id: ID(100 + n),
    name,
    durationSec: 10,
    background: null,
    widgets: list,
  };
}

function render(
  slides: DeviceSlide[],
  transition: "fade" | "none" = "fade",
  autoAdvance = true,
  startSlideId: string | null = null,
  screen: ScreenSize | null = null,
) {
  return renderI18n(
    <SlidePlayer
      slides={slides}
      autoAdvance={autoAdvance}
      transition={transition}
      tokens={tokens}
      showHeader
      header={{ name: "Wurfel", logoImageId: LOGO, timeZone: "Europe/Berlin" }}
      images={images}
      renderWidget={(widget) => <DeviceWidgetView widget={widget} env={env} />}
      empty={<p>Nothing to show</p>}
      startSlideId={startSlideId}
      screen={screen}
    />,
  );
}

function slideTags(html: string): string[] {
  return [...html.matchAll(/<div class="slide-player-slide[^>]*>/g)].map(
    (match) => match[0],
  );
}

describe("SlidePlayer", () => {
  it("stacks every slide and shows the first, the others inert", () => {
    const html = render([
      slide(1, "Sales", widgets.slice(0, 2)),
      slide(2, "Countries", widgets.slice(2)),
      slide(3, "Empty", []),
    ]);
    const tags = slideTags(html);
    expect(tags).toHaveLength(3);
    expect(tags[0]).toContain("slide-player-slide active");
    expect(tags[0]).not.toContain("inert");
    for (const tag of tags.slice(1)) {
      expect(tag).not.toContain("active");
      expect(tag).toContain('aria-hidden="true"');
      expect(tag).toContain("inert");
    }
    // Each slide has its name in the header and the logo from a blob URL.
    expect(html).toContain("Sales");
    expect(html).toContain("Countries");
    expect(html).toContain('src="blob:kiosk/1"');
  });

  it("starts on the given slide (Play from a slide), else the first", () => {
    const slides = [slide(1, "A", []), slide(2, "B", []), slide(3, "C", [])];
    const tags = slideTags(render(slides, "fade", true, ID(102)));
    expect(tags[1]).toContain("slide-player-slide active");
    expect(tags[0]).not.toContain("active");
    // A slide that is not there, or no auto-advance: the first.
    expect(slideTags(render(slides, "fade", true, ID(999)))[0]).toContain(
      "active",
    );
    expect(slideTags(render(slides, "fade", false, ID(102)))[0]).toContain(
      "active",
    );
  });

  it("cross-fades with fade and cuts with none", () => {
    const slides = [slide(1, "A", []), slide(2, "B", [])];
    expect(render(slides, "fade")).toContain("slide-player--fade");
    expect(render(slides, "none")).not.toContain("slide-player--fade");
  });

  it("shows the empty state without slides", () => {
    expect(render([])).toContain("Nothing to show");
  });
});

describe("SlidePlayer in screen view on any screen (ADR 0017, #281)", () => {
  const full = () => [
    slide(1, "Sales", widgets),
    slide(2, "Logo", widgets.slice(3, 4)),
  ];
  const widgetStyles = (html: string) =>
    [
      ...html.matchAll(
        /<div class="studio-widget [^"]*" style="([^"]*)" data-widget-id="([^"]+)"/g,
      ),
    ].map((match) => [match[2], match[1]]);

  it("renders a 16:9 screen exactly as before (pixel-identical boxes)", () => {
    const before = render(full(), "fade", true, null, null);
    for (const size of [
      { width: 1920, height: 1080 },
      { width: 1280, height: 720 },
      { width: 3840, height: 2160 },
    ]) {
      expect(render(full(), "fade", true, null, size)).toBe(before);
    }
    expect(before).toContain('data-format="16x9"');
    // The unit stays the CSS one (100cqw / 1920), boxes the 16:9 ones.
    expect(before).not.toContain("--u:");
    const styles = widgetStyles(before);
    expect(styles.length).toBe(widgets.length + 1);
    for (const [id, style] of styles) {
      const widget = widgets.find((candidate) => candidate.id === id)!;
      const box = widgetBoxStyle(widget, true);
      expect(style).toBe(
        `left:${box.left};top:${box.top};width:${box.width};height:${box.height}`,
      );
    }
    expect(before).toContain('style="height:7.000000000000001%;');
  });

  it("rotates continuation pages as slides, 1/2 in the header", () => {
    const portrait = { width: 1080, height: 1920 };
    const pages = slidePages(widgets, {
      primaryFormat: "16x9",
      format: "9x16",
    });
    expect(pages.length).toBeGreaterThan(1);
    const html = render(full(), "fade", true, null, portrait);
    expect(html).toContain('data-format="9x16"');
    const tags = slideTags(html);
    expect(tags).toHaveLength(pages.length + 1);
    expect(tags[0]).toContain("active");
    expect(tags[0]).toContain('data-page="1"');
    expect(tags[1]).toContain('data-page="2"');
    expect(tags[1]).toContain(`data-slide-id="${ID(101)}"`);
    expect(html).toContain('class="studio-header-page"');
    expect(html).toContain(`>1/${pages.length}</span>`);
    expect(html).toContain(`>2/${pages.length}</span>`);
    // Every widget is on exactly one page.
    const shown = widgetStyles(html).map(([id]) => id);
    expect(shown.filter((id) => id !== ID(4)).sort()).toEqual(
      widgets
        .filter((widget) => widget.id !== ID(4))
        .map((widget) => widget.id)
        .sort(),
    );
    // The unit is the format's: the short edge over 1080.
    expect(html).toContain("--u:1px");
  });

  it("starts on a page's slide and reports the slide", () => {
    const html = render(full(), "fade", true, ID(102), {
      width: 1080,
      height: 1920,
    });
    const tags = slideTags(html);
    const active = tags.filter((tag) => tag.includes("active"));
    expect(active).toHaveLength(1);
    expect(active[0]).toContain(`data-slide-id="${ID(102)}"`);
  });

  it.each([
    [{ width: 2560, height: 1080 }, "21x9"],
    [{ width: 3440, height: 1440 }, "21x9"],
    [{ width: 1024, height: 768 }, "4x3"],
    [{ width: 768, height: 1024 }, "3x4"],
    [{ width: 1920, height: 1200 }, "16x9"],
    [{ width: 5120, height: 1440 }, "21x9"],
  ])("lays out %o as %s", (size, format) => {
    const html = render(full(), "fade", true, null, size);
    expect(html).toContain(`data-format="${format}"`);
    expect(html).toContain("--u:");
  });

  it("letterboxes 32:9: the header inside the capped canvas", () => {
    const html = render(full(), "fade", true, null, {
      width: 5120,
      height: 1440,
    });
    expect(html).toContain(
      'class="studio-header" style="left:6.25%;top:0%;width:87.5%;height:7%;right:auto',
    );
  });

  it("lays out a kiosk turned by 90° in its rotated format", () => {
    // A 1920 × 1080 screen turned 90°: the player measures 1080 × 1920.
    const html = renderI18n(
      <RotatedScreen rotation={90}>
        <SlidePlayer
          slides={full()}
          autoAdvance
          transition="none"
          tokens={tokens}
          showHeader
          header={{ name: "Wurfel", logoImageId: null, timeZone: "UTC" }}
          images={images}
          renderWidget={(widget) => (
            <DeviceWidgetView widget={widget} env={env} />
          )}
          screen={{ width: 1080, height: 1920 }}
        />
      </RotatedScreen>,
    );
    expect(html).toContain('data-rotation="90"');
    expect(html).toContain("rotate(90deg)");
    expect(html).toContain("width:100vh;height:100vw");
    expect(html).toContain('data-format="9x16"');
  });
});

describe("DeviceWidgetView", () => {
  const html = (widget: DeviceWidget) =>
    renderI18n(<DeviceWidgetView widget={widget} env={env} />);

  it("renders a metric from the payload's numbers", () => {
    const markup = html(widgets[0]!);
    expect(markup).toContain(">Downloads</h3>");
    expect(markup).toContain(">Wurfel</p>");
    expect(markup).toContain("1,234");
    expect(markup).toContain("▲");
  });

  it("renders a line chart with the previous period", () => {
    const markup = html(widgets[1]!);
    expect(markup).toContain("<svg");
    expect(markup).toContain("sw-line-previous");
    expect(markup).toContain("sw-line-current");
  });

  it("renders bars with their labels and Others", () => {
    const markup = html(widgets[2]!);
    expect(markup).toContain("Germany");
    expect(markup).toContain("United States");
    expect(markup).toContain("Others");
  });

  it("shows an image from its blob URL, or a notice when not loaded", () => {
    expect(html(widgets[3]!)).toContain('src="blob:kiosk/1"');
    const missing = renderI18n(
      <DeviceWidgetView
        widget={widgets[3]!}
        env={{ ...env, images: new Map() }}
      />,
    );
    expect(missing).toContain("Image not available");
  });

  it("never interprets text as HTML", () => {
    const markup = html(widgets[4]!);
    expect(markup).toContain("Wurfel");
    expect(markup).toContain("&lt;b&gt;not html&lt;/b&gt;");
  });

  it("shows a notice for a failed widget and an unknown type", () => {
    const failed = {
      ...widgets[0]!,
      data: {
        ...(widgets[0] as { data: object }).data,
        unit: null,
        status: "no_data",
      },
    } as DeviceWidget;
    expect(html(failed)).toContain("—");
    const unknown = { ...widgets[5]!, type: "map" } as unknown as DeviceWidget;
    expect(html(unknown)).toContain("This widget could not be shown");
  });
});
