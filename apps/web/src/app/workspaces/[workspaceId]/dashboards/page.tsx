import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import "@/app/styles/dashboards.css";
import { CreateProjectForm } from "../create-project-form";
import { DashboardsBrowser } from "./dashboards-browser";
import { listDashboards, listProjects, listWorkspaces } from "@/lib/api";
import { getLocale, getT } from "@/lib/i18n/server";
import { relativeTimeIn } from "@/lib/relative-time";
import { requireSession } from "@/lib/session";
import { builtinThemeName } from "@/lib/theme-name";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("workspace.pages");
  return { title: `${t("dashboards")} · netrics` };
}

interface DashboardsPageProps {
  params: Promise<{ workspaceId: string }>;
}

/**
 * All dashboards of the workspace (ADR 0018, design 3a; #304): templates,
 * cards with thumbnails, and projects as a secondary section.
 */
export default async function DashboardsPage({ params }: DashboardsPageProps) {
  const { workspaceId } = await params;
  const { cookieHeader } = await requireSession();
  const locale = await getLocale();
  const t = await getT("workspace");
  const page = await getT("dashboardsPage");

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

  const live = dashboards.filter((d) => d.screenCount > 0).length;
  const now = Date.now();
  const cards = dashboards.map((dashboard) => ({
    ...dashboard,
    updatedLabel: page("updated", {
      time: relativeTimeIn(dashboard.updatedAt, locale, now) ?? "",
    }),
    themeLabel: dashboard.theme.builtin
      ? builtinThemeName(dashboard.theme.builtin, locale)
      : dashboard.theme.name,
  }));

  return (
    <div className="area-page dashboards-page">
      <DashboardsBrowser
        workspaceId={workspaceId}
        dashboards={cards}
        projects={projects.map(({ id, name }) => ({ id, name }))}
        canCreate={can(role, "dashboards:create")}
        canEdit={can(role, "dashboards:update")}
        title={t("pages.dashboards")}
        meta={
          live > 0
            ? page("metaLive", { count: dashboards.length, live })
            : page("meta", { count: dashboards.length })
        }
      />

      <details className="dashboards-projects">
        <summary>
          <span>{page("projects.summary")}</span>
          <span className="dashboards-projects-count">
            {page("projects.count", { count: projects.length })}
          </span>
        </summary>
        <div className="dashboards-projects-body">
          <p className="muted">{t("projectsHint")}</p>
          {projects.length === 0 ? (
            <p className="muted">{t("noProjects")}</p>
          ) : (
            <ul className="dashboards-project-list">
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
      </details>
    </div>
  );
}
