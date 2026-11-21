import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { can } from "@netrics/domain";

import { ApproveDeviceForm, type ApprovableWorkspace } from "./approve-form";
import { listDashboards, listProjects, listWorkspaces } from "@/lib/api";
import { forwardedHeaders } from "@/lib/api-fetch";
import { getT } from "@/lib/i18n/server";
import { pickableDashboards } from "@/lib/project-pickers";
import { projectScope } from "@/lib/project-scope";
import { getSessionUser } from "@/lib/session";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("deviceApproval");
  return { title: t("pageTitle") };
}

interface ApproveDevicePageProps {
  searchParams: Promise<{
    code?: string | string[];
    workspace?: string | string[];
    dashboard?: string | string[];
  }>;
}

/**
 * Where a TV sends people to approve its pairing code (ADR 0010). The TV's
 * QR code lands here with ?code=; on the hosted service via netrics.tv/<CODE>
 * (see src/proxy.ts).
 */
export default async function ApproveDevicePage({
  searchParams,
}: ApproveDevicePageProps) {
  const params = await searchParams;
  const one = (value: string | string[] | undefined, length: number) =>
    typeof value === "string" ? value.slice(0, length) : "";
  const code = one(params.code, 20);
  // Opened from a workspace (and dashboard) via "Connect a TV" (#835).
  const wantedWorkspace = one(params.workspace, 64);
  const wantedDashboard = one(params.dashboard, 64);
  const query = new URLSearchParams({
    ...(code ? { code } : {}),
    ...(wantedWorkspace ? { workspace: wantedWorkspace } : {}),
    ...(wantedDashboard ? { dashboard: wantedDashboard } : {}),
  }).toString();
  const here = `/devices/approve${query ? `?${query}` : ""}`;

  const forwarded = forwardedHeaders(await headers());
  const user = await getSessionUser(forwarded);
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(here)}`);
  }

  const { workspaces } = await listWorkspaces(forwarded);
  const manageable = workspaces.filter((workspace) =>
    can(workspace.role, "devices:manage"),
  );
  // Each workspace offers its active project's and unassigned dashboards,
  // never those of archived projects (#573).
  const approvable: ApprovableWorkspace[] = await Promise.all(
    manageable.map(async (workspace) => {
      const [{ dashboards }, { projects }] = await Promise.all([
        listDashboards(forwarded, workspace.id),
        listProjects(forwarded, workspace.id),
      ]);
      return {
        id: workspace.id,
        name: workspace.name,
        dashboards: pickableDashboards(
          dashboards,
          projectScope(workspace.activeProjectId, projects),
          null,
        ).map((dashboard) => ({ id: dashboard.id, name: dashboard.name })),
      };
    }),
  );

  const t = await getT("deviceApproval");
  const common = await getT("common");
  return (
    <>
      <h1>{t("title")}</h1>
      <p className="subtitle">{t("subtitle")}</p>
      {approvable.length === 0 ? (
        <div className="card">
          <p>{t("notAllowed")}</p>
          <p className="muted">
            <Link href="/">{common("back")}</Link>
          </p>
        </div>
      ) : (
        <div className="card">
          <ApproveDeviceForm
            initialCode={code}
            workspaces={approvable}
            initialWorkspaceId={wantedWorkspace || undefined}
            initialDashboardId={wantedDashboard || undefined}
          />
        </div>
      )}
    </>
  );
}
