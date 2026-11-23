/**
 * A permanent note on a connection's page about the access its connector
 * needs (#872 review), by connector ID, as a `connections.detail` message
 * key; null for connectors without one.
 *
 * Hetzner Cloud: the API cannot tell whether a token can also write, so
 * the page says that netrics only reads and a Read token is enough.
 */
export function connectorAccessNote(
  connectorId: string,
): "hetznerCloudReadOnly" | null {
  return connectorId === HETZNER_CLOUD_CONNECTOR_ID
    ? "hetznerCloudReadOnly"
    : null;
}

export const HETZNER_CLOUD_CONNECTOR_ID = "hetzner-cloud";
export const HETZNER_CLOUD_DOCS_URL =
  "https://github.com/netrics-so/netrics/blob/main/docs/connectors/hetzner-cloud.md";
