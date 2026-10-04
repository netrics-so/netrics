import { describe, expect, it } from "vitest";

import type { DashboardSlide, DashboardWidget } from "@netrics/contracts";
import { BUILTIN_THEMES, type Locale } from "@netrics/domain";

import { DisplayModeSwitch } from "@/app/workspaces/[workspaceId]/dashboards/[dashboardId]/display-mode-switch";
import { renderI18n } from "@/lib/i18n/test-render";
import type { StudioImage, StudioWidget } from "@/lib/studio-widgets";

import { ScrollView } from "./scroll-view";
import {
  ScrollBarCard,
  ScrollClockCard,
  ScrollImageCard,
  ScrollLineCard,
  ScrollMetricCard,
  ScrollTextCard,
  type ScrollCardSize,
} from "./scroll-widgets";

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** The markup's text without tags, entities decoded. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");
}

const binding = {
  connectionId: ID(9),
  metricKey: "downloads",
  aggregation: "sum",
  period: "last_7_days",
  dimensions: {},
  displayCurrency: null,
  resourceName: null,
  allResourcesName: null,
} as const;

const LONG_LABEL =
  "Durchschnittliche Bewertung der letzten Rezensionen · Paperstand – Magazin- und Zeitungsleser für unterwegs, mit Offline-Archiv und Vorlesefunktion";

// The primary layout: the line chart is listed first but sits below the
// metrics; the clock sits right of them.
const widgets = [
  {
    id: ID(31),
    type: "line",
    x: 0,
    y: 3,
    w: 8,
    h: 3,
    title: null,
    ...binding,
    options: { showPrevious: true, showAxis: true },
  },
  {
    id: ID(30),
    type: "metric",
    x: 0,
    y: 0,
    w: 4,
    h: 3,
    title: LONG_LABEL,
    ...binding,
    options: { showSparkline: false, showChange: true },
  },
  {
    id: ID(32),
    type: "clock",
    x: 8,
    y: 0,
    w: 4,
    h: 3,
    title: null,
    options: { showDate: true, hour12: false, timeZone: null },
  },
] as unknown as DashboardWidget[];

function slide(
  n: number,
  name: string | null,
  extra: Partial<DashboardSlide> = {},
): DashboardSlide {
  return {
    id: ID(20 + n),
    position: n,
    name,
    durationSeconds: null,
    enabled: true,
    widgets,
    background: null,
    ...extra,
  } as DashboardSlide;
}

const images = new Map<string, StudioImage>([
  [ID(50), { id: ID(50), url: "/logo.png", width: 64, height: 64 }],
  [ID(52), { id: ID(52), url: "/bg.jpg", width: 1920, height: 1080 }],
]);

// 2026-10-04 08:05 UTC: 10:05 in Berlin, 17:05 in Tokyo.
const NOW = new Date("2026-10-04T08:05:00Z");

/** Cards from fixed readings, as a test stands in for the live queries. */
function card(widget: StudioWidget, size: ScrollCardSize) {
  switch (widget.type) {
    case "metric":
      return (
        <ScrollMetricCard
          label={widget.title ?? "Downloads"}
          period="last_7_days"
          aggregation="sum"
          metric={{ kind: "counter", granularity: "day", better: "higher" }}
          reading={{
            value: 1248,
            unit: "count",
            delta: 120,
            ratio: 0.106,
            series: [],
            timeZone: "UTC",
          }}
          notice={null}
          source="App Store Connect"
          options={widget.options}
          {...size}
        />
      );
    case "line":
      return (
        <ScrollLineCard
          label="Downloads"
          period="last_7_days"
          reading={{
            value: 1248,
            unit: "count",
            series: [3, 5, 4, 8].map((value, index) => ({
              bucket: `2026-09-2${index}T00:00:00.000Z`,
              value,
            })),
            previous: null,
            timeZone: "UTC",
          }}
          notice={null}
          options={widget.options}
          {...size}
        />
      );
    case "clock":
      return (
        <ScrollClockCard
          now={NOW}
          timeZone={widget.options.timeZone ?? "Europe/Berlin"}
          options={widget.options}
          {...size}
        />
      );
    default:
      return null;
  }
}

function render(
  slides: DashboardSlide[],
  options: { locale?: Locale; width?: number } = {},
) {
  return renderI18n(
    <ScrollView
      name="Wurfel"
      logoImageId={ID(50)}
      slides={slides}
      tokens={BUILTIN_THEMES.paper.tokens}
      images={images}
      initialWidth={options.width ?? 360}
      renderWidget={card}
    />,
    options.locale ?? "en",
  );
}

describe("scroll view (ADR 0017, section 5)", () => {
  it("has the header with logo, the dashboard name as h1 and the live state", () => {
    const html = render([slide(0, "Sales")]);
    expect(html).toContain('class="scroll-logo" src="/logo.png"');
    expect(html).toMatch(/<h1[^>]*class="scroll-name"[^>]*>Wurfel<\/h1>/);
    expect(html).toContain('role="status"');
    expect(text(html)).toContain("Live");
    // In the dashboard's theme.
    expect(html).toContain("--t-background:#f2ede2");
  });

  it("shows every enabled slide as a named section, disabled slides skipped", () => {
    const html = render([
      slide(0, "Sales"),
      slide(1, "Hidden", { enabled: false }),
      slide(2, null),
    ]);
    const headings = [
      ...html.matchAll(/<h2[^>]*class="scroll-section-heading"[^>]*>([^<]*)</g),
    ].map((match) => match[1]);
    expect(headings).toEqual(["Sales", "Slide 3"]);
    // Each section is a region named by its heading.
    expect(html.match(/<section[^>]*aria-labelledby="[^"]+"/g)).toHaveLength(2);
    expect(html).not.toContain("Hidden");
  });

  it("names nameless slides in German", () => {
    const html = render([slide(0, null)], { locale: "de" });
    expect(html).toContain(">Folie 1</h2>");
    expect(html).toContain('aria-label="Folien von Wurfel"');
    expect(text(html)).toContain("Live");
  });

  it("orders widgets from the primary layout and spans charts across the row", () => {
    const html = render([slide(0, "Sales")], { width: 1072 });
    const items = [
      ...html.matchAll(
        /data-widget-id="([^"]+)" data-span="(\d)" style="grid-column:([^;]+);grid-row:(\d+)"/g,
      ),
    ].map((match) => ({
      id: match[1],
      span: Number(match[2]),
      column: match[3],
      row: Number(match[4]),
    }));
    expect(items).toEqual([
      { id: ID(30), span: 1, column: "1 / span 1", row: 1 },
      { id: ID(32), span: 1, column: "2 / span 1", row: 1 },
      { id: ID(31), span: 3, column: "1 / span 3", row: 2 },
    ]);
    expect(html).toContain("grid-template-columns:repeat(3, minmax(0, 1fr))");
  });

  it("uses one column on a 360 px phone", () => {
    const html = render([slide(0, "Sales")], { width: 360 });
    expect(html).toContain("grid-template-columns:repeat(1, minmax(0, 1fr))");
    expect(html).toContain('data-columns="1"');
  });

  it("shows a slide's background behind its section, under the dim, with the heading on a band", () => {
    const html = render([
      slide(0, "Sales", { background: { imageId: ID(52), dim: 40 } }),
    ]);
    expect(html).toContain('class="scroll-section has-background"');
    expect(html).toMatch(/class="scroll-section-bg" src="\/bg.jpg" alt=""/);
    expect(html).toContain(
      '<div class="scroll-section-dim" style="opacity:0.4"></div>',
    );
    // The heading follows the backdrop (it sits on its own surface band).
    expect(html.indexOf("scroll-section-dim")).toBeLessThan(
      html.indexOf("scroll-section-heading"),
    );
  });

  it("leaves a missing background out instead of a broken picture", () => {
    const html = render([
      slide(0, "Sales", { background: { imageId: ID(99), dim: 40 } }),
    ]);
    expect(html).not.toContain("scroll-section-bg");
    expect(html).toContain('class="scroll-section"');
  });

  it("shows clocks as compact cards in the workspace's time zone", () => {
    const en = render([slide(0, "Sales")]);
    expect(en).toContain("scroll-card--clock");
    expect(en).toMatch(/class="sw-clock-time"[^>]*>10:05<\/time>/);
    expect(text(en)).toContain("Sun 4 Oct");
    const de = render([slide(0, "Sales")], { locale: "de" });
    expect(de).toMatch(/>10:05<\/time>/);
    expect(text(de)).toContain("So., 4. Okt.");
  });

  it("shows a clock with its own zone in that zone", () => {
    const html = renderI18n(
      <ScrollClockCard
        now={NOW}
        timeZone="Asia/Tokyo"
        options={{ showDate: false, hour12: true }}
        width={312}
        rootPx={16}
      />,
    );
    expect(html).toContain(">5:05 PM</time>");
  });

  it("never cuts a label on a 360 px phone: it wraps in full", () => {
    const html = render([slide(0, "Sales")], { width: 360 });
    expect(html).toContain(
      ">Durchschnittliche Bewertung der letzten Rezensionen</h3>",
    );
    expect(html).toContain(
      ">Paperstand – Magazin- und Zeitungsleser für unterwegs, mit Offline-Archiv und Vorlesefunktion</p>",
    );
    expect(html).not.toContain("data-truncated");
    expect(html).not.toContain("sw-title");
  });

  it("formats values and changes in the viewer's language", () => {
    const en = render([slide(0, "Sales")]);
    expect(en).toMatch(/class="scroll-value"[^>]*>1,248</);
    const de = render([slide(0, "Sales")], { locale: "de" });
    expect(de).toMatch(/class="scroll-value"[^>]*>1\.248</);
    expect(text(de)).toContain("Letzte 7 Tage");
  });

  it("text sizes are rem-based through the scroll view's unit", () => {
    const html = render([slide(0, "Sales")]);
    expect(html).toContain(
      'class="scroll-title" style="font-size:calc(var(--u) * 30)"',
    );
  });
});

describe("scroll view cards", () => {
  const size = { width: 312, rootPx: 16 };

  it("goes compact in a narrow card instead of cutting the value", () => {
    const html = renderI18n(
      <ScrollMetricCard
        label="Proceeds"
        period="last_30_days"
        aggregation="sum"
        metric={null}
        reading={{
          value: 123456,
          unit: "count",
          delta: null,
          ratio: null,
          series: [],
          timeZone: "UTC",
        }}
        notice={null}
        source={null}
        options={{ showSparkline: false, showChange: false }}
        width={110}
        rootPx={16}
      />,
    );
    // At the minimum size (48 units = 1.5rem), in the compact form.
    expect(html).toContain(
      'class="scroll-value" style="font-size:calc(var(--u) * 48)">123.5K</p>',
    );
  });

  it("draws the line chart 16:9 of its width", () => {
    const html = renderI18n(
      <ScrollLineCard
        label="Downloads"
        period="last_7_days"
        reading={{
          value: 10,
          unit: "count",
          series: [1, 2, 3].map((value) => ({ value })),
          previous: null,
          timeZone: "UTC",
        }}
        notice={null}
        options={{ showPrevious: false, showAxis: false }}
        width={1048}
        rootPx={16}
      />,
    );
    const match = html.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
    expect(match).not.toBeNull();
    const ratio = Number(match![1]) / Number(match![2]);
    expect(ratio).toBeCloseTo(16 / 9, 1);
    expect(html).toContain('role="img"');
  });

  it("shows every bar group with its full label, and Others in German", () => {
    const html = renderI18n(
      <ScrollBarCard
        label="Downloads by country"
        reading={{
          unit: "count",
          groups: [
            { label: "Vereinigte Staaten von Amerika", value: 500 },
            { label: "Deutschland", value: 250 },
          ],
          others: { label: "Andere", value: 50 },
        }}
        notice={null}
        {...size}
      />,
      "de",
    );
    expect(html).toContain(">Vereinigte Staaten von Amerika</span>");
    expect(html).toContain('class="sw-bar-row others"');
    expect(html).toContain("width:100.00%");
    expect(html).toContain("width:50.00%");
    expect(html).toContain(">500</span>");
  });

  it("renders text widgets as text, and images at their aspect", () => {
    const textHtml = renderI18n(
      <ScrollTextCard
        text={"# Goals\n**Ship** <b>it</b>"}
        options={{ size: "heading", align: "start" }}
      />,
    );
    expect(textHtml).toContain("Goals</span></h3>");
    expect(textHtml).toContain("&lt;b&gt;it&lt;/b&gt;");
    const imageHtml = renderI18n(
      <ScrollImageCard
        widget={{ title: "Team", options: { fit: "cover", align: "center" } }}
        image={images.get(ID(50))!}
      />,
    );
    expect(imageHtml).toContain('alt="Team" width="64" height="64"');
    const missing = renderI18n(
      <ScrollImageCard
        widget={{ title: null, options: { fit: "contain", align: "center" } }}
        image={null}
      />,
      "de",
    );
    expect(missing).toContain("sw-notice");
  });
});

describe("display mode switch", () => {
  it("offers Scroll view and Screen view, the current one pressed", () => {
    const html = renderI18n(
      <DisplayModeSwitch mode="scroll" onChange={() => {}} />,
    );
    expect(html).toContain('role="group" aria-label="View"');
    expect(html).toContain('aria-pressed="true">Scroll view</button>');
    expect(html).toContain('aria-pressed="false">Screen view</button>');
  });

  it("speaks German", () => {
    const html = renderI18n(
      <DisplayModeSwitch mode="screen" onChange={() => {}} />,
      "de",
    );
    expect(html).toContain('aria-label="Ansicht"');
    expect(html).toContain('aria-pressed="false">Scroll-Ansicht</button>');
    expect(html).toContain('aria-pressed="true">Bildschirm-Ansicht</button>');
  });
});
