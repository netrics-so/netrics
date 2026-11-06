import { describe, expect, it } from "vitest";

import type {
  ConnectionStateView,
  DashboardSlide,
  DashboardWidget,
} from "@netrics/contracts";
import { BUILTIN_THEMES, STUDIO_TEXT_MINIMUMS } from "@netrics/domain";

import { u, widgetBoxStyle } from "@/lib/studio-render";
import { studioVectors } from "@/lib/studio-vectors.test-helper";
import type { StudioEnv, StudioWidget } from "@/lib/studio-widgets";

import { BarWidgetView } from "./bar-widget";
import { ClockWidgetView } from "./clock-widget";
import { ImageWidgetView } from "./image-widget";
import { LineWidgetView } from "./line-widget";
import { MetricWidgetView, liveDataState } from "./metric-widget";
import { LiveWidget, SlideCanvas, WidgetBoundary } from "./slide-canvas";
import { TextWidgetView } from "./text-widget";
import { renderI18n } from "@/lib/i18n/test-render";

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Every font size the markup sets, in units. */
function fontSizes(html: string): number[] {
  return [...html.matchAll(/font-size:calc\(var\(--u\) \* ([\d.]+)\)/g)].map(
    (match) => Number(match[1]),
  );
}

/** The markup's text without tags, entities decoded. */
function text(html: string): string {
  return html
    .replace(/<br\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

const placement = { x: 0, y: 0, w: 4, h: 3 };
const series = [10, 14, 12, 18, 22, 21, 25].map((value, index) => ({
  bucket: `2026-09-${String(index + 20)}T00:00:00.000Z`,
  value,
}));

describe("metric widget", () => {
  const props = {
    label: "Proceeds · Paperstand – Magazine reader",
    period: "last_7_days" as const,
    aggregation: "sum" as const,
    metric: { kind: "counter", granularity: "day", better: "higher" } as const,
    reading: {
      value: 1248,
      unit: "count",
      delta: 120,
      ratio: 0.106,
      series,
      timeZone: "UTC",
    },
    notice: null,
    source: "App Store Connect",
    placement,
    showHeader: true,
    fontScale: 1,
    options: { showSparkline: true, showChange: true },
  };

  it("shows the label in full as title and resource line, value and change", () => {
    const html = renderI18n(<MetricWidgetView {...props} />);
    expect(html).toContain('<h3 class="sw-title"');
    expect(html).toContain(">Proceeds</h3>");
    expect(html).toContain(">Paperstand – Magazine reader</p>");
    expect(html).not.toContain("data-truncated");
    expect(html).toContain(">1,248</p>");
    expect(html).toContain('class="sw-change good"');
    expect(text(html)).toContain("▲ +11% vs previous 7 days");
    expect(html).toContain(
      '<span class="sw-comparison">vs previous 7 days</span>',
    );
    expect(html).toContain("App Store Connect");
  });

  it("never sets text below the minimums", () => {
    for (const fontScale of [1, 1.15, 1.3]) {
      const html = renderI18n(
        <MetricWidgetView
          {...props}
          fontScale={fontScale}
          placement={{ x: 0, y: 0, w: 3, h: 2 }}
          notice="Connection needs new credentials"
        />,
      );
      const sizes = fontSizes(html);
      expect(sizes.length).toBeGreaterThan(3);
      expect(Math.min(...sizes)).toBeGreaterThanOrEqual(
        STUDIO_TEXT_MINIMUMS.any,
      );
      expect(html).toContain("Connection needs new credentials");
    }
  });

  it("sizes the title and resource like the shared type scale", () => {
    const vector = studioVectors.typeScales.find(
      (entry) =>
        entry.type === "metric" &&
        entry.w === 4 &&
        entry.h === 3 &&
        entry.fontScale === 1 &&
        entry.showHeader,
    )!;
    const html = renderI18n(<MetricWidgetView {...props} />);
    expect(html).toContain(
      `<h3 class="sw-title" style="font-size:${u(vector.sizes.title!)}"`,
    );
    expect(html).toContain(
      `<p class="sw-resource" style="font-size:${u(vector.sizes.resource!)}"`,
    );
  });

  it("marks a label that cannot fit as truncated, with the full text kept", () => {
    const long = `Downloads · ${"Extremely long application name ".repeat(4).trim()}`;
    const html = renderI18n(
      <MetricWidgetView
        {...props}
        label={long}
        placement={{ x: 0, y: 0, w: 3, h: 2 }}
      />,
    );
    expect(html).toContain('data-truncated="true"');
    expect(html).toContain(`title="${long.slice(12)}"`);
  });

  it("shows a placeholder while loading and a notice when it failed", () => {
    const loading = renderI18n(
      <MetricWidgetView {...props} reading={null} loading />,
    );
    expect(loading).toContain("sw-placeholder");
    expect(loading).toContain(">…</p>");
    const failed = renderI18n(
      <MetricWidgetView {...props} reading={null} notice="Could not load" />,
    );
    expect(failed).toContain('class="sw-notice"');
    expect(failed).toContain("Could not load");
  });
});

describe("line widget", () => {
  const props = {
    label: "Clicks · example.com",
    period: "last_7_days" as const,
    reading: {
      value: 122,
      unit: "count",
      series,
      previous: series.map((point) => ({
        ...point,
        value: point.value - 3,
      })),
      timeZone: "UTC",
    },
    notice: null,
    placement,
    showHeader: true,
    fontScale: 1,
    options: { showPrevious: true, showAxis: true },
  };

  it("draws the period, the previous period dashed and labelled axes", () => {
    const html = renderI18n(<LineWidgetView {...props} />);
    expect(html).toContain('class="sw-line-current"');
    expect(html).toContain('class="sw-line-previous"');
    expect(html).toContain('class="sw-line-last"');
    const axisSizes = [
      ...html.matchAll(/class="sw-axis-label"[^>]*font-size="([\d.]+)"/g),
    ].map((match) => Number(match[1]));
    expect(axisSizes).toHaveLength(4);
    expect(Math.min(...axisSizes)).toBeGreaterThanOrEqual(24);
    expect(text(html)).toContain("Sep 20");
    expect(text(html)).toContain("Sep 26");
  });

  it("leaves out what its options switch off", () => {
    const html = renderI18n(
      <LineWidgetView
        {...props}
        options={{ showPrevious: false, showAxis: false }}
      />,
    );
    expect(html).not.toContain("sw-line-previous");
    expect(html).not.toContain("sw-axis-label");
  });
});

describe("bar widget", () => {
  it("lists the groups with Others last and never cuts a name silently", () => {
    const html = renderI18n(
      <BarWidgetView
        label="Downloads by app"
        reading={{
          unit: "count",
          groups: [
            { label: "Wurfel", value: 812 },
            { label: "Paperstand – Magazine reader", value: 377 },
          ],
          others: { label: "Others", value: 129 },
        }}
        notice={null}
        placement={placement}
        showHeader
        fontScale={1}
      />,
    );
    const labels = [
      ...html.matchAll(/class="sw-bar-label"[^>]*>([^<]*)</g),
    ].map((match) => match[1]);
    expect(labels).toEqual([
      "Wurfel",
      "Paperstand – Magazine reader",
      "Others",
    ]);
    expect(html).not.toContain("data-truncated");
    expect(html).toContain('class="sw-bar-row others"');
    expect(html).toContain("width:100.00%");
    expect(Math.min(...fontSizes(html))).toBeGreaterThanOrEqual(24);
  });
});

describe("freshness footer and figures (ADR 0018 section 5, #309)", () => {
  const minutesAgo = (minutes: number) =>
    new Date(Date.now() - minutes * 60_000).toISOString();
  const metric = {
    label: "Proceeds · Paperstand",
    period: "last_7_days" as const,
    aggregation: "sum" as const,
    metric: { kind: "counter", granularity: "day", better: "higher" } as const,
    reading: {
      value: 1248,
      unit: "count",
      delta: 120,
      ratio: 0.106,
      series,
      timeZone: "UTC",
    },
    notice: null,
    source: "App Store Connect",
    updatedAt: minutesAgo(5),
    placement: { x: 0, y: 0, w: 6, h: 4 },
    showHeader: true,
    fontScale: 1,
    options: { showSparkline: true, showChange: true },
  };
  const footers = (html: string) =>
    [
      ...html.matchAll(
        /<p class="sw-muted sw-source sw-footer"[^>]*>([^<]*)</g,
      ),
    ].map((match) => match[1]);

  it("says when the numbers were updated and from where, at 24 units", () => {
    const html = renderI18n(<MetricWidgetView {...metric} />);
    expect(footers(html)).toEqual(["updated 5 min. ago · App Store Connect"]);
    expect(html).toContain(
      `<p class="sw-muted sw-source sw-footer" style="font-size:${u(24)}"`,
    );
    expect(Math.min(...fontSizes(html))).toBeGreaterThanOrEqual(
      STUDIO_TEXT_MINIMUMS.any,
    );
  });

  it("words the footer in German with Intl", () => {
    const html = renderI18n(<MetricWidgetView {...metric} />, "de");
    expect(footers(html)).toEqual([
      "aktualisiert vor 5 Min. · App Store Connect",
    ]);
  });

  it("shortens the footer to one line in a narrow widget", () => {
    const html = renderI18n(
      <MetricWidgetView
        {...metric}
        placement={{ x: 0, y: 0, w: 3, h: 4 }}
        source="App Store Connect for Wurfel and Paperstand"
      />,
    );
    expect(footers(html)).toEqual(["updated 5 min. ago"]);
  });

  it("shows the stale notice in the footer's place, in the warning colour", () => {
    const html = renderI18n(
      <MetricWidgetView {...metric} notice="Last sync 3 hours ago" />,
    );
    expect(footers(html)).toEqual([]);
    expect(html).toContain('class="sw-notice"');
    expect(text(html)).toContain("Last sync 3 hours ago");
  });

  it("draws the sparkline between the label and the value", () => {
    const html = renderI18n(<MetricWidgetView {...metric} />);
    const spark = html.indexOf('class="sw-spark"');
    expect(spark).toBeGreaterThan(html.indexOf('class="sw-resource"'));
    expect(spark).toBeLessThan(html.indexOf('class="sw-value"'));
  });

  it("gives line and bar widgets the footer while the chart keeps its room", () => {
    const line = renderI18n(
      <LineWidgetView
        label="Clicks · example.com"
        period="last_7_days"
        reading={{
          value: 122,
          unit: "count",
          series,
          previous: series,
          timeZone: "UTC",
        }}
        notice={null}
        source="Search Console"
        updatedAt={minutesAgo(2)}
        placement={{ x: 0, y: 0, w: 6, h: 5 }}
        showHeader
        fontScale={1}
        options={{ showPrevious: true, showAxis: true }}
      />,
    );
    expect(footers(line)).toEqual(["updated 2 min. ago · Search Console"]);
    // The area fades from the chart fill (a gradient per widget).
    expect(line).toMatch(/<linearGradient id="sw-area-[\w-]+"/);
    expect(line).toContain('class="sw-line-area-from"');
    expect(line).toMatch(
      /class="sw-line-area" d="[^"]+" style="fill:url\(#sw-area-/,
    );

    const bar = (placement: { x: number; y: number; w: number; h: number }) =>
      renderI18n(
        <BarWidgetView
          label="Downloads by app"
          reading={{
            unit: "count",
            groups: [{ label: "Wurfel", value: 812 }],
            others: null,
          }}
          notice={null}
          source="App Store Connect"
          updatedAt={minutesAgo(1)}
          placement={placement}
          showHeader
          fontScale={1}
        />,
      );
    expect(footers(bar({ x: 0, y: 0, w: 4, h: 5 }))).toEqual([
      "updated 1 min. ago · App Store Connect",
    ]);
    // A chart that would get too small (a long label at the minimum
    // size) keeps its room: no footer.
    const crowded = renderI18n(
      <LineWidgetView
        label="Proceeds in every currency · Paperstand – Magazine reader for iPad"
        period="last_7_days"
        reading={{
          value: 1234567,
          unit: "EUR_minor",
          series,
          previous: null,
          timeZone: "UTC",
        }}
        notice={null}
        source="App Store Connect"
        updatedAt={minutesAgo(2)}
        placement={{ x: 0, y: 0, w: 4, h: 3 }}
        showHeader
        fontScale={1}
        options={{ showPrevious: false, showAxis: true }}
      />,
    );
    expect(crowded).toContain("<svg");
    expect(footers(crowded)).toEqual([]);
  });
});

describe("image widget", () => {
  it("keeps the aspect ratio with contain or cover", () => {
    const image = { id: ID(5), url: "/img.png", width: 512, height: 256 };
    const contain = renderI18n(
      <ImageWidgetView
        widget={{
          title: "Wurfel",
          options: { fit: "contain", align: "start" },
        }}
        image={image}
      />,
    );
    expect(contain).toContain('src="/img.png"');
    expect(contain).toContain('alt="Wurfel"');
    expect(contain).toContain('width="512"');
    expect(contain).toContain("object-fit:contain");
    expect(contain).toContain("object-position:0% 50%");
    const cover = renderI18n(
      <ImageWidgetView
        widget={{ title: null, options: { fit: "cover", align: "center" } }}
        image={image}
      />,
    );
    expect(cover).toContain("object-fit:cover");
    expect(cover).toContain('alt=""');
  });

  it("says so when the image is gone", () => {
    const html = renderI18n(
      <ImageWidgetView
        widget={{ title: null, options: { fit: "contain", align: "center" } }}
        image={null}
      />,
    );
    expect(html).toContain("Image not available");
    expect(html).not.toContain("<img");
  });
});

describe("text widget", () => {
  const render = (source: string) =>
    renderI18n(
      <TextWidgetView
        text={source}
        options={{ size: "body", align: "start" }}
        placement={{ x: 0, y: 0, w: 12, h: 8 }}
        showHeader
        fontScale={1}
      />,
    );

  it("renders every shared markdown vector as its blocks", () => {
    for (const vector of studioVectors.markdown) {
      const html = render(vector.source);
      const headings = vector.blocks.filter(
        (block) => block.kind === "heading",
      );
      expect((html.match(/<h[34][ >]/g) ?? []).length).toBe(headings.length);
      const paragraphs = vector.blocks.filter(
        (block) => block.kind === "paragraph",
      );
      expect((html.match(/<p[ >]/g) ?? []).length).toBe(paragraphs.length);
      const spans = vector.blocks.flatMap((block) =>
        block.kind === "heading" ? block.spans : block.lines.flat(),
      );
      expect((html.match(/<strong>/g) ?? []).length).toBe(
        spans.filter((span) => span.bold).length,
      );
      expect((html.match(/<em>/g) ?? []).length).toBe(
        spans.filter((span) => span.italic).length,
      );
      const expected = vector.blocks
        .map((block) =>
          block.kind === "heading"
            ? block.spans.map((span) => span.text).join("")
            : block.lines
                .map((line) => line.map((span) => span.text).join(""))
                .join("\n"),
        )
        .join("");
      expect(text(html)).toBe(expected);
    }
  });

  it("shows HTML literally, never as markup", () => {
    const html = render(
      '<script>alert(1)</script>\n<img src=x onerror="alert(2)">\n**<b>bold</b>**',
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<b>/);
    expect(text(html)).toBe(
      '<script>alert(1)</script>\n<img src=x onerror="alert(2)">\n<b>bold</b>',
    );
  });
});

describe("clock widget", () => {
  it("shows the time in its zone and the date", () => {
    const html = renderI18n(
      <ClockWidgetView
        now={new Date("2026-10-04T12:05:00Z")}
        timeZone="Europe/Berlin"
        options={{ showDate: true, hour12: false }}
        placement={{ x: 0, y: 0, w: 3, h: 2 }}
        showHeader
        fontScale={1}
      />,
    );
    expect(text(html)).toContain("14:05");
    expect(text(html)).toContain("Sun 4 Oct");
    expect(Math.max(...fontSizes(html))).toBeGreaterThanOrEqual(56);
  });

  it("shows the long date and the zone line where they fit (ADR 0019 §9)", () => {
    const html = renderI18n(
      <ClockWidgetView
        now={new Date("2026-10-04T12:05:00Z")}
        timeZone="Europe/Berlin"
        options={{
          showDate: true,
          hour12: false,
          dateStyle: "long",
          showZone: true,
        }}
        placement={{ x: 0, y: 0, w: 3, h: 3 }}
        showHeader
        fontScale={1}
      />,
    );
    expect(text(html)).toContain("Sunday, 4 October");
    expect(text(html)).toContain("Berlin \u00b7 UTC+2");
    expect(Math.min(...fontSizes(html))).toBeGreaterThanOrEqual(24);
  });

  it("shows only the time in a 2 × 1 clock with both options", () => {
    const html = renderI18n(
      <ClockWidgetView
        now={new Date("2026-10-04T12:05:00Z")}
        timeZone="Europe/Berlin"
        options={{
          showDate: true,
          hour12: false,
          dateStyle: "long",
          showZone: true,
        }}
        placement={{ x: 0, y: 0, w: 2, h: 1 }}
        showHeader
        fontScale={1}
      />,
    );
    expect(text(html)).toBe("14:05");
  });
});

describe("slide canvas", () => {
  const state: ConnectionStateView = {
    health: "ok",
    authState: "ok",
    authReason: null,
    lastSuccessAt: new Date().toISOString(),
    nextDueAt: null,
    consecutiveFailures: 0,
    pollIntervalSeconds: 300,
  };
  const env: StudioEnv = {
    workspaceId: ID(1),
    timeZone: "Europe/Berlin",
    fontScale: 1,
    showHeader: true,
    metrics: new Map(),
    connections: { [ID(9)]: { name: "App Store Connect", state } },
    images: new Map([
      [ID(50), { id: ID(50), url: "/logo.png", width: 64, height: 64 }],
      [ID(52), { id: ID(52), url: "/bg.jpg", width: 1920, height: 1080 }],
    ]),
  };
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
  const widgets: StudioWidget[] = [
    {
      type: "metric",
      id: ID(11),
      x: 0,
      y: 0,
      w: 3,
      h: 2,
      title: null,
      ...binding,
      options: { showSparkline: true, showChange: true },
    },
    {
      type: "line",
      id: ID(12),
      x: 3,
      y: 0,
      w: 5,
      h: 4,
      title: null,
      ...binding,
      options: { showPrevious: true, showAxis: true },
    },
    {
      type: "bar",
      id: ID(13),
      x: 8,
      y: 0,
      w: 4,
      h: 4,
      title: null,
      ...binding,
      options: { groupBy: "resource", limit: 5 },
    },
    {
      type: "image",
      id: ID(14),
      x: 0,
      y: 2,
      w: 3,
      h: 2,
      title: "Logo",
      imageId: ID(50),
      options: { fit: "contain", align: "center" },
    },
    {
      type: "text",
      id: ID(15),
      x: 0,
      y: 4,
      w: 6,
      h: 4,
      title: null,
      text: "## Wurfel\n<script>x</script>",
      options: { size: "body", align: "start" },
    },
    {
      type: "clock",
      id: ID(16),
      x: 6,
      y: 4,
      w: 6,
      h: 4,
      title: null,
      options: {
        showDate: true,
        hour12: false,
        timeZone: null,
        dateStyle: "short",
        showZone: false,
      },
    },
  ];
  const slide = {
    id: ID(20),
    position: 0,
    name: "Sales",
    durationSeconds: null,
    enabled: true,
    widgets: widgets as DashboardWidget[],
    background: { imageId: ID(52), dim: 40 },
  } as DashboardSlide;

  const render = (renderWidget: (widget: StudioWidget) => React.ReactNode) =>
    renderI18n(
      <SlideCanvas
        slide={slide}
        tokens={BUILTIN_THEMES.paper.tokens}
        showHeader
        header={{
          name: "Wurfel",
          slideName: "Sales",
          logoImageId: ID(50),
          timeZone: "Europe/Berlin",
          offline: true,
        }}
        images={env.images}
        renderWidget={renderWidget}
      />,
    );

  it("places every widget type by studioLayout, themed by CSS variables", () => {
    const html = render((widget) => <LiveWidget widget={widget} env={env} />);
    expect(html).toContain("--t-background:#f2ede2");
    expect(html).toContain("--t-accent:#a64b22");
    for (const widget of widgets) {
      const box = widgetBoxStyle(widget, true);
      expect(html).toContain(
        `class="studio-widget studio-widget--${widget.type}" style="left:${box.left};top:${box.top};width:${box.width};height:${box.height}" data-widget-id="${widget.id}"`,
      );
    }
    expect(html).toContain('src="/logo.png"');
    expect(html).toContain('class="studio-background" src="/bg.jpg"');
    // The background covers the whole 16:9 slide, centred, whatever its
    // aspect ratio (#245).
    expect(html).toMatch(
      /class="studio-background"[^>]*style="[^"]*top:0;right:0;bottom:0;left:0;[^"]*width:100%;height:100%;[^"]*object-fit:cover;object-position:center"/,
    );
    expect(html).toContain(
      'class="studio-background-dim" style="position:absolute;top:0;right:0;bottom:0;left:0;opacity:0.4"',
    );
    expect(text(html)).toContain("Wurfel");
    expect(text(html)).toContain("Sales");
    expect(text(html)).toContain("Offline");
    expect(html).not.toContain("<script");
  });

  it("keeps a widget it does not know as a notice, not a blank slide", () => {
    const unknown = {
      ...widgets[0]!,
      type: "heatmap",
    } as unknown as StudioWidget;
    const html = renderI18n(<LiveWidget widget={unknown} env={env} />);
    expect(html).toContain("This widget could not be shown");
  });

  it("catches a widget that fails to render", () => {
    expect(WidgetBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    const boundary = new WidgetBoundary({ children: null });
    boundary.state = { failed: true };
    expect(renderI18n(<>{boundary.render()}</>)).toContain(
      "This widget could not be shown",
    );
  });

  it("leaves the header out when the dashboard hides it", () => {
    const html = renderI18n(
      <SlideCanvas
        slide={slide}
        tokens={BUILTIN_THEMES.netrics_dark.tokens}
        showHeader={false}
        header={{
          name: "Wurfel",
          slideName: null,
          logoImageId: null,
          timeZone: "UTC",
        }}
        images={new Map()}
        renderWidget={() => null}
      />,
    );
    expect(html).not.toContain("studio-header");
    // The background image is missing: no broken picture.
    expect(html).not.toContain("studio-background");
    const box = widgetBoxStyle(widgets[0]!, false);
    expect(html).toContain(`left:${box.left};top:${box.top}`);
  });
});

describe("liveDataState (#311)", () => {
  const connection = {
    state: {
      health: "pending" as const,
      authState: "ok" as const,
      authReason: null,
      lastSuccessAt: null,
      nextDueAt: null,
      consecutiveFailures: 0,
      pollIntervalSeconds: 300,
    },
  };
  const query = { error: null, loading: false, loaded: true, hasData: false };

  it("is backfilling while a new connection loads its history", () => {
    expect(liveDataState(query, connection, "en").status).toBe("backfilling");
  });

  it("is not a data state during the first load", () => {
    expect(
      liveDataState(
        { ...query, loading: true, loaded: false },
        connection,
        "en",
      ).status,
    ).toBe("ok");
  });

  it("keeps the notice of a failed query or a removed connection", () => {
    expect(
      liveDataState({ ...query, error: "boom" }, connection, "en"),
    ).toEqual({
      notice: "Refresh failed",
      status: "outage",
    });
    expect(liveDataState(query, undefined, "en")).toEqual({
      notice: "Connection removed",
      status: "outage",
    });
  });
});
