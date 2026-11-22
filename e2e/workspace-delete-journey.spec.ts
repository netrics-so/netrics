import { expect, test } from "@playwright/test";
import { authDe } from "../apps/web/src/messages/auth/de.ts";
import { authEn } from "../apps/web/src/messages/auth/en.ts";
import { commonDe } from "../apps/web/src/messages/common/de.ts";
import { commonEn } from "../apps/web/src/messages/common/en.ts";
import { fill, projectLabels, type Locale } from "./support/labels.ts";
import { startWorkspace } from "./support/session.ts";

/**
 * Deleting a workspace (#839), in workspace settings: the app's own dialog
 * asks for the workspace's name. Its Delete stays disabled until exactly
 * that name is typed, Enter in the field does nothing before, Escape
 * cancels and gives the focus back, and the focus never leaves the dialog.
 * Afterwards the workspace is gone and the user, whose only workspace it
 * was, is offered to create one.
 */
test("an owner deletes a workspace by typing its name", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const de = locale === "de";
  const common = (de ? commonDe : commonEn).common as typeof commonEn.common;
  const home = (de ? authDe : authEn).home as typeof authEn.home;
  const text = projectLabels(locale).settings.deletion;
  const exact = { exact: true } as const;
  const name = "Journey " + locale;
  const native: string[] = [];
  page.on("dialog", (dialog) => {
    native.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
  });

  const { workspaceId } = await startWorkspace(page, locale);
  const stored = async () =>
    (await page.request.get(`/v1/workspaces/${workspaceId}`)).status();

  await page.goto(`/workspaces/${workspaceId}/settings`);
  await expect(
    page.getByRole("heading", { name: text.title, ...exact }),
  ).toBeVisible();
  const open = page.getByRole("button", { name: text.button, ...exact });
  const question = page.getByRole("dialog", {
    name: fill(text.confirmTitle, { workspace: name }),
  });
  const field = question.getByLabel(
    fill(text.typeLabel, { workspace: name }),
    exact,
  );
  const confirm = question.getByRole("button", {
    name: text.confirm,
    ...exact,
  });
  const cancel = question.getByRole("button", {
    name: common.cancel,
    ...exact,
  });

  // 1. The dialog opens in the name field with Delete disabled, and says
  // what goes.
  await open.click();
  await expect(question).toBeVisible();
  await expect(question).toContainText(text.confirmText);
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("");
  await expect(confirm).toBeDisabled();

  // 2. Not the name: still disabled, and Enter in the field does nothing.
  for (const wrong of ["Journey", name.toUpperCase(), `${name}!`]) {
    await field.fill(wrong);
    await expect(confirm).toBeDisabled();
    await page.keyboard.press("Enter");
    await expect(question).toBeVisible();
  }
  expect(await stored()).toBe(200);

  // 3. Tab never leaves the dialog. (A modal dialog makes the page behind
  // it inert: after its last control the focus goes to the browser's own
  // controls, then back into it.)
  for (let step = 0; step < 6; step += 1) {
    await page.keyboard.press("Tab");
    expect(
      await question.evaluate((dialog) => {
        const active = document.activeElement;
        return dialog.contains(active) || active === document.body;
      }),
    ).toBe(true);
  }
  await expect(open).not.toBeFocused();

  // 4. Escape cancels; the focus is back on the button that asked, and
  // nothing was deleted.
  await page.keyboard.press("Escape");
  await expect(question).toHaveCount(0);
  await expect(open).toBeFocused();
  expect(await stored()).toBe(200);

  // 5. Cancel does the same, and what was typed is not kept.
  await open.click();
  await expect(field).toHaveValue("");
  await field.fill(name);
  await expect(confirm).toBeEnabled();
  await cancel.click();
  await expect(question).toHaveCount(0);
  expect(await stored()).toBe(200);

  // 6. The name, typed: Delete is enabled and deletes. The user's only
  // workspace is gone, so the start page offers to create one.
  await open.click();
  await expect(field).toBeFocused();
  await field.pressSequentially(name);
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page).toHaveURL("/");
  await expect(page.getByText(home.noWorkspace, exact)).toBeVisible();
  await expect(page.getByLabel(home.workspaceName, exact)).toBeVisible();
  expect(await stored()).toBe(404);
  const list = (await (await page.request.get("/v1/workspaces")).json()) as {
    workspaces: unknown[];
  };
  expect(list.workspaces).toEqual([]);
  // Its pages are gone too.
  const settings = await page.request.get(
    `/workspaces/${workspaceId}/settings`,
  );
  expect(settings.status()).toBe(404);
  expect(native).toEqual([]);
});
