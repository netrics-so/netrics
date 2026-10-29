import { ConnectorRegistry } from "@netrics/connector-runtime";
import {
  createAppStoreConnectConnector,
  createAppleAdsConnector,
  createDemoConnector,
  createSearchConsoleConnector,
  createVercelConnector,
} from "@netrics/connectors";

/**
 * Connectors in the bundle that are not finished for users yet (roadmap
 * rule 6: unfinished UI stays unavailable outside development). They are
 * registered in development and tests only, so a production installation
 * neither lists nor connects nor syncs them, and its catalog has no rows
 * for them.
 *
 * Apple Ads (milestone 10): the sync produces data since #374, but the
 * generic connect form cannot set it up. Its preview lists ad accounts as
 * if they were resources to select, and nothing stores the chosen
 * account's ID, currency and time zone. The guided setup is #375; Apple's
 * real answers are confirmed by #370.
 */
export const PREVIEW_CONNECTORS: ReadonlySet<string> = new Set(["apple-ads"]);

export interface DefaultRegistryOptions {
  /**
   * The server's NODE_ENV. Preview connectors are left out in
   * "production". Default: "development".
   */
  nodeEnv?: "development" | "test" | "production";
}

/**
 * The connector bundle compiled into this server image: the demo connector,
 * Vercel Web Analytics, Google Search Console, App Store Connect and Apple
 * Ads (outside production only, PREVIEW_CONNECTORS). Reviewed connectors
 * join here per the architecture's distribution workflow. The runtime only
 * knows the registry; which connectors ship is decided by the application
 * (#39). OAuth connectors are listed as unavailable until their provider is
 * configured (ADR 0012); signed-key connectors need the host's provider
 * (ADR 0014).
 */
export function createDefaultRegistry(
  options: DefaultRegistryOptions = {},
): ConnectorRegistry {
  const preview = (options.nodeEnv ?? "development") !== "production";
  const registry = new ConnectorRegistry();
  const connectors = [
    createDemoConnector(),
    createVercelConnector(),
    createSearchConsoleConnector(),
    createAppStoreConnectConnector(),
    createAppleAdsConnector(),
  ];
  for (const connector of connectors) {
    if (preview || !PREVIEW_CONNECTORS.has(connector.manifest.id)) {
      registry.register(connector);
    }
  }
  return registry;
}
