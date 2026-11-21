// Expired builder drafts that hold an OAuth grant (milestone 13, #805): the
// scheduler queues one `custom_api.draft_expired` job per such draft
// (enqueue_expired_draft_grants, migration 0089) instead of pruning it, so
// the grant is revoked at the provider first. The revocation is best
// effort; the draft is deleted either way, unless it was touched again
// meanwhile (then it is no longer expired). No transaction spans the provider call.

import {
  DRAFT_CONNECTION_TTL_HOURS,
  findConnection,
  findConnectionOAuth,
  schema,
  withWorkspace,
} from "@netrics/database";
import { and, eq, lt } from "drizzle-orm";

import type { JobHandler } from "../jobs/handlers.js";
import type { OAuthTokenService } from "../oauth/tokens.js";

export const DRAFT_EXPIRED_JOB = "custom_api.draft_expired";

const HOUR_MS = 60 * 60 * 1000;

export function createDraftExpiredHandler(deps: {
  oauthTokens?: OAuthTokenService;
  now?: () => Date;
}): JobHandler {
  const now = deps.now ?? (() => new Date());
  return async ({ job, appDb, logger }) => {
    const workspaceId = job.workspaceId;
    const draftId = job.connectionId;
    if (!workspaceId || !draftId) return;
    const cutoff = new Date(
      now().getTime() - DRAFT_CONNECTION_TTL_HOURS * HOUR_MS,
    );
    const seen = await withWorkspace(appDb, { workspaceId }, async (tx) => {
      const found = await findConnection(tx, workspaceId, draftId, {
        includeDrafts: true,
      });
      if (
        !found ||
        found.row.status !== "draft" ||
        found.row.updatedAt >= cutoff
      )
        return null;
      const grant = await findConnectionOAuth(tx, workspaceId, draftId);
      const resolved = grant
        ? await deps.oauthTokens?.customOAuth?.resolve(tx, {
            workspaceId,
            connectionId: draftId,
          })
        : null;
      return { resolved: resolved ?? null };
    });
    if (!seen) return;
    // Never sent to hosts it was not entered for.
    const token = seen.resolved?.bindingHeld
      ? seen.resolved.credentials.refreshToken
      : null;
    const revoked =
      seen.resolved && token && deps.oauthTokens
        ? await deps.oauthTokens.revokeCustomGrant(
            seen.resolved.provider,
            token,
          )
        : false;
    const deleted = await withWorkspace(appDb, { workspaceId }, async (tx) => {
      const rows = await tx
        .delete(schema.connections)
        .where(
          and(
            eq(schema.connections.workspaceId, workspaceId),
            eq(schema.connections.id, draftId),
            eq(schema.connections.status, "draft"),
            // Not touched again meanwhile (still expired).
            lt(schema.connections.updatedAt, cutoff),
          ),
        )
        .returning({ id: schema.connections.id });
      // Touched during the cleanup: the draft stays, its revoked grant
      // goes, so the builder asks for a new sign-in.
      if (rows.length === 0 && seen.resolved)
        await tx
          .delete(schema.connectionOAuth)
          .where(
            and(
              eq(schema.connectionOAuth.workspaceId, workspaceId),
              eq(schema.connectionOAuth.connectionId, draftId),
            ),
          );
      return rows;
    });
    logger.info(
      { draftId, revoked, deleted: deleted.length > 0 },
      "expired custom API draft cleaned up",
    );
  };
}
