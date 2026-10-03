import { ConnectorRegistry } from "@netrics/connector-runtime";
import {
  createAppStoreConnectConnector,
  createDemoConnector,
  createSearchConsoleConnector,
  createVercelConnector,
} from "@netrics/connectors";

/**
 * The connector bundle compiled into this server image: the demo connector,
 * Vercel Web Analytics, Google Search Console and App Store Connect. Reviewed connectors join
 * here per the architecture's distribution workflow. The runtime only knows
 * the registry; which connectors ship is decided by the application (#39).
 * OAuth connectors are listed as unavailable until their provider is
 * configured (ADR 0012); signed-key connectors need the host's provider
 * (ADR 0014).
 */
export function createDefaultRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(createDemoConnector());
  registry.register(createVercelConnector());
  registry.register(createSearchConsoleConnector());
  registry.register(createAppStoreConnectConnector());
  return registry;
}
