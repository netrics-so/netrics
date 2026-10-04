import type {
  DashboardSlideInput,
  DashboardWidgetInput,
  MetricPeriod,
  createDashboardRequestSchema,
} from "@netrics/contracts";
import type { z } from "zod";
import {
  DEFAULT_LOCALE,
  STUDIO_GRID,
  STUDIO_LIMITS,
  createTranslator,
  type Catalog,
  type Locale,
} from "@netrics/domain";

import { templateDe } from "./template-messages/de.js";
import { templateEn, type TemplateMessages } from "./template-messages/en.js";

// Dashboard templates (ADR 0015 section 9, #226): pure builders that turn
// the workspace's connections into an ordinary studio dashboard. The
// service validates the result like any dashboard a user sends (bounds,
// overlap, minimum sizes, metrics, resources), and the tests check that
// every label fits at 1080p, so a template never starts out unreadable.
// Names and titles are in the creator's language (ADR 0016 section 5,
// #268); widgets whose automatic label says the same go untitled.

const TEMPLATE_CATALOGS: Readonly<Record<Locale, Catalog<TemplateMessages>>> = {
  en: templateEn,
  de: templateDe,
};

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
  /** Null: the automatic label (tileLabel) in the reader's language. */
  title: string | null;
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
  title: string | null,
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
    ...(widget.title ? { title: widget.title } : {}),
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

/** Days of the periods template titles name. */
const PERIOD_DAYS = {
  last_7_days: 7,
  last_30_days: 30,
  last_90_days: 90,
} as const;
type TitledPeriod = keyof typeof PERIOD_DAYS;
type MetricWord = keyof TemplateMessages["metrics"];

/** The template catalog in the creator's language (ADR 0016 section 5). */
function templateTexts(locale: Locale) {
  const t = createTranslator<TemplateMessages>({
    locale,
    messages: TEMPLATE_CATALOGS[locale],
    fallback: templateEn,
  });
  return {
    t,
    /** "Downloads, 30 days", "Erlöse, 30 Tage". */
    over(metric: MetricWord, period: TitledPeriod): string {
      return t("withPeriod", {
        metric: t(`metrics.${metric}`),
        days: PERIOD_DAYS[period],
      });
    },
  };
}

/**
 * Overview metric widgets go untitled: their automatic label ("Downloads ·
 * All apps", in the screen language) and period line ("Last 7 days ·
 * Total") say the same, and follow a later change of the screen language.
 * With several connections of one kind those labels would be alike, so
 * the title names the connection: "Downloads, 7 days · Studio A".
 */
function overviewTitle(
  text: ReturnType<typeof templateTexts>,
  metric: MetricWord,
  period: TitledPeriod,
  source: TemplateSource,
  several: boolean,
): string | null {
  return several
    ? `${text.over(metric, period)} · ${source.connectionName}`
    : null;
}

export interface OverviewOptions {
  /** Default: "Overview" in the creator's language. */
  name?: string | undefined;
  /** The creator's language; default English. */
  locale?: Locale;
}

/**
 * Overview: every connection the templates know, the store numbers on one
 * slide and the web numbers on another. Null when none is connected.
 */
export function buildOverviewTemplate(
  sources: readonly TemplateSource[],
  options: OverviewOptions = {},
): TemplateDashboard | null {
  const text = templateTexts(options.locale ?? DEFAULT_LOCALE);
  const { t } = text;
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
        overviewTitle(text, "downloads", "last_7_days", source, several),
      ),
      spec(
        source,
        "metric",
        ASC.proceeds,
        "last_30_days",
        overviewTitle(text, "proceeds", "last_30_days", source, several),
      ),
      ...(source.hasReviews
        ? [
            spec(
              source,
              "metric",
              ASC.reviews,
              "last_30_days",
              overviewTitle(text, "reviews", "last_30_days", source, several),
            ),
          ]
        : []),
    ]);
    const first = stores[0]!;
    // Charts have no period line: their titles name it.
    slides.push(
      ...slidesFor(t("slides.appStore"), metrics, [
        spec(
          first,
          "line",
          ASC.downloads,
          "last_30_days",
          text.over("downloads", "last_30_days"),
        ),
        spec(
          first,
          "bar",
          ASC.downloads,
          "last_30_days",
          t("downloadsByApp"),
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
        overviewTitle(
          text,
          "searchClicks",
          "last_7_days",
          source,
          searches.length > 1,
        ),
      ),
      spec(
        source,
        "metric",
        GSC.impressions,
        "last_7_days",
        overviewTitle(
          text,
          "impressions",
          "last_7_days",
          source,
          searches.length > 1,
        ),
      ),
    ]),
    ...sites.map((source) =>
      spec(
        source,
        "metric",
        VERCEL_METRICS.visitors,
        "last_7_days",
        overviewTitle(
          text,
          "visitors",
          "last_7_days",
          source,
          sites.length > 1,
        ),
      ),
    ),
    ...demos.flatMap((source) => [
      spec(
        source,
        "metric",
        DEMO_METRICS.signups,
        "last_7_days",
        overviewTitle(text, "signups", "last_7_days", source, demos.length > 1),
      ),
      spec(
        source,
        "metric",
        DEMO_METRICS.visitors,
        "last_7_days",
        overviewTitle(
          text,
          "visitors",
          "last_7_days",
          source,
          demos.length > 1,
        ),
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
          text.over("searchClicks", "last_30_days"),
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
          text.over("visitors", "last_30_days"),
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
          text.over("signups", "last_30_days"),
        ),
      ),
  ];
  if (webMetrics.length > 0) {
    slides.push(...slidesFor(t("slides.web"), webMetrics, webCharts));
  }

  if (slides.length === 0) {
    return null;
  }
  return {
    name: options.name ?? t("overviewName"),
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
  /** The creator's language; default English. */
  locale?: Locale;
}

/**
 * The brand's numbers per connector: band, charts, and a trend slide.
 *
 * Every Brand widget is titled. Its automatic label would repeat the
 * brand's name ("Downloads · Wurfel – Cube Solver") on every widget of a
 * dashboard named after it, and a long name wraps and, in a narrow band
 * at a large font scale, pushes out the period line; the title names the
 * period instead. Charts have no period line at all.
 */
function brandSpecs(
  source: TemplateSource,
  text: ReturnType<typeof templateTexts>,
): { metrics: WidgetSpec[]; charts: WidgetSpec[]; trend: WidgetSpec[] } | null {
  const { t, over } = text;
  const at = (
    type: DataType,
    metricKey: string,
    period: TitledPeriod,
    word: MetricWord,
  ) => spec(source, type, metricKey, period, over(word, period));
  switch (source.connectorId) {
    case APP_STORE_CONNECT:
      return {
        metrics: [
          at("metric", ASC.downloads, "last_7_days", "downloads"),
          at("metric", ASC.proceeds, "last_30_days", "proceeds"),
          ...(source.hasReviews
            ? [at("metric", ASC.reviews, "last_30_days", "reviews")]
            : []),
        ],
        charts: [
          at("line", ASC.downloads, "last_30_days", "downloads"),
          spec(
            source,
            "bar",
            ASC.downloadsByTerritory,
            "last_30_days",
            t("topTerritories"),
            "territory",
          ),
        ],
        trend: [
          at("line", ASC.downloads, "last_90_days", "downloads"),
          at("line", ASC.proceeds, "last_90_days", "proceeds"),
        ],
      };
    case SEARCH_CONSOLE:
      return {
        metrics: [
          at("metric", GSC.clicks, "last_7_days", "searchClicks"),
          at("metric", GSC.impressions, "last_7_days", "impressions"),
        ],
        charts: [at("line", GSC.clicks, "last_30_days", "searchClicks")],
        trend: [
          at("line", GSC.clicks, "last_90_days", "searchClicks"),
          at("line", GSC.impressions, "last_90_days", "impressions"),
        ],
      };
    case VERCEL:
      return {
        metrics: [
          at("metric", VERCEL_METRICS.visitors, "last_7_days", "visitors"),
          at("metric", VERCEL_METRICS.pageviews, "last_7_days", "pageViews"),
        ],
        charts: [
          at("line", VERCEL_METRICS.visitors, "last_30_days", "visitors"),
          spec(
            source,
            "bar",
            VERCEL_METRICS.countryVisitors,
            "last_30_days",
            t("topCountries"),
            "country",
          ),
        ],
        trend: [
          at("line", VERCEL_METRICS.visitors, "last_90_days", "visitors"),
          at("line", VERCEL_METRICS.pageviews, "last_90_days", "pageViews"),
        ],
      };
    case DEMO:
      return {
        metrics: [
          at("metric", DEMO_METRICS.signups, "last_7_days", "signups"),
          at("metric", DEMO_METRICS.visitors, "last_7_days", "visitors"),
        ],
        charts: [at("line", DEMO_METRICS.signups, "last_30_days", "signups")],
        trend: [at("line", DEMO_METRICS.signups, "last_90_days", "signups")],
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
  const text = templateTexts(input.locale ?? DEFAULT_LOCALE);
  const specs = brandSpecs(input.source, text);
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
        text.t("slides.today"),
        specs.metrics.map(filter),
        specs.charts.map(filter),
        lead,
      ),
      layoutSlide(text.t("slides.trend"), [], specs.trend.map(filter)),
    ],
  };
}
