import { notFound, redirect } from "next/navigation";

import { can } from "@netrics/domain";

import { StudioEditor } from "@/components/studio-editor/studio-editor";
import {
  getDashboard,
  getWorkspace,
  listConnections,
  listDashboards,
  listDevices,
  listImages,
  listProjects,
  listThemes,
  listWorkspaceMetrics,
  listWorkspaces,
} from "@/lib/api";
import { requireSession } from "@/lib/session";
import type { StudioConnection } from "@/lib/studio-widgets";

export const dynamic = "force-dynamic";

interface StudioPageProps {
  params: Promise<{ workspaceId: string; dashboardId: string }>;
}

/** The Studio for one dashboard (ADR 0015, section 9; #223). */
export default async function StudioPage({ params }: StudioPageProps) {
  const { workspaceId, dashboardId } = await params;
  const { cookieHeader } = await requireSession();

  const [{ workspaces }, dashboardResult] = await Promise.all([
    listWorkspaces(cookieHeader),
    getDashboard(cookieHeader, workspaceId, dashboardId),
  ]);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!membership || !dashboardResult) {
    notFound();
  }
  const role = membership.role;
  if (!can(role, "dashboards:update")) {
    // Viewers see the dashboard read-only.
    redirect(`/workspaces/${workspaceId}/dashboards/${dashboardId}`);
  }
  const canManageDevices = can(role, "devices:manage");
  const [
    { metrics },
    { connections },
    workspaceResult,
    themes,
    { images },
    { projects },
    { dashboards },
    devices,
  ] = await Promise.all([
    listWorkspaceMetrics(cookieHeader, workspaceId),
    listConnections(cookieHeader, workspaceId),
    getWorkspace(cookieHeader, workspaceId),
    listThemes(cookieHeader, workspaceId),
    listImages(cookieHeader, workspaceId),
    listProjects(cookieHeader, workspaceId),
    listDashboards(cookieHeader, workspaceId),
    canManageDevices ? listDevices(cookieHeader, workspaceId) : null,
  ]);
  const byId: Record<string, StudioConnection> = Object.fromEntries(
    connections.map((connection) => [
      connection.id,
      { name: connection.name, state: connection.state },
    ]),
  );

  return (
    <div className="studio-page">
      <StudioEditor
        workspaceId={workspaceId}
        dashboard={dashboardResult.dashboard}
        timeZone={workspaceResult?.workspace.timeZone ?? "UTC"}
        metrics={metrics}
        connections={byId}
        themes={{ builtins: themes.builtins, custom: themes.themes }}
        images={images}
        projects={projects.map((project) => ({
          id: project.id,
          name: project.name,
        }))}
        devices={devices?.devices ?? null}
        dashboardNames={Object.fromEntries(
          dashboards.map((dashboard) => [dashboard.id, dashboard.name]),
        )}
      />
    </div>
  );
}
