import { HTTP_CHECK_CONNECTOR_ID } from "@netrics/connectors";

/**
 * Connectors whose resources are their configuration (#874 review: an HTTP
 * check connection's checks). Discovery reads the config only, so a saved
 * config change names its resources at once and retires the freshness of
 * those it no longer has; a resource selection, which the sync could not
 * honor, is refused (a check is removed from the list instead). A run of
 * such a connector publishes its snapshot and freshness only while the
 * configuration it read is still the saved one (#898).
 */
export const RESOURCES_FROM_CONFIG: ReadonlySet<string> = new Set([
  HTTP_CHECK_CONNECTOR_ID,
]);
