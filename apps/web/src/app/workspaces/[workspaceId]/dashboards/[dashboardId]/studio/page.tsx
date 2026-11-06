import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { can } from "@netrics/domain";

import { StudioEditor } from "@/components/studio-editor/studio-editor";
import {
  getCurrencyConversion,
  getDashboard,
  getWorkspace,
  listConnections,
  listDashboards,
  listDevices,
  listGoals,
  listImages,
  listProjects,
  listThemes,
  listWorkspaceMetrics,
  listWorkspaces,
} from "@/lib/api";
import { getT } from "@/lib/i18n/server";
import { requireSession } from "@/lib/session";
import type { StudioConnection } from "@/lib/studio-widgets";

import "@/app/styles/studio.css";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("studio.editor");
  return { title: t("pageTitle") };
}

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
    conversion,
    { goals },
  ] = await Promise.all([
    listWorkspaceMetrics(cookieHeader, workspaceId),
    listConnections(cookieHeader, workspaceId),
    getWorkspace(cookieHeader, workspaceId),
    listThemes(cookieHeader, workspaceId),
    listImages(cookieHeader, workspaceId),
    listProjects(cookieHeader, workspaceId),
    listDashboards(cookieHeader, workspaceId),
    canManageDevices ? listDevices(cookieHeader, workspaceId) : null,
    getCurrencyConversion(cookieHeader, workspaceId),
    listGoals(cookieHeader, workspaceId),
  ]);
  const byId: Record<string, StudioConnection> = Object.fromEntries(
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
        currency={{
          displayCurrency: workspaceResult?.workspace.displayCurrency ?? null,
          convertible: conversion.enabled ? conversion.currencies : [],
        }}
        goals={goals}
        canCreateGoals={can(role, "dashboards:create")}
        dashboardNames={Object.fromEntries(
          dashboards.map((dashboard) => [dashboard.id, dashboard.name]),
        )}
      />
    </div>
  );
}
