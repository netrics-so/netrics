/**
 * Resources (#194): the app, project or property an observation belongs to,
 * named by its `resource` dimension. A tile shows all of a connection's
 * resources added up, or one of them.
 */

/** The dimension that names an observation's resource. */
export const RESOURCE_DIMENSION = "resource";

/**
 * A tile's label: its own title, else the metric name, followed by the
 * resource it shows ("Downloads · Wurfel"), by id when it has no name.
 */
export function tileLabel(input: {
  title: string | null;
  metricName: string;
  dimensions: Readonly<Record<string, string>>;
  resourceName: string | null;
}): string {
  if (input.title) {
    return input.title;
  }
  const resource = input.dimensions[RESOURCE_DIMENSION];
  return resource === undefined
    ? input.metricName
    : `${input.metricName} · ${input.resourceName ?? resource}`;
}
