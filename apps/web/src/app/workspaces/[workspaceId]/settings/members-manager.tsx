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
import { useLocale, useT } from "@/lib/i18n/client";

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
  const locale = useLocale();
  const t = useT("members");
  const roles = useT("common.roles");
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
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <form className="inline" onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="invite-email">{t("inviteEmail")}</label>
          <input
            id="invite-email"
            name="email"
            type="email"
            required
            disabled={pending}
          />
        </div>
        <div className="field">
          <label htmlFor="invite-role">{t("role")}</label>
          <select
            id="invite-role"
            name="role"
            defaultValue="viewer"
            disabled={pending}
          >
            {grantable.map((role) => (
              <option key={role} value={role}>
                {roles(role)}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={pending}>
          {pending ? t("inviting") : t("invite")}
        </button>
      </form>
      {error ? <div className="error">{error}</div> : null}
      {result ? (
        result.inviteUrl ? (
          <div className="stack">
            <p className="muted">{t("noEmail", { email: result.email })}</p>
            <input
              readOnly
              value={result.inviteUrl}
              aria-label={t("inviteLink")}
              className="copy-link"
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>
        ) : (
          <p className="muted">{t("sent", { email: result.email })}</p>
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
  const locale = useLocale();
  const t = useT("members");
  const roles = useT("common.roles");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const mayRevoke = canManageMember(actorRole, invitation.role, "add");
  const expires = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
  }).format(new Date(invitation.expiresAt));

  async function revoke() {
    setError(null);
    setPending(true);
    try {
      await revokeInvitation(workspaceId, invitation.id);
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="row">
      <span>
        {invitation.email}{" "}
        <span className="muted">
          {invitation.invitedByName
            ? t("invitedAsBy", {
                role: roles(invitation.role),
                inviter: invitation.invitedByName,
                date: expires,
              })
            : t("invitedAs", { role: roles(invitation.role), date: expires })}
        </span>
      </span>
      <span className="value">
        {mayRevoke ? (
          <button type="button" onClick={revoke} disabled={pending}>
            {pending ? t("revoking") : t("revoke")}
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
  const locale = useLocale();
  const t = useT("members");
  const roles = useT("common.roles");
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
      setError(apiErrorMessage(cause, locale));
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
          {isSelf ? ` ${t("you")}` : ""}
        </span>
      </span>
      <span className="value">
        {mayChangeRole ? (
          <select
            aria-label={t("roleOf", { name: member.displayName })}
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
                {roles(role)}
              </option>
            ))}
          </select>
        ) : (
          <span className="role-badge">{roles(member.role)}</span>
        )}
        {mayRemove ? (
          <button
            type="button"
            className="danger"
            disabled={pending}
            onClick={() => {
              if (
                window.confirm(
                  t("confirmRemove", {
                    name: member.displayName,
                    email: member.email,
                  }),
                )
              ) {
                void run(() => removeMember(workspaceId, member.userId));
              }
            }}
          >
            {t("remove")}
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
  const t = useT("members");
  return (
    <div className="card">
      <h2>{t("title")}</h2>
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
              <h3>{t("pendingInvitations")}</h3>
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
