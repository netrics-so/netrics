import { expect, test } from "@playwright/test";
import { commonDe } from "../apps/web/src/messages/common/de.ts";
import { commonEn } from "../apps/web/src/messages/common/en.ts";
import { studioDe } from "../apps/web/src/messages/studio/de.ts";
import { studioEn } from "../apps/web/src/messages/studio/en.ts";
import { fill, type Locale } from "./support/labels.ts";
import { ORIGIN } from "./support/origin.ts";
import { startWorkspace } from "./support/session.ts";

/**
 * Deleting a dashboard (#798, #839) asks in the app's own dialog, never
 * the browser's: the focus starts on Cancel and stays in the dialog,
 * Escape cancels and gives the focus back to the Delete button, and only
 * the dialog's Delete removes the dashboard.
 */
test("deleting a dashboard confirms in the app's dialog", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const de = locale === "de";
  const common = (de ? commonDe : commonEn).common as typeof commonEn.common;
  const text = (de ? studioDe : studioEn)
    .dashboard as typeof studioEn.dashboard;
  const exact = { exact: true } as const;
  const native: string[] = [];
  page.on("dialog", (dialog) => {
    native.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
  });

  const { workspaceId } = await startWorkspace(page, locale);
  const created = await page.request.post(
    `/v1/workspaces/${workspaceId}/dashboards`,
    { headers: { origin: ORIGIN }, data: { name: "Sales board" } },
  );
  expect(created.status(), await created.text()).toBe(200);
  const dashboardId = ((await created.json()) as { dashboard: { id: string } })
    .dashboard.id;
  const stored = async () =>
    (
      await page.request.get(
        `/v1/workspaces/${workspaceId}/dashboards/${dashboardId}`,
      )
    ).status();

  await page.goto(`/workspaces/${workspaceId}/dashboards/${dashboardId}`);
  // The page's Delete button, not the dialog's.
  const remove = page
    .getByRole("button", { name: common.delete, ...exact })
    .and(page.locator(":not(dialog *)"));
  const question = page.getByRole("dialog", {
    name: fill(text.deleteConfirm, { name: "Sales board" }),
  });
  const cancel = question.getByRole("button", {
    name: common.cancel,
    ...exact,
  });
  const confirm = question.getByRole("button", {
    name: common.delete,
    ...exact,
  });

  // 1. The dialog opens on Cancel; Tab never leaves it; Escape cancels and
  // the focus is back on the button that asked.
  await remove.click();
  await expect(question).toBeVisible();
  await expect(cancel).toBeFocused();
  // (A modal dialog makes the page behind it inert: after its last button
  // the focus goes to the browser's own controls, then back into it.)
  for (let step = 0; step < 5; step += 1) {
    await page.keyboard.press("Tab");
    expect(
      await question.evaluate((dialog) => {
        const active = document.activeElement;
        return dialog.contains(active) || active === document.body;
      }),
    ).toBe(true);
  }
  await expect(remove).not.toBeFocused();
  await page.keyboard.press("Escape");
  await expect(question).toHaveCount(0);
  await expect(remove).toBeFocused();
  expect(await stored()).toBe(200);

  // 2. Enter right after it opens answers Cancel, not Delete.
  await remove.click();
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(question).toHaveCount(0);
  await expect(page).toHaveURL(
    `/workspaces/${workspaceId}/dashboards/${dashboardId}`,
  );
  expect(await stored()).toBe(200);

  // 3. Delete in the dialog removes the dashboard.
  await remove.click();
  await confirm.click();
  await expect(page).toHaveURL(`/workspaces/${workspaceId}/dashboards`);
  expect(await stored()).toBe(404);
  expect(native).toEqual([]);
});
