import { expect, test } from "@playwright/test";
import { salesEu } from "./fixtures/journey.ts";
import { labels, type Locale } from "./support/labels.ts";
import { ORIGIN } from "./support/origin.ts";
import { seedReferenceTable, startWorkspace } from "./support/session.ts";

/**
 * Reference tables are workspace-wide (#644): inside a project the Data
 * page still lists them, marked as shared by all projects, so a project's
 * preparations can start from them.
 */
test("reference tables stay visible inside a project", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = labels(locale);
  const { workspaceId } = await startWorkspace(page, locale);
  await seedReferenceTable(page, workspaceId, salesEu);
  const created = await page.request.post(
    `/v1/workspaces/${workspaceId}/projects`,
    { headers: { origin: ORIGIN }, data: { name: "Launch" } },
  );
  expect(created.status(), await created.text()).toBe(200);
  const projectId = ((await created.json()) as { project: { id: string } })
    .project.id;
  const active = await page.request.patch(
    `/v1/workspaces/${workspaceId}/active-project`,
    { headers: { origin: ORIGIN }, data: { projectId } },
  );
  expect(active.status(), await active.text()).toBe(200);

  await page.goto(`/workspaces/${workspaceId}/data`);
  const tabs = page.getByRole("navigation", { name: t.title });
  await expect(
    tabs.getByRole("button", { name: new RegExp(t.datasets) }),
  ).toContainText("1");
  const row = page.getByRole("button", { name: new RegExp(salesEu.name) });
  await expect(row).toContainText(`${t.manual} · ${t.allProjects}`);

  // A new preparation in the project can read it.
  await page
    .getByRole("navigation", { name: t.title })
    .getByRole("button", { name: new RegExp(t.preparations) })
    .click();
  await page.getByRole("button", { name: t.newPreparation }).click();
  await expect(
    page.locator("select option", { hasText: salesEu.name }).first(),
  ).toBeAttached();
});
