import { describe, expect, it } from "vitest";

import {
  inPickerScope,
  inProject,
  navigationQuery,
  pickerQuery,
  projectChoices,
  projectQueryString,
  projectScope,
} from "./project-scope";

const A = "00000000-0000-4000-8000-0000000000aa";
const B = "00000000-0000-4000-8000-0000000000bb";
const ARCHIVED = "2026-11-14T00:00:00Z";
const projects = [
  { id: A, archivedAt: null },
  { id: B, archivedAt: null },
];
const withArchived = [
  { id: A, archivedAt: null },
  { id: B, archivedAt: ARCHIVED },
];
const scopeWithBArchived = projectScope(null, withArchived);

describe("project scope (#573)", () => {
  it("lists navigation by the active project, or everything not archived", () => {
    expect(navigationQuery(projectScope(null, projects))).toEqual({
      project: "all",
    });
    expect(navigationQuery(projectScope(A, projects))).toEqual({ project: A });
  });

  it("offers pickers the active project plus unassigned items", () => {
    expect(pickerQuery(projectScope(A, projects))).toEqual({
      project: A,
      unassigned: "include",
    });
    expect(pickerQuery(projectScope(null, projects))).toEqual({
      project: "all",
    });
  });

  it("treats an archived active project as All", () => {
    const scope = projectScope(B, withArchived);
    expect(scope.active).toBeNull();
    expect(navigationQuery(scope)).toEqual({ project: "all" });
  });

  it("decides picker scope for items that carry their project", () => {
    expect(
      inPickerScope(B, projectScope(null, [{ id: B, archivedAt: ARCHIVED }])),
    ).toBe(false);
    expect(inPickerScope(B, scopeWithBArchived, true)).toBe(true); // current value kept
    expect(inPickerScope(null, projectScope(A, projects))).toBe(true);
    expect(inPickerScope(A, projectScope(A, projects))).toBe(true);
    expect(inPickerScope(B, projectScope(A, projects))).toBe(false);
    expect(inPickerScope(B, projectScope(null, projects))).toBe(true);
  });

  it("offers projects that are not archived, plus the current one", () => {
    expect(projectChoices(withArchived, null).map((p) => p.id)).toEqual([A]);
    expect(projectChoices(withArchived, B).map((p) => p.id)).toEqual([A, B]);
    expect(projectChoices(withArchived, A).map((p) => p.id)).toEqual([A]);
  });

  it("writes the filter as a query string", () => {
    expect(projectQueryString(undefined)).toBe("");
    expect(projectQueryString({})).toBe("");
    expect(projectQueryString({ project: "all" })).toBe("?project=all");
    expect(projectQueryString({ project: A, unassigned: "include" })).toBe(
      `?project=${A}&unassigned=include`,
    );
  });

  it("starts new items in the active project (#573)", () => {
    expect(inProject({ template: "overview" }, A)).toEqual({
      template: "overview",
      projectId: A,
    });
    expect(inProject({ template: "overview" }, null)).toEqual({
      template: "overview",
    });
  });
});
