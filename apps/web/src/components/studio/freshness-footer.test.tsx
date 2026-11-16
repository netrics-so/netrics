import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DashboardWidgetData,
  DeviceWidget,
  WidgetFreshness,
} from "@netrics/contracts";

import { renderI18n } from "@/lib/i18n/test-render";
import { ScrollMetricCard } from "@/components/scroll/scroll-widgets";

import { deviceMetricReading } from "./device-widget";
import { LineWidgetView } from "./line-widget";
import { MeasureWidgetView } from "./measure-widget";
import { MetricWidgetView } from "./metric-widget";
import { ReviewWidgetView, deviceReviewReading } from "./review-widget";

// The freshness footer on widgets (ADR 0025 section 8, #705): the
// precedence of warnings, data states, a late provider and the normal
// line. Times that depend on the zone are kept out of the assertions.

const NOW = Date.parse("2026-11-16T12:50:00Z");
const TEN_MIN_AGO = "2026-11-16T12:40:00Z";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

/** The markup's text without tags, entities decoded, spaces plain. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[\u202f\u00a0]/g, " ");
}

/** The muted footer's text, or null. */
function footer(html: string): string | null {
  const match =
    /<p class="sw-muted sw-source sw-footer"[^>]*>([^<]*)<\/p>/.exec(html);
  return match ? text(match[1]!) : null;
}

/** The warning notice's text, or null. */
function notice(html: string): string | null {
  const match = /<p class="sw-notice[^"]*"[^>]*>(.*?)<\/p>/.exec(html);
  return match ? text(match[1]!).replace(/\s+/g, " ").trim() : null;
}

const periodic: WidgetFreshness = {
  kind: "periodic",
  stream: "Sales",
  fetchedAt: TEN_MIN_AGO,
  dataThrough: "2026-11-15",
  // Already past and not late: "next any minute", in every zone.
  nextExpectedAt: "2026-11-16T12:00:00Z",
};
const late: WidgetFreshness = {
  kind: "periodic",
  stream: "Sales",
  fetchedAt: TEN_MIN_AGO,
  dataThrough: "2026-11-14",
  nextExpectedAt: "2026-11-15T20:00:00Z",
  late: true,
  nextCheckAt: "2026-11-16T12:45:00Z",
};
const continuous: WidgetFreshness = {
  kind: "continuous",
  stream: "Reviews",
  fetchedAt: TEN_MIN_AGO,
  nextCheckAt: "2026-11-16T12:49:00Z",
};

const metric = {
  label: "Proceeds",
  period: "last_7_days" as const,
  aggregation: "sum" as const,
  metric: { kind: "counter", granularity: "day", better: "higher" } as const,
  reading: {
    value: 1248,
    unit: "count",
    delta: 120,
    ratio: 0.106,
    series: [{ value: 1 }, { value: 2 }],
    timeZone: "UTC",
  },
  notice: null,
  source: "App Store Connect",
  updatedAt: "2026-11-16T12:45:00Z",
  placement: { x: 0, y: 0, w: 8, h: 4 },
  showHeader: true,
  fontScale: 1,
  options: { showSparkline: false, showChange: true },
};

describe("metric widget footer", () => {
  it("without freshness keeps 'updated … ago · Source'", () => {
    const html = renderI18n(<MetricWidgetView {...metric} />);
    expect(footer(html)).toBe("updated 5 min. ago · App Store Connect");
  });

  it("periodic: up to, fetched and next", () => {
    const html = renderI18n(
      <MetricWidgetView {...metric} freshness={periodic} />,
    );
    expect(footer(html)).toBe(
      "Up to Nov 15 · fetched 10 min. ago · next any minute",
    );
    const de = renderI18n(
      <MetricWidgetView {...metric} freshness={periodic} />,
      "de",
    );
    expect(footer(de)).toBe(
      "Bis 15. Nov. · abgerufen vor 10 Min. · nächste in Kürze",
    );
  });

  it("a late provider is the muted footer, not a warning", () => {
    const html = renderI18n(<MetricWidgetView {...metric} freshness={late} />);
    expect(footer(html)).toBe(
      "Up to Nov 14 · Nov 15 not published yet · checking again any minute",
    );
    expect(notice(html)).toBeNull();
    expect(html).not.toContain("sw--stale");
  });

  it("an overdue provider is the stale warning in the late wording", () => {
    const html = renderI18n(
      <MetricWidgetView
        {...metric}
        status="stale"
        notice="Last sync 3 hr. ago"
        freshness={late}
      />,
    );
    expect(notice(html)).toBe("Up to Nov 14 · Nov 15 not published yet");
    expect(html).toContain("sw-notice--stale");
    expect(footer(html)).toBeNull();
  });

  it("a failing connection keeps its notice, with the covered day only", () => {
    const html = renderI18n(
      <MetricWidgetView
        {...metric}
        status="outage"
        notice="Source unreachable"
        freshness={periodic}
      />,
    );
    expect(notice(html)).toBe("⚠ Source unreachable · Up to Nov 15");
    expect(html).not.toContain("next any minute");
    expect(footer(html)).toBeNull();
  });

  it("no data and backfilling come before the freshness line", () => {
    for (const status of ["no_data", "backfilling"] as const) {
      const html = renderI18n(
        <MetricWidgetView
          {...metric}
          status={status}
          reading={null}
          freshness={periodic}
        />,
      );
      expect(html).toContain("sw--empty");
      expect(text(html)).not.toContain("Up to");
    }
  });

  it("auth failed keeps only the covered day in its footer", () => {
    const html = renderI18n(
      <MetricWidgetView {...metric} status="auth_failed" freshness={late} />,
    );
    expect(html).toContain("sw--auth");
    expect(footer(html)).toBe("Up to Nov 14 · Nov 15 not published yet");
  });

  it("a narrow widget drops parts from the end", () => {
    const full = "Up to Nov 15 · fetched 10 min. ago · next any minute";
    const shown = new Set<string>();
    for (let w = 1; w <= 12; w++) {
      const line = footer(
        renderI18n(
          <MetricWidgetView
            {...metric}
            placement={{ x: 0, y: 0, w, h: 4 }}
            freshness={periodic}
          />,
        ),
      );
      if (line === null) continue;
      // Whole parts only, from the start.
      expect([
        full,
        "Up to Nov 15 · fetched 10 min. ago",
        "Up to Nov 15",
      ]).toContain(line);
      shown.add(line);
    }
    expect(shown.has(full)).toBe(true);
    expect(shown.size).toBeGreaterThan(1);
  });

  it("a line widget shows it in its notice line", () => {
    const html = renderI18n(
      <LineWidgetView
        label="Proceeds"
        period="last_30_days"
        reading={{
          value: 10,
          unit: "count",
          series: Array.from({ length: 10 }, (_, index) => ({
            bucket: `2026-11-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
            value: index,
          })),
          previous: null,
          timeZone: "UTC",
        }}
        notice={null}
        updatedAt={TEN_MIN_AGO}
        freshness={continuous}
        placement={{ x: 0, y: 0, w: 8, h: 6 }}
        showHeader
        fontScale={1}
        options={{ showPrevious: false, showAxis: false }}
      />,
    );
    expect(footer(html)).toBe("Checked 10 min. ago · next check any minute");
  });
});

describe("payload widgets carry their freshness", () => {
  it("a device metric reading passes it on", () => {
    const widget = {
      id: "00000000-0000-4000-8000-000000000001",
      type: "metric",
      label: "Proceeds",
      x: 0,
      y: 0,
      w: 4,
      h: 3,
      options: { showSparkline: false, showChange: true },
      data: {
        period: "last_7_days",
        aggregation: "sum",
        unit: "count",
        conversion: null,
        kind: "counter",
        granularity: "day",
        better: "higher",
        status: "ok",
        updatedAt: TEN_MIN_AGO,
        freshness: periodic,
        value: 3,
        change: { delta: null, ratio: null },
        spark: [],
      },
    } as unknown as Extract<DeviceWidget, { type: "metric" }>;
    expect(deviceMetricReading(widget, "UTC", "en").freshness).toEqual(
      periodic,
    );
  });

  it("the scroll view's card shows the full line", () => {
    const html = renderI18n(
      <ScrollMetricCard
        {...metric}
        freshness={periodic}
        width={600}
        rootPx={16}
      />,
    );
    expect(footer(html)).toBe(
      "Up to Nov 15 · fetched 10 min. ago · next any minute",
    );
  });
});

describe("latest-review widget", () => {
  const review = {
    label: "Latest review",
    reading: {
      rating: 4,
      title: "Finally",
      body: "Good.",
      author: "Marta P.",
      territory: "DE",
      createdAt: "2026-11-16T10:00:00Z",
    },
    icon: null,
    notice: null,
    placement: { x: 0, y: 0, w: 8, h: 6 },
    showHeader: true,
    fontScale: 1,
  };

  it("shows the continuous wording", () => {
    const html = renderI18n(
      <ReviewWidgetView {...review} freshness={continuous} />,
    );
    expect(footer(html)).toBe("Checked 10 min. ago · next check any minute");
    const de = renderI18n(
      <ReviewWidgetView {...review} freshness={continuous} />,
      "de",
    );
    expect(footer(de)).toBe("Geprüft vor 10 Min. · nächste Prüfung in Kürze");
  });

  it("without freshness has no footer, as before", () => {
    expect(footer(renderI18n(<ReviewWidgetView {...review} />))).toBeNull();
  });

  it("a device review reading passes it on", () => {
    const widget = {
      id: "00000000-0000-4000-8000-000000000002",
      type: "review",
      label: "Latest review",
      imageId: null,
      x: 0,
      y: 0,
      w: 4,
      h: 3,
      data: {
        status: "ok",
        updatedAt: TEN_MIN_AGO,
        review: review.reading,
        freshness: continuous,
      },
    } as unknown as Extract<DeviceWidget, { type: "review" }>;
    expect(deviceReviewReading(widget, new Map(), "en").freshness).toEqual(
      continuous,
    );
  });
});

describe("measure widget footer", () => {
  const data = (extra: Partial<DashboardWidgetData>): DashboardWidgetData => ({
    widgetId: "00000000-0000-4000-8000-000000000003",
    metadata: null,
    result: {
      rows: [
        {
          dimensions: {},
          measures: { units: { value: 42, type: "integer" } },
        },
      ],
      warnings: [],
    } as unknown as DashboardWidgetData["result"],
    error: null,
    exclusions: [],
    ...extra,
  });
  const widget = {
    title: "Units",
    options: { view: "value" as const, limit: 20 },
    binding: { measureIds: ["units"], groupBy: [] },
  };
  /** The measure widget's freshness line. */
  const line = (html: string) =>
    /<p class="sw-measure-freshness[^"]*"[^>]*>(.*?)<\/p>/
      .exec(html)?.[1]
      ?.replace(/<[^>]+>/g, "")
      .replace(/[\u202f\u00a0]/g, " ");

  it("shows the freshness line, which it had no place for before", () => {
    const html = renderI18n(
      <MeasureWidgetView
        widget={widget}
        data={data({ freshness: periodic })}
      />,
    );
    expect(line(html)).toBe(
      "Up to Nov 15 · fetched 10 min. ago · next any minute",
    );
  });

  it("a late provider is muted; an overdue one is the warning", () => {
    const muted = renderI18n(
      <MeasureWidgetView widget={widget} data={data({ freshness: late })} />,
    );
    expect(muted).toContain('class="sw-measure-freshness"');
    expect(muted).toContain("Nov 15 not published yet");
    const overdue = renderI18n(
      <MeasureWidgetView
        widget={widget}
        data={data({ freshness: late, status: "stale" })}
      />,
    );
    expect(overdue).toContain('class="sw-measure-freshness sw-notice"');
    expect(line(overdue)).toBe("Up to Nov 14 · Nov 15 not published yet");
  });

  it("a failing source keeps its notice; the line keeps the covered day", () => {
    const html = renderI18n(
      <MeasureWidgetView
        widget={widget}
        data={data({
          freshness: periodic,
          sourceHealth: [
            {
              connectionId: "00000000-0000-4000-8000-000000000004",
              name: "App Store",
              status: "outage",
              lastSuccessAt: TEN_MIN_AGO,
            },
          ],
        })}
      />,
    );
    expect(line(html)).toBe("Up to Nov 15");
    expect(html).not.toContain("next any minute");
  });

  it("without freshness shows no line", () => {
    const html = renderI18n(
      <MeasureWidgetView widget={widget} data={data({})} />,
    );
    expect(line(html)).toBeUndefined();
  });
});
