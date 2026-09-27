import type { FastifyInstance } from "fastify";

import type { WorkspaceRole } from "@netrics/contracts";
import {
  acceptInvitation,
  findUserByEmail,
  type Database,
} from "@netrics/database";

import { hashToken } from "./tokens.js";

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

/**
 * Test setup shortcut for "this account becomes a member": the admin invites
 * through the API (so permission checks apply), then the invitee's account
 * accepts through the same database function the accept route uses. Returns
 * the invitation response, so callers can assert 403/409 as before.
 *
 * Requires an app without email delivery (the invite URL is returned) and an
 * existing account for `email`. Accepting through the HTTP route itself is
 * covered in invitations.test.ts.
 */
export async function addMemberViaInvitation(
  app: FastifyInstance,
  db: Database,
  adminCookie: string,
  workspaceId: string,
  email: string,
  role: WorkspaceRole,
): Promise<InjectResponse> {
  const invited = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspaceId}/invitations`,
    headers: { cookie: adminCookie },
    payload: { email, role },
  });
  if (invited.statusCode !== 200) {
    return invited;
  }
  const { inviteUrl } = invited.json<{ inviteUrl: string | null }>();
  if (!inviteUrl) {
    throw new Error("addMemberViaInvitation needs manual delivery (no SMTP)");
  }
  const user = await findUserByEmail(db, email);
  if (!user) {
    throw new Error(`addMemberViaInvitation: no account for ${email}`);
  }
  const token = new URL(inviteUrl).pathname.split("/").pop()!;
  await acceptInvitation(db, hashToken(token), user.id);
  return invited;
}
