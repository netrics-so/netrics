import { expect, test } from "@playwright/test";
import { dashboardsDe } from "../apps/web/src/messages/dashboards/de.ts";
import { dashboardsEn } from "../apps/web/src/messages/dashboards/en.ts";
import { fill, labels, type Locale } from "./support/labels.ts";
import { startWorkspace } from "./support/session.ts";
import { installWithUpdate } from "./support/store-template.ts";

/** One branch of a `{count, plural, …}` message, e.g. `=0`. */
const pluralBranch = (message: string, branch: string) =>
  new RegExp(`${branch} \\{([^}]*)\\}`).exec(message)![1]!;

const updateLabels = (locale: Locale) =>
  (locale === "de" ? dashboardsDe : dashboardsEn)
    .storeUpdate as (typeof dashboardsEn)["storeUpdate"];

/**
 * Template updates (11E) in the browser, in English and in German: the
 * template's dashboard says "Update available"; the customer reviews the
 * update, decides the one conflict (nothing is decided for them), applies
 * it as drafts, publishes the model draft in data settings through the
 * impact confirmation, creates the updated copy, swaps it onto the screens
 * (the original is archived) and switches back.
 */
test("a customer reviews and applies a store-template update", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const u = updateLabels(locale),
    data = labels(locale);
  const name = "App portfolio";

  const { workspaceId } = await startWorkspace(page, locale);
  const { requestId, dashboardId } = await installWithUpdate(page, workspaceId);
  const updatePath = `/workspaces/${workspaceId}/dashboards/stores/updates/${requestId}`;

  // 1. The dashboard says an update is available; the badge opens it.
  await page.goto(`/workspaces/${workspaceId}/dashboards`);
  const badge = page.getByRole("link", {
    name: fill(u.badgeNamed, { name }),
  });
  await expect(badge).toHaveText(u.badge);
  await badge.click();
  await expect(page).toHaveURL(updatePath);
  await expect(
    page.getByRole("heading", { level: 1, name: fill(u.title, { name }) }),
  ).toBeVisible();

  // 2. Review: the conflict waits for the customer's choice.
  await expect(
    page.getByRole("heading", { name: u.groups.choose }),
  ).toBeVisible();
  await expect(page.getByText(u.why.both).first()).toBeVisible();
  const apply = page.getByRole("button", { name: u.apply });
  await expect(apply).toBeDisabled();
  for (const radio of await page.getByRole("radio").all())
    await expect(radio).not.toBeChecked();
  for (const choice of await page
    .getByRole("radio", { name: u.useTemplate })
    .all())
    await choice.check();
  for (const removal of await page
    .getByRole("radio", { name: u.keep, exact: true })
    .all())
    await removal.check();
  await expect(apply).toBeEnabled();
  await apply.click();

  // 3. The model draft is published in data settings, impact first.
  const publishStep = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: u.steps.publish }) });
  await expect(publishStep.getByText(u.progress.draft)).toBeVisible();
  const createCopy = page.getByRole("button", {
    name: u.progress.createCopy,
  });
  await expect(createCopy).toBeDisabled();
  await publishStep
    .getByRole("link", { name: u.progress.openDraft })
    .first()
    .click();
  await expect(page).toHaveURL(/\/data\?model=/);
  // The normal flow: preview the draft, then publish it. Store measures
  // keep stores separate, so the preview groups by every dimension.
  const groupBy = page.getByRole("group", { name: data.groupBy });
  await expect(groupBy.getByRole("checkbox").first()).toBeVisible();
  for (const dimension of await groupBy.getByRole("checkbox").all())
    await dimension.check();
  await page
    .getByRole("region", { name: data.preview, exact: true })
    .getByRole("button", { name: data.preview, exact: true })
    .click();
  const publish = page.getByRole("button", { name: data.publish, exact: true });
  await expect(publish).toBeEnabled();
  await publish.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: data.impact.confirm, exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: data.publishedNotice }),
  ).toBeVisible();

  // 4. Back on the update: the copy is made from the published data.
  await page.goto(updatePath);
  await expect(publishStep.getByText(u.progress.published)).toBeVisible();
  await expect(createCopy).toBeEnabled();
  await createCopy.click();
  const openCopy = page.getByRole("link", { name: u.progress.openCopy });
  await expect(openCopy).toBeVisible();
  const copyHref = await openCopy.getAttribute("href");
  const copyId = copyHref!.split("/").at(-2)!;
  expect(copyId).not.toBe(dashboardId);
  // The copy has the template's titles; the original is untouched.
  const titles = async (id: string) => {
    const response = await page.request.get(
      `/v1/workspaces/${workspaceId}/dashboards/${id}`,
    );
    expect(response.status()).toBe(200);
    const body = (await response.json()) as {
      dashboard: { slides: { widgets: { title: string | null }[] }[] };
    };
    return body.dashboard.slides.flatMap((slide) =>
      slide.widgets.map((widget) => widget.title),
    );
  };
  expect(await titles(copyId)).not.toContain("My downloads");
  expect(await titles(copyId)).not.toContain("Proceeds (v0)");
  expect(await titles(dashboardId)).toContain("My downloads");

  // 5. Compare in Studio: the copy says what it is.
  await openCopy.click();
  await expect(
    page.getByText(u.studioCopy.split(".")[0]!, { exact: false }),
  ).toBeVisible();
  await page.goto(updatePath);

  // 6. Swap onto the screens (none yet), then the update is done.
  await expect(
    page.getByText(pluralBranch(u.progress.screens, "=0")),
  ).toBeVisible();
  await page.getByRole("button", { name: u.progress.swap }).click();
  await expect(page.getByText(u.progress.swapped)).toBeVisible();
  await expect(page.getByText(u.progress.finished)).toBeVisible();

  // 7. The original is archived: not in the grid, in its own section.
  await page.goto(`/workspaces/${workspaceId}/dashboards`);
  const grid = page.getByRole("list", {
    name: (locale === "de" ? dashboardsDe : dashboardsEn).dashboardsPage.list,
  });
  await expect(grid.getByText(name, { exact: true })).toHaveCount(0);
  const archived = page.locator("details.dashboards-archived");
  await archived.locator("summary").click();
  await expect(archived.getByText(name, { exact: true })).toBeVisible();
  await archived.getByRole("link", { name: u.switchBackLink }).click();
  await expect(page).toHaveURL(updatePath);

  // 8. Switch back: the original returns, the update is offered again.
  await page.getByRole("button", { name: u.progress.switchBack }).click();
  await expect(page.getByText(u.progress.switchedBack)).toBeVisible();
  await expect(
    page.getByRole("button", { name: u.progress.swapAgain }),
  ).toBeVisible();
  const list = await page.request.get(
    `/v1/workspaces/${workspaceId}/dashboards`,
  );
  const { dashboards } = (await list.json()) as {
    dashboards: { id: string }[];
  };
  expect(dashboards.map((d) => d.id)).toContain(dashboardId);
  expect(dashboards.map((d) => d.id)).not.toContain(copyId);
});
