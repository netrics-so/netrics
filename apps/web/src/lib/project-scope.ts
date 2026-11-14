import type { ProjectFilterQuery } from "@netrics/contracts";

/**
 * Which items a page lists and a picker offers (#573): the user's stored
 * active project (`memberships.active_project_id`, null = "All projects"),
 * and the archived projects, whose items are hidden from both.
 */
export interface ProjectScope {
  active: string | null;
  archived: ReadonlySet<string>;
}

export function projectScope(
  activeProjectId: string | null,
  projects: ReadonlyArray<{ id: string; archivedAt: string | null }>,
): ProjectScope {
  const archived = new Set(
    projects.flatMap((project) =>
      project.archivedAt === null ? [] : [project.id],
    ),
  );
  // The server already reads an archived active project back as null;
  // a list loaded a moment later says the same.
  const active =
    activeProjectId !== null && !archived.has(activeProjectId)
      ? activeProjectId
      : null;
  return { active, archived };
}

/** Lists in navigation: the active project only, or everything not archived. */
export function navigationQuery(scope: ProjectScope): ProjectFilterQuery {
  return { project: scope.active ?? "all" };
}

/** Pickers: the active project plus unassigned items, never archived projects. */
export function pickerQuery(scope: ProjectScope): ProjectFilterQuery {
  return scope.active
    ? { project: scope.active, unassigned: "include" }
    : { project: "all" };
}

/**
 * Client-side twin of pickerQuery for lists that carry projectId; `keep`
 * stays visible (the current value).
 */
export function inPickerScope(
  projectId: string | null,
  scope: ProjectScope,
  keep = false,
): boolean {
  if (keep || projectId === null) return true;
  if (scope.archived.has(projectId)) return false;
  return scope.active === null || projectId === scope.active;
}

/** Project choices for a select: not archived, plus the current one if archived. */
export function projectChoices<
  T extends { id: string; archivedAt: string | null },
>(projects: readonly T[], current: string | null): T[] {
  return projects.filter(
    (project) => project.archivedAt === null || project.id === current,
  );
}

/** The active project's name for page headers; null under "All projects". */
export function activeProjectName(
  scope: ProjectScope,
  projects: ReadonlyArray<{ id: string; name: string }>,
): string | null {
  if (scope.active === null) return null;
  return projects.find((project) => project.id === scope.active)?.name ?? null;
}

/** "?project=…&unassigned=include", or "" for the full list. */
export function projectQueryString(query: ProjectFilterQuery | undefined) {
  const params = new URLSearchParams();
  if (query?.project) params.set("project", query.project);
  if (query?.unassigned) params.set("unassigned", query.unassigned);
  const text = params.toString();
  return text ? `?${text}` : "";
}
