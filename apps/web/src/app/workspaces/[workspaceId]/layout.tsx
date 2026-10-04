import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { can } from "@netrics/domain";

import { AppShell } from "@/components/app-shell/app-shell";
import { listConnections, listWorkspaces } from "@/lib/api";
import { sourcesNeedingAttention } from "@/lib/app-nav";
import { getCurrentMe } from "@/lib/current-user";
import { requireSession } from "@/lib/session";

interface WorkspaceLayoutProps {
  params: Promise<{ workspaceId: string }>;
  children: ReactNode;
}

/**
 * Every workspace page sits in the app shell (ADR 0018 section 4, #302):
 * sidebar with the workspace's areas, top bar with source health and the
 * account. The Studio shows the icon rail and TV mode no chrome; the shell
 * decides from the path.
 */
export default async function WorkspaceLayout({
  params,
  children,
}: WorkspaceLayoutProps) {
  const { workspaceId } = await params;
  const { cookieHeader, user } = await requireSession();
  const [{ workspaces }, me] = await Promise.all([
    listWorkspaces(cookieHeader),
    getCurrentMe(),
  ]);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!membership) {
    notFound();
  }
  const { connections } = await listConnections(cookieHeader, workspaceId);

  return (
    <AppShell
      workspaceId={workspaceId}
      workspaces={workspaces.map(({ id, name }) => ({ id, name }))}
      userName={me?.user.displayName ?? user.name}
      permissions={{
        viewDevices: can(membership.role, "devices:view"),
        createConnections: can(membership.role, "connections:create"),
      }}
      sourceCount={connections.length}
      attention={sourcesNeedingAttention(connections)}
    >
      {children}
    </AppShell>
  );
}
