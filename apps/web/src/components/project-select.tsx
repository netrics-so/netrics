"use client";

import { useEffect, useId, useState } from "react";

import { useT } from "@/lib/i18n/client";
import { projectChoices } from "@/lib/project-scope";

/** The select's value for a project, "" for none. */
export function parseProjectChoice(value: string): string | null {
  return value === "" ? null : value;
}

/**
 * The project of a dashboard, connection, preparation or model (#573):
 * projects that are not archived, plus the current one if it is; "No
 * project" is null.
 */
export function ProjectSelect({
  projects,
  value,
  onChange,
  disabled = false,
  id,
}: {
  projects: ReadonlyArray<{
    id: string;
    name: string;
    archivedAt: string | null;
  }>;
  value: string | null;
  onChange: (projectId: string | null) => void;
  disabled?: boolean;
  /** The select's id, e.g. for a stable label target; generated otherwise. */
  id?: string;
}) {
  const t = useT("dashboardsPage.projects");
  const generated = useId();
  const selectId = id ?? generated;
  return (
    <div className="field">
      <label htmlFor={selectId}>{t("project")}</label>
      <select
        id={selectId}
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(parseProjectChoice(event.target.value))}
      >
        <option value="">{t("noProject")}</option>
        {projectChoices(projects, value).map((project) => (
          <option key={project.id} value={project.id}>
            {project.archivedAt === null
              ? project.name
              : `${project.name} (${t("archived")})`}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Where a project assignment stands (#640): it never saves silently. */
export type ProjectSaveState =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved"; projectId: string | null }
  | { state: "failed"; message: string };

/**
 * Saves a project choice and reports each step: saving, then saved (with
 * the project it landed in) or failed (with a message). Answers whether it
 * saved.
 */
export async function assignProject(
  projectId: string | null,
  save: (projectId: string | null) => Promise<unknown>,
  describeError: (cause: unknown) => string,
  report: (state: ProjectSaveState) => void,
): Promise<boolean> {
  report({ state: "saving" });
  try {
    await save(projectId);
    report({ state: "saved", projectId });
    return true;
  } catch (cause) {
    report({ state: "failed", message: describeError(cause) });
    return false;
  }
}

/** The line under a project select: "Saving…", "Saved to …" or the error. */
export function ProjectSaveStatus({
  status,
  projects,
}: {
  status: ProjectSaveState;
  projects: ReadonlyArray<{ id: string; name: string }>;
}) {
  const t = useT("dashboardsPage.projects");
  if (status.state === "idle") return null;
  if (status.state === "failed") {
    return (
      <p className="error" role="alert">
        {status.message}
      </p>
    );
  }
  const name =
    status.state === "saved" && status.projectId !== null
      ? (projects.find((project) => project.id === status.projectId)?.name ??
        null)
      : null;
  return (
    <p className="muted project-save-status" role="status">
      {status.state === "saving"
        ? t("saving")
        : name !== null
          ? t("savedTo", { name })
          : t("savedNone")}
    </p>
  );
}

/**
 * A project select that saves on change and says so (#640): "Saving…",
 * then "Saved to Marketing", or the error with the previous choice back.
 * Key it by the item, so another item starts without a status.
 */
export function ProjectAssignment({
  projects,
  value,
  onSave,
  describeError,
  disabled = false,
  id,
}: {
  projects: ReadonlyArray<{
    id: string;
    name: string;
    archivedAt: string | null;
  }>;
  value: string | null;
  /** Stores the choice; throws when it was not stored. */
  onSave: (projectId: string | null) => Promise<unknown>;
  describeError: (cause: unknown) => string;
  disabled?: boolean;
  id?: string;
}) {
  const [current, setCurrent] = useState(value);
  const [status, setStatus] = useState<ProjectSaveState>({ state: "idle" });
  useEffect(() => setCurrent(value), [value]);

  async function onChange(next: string | null) {
    const previous = current;
    setCurrent(next);
    const saved = await assignProject(next, onSave, describeError, setStatus);
    if (!saved) setCurrent(previous);
  }

  return (
    <>
      <ProjectSelect
        id={id}
        projects={projects}
        value={current}
        disabled={disabled || status.state === "saving"}
        onChange={(next) => void onChange(next)}
      />
      <ProjectSaveStatus status={status} projects={projects} />
    </>
  );
}
