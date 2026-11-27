/** How long one journey may take (playwright.config.ts `timeout`). */
export const JOURNEY_TIMEOUT_MS = 180_000;

/**
 * How long the web server the journeys start keeps an idle connection open
 * (#897). Playwright's `page.request` keeps connections alive but ignores the
 * server's `Keep-Alive: timeout=5` hint, so it reuses a connection after any
 * pause. Node closes an idle connection after keepAliveTimeout plus one
 * second: a journey whose browser steps happen to last about 6 s between two
 * `page.request` calls sends the second one on a connection the server is
 * closing at that moment, and fails with ECONNRESET ("socket hang up").
 * Browsers and the web app's own fetch to the API honour the hint; only the
 * test client does not. Longer than a whole journey, no idle connection is
 * closed while one runs; each test's request context closes its own at the
 * end.
 */
export const WEB_KEEP_ALIVE_MS = 2 * JOURNEY_TIMEOUT_MS;
