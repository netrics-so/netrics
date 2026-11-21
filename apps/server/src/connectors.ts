import {
  ConnectorRegistry,
  broadPrivateHostEntries,
} from "@netrics/connector-runtime";
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
  /**
   * Which connectors count as previews. Default: PREVIEW_CONNECTORS; tests
   * pass their own, since the bundle has no preview at the moment.
   */
  previews?: ReadonlySet<string>;
}

/**
 * The connector bundle compiled into this server image: the demo connector,
 * Vercel Web Analytics, Google Search Console, App Store Connect, Google
 * Play and Apple Ads. A preview connector (PREVIEW_CONNECTORS, currently
 * none) is registered outside production, and in production only when
 * listed in NETRICS_PREVIEW_CONNECTORS. Reviewed connectors join here
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
  const previews = options.previews ?? PREVIEW_CONNECTORS;
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
    if (allPreviews || !previews.has(id) || enabledPreviews.has(id)) {
      registry.register(connector);
    }
  }
  return registry;
}

/** The two log levels logRegisteredConnectors uses (pino, Fastify). */
export interface ConnectorLog {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
}

/**
 * Logs, once at startup, which connectors this process registered, and
 * warns about NETRICS_PREVIEW_CONNECTORS entries that are no longer
 * previews (ignored). Every service logs it, so a service whose variable
 * differs from the others shows in the logs. IDs only, no secrets.
 */
export function logRegisteredConnectors(
  log: ConnectorLog,
  registry: ConnectorRegistry,
  options: {
    previewConnectorsIgnored?: readonly string[];
    /** Default: PREVIEW_CONNECTORS. */
    previews?: ReadonlySet<string>;
    /** NETRICS_CUSTOM_API_PRIVATE_HOSTS; broad entries get a warning. */
    customApiPrivateHosts?: readonly string[];
  } = {},
): void {
  const ignored = options.previewConnectorsIgnored ?? [];
  const previews = options.previews ?? PREVIEW_CONNECTORS;
  if (ignored.length > 0) {
    log.warn(
      { ignored },
      "NETRICS_PREVIEW_CONNECTORS names connectors that are not previews (any more); they are registered anyway, remove them from the variable",
    );
  }
  const broad = broadPrivateHostEntries(options.customApiPrivateHosts ?? []);
  if (broad.length > 0) {
    log.warn(
      { entries: broad },
      "NETRICS_CUSTOM_API_PRIVATE_HOSTS has broad entries; a listed name may resolve to any private address, loopback included (metadata stays refused). List exact hosts or ranges instead",
    );
  }
  log.info(
    {
      connectors: registry.list().map(({ manifest }) => manifest.id),
      previews: registry
        .list()
        .map(({ manifest }) => manifest.id)
        .filter((id) => previews.has(id)),
    },
    "connectors registered",
  );
}
