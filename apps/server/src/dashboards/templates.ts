import type {
  DashboardSlideInput,
  DashboardWidgetInput,
  MetricPeriod,
  createDashboardRequestSchema,
} from "@netrics/contracts";
import type { z } from "zod";
import { STUDIO_GRID, STUDIO_LIMITS } from "@netrics/domain";

// Dashboard templates (ADR 0015 section 9, #226): pure builders that turn
// the workspace's connections into an ordinary studio dashboard. The
// service validates the result like any dashboard a user sends (bounds,
// overlap, minimum sizes, metrics, resources), and the tests check that
// every label fits at 1080p, so a template never starts out unreadable.

/** A dashboard as sent to POST /dashboards, before defaults apply. */
export type TemplateDashboard = z.input<typeof createDashboardRequestSchema>;

export const APP_STORE_CONNECT = "app-store-connect";
export const SEARCH_CONSOLE = "google-search-console";
export const VERCEL = "vercel";
export const DEMO = "demo";

/** Connectors the templates know metrics of, in the order they appear. */
export const TEMPLATE_CONNECTORS = [
  APP_STORE_CONNECT,
  SEARCH_CONSOLE,
  VERCEL,
  DEMO,
] as const;

export interface TemplateSource {
  connectionId: string;
  connectionName: string;
  connectorId: string;
  /** App Store Connect: the connection holds a reviews key (#190). */
  hasReviews?: boolean;
}

type DataType = "metric" | "line" | "bar";

interface WidgetSpec {
  type: DataType;
  connectionId: string;
  metricKey: string;
  period: MetricPeriod;
  title: string;
  groupBy?: string;
  dimensions?: Record<string, string>;
}

const ASC = {
  downloads: "app_store_connect.downloads",
  downloadsByTerritory: "app_store_connect.downloads_by_territory",
  proceeds: "app_store_connect.proceeds",
  reviews: "app_store_connect.reviews",
} as const;
const GSC = {
  clicks: "google-search-console.clicks",
  impressions: "google-search-console.impressions",
} as const;
const VERCEL_METRICS = {
  visitors: "vercel.visitors",
  pageviews: "vercel.pageviews",
  countryVisitors: "vercel.country_visitors",
} as const;
const DEMO_METRICS = {
  signups: "demo.signups",
  visitors: "demo.visitors",
} as const;

/** Metrics per slide row, and charts per slide, at most. */
const METRICS_PER_SLIDE = 4;
const CHARTS_PER_SLIDE = 2;
/** Rows of the metric band above the charts. */
const METRIC_ROWS = 3;

function spec(
  source: TemplateSource,
  type: DataType,
  metricKey: string,
  period: MetricPeriod,
  title: string,
  groupBy?: string,
): WidgetSpec {
  return {
    type,
    connectionId: source.connectionId,
    metricKey,
    period,
    title,
    ...(groupBy ? { groupBy } : {}),
  };
}

/** Splits `total` cells into `count` widths, larger ones first. */
export function splitWidths(total: number, count: number): number[] {
  const base = Math.floor(total / count);
  const extra = total - base * count;
  return Array.from({ length: count }, (_, index) =>
    index < extra ? base + 1 : base,
  );
}

function toWidget(
  widget: WidgetSpec,
  place: { x: number; y: number; w: number; h: number },
): DashboardWidgetInput {
  const binding = {
    ...place,
    connectionId: widget.connectionId,
    metricKey: widget.metricKey,
    period: widget.period,
    title: widget.title,
    ...(widget.dimensions ? { dimensions: widget.dimensions } : {}),
  };
  if (widget.type === "bar") {
    return {
      type: "bar",
      ...binding,
      options: { groupBy: widget.groupBy ?? "resource", limit: 5 },
    };
  }
  return { type: widget.type, ...binding };
}

/**
 * One slide: a band of metric widgets (3 rows, side by side) above up to
 * two charts (5 rows), or either alone over the full height. With a
 * `lead` image the band starts after it (the brand logo, 3 × 3).
 */
export function layoutSlide(
  name: string,
  metrics: readonly WidgetSpec[],
  charts: readonly WidgetSpec[],
  lead?: { imageId: string },
): DashboardSlideInput {
  const widgets: DashboardWidgetInput[] = [];
  const shownMetrics = metrics.slice(0, METRICS_PER_SLIDE - (lead ? 1 : 0));
  const shownCharts = charts.slice(0, CHARTS_PER_SLIDE);
  const band = shownCharts.length === 0 ? STUDIO_GRID.rows : METRIC_ROWS;
  let x = 0;
  if (lead) {
    widgets.push({
      type: "image",
      x: 0,
      y: 0,
      w: METRIC_ROWS,
      h: METRIC_ROWS,
      imageId: lead.imageId,
      options: { fit: "contain", align: "center" },
    });
    x = METRIC_ROWS;
  }
  const metricWidths = splitWidths(
    STUDIO_GRID.columns - x,
    Math.max(shownMetrics.length, 1),
  );
  shownMetrics.forEach((metric, index) => {
    widgets.push(
      toWidget(metric, { x, y: 0, w: metricWidths[index]!, h: band }),
    );
    x += metricWidths[index]!;
  });
  const top = shownMetrics.length > 0 || lead ? METRIC_ROWS : 0;
  if (top === 0 && shownCharts.length === 2) {
    // Charts alone: stacked, full width (two trends to compare).
    const half = STUDIO_GRID.rows / 2;
    shownCharts.forEach((chart, index) => {
      widgets.push(
        toWidget(chart, {
          x: 0,
          y: index * half,
          w: STUDIO_GRID.columns,
          h: half,
        }),
      );
    });
    return { name, widgets };
  }
  // Below the band: the trend wider than the breakdown.
  const chartWidths = shownCharts.length === 2 ? [7, 5] : [STUDIO_GRID.columns];
  let chartX = 0;
  shownCharts.forEach((chart, index) => {
    widgets.push(
      toWidget(chart, {
        x: chartX,
        y: top,
        w: chartWidths[index]!,
        h: STUDIO_GRID.rows - top,
      }),
    );
    chartX += chartWidths[index]!;
  });
  return { name, widgets };
}

/** Metric widgets beyond one band go on further slides of their own. */
function slidesFor(
  name: string,
  metrics: readonly WidgetSpec[],
  charts: readonly WidgetSpec[],
): DashboardSlideInput[] {
  const slides = [
    layoutSlide(name, metrics.slice(0, METRICS_PER_SLIDE), charts),
  ];
  for (
    let start = METRICS_PER_SLIDE;
    start < metrics.length;
    start += METRICS_PER_SLIDE
  ) {
    slides.push(
      layoutSlide(name, metrics.slice(start, start + METRICS_PER_SLIDE), []),
    );
  }
  return slides;
}

function byConnector(sources: readonly TemplateSource[], connectorId: string) {
  return sources
    .filter((source) => source.connectorId === connectorId)
    .sort(
      (a, b) =>
        a.connectionName.localeCompare(b.connectionName) ||
        a.connectionId.localeCompare(b.connectionId),
    );
}

/** "Downloads, 7 days", plus " · <connection>" when there are several. */
function titled(base: string, source: TemplateSource, several: boolean) {
  return several ? `${base} · ${source.connectionName}` : base;
}

/**
 * Overview: every connection the templates know, the store numbers on one
 * slide and the web numbers on another. Null when none is connected.
 */
export function buildOverviewTemplate(
  sources: readonly TemplateSource[],
  name = "Overview",
): TemplateDashboard | null {
  const slides: DashboardSlideInput[] = [];

  const stores = byConnector(sources, APP_STORE_CONNECT);
  if (stores.length > 0) {
    const several = stores.length > 1;
    const metrics = stores.flatMap((source) => [
      spec(
        source,
        "metric",
        ASC.downloads,
        "last_7_days",
        titled("Downloads, 7 days", source, several),
      ),
      spec(
        source,
        "metric",
        ASC.proceeds,
        "last_30_days",
        titled("Proceeds, 30 days", source, several),
      ),
      ...(source.hasReviews
        ? [
            spec(
              source,
              "metric",
              ASC.reviews,
              "last_30_days",
              titled("Reviews, 30 days", source, several),
            ),
          ]
        : []),
    ]);
    const first = stores[0]!;
    slides.push(
      ...slidesFor("App Store", metrics, [
        spec(
          first,
          "line",
          ASC.downloads,
          "last_30_days",
          "Downloads, 30 days",
        ),
        spec(
          first,
          "bar",
          ASC.downloads,
          "last_30_days",
          "Downloads by app",
          "resource",
        ),
      ]),
    );
  }

  const searches = byConnector(sources, SEARCH_CONSOLE);
  const sites = byConnector(sources, VERCEL);
  const demos = byConnector(sources, DEMO);
  const webMetrics = [
    ...searches.flatMap((source) => [
      spec(
        source,
        "metric",
        GSC.clicks,
        "last_7_days",
        titled("Search clicks, 7 days", source, searches.length > 1),
      ),
      spec(
        source,
        "metric",
        GSC.impressions,
        "last_7_days",
        titled("Impressions, 7 days", source, searches.length > 1),
      ),
    ]),
    ...sites.map((source) =>
      spec(
        source,
        "metric",
        VERCEL_METRICS.visitors,
        "last_7_days",
        titled("Visitors, 7 days", source, sites.length > 1),
      ),
    ),
    ...demos.flatMap((source) => [
      spec(
        source,
        "metric",
        DEMO_METRICS.signups,
        "last_7_days",
        titled("Signups, 7 days", source, demos.length > 1),
      ),
      spec(
        source,
        "metric",
        DEMO_METRICS.visitors,
        "last_7_days",
        titled("Visitors, 7 days", source, demos.length > 1),
      ),
    ]),
  ];
  const webCharts = [
    ...searches
      .slice(0, 1)
      .map((source) =>
        spec(
          source,
          "line",
          GSC.clicks,
          "last_30_days",
          "Search clicks, 30 days",
        ),
      ),
    ...sites
      .slice(0, 1)
      .map((source) =>
        spec(
          source,
          "line",
          VERCEL_METRICS.visitors,
          "last_30_days",
          "Visitors, 30 days",
        ),
      ),
    ...demos
      .slice(0, 1)
      .map((source) =>
        spec(
          source,
          "line",
          DEMO_METRICS.signups,
          "last_30_days",
          "Signups, 30 days",
        ),
      ),
  ];
  if (webMetrics.length > 0) {
    slides.push(...slidesFor("Web", webMetrics, webCharts));
  }

  if (slides.length === 0) {
    return null;
  }
  return {
    name,
    settings: { showHeader: true, autoAdvance: true },
    slides: slides.slice(0, STUDIO_LIMITS.slides),
  };
}

export interface BrandInput {
  source: TemplateSource;
  resourceId: string;
  resourceName: string;
  name?: string;
  logoImageId: string | null;
  accentColor: string | null;
}

/** The brand's numbers per connector: band, charts, and a trend slide. */
function brandSpecs(
  source: TemplateSource,
): { metrics: WidgetSpec[]; charts: WidgetSpec[]; trend: WidgetSpec[] } | null {
  switch (source.connectorId) {
    case APP_STORE_CONNECT:
      return {
        metrics: [
          spec(
            source,
            "metric",
            ASC.downloads,
            "last_7_days",
            "Downloads, 7 days",
          ),
          spec(
            source,
            "metric",
            ASC.proceeds,
            "last_30_days",
            "Proceeds, 30 days",
          ),
          ...(source.hasReviews
            ? [
                spec(
                  source,
                  "metric",
                  ASC.reviews,
                  "last_30_days",
                  "Reviews, 30 days",
                ),
              ]
            : []),
        ],
        charts: [
          spec(
            source,
            "line",
            ASC.downloads,
            "last_30_days",
            "Downloads, 30 days",
          ),
          spec(
            source,
            "bar",
            ASC.downloadsByTerritory,
            "last_30_days",
            "Top territories",
            "territory",
          ),
        ],
        trend: [
          spec(
            source,
            "line",
            ASC.downloads,
            "last_90_days",
            "Downloads, 90 days",
          ),
          spec(
            source,
            "line",
            ASC.proceeds,
            "last_90_days",
            "Proceeds, 90 days",
          ),
        ],
      };
    case SEARCH_CONSOLE:
      return {
        metrics: [
          spec(
            source,
            "metric",
            GSC.clicks,
            "last_7_days",
            "Search clicks, 7 days",
          ),
          spec(
            source,
            "metric",
            GSC.impressions,
            "last_7_days",
            "Impressions, 7 days",
          ),
        ],
        charts: [
          spec(
            source,
            "line",
            GSC.clicks,
            "last_30_days",
            "Search clicks, 30 days",
          ),
        ],
        trend: [
          spec(
            source,
            "line",
            GSC.clicks,
            "last_90_days",
            "Search clicks, 90 days",
          ),
          spec(
            source,
            "line",
            GSC.impressions,
            "last_90_days",
            "Impressions, 90 days",
          ),
        ],
      };
    case VERCEL:
      return {
        metrics: [
          spec(
            source,
            "metric",
            VERCEL_METRICS.visitors,
            "last_7_days",
            "Visitors, 7 days",
          ),
          spec(
            source,
            "metric",
            VERCEL_METRICS.pageviews,
            "last_7_days",
            "Page views, 7 days",
          ),
        ],
        charts: [
          spec(
            source,
            "line",
            VERCEL_METRICS.visitors,
            "last_30_days",
            "Visitors, 30 days",
          ),
          spec(
            source,
            "bar",
            VERCEL_METRICS.countryVisitors,
            "last_30_days",
            "Top countries",
            "country",
          ),
        ],
        trend: [
          spec(
            source,
            "line",
            VERCEL_METRICS.visitors,
            "last_90_days",
            "Visitors, 90 days",
          ),
          spec(
            source,
            "line",
            VERCEL_METRICS.pageviews,
            "last_90_days",
            "Page views, 90 days",
          ),
        ],
      };
    case DEMO:
      return {
        metrics: [
          spec(
            source,
            "metric",
            DEMO_METRICS.signups,
            "last_7_days",
            "Signups, 7 days",
          ),
          spec(
            source,
            "metric",
            DEMO_METRICS.visitors,
            "last_7_days",
            "Visitors, 7 days",
          ),
        ],
        charts: [
          spec(
            source,
            "line",
            DEMO_METRICS.signups,
            "last_30_days",
            "Signups, 30 days",
          ),
        ],
        trend: [
          spec(
            source,
            "line",
            DEMO_METRICS.signups,
            "last_90_days",
            "Signups, 90 days",
          ),
        ],
      };
    default:
      return null;
  }
}

/** Whether a Brand dashboard can be made for this connector's resources. */
export function brandSupported(connectorId: string): boolean {
  return (TEMPLATE_CONNECTORS as readonly string[]).includes(connectorId);
}

/**
 * Brand: one resource's own numbers (every data widget filtered to it),
 * its icon as the header logo and on the first slide, and an accent
 * colour. Null for a connector the templates do not know.
 */
export function buildBrandTemplate(
  input: BrandInput,
): TemplateDashboard | null {
  const specs = brandSpecs(input.source);
  if (!specs) {
    return null;
  }
  const filter = (widget: WidgetSpec): WidgetSpec => ({
    ...widget,
    dimensions: { resource: input.resourceId },
  });
  const lead = input.logoImageId ? { imageId: input.logoImageId } : undefined;
  return {
    name: (input.name ?? input.resourceName).slice(0, 100),
    settings: {
      showHeader: true,
      autoAdvance: true,
      accentColor: input.accentColor,
      logoImageId: input.logoImageId,
    },
    slides: [
      layoutSlide(
        "Today",
        specs.metrics.map(filter),
        specs.charts.map(filter),
        lead,
      ),
      layoutSlide("Trend", [], specs.trend.map(filter)),
    ],
  };
}
