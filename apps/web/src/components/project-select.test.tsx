import { describe, expect, it } from "vitest";

import { renderI18n } from "@/lib/i18n/test-render";

import { ProjectSelect, parseProjectChoice } from "./project-select";

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
