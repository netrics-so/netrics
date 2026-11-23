import { rethrowWorkspaceGone } from "@netrics/database";
// Connector resolution per connection (milestone 13, ADR 0027). Bundled
// connectors come from the registry; a custom-api connection's connector is
// built from its pinned definition version and environment, because its
// manifest differs per connection. "custom-api" is never in the registry,
// so a call site that still asks registry.get() for it fails loudly.

import {
  customApiCallOptions,
  type ConnectorRegistry,
  type ExecuteOptions,
  type RegisteredConnector,
} from "@netrics/connector-runtime";
import { assertManifestCompatible } from "@netrics/connector-sdk";
import {
  CUSTOM_API_LIMITS,
  upgradeCustomApiDefinition,
  type CustomApiDefinition,
} from "@netrics/connector-sdk/custom-api";
import {
  CUSTOM_API_CONNECTOR_ID,
  createCustomApiConnector,
  customApiSecretValues,
  type CustomApiCredentials,
  type CustomApiPin,
} from "@netrics/connectors/custom-api";
import type { ConnectionCustomApi } from "@netrics/database";

export interface ResolvedConnector extends RegisteredConnector {
  /** The pin and validated definition of a custom-api connection; null for bundled connectors. */
  customApi: { pin: CustomApiPin; definition: CustomApiDefinition } | null;
}

/** Versions are immutable, so a built connector stays valid; bounded. */
const CACHE_SIZE = 500;
const cache = new Map<string, ResolvedConnector | null>();

function remember(key: string, value: ResolvedConnector | null) {
  cache.set(key, value);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return value;
}

function buildCustomApi(pinned: ConnectionCustomApi): ResolvedConnector | null {
  try {
    const definition = upgradeCustomApiDefinition(pinned.document);
    const pin: CustomApiPin = {
      definitionId: pinned.definitionId,
      versionId: pinned.versionId,
      version: pinned.version,
      environmentId: pinned.environmentId,
      datasetVersions: { ...pinned.datasetVersions },
    };
    const connector = createCustomApiConnector({ definition, pin });
    const manifest = assertManifestCompatible(connector.manifest);
    return { connector, manifest, customApi: { pin, definition } };
  } catch (caught) {
    rethrowWorkspaceGone(caught);
    // A pin to an unknown environment, a missing dataset version or a
    // document this server cannot read: the connection has no connector.
    return null;
  }
}

/**
 * Bundled: registry.get(connectorId). custom-api: built from the pin
 * (upgradeCustomApiDefinition + createCustomApiConnector +
 * assertManifestCompatible), cached by `${versionId}:${environmentId}`.
 * Invalid → undefined.
 */
export function connectorFor(
  registry: ConnectorRegistry,
  connection: {
    row: { connectorId: string };
    customApi: ConnectionCustomApi | null;
  },
): ResolvedConnector | undefined {
  if (connection.row.connectorId !== CUSTOM_API_CONNECTOR_ID) {
    const registered = registry.get(connection.row.connectorId);
    return registered ? { ...registered, customApi: null } : undefined;
  }
  const pinned = connection.customApi;
  if (!pinned) return undefined;
  const key = `${pinned.versionId}:${pinned.environmentId}`;
  if (cache.has(key)) {
    const hit = cache.get(key)!;
    cache.delete(key);
    cache.set(key, hit);
    return hit ?? undefined;
  }
  return remember(key, buildCustomApi(pinned)) ?? undefined;
}

type Egress = NonNullable<ExecuteOptions["egress"]>;

/**
 * The custom-api egress values, in one place: same-host redirects (an
 * allowlist hop would keep custom headers such as x-api-key on another
 * origin), the custom API response, decompression and time bounds, and the
 * self-host private hosts. `base` carries test-only options (lookup,
 * allowInsecureHttp, tlsCa, allowPrivateHosts).
 */
export function customApiEgress(
  privateHosts: readonly string[],
  base?: ExecuteOptions["egress"],
): Egress {
  return {
    ...base,
    redirects: "same-host",
    maxResponseBytes: CUSTOM_API_LIMITS.responseBytes,
    maxDecompressedBytes: CUSTOM_API_LIMITS.decompressedBytes,
    requestTimeoutMs: CUSTOM_API_LIMITS.requestTimeoutMs,
    allowPrivateHosts: [...(base?.allowPrivateHosts ?? []), ...privateHosts],
  };
}

/**
 * For custom-api: egress = customApiEgress(privateHosts, base.egress),
 * timeoutMs 60_000, redactValues += customApiSecretValues(...). Bundled:
 * base, never with private hosts.
 */
export function callOptionsFor(
  resolved: ResolvedConnector,
  base: ExecuteOptions,
  input: {
    credentials: Record<string, unknown>;
    privateHosts: readonly string[];
    config?: Record<string, unknown>;
  },
): ExecuteOptions {
  if (!resolved.customApi) {
    if (!base.egress?.allowPrivateHosts) return base;
    const { allowPrivateHosts: _private, ...egress } = base.egress;
    return { ...base, egress };
  }
  return customApiCallOptions({
    ...base,
    egress: customApiEgress(input.privateHosts, base.egress),
    timeoutMs: 60_000,
    redactValues: [
      ...(base.redactValues ?? []),
      ...customApiSecretValues(
        resolved.customApi.definition,
        input.credentials as CustomApiCredentials,
        input.config ?? {},
        // Rendered bodies are redacted like rendered headers (ADR 0030 §4).
        resolved.customApi.definition.streams,
      ),
    ],
  });
}
