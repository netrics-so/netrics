"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { canManageMember } from "@netrics/domain";
import type { Invitation, Member, WorkspaceRole } from "@netrics/contracts";

import {
  apiErrorMessage,
  createInvitation,
  removeMember,
  revokeInvitation,
  updateMemberRole,
} from "@/lib/api";

const ALL_ROLES: WorkspaceRole[] = ["owner", "admin", "editor", "viewer"];

function rolesGrantableBy(actorRole: WorkspaceRole): WorkspaceRole[] {
  return ALL_ROLES.filter((role) => canManageMember(actorRole, role, "add"));
}

function roleOptionsForTarget(
  actorRole: WorkspaceRole,
  target: Member,
): WorkspaceRole[] {
  return ALL_ROLES.filter(
    (role) =>
      role === target.role ||
      canManageMember(actorRole, target.role, "change-role", role),
  );
}

export function InviteMemberForm({
  workspaceId,
  actorRole,
}: {
  workspaceId: string;
  actorRole: WorkspaceRole;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    email: string;
    inviteUrl: string | null;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const grantable = rolesGrantableBy(actorRole);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    setError(null);
    setResult(null);
    setPending(true);
    const form = new FormData(formEl);
    try {
      const { invitation, inviteUrl } = await createInvitation(
        workspaceId,
        String(form.get("email") ?? ""),
        String(form.get("role")) as WorkspaceRole,
      );
      setResult({ email: invitation.email, inviteUrl });
      formEl.reset();
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <form className="inline" onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="invite-email">Invite by email</label>
          <input
            id="invite-email"
            name="email"
            type="email"
            required
            disabled={pending}
          />
        </div>
        <div className="field">
          <label htmlFor="invite-role">Role</label>
          <select
            id="invite-role"
            name="role"
            defaultValue="viewer"
            disabled={pending}
          >
            {grantable.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={pending}>
          {pending ? "Inviting…" : "Invite"}
        </button>
      </form>
      {error ? <div className="error">{error}</div> : null}
      {result ? (
        result.inviteUrl ? (
          <div className="stack">
            <p className="muted">
              Email is not configured on this installation. Send this link to{" "}
              {result.email} yourself. It works once, only for that address, and
              expires in 7 days.
            </p>
            <input
              readOnly
              value={result.inviteUrl}
              aria-label="Invitation link"
              className="copy-link"
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>
        ) : (
          <p className="muted">Invitation sent to {result.email}.</p>
        )
      ) : null}
    </>
  );
}

function InvitationRow({
  workspaceId,
  invitation,
  actorRole,
}: {
  workspaceId: string;
  invitation: Invitation;
  actorRole: WorkspaceRole;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const mayRevoke = canManageMember(actorRole, invitation.role, "add");

  async function revoke() {
    setError(null);
    setPending(true);
    try {
      await revokeInvitation(workspaceId, invitation.id);
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="row">
      <span>
        {invitation.email}{" "}
        <span className="muted">
          invited as {invitation.role}
          {invitation.invitedByName ? ` by ${invitation.invitedByName}` : ""},
          expires {new Date(invitation.expiresAt).toLocaleDateString()}
        </span>
      </span>
      <span className="value">
        {mayRevoke ? (
          <button type="button" onClick={revoke} disabled={pending}>
            {pending ? "Revoking…" : "Revoke"}
          </button>
        ) : null}
        {error ? <span className="error">{error}</span> : null}
      </span>
    </div>
  );
}

function MemberRow({
  workspaceId,
  member,
  actorRole,
  currentUserId,
}: {
  workspaceId: string;
  member: Member;
  actorRole: WorkspaceRole;
  currentUserId: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const isSelf = member.userId === currentUserId;
  const mayChangeRole =
    !isSelf && canManageMember(actorRole, member.role, "change-role");
  const mayRemove = canManageMember(actorRole, member.role, "remove");

  async function run(action: () => Promise<unknown>) {
    setError(null);
    setPending(true);
    try {
      await action();
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="row">
      <span>
        {member.displayName}{" "}
        <span className="muted">
          {member.email}
          {isSelf ? " (you)" : ""}
        </span>
      </span>
      <span className="value">
        {mayChangeRole ? (
          <select
            value={member.role}
            disabled={pending}
            onChange={(event) =>
              run(() =>
                updateMemberRole(
                  workspaceId,
                  member.userId,
                  event.target.value as WorkspaceRole,
                ),
              )
            }
          >
            {roleOptionsForTarget(actorRole, member).map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        ) : (
          <span className="role-badge">{member.role}</span>
        )}
        {mayRemove ? (
          <button
            type="button"
            className="danger"
            disabled={pending}
            onClick={() => {
              if (
                window.confirm(
                  `Remove ${member.displayName} (${member.email}) from this workspace?`,
                )
              ) {
                void run(() => removeMember(workspaceId, member.userId));
              }
            }}
          >
            Remove
          </button>
        ) : null}
      </span>
      {error ? <div className="error">{error}</div> : null}
    </div>
  );
}

export function MembersManager({
  workspaceId,
  members,
  actorRole,
  currentUserId,
  canAdd,
  invitations,
}: {
  workspaceId: string;
  members: Member[];
  actorRole: WorkspaceRole;
  currentUserId: string;
  canAdd: boolean;
  invitations: Invitation[];
}) {
  return (
    <div className="card">
      <h2>Members</h2>
      {members.map((member) => (
        <MemberRow
          key={member.id}
          workspaceId={workspaceId}
          member={member}
          actorRole={actorRole}
          currentUserId={currentUserId}
        />
      ))}
      {canAdd ? (
        <>
          {invitations.length > 0 ? (
            <>
              <h3>Pending invitations</h3>
              {invitations.map((invitation) => (
                <InvitationRow
                  key={invitation.id}
                  workspaceId={workspaceId}
                  invitation={invitation}
                  actorRole={actorRole}
                />
              ))}
            </>
          ) : null}
          <InviteMemberForm workspaceId={workspaceId} actorRole={actorRole} />
        </>
      ) : null}
    </div>
  );
}
