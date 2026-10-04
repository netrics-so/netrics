/**
 * Words the shared formatting helpers produce (lib/relative-time,
 * lib/sync-schedule, lib/format-metric, lib/tile-currency):
 * used on the workspace pages, dashboards, the Studio and the kiosk.
 */
export const formatsEn = {
  formats: {
    time: {
      justNow: "just now",
      never: "never",
    },
    interval: {
      day: "{count, plural, one {every day} other {every # days}}",
      hour: "{count, plural, one {every hour} other {every # hours}}",
      minute: "{count, plural, one {every minute} other {every # minutes}}",
      second: "{count, plural, one {every second} other {every # seconds}}",
    },
    nextSync: {
      pausedReconnect: "Paused until reconnected",
      pausedCredentials: "Paused until the credentials work",
    },
    metric: {
      perBreakdown: "{name} (per {dimensions})",
      notConverted: "{amount} not converted",
    },
  },
} as const;
