// The second step of deleting a workspace (#839). delete_workspace()
// (migration 0094) has already ended every way into the workspace and
// marked it deleted; this job removes what it holds and then the workspace
// row itself.
//
// Every step commits on its own and only removes, so the job is idempotent
// and resumes where a crashed or restarted worker stopped: connections one
// by one, each exactly like "Delete connection" (its OAuth grant released
// and, unless another workspace still uses it, revoked at the provider, best
// effort), then the larger remaining pieces in small transactions, then the
// workspace row, whose foreign keys cascade to everything left. A workspace
// that is not marked deleted is never touched.

import {
  hasSqlstate,
  insertAuditEvent,
  schema,
  withWorkspace,
  WORKSPACE_PURGE_JOB,
  type Database,
  type Transaction,
} from "@netrics/database";
import { and, eq, inArray, isNotNull, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Logger } from "pino";
import { z } from "zod";

import type { JobHandler } from "../jobs/handlers.js";
import { NonRetryableJobError } from "../jobs/handlers.js";

export { WORKSPACE_PURGE_JOB };

/** How a connection of the workspace is removed (ConnectionService). */
export type PurgeConnection = (
  workspaceId: string,
  connectionId: string,
) => Promise<
  | {
      ok: true;
      value: { revocation: { provider: string; status: string } | null };
    }
  | { ok: false; status: number; error: string }
>;

/**
 * A tenant transaction for a workspace that is deleted: every other
 * transaction refuses one (the fence in withWorkspace).
 */
const inDeleted = <T>(
  appDb: Database,
  workspaceId: string,
  run: (tx: Transaction) => Promise<T>,
) => withWorkspace(appDb, { workspaceId }, run, { fence: "any" });

const payloadSchema = z.object({ purge_workspace_id: z.uuid() });

/** Rows removed per transaction for the pieces deleted in batches. */
const BATCH = 25;

const FOREIGN_KEY_VIOLATION = "23503";

interface Piece {
  name: string;
  table: PgTable;
  id: PgColumn;
  workspaceId: PgColumn;
  /** Rows per transaction: one where a row's cascade can be large. */
  batch: number;
}

// After the connections (whose cascades take observations, source datasets,
// reviews and stream records with them): what else can be large. Dashboards
// go before the images they refer to. Everything not listed is small and
// goes with the workspace row.
const PIECES: readonly Piece[] = [
  {
    name: "dashboards",
    table: schema.dashboards,
    id: schema.dashboards.id,
    workspaceId: schema.dashboards.workspaceId,
    batch: 1,
  },
  {
    name: "models",
    table: schema.dataModels,
    id: schema.dataModels.id,
    workspaceId: schema.dataModels.workspaceId,
    batch: 1,
  },
  {
    name: "preparations",
    table: schema.dataPreparations,
    id: schema.dataPreparations.id,
    workspaceId: schema.dataPreparations.workspaceId,
    batch: 1,
  },
  {
    name: "datasets",
    table: schema.dataDatasets,
    id: schema.dataDatasets.id,
    workspaceId: schema.dataDatasets.workspaceId,
    batch: 1,
  },
  {
    name: "images",
    table: schema.workspaceImages,
    id: schema.workspaceImages.id,
    workspaceId: schema.workspaceImages.workspaceId,
    batch: BATCH,
  },
];

/**
 * Deletes one piece in small transactions. A row another table still refers
 * to without a cascade is left for the workspace row's cascade, which
 * removes both sides in one statement.
 */
async function removePiece(
  appDb: Database,
  workspaceId: string,
  piece: Piece,
  logger: Logger,
): Promise<number> {
  let removed = 0;
  for (;;) {
    let deleted: number;
    try {
      deleted = await inDeleted(appDb, workspaceId, async (tx) => {
        const scope: SQL = eq(piece.workspaceId, workspaceId);
        const ids = await tx
          .select({ id: piece.id })
          .from(piece.table)
          .where(scope)
          .limit(piece.batch);
        if (ids.length === 0) return 0;
        await tx.delete(piece.table).where(
          and(
            scope,
            inArray(
              piece.id,
              ids.map((row) => row.id as string),
            ),
          ),
        );
        return ids.length;
      });
    } catch (error) {
      if (!hasSqlstate(error, FOREIGN_KEY_VIOLATION)) throw error;
      logger.info(
        { piece: piece.name },
        "still referenced; left for the workspace cascade",
      );
      return removed;
    }
    if (deleted === 0) return removed;
    removed += deleted;
  }
}

export function createWorkspacePurgeHandler(deps: {
  purgeConnection: PurgeConnection;
}): JobHandler {
  return async ({ job, appDb, logger }) => {
    const payload = payloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new NonRetryableJobError("contract: purge names no workspace");
    }
    const workspaceId = payload.data.purge_workspace_id;
    const log = logger.child({ purgeWorkspaceId: workspaceId });

    const [workspace] = await inDeleted(appDb, workspaceId, (tx) =>
      tx
        .select({ deletedAt: schema.workspaces.deletedAt })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1),
    );
    if (!workspace) {
      // An earlier attempt finished the purge.
      log.info("workspace already purged");
      return;
    }
    if (!workspace.deletedAt) {
      throw new NonRetryableJobError(
        "contract: purge of a workspace that is not deleted",
      );
    }

    // Connections, builder drafts included, each as its own disconnect.
    const revocations = { revoked: 0, failed: 0, kept: 0 };
    let connections = 0;
    for (;;) {
      const rows = await inDeleted(appDb, workspaceId, (tx) =>
        tx
          .select({ id: schema.connections.id })
          .from(schema.connections)
          .where(eq(schema.connections.workspaceId, workspaceId))
          .limit(BATCH),
      );
      if (rows.length === 0) break;
      for (const { id } of rows) {
        const result = await deps.purgeConnection(workspaceId, id);
        if (!result.ok) {
          // 404: gone meanwhile (a second purge attempt). Anything else
          // (a grant that kept changing hands) is tried again.
          if (result.status === 404) continue;
          throw new Error(`connection not removed: ${result.error}`);
        }
        connections += 1;
        const status = result.value.revocation?.status;
        if (status === "revoked") revocations.revoked += 1;
        else if (status === "failed") revocations.failed += 1;
        else if (status === "kept") revocations.kept += 1;
        // Provider and outcome only: never a token.
        if (result.value.revocation) {
          log.info(
            {
              connectionId: id,
              provider: result.value.revocation.provider,
              revocation: status,
            },
            "oauth grant of a purged connection",
          );
        }
      }
    }

    const pieces: Record<string, number> = {};
    for (const piece of PIECES) {
      pieces[piece.name] = await removePiece(appDb, workspaceId, piece, log);
    }

    // The row, and with it everything that still hangs off it. Only a
    // workspace still marked deleted; the audit event names no person (the
    // deletion itself was recorded with its actor).
    const purged = await inDeleted(appDb, workspaceId, async (tx) => {
      const rows = await tx
        .delete(schema.workspaces)
        .where(
          and(
            eq(schema.workspaces.id, workspaceId),
            isNotNull(schema.workspaces.deletedAt),
          ),
        )
        .returning({ id: schema.workspaces.id });
      if (rows.length > 0) {
        await insertAuditEvent(tx, {
          workspaceId: null,
          actorUserId: null,
          action: "workspace.purged",
          target: workspaceId,
          metadata: { connections, oauthGrants: revocations },
        });
      }
      return rows;
    });
    log.info(
      { connections, revocations, ...pieces, purged: purged.length > 0 },
      "workspace purged",
    );
  };
}
