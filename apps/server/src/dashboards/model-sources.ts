import { and, eq, inArray, or } from "drizzle-orm";
import { schema, type Transaction } from "@netrics/database";

import { graphDefaultLinks } from "./developer-portfolio.js";

// The sources a published model reads (#721): one resolution for the
// measure widget's source warnings, its freshness and the compare widget's
// health, so the three always name the same connections.

/** What a published release records about its inputs. */
export interface ModelRelease {
  bindings: Readonly<Record<string, unknown>>;
  dependencies: { prepared?: Record<string, number> };
}

export interface ModelSourceDatasets {
  /** Every dataset id the model reads, bound or through a preparation. */
  all: Set<string>;
  /** The datasets of each preparation source node, by the node's id. */
  bySourceNode: Map<string, Set<string>>;
  /** The default links its pinned preparations carry (#913). */
  defaultLinks: PinnedDefaultLinks;
}

/**
 * The default links a Developer Portfolio's preparations carry (#913), as
 * the versions releases pin them at have them: by the links table they
 * read (their `links` source node), the pinned versions they come from
 * (`<preparationId>@<version>`, sorted: what a cache keys them by) and,
 * per resource, every project a pinned version links it to. What a
 * project's freshness resolves its resources through, so it covers the
 * resources the model's rows do.
 */
export type PinnedDefaultLinks = Map<
  string,
  { pins: string; links: Map<string, Set<string>> }
>;

/**
 * The default links of pinned preparation graphs, by links table. Every
 * pinned version counts (#923): during a partial rollout two releases may
 * pin one preparation at different versions, or two preparations of one
 * install may link a resource to different projects. A resource is then
 * in each project a version links it to, as each release's rows have it;
 * the links table resolves over each of them alike (readMapping).
 */
function pinnedDefaultLinks(
  graphs: readonly { preparationId: string; version: number; graph: unknown }[],
): PinnedDefaultLinks {
  const found = new Map<
    string,
    { pins: string[]; links: Map<string, Set<string>> }
  >();
  const seen = new Set<string>();
  for (const entry of [...graphs].sort((a, b) =>
    a.preparationId < b.preparationId
      ? -1
      : a.preparationId > b.preparationId
        ? 1
        : a.version - b.version,
  )) {
    const pin = `${entry.preparationId}@${entry.version}`;
    if (seen.has(pin)) continue;
    seen.add(pin);
    const nodes = (entry.graph as { nodes?: unknown[] } | undefined)?.nodes;
    const links = (Array.isArray(nodes) ? nodes : []).find(
      (node): node is { datasetId: string } =>
        !!node &&
        typeof node === "object" &&
        (node as { type?: unknown }).type === "source" &&
        (node as { id?: unknown }).id === "links" &&
        typeof (node as { datasetId?: unknown }).datasetId === "string",
    )?.datasetId;
    if (!links) continue;
    const defaults = graphDefaultLinks(entry.graph);
    const keys = Object.keys(defaults);
    if (!keys.length) continue;
    let table = found.get(links);
    if (!table) found.set(links, (table = { pins: [], links: new Map() }));
    table.pins.push(pin);
    for (const key of keys) {
      const projects = table.links.get(key);
      if (projects) projects.add(defaults[key]!);
      else table.links.set(key, new Set([defaults[key]!]));
    }
  }
  return new Map(
    [...found].map(([links, table]) => [
      links,
      { pins: table.pins.join(","), links: table.links },
    ]),
  );
}

/**
 * The datasets of a release: its bindings, which the loader records for
 * everything it read, and the source nodes of the preparation versions it
 * is pinned to (`dependencies.prepared`, nested ones included).
 */
export async function modelSourceDatasets(
  tx: Transaction,
  workspaceId: string,
  release: ModelRelease,
): Promise<ModelSourceDatasets> {
  const all = new Set(Object.keys(release.bindings));
  const bySourceNode = new Map<string, Set<string>>();
  const graphs: { preparationId: string; version: number; graph: unknown }[] =
    [];
  for (const [preparationId, version] of Object.entries(
    release.dependencies.prepared ?? {},
  )) {
    const [row] = await tx
      .select({ graph: schema.dataPreparationVersions.graph })
      .from(schema.dataPreparationVersions)
      .where(
        and(
          eq(schema.dataPreparationVersions.workspaceId, workspaceId),
          eq(schema.dataPreparationVersions.preparationId, preparationId),
          eq(schema.dataPreparationVersions.version, version),
        ),
      );
    if (row) graphs.push({ preparationId, version, graph: row.graph });
    const nodes = (row?.graph as { nodes?: unknown[] } | undefined)?.nodes;
    for (const node of Array.isArray(nodes) ? nodes : [])
      if (
        node &&
        typeof node === "object" &&
        "type" in node &&
        node.type === "source" &&
        "datasetId" in node &&
        typeof node.datasetId === "string"
      ) {
        all.add(node.datasetId);
        if ("id" in node && typeof node.id === "string")
          bySourceNode.set(
            node.id,
            (bySourceNode.get(node.id) ?? new Set()).add(node.datasetId),
          );
      }
  }
  return { all, bySourceNode, defaultLinks: pinnedDefaultLinks(graphs) };
}

/** A published release as one batched read returns it. */
export interface PublishedRelease extends ModelRelease {
  definition: unknown;
}

/**
 * The published releases of several models in one query (#835): what a
 * shown dashboard reads once for its column heads, units and the products
 * its slide scopes name. A model without a published version is absent.
 */
export async function publishedReleases(
  tx: Transaction,
  workspaceId: string,
  modelIds: readonly string[],
): Promise<Map<string, PublishedRelease>> {
  const ids = [...new Set(modelIds)];
  if (!ids.length) return new Map();
  const rows = await tx
    .select({
      id: schema.dataModels.id,
      definition: schema.dataModelReleases.definition,
      bindings: schema.dataModelReleases.schemaBindings,
      dependencies: schema.dataModelReleases.dependencies,
    })
    .from(schema.dataModels)
    .innerJoin(
      schema.dataModelReleases,
      and(
        eq(schema.dataModelReleases.workspaceId, workspaceId),
        eq(schema.dataModelReleases.modelId, schema.dataModels.id),
        eq(
          schema.dataModelReleases.version,
          schema.dataModels.publishedVersion,
        ),
      ),
    )
    .where(
      and(
        eq(schema.dataModels.workspaceId, workspaceId),
        inArray(schema.dataModels.id, ids),
      ),
    );
  return new Map(
    rows.map((row) => [
      row.id,
      {
        definition: row.definition,
        bindings: row.bindings as Record<string, unknown>,
        dependencies: row.dependencies as ModelRelease["dependencies"],
      },
    ]),
  );
}

/**
 * Every dataset several releases read, as `modelSourceDatasets` finds
 * them for one, with all their pinned preparation versions in one query.
 */
export async function releasesSourceDatasets(
  tx: Transaction,
  workspaceId: string,
  releases: Iterable<ModelRelease>,
): Promise<Pick<ModelSourceDatasets, "all" | "defaultLinks">> {
  const all = new Set<string>();
  const pinned = new Map<string, [string, number]>();
  for (const release of releases) {
    for (const id of Object.keys(release.bindings)) all.add(id);
    for (const [preparationId, version] of Object.entries(
      release.dependencies.prepared ?? {},
    ))
      pinned.set(`${preparationId}@${version}`, [preparationId, version]);
  }
  if (!pinned.size) return { all, defaultLinks: new Map() };
  const rows = await tx
    .select({
      preparationId: schema.dataPreparationVersions.preparationId,
      version: schema.dataPreparationVersions.version,
      graph: schema.dataPreparationVersions.graph,
    })
    .from(schema.dataPreparationVersions)
    .where(
      and(
        eq(schema.dataPreparationVersions.workspaceId, workspaceId),
        or(
          ...[...pinned.values()].map(([preparationId, version]) =>
            and(
              eq(schema.dataPreparationVersions.preparationId, preparationId),
              eq(schema.dataPreparationVersions.version, version),
            ),
          ),
        ),
      ),
    );
  for (const row of rows) {
    const nodes = (row.graph as { nodes?: unknown[] } | undefined)?.nodes;
    for (const node of Array.isArray(nodes) ? nodes : [])
      if (
        node &&
        typeof node === "object" &&
        "type" in node &&
        node.type === "source" &&
        "datasetId" in node &&
        typeof node.datasetId === "string"
      )
        all.add(node.datasetId);
  }
  return { all, defaultLinks: pinnedDefaultLinks(rows) };
}

const ID = /^[0-9a-f-]{36}$/i;

/**
 * The connection of each dataset that has one: `observation:<connection>:…`
 * and `resources:<connection>` by their id, a stored dataset by its row.
 * Manual and prepared datasets have none.
 */
export async function datasetConnections(
  tx: Transaction,
  workspaceId: string,
  datasetIds: Iterable<string>,
): Promise<Map<string, string>> {
  const connectionOf = new Map<string, string>();
  const stored: string[] = [];
  for (const id of datasetIds) {
    if (id.startsWith("observation:") || id.startsWith("resources:")) {
      const connectionId = id.split(":")[1];
      if (connectionId && ID.test(connectionId))
        connectionOf.set(id, connectionId);
    } else if (ID.test(id)) stored.push(id);
  }
  if (stored.length)
    for (const dataset of await tx
      .select({
        id: schema.dataDatasets.id,
        connectionId: schema.dataDatasets.connectionId,
      })
      .from(schema.dataDatasets)
      .where(
        and(
          eq(schema.dataDatasets.workspaceId, workspaceId),
          inArray(schema.dataDatasets.id, stored),
        ),
      ))
      if (dataset.connectionId)
        connectionOf.set(dataset.id, dataset.connectionId);
  return connectionOf;
}

/**
 * The connections a model reads, each once, and those of each preparation
 * source node by its id (a compiled compare's `numerator_source`).
 */
export async function modelSourceConnections(
  tx: Transaction,
  workspaceId: string,
  sources: ModelSourceDatasets,
): Promise<{ all: string[]; bySourceNode: Map<string, string[]> }> {
  const connectionOf = await datasetConnections(tx, workspaceId, sources.all);
  const connectionsOf = (ids: Iterable<string>) => [
    ...new Set(
      [...ids].flatMap((id) => {
        const connection = connectionOf.get(id);
        return connection ? [connection] : [];
      }),
    ),
  ];
  return {
    all: connectionsOf(sources.all),
    bySourceNode: new Map(
      [...sources.bySourceNode].map(([node, ids]) => [
        node,
        connectionsOf(ids),
      ]),
    ),
  };
}
