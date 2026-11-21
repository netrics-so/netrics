import { expect, test } from "@playwright/test";
import { commonDe } from "../apps/web/src/messages/common/de.ts";
import { commonEn } from "../apps/web/src/messages/common/en.ts";
import { studioDe } from "../apps/web/src/messages/studio/de.ts";
import { studioEn } from "../apps/web/src/messages/studio/en.ts";
import type { Locale } from "./support/labels.ts";
import { ORIGIN } from "./support/origin.ts";
import { startWorkspace } from "./support/session.ts";

/**
 * The Studio's keyboard shortcuts rest while a confirmation is open
 * (#798): with "Discard all unsaved changes?" on screen, Ctrl/Cmd+S does
 * not save and Ctrl/Cmd+Z does not change the draft behind the dialog.
 * After Discard, whose button is then disabled, the focus is on the
 * dashboard's heading.
 */
test("Studio shortcuts rest while the discard question is open", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const de = locale === "de";
  const common = (de ? commonDe : commonEn).common as typeof commonEn.common;
  const studio = (de ? studioDe : studioEn).studio as typeof studioEn.studio;
  const t = studio.editor;
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
  const storedSlides = async () => {
    const response = await page.request.get(
      `/v1/workspaces/${workspaceId}/dashboards/${dashboardId}`,
    );
    const body = (await response.json()) as {
      dashboard: { slides: unknown[] };
    };
    return body.dashboard.slides.length;
  };
  const slidesBefore = await storedSlides();

  await page.goto(
    `/workspaces/${workspaceId}/dashboards/${dashboardId}/studio`,
  );
  const outside = page.locator(":not(dialog *)");
  const discard = page
    .getByRole("button", { name: t.discard, ...exact })
    .and(outside);
  const undo = page.getByRole("button", { name: t.undo, ...exact });
  const redo = page.getByRole("button", { name: t.redo, ...exact });
  const unsaved = page.getByText(t.unsaved, exact);
  const question = page.getByRole("dialog", { name: t.discardConfirm });
  const cancel = question.getByRole("button", {
    name: common.cancel,
    ...exact,
  });

  // An unsaved change: one more slide.
  await page.getByRole("button", { name: studio.rail.add, ...exact }).click();
  await expect(unsaved).toBeVisible();
  await expect(undo).toBeEnabled();
  await expect(redo).toBeDisabled();

  // With the question open, save and undo do nothing, from Cancel and from
  // the dialog's Discard button alike.
  await discard.click();
  await expect(cancel).toBeFocused();
  for (const button of [
    cancel,
    question.getByRole("button", { name: t.discard, ...exact }),
  ]) {
    await button.focus();
    await page.keyboard.press("ControlOrMeta+s");
    await page.keyboard.press("ControlOrMeta+z");
    await page.keyboard.press("ControlOrMeta+y");
    await page.keyboard.press("ControlOrMeta+v");
  }
  await expect(question).toBeVisible();
  await cancel.click();
  await expect(question).toHaveCount(0);
  await expect(unsaved).toBeVisible();
  await expect(undo).toBeEnabled();
  await expect(redo).toBeDisabled();
  expect(await storedSlides()).toBe(slidesBefore);

  // The shortcuts work again once it is closed.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(redo).toBeEnabled();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(redo).toBeDisabled();
  await expect(unsaved).toBeVisible();

  // Discard: nothing is saved, and the focus goes to the heading (the
  // Discard button is disabled now).
  await discard.click();
  await question.getByRole("button", { name: t.discard, ...exact }).click();
  await expect(question).toHaveCount(0);
  await expect(discard).toBeDisabled();
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  expect(await storedSlides()).toBe(slidesBefore);
  expect(native).toEqual([]);
});
