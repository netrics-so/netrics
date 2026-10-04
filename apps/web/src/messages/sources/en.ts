/**
 * The Sources page and the connector catalogue (ADR 0018, design 3c, #306):
 * the connected strip, catalogue cards, category filter and the custom
 * API placeholder.
 */
export const sourcesEn = {
  sources: {
    subtitle:
      "Connect the tools you report on. netrics syncs them on a schedule; you choose what each connection reads.",
    connected: "Connected",
    catalogue: "Catalogue",
    catalogueHint: "Pick a connector to add a source.",
    allConnections: "All connections",
    strip: {
      synced: "Synced {time}",
      firstSync: "Waiting for the first sync",
      setupPending: "Setup unfinished",
      needsReconnect: "Access expired",
      authFailed: "Sign-in rejected",
      keyRejected: "Key rejected",
      tokenRejected: "Token rejected",
      outage: "Provider outage",
      action: "{problem} · {action}",
    },
    actions: {
      finishSetup: "Finish setup",
      reconnect: "Reconnect",
      fixKey: "Fix key",
      fixToken: "Fix token",
      view: "View",
    },
    categories: {
      all: "All",
      seo: "SEO",
      web: "Web",
      apps: "Apps",
      ads: "Ads",
      revenue: "Revenue",
      other: "Other",
    },
    filter: "Filter connectors by category",
    auth: {
      oauth2: "{provider} sign-in",
      "signed-key": "API key",
      token: "Access token",
      none: "No sign-in",
    },
    refresh: {
      minutes: "{count, plural, one {every minute} other {every # min}}",
      hours: "{count, plural, one {hourly} other {every # hours}}",
      days: "{count, plural, one {daily} other {every # days}}",
    },
    moreMetrics: "+{count}",
    cta: {
      connect: "Connect",
      addAnother: "Add another",
      fix: "Fix",
      details: "Details",
      selected: "Selected",
      comingLater: "Coming later",
    },
    connectName: "Connect {name}",
    addAnotherName: "Add another {name} connection",
    fixName: "Fix {name}",
    detailsName: "Why {name} is not available",
    customApi: {
      name: "Custom API",
      tag: "Coming later",
      description:
        "Turn your own JSON API into a source, without writing code. Planned for a later release.",
      plan: "Read the plan",
    },
  },
} as const;
