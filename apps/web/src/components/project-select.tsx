"use client";

import { useId } from "react";

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
