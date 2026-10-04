/**
 * The shared catalog (ADR 0016 section 4): words the server and the clients
 * both produce — a tile's scope, a bar chart's remainder, period,
 * comparison and aggregation names, the conversion note. English is the
 * source; the label functions in @netrics/domain look these up and return
 * finished text.
 */
export const sharedEn = {
  scope: {
    /** A tile of several resources added up: "All apps". */
    all: "All {plural}",
  },
  /** The resource noun of connectors that do not name theirs. */
  resources: {
    singular: "resource",
    plural: "resources",
  },
  /** A breakdown's remainder: the smaller groups added up. */
  others: "Others",
  /** A status board's default label (ADR 0019 section 7). */
  sources: "Sources",
  /** A breakdown group without a value. */
  none: "(none)",
  periods: {
    today: "Today",
    last_7_days: "Last 7 days",
    last_30_days: "Last 30 days",
    this_month: "This month",
    last_90_days: "Last 90 days",
    last_12_months: "Last 12 months",
    this_week: "This week",
    this_quarter: "This quarter",
    this_year: "This year",
  },
  /** What a change is measured against. */
  comparisons: {
    today: "vs yesterday",
    last_7_days: "vs previous 7 days",
    last_30_days: "vs previous 30 days",
    this_month: "vs last month",
    last_90_days: "vs previous 90 days",
    last_12_months: "vs previous 12 months",
    this_week: "vs last week to date",
    this_quarter: "vs last quarter to date",
    this_year: "vs last year to date",
  },
  aggregations: {
    sum: "Total",
    avg: "Average",
    min: "Minimum",
    max: "Maximum",
    last: "Latest",
  },
  /** A daily gauge's aggregations: one reading per day. */
  dailyAggregations: {
    last: "Latest day",
    min: "Lowest day",
    max: "Highest day",
  },
  /** A sparkline point of a week: "Week of Sep 28". */
  weekOf: "Week of {date}",
  /** The countdown widget (ADR 0019 section 8). */
  countdown: {
    /** Its label without a title. */
    label: "Countdown",
    /** Shown once the target is reached, without its own text. */
    done: "Now",
    /** The unit letters after each number: "2 d 14 h 05 m". */
    units: { d: "d", h: "h", m: "m" },
  },
  conversion: {
    source: "ECB reference rates",
    notConverted: "{source} · {currencies} not converted",
  },
} as const;

export type SharedMessages = typeof sharedEn;
