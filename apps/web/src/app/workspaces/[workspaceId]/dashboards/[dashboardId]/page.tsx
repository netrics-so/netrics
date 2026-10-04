import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import {
  getDashboard,
  getTheme,
  getWorkspace,
  listConnections,
  listStudioImages,
  listWorkspaceMetrics,
  listWorkspaces,
} from "@/lib/api";
import { getT } from "@/lib/i18n/server";
import { requireSession } from "@/lib/session";
import { resolveDashboardTheme } from "@/lib/studio-theme";
import { referencedImageIds } from "@/lib/studio-widgets";

import { DashboardView } from "./dashboard-view";
import type { TileConnection } from "./metric-tile";

export const dynamic = "force-dynamic";

/** Edge to edge on phones; the page keeps to the safe area (ADR 0017). */
export const viewport: Viewport = { viewportFit: "cover" };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("dashboard");
  return { title: t("pageTitle") };
}

interface DashboardPageProps {
  params: Promise<{ workspaceId: string; dashboardId: string }>;
}

export default async function DashboardPage({ params }: DashboardPageProps) {
  const { workspaceId, dashboardId } = await params;
  const { cookieHeader } = await requireSession();
  const t = await getT("dashboard");

  const [{ workspaces }, dashboardResult] = await Promise.all([
    listWorkspaces(cookieHeader),
    getDashboard(cookieHeader, workspaceId, dashboardId),
  ]);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!membership || !dashboardResult) {
    notFound();
  }
  const { dashboard } = dashboardResult;
  const [{ metrics }, { connections }, workspaceResult, customTheme, images] =
    await Promise.all([
      listWorkspaceMetrics(cookieHeader, workspaceId),
      listConnections(cookieHeader, workspaceId),
      getWorkspace(cookieHeader, workspaceId),
      dashboard.settings.themeId
        ? getTheme(cookieHeader, workspaceId, dashboard.settings.themeId)
        : null,
      // Only dashboards that show images ask for them.
      referencedImageIds(dashboard).length > 0
        ? listStudioImages(cookieHeader, workspaceId)
        : [],
    ]);
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
    <div className="dashboard-page">
      <p className="muted">
        <Link href={`/workspaces/${workspaceId}/dashboards`}>
          {t("breadcrumb")}
        </Link>{" "}
        /
      </p>
      <DashboardView
        workspaceId={workspaceId}
        dashboard={dashboard}
        theme={resolveDashboardTheme(
          dashboard.settings,
          customTheme?.theme ?? null,
        )}
        timeZone={workspaceResult?.workspace.timeZone ?? "UTC"}
        images={images}
        metrics={metrics}
        connections={byId}
        canEdit={can(membership.role, "dashboards:update")}
        canDuplicate={can(membership.role, "dashboards:create")}
        canDelete={can(membership.role, "dashboards:delete")}
      />
    </div>
  );
}
