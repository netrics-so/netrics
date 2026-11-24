// Hosts a connection names in its configuration (SDK 0.2.20, #873): a
// self-hosted instance of a provider, for example. A manifest lists the
// config keys under `configuredHosts`; the host adds the value of each to
// the connection's egress allowlist, exactly as this function reads it.

/** Longest host name (RFC 1035). */
const MAX_HOST_LENGTH = 253;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The host name a configured value names, lowercased, or null when it names
 * none. Accepted: a bare name ("posthog.example.com") or an https URL
 * without credentials, port, query or fragment, with at most a "/" path
 * ("https://posthog.example.com/"). Refused: http and other schemes, IP
 * addresses, single-label names ("localhost"), wildcards, ports and
 * anything else. The egress guard still checks every address the name
 * resolves to (no private, loopback or metadata addresses).
 */
export function configuredHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let host = value.trim().toLowerCase();
  if (host.startsWith("https://")) {
    host = host.slice("https://".length);
    if (host.endsWith("/")) host = host.slice(0, -1);
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "" || host.length > MAX_HOST_LENGTH) return null;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) {
    return null;
  }
  // The last label of a name is never all digits: that is an IPv4 address.
  if (/^\d+$/.test(labels.at(-1)!)) return null;
  return host;
}

/** An IPv4 address in dotted decimal, each part 0–255 without leading zeros. */
const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/**
 * The host of a URL a configuration item names (SDK 0.2.21, #874: a
 * health check's URL), lowercased, or null. Accepted: an absolute https
 * URL without user info, whose host is a name of at least two labels (as
 * `configuredHost` reads it) or an IP address; any port, path and query.
 * Refused: http and other schemes, single-label names ("localhost"),
 * anything unparsable or longer than 2,048 characters. The egress guard
 * still checks every address (no private, loopback or metadata addresses
 * unless the host allows them).
 */
export function configuredUrlHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "" || text.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    // The URL parser has validated and normalized the IPv6 address.
    return host.slice(1, -1);
  }
  if (IPV4.test(host)) return host;
  return configuredHost(host);
}

/** A `configuredHosts` entry: a config key, or `<array key>[].<item key>`. */
export function configuredHostPath(entry: string): {
  key: string;
  item?: string;
} {
  const match = /^([^[\]]+)\[\]\.([^[\].]+)$/.exec(entry);
  return match ? { key: match[1]!, item: match[2]! } : { key: entry };
}

/**
 * The hosts a connection's configuration adds to its egress allowlist: the
 * valid value of each config key the manifest lists in `configuredHosts`.
 * Invalid or missing values add nothing. An entry `<key>[].<item>` (SDK
 * 0.2.21, #874) names a URL in each item of the array `<key>`: each valid
 * URL's host (`configuredUrlHost`) is added.
 */
export function configuredHostsOf(
  manifest: { configuredHosts?: readonly string[]; configSchema?: unknown },
  config: Record<string, unknown>,
): string[] {
  const hosts: string[] = [];
  const add = (host: string | null) => {
    if (host !== null && !hosts.includes(host)) hosts.push(host);
  };
  for (const entry of manifest.configuredHosts ?? []) {
    const path = configuredHostPath(entry);
    if (path.item === undefined) {
      add(configuredHost(effectiveValue(manifest, config, path.key)));
      continue;
    }
    const items = Object.hasOwn(config, path.key) ? config[path.key] : null;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const record = item as Record<string, unknown>;
        add(
          configuredUrlHost(
            Object.hasOwn(record, path.item) ? record[path.item] : undefined,
          ),
        );
      }
    }
  }
  return hosts;
}

/**
 * Whether a configured URL host is followed on redirects only to the same
 * scheme, host and port (SDK 0.2.21, #874): a manifest with an item path
 * in `configuredHosts` names user-entered URLs, whose redirects never go
 * to another host, even one the configuration also names.
 */
export function configuredUrlsFollowSameHostOnly(manifest: {
  configuredHosts?: readonly string[];
}): boolean {
  return (manifest.configuredHosts ?? []).some(
    (entry) => configuredHostPath(entry).item !== undefined,
  );
}

/**
 * A configured value as the connector reads it: missing, null or blank is
 * the configSchema property's default (#884 review 2), so `{}`, `""` and
 * the default name one destination, for egress and for the binding alike.
 */
function effectiveValue(
  manifest: { configSchema?: unknown },
  config: Record<string, unknown>,
  key: string,
): unknown {
  const value = Object.hasOwn(config, key) ? config[key] : undefined;
  if (
    value !== undefined &&
    value !== null &&
    !(typeof value === "string" && value.trim() === "")
  ) {
    return value;
  }
  const properties =
    manifest.configSchema && typeof manifest.configSchema === "object"
      ? (manifest.configSchema as { properties?: unknown }).properties
      : undefined;
  const property =
    properties &&
    typeof properties === "object" &&
    Object.hasOwn(properties, key)
      ? (properties as Record<string, unknown>)[key]
      : undefined;
  return property && typeof property === "object"
    ? (property as { default?: unknown }).default
    : undefined;
}

// ─── Credentials bound to configured hosts (#884 review) ───────────────────
//
// A connection's credentials go only to the hosts they were entered for.
// When a host stores credentials of a connector with `configuredHosts`, it
// records the configured hosts in the credential envelope under
// CREDENTIAL_HOSTS_KEY (`bindCredentialHosts`). The runtime refuses a call
// whose configuration names other hosts than the bound ones while it
// carries credentials (`credentialHostsMatch`), and hands the connector the
// credentials without that key. The host also keeps a connection's
// configured hosts fixed (`configuredHostsChanged`): another host is
// another connection, entered with its own credentials.

/** The reserved credential key holding the bound hosts. */
export const CREDENTIAL_HOSTS_KEY = "$configuredHosts";

function sameHosts(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((host) => right.has(host));
}

/**
 * Freshly entered credentials, bound to the configured hosts of the config
 * they are checked and stored with. Unchanged for a manifest without
 * `configuredHosts` and for credentials without a secret. Never apply it
 * to stored credentials: that would move them to another host.
 */
export function bindCredentialHosts(
  manifest: { configuredHosts?: readonly string[]; configSchema?: unknown },
  config: Record<string, unknown>,
  credentials: Record<string, unknown>,
): Record<string, unknown> {
  if (!manifest.configuredHosts?.length) return credentials;
  // Nothing secret to bind (an HTTP check connection, #874): stored as is.
  const secrets = withoutCredentialHosts(credentials);
  if (Object.keys(secrets).length === 0) return secrets;
  return {
    ...secrets,
    [CREDENTIAL_HOSTS_KEY]: configuredHostsOf(manifest, config),
  };
}

/** The credentials as a connector sees them: without the bound hosts. */
export function withoutCredentialHosts(
  credentials: Record<string, unknown>,
): Record<string, unknown> {
  if (!Object.hasOwn(credentials, CREDENTIAL_HOSTS_KEY)) return credentials;
  const { [CREDENTIAL_HOSTS_KEY]: _bound, ...rest } = credentials;
  return rest;
}

/**
 * Whether credentials may be used with this config: always for a manifest
 * without `configuredHosts` or for credentials without a secret; otherwise
 * only when the config names exactly the bound hosts (none bound: none
 * configured).
 */
export function credentialHostsMatch(
  manifest: { configuredHosts?: readonly string[]; configSchema?: unknown },
  config: Record<string, unknown>,
  credentials: Record<string, unknown>,
): boolean {
  if (!manifest.configuredHosts?.length) return true;
  if (Object.keys(withoutCredentialHosts(credentials)).length === 0) {
    return true;
  }
  const raw = credentials[CREDENTIAL_HOSTS_KEY];
  const bound =
    Array.isArray(raw) && raw.every((host) => typeof host === "string")
      ? (raw as string[])
      : [];
  return sameHosts(bound, configuredHostsOf(manifest, config));
}

/**
 * Whether a config change names other configured hosts. Never for a
 * connector without credentials (every auth strategy "none", SDK 0.2.21,
 * #874): with nothing to carry to another host, a health check may name
 * new URLs.
 */
export function configuredHostsChanged(
  manifest: {
    configuredHosts?: readonly string[];
    configSchema?: unknown;
    authStrategies?: readonly { strategy: string }[];
  },
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  if (
    manifest.authStrategies?.length &&
    manifest.authStrategies.every((strategy) => strategy.strategy === "none")
  ) {
    return false;
  }
  return !sameHosts(
    configuredHostsOf(manifest, before),
    configuredHostsOf(manifest, after),
  );
}
