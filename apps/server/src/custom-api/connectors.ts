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
import { HTTP_CHECK_CONNECTOR_ID } from "@netrics/connectors";
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
 * The egress bounds of the HTTP check connector (#874): a check reads at
 * most 1 MiB of a body (decoded too) and waits at most 10 s per request
 * (a check's own limit, 1 to 10 s, only lowers it); 20 checks, ten at a
 * time, stay inside the 60 s call.
 */
export const HTTP_CHECK_LIMITS = {
  responseBytes: 1024 * 1024,
  requestTimeoutMs: 10_000,
  callTimeoutMs: 60_000,
} as const;

/**
 * The HTTP check egress values, in one place (ADR 0027 §3 applied to
 * user-entered URLs, #874): same-host redirects (the runtime forces them
 * for item URLs as well), the HTTP check bounds, and the self-host private
 * hosts of the custom API (`NETRICS_CUSTOM_API_PRIVATE_HOSTS`): a check
 * reaches the same private hosts a custom API may, and on the hosted
 * service, where the list is empty, public addresses only. `base` carries
 * test-only options (lookup, tlsCa, allowPrivateHosts).
 */
export function httpCheckEgress(
  privateHosts: readonly string[],
  base?: ExecuteOptions["egress"],
): Egress {
  return {
    ...base,
    redirects: "same-host",
    maxResponseBytes: HTTP_CHECK_LIMITS.responseBytes,
    maxDecompressedBytes: HTTP_CHECK_LIMITS.responseBytes,
    requestTimeoutMs: HTTP_CHECK_LIMITS.requestTimeoutMs,
    allowPrivateHosts: [...(base?.allowPrivateHosts ?? []), ...privateHosts],
  };
}

/**
 * For custom-api: egress = customApiEgress(privateHosts, base.egress),
 * timeoutMs 60_000, redactValues += customApiSecretValues(...). For
 * http-check: egress = httpCheckEgress(privateHosts, base.egress), timeoutMs
 * 60_000. Other bundled connectors: base, never with the custom API private
 * hosts; one whose manifest names `configuredHosts` gets the connector
 * private hosts (NETRICS_CONNECTOR_PRIVATE_HOSTS, #892), which the runtime
 * applies to that connection's configured hosts only.
 */
export function callOptionsFor(
  resolved: ResolvedConnector,
  given: ExecuteOptions,
  input: {
    credentials: Record<string, unknown>;
    privateHosts: readonly string[];
    connectorPrivateHosts?: readonly string[];
    config?: Record<string, unknown>;
  },
): ExecuteOptions {
  // The connector private hosts are set here alone, never by a caller.
  const { connectorPrivateHosts: _unscoped, ...base } = given;
  if (!resolved.customApi && resolved.manifest.id === HTTP_CHECK_CONNECTOR_ID) {
    return {
      ...base,
      egress: httpCheckEgress(input.privateHosts, base.egress),
      timeoutMs: HTTP_CHECK_LIMITS.callTimeoutMs,
    };
  }
  if (!resolved.customApi) {
    const connectorPrivateHosts = resolved.manifest.configuredHosts?.length
      ? (input.connectorPrivateHosts ?? [])
      : [];
    const scoped = connectorPrivateHosts.length
      ? { connectorPrivateHosts }
      : {};
    if (!base.egress?.allowPrivateHosts) return { ...base, ...scoped };
    const { allowPrivateHosts: _private, ...egress } = base.egress;
    return { ...base, egress, ...scoped };
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
