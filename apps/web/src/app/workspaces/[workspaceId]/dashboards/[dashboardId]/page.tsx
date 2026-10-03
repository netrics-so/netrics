import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import {
  getCurrencyConversion,
  getDashboard,
  getWorkspace,
  listConnections,
  listWorkspaceMetrics,
  listWorkspaces,
} from "@/lib/api";
import { requireSession } from "@/lib/session";

import { DashboardView } from "./dashboard-view";
import type { TileConnection } from "./metric-tile";

export const dynamic = "force-dynamic";

interface DashboardPageProps {
  params: Promise<{ workspaceId: string; dashboardId: string }>;
}

export default async function DashboardPage({ params }: DashboardPageProps) {
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
  const [{ metrics }, { connections }, workspaceResult, conversion] =
    await Promise.all([
      listWorkspaceMetrics(cookieHeader, workspaceId),
      listConnections(cookieHeader, workspaceId),
      getWorkspace(cookieHeader, workspaceId),
      getCurrencyConversion(cookieHeader, workspaceId),
    ]);
  const byId: Record<string, TileConnection> = Object.fromEntries(
    connections.map((connection) => [
      connection.id,
      { name: connection.name, state: connection.state },
    ]),
  );

  return (
    <div className="dashboard-page">
      <p className="muted">
        <Link href={`/workspaces/${workspaceId}`}>{membership.name}</Link> /
        Dashboards
      </p>
      <DashboardView
        workspaceId={workspaceId}
        dashboard={dashboardResult.dashboard}
        metrics={metrics}
        connections={byId}
        currency={{
          displayCurrency: workspaceResult?.workspace.displayCurrency ?? null,
          convertible: conversion.enabled ? conversion.currencies : [],
        }}
        canEdit={can(membership.role, "dashboards:update")}
        canDuplicate={can(membership.role, "dashboards:create")}
        canDelete={can(membership.role, "dashboards:delete")}
      />
    </div>
  );
}
