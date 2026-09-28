import { notFound } from "next/navigation";

import {
  getDashboard,
  getWorkspace,
  listConnections,
  listWorkspaceMetrics,
} from "@/lib/api";
import { requireSession } from "@/lib/session";

import type { TileConnection } from "../metric-tile";
import { TvDashboard } from "./tv-dashboard";

export const dynamic = "force-dynamic";

interface TvPageProps {
  params: Promise<{ workspaceId: string; dashboardId: string }>;
}

/** Full-screen, read-only dashboard for a wall screen or TV browser (#52). */
export default async function TvPage({ params }: TvPageProps) {
  const { workspaceId, dashboardId } = await params;
  const { cookieHeader } = await requireSession();
  const [workspaceResult, dashboardResult] = await Promise.all([
    getWorkspace(cookieHeader, workspaceId),
    getDashboard(cookieHeader, workspaceId, dashboardId),
  ]);
  if (!workspaceResult || !dashboardResult) {
    notFound();
  }
  const [{ metrics }, { connections }] = await Promise.all([
    listWorkspaceMetrics(cookieHeader, workspaceId),
    listConnections(cookieHeader, workspaceId),
  ]);
  const byId: Record<string, TileConnection> = Object.fromEntries(
    connections.map((connection) => [
      connection.id,
      { name: connection.name, state: connection.state },
    ]),
  );

  return (
    <TvDashboard
      workspaceId={workspaceId}
      timeZone={workspaceResult.workspace.timeZone}
      dashboard={dashboardResult.dashboard}
      metrics={metrics}
      connections={byId}
    />
  );
}
