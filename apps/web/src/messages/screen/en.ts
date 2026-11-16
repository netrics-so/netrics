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
      pairingLabel: "Add this screen",
      pairingCode: "Pairing code",
      pairingGoTo: "Go to {url} and enter the code.",
      pairingScan: "or scan",
      pairingQr: "QR code to approve this screen at {url}",
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
      offlineSince: "Offline — last update {time}",
      offlineShort: "Offline · {time}",
      mayBeOutdated: "The numbers may be out of date",
      lineSummary: "{label}: {value}.",
      lineSummaryPrevious: "{label}: {value}, dashed line {comparison}.",
      trend: "Trend from {min} to {max}, latest {latest}.",
      trendAt: "Trend from {min} to {max}, latest {latest} ({date}).",
      updated: "updated {time}",
      updatedFrom: "updated {time} · {source}",
      /** Data states (ADR 0018 section 5, #311). */
      reconnect: "Reconnect {source}",
      reconnectSource: "Reconnect the source",
      reconnectHint:
        "Access was rejected. An admin can fix this under Connections.",
      loadingHistory: "Loading history…",
      /** Table widgets (ADR 0019 section 6). */
      tableTop: "Top {count}",
      tableNew: "new",
      reviewsPaused: "App Store reviews paused — upload a new reviews key",
      reviewsPausedHint: "Upload it in the connection's settings.",
      noReviews: "No reviews yet",
      reviewStars: "{rating} of 5 stars",
      tableNoChange: "–",
      tableChangeHead: "Δ",
      /** Goal widgets (ADR 0019 section 5). */
      gaugeTarget: "Goal {target}",
      gaugeToGo: "{amount} to go",
      gaugeDaysLeft: "{count, plural, one {# day left} other {# days left}}",
      gaugeLastDay: "last day",
      gaugeHoursLeft: "{count} h left",
      gaugeUnderHour: "< 1 h left",
      gaugeReached: "✓ Reached",
      gaugeEarly: "{count, plural, one {# day early} other {# days early}}",
      gaugeSummary: "{label}: {progress}. {target}.",
      goalDeleted: "Goal deleted",
      goalDeletedHint: "Pick another goal in the Studio.",
      /** Status boards (ADR 0019 section 7). */
      statusEmpty: "No sources connected",
      statusMore: "+{count} more",
      statusConnected: "{count} connected",
      statusDelayed: "{count} delayed",
      statusFailing: "{count} failing",
      /** A sync's age: "14 m", "3 h", "2 d". */
      statusAge:
        "{unit, select, m {{count} m} h {{count} h} other {{count} d}}",
      statusNever: "never",
      statusItem:
        "{name}: {status, select, ok {up to date} stale {delayed} backfilling {loading history} auth_failed {needs attention} outage {unreachable} other {unknown}}",
      /** Compare widgets (ADR 0019 section 10). */
      compareRatio: "ratio",
      comparePoints: "{value} pt",
      compareDerived: "derived",
      compareNoRatio: "–",
    },
    /** What a playing screen shows around its slides (ADR 0018, section 5). */
    player: {
      nextRefresh: "next refresh in {seconds} s",
      position: "{number} / {count}",
      next: "next: {name}",
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
    /**
     * How far a widget's numbers reach (ADR 0025 section 8): the
     * provider's last complete day, when netrics last read it and when the
     * next one is due, in the viewer's time zone. Parts join with " · ".
     */
    freshness: {
      upTo: "Up to {date}",
      streamUpTo: "{stream} up to {date}",
      fetched: "fetched {time}",
      fetchedOn: "fetched {date}",
      next: "next {when}",
      nextSoon: "next any minute",
      notPublished: "{period} not published yet",
      checkingAgain: "checking again {when}",
      checkingSoon: "checking again any minute",
      checked: "Checked {time}",
      checkedOn: "Checked {date}",
      streamChecked: "{stream} checked {time}",
      streamCheckedOn: "{stream} checked {date}",
      nextCheck: "next check {when}",
      nextCheckSoon: "next check any minute",
      notChecked: "{stream} not checked yet",
      /** An expected time: "~9:00 PM", "tomorrow ~9:00 AM", "~Nov 18". */
      at: "~{time}",
      dayAt: "{day} ~{time}",
      onDate: "~{date}",
    },
  },
} as const;
