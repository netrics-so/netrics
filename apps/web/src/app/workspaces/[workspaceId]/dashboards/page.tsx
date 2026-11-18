import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import "@/app/styles/dashboards.css";
import Link from "next/link";

import { ViewerHint } from "../viewer-hint";
import { DashboardsBrowser } from "./dashboards-browser";
import {
  listDashboards,
  listProjects,
  listStoreTemplateInstalls,
  listWorkspaces,
} from "@/lib/api";
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
  const { forwarded } = await requireSession();
  const locale = await getLocale();
  const t = await getT("workspace");
  const page = await getT("dashboardsPage");

  const { workspaces } = await listWorkspaces(forwarded);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!membership) {
    notFound();
  }
  const role = membership.role;
  // The server reads an archived active project back as null ("All").
  // Archived originals (11E) come along for their own section.
  const [{ dashboards: listed }, { projects }, storeInstalls] =
    await Promise.all([
      listDashboards(forwarded, workspaceId, {
        ...navigationQuery(projectScope(membership.activeProjectId, [])),
        archived: "include",
      }),
      listProjects(forwarded, workspaceId),
      // Updates are an extra: the page works without them.
      listStoreTemplateInstalls(forwarded, workspaceId).then(
        ({ installs }) => installs,
        () => [],
      ),
    ]);
  const dashboards = listed.filter((d) => d.archivedAt === null);
  const scope = projectScope(membership.activeProjectId, projects);
  const projectName = activeProjectName(scope, projects);
  // Under "All projects", an empty page says what archived projects hide
  // (#640) instead of suggesting there is nothing.
  const hiddenInArchived =
    dashboards.length === 0 && scope.active === null && scope.archived.size > 0
      ? (await listDashboards(forwarded, workspaceId)).dashboards.filter(
          (d) =>
            d.archivedAt === null &&
            d.projectId !== null &&
            scope.archived.has(d.projectId),
        ).length
      : 0;
  const activeProjects = projects.filter((p) => p.archivedAt === null).length;

  const live = dashboards.filter((d) => d.screenCount > 0).length;
  const now = Date.now();
  const card = (dashboard: (typeof listed)[number]) => ({
    ...dashboard,
    updatedLabel: page("updated", {
      time: relativeTimeIn(dashboard.updatedAt, locale, now) ?? "",
    }),
    themeLabel: dashboard.theme.builtin
      ? builtinThemeName(dashboard.theme.builtin, locale)
      : dashboard.theme.name,
  });
  const cards = dashboards.map(card);
  const archived = listed.filter((d) => d.archivedAt !== null).map(card);

  return (
    <div className="area-page dashboards-page">
      <DashboardsBrowser
        workspaceId={workspaceId}
        dashboards={cards}
        archived={archived}
        storeInstalls={storeInstalls}
        projectId={scope.active}
        projectName={projectName}
        hiddenInArchived={hiddenInArchived}
        canCreate={can(role, "dashboards:create")}
        canEdit={can(role, "dashboards:update")}
        readOnlyNote={<ViewerHint role={role} workspaceId={workspaceId} />}
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

      <p className="dashboards-projects">
        <span>
          {page("projects.overview", {
            active: activeProjects,
            archived: projects.length - activeProjects,
          })}
        </span>{" "}
        <Link href={`/workspaces/${workspaceId}/settings/projects`}>
          {page("projects.summary")}
        </Link>
      </p>
    </div>
  );
}
