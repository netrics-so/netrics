import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  acceptInvitationResponseSchema,
  createInvitationRequestSchema,
  invitationListResponseSchema,
  invitationPreviewResponseSchema,
  invitationResponseSchema,
  workspaceRoleSchema,
} from "@netrics/contracts";
import {
  AcceptInvitationFailure,
  acceptInvitation,
  createInvitation,
  findUserById,
  findWorkspace,
  insertAuditEvent,
  listMembers,
  listOpenInvitations,
  previewInvitation,
  revokeInvitation,
  withWorkspace,
  type Database,
  type Invitation,
} from "@netrics/database";
import { can, canManageMember } from "@netrics/domain";

import type { AuthService } from "../auth/index.js";
import type { Mailer } from "../mail/mailer.js";
import { generateToken, hashToken } from "../tokens.js";
import { parseBody, resolveAccess, sendError } from "./access.js";
import { createRequireSession } from "./session.js";

export interface InvitationRouteDeps {
  authService: AuthService;
  db: Database;
  mailer: Mailer;
  /** Public web origin; invitation links point to <webOrigin>/invite/<token>. */
  webOrigin: string;
}

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const invitationParamsSchema = z.object({ invitationId: z.uuid() });
// Tokens are 43-char base64url strings; bound the input before hashing.
const tokenParamsSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
});

function toInvitation(invitation: Invitation) {
  return {
    id: invitation.id,
    email: invitation.email,
    role: workspaceRoleSchema.parse(invitation.role),
    delivery: invitation.delivery,
    invitedByName: invitation.invitedByName,
    createdAt: invitation.createdAt.toISOString(),
    expiresAt: invitation.expiresAt.toISOString(),
  };
}

const ACCEPT_FAILURE_STATUS: Record<AcceptInvitationFailure["reason"], number> =
  {
    invitation_not_found: 404,
    invitation_revoked: 410,
    invitation_used: 410,
    invitation_expired: 410,
    invitation_email_mismatch: 403,
  };

/**
 * Workspace invitations. Admins create, list and revoke them; the invitee
 * previews (public, token only) and accepts (signed in, matching email).
 */
export function registerInvitationRoutes(
  app: FastifyInstance,
  deps: InvitationRouteDeps,
): void {
  const requireSession = createRequireSession(deps.authService);

  void app.register(
    (scope, _opts, done) => {
      // Public: the token is the credential. Reveals only what the invite
      // page shows (workspace name, invited address, role, status).
      scope.get("/invitations/:token", async (request, reply) => {
        const params = tokenParamsSchema.safeParse(request.params);
        const preview = params.success
          ? await previewInvitation(deps.db, hashToken(params.data.token))
          : null;
        if (!preview) {
          return sendError(reply, 404, "invitation_not_found");
        }
        return invitationPreviewResponseSchema.parse({
          workspaceName: preview.workspaceName,
          email: preview.email,
          role: preview.role,
          status: preview.status,
          expiresAt: preview.expiresAt.toISOString(),
        });
      });

      done();
    },
    { prefix: "/v1" },
  );

  void app.register(
    (scope, _opts, done) => {
      scope.addHook("preHandler", requireSession);

      scope.post(
        "/workspaces/:workspaceId/invitations",
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) {
            return;
          }
          if (!can(access.role, "members:add")) {
            return sendError(reply, 403, "forbidden");
          }
          const body = parseBody(createInvitationRequestSchema, request, reply);
          if (!body) {
            return;
          }
          if (!canManageMember(access.role, body.role, "add")) {
            return sendError(reply, 403, "forbidden");
          }
          const email = body.email.toLowerCase();
          const token = generateToken();
          const delivery = deps.mailer.delivers ? "email" : "manual";

          const created = await withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            async (tx) => {
              // Membership is visible to admins anyway, so saying so leaks
              // nothing about other workspaces or the installation.
              const members = await listMembers(tx, access.workspaceId);
              if (members.some((m) => m.email.toLowerCase() === email)) {
                return null;
              }
              const invitation = await createInvitation(tx, {
                workspaceId: access.workspaceId,
                email,
                role: body.role,
                tokenHash: hashToken(token),
                delivery,
                invitedByUserId: access.callerId,
                expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
              });
              await insertAuditEvent(tx, {
                workspaceId: access.workspaceId,
                actorUserId: access.callerId,
                action: "invitation.created",
                target: invitation.id,
                metadata: { email, role: body.role, delivery },
              });
              const workspace = await findWorkspace(tx, access.workspaceId);
              return { invitation, workspaceName: workspace!.name };
            },
          );
          if (!created) {
            return sendError(reply, 409, "membership_exists");
          }

          const inviteUrl = new URL(
            `/invite/${token}`,
            deps.webOrigin,
          ).toString();
          if (delivery === "email") {
            const inviter = await findUserById(deps.db, access.callerId);
            try {
              await deps.mailer.sendInvitationEmail({
                to: email,
                url: inviteUrl,
                workspaceName: created.workspaceName,
                inviterName: inviter?.displayName ?? "A workspace admin",
              });
            } catch {
              // The invitation stays open; inviting again sends a new link.
              return sendError(reply, 502, "email_delivery_failed");
            }
          }
          return invitationResponseSchema.parse({
            invitation: toInvitation(created.invitation),
            inviteUrl: delivery === "manual" ? inviteUrl : null,
          });
        },
      );

      scope.get(
        "/workspaces/:workspaceId/invitations",
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) {
            return;
          }
          if (!can(access.role, "members:add")) {
            return sendError(reply, 403, "forbidden");
          }
          const invitations = await withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            (tx) => listOpenInvitations(tx, access.workspaceId),
          );
          return invitationListResponseSchema.parse({
            invitations: invitations.map(toInvitation),
          });
        },
      );

      scope.delete(
        "/workspaces/:workspaceId/invitations/:invitationId",
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) {
            return;
          }
          const params = invitationParamsSchema.safeParse(request.params);
          if (!params.success) {
            return sendError(reply, 404, "invitation_not_found");
          }
          if (!can(access.role, "members:add")) {
            return sendError(reply, 403, "forbidden");
          }
          const result = await withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            async (tx) => {
              const open = await listOpenInvitations(tx, access.workspaceId);
              const target = open.find(
                (i) => i.id === params.data.invitationId,
              );
              if (!target) {
                return "not_found" as const;
              }
              // Only owners may manage invitations that grant the owner role.
              const role = workspaceRoleSchema.parse(target.role);
              if (!canManageMember(access.role, role, "add")) {
                return "forbidden" as const;
              }
              await revokeInvitation(tx, access.workspaceId, target.id);
              await insertAuditEvent(tx, {
                workspaceId: access.workspaceId,
                actorUserId: access.callerId,
                action: "invitation.revoked",
                target: target.id,
                metadata: { email: target.email, role: target.role },
              });
              return "revoked" as const;
            },
          );
          if (result === "not_found") {
            return sendError(reply, 404, "invitation_not_found");
          }
          if (result === "forbidden") {
            return sendError(reply, 403, "forbidden");
          }
          return reply.code(204).send();
        },
      );

      scope.post("/invitations/:token/accept", async (request, reply) => {
        const params = tokenParamsSchema.safeParse(request.params);
        if (!params.success) {
          return sendError(reply, 404, "invitation_not_found");
        }
        try {
          const workspaceId = await acceptInvitation(
            deps.db,
            hashToken(params.data.token),
            request.sessionIdentity!.domainUserId,
          );
          return acceptInvitationResponseSchema.parse({ workspaceId });
        } catch (error) {
          if (error instanceof AcceptInvitationFailure) {
            return sendError(
              reply,
              ACCEPT_FAILURE_STATUS[error.reason],
              error.reason,
            );
          }
          throw error;
        }
      });

      done();
    },
    { prefix: "/v1" },
  );
}
