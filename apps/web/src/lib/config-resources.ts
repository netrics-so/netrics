/**
 * Connectors whose resources are their configuration (#874: an HTTP check
 * connection's checks). The wizard lists them without a selection, since
 * the sync requests every configured check; one is left out by removing it
 * from the list. The API refuses a selection for them as well.
 */
const RESOURCES_FROM_CONFIG: ReadonlySet<string> = new Set(["http-check"]);

export function resourcesFromConfig(connectorId: string): boolean {
  return RESOURCES_FROM_CONFIG.has(connectorId);
}
