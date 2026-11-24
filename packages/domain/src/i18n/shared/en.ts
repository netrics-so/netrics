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
     * The Railway connector's failed checks (#870), equal to
     * TOKEN_REJECTED_MESSAGE and WORKSPACE_DENIED_MESSAGE in
     * @netrics/connectors/railway.
     */
    railway: {
      /** `me` (no workspace ID) answered "Not Authorized". */
      tokenRejected:
        "Railway did not accept the token: it is wrong, was deleted, or is a project token. Create an account or workspace token in Railway (Account Settings → Tokens). For a workspace token, also enter its workspace ID.",
      /** The configured workspace answered "Not Authorized" or "not found". */
      workspaceDenied:
        "Railway did not accept the token for this connection's workspace ID: the ID is wrong, the token belongs to another workspace, or it was deleted. Check the workspace ID, or create a new token for that workspace.",
    },
    /**
     * The PostHog connector's failed checks (#873), equal to the
     * *_MESSAGE constants in @netrics/connectors/posthog.
     */
    posthog: {
      /** PostHog answered 401. */
      keyRejected:
        "PostHog did not accept the personal API key: it is wrong, was deleted, or belongs to another region or instance. Create a personal API key in PostHog (Settings → Personal API keys) on the host this connection names.",
      /** PostHog answered 403 naming a missing scope. */
      scopeMissing:
        "The personal API key lacks a scope netrics needs. Give it the read scopes Organization, Project, Query and Insight in PostHog (Settings → Personal API keys), or create a new key with them.",
      /** A host that is no valid host name. */
      hostInvalid:
        "Enter your PostHog's host: us.posthog.com, eu.posthog.com, or your own instance's host name such as posthog.example.com: a public name reached over https, without a path or port.",
      /** Saved insights that are not insight links. */
      insightsInvalid:
        "netrics could not read the saved insights. Paste each insight's link from PostHog (…/project/12345/insights/AbCd1234), separated by spaces or commas, at most 20.",
      /** A key limited to projects, without their IDs (#884 review). */
      projectsRequired:
        "The personal API key is limited to some projects, so PostHog does not list them. Enter their project IDs under Project IDs (PostHog: Project settings → Project ID).",
      /** Project IDs that are no IDs, or that the key cannot read. */
      projectsInvalid:
        "netrics could not read every project ID with this key. Enter the numeric IDs of projects the key may read (PostHog: Project settings → Project ID), separated by spaces or commas, at most 50.",
    },
    /**
     * The Hetzner Cloud connector's failed checks (#872), equal to the
     * TOKEN_*_MESSAGE constants in @netrics/connectors/hetzner-cloud.
     */
    hetznerCloud: {
      /** Hetzner answered 401. */
      tokenRejected:
        "Hetzner Cloud did not accept the API token: it is wrong or was deleted. Create a token in the Hetzner Console (your project → Security → API tokens) with Read permission and enter it again.",
      /** Hetzner answered 403 `forbidden` on a listing. */
      tokenForbidden:
        "Hetzner Cloud accepted the API token but refused to let it read the project's servers or prices. Create a new token in the Hetzner Console (your project → Security → API tokens) with Read permission.",
    },
    /**
     * The HTTP check connector's refused configurations (#874), equal to
     * the *_MESSAGE constants in @netrics/connectors/http-check.
     */
    httpCheck: {
      noChecks: "Add at least one check, and at most 20.",
      urlInvalid:
        "Every check needs an https URL whose host is a full domain name or an IP address, without a user name or password, of at most 2,048 characters.",
      nameDuplicate:
        "Every check needs a name, and a name of its own: two checks in a connection cannot share one.",
      statusInvalid:
        "Expected status: a code (200), a range (200-299), a class (2xx), or up to ten of them separated by commas, all between 100 and 599.",
      textInvalid:
        "Expected text works only with GET: a HEAD request has no body to look in.",
      headersInvalid:
        "Request headers: one “Name: value” per line, at most ten. Headers that carry secrets (Authorization, Cookie, or a name with key, token, secret, auth, session, password or signature) and Host, Content-Length, Connection and Transfer-Encoding are not allowed: the configuration is not encrypted.",
    },
    /**
     * The runtime's refusal of credentials whose bound host differs from
     * the configuration (SDK 0.2.20 configuredHosts, #884 review), equal
     * to CREDENTIAL_HOST_MISMATCH_MESSAGE in @netrics/connector-runtime.
     */
    connection: {
      credentialsHostChanged:
        "The stored credentials were entered for another host. Enter them again for this host, in a new connection.",
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
      graphqlErrors:
        "The GraphQL API answered with errors. Check the query and its variables in the definition.",
    },
  },
} as const;

export type SharedMessages = typeof sharedEn;
