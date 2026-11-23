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

/**
 * The hosts a connection's configuration adds to its egress allowlist: the
 * valid value of each config key the manifest lists in `configuredHosts`.
 * Invalid or missing values add nothing.
 */
export function configuredHostsOf(
  manifest: { configuredHosts?: readonly string[] },
  config: Record<string, unknown>,
): string[] {
  const hosts: string[] = [];
  for (const key of manifest.configuredHosts ?? []) {
    const host = Object.hasOwn(config, key)
      ? configuredHost(config[key])
      : null;
    if (host !== null && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}
