import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import { CreateProjectForm } from "../../create-project-form";
import { ProjectList } from "./project-list";
import { listProjects, listWorkspaces } from "@/lib/api";
import { getT } from "@/lib/i18n/server";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

interface ProjectsPageProps {
  params: Promise<{ workspaceId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("projectsPage");
  return { title: t("metaTitle") };
}

/**
 * The workspace's projects in one place (#640): create, rename, archive
 * and unarchive. Linked from Settings, the sidebar's project switcher and
 * the Dashboards page.
 */
export default async function ProjectsPage({ params }: ProjectsPageProps) {
  const { workspaceId } = await params;
  const { cookieHeader } = await requireSession();
  const { workspaces } = await listWorkspaces(cookieHeader);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!membership) {
    notFound();
  }
  const role = membership.role;
  const [{ projects }, t] = await Promise.all([
    listProjects(cookieHeader, workspaceId),
    getT("projectsPage"),
  ]);
  const canEdit = can(role, "projects:rename");

  return (
    <div className="area-page projects-page">
      <header className="page-header">
        <div>
          <h1>{t("title")}</h1>
          <p className="page-meta">
            {t("meta", {
              active: projects.filter((p) => p.archivedAt === null).length,
              archived: projects.filter((p) => p.archivedAt !== null).length,
            })}
          </p>
        </div>
      </header>
      <p className="muted">
        <Link href={`/workspaces/${workspaceId}/settings`}>
          {t("backToSettings")}
        </Link>
      </p>
      <div className="card">
        <p className="muted">{t("hint")}</p>
        <ProjectList
          workspaceId={workspaceId}
          projects={projects.map(({ id, name, archivedAt }) => ({
            id,
            name,
            archivedAt,
          }))}
          canEdit={canEdit}
        />
        {canEdit ? <p className="muted">{t("archiveHint")}</p> : null}
      </div>
      <div className="card">
        <h2>{t("create")}</h2>
        {can(role, "projects:create") ? (
          <CreateProjectForm workspaceId={workspaceId} />
        ) : (
          <p className="muted">{t("cannotCreate")}</p>
        )}
      </div>
    </div>
  );
}
