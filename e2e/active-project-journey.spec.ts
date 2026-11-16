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

  // 3. An unsaved edit survives a switch: the editor keeps its draft while
  // the lists follow the project.
  await page.getByText("Unassigned", { exact: true }).click();
  const name = page.getByLabel(t.modelName, { exact: true });
  await name.fill("Unassigned EDITED");
  await switcher.selectOption({ label: "Marketing" });
  await expect(models).toContainText("1");
  await expect(name).toHaveValue("Unassigned EDITED");
  await switcher.selectOption({ label: shell.allProjects });
  await expect(models).toContainText("2");
  await expect(name).toHaveValue("Unassigned EDITED");

  // 4. Switched elsewhere (another tab): the page follows on its next
  // router refresh, as any save on the page triggers one.
  await page.goto(`/workspaces/${workspaceId}/data`);
  await expect(models).toContainText("2");
  const other = await page.context().newPage();
  await other.goto(`/workspaces/${workspaceId}/data`);
  await other
    .locator("#shell-sidebar")
    .getByLabel(shell.projectSwitcher, { exact: true })
    .selectOption({ label: "Marketing" });
  await expect(
    other
      .getByRole("navigation", { name: t.title })
      .getByRole("button", { name: new RegExp(t.models) }),
  ).toContainText("1");
  await other.close();
  await routerRefresh(page);
  await expect(switcher).toHaveValue(projectId);
  await expect(models).toContainText("1");

  // 5. Archived while active: back on All, and it stays so after
  // un-archiving.
  await post(
    page,
    `/v1/workspaces/${workspaceId}/projects/${projectId}/archive`,
  );
  await routerRefresh(page);
  // On All now (the switcher goes: no project left to pick); the archived
  // project's model is hidden, the other stays.
  await expect(switcher).toHaveCount(0);
  await expect(models).toContainText("1");
  await post(
    page,
    `/v1/workspaces/${workspaceId}/projects/${projectId}/unarchive`,
  );
  await page.reload();
  await expect(switcher).toHaveValue("");
  await expect(models).toContainText("2");
});

/** The app router's refresh, as router.refresh() after a save runs it. */
async function routerRefresh(page: Page) {
  await page.evaluate(() =>
    (
      window as unknown as { next: { router: { refresh: () => void } } }
    ).next.router.refresh(),
  );
}

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
