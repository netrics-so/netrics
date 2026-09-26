import type { ConnectorManifest } from "@netrics/connector-sdk";
import type { ConnectorRegistry } from "@netrics/connector-runtime";
import type { Database } from "@netrics/database";
import { schema } from "@netrics/database";

/**
 * Upserts one connector's catalog rows (connectors + metric_definitions) from
 * its manifest. These tables are installation-level (no RLS), so the app role
 * writes them directly — outside any tenant context. Idempotent: conflicts
 * refresh version/manifest/definition columns.
 *
 * Accepts a plain database handle or a tenant transaction (the sync engine
 * calls it inside its ingest transaction so first-use definitions commit
 * atomically with the observations that reference them).
 */
export async function upsertConnectorCatalog(
  db: Pick<Database, "insert">,
  manifest: ConnectorManifest,
): Promise<void> {
  await db
    .insert(schema.connectors)
    .values({
      id: manifest.id,
      version: manifest.version,
      manifest: { ...manifest },
    })
    .onConflictDoUpdate({
      target: schema.connectors.id,
      set: {
        version: manifest.version,
        manifest: { ...manifest },
        updatedAt: new Date(),
      },
    });
  for (const metric of manifest.metrics) {
    await db
      .insert(schema.metricDefinitions)
      .values({
        connectorId: manifest.id,
        key: metric.key,
        name: metric.name,
        description: metric.description,
        kind: metric.kind,
        unit: metric.unit,
        dimensions: [...metric.dimensions],
        aggregations: [...metric.aggregations],
      })
      .onConflictDoUpdate({
        target: [
          schema.metricDefinitions.connectorId,
          schema.metricDefinitions.key,
        ],
        set: {
          name: metric.name,
          description: metric.description,
          kind: metric.kind,
          unit: metric.unit,
          dimensions: [...metric.dimensions],
          aggregations: [...metric.aggregations],
        },
      });
  }
}

/**
 * Syncs the installation-level connector catalog from the registry's
 * manifests. Called at worker (and api) startup and explicitly in tests.
 */
export async function syncCatalog(
  db: Database,
  registry: ConnectorRegistry,
): Promise<void> {
  for (const { manifest } of registry.list()) {
    await upsertConnectorCatalog(db, manifest);
  }
}
