/**
 * The browser kiosk, the signed-in TV mode and what widgets and tiles draw
 * on both (#256).
 */
export const screenEn = {
  /**
   * Screens (ADR 0016 sections 3 and 6): the browser kiosk in the
   * workspace's screen language, the signed-in TV mode in the member's, and
   * the widgets and tiles both draw.
   */
  screen: {
    kiosk: {
      title: "netrics kiosk",
      connecting: "Connecting to netrics…",
      loading: "Loading…",
      noDashboardTitle: "No dashboard assigned yet",
      noDashboardText:
        "Choose one under TVs in netrics; this screen picks it up on its own.",
      pairingPrompt: "Show a netrics dashboard on this screen",
      pairingCode: "Pairing code",
      pairingGoTo: "Go to {url} and enter the code.",
      unreachable: "Cannot reach netrics — retrying",
      offline: "Offline",
      offlineSince: "Offline — last update {time}",
      noSlides: "This dashboard has no slides to show.",
      noTiles: "This dashboard has no tiles yet.",
      tileFailed: "This tile could not load.",
    },
    tv: {
      allHidden:
        "Every slide is hidden. Show at least one slide to play this dashboard.",
      exit: "Exit TV mode",
    },
    widget: {
      approximate: "Approximate",
      noDataYet: "No data for this period yet",
      noDataShort: "No data yet",
      noComparison: "No data to compare {comparison}",
      noComparisonShort: "No comparison",
      notEnoughData: "Not enough data for a chart yet",
      refreshFailed: "Refresh failed",
      couldNotLoad: "Could not load",
      failed: "This widget could not be shown",
      imageMissing: "Image not available",
      offline: "Offline",
      mayBeOutdated: "The numbers may be out of date",
      lineSummary: "{label}: {value}.",
      lineSummaryPrevious: "{label}: {value}, dashed line {comparison}.",
      trend: "Trend from {min} to {max}, latest {latest}.",
      trendAt: "Trend from {min} to {max}, latest {latest} ({date}).",
    },
    /** Why a tile's numbers may be out of date (#52, #59). */
    notices: {
      removed: "Connection removed",
      authFailed: "Connection needs new credentials",
      needsReconnect: "Connection needs to be reconnected",
      outage: "Source unreachable",
      firstSync: "Waiting for the first sync",
      lastSync: "Last sync {time}",
      never: "never",
    },
  },
} as const;
