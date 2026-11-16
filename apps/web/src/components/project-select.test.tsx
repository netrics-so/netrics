import { describe, expect, it, vi } from "vitest";

import { renderI18n } from "@/lib/i18n/test-render";

import {
  ProjectSaveStatus,
  ProjectSelect,
  assignProject,
  parseProjectChoice,
  type ProjectSaveState,
} from "./project-select";

const A = "00000000-0000-4000-8000-0000000000aa";
const B = "00000000-0000-4000-8000-0000000000bb";
const PROJECTS = [
  { id: A, name: "Alpha", archivedAt: null },
  { id: B, name: "Beta", archivedAt: "2026-11-14T00:00:00.000Z" },
];

function render(value: string | null, locale: "en" | "de" = "en") {
  return renderI18n(
    <ProjectSelect
      id="project"
      projects={PROJECTS}
      value={value}
      onChange={() => {}}
    />,
    locale,
  );
}

describe("project select (#573)", () => {
  it("hides archived projects unless one is the current value", () => {
    const html = render(A);
    expect(html).toContain('<label for="project">Project</label>');
    expect(html).toContain('<option value="">No project</option>');
    expect(html).toContain(`<option value="${A}" selected="">Alpha</option>`);
    expect(html).not.toContain("Beta");

    const current = render(B);
    expect(current).toContain(
      `<option value="${B}" selected="">Beta (Archived)</option>`,
    );
    expect(render(null)).toContain(
      '<option value="" selected="">No project</option>',
    );
  });

  it('reads "No project" as null', () => {
    expect(parseProjectChoice("")).toBeNull();
    expect(parseProjectChoice(A)).toBe(A);
  });

  it("speaks German", () => {
    const html = render(B, "de");
    expect(html).toContain(">Projekt</label>");
    expect(html).toContain(">Kein Projekt</option>");
    expect(html).toContain(">Beta (Archiviert)</option>");
  });
});

describe("project assignment says when it is saved (#640)", () => {
  it("reports saving, then the project it saved to", async () => {
    const states: ProjectSaveState[] = [];
    const save = vi.fn(async () => {});
    const saved = await assignProject(
      A,
      save,
      () => "x",
      (state) => states.push(state),
    );
    expect(saved).toBe(true);
    expect(save).toHaveBeenCalledWith(A);
    expect(states).toEqual([
      { state: "saving" },
      { state: "saved", projectId: A },
    ]);
  });

  it("reports a failure with its message", async () => {
    const states: ProjectSaveState[] = [];
    const saved = await assignProject(
      null,
      () => Promise.reject(new Error("nope")),
      (cause) => `failed: ${(cause as Error).message}`,
      (state) => states.push(state),
    );
    expect(saved).toBe(false);
    expect(states.at(-1)).toEqual({ state: "failed", message: "failed: nope" });
  });

  it("shows the status line in English and German", () => {
    const line = (status: ProjectSaveState, locale: "en" | "de" = "en") =>
      renderI18n(
        <ProjectSaveStatus status={status} projects={PROJECTS} />,
        locale,
      );
    expect(line({ state: "idle" })).toBe("");
    expect(line({ state: "saving" })).toContain('role="status">Saving…</p>');
    expect(line({ state: "saved", projectId: A })).toContain(
      'role="status">Saved to Alpha</p>',
    );
    expect(line({ state: "saved", projectId: null })).toContain(
      "Saved: no project",
    );
    expect(line({ state: "failed", message: "Try again" })).toContain(
      '<p class="error" role="alert">Try again</p>',
    );
    expect(line({ state: "saved", projectId: A }, "de")).toContain(
      "In Alpha gespeichert",
    );
  });
});
