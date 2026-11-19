/**
 * Connectors in the bundle that are not finished for users yet (roadmap
 * rule 6: unfinished UI stays unavailable outside development). They are
 * registered in development and tests. In production they are left out
 * unless the operator names them in NETRICS_PREVIEW_CONNECTORS, so a
 * production installation by default neither lists nor connects nor syncs
 * them, and its catalog has no rows for them. An opted-in preview connector
 * is marked as a preview in the catalog (`preview: true`).
 *
 * Apple Ads (milestone 10): the sync produces data since #374, and the
 * guided setup of #375 generates the key, lists the ad accounts and stores
 * the chosen accounts' ID, name, currency and time zone in each
 * connection's config. It stays a preview until the exit gate (#378)
 * passes; the gate itself runs on the hosted service and on a self-hosted
 * install with NETRICS_PREVIEW_CONNECTORS=apple-ads. Once it passes,
 * "apple-ads" leaves this set and is available everywhere; a variable that
 * still names it is then ignored with a warning.
 *
 * Kept apart from connectors.ts so the server config can validate the
 * opt-in without loading the connector bundle.
 */
export const PREVIEW_CONNECTORS: ReadonlySet<string> = new Set(["apple-ads"]);

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
]);
