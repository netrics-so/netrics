import { ConnectorRegistry } from "@netrics/connector-runtime";
import {
  createAppStoreConnectConnector,
  createAppleAdsConnector,
  createDemoConnector,
  createGooglePlayConnector,
  createSearchConsoleConnector,
  createVercelConnector,
} from "@netrics/connectors";

import { PREVIEW_CONNECTORS } from "./preview-connectors.js";

export { PREVIEW_CONNECTORS };

export interface DefaultRegistryOptions {
  /**
   * The server's NODE_ENV. Preview connectors are left out in
   * "production" unless listed in `previewConnectors`. Default:
   * "development".
   */
  nodeEnv?: "development" | "test" | "production";
  /**
   * Preview connectors the operator turned on for production
   * (NETRICS_PREVIEW_CONNECTORS, validated by the server config). Ignored
   * outside production, where every preview connector is registered.
   * Default: none.
   */
  previewConnectors?: ReadonlySet<string>;
}

/**
 * The connector bundle compiled into this server image: the demo connector,
 * Vercel Web Analytics, Google Search Console, App Store Connect and Apple
 * Ads (a preview, PREVIEW_CONNECTORS: outside production, or in production
 * when listed in NETRICS_PREVIEW_CONNECTORS). Reviewed connectors join here
 * per the architecture's distribution workflow. The runtime only knows the
 * registry; which connectors ship is decided by the application (#39).
 * OAuth connectors are listed as unavailable until their provider is
 * configured (ADR 0012); signed-key connectors need the host's provider
 * (ADR 0014).
 *
 * API, worker, migrate (catalog sync) and the operator CLI all pass the
 * same config, so they agree on the bundle.
 */
export function createDefaultRegistry(
  options: DefaultRegistryOptions = {},
): ConnectorRegistry {
  const allPreviews = (options.nodeEnv ?? "development") !== "production";
  const enabledPreviews = options.previewConnectors ?? new Set<string>();
  const registry = new ConnectorRegistry();
  const connectors = [
    createDemoConnector(),
    createVercelConnector(),
    createSearchConsoleConnector(),
    createAppStoreConnectConnector(),
    createGooglePlayConnector(),
    createAppleAdsConnector(),
  ];
  for (const connector of connectors) {
    const id = connector.manifest.id;
    if (allPreviews || !PREVIEW_CONNECTORS.has(id) || enabledPreviews.has(id)) {
      registry.register(connector);
    }
  }
  return registry;
}
