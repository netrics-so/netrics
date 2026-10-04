/**
 * Dashboard templates in English (#226, #268): the source catalog for the
 * names and titles a template creates. Created in the creator's language
 * and then the workspace's data, not translated afterwards (ADR 0016
 * section 5). German is typed against it.
 *
 * Titles are set only where they say more than a widget's automatic label
 * (metric · scope, see tileLabel): charts, which have no period line, and
 * Brand metrics, whose automatic label would repeat the brand's name.
 */
export const templateEn = {
  /** The Overview's name when the creator gives none. */
  overviewName: "Overview",
  slides: {
    appStore: "App Store",
    web: "Web",
    /** Brand: the band of current numbers above the charts. */
    today: "Today",
    /** Brand: the 90-day trends. */
    trend: "Trend",
  },
  /** Short metric words for titles; the connectors' names may be longer. */
  metrics: {
    downloads: "Downloads",
    proceeds: "Proceeds",
    reviews: "Reviews",
    searchClicks: "Search clicks",
    impressions: "Impressions",
    visitors: "Visitors",
    pageViews: "Page views",
    signups: "Signups",
  },
  /** "Downloads, 30 days". */
  withPeriod: "{metric}, {days} days",
  /** A bar of downloads per app. */
  downloadsByApp: "Downloads by app",
  /** A bar of one app's downloads per territory. */
  topTerritories: "Top territories",
  /** A bar of one site's visitors per country. */
  topCountries: "Top countries",
} as const;

export type TemplateMessages = typeof templateEn;
