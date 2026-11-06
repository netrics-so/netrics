import type { ConnectorRegistry } from "@netrics/connector-runtime";
import {
  findConnection,
  insertAuditEvent,
  requestConnectionBackfill,
  withWorkspace,
  type Database,
} from "@netrics/database";

export type OperatorBackfillResult =
  | { ok: true; jobId: string; connectorId: string }
  | { ok: false; reason: string };

/**
 * Operator path (admin-cli backfill-connection): reads a connection's whole
 * backfill window again, e.g. after a connector fix changed what it writes
 * for days that are already stored. Same job as a config change queues
 * (#153); stored observations stay and are overwritten with the new values.
 * Audited without an actor: the operator is not a workspace member.
 */
export async function requestOperatorBackfill(
  db: Database,
  registry: ConnectorRegistry,
  input: { workspaceId: string; connectionId: string },
): Promise<OperatorBackfillResult> {
  return withWorkspace(db, { workspaceId: input.workspaceId }, async (tx) => {
    const connection = await findConnection(
      tx,
      input.workspaceId,
      input.connectionId,
    );
    if (!connection) {
      return { ok: false, reason: "no such connection in this workspace" };
    }
    const { connectorId, setupPending } = connection.row;
    if (setupPending) {
      return {
        ok: false,
        reason:
          "the connection is still being set up; its first backfill runs once setup finishes",
      };
    }
    const registered = registry.get(connectorId);
    if (!registered) {
      return { ok: false, reason: `connector ${connectorId} is not installed` };
    }
    if (!registered.manifest.supportsBackfill) {
      return {
        ok: false,
        reason: `connector ${connectorId} does not support backfills`,
      };
    }
    const jobId = await requestConnectionBackfill(tx, input);
    await insertAuditEvent(tx, {
      workspaceId: input.workspaceId,
      actorUserId: null,
      action: "connection.backfill_requested",
      target: input.connectionId,
      metadata: { connectorId, by: "operator" },
    });
    return { ok: true, jobId, connectorId };
  });
}
