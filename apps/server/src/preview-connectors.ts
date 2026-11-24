/**
 * Connectors in the bundle that are not finished for users yet (roadmap
 * rule 6: unfinished UI stays unavailable outside development). They are
 * registered in development and tests. In production they are left out
 * unless the operator names them in NETRICS_PREVIEW_CONNECTORS, so a
 * production installation by default neither lists nor connects nor syncs
 * them, and its catalog has no rows for them. An opted-in preview connector
 * is marked as a preview in the catalog (`preview: true`).
 *
 * Currently Railway (#870), PostHog (#873), Hetzner Cloud (#872) and HTTP
 * checks (#874), all milestone 13.1, until
 * the milestone's exit gate (#877) passes. Apple Ads (milestone 10) left
 * this set when its exit gate (#378) passed on the hosted service and on a
 * self-hosted install, and is available everywhere since. A variable that still names a finished
 * connector (such as apple-ads) is ignored with a warning, so the instance
 * starts as before.
 *
 * Kept apart from connectors.ts so the server config can validate the
 * opt-in without loading the connector bundle.
 */
export const PREVIEW_CONNECTORS: ReadonlySet<string> = new Set<string>([
  "railway",
  "posthog",
  "hetzner-cloud",
  "http-check",
]);

/**
 * The IDs of every connector in the bundle (createDefaultRegistry), finished
 * or preview, so the config can tell a typo in NETRICS_PREVIEW_CONNECTORS
 * (refused) from a connector that has graduated from preview since the
 * variable was set (ignored with a warning, so upgrading never stops an
 * instance). connectors.test.ts keeps it equal to the registry.
 */
export const BUNDLE_CONNECTORS: ReadonlySet<string> = new Set([
  "demo",
  "vercel",
  "google-search-console",
  "app-store-connect",
  "google-play",
  "apple-ads",
  "railway",
  "posthog",
  "hetzner-cloud",
  "http-check",
]);
