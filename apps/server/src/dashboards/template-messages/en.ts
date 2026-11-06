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
    /** One Apple Ads ad account's numbers (#377). */
    appleAds: "Apple Ads",
    /** Downloads, ad installs and visitors side by side (#377). */
    glance: "At a glance",
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
    adSpend: "Ad spend",
    adInstalls: "Ad installs",
    costPerInstall: "Cost per install",
  },
  /** "Downloads, 30 days". */
  withPeriod: "{metric}, {days} days",
  /** A bar of downloads per app. */
  downloadsByApp: "Downloads by app",
  /** A bar of one app's downloads per territory. */
  topTerritories: "Top territories",
  /** A bar of one site's visitors per country. */
  topCountries: "Top countries",
  /** Beside a compare widget's ratio: spend ÷ installs (ADR 0019 §10). */
  perInstall: "per install",
  /** A table of an ad account's campaigns, largest spend first. */
  topCampaigns: "Top campaigns",
  /** A bar of an ad account's spend per country or region. */
  spendByCountry: "Spend by country",
  /** A bar of ad installs after a tap and after a view. */
  installsByAttribution: "Installs: tap or view",
  /** The note on an Apple Ads slide (ADR 0020 section 8). */
  adsDays: "Days in {timeZone}, as in Apple Ads.",
  /** The same, shorter, for a long zone name. */
  adsDaysShort: "Days in {timeZone}.",
  /** The same, for an ad account whose zone is not known. */
  adsDaysUnknownZone: "Days in the ad account's time zone.",
} as const;

export type TemplateMessages = typeof templateEn;
