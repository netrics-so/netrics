import { ConnectorRegistry } from "@netrics/connector-runtime";
import { createDemoConnector } from "@netrics/connectors";

/**
 * The connector bundle compiled into this server image — for now just the
 * demo connector. Reviewed connectors join here per the architecture's
 * distribution workflow. The runtime only knows the registry; which
 * connectors ship is decided by the application (#39).
 */
export function createDefaultRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(createDemoConnector());
  return registry;
}
