import {
  chosenRetentionDays,
  connectorDatasetRetention,
  effectiveRetentionDays,
  type ConnectionRetention,
  type ConnectionRetentionChoice,
  type SourceDatasetDefinition,
} from "@netrics/contracts";
import type { ConnectorRegistry } from "@netrics/connector-runtime";
import type { ConnectorManifest } from "@netrics/connector-sdk";
import {
  findConnection,
  findConnectionRetention,
  insertAuditEvent,
  resolveDataPolicy,
  setConnectionRetention,
  withWorkspace,
  type ConnectionRetentionRecord,
  type Database,
} from "@netrics/database";
import type { DataPolicy } from "@netrics/domain";

import type { Actor, Result } from "./service.js";

// Per-connection dataset retention (#492): one choice per dataset of the
// connection's connector, capped by the workspace maximum.

/** Whether every key of the choice is a dataset of the connector. */
export function retentionNamesDatasets(
  manifest: Pick<ConnectorManifest, "datasets">,
  choice: ConnectionRetentionChoice,
): boolean {
  const keys = new Set((manifest.datasets ?? []).map((d) => d.key));
  return Object.keys(choice).every((key) => keys.has(key));
}

export function presentConnectionRetention(
  datasets: readonly SourceDatasetDefinition[],
  record: ConnectionRetentionRecord,
  workspaceMaxDays: number | null,
): ConnectionRetention {
  return {
    datasets: datasets.map((definition) => {
      const chosen = chosenRetentionDays(definition, record);
      const effectiveDays = effectiveRetentionDays(
        chosen.days,
        workspaceMaxDays,
      );
      return {
        ...connectorDatasetRetention(definition),
        days: chosen.days,
        source: chosen.source,
        effectiveDays,
        cappedByWorkspace: effectiveDays !== chosen.days,
      };
    }),
    workspaceMaxDays,
    basis: record.basis,
    chosenAt: record.chosenAt?.toISOString() ?? null,
    chosenBy: record.chosenBy,
  };
}

export interface ConnectionRetentionServiceDeps {
  db: Database;
  registry: ConnectorRegistry;
  /** Instance data policy defaults; workspace overrides resolve per request. */
  dataPolicy?: DataPolicy;
}

type RetentionResult = Result<ConnectionRetention>;

export function createConnectionRetentionService(
  deps: ConnectionRetentionServiceDeps,
) {
  function datasetsOf(connectorId: string) {
    return deps.registry.get(connectorId)?.manifest.datasets ?? [];
  }

  return {
    /** The connection's retention per dataset, as settings show it. */
    get(actor: Actor, connectionId: string): Promise<RetentionResult> {
      return withWorkspace(
        deps.db,
        { workspaceId: actor.workspaceId, userId: actor.callerId },
        async (tx): Promise<RetentionResult> => {
          const connection = await findConnection(
            tx,
            actor.workspaceId,
            connectionId,
          );
          const record = await findConnectionRetention(
            tx,
            actor.workspaceId,
            connectionId,
          );
          if (!connection || !record)
            return { ok: false, status: 404, error: "connection_not_found" };
          const { policy } = await resolveDataPolicy(
            tx,
            actor.workspaceId,
            deps.dataPolicy,
          );
          return {
            ok: true,
            value: presentConnectionRetention(
              datasetsOf(connection.row.connectorId),
              record,
              policy.maxRetentionDays,
            ),
          };
        },
      );
    },

    /**
     * Replaces the connection's choice and applies it to stored deadlines
     * in the same transaction: shorter periods at once (caches cleared),
     * longer ones only for data that has not expired.
     */
    set(
      actor: Actor,
      connectionId: string,
      choice: ConnectionRetentionChoice,
    ): Promise<RetentionResult> {
      return withWorkspace(
        deps.db,
        { workspaceId: actor.workspaceId, userId: actor.callerId },
        async (tx): Promise<RetentionResult> => {
          const connection = await findConnection(
            tx,
            actor.workspaceId,
            connectionId,
          );
          if (!connection)
            return { ok: false, status: 404, error: "connection_not_found" };
          const datasets = datasetsOf(connection.row.connectorId);
          if (!retentionNamesDatasets({ datasets }, choice))
            return {
              ok: false,
              status: 400,
              error: "retention_dataset_unknown",
            };
          const before = await findConnectionRetention(
            tx,
            actor.workspaceId,
            connectionId,
          );
          const { policy } = await resolveDataPolicy(
            tx,
            actor.workspaceId,
            deps.dataPolicy,
          );
          const setting = {
            choice,
            fallback: before?.fallback ?? ("preset" as const),
          };
          const effective = Object.fromEntries(
            datasets.map((definition) => [
              definition.key,
              effectiveRetentionDays(
                chosenRetentionDays(definition, setting).days,
                policy.maxRetentionDays,
              ),
            ]),
          );
          const applied = await setConnectionRetention(tx, {
            workspaceId: actor.workspaceId,
            connectionId,
            choice,
            chosenBy: actor.callerId,
            effective,
          });
          if (!applied)
            return { ok: false, status: 404, error: "connection_not_found" };
          await insertAuditEvent(tx, {
            workspaceId: actor.workspaceId,
            actorUserId: actor.callerId,
            action: "connection.retention_updated",
            target: connectionId,
            metadata: { datasets: choice },
          });
          const record = await findConnectionRetention(
            tx,
            actor.workspaceId,
            connectionId,
          );
          return {
            ok: true,
            value: presentConnectionRetention(
              datasets,
              record!,
              policy.maxRetentionDays,
            ),
          };
        },
      );
    },
  };
}
