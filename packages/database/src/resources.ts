import { and, eq, inArray, sql } from "drizzle-orm";

import {
  DEFAULT_LOCALE,
  localizedResourceNoun,
  type ConnectorTranslations,
} from "@netrics/domain";

import type { Transaction } from "./context.js";
import * as schema from "./schema.js";

// A connection's resources (#194): the apps, projects or properties its
// observations carry in their `resource` dimension, with the names the
// connector's discover reported. Runs as netrics_app inside withWorkspace;
// every statement also names the workspace (tenant isolation twice).

/** The dimension that names an observation's resource (all connectors). */
const RESOURCE_DIMENSION = "resource";
/** Most resources one listing returns. */
const MAX_RESOURCES = 500;

export interface DiscoveredResourceName {
  id: string;
  name: string;
  kind: string;
}

/**
 * Records the names discover reported. Known resources get the new name;
 * resources missing from this discovery keep their last name, since their
 * observations stay.
 */
export async function upsertConnectionResources(
  tx: Transaction,
  input: {
    workspaceId: string;
    connectionId: string;
    resources: readonly DiscoveredResourceName[];
    now: Date;
  },
): Promise<void> {
  // One row per id: a statement may not update the same key twice.
  const unique = new Map(
    input.resources.map((resource) => [resource.id, resource]),
  );
  if (unique.size === 0) {
    return;
  }
  await tx
    .insert(schema.connectionResources)
    .values(
      [...unique.values()].map((resource) => ({
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        resourceId: resource.id,
        name: resource.name,
        kind: resource.kind,
        discoveredAt: input.now,
      })),
    )
    .onConflictDoUpdate({
      target: [
        schema.connectionResources.connectionId,
        schema.connectionResources.resourceId,
      ],
      set: {
        name: sql`excluded.name`,
        kind: sql`excluded.kind`,
        discoveredAt: sql`excluded.discovered_at`,
      },
    });
}

/** When the connection's resource names were last discovered, if ever. */
export async function connectionResourcesDiscoveredAt(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
): Promise<Date | null> {
  const rows = await tx.execute(sql`
    select max(discovered_at) as discovered_at
    from connection_resources
    where workspace_id = ${workspaceId} and connection_id = ${connectionId}`);
  const value = rows[0]?.discovered_at as string | Date | null | undefined;
  return value ? new Date(value) : null;
}

export interface MetricResource {
  /** The `resource` dimension value. */
  id: string;
  /** From discover; null when the connector has not named it (yet). */
  name: string | null;
}

/**
 * The resources a tile of this metric can show: those with observations of
 * the metric, and the named resources of the connection (only the selected
 * ones, when the connection syncs a selection). Named first, by name.
 */
export async function listMetricResources(
  tx: Transaction,
  query: { workspaceId: string; connectionId: string; metricKey: string },
): Promise<MetricResource[]> {
  const rows = await tx.execute(sql`
    with connection as (
      select c.id, c.connector_id, c.config -> 'resourceSelection' as selection
      from connections c
      where c.workspace_id = ${query.workspaceId}
        and c.id = ${query.connectionId}
    ),
    seen as (
      select distinct o.dimensions ->> ${RESOURCE_DIMENSION} as id
      from observations o
      join connection c on c.id = o.connection_id
      join metric_definitions m
        on m.id = o.metric_definition_id and m.connector_id = c.connector_id
      where o.workspace_id = ${query.workspaceId}
        and o.connection_id = ${query.connectionId}
        and m.key = ${query.metricKey}
        and o.dimensions ? ${RESOURCE_DIMENSION}
    ),
    named as (
      select r.resource_id as id
      from connection_resources r
      join connection c on c.id = r.connection_id
      where r.workspace_id = ${query.workspaceId}
        and r.connection_id = ${query.connectionId}
        and (
          jsonb_typeof(c.selection) is distinct from 'array'
          or jsonb_array_length(c.selection) = 0
          or c.selection ? r.resource_id
        )
    )
    select ids.id, r.name
    from (select id from seen union select id from named) ids
    left join connection_resources r
      on r.workspace_id = ${query.workspaceId}
      and r.connection_id = ${query.connectionId}
      and r.resource_id = ids.id
    order by r.name nulls last, ids.id
    limit ${MAX_RESOURCES}`);
  return rows.map((row) => ({
    id: row.id as string,
    name: (row.name as string | null) ?? null,
  }));
}

/**
 * Whether the connection knows this resource: it has observations of it,
 * discover named it, or the connection syncs a selection that includes it.
 */
export async function connectionHasResource(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
  resourceId: string,
): Promise<boolean> {
  const rows = await tx.execute(sql`
    select exists (
      select 1 from connection_resources
      where workspace_id = ${workspaceId}
        and connection_id = ${connectionId}
        and resource_id = ${resourceId}
    ) or exists (
      select 1 from connections
      where workspace_id = ${workspaceId}
        and id = ${connectionId}
        and jsonb_typeof(config -> 'resourceSelection') = 'array'
        and config -> 'resourceSelection' ? ${resourceId}
    ) or exists (
      select 1 from observations
      where workspace_id = ${workspaceId}
        and connection_id = ${connectionId}
        and dimensions @> ${JSON.stringify({ [RESOURCE_DIMENSION]: resourceId })}::jsonb
    ) as known`);
  return rows[0]?.known === true;
}

/**
 * Names of the given resources, keyed by `resourceNameKey`. Resources
 * without a discovered name are missing from the map.
 */
export async function findResourceNames(
  tx: Transaction,
  workspaceId: string,
  resources: readonly { connectionId: string; resourceId: string }[],
): Promise<Map<string, string>> {
  if (resources.length === 0) {
    return new Map();
  }
  const connectionIds = [...new Set(resources.map((r) => r.connectionId))];
  const resourceIds = [...new Set(resources.map((r) => r.resourceId))];
  const table = schema.connectionResources;
  const rows = await tx
    .select({
      connectionId: table.connectionId,
      resourceId: table.resourceId,
      name: table.name,
    })
    .from(table)
    .where(
      and(
        eq(table.workspaceId, workspaceId),
        inArray(table.connectionId, connectionIds),
        inArray(table.resourceId, resourceIds),
      ),
    );
  return new Map(
    rows.map((row) => [
      resourceNameKey(row.connectionId, row.resourceId),
      row.name,
    ]),
  );
}

/**
 * What the connection's connector calls its resources (its manifest's
 * `resourceNoun`, SDK 0.2.4), in `locale` when the connector translates it
 * (SDK 0.2.6, #257), or null when it does not say (#208).
 */
export async function findConnectionResourceNoun(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
  locale: string = DEFAULT_LOCALE,
): Promise<{ singular: string; plural: string } | null> {
  const rows = await tx.execute(sql`
    select k.manifest -> 'resourceNoun' as resource_noun,
           k.manifest -> 'translations' as translations
    from connections c
    join connectors k on k.id = c.connector_id
    where c.workspace_id = ${workspaceId} and c.id = ${connectionId}`);
  const row = rows[0];
  if (!row) {
    return null;
  }
  const stored = row.resource_noun as {
    singular?: unknown;
    plural?: unknown;
  } | null;
  const english =
    stored &&
    typeof stored.singular === "string" &&
    stored.singular !== "" &&
    typeof stored.plural === "string" &&
    stored.plural !== ""
      ? { singular: stored.singular, plural: stored.plural }
      : undefined;
  return localizedResourceNoun(
    {
      resourceNoun: english,
      translations: (row.translations ?? null) as ConnectorTranslations | null,
    },
    locale,
  );
}

/** The key of a resource in `findResourceNames`' result. */
export function resourceNameKey(
  connectionId: string,
  resourceId: string,
): string {
  return `${connectionId}|${resourceId}`;
}

/** Territories hinted per resource at most. */
const MAX_TERRITORY_HINTS = 3;

/**
 * The territories (ISO 3166-1 alpha-2) each resource has the largest
 * values for over the last 90 days, in any metric with a "territory"
 * dimension, largest first (#226: where a store lookup tries next). Groups
 * such as "Others" are left out.
 */
export async function resourceTopTerritories(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
  resourceIds: readonly string[],
  now: Date,
): Promise<Map<string, string[]>> {
  if (resourceIds.length === 0) {
    return new Map();
  }
  const since = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const rows = await tx.execute(sql`
    select resource, territory from (
      select resource, territory,
             row_number() over (
               partition by resource order by total desc, territory
             ) as rank
      from (
        select o.dimensions ->> ${RESOURCE_DIMENSION} as resource,
               o.dimensions ->> 'territory' as territory,
               sum(o.value) as total
        from observations o
        where o.workspace_id = ${workspaceId}
          and o.connection_id = ${connectionId}
          and o.source_timestamp >= ${since.toISOString()}
          and o.dimensions ->> ${RESOURCE_DIMENSION} in (${sql.join(
            resourceIds.map((id) => sql`${id}`),
            sql`, `,
          )})
          and o.dimensions ->> 'territory' ~ '^[A-Z]{2}$'
        group by 1, 2
      ) totals
    ) ranked
    where rank <= ${MAX_TERRITORY_HINTS}
    order by resource, rank`);
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const resource = row.resource as string;
    result.set(resource, [
      ...(result.get(resource) ?? []),
      row.territory as string,
    ]);
  }
  return result;
}

export interface NamedResource {
  connectionId: string;
  resourceId: string;
  name: string;
  kind: string;
}

/**
 * The discovered resources of the given connections (only the selected
 * ones, when a connection syncs a selection), by connection and name.
 */
export async function listNamedResources(
  tx: Transaction,
  workspaceId: string,
  connectionIds: readonly string[],
): Promise<NamedResource[]> {
  if (connectionIds.length === 0) {
    return [];
  }
  const rows = await tx.execute(sql`
    select r.connection_id, r.resource_id, r.name, r.kind
    from connection_resources r
    join connections c
      on c.workspace_id = ${workspaceId} and c.id = r.connection_id
    where r.workspace_id = ${workspaceId}
      and r.connection_id in (${sql.join(
        connectionIds.map((id) => sql`${id}`),
        sql`, `,
      )})
      and (
        jsonb_typeof(c.config -> 'resourceSelection') is distinct from 'array'
        or jsonb_array_length(c.config -> 'resourceSelection') = 0
        or c.config -> 'resourceSelection' ? r.resource_id
      )
    order by r.connection_id, r.name, r.resource_id
    limit ${MAX_RESOURCES}`);
  return rows.map((row) => ({
    connectionId: row.connection_id as string,
    resourceId: row.resource_id as string,
    name: row.name as string,
    kind: row.kind as string,
  }));
}
