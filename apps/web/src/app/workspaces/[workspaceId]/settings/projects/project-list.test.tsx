import { describe, expect, it, vi } from "vitest";

import { webTranslator } from "@/lib/i18n/catalogs";
import { renderI18n } from "@/lib/i18n/test-render";

import { projectName } from "../../create-project-form";
import { ProjectList } from "./project-list";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

const W = "00000000-0000-4000-8000-000000000001";
const A = "00000000-0000-4000-8000-0000000000aa";
const B = "00000000-0000-4000-8000-0000000000bb";
const PROJECTS = [
  { id: A, name: "Marketing", archivedAt: null },
  { id: B, name: "Launch", archivedAt: "2026-11-14T00:00:00.000Z" },
];

describe("projects page (#640)", () => {
  it("lists active projects with Rename and Archive, archived ones with Unarchive", () => {
    const html = renderI18n(
      <ProjectList workspaceId={W} projects={PROJECTS} canEdit />,
    );
    expect(html).toContain('aria-label="Rename Marketing"');
    expect(html).toContain('aria-label="Archive Marketing"');
    expect(html).toContain('aria-label="Unarchive Launch"');
    expect(html).not.toContain('aria-label="Rename Launch"');
    expect(html).toContain('id="projects-archived">Archived</h2>');
  });

  it("is read-only for roles that cannot change projects", () => {
    const html = renderI18n(
      <ProjectList workspaceId={W} projects={PROJECTS} canEdit={false} />,
    );
    expect(html).toContain("Marketing");
    expect(html).not.toContain("<button");
  });

  it("speaks German", () => {
    const html = renderI18n(
      <ProjectList workspaceId={W} projects={PROJECTS} canEdit />,
      "de",
    );
    expect(html).toContain('aria-label="Marketing umbenennen"');
    expect(html).toContain('aria-label="Launch aus dem Archiv holen"');
  });

  it("counts archived projects on the Dashboards page", () => {
    const en = webTranslator("en", "dashboardsPage.projects");
    const de = webTranslator("de", "dashboardsPage.projects");
    expect(en("overview", { active: 0, archived: 1 })).toBe(
      "Projects: none active · 1 archived.",
    );
    expect(en("overview", { active: 2, archived: 0 })).toBe(
      "Projects: 2 active.",
    );
    expect(de("overview", { active: 0, archived: 1 })).toBe(
      "Projekte: keine aktiven · 1 archiviert.",
    );
  });

  it("trims names and catches whitespace-only ones", () => {
    expect(projectName("  Marketing  ")).toBe("Marketing");
    expect(projectName("   ")).toBeNull();
    expect(projectName("")).toBeNull();
    const en = webTranslator("en", "projectsPage");
    const de = webTranslator("de", "projectsPage");
    expect(en("nameRequired")).toBe("Enter a name for the project.");
    expect(de("nameRequired")).toBe("Gib dem Projekt einen Namen.");
    expect(en("renamedDone", { name: projectName(" Launch ")! })).toBe(
      "Renamed to Launch.",
    );
    expect(en("createdDone", { name: "Launch" })).toBe("Launch is created.");
    expect(de("createdDone", { name: "Launch" })).toBe("Launch ist angelegt.");
  });
});
