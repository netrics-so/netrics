import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import { MembersManager } from "./members-manager";
import { getMe, listInvitations, listMembers, listWorkspaces } from "@/lib/api";
import { getT } from "@/lib/i18n/server";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("workspace.pages");
  return { title: `${t("team")} · netrics` };
}

interface TeamPageProps {
  params: Promise<{ workspaceId: string }>;
}

/** Members, their roles and invitations (#302; was in settings). */
export default async function TeamPage({ params }: TeamPageProps) {
  const { workspaceId } = await params;
  const { cookieHeader } = await requireSession();

  const [{ workspaces }, me] = await Promise.all([
    listWorkspaces(cookieHeader),
    getMe(cookieHeader),
  ]);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!membership || !me) {
    notFound();
  }
  const role = membership.role;
  const canAddMembers = can(role, "members:add");
  const [t, roles, settingsT] = await Promise.all([
    getT("workspace"),
    getT("common.roles"),
    getT("workspaceSettings"),
  ]);
  const [{ members }, { invitations }] = await Promise.all([
    listMembers(cookieHeader, workspaceId),
    canAddMembers
      ? listInvitations(cookieHeader, workspaceId)
      : Promise.resolve({ invitations: [] }),
  ]);

  return (
    <div className="area-page team-page">
      <header className="page-header">
        <div>
          <h1>{t("pages.team")}</h1>
          <p className="page-meta">
            {settingsT.rich("yourRole", {
              role: (
                <span key="role" className="role-badge">
                  {roles(role)}
                </span>
              ),
            })}
          </p>
        </div>
      </header>
      <MembersManager
        workspaceId={workspaceId}
        members={members}
        actorRole={role}
        currentUserId={me.user.id}
        canAdd={canAddMembers}
        invitations={invitations}
      />
    </div>
  );
}
