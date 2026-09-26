"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { canManageMember } from "@netrics/domain";
import type { Member, WorkspaceRole } from "@netrics/contracts";

import {
  addMember,
  apiErrorMessage,
  removeMember,
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

export function AddMemberForm({
  workspaceId,
  actorRole,
}: {
  workspaceId: string;
  actorRole: WorkspaceRole;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const grantable = rolesGrantableBy(actorRole);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    setError(null);
    setPending(true);
    const form = new FormData(formEl);
    try {
      await addMember(
        workspaceId,
        String(form.get("email") ?? ""),
        String(form.get("role")) as WorkspaceRole,
      );
      formEl.reset();
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="inline" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="member-email">Member email</label>
        <input
          id="member-email"
          name="email"
          type="email"
          required
          disabled={pending}
        />
      </div>
      <div className="field">
        <label htmlFor="member-role">Role</label>
        <select
          id="member-role"
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
        {pending ? "Adding…" : "Add member"}
      </button>
      {error ? <div className="error">{error}</div> : null}
    </form>
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
}: {
  workspaceId: string;
  members: Member[];
  actorRole: WorkspaceRole;
  currentUserId: string;
  canAdd: boolean;
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
        <AddMemberForm workspaceId={workspaceId} actorRole={actorRole} />
      ) : null}
    </div>
  );
}
