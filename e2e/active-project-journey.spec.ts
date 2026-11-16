import { expect, test, type Page } from "@playwright/test";
import type { SemanticModelDefinition } from "@netrics/domain";
import { salesEu } from "./fixtures/journey.ts";
import { labels, type Locale } from "./support/labels.ts";
import { ORIGIN } from "./support/origin.ts";
import { seedReferenceTable, startWorkspace } from "./support/session.ts";
import { shellDe } from "../apps/web/src/messages/shell/de.ts";
import { shellEn } from "../apps/web/src/messages/shell/en.ts";

/**
 * The active project (#641): picking one in the sidebar refreshes the
 * page's lists at once, and archiving it ends it as the active project;
 * un-archiving leaves the user on "All projects".
 */
test("switching projects refreshes the page; un-archiving does not switch back", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = labels(locale);
  const shell = (locale === "de" ? shellDe : shellEn).shell;

  const { workspaceId } = await startWorkspace(page, locale);
  const datasetId = await seedReferenceTable(page, workspaceId, salesEu);
  const projectId = await post<{ project: { id: string } }>(
    page,
    `/v1/workspaces/${workspaceId}/projects`,
    { name: "Marketing" },
  ).then((body) => body.project.id);
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
  await post(page, `/v1/workspaces/${workspaceId}/data/models`, {
    name: "In Marketing",
    definition,
    projectId,
  });
  await post(page, `/v1/workspaces/${workspaceId}/data/models`, {
    name: "Unassigned",
    definition,
  });

  await page.goto(`/workspaces/${workspaceId}/data`);
  const tabs = page.getByRole("navigation", { name: t.title });
  const models = tabs.getByRole("button", { name: new RegExp(t.models) });
  await expect(models).toContainText("2");
  await models.click();
  await expect(page.getByText("Unassigned", { exact: true })).toBeVisible();

  // 1. Picking the project in the sidebar narrows the lists, no reload.
  const switcher = page
    .locator("#shell-sidebar")
    .getByLabel(shell.projectSwitcher, { exact: true });
  let reloads = 0;
  page.on("load", () => (reloads += 1));
  await switcher.selectOption({ label: "Marketing" });
  await expect(models).toContainText("1");
  await expect(page.getByText("Unassigned", { exact: true })).toHaveCount(0);
  // 2. And back to All.
  await switcher.selectOption({ label: shell.allProjects });
  await expect(models).toContainText("2");
  expect(reloads).toBe(0);

  // 3. Archived while active: back on All, and it stays so after
  // un-archiving.
  await switcher.selectOption({ label: "Marketing" });
  await expect(models).toContainText("1");
  await post(
    page,
    `/v1/workspaces/${workspaceId}/projects/${projectId}/archive`,
  );
  await post(
    page,
    `/v1/workspaces/${workspaceId}/projects/${projectId}/unarchive`,
  );
  await page.reload();
  await expect(switcher).toHaveValue("");
  await expect(models).toContainText("2");
});

async function post<T = unknown>(
  page: Page,
  path: string,
  data?: unknown,
): Promise<T> {
  const response = await page.request.post(path, {
    headers: { origin: ORIGIN },
    ...(data === undefined ? {} : { data }),
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as T;
}
