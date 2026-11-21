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
  /** A latest-review widget without a title (ADR 0019 section 12). */
  latestReview: "Latest review",
  /** A latest-items widget without a title (#810). */
  latestItems: "Latest items",
  /**
   * What a screen that does not know the latest-items widget shows in its
   * place (#810): an older netrics TV or kiosk.
   */
  itemsNeedNewerApp: "Update netrics TV to show the latest items.",
  /** A breakdown's remainder: the smaller groups added up. */
  others: "Others",
  /** A status board's default label (ADR 0019 section 7). */
  sources: "Sources",
  /** A goal widget without a title whose goal was deleted (ADR 0019 §5). */
  goal: "Goal",
  /** A breakdown group without a value. */
  none: "(none)",
  /**
   * The values of an `attribution` dimension (Apple Ads installs, ADR 0020
   * section 6): after a tap on the ad, or after it was seen.
   */
  attribution: {
    tap: "Tap-through",
    view: "View-through",
  },
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
  /**
   * Names a compare saved as a measure gets (#506, #515): stored with the
   * generated preparation and model, in the author's language.
   */
  compareMeasure: {
    /** The preparation field that tags each row with its side. */
    side: "Compare side",
    /** The model's date dimension. */
    date: "Date",
    /** A daily gauge side's count of days with data. */
    days: "{name} · days",
    previous: "{name} · previous period",
    /** The ratio's percent change against the previous period. */
    change: "{name} · change",
    /** The ratio's change in percentage points. */
    changePoints: "{name} · change (pt)",
  },
  /**
   * A provider's refusal of a connection's key (#378). The server records
   * a reason code next to the English message of a failed sync or key
   * check (#795), and clients show the code's text in the viewer's
   * language (`providerMessageForCode`, PROVIDER_MESSAGE_CODES). Rows
   * recorded before codes are found by their exact English text
   * (`localizedProviderMessage`).
   */
  providerMessages: {
    appleAds: {
      /** The token exchange answered `invalid_client`. */
      invalidClient:
        "Apple Ads refused the key: the client ID, team ID and key ID do not match the public key you saved in Apple Ads, or the key was removed. Check the three values under Account Settings → API, or set up a new key.",
      /** A call answered 401 with an exchanged token. */
      unauthorized:
        "Apple Ads refused the access token: the key was removed, or the API user lost access. Set up a new Apple Ads key.",
      /** A call answered 403. */
      forbidden:
        "Apple Ads refused access: the API user needs an API role, such as API Account Read Only (API Read Only in Apple's answers), in this ad account. A non-API role removes API access. Ask an Account Admin to change the role, or set up a new key.",
    },
    appStoreConnect: {
      /** A call answered 401 with a freshly signed token. */
      unauthorized:
        "App Store Connect refused the key: it was revoked, or the issuer ID, key ID and private key do not belong together. Upload a new App Store Connect key.",
      /** A call answered 403. */
      forbidden:
        "App Store Connect refused access: the key's role was changed or access was removed. This key needs the Sales or Finance role. Upload a new App Store Connect key.",
      /** The key check answered 401 before the key was stored. */
      keyMismatch:
        "App Store Connect refused the key: the issuer ID, key ID and private key do not belong together, or the key was revoked. Check the three values, or create a new team key and upload it.",
      /** The key check answered 403: the key's role reads no sales. */
      roleMissing:
        "This key cannot read sales reports. It needs the Sales or Finance role; Admin also works, but grants more than netrics needs. Create a team key with the Sales role and upload it.",
      /** The key check answered 403 for a missing agreement. */
      agreementsMissing:
        "App Store Connect requires an agreement that is missing or has expired. The Account Holder must accept the latest agreements in App Store Connect (Business), then try again.",
    },
    /**
     * The custom-api connector's fixed messages (milestone 13), equal to
     * CUSTOM_API_MESSAGES in @netrics/connectors/custom-api.
     */
    customApi: {
      unauthorized:
        "The API refused the credentials (HTTP 401). Enter a new key, token or password for this connection, or reconnect it.",
      forbidden:
        "The API denied access (HTTP 403). Check that these credentials may read the endpoints of this custom API.",
      hostChanged:
        "This connection's credentials were entered for another API host. Enter them again for the connection's environment.",
      notJson:
        "The API did not answer with JSON. Check the base URL and the request path.",
      recordsNotList:
        "The record path does not point to a list or an object in the response. Choose the records again in the definition.",
      nextUrlOffHost:
        "The API's next page link points to another host. netrics only follows next page links on the API host.",
      pageLimit:
        "The run stopped after 200 pages, the most one run reads. The data so far is kept; the next run continues.",
      recordLimit:
        "The run stopped after 100,000 records, the most one run reads. The data so far is kept; the next run continues.",
      durationLimit:
        "The run stopped after 30 minutes, the longest one run takes. The data so far is kept; the next run continues.",
      tokenRefused:
        "The token endpoint refused the client ID or client secret. Check both values and enter them again.",
      scopeRefused:
        "The token endpoint did not grant every scope this API needs. Check the client's permissions at the provider, then enter the client ID and secret again.",
    },
  },
} as const;

export type SharedMessages = typeof sharedEn;
