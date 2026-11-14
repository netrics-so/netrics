import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import "@/app/styles/dashboards.css";
import { CreateProjectForm } from "../create-project-form";
import { DashboardsBrowser } from "./dashboards-browser";
import { ProjectList } from "./project-list";
import { listDashboards, listProjects, listWorkspaces } from "@/lib/api";
import { getLocale, getT } from "@/lib/i18n/server";
import {
  activeProjectName,
  navigationQuery,
  projectScope,
} from "@/lib/project-scope";
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
  // The server reads an archived active project back as null ("All").
  const [{ dashboards }, { projects }] = await Promise.all([
    listDashboards(
      cookieHeader,
      workspaceId,
      navigationQuery(projectScope(membership.activeProjectId, [])),
    ),
    listProjects(cookieHeader, workspaceId),
  ]);
  const scope = projectScope(membership.activeProjectId, projects);
  const projectName = activeProjectName(scope, projects);

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
        projectId={scope.active}
        projectName={projectName}
        canCreate={can(role, "dashboards:create")}
        canEdit={can(role, "dashboards:update")}
        title={t("pages.dashboards")}
        meta={[
          live > 0
            ? page("metaLive", { count: dashboards.length, live })
            : page("meta", { count: dashboards.length }),
          ...(projectName
            ? [page("activeProjectMeta", { project: projectName })]
            : []),
        ].join(" · ")}
      />

      <details className="dashboards-projects">
        <summary>
          <span>{page("projects.summary")}</span>
          <span className="dashboards-projects-count">
            {page("projects.count", {
              count: projects.filter((project) => project.archivedAt === null)
                .length,
            })}
          </span>
        </summary>
        <div className="dashboards-projects-body">
          <p className="muted">{t("projectsHint")}</p>
          {projects.length === 0 ? (
            <p className="muted">{t("noProjects")}</p>
          ) : (
            <ProjectList
              workspaceId={workspaceId}
              projects={projects.map(({ id, name, archivedAt }) => ({
                id,
                name,
                archivedAt,
              }))}
              canArchive={can(role, "projects:rename")}
            />
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
