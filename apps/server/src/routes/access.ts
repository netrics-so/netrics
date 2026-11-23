import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  errorResponseSchema,
  workspaceRoleSchema,
  type WorkspaceRole,
} from "@netrics/contracts";
import type { Locale } from "@netrics/domain";
import {
  findMembership,
  withUserContext,
  workspaceState,
  type Database,
} from "@netrics/database";

// Helpers shared by the /v1 route modules.

export function sendError(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send(errorResponseSchema.parse({ error }));
}

/** Parses the request body; sends 400 invalid_request and returns null on failure. */
export function parseBody<T>(
  schema: z.ZodType<T>,
  request: FastifyRequest,
  reply: FastifyReply,
): T | null {
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    sendError(reply, 400, "invalid_request");
    return null;
  }
  return parsed.data;
}

export interface WorkspaceAccess {
  workspaceId: string;
  callerId: string;
  role: WorkspaceRole;
  /** The caller's language (ADR 0016 section 3). */
  locale: Locale;
}

const workspaceParamsSchema = z.object({ workspaceId: z.uuid() });

/**
 * Resolves the caller's membership for the :workspaceId route param. The
 * workspace id comes from the URL but is never trusted: the membership lookup
 * runs under the caller's user context, and a missing membership yields 404
 * (not 403) so workspace existence is not leaked to non-members.
 */
export async function resolveAccess(
  db: Database,
  request: FastifyRequest,
  reply: FastifyReply,
  options: {
    /**
     * false: the membership alone, without the workspace's fence. Only for
     * the route that deletes the workspace (#855): delete_workspace()
     * checks state, role and name again under the exclusive fence, and a
     * request that waited for the fence here would hold a connection
     * before it reaches the queue of deletions. A deleted or purged
     * workspace has no members, so the answer is the same 404.
     */
    fence?: boolean;
  } = {},
): Promise<WorkspaceAccess | null> {
  const params = workspaceParamsSchema.safeParse(request.params);
  if (!params.success) {
    sendError(reply, 404, "workspace_not_found");
    return null;
  }
  const { domainUserId: callerId, locale } = request.sessionIdentity!;
  // A deleted workspace has no members; the fence also waits out a
  // deletion in progress, so access is never resolved across one (#839).
  const membership = await withUserContext(
    db,
    { userId: callerId },
    async (tx) =>
      options.fence === false ||
      (await workspaceState(tx, params.data.workspaceId)) === "live"
        ? findMembership(tx, params.data.workspaceId, callerId)
        : null,
  );
  if (!membership) {
    sendError(reply, 404, "workspace_not_found");
    return null;
  }
  return {
    workspaceId: params.data.workspaceId,
    callerId,
    role: workspaceRoleSchema.parse(membership.role),
    locale,
  };
}
