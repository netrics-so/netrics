import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import { CreateDashboardForm } from "../create-dashboard-form";
import { CreateProjectForm } from "../create-project-form";
import { listDashboards, listProjects, listWorkspaces } from "@/lib/api";
import { getLocale, getT } from "@/lib/i18n/server";
import { relativeTime } from "@/lib/relative-time";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("workspace.pages");
  return { title: `${t("dashboards")} · netrics` };
}

interface DashboardsPageProps {
  params: Promise<{ workspaceId: string }>;
}

/** All dashboards of the workspace, a new one, and projects (#302). */
export default async function DashboardsPage({ params }: DashboardsPageProps) {
  const { workspaceId } = await params;
  const { cookieHeader } = await requireSession();
  const locale = await getLocale();
  const t = await getT("workspace");

  const { workspaces } = await listWorkspaces(cookieHeader);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!membership) {
    notFound();
  }
  const role = membership.role;
  const [{ dashboards }, { projects }] = await Promise.all([
    listDashboards(cookieHeader, workspaceId),
    listProjects(cookieHeader, workspaceId),
  ]);

  return (
    <div className="area-page dashboards-page">
      <header className="page-header">
        <div>
          <h1>{t("pages.dashboards")}</h1>
          <p className="page-meta">
            {t("dashboardCount", { count: dashboards.length })}
          </p>
        </div>
      </header>

      <div className="card">
        <h2>{t("dashboards")}</h2>
        {dashboards.length === 0 ? (
          <p className="muted">{t("noDashboards")}</p>
        ) : (
          <ul className="workspace-list">
            {dashboards.map((dashboard) => (
              <li key={dashboard.id}>
                <Link
                  href={`/workspaces/${workspaceId}/dashboards/${dashboard.id}`}
                >
                  {dashboard.name}
                </Link>{" "}
                <span className="muted">
                  {t("dashboardMeta", {
                    slides: dashboard.slideCount,
                    widgets: dashboard.widgetCount,
                    updated: relativeTime(dashboard.updatedAt, locale),
                  })}
                </span>
                {can(role, "dashboards:update") ? (
                  <>
                    {" "}
                    <Link
                      href={`/workspaces/${workspaceId}/dashboards/${dashboard.id}/studio`}
                      className="studio-link"
                      aria-label={t("openInStudio", { name: dashboard.name })}
                    >
                      {t("studio")}
                    </Link>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {can(role, "dashboards:create") ? (
        <section id="new-dashboard" className="card">
          <CreateDashboardForm workspaceId={workspaceId} />
        </section>
      ) : null}

      <div className="card">
        <h2>{t("projects")}</h2>
        <p className="muted">{t("projectsHint")}</p>
        {projects.length === 0 ? (
          <p className="muted">{t("noProjects")}</p>
        ) : (
          <ul className="workspace-list">
            {projects.map((project) => (
              <li key={project.id}>{project.name}</li>
            ))}
          </ul>
        )}
        {can(role, "projects:create") ? (
          <CreateProjectForm workspaceId={workspaceId} />
        ) : (
          <p className="muted">{t("cannotCreateProjects")}</p>
        )}
      </div>
    </div>
  );
}
