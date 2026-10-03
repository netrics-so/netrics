import type { MetricResourcesResponse } from "@netrics/contracts";
import {
  RESOURCE_DIMENSION,
  allResourcesName,
  type ResourceNoun,
} from "@netrics/domain";

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

/** The picker's label: what the connector calls a resource ("App"). */
export function resourceFieldLabel(noun: ResourceNoun): string {
  return noun.singular.charAt(0).toUpperCase() + noun.singular.slice(1);
}

/** The picker's choice of all resources added up: "All apps". */
export function allResourcesOption(noun: ResourceNoun): string {
  return `All ${noun.plural}`;
}

/**
 * The scope a new tile names after the metric (#208): "All apps" for all of
 * several resources, null for one resource or a single one.
 */
export function newTileScope(
  resources: TileResources | null,
  resource: TileResources[number] | null,
  noun: ResourceNoun | null,
): string | null {
  return resource ? null : allResourcesName(noun, resources?.length ?? 0);
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
