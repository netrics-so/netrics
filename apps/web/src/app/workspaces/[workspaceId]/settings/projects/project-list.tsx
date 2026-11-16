"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";

import {
  apiErrorMessage,
  archiveProject,
  renameProject,
  unarchiveProject,
} from "@/lib/api";
import { useLocale, useT } from "@/lib/i18n/client";

type ProjectRow = { id: string; name: string; archivedAt: string | null };

/**
 * The workspace's projects (#573, #640): active ones with Rename and
 * Archive, archived ones in their own list with Unarchive. Archiving hides
 * a project and its items from lists and pickers; screens keep showing
 * their dashboards. Every change says when it is done.
 */
export function ProjectList({
  workspaceId,
  projects,
  canEdit,
}: {
  workspaceId: string;
  projects: readonly ProjectRow[];
  /** Owners, admins and editors (projects:rename). */
  canEdit: boolean;
}) {
  const t = useT("projectsPage");
  const locale = useLocale();
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const active = projects.filter((project) => project.archivedAt === null);
  const archived = projects.filter((project) => project.archivedAt !== null);

  async function run(projectId: string, change: () => Promise<string>) {
    setPending(projectId);
    setError(null);
    setDone(null);
    try {
      setDone(await change());
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(null);
    }
  }

  const toggle = (project: ProjectRow, archive: boolean) =>
    run(project.id, async () => {
      await (archive ? archiveProject : unarchiveProject)(
        workspaceId,
        project.id,
      );
      return t(archive ? "archivedDone" : "unarchivedDone", {
        name: project.name,
      });
    });

  function onRename(event: FormEvent<HTMLFormElement>, project: ProjectRow) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "");
    void run(project.id, async () => {
      await renameProject(workspaceId, project.id, name);
      setRenaming(null);
      return t("renamedDone", { name });
    });
  }

  const row = (project: ProjectRow, archive: boolean): ReactNode => (
    <li key={project.id} className="projects-row">
      {renaming === project.id ? (
        <form className="inline" onSubmit={(event) => onRename(event, project)}>
          <div className="field">
            <label htmlFor={`rename-${project.id}`}>
              {t("renameLabel", { name: project.name })}
            </label>
            <input
              id={`rename-${project.id}`}
              name="name"
              type="text"
              required
              maxLength={100}
              defaultValue={project.name}
              disabled={pending !== null}
              autoFocus
            />
          </div>
          <button type="submit" disabled={pending !== null}>
            {t("save")}
          </button>
          <button
            type="button"
            className="link-button"
            onClick={() => setRenaming(null)}
          >
            {t("cancel")}
          </button>
        </form>
      ) : (
        <>
          <span className="projects-row-name">{project.name}</span>
          {canEdit ? (
            <span className="projects-row-actions">
              {archive ? (
                <button
                  type="button"
                  className="link-button"
                  disabled={pending !== null}
                  aria-label={t("renameNamed", { name: project.name })}
                  onClick={() => setRenaming(project.id)}
                >
                  {t("rename")}
                </button>
              ) : null}
              <button
                type="button"
                className="link-button"
                disabled={pending !== null}
                aria-label={t(archive ? "archiveNamed" : "unarchiveNamed", {
                  name: project.name,
                })}
                onClick={() => void toggle(project, archive)}
              >
                {t(archive ? "archive" : "unarchive")}
              </button>
            </span>
          ) : null}
        </>
      )}
    </li>
  );

  return (
    <>
      {active.length > 0 ? (
        <ul className="projects-list" aria-label={t("active")}>
          {active.map((project) => row(project, true))}
        </ul>
      ) : (
        <p className="muted">{t("noneActive")}</p>
      )}
      {archived.length > 0 ? (
        <>
          <h2 className="section-label" id="projects-archived">
            {t("archived")}
          </h2>
          <ul
            className="projects-list projects-list--archived"
            aria-labelledby="projects-archived"
          >
            {archived.map((project) => row(project, false))}
          </ul>
        </>
      ) : null}
      {done ? (
        <p className="notice" role="status">
          {done}
        </p>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
