import type {
  DashboardSlideInput,
  DashboardWidgetInput,
  MetricPeriod,
  createDashboardRequestSchema,
} from "@netrics/contracts";
import type { z } from "zod";
import {
  DEFAULT_LOCALE,
  STUDIO_FONT_SCALES,
  STUDIO_GRID,
  STUDIO_LIMITS,
  createTranslator,
  slideFormatWarnings,
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
export const APPLE_ADS = "apple-ads";
export const SEARCH_CONSOLE = "google-search-console";
export const VERCEL = "vercel";
export const DEMO = "demo";

/** Connectors the templates know metrics of, in the order they appear. */
export const TEMPLATE_CONNECTORS = [
  APP_STORE_CONNECT,
  APPLE_ADS,
  SEARCH_CONSOLE,
  VERCEL,
  DEMO,
] as const;

/**
 * Connectors a Brand dashboard can be made for. Apple Ads is not one: its
 * numbers are the ad account's, on the Overview's Apple Ads slide.
 */
const BRAND_CONNECTORS = [
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
  /**
   * Apple Ads (#375): the ad account's currency and time zone, from the
   * connection's config. Spend is shown in that currency, and the days
   * are that zone's (ADR 0020 sections 7 and 8).
   */
  currency?: string | null;
  timeZone?: string | null;
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
/**
 * Apple Ads (ADR 0020 section 6): campaign × country rows, so an
 * unfiltered sum is the ad account's total. Ad-group keys are not used.
 */
const ADS = {
  spend: "apple_ads.spend",
  installs: "apple_ads.installs",
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

/** An Apple Ads currency from the connection's config, else null. */
function adsCurrency(source: TemplateSource): string | null {
  const currency = source.currency?.trim().toUpperCase();
  return currency && /^[A-Z]{3}$/.test(currency) ? currency : null;
}

/**
 * One ad account's Apple Ads slide (#377): spend in the account's currency,
 * installs (the total, tap plus view), cost per install as a compare widget
 * (spend ÷ installs, ADR 0019 section 10: ratios are not stored), the top
 * campaigns by spend, spend by country or region, installs by attribution,
 * and the note that the days are the ad account's (ADR 0020 section 8).
 *
 *   spend (4 × 3)       installs (4 × 3)    cost per install (4 × 3)
 *   top campaigns       spend by country    tap or view (4 × 4 each)
 *   (4 × 5)             the time-zone note (8 × 1)
 *
 * Spend reads the account's own currency (a `currency` filter), so the
 * title can name it and the value is exact, never converted. Every widget
 * is titled: the spend's title names its currency, and the others match
 * it; with several ad accounts each title names its connection.
 */
function appleAdsSlide(
  source: TemplateSource,
  text: ReturnType<typeof templateTexts>,
  several: boolean,
): DashboardSlideInput {
  const { t, over } = text;
  const currency = adsCurrency(source);
  const named = (title: string) =>
    several ? `${title} · ${source.connectionName}` : title;
  const period = "last_30_days" as const;
  const bound = {
    connectionId: source.connectionId,
    period,
  };
  const spend = {
    ...bound,
    metricKey: ADS.spend,
    ...(currency ? { dimensions: { currency } } : {}),
  };
  const installs = { ...bound, metricKey: ADS.installs };
  const spendTitle = over("adSpend", period);
  const zone = source.timeZone?.trim();
  const widgets: DashboardWidgetInput[] = [
    {
      type: "metric",
      x: 0,
      y: 0,
      w: 4,
      h: METRIC_ROWS,
      ...spend,
      title: named(currency ? `${spendTitle} · ${currency}` : spendTitle),
    },
    {
      type: "metric",
      x: 4,
      y: 0,
      w: 4,
      h: METRIC_ROWS,
      ...installs,
      title: named(over("adInstalls", period)),
    },
    {
      type: "compare",
      x: 8,
      y: 0,
      w: 4,
      h: METRIC_ROWS,
      ...spend,
      title: named(over("costPerInstall", period)),
      denominator: {
        connectionId: source.connectionId,
        metricKey: ADS.installs,
      },
      options: {
        format: "ratio",
        ratioLabel: t("perInstall"),
        showChange: true,
      },
    },
    {
      type: "table",
      x: 0,
      y: METRIC_ROWS,
      w: 4,
      h: STUDIO_GRID.rows - METRIC_ROWS,
      ...spend,
      title: named(t("topCampaigns")),
      options: {
        groupBy: "campaign",
        limit: 5,
        showChange: true,
        showOthers: false,
      },
    },
    {
      type: "bar",
      x: 4,
      y: METRIC_ROWS,
      w: 4,
      h: STUDIO_GRID.rows - METRIC_ROWS - 1,
      ...spend,
      title: named(t("spendByCountry")),
      options: { groupBy: "country", limit: 5 },
    },
    {
      type: "bar",
      x: 8,
      y: METRIC_ROWS,
      w: 4,
      h: STUDIO_GRID.rows - METRIC_ROWS - 1,
      ...installs,
      title: named(t("installsByAttribution")),
      options: { groupBy: "attribution", limit: 3 },
    },
  ];
  const note = (words: string): DashboardWidgetInput => ({
    type: "text",
    x: 4,
    y: STUDIO_GRID.rows - 1,
    w: 8,
    h: 1,
    text: words,
    options: { size: "body", align: "start" },
  });
  // The longest wording that fits in every format at the largest font
  // scale: a long zone ("America/Indiana/Indianapolis") drops the "as in
  // Apple Ads", and the zone alone is the last resort.
  const candidates = zone
    ? [
        t("adsDays", { timeZone: zone }),
        t("adsDaysShort", { timeZone: zone }),
        zone,
      ]
    : [t("adsDaysUnknownZone")];
  const chosen =
    candidates.find((candidate) => noteFits(widgets, note(candidate))) ??
    candidates.at(-1)!;
  return {
    name: t("slides.appleAds"),
    widgets: [...widgets, note(chosen)],
  };
}

/**
 * Whether a text widget's text fits beside the slide's other widgets in
 * every format (ADR 0017 section 6) at the largest font scale a theme may
 * set.
 */
function noteFits(
  widgets: readonly DashboardWidgetInput[],
  note: DashboardWidgetInput,
): boolean {
  const all = [...widgets, note].map((widget, index) => ({
    id: `w${index}`,
    type: widget.type,
    x: widget.x,
    y: widget.y,
    w: widget.w,
    h: widget.h,
    ...(widget.type === "text"
      ? { text: widget.text, textSize: widget.options?.size ?? "body" }
      : {}),
  }));
  const noteId = all.at(-1)!.id;
  return !slideFormatWarnings(
    { name: null, widgets: all, layouts: {} },
    {
      primaryFormat: "16x9",
      fontScale: Math.max(...STUDIO_FONT_SCALES),
      showHeader: true,
      dashboardName: "",
      logoAspect: null,
    },
  ).some(
    (warning) => warning.code === "text_cut" && warning.widgetId === noteId,
  );
}

export interface OverviewOptions {
  /** Default: "Overview" in the creator's language. */
  name?: string | undefined;
  /** The creator's language; default English. */
  locale?: Locale;
}

/**
 * Overview: every connection the templates know, the store numbers on one
 * slide, each Apple Ads ad account on one, and the web numbers on another;
 * with Apple Ads beside App Store Connect or Vercel, a first slide sets
 * downloads, ad installs and visitors side by side. Null when none is
 * connected.
 */
export function buildOverviewTemplate(
  sources: readonly TemplateSource[],
  options: OverviewOptions = {},
): TemplateDashboard | null {
  const text = templateTexts(options.locale ?? DEFAULT_LOCALE);
  const { t } = text;
  const slides: DashboardSlideInput[] = [];

  const stores = byConnector(sources, APP_STORE_CONNECT);
  const ads = byConnector(sources, APPLE_ADS);
  const sites = byConnector(sources, VERCEL);
  // The cross-source row (#377): App Store downloads, Apple Ads installs
  // and Vercel visitors side by side, when Apple Ads sits beside one of
  // the others (alone, the Apple Ads slide says it all).
  if (ads.length > 0 && (stores.length > 0 || sites.length > 0)) {
    const row = [
      ...stores.map((source) =>
        spec(
          source,
          "metric",
          ASC.downloads,
          "last_7_days",
          overviewTitle(
            text,
            "downloads",
            "last_7_days",
            source,
            stores.length > 1,
          ),
        ),
      ),
      ...ads.map((source) =>
        spec(
          source,
          "metric",
          ADS.installs,
          "last_7_days",
          overviewTitle(
            text,
            "adInstalls",
            "last_7_days",
            source,
            ads.length > 1,
          ),
        ),
      ),
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
    ];
    const trends = [
      spec(
        ads[0]!,
        "line",
        ADS.installs,
        "last_30_days",
        text.over("adInstalls", "last_30_days"),
      ),
      ...stores
        .slice(0, 1)
        .map((source) =>
          spec(
            source,
            "line",
            ASC.downloads,
            "last_30_days",
            text.over("downloads", "last_30_days"),
          ),
        ),
    ];
    slides.push(...slidesFor(t("slides.glance"), row, trends));
  }

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

  // One slide per ad account: each has its own currency and time zone.
  slides.push(
    ...ads.map((source) => appleAdsSlide(source, text, ads.length > 1)),
  );

  const searches = byConnector(sources, SEARCH_CONSOLE);
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
  return (BRAND_CONNECTORS as readonly string[]).includes(connectorId);
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
