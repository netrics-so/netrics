"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { apiErrorMessage, archiveProject, unarchiveProject } from "@/lib/api";
import { useLocale, useT } from "@/lib/i18n/client";

/**
 * The workspace's projects (#573): active ones with Archive, archived ones
 * in their own list with Unarchive. Archiving hides a project and its
 * items from lists and pickers; screens keep showing their dashboards.
 */
export function ProjectList({
  workspaceId,
  projects,
  canArchive,
}: {
  workspaceId: string;
  projects: ReadonlyArray<{
    id: string;
    name: string;
    archivedAt: string | null;
  }>;
  /** Owners, admins and editors (projects:rename). */
  canArchive: boolean;
}) {
  const t = useT("dashboardsPage.projects");
  const locale = useLocale();
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = projects.filter((project) => project.archivedAt === null);
  const archived = projects.filter((project) => project.archivedAt !== null);

  async function toggle(projectId: string, archive: boolean) {
    setPending(projectId);
    setError(null);
    try {
      await (archive ? archiveProject : unarchiveProject)(
        workspaceId,
        projectId,
      );
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(null);
    }
  }

  const row = (
    project: (typeof projects)[number],
    archive: boolean,
  ): ReactNode => (
    <li key={project.id} className="dashboards-project">
      <span className="dashboards-project-name">{project.name}</span>
      {canArchive ? (
        <button
          type="button"
          className="link-button"
          disabled={pending !== null}
          aria-label={t(archive ? "archiveNamed" : "unarchiveNamed", {
            name: project.name,
          })}
          onClick={() => void toggle(project.id, archive)}
        >
          {t(archive ? "archive" : "unarchive")}
        </button>
      ) : null}
    </li>
  );

  return (
    <>
      {active.length > 0 ? (
        <ul className="dashboards-project-list">
          {active.map((project) => row(project, true))}
        </ul>
      ) : null}
      {archived.length > 0 ? (
        <>
          <h3 className="section-label" id="dashboards-archived-projects">
            {t("archived")}
          </h3>
          <ul
            className="dashboards-project-list dashboards-project-list--archived"
            aria-labelledby="dashboards-archived-projects"
          >
            {archived.map((project) => row(project, false))}
          </ul>
        </>
      ) : null}
      {canArchive ? <p className="muted">{t("archiveHint")}</p> : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
