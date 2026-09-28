import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import { MembersManager } from "./members-manager";
import { RenameWorkspaceForm } from "./rename-workspace-form";
import { TimeZoneForm } from "./time-zone-form";
import {
  getMe,
  getWorkspace,
  listInvitations,
  listMembers,
  listWorkspaces,
} from "@/lib/api";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

interface WorkspaceSettingsPageProps {
  params: Promise<{ workspaceId: string }>;
}

export default async function WorkspaceSettingsPage({
  params,
}: WorkspaceSettingsPageProps) {
  const { workspaceId } = await params;
  const { cookieHeader } = await requireSession();

  const [{ workspaces }, workspaceResult, me] = await Promise.all([
    listWorkspaces(cookieHeader),
    getWorkspace(cookieHeader, workspaceId),
    getMe(cookieHeader),
  ]);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!workspaceResult || !membership || !me) {
    notFound();
  }

  const role = membership.role;
  const canRename = can(role, "workspace:rename");
  const canAddMembers = can(role, "members:add");
  const [{ members }, { invitations }] = await Promise.all([
    listMembers(cookieHeader, workspaceId),
    canAddMembers
      ? listInvitations(cookieHeader, workspaceId)
      : Promise.resolve({ invitations: [] }),
  ]);

  return (
    <>
      <h1>{workspaceResult.workspace.name} — settings</h1>
      <p className="subtitle">
        Your role: <span className="role-badge">{role}</span>
      </p>
      <p className="muted">
        <Link href={`/workspaces/${workspaceId}`}>Back to workspace</Link>
      </p>

      {canRename ? (
        <div className="card">
          <h2>Workspace</h2>
          <RenameWorkspaceForm
            workspaceId={workspaceId}
            currentName={workspaceResult.workspace.name}
          />
          <TimeZoneForm
            workspaceId={workspaceId}
            currentTimeZone={workspaceResult.workspace.timeZone}
          />
          <p className="muted">
            Dashboards count &ldquo;today&rdquo; and daily numbers in this time
            zone.
          </p>
        </div>
      ) : null}

      <MembersManager
        workspaceId={workspaceId}
        members={members}
        actorRole={role}
        currentUserId={me.user.id}
        canAdd={canAddMembers}
        invitations={invitations}
      />
    </>
  );
}
