import { expect, test } from "@playwright/test";
import type { SemanticModelDefinition } from "@netrics/domain";
import { salesEu } from "./fixtures/journey.ts";
import { createModel } from "./support/api.ts";
import { fill, projectLabels, type Locale } from "./support/labels.ts";
import { ORIGIN } from "./support/origin.ts";
import { seedReferenceTable, startWorkspace } from "./support/session.ts";

/**
 * Projects are managed from an obvious place, and moving an item into one
 * says so (#640): Settings and the sidebar's project switcher lead to the
 * projects page; the Dashboards page counts archived projects and says
 * what they hide; the project select of a data item shows "Saved to …".
 */
test("projects are easy to find and assignments confirm", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = projectLabels(locale);
  const exact = { exact: true } as const;

  const { workspaceId } = await startWorkspace(page, locale);
  const datasetId = await seedReferenceTable(page, workspaceId, salesEu);
  const definition: SemanticModelDefinition = {
    version: 1,
    datasets: [datasetId],
    relationships: [],
    dimensions: [
      { id: "country", name: "Country", datasetId, fieldId: "country" },
    ],
    measures: [
      {
        id: "revenue",
        name: "Revenue",
        kind: "aggregate",
        datasetId,
        aggregate: {
          id: "revenue",
          name: "Revenue",
          op: "sum",
          fieldId: "revenue",
        },
      },
    ],
  };
  const modelId = await createModel(page, workspaceId, {
    name: "Sales",
    definition,
  });

  // 1. Settings lead to the projects page; a project is created there.
  await page.goto(`/workspaces/${workspaceId}/settings`);
  await page.getByRole("link", { name: t.settings.projects.manage }).click();
  await expect(
    page.getByRole("heading", { name: t.page.title, level: 1 }),
  ).toBeVisible();
  await page.getByLabel(t.workspace.newProject.label, exact).fill("Marketing");
  await page
    .getByRole("button", { name: t.workspace.newProject.create })
    .click();
  await expect(
    page.getByRole("status").filter({
      hasText: fill(t.page.createdDone, { name: "Marketing" }),
    }),
  ).toBeVisible();
  const rename = page.getByRole("button", {
    name: fill(t.page.renameNamed, { name: "Marketing" }),
  });
  await expect(rename).toBeVisible();

  // Renaming trims the name and says so; whitespace alone is refused
  // with its own message.
  const renameField = page.getByLabel(
    fill(t.page.renameLabel, { name: "Marketing" }),
  );
  await rename.click();
  await renameField.fill("   ");
  await page.getByRole("button", { name: t.page.save, ...exact }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: t.page.nameRequired }),
  ).toBeVisible();
  await renameField.fill("  Marketing  ");
  await page.getByRole("button", { name: t.page.save, ...exact }).click();
  await expect(
    page.getByRole("status").filter({
      hasText: fill(t.page.renamedDone, { name: "Marketing" }),
    }),
  ).toBeVisible();
  await expect(rename).toBeVisible();

  // 2. The sidebar's switcher links back to it.
  const sidebar = page.locator("#shell-sidebar");
  await expect(
    sidebar.getByRole("link", { name: t.shell.manageProjects }),
  ).toHaveAttribute("href", `/workspaces/${workspaceId}/settings/projects`);

  // 3. Assigning the model to the project says where it was saved.
  await page.goto(`/workspaces/${workspaceId}/data?model=${modelId}`);
  await page
    .locator(".data-editor-project")
    .getByLabel(t.dashboards.projects.project, exact)
    .selectOption({ label: "Marketing" });
  await expect(
    page.getByRole("status").filter({
      hasText: fill(t.dashboards.projects.savedTo, { name: "Marketing" }),
    }),
  ).toBeVisible();

  // 4. A dashboard in the project, then the project archived: the
  // Dashboards page counts it and says what the archive hides.
  const listed = await page.request.get(
    `/v1/workspaces/${workspaceId}/projects`,
  );
  const projectId = (
    (await listed.json()) as { projects: { id: string; name: string }[] }
  ).projects.find((project) => project.name === "Marketing")!.id;
  const created = await page.request.post(
    `/v1/workspaces/${workspaceId}/dashboards`,
    { headers: { origin: ORIGIN }, data: { name: "Launch wall", projectId } },
  );
  expect(created.status(), await created.text()).toBe(200);
  await page.goto(`/workspaces/${workspaceId}/settings/projects`);
  // Archive the active project: the confirmation stays while the page
  // refreshes onto "All projects".
  const switcher = sidebar.getByLabel(t.shell.projectSwitcher, exact);
  await switcher.selectOption({ label: "Marketing" });
  await expect(switcher).toHaveValue(projectId);
  await page
    .getByRole("button", {
      name: fill(t.page.archiveNamed, { name: "Marketing" }),
    })
    .click();
  await expect(
    page.getByRole("status").filter({
      hasText: fill(t.page.archivedDone, { name: "Marketing" }),
    }),
  ).toBeVisible();
  // The switcher goes (no project left to pick), the note stays.
  await expect(switcher).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({
      hasText: fill(t.page.archivedDone, { name: "Marketing" }),
    }),
  ).toBeVisible();

  await page.goto(`/workspaces/${workspaceId}/dashboards`);
  await expect(page.locator(".dashboards-projects")).toContainText(
    locale === "de"
      ? "Projekte: keine aktiven · 1 archiviert."
      : "Projects: none active · 1 archived.",
  );
  await expect(page.locator(".dashboards-empty")).toContainText(
    locale === "de"
      ? "1 Dashboard liegt in einem archivierten Projekt."
      : "1 dashboard is in an archived project.",
  );
  await page
    .locator(".dashboards-projects")
    .getByRole("link", { name: t.dashboards.projects.summary })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/workspaces/${workspaceId}/settings/projects$`),
  );
});
