import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import { DisplayCurrencyForm } from "./display-currency-form";
import { MembersManager } from "./members-manager";
import { RenameWorkspaceForm } from "./rename-workspace-form";
import { TimeZoneForm } from "./time-zone-form";
import {
  getCurrencyConversion,
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
  const [{ members }, { invitations }, conversion] = await Promise.all([
    listMembers(cookieHeader, workspaceId),
    canAddMembers
      ? listInvitations(cookieHeader, workspaceId)
      : Promise.resolve({ invitations: [] }),
    canRename ? getCurrencyConversion(cookieHeader, workspaceId) : null,
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

      {canRename && conversion ? (
        <div className="card">
          <h2>Currency</h2>
          <DisplayCurrencyForm
            workspaceId={workspaceId}
            currentDisplayCurrency={workspaceResult.workspace.displayCurrency}
            options={conversion}
          />
        </div>
      ) : null}

      {can(role, "dashboards:view") ? (
        <div className="card">
          <h2>Themes</h2>
          <p className="muted">
            Colours and text size of dashboards on TVs: five built-in themes and
            your own.
          </p>
          <p>
            <Link href={`/workspaces/${workspaceId}/settings/themes`}>
              Manage themes
            </Link>
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
