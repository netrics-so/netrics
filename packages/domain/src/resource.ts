/**
 * Resources (#194): the app, project or property an observation belongs to,
 * named by its `resource` dimension. A tile shows all of a connection's
 * resources added up, or one of them.
 */

/** The dimension that names an observation's resource. */
export const RESOURCE_DIMENSION = "resource";

/** What a connector calls its resources ("app", "apps"). */
export interface ResourceNoun {
  singular: string;
  plural: string;
}

/** For connectors that do not name their resources. */
export const DEFAULT_RESOURCE_NOUN: ResourceNoun = {
  singular: "resource",
  plural: "resources",
};

/**
 * The scope of a tile of all resources (#208): "All apps" when there is
 * more than one to add up, else null (one resource is the same as all).
 */
export function allResourcesName(
  noun: ResourceNoun | null | undefined,
  resourceCount: number,
): string | null {
  return resourceCount > 1
    ? `All ${(noun ?? DEFAULT_RESOURCE_NOUN).plural}`
    : null;
}

/**
 * A tile's label: its own title, else the metric name, followed by the
 * resource it shows ("Downloads · Wurfel", by id when it has no name) or,
 * for a tile of several resources added up, by their scope ("Downloads ·
 * All apps", see allResourcesName).
 */
export function tileLabel(input: {
  title: string | null;
  metricName: string;
  dimensions: Readonly<Record<string, string>>;
  resourceName: string | null;
  allResourcesName?: string | null;
}): string {
  if (input.title) {
    return input.title;
  }
  const resource = input.dimensions[RESOURCE_DIMENSION];
  if (resource !== undefined) {
    return `${input.metricName} · ${input.resourceName ?? resource}`;
  }
  return input.allResourcesName
    ? `${input.metricName} · ${input.allResourcesName}`
    : input.metricName;
}
