import type { MetricResourcesResponse } from "@netrics/contracts";
import { RESOURCE_DIMENSION } from "@netrics/domain";

/**
 * The tile editor's resource choice (#194): a tile shows all of a
 * connection's resources added up (the default), or one app, project or
 * property.
 */

export type TileResources = MetricResourcesResponse["resources"];

/** Whether the metric's observations name their resource. */
export function hasResources(
  metric: { dimensions: readonly string[] } | undefined,
): boolean {
  return metric !== undefined && metric.dimensions.includes(RESOURCE_DIMENSION);
}

/**
 * Whether the editor offers a choice: only with more than one resource,
 * since one resource is the same as all of them.
 */
export function offersResourceChoice(resources: TileResources | null): boolean {
  return resources !== null && resources.length > 1;
}

/** A resource as the picker lists it: its name, else its id. */
export function resourceOptionLabel(resource: TileResources[number]): string {
  return resource.name ?? resource.id;
}

/**
 * The resource a new tile shows: the one picked, while the metric still
 * lists it, else none (all resources).
 */
export function effectiveResource(
  resources: TileResources | null,
  picked: string,
): TileResources[number] | null {
  return resources?.find((resource) => resource.id === picked) ?? null;
}

/** The dimension filter with the tile's resource, when it shows one. */
export function withResource(
  dimensions: Record<string, string>,
  resource: TileResources[number] | null,
): Record<string, string> {
  return resource
    ? { ...dimensions, [RESOURCE_DIMENSION]: resource.id }
    : dimensions;
}
