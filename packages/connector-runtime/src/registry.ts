import { createDemoConnector } from "@netrics/connectors";
import {
  assertManifestCompatible,
  type Connector,
  type ConnectorManifest,
} from "@netrics/connector-sdk";

export interface RegisteredConnector {
  connector: Connector;
  /** The validated manifest (assertManifestCompatible output). */
  manifest: ConnectorManifest;
}

/**
 * The reviewed connector bundle of this deployment. Connectors are registered
 * at process start; manifests are validated against the SDK contract and
 * version range before any tenant connection can run them.
 */
export class ConnectorRegistry {
  private readonly connectors = new Map<string, RegisteredConnector>();

  register(connector: Connector): void {
    const manifest = assertManifestCompatible(connector.manifest);
    if (this.connectors.has(manifest.id)) {
      throw new Error(`Connector "${manifest.id}" is already registered`);
    }
    this.connectors.set(manifest.id, { connector, manifest });
  }

  get(id: string): RegisteredConnector | undefined {
    return this.connectors.get(id);
  }

  list(): RegisteredConnector[] {
    return [...this.connectors.values()];
  }
}

/**
 * The default bundle compiled into the server image — for now just the demo
 * connector. Reviewed community connectors join here per the architecture's
 * distribution workflow.
 */
export function createDefaultRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(createDemoConnector());
  return registry;
}
