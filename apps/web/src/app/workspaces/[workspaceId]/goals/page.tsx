import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import "@/app/styles/goals.css";
import {
  getCurrencyConversion,
  getWorkspace,
  listGoals,
  listWorkspaceMetrics,
  listWorkspaces,
} from "@/lib/api";
import { getT } from "@/lib/i18n/server";
import { requireSession } from "@/lib/session";

import { GoalsView } from "./goals-view";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("goals");
  return { title: t("metaTitle") };
}

interface GoalsPageProps {
  params: Promise<{ workspaceId: string }>;
}

/**
 * The workspace's goals (ADR 0019 section 4, #335) with their progress in
 * the current period. Viewers read; editors create and edit; owners and
 * admins delete.
 */
export default async function GoalsPage({ params }: GoalsPageProps) {
  const { workspaceId } = await params;
  const { cookieHeader } = await requireSession();
  const { workspaces } = await listWorkspaces(cookieHeader);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!membership || !can(membership.role, "dashboards:view")) {
    notFound();
  }
  const role = membership.role;
  const [{ goals }, { metrics }, workspace, conversion] = await Promise.all([
    listGoals(cookieHeader, workspaceId),
    listWorkspaceMetrics(cookieHeader, workspaceId),
    getWorkspace(cookieHeader, workspaceId),
    getCurrencyConversion(cookieHeader, workspaceId),
  ]);

  return (
    <div className="area-page goals-page">
      <GoalsView
        workspaceId={workspaceId}
        goals={goals}
        metrics={metrics}
        timeZone={workspace?.workspace.timeZone ?? "UTC"}
        currency={{
          displayCurrency: workspace?.workspace.displayCurrency ?? null,
          convertible: conversion.enabled ? conversion.currencies : [],
        }}
        canCreate={can(role, "dashboards:create")}
        canEdit={can(role, "dashboards:update")}
        canDelete={can(role, "dashboards:delete")}
      />
    </div>
  );
}
