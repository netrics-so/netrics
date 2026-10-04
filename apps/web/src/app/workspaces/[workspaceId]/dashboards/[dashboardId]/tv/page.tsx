import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  getDashboard,
  getTheme,
  getWorkspace,
  listConnections,
  listStudioImages,
  listWorkspaceMetrics,
} from "@/lib/api";
import { getT } from "@/lib/i18n/server";
import { requireSession } from "@/lib/session";
import { resolveDashboardTheme } from "@/lib/studio-theme";
import { referencedImageIds } from "@/lib/studio-widgets";

import type { TileConnection } from "../metric-tile";
import { TvDashboard } from "./tv-dashboard";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("dashboard");
  return { title: t("tvPageTitle") };
}

interface TvPageProps {
  params: Promise<{ workspaceId: string; dashboardId: string }>;
}

/**
 * Full-screen, read-only dashboard for a wall screen or TV browser (#52):
 * its slides rotate as on a paired screen (#221), with live numbers from
 * the signed-in user's session.
 */
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
  const { dashboard } = dashboardResult;
  const [{ metrics }, { connections }, customTheme, images] = await Promise.all(
    [
      listWorkspaceMetrics(cookieHeader, workspaceId),
      listConnections(cookieHeader, workspaceId),
      dashboard.settings.themeId
        ? getTheme(cookieHeader, workspaceId, dashboard.settings.themeId)
        : null,
      referencedImageIds(dashboard).length > 0
        ? listStudioImages(cookieHeader, workspaceId)
        : [],
    ],
  );
  const byId: Record<string, TileConnection> = Object.fromEntries(
    connections.map((connection) => [
      connection.id,
      {
        name: connection.name,
        state: connection.state,
        setupPending: connection.setupPending,
        connectorId: connection.connectorId,
      },
    ]),
  );

  return (
    <TvDashboard
      workspaceId={workspaceId}
      timeZone={workspaceResult.workspace.timeZone}
      dashboard={dashboard}
      theme={resolveDashboardTheme(
        dashboard.settings,
        customTheme?.theme ?? null,
      )}
      images={images}
      metrics={metrics}
      connections={byId}
    />
  );
}
