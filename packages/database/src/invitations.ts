import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";

import type { Db, Transaction } from "./context.js";
import { invitations, users } from "./schema.js";

type Executor = Db | Transaction;

export type InvitationDelivery = "email" | "manual";
export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export interface Invitation {
  id: string;
  workspaceId: string;
  email: string;
  role: string;
  delivery: InvitationDelivery;
  invitedByUserId: string | null;
  invitedByName: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface InvitationPreview {
  invitationId: string;
  workspaceName: string;
  email: string;
  role: string;
  delivery: InvitationDelivery;
  status: InvitationStatus;
  expiresAt: Date;
}

export type AcceptInvitationError =
  | "invitation_not_found"
  | "invitation_revoked"
  | "invitation_used"
  | "invitation_expired"
  | "invitation_email_mismatch";

const ACCEPT_ERRORS: readonly AcceptInvitationError[] = [
  "invitation_not_found",
  "invitation_revoked",
  "invitation_used",
  "invitation_expired",
  "invitation_email_mismatch",
];

export class AcceptInvitationFailure extends Error {
  constructor(readonly reason: AcceptInvitationError) {
    super(reason);
    this.name = "AcceptInvitationFailure";
  }
}

/**
 * Creates an invitation in the current workspace context, revoking any open
 * invitation for the same address first (inviting again = resend with a
 * fresh token). Must run inside withWorkspace().
 */
export async function createInvitation(
  tx: Transaction,
  input: {
    workspaceId: string;
    email: string;
    role: string;
    tokenHash: string;
    delivery: InvitationDelivery;
    invitedByUserId: string;
    expiresAt: Date;
  },
): Promise<Invitation> {
  const email = input.email.toLowerCase();
  await tx
    .update(invitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(invitations.workspaceId, input.workspaceId),
        eq(invitations.email, email),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ),
    );
  const [row] = await tx
    .insert(invitations)
    .values({ ...input, email })
    .returning();
  return { ...toInvitation(row!), invitedByName: null };
}

/** Open (not accepted, revoked or expired) invitations of a workspace. */
export async function listOpenInvitations(
  tx: Transaction,
  workspaceId: string,
): Promise<Invitation[]> {
  const rows = await tx
    .select({ invitation: invitations, invitedByName: users.displayName })
    .from(invitations)
    .leftJoin(users, eq(users.id, invitations.invitedByUserId))
    .where(
      and(
        eq(invitations.workspaceId, workspaceId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, sql`now()`),
      ),
    )
    .orderBy(desc(invitations.createdAt));
  return rows.map(({ invitation, invitedByName }) => ({
    ...toInvitation(invitation),
    invitedByName,
  }));
}

/** Revokes an open invitation; returns it, or null when none was open. */
export async function revokeInvitation(
  tx: Transaction,
  workspaceId: string,
  invitationId: string,
): Promise<Invitation | null> {
  const [row] = await tx
    .update(invitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(invitations.workspaceId, workspaceId),
        eq(invitations.id, invitationId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ),
    )
    .returning();
  return row ? { ...toInvitation(row), invitedByName: null } : null;
}

/** Looks an invitation up by token hash without a tenant context. */
export async function previewInvitation(
  db: Executor,
  tokenHash: string,
): Promise<InvitationPreview | null> {
  const rows = await db.execute<{
    invitation_id: string;
    workspace_name: string;
    email: string;
    role: string;
    delivery: InvitationDelivery;
    status: InvitationStatus;
    expires_at: string | Date;
  }>(sql`select * from invitation_preview(${tokenHash})`);
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    invitationId: row.invitation_id,
    workspaceName: row.workspace_name,
    email: row.email,
    role: row.role,
    delivery: row.delivery,
    status: row.status,
    expiresAt: new Date(row.expires_at),
  };
}

/**
 * Grants the invited membership to `userId`, whose account email must match
 * the invitation. Returns the workspace id; throws AcceptInvitationFailure
 * with a stable reason otherwise.
 */
export async function acceptInvitation(
  db: Executor,
  tokenHash: string,
  userId: string,
): Promise<string> {
  try {
    const rows = await db.execute<{ workspace_id: string }>(
      sql`select accept_invitation(${tokenHash}, ${userId}::uuid) as workspace_id`,
    );
    return rows[0]!.workspace_id;
  } catch (error) {
    const reason = acceptFailureReason(error);
    if (reason) {
      throw new AcceptInvitationFailure(reason);
    }
    throw error;
  }
}

function acceptFailureReason(error: unknown): AcceptInvitationError | null {
  // RAISE EXCEPTION without ERRCODE is P0001 (raise_exception); the message
  // is the stable reason. drizzle wraps driver errors, so walk the causes.
  let current: unknown = error;
  while (current instanceof Error) {
    const { code, message } = current as Error & { code?: string };
    if (code === "P0001") {
      const reason = ACCEPT_ERRORS.find((r) => r === message);
      if (reason) {
        return reason;
      }
    }
    current = current.cause;
  }
  return null;
}

function toInvitation(row: typeof invitations.$inferSelect) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    email: row.email,
    role: row.role,
    delivery: row.delivery as InvitationDelivery,
    invitedByUserId: row.invitedByUserId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}
