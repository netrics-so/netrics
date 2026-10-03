import type { ConnectorManifest } from "@netrics/connector-sdk";
import type { ConnectorRegistry } from "@netrics/connector-runtime";
import type { Database } from "@netrics/database";
import { schema } from "@netrics/database";

/**
 * Upserts one connector's catalog rows (connectors + metric_definitions) from
 * its manifest. Installation-level tables: written only by `migrate` (owner
 * role) when a deployment starts; the app role may only read them (#36).
 * Idempotent: conflicts refresh version/manifest/definition columns.
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
        granularity: metric.granularity,
        dimensions: [...metric.dimensions],
        aggregations: [...metric.aggregations],
        better: metric.better ?? "higher",
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
          granularity: metric.granularity,
          dimensions: [...metric.dimensions],
          aggregations: [...metric.aggregations],
          better: metric.better ?? "higher",
        },
      });
  }
}

/**
 * Syncs the installation-level connector catalog from the deployed bundle's
 * manifests. Runs in `migrate` (every deploy/upgrade) and in test setup.
 */
export async function syncCatalog(
  db: Database,
  registry: ConnectorRegistry,
): Promise<void> {
  for (const { manifest } of registry.list()) {
    await upsertConnectorCatalog(db, manifest);
  }
}
