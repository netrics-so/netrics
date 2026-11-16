import { expect, test } from "@playwright/test";
import { salesEu } from "./fixtures/journey.ts";
import { fill, labels, type Locale } from "./support/labels.ts";
import { seedReferenceTable, startWorkspace } from "./support/session.ts";

/**
 * A step that fails when the preview runs (#643, #629), in English and in
 * German: the failure is shown once, on the step that caused it and with
 * its column, in words for that failure; later steps are marked affected;
 * the sample keeps the last valid rows; and the step form stays open, so
 * the setting can be fixed or the change cancelled. The editor never ends
 * with every control disabled.
 */
test("a failing step is named, marked and fixable", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = labels(locale);
  const exact = { exact: true } as const;

  const { workspaceId } = await startWorkspace(page, locale);
  await seedReferenceTable(page, workspaceId, salesEu);
  await page.goto(`/workspaces/${workspaceId}/data`);
  await page
    .getByRole("complementary")
    .getByRole("button", { name: salesEu.name })
    .click();
  await page.getByRole("button", { name: t.prepare }).click();
  const preview = page.getByRole("table");
  const rows = salesEu.rows.length + 1;
  await expect(preview.getByRole("row")).toHaveCount(rows);

  const steps = page.locator(".data-step-list > li");
  const operation = page.getByRole("combobox", { name: t.operation });
  const applyStep = page.getByRole("button", { name: t.applyStep });
  const applyChanges = page.getByRole("button", { name: t.applyStepChanges });
  const cancel = page.getByRole("button", { name: t.cancel, ...exact });
  const addStep = page.getByRole("button", { name: t.addStep });
  const onError = page.getByRole("combobox", { name: t.onError });
  const castFailure =
    fill(t.stepFailed, { message: t.errors.conversion }) +
    " " +
    fill(t.stepFailedColumn, { column: "Country" });

  // 1. Country to an exact decimal, stopping on a failure: "DE" fails.
  await addStep.click();
  await operation.selectOption({ label: t.cast });
  await page
    .getByRole("combobox", { name: t.field, ...exact })
    .selectOption({ label: "Country" });
  await page
    .getByRole("combobox", { name: t.type, ...exact })
    .selectOption({ label: t.types.decimal });
  await onError.selectOption({ label: t.reject });
  await applyStep.click();

  // The new step is listed as failed, with its message and column, once.
  const failed = steps.filter({ hasText: t.stepStatus.failed });
  await expect(failed).toHaveCount(1);
  await expect(failed).toContainText(t.cast);
  await expect(failed.getByRole("alert")).toHaveText(castFailure);
  await expect(page.getByText(t.errors.conversion)).toHaveCount(1);
  await expect(page.getByText(t.errors.invalid)).toHaveCount(0);
  // The last valid sample stays, marked out of date; the form stays open.
  await expect(preview.getByRole("row")).toHaveCount(rows);
  await expect(page.getByText(t.sampleOutdated)).toBeVisible();
  await expect(applyStep).toBeEnabled();
  await expect(cancel).toBeEnabled();
  await expect(onError).toHaveValue("reject");

  // 2. Empty values for what does not convert: the step applies.
  await onError.selectOption({ label: t.useNull });
  await applyStep.click();
  await expect(applyStep).toBeHidden();
  await expect(steps).toHaveCount(2);
  await expect(steps.filter({ hasText: t.stepStatus.failed })).toHaveCount(0);
  await expect(page.getByText(t.sampleOutdated)).toBeHidden();
  await expect(preview.getByRole("row")).toHaveCount(rows);
  await expect(addStep).toBeEnabled();

  // 3. A later step, then the type change edited back to stopping: the
  // type change fails and the later step is affected.
  await addStep.click();
  await operation.selectOption({ label: t.deduplicate });
  await applyStep.click();
  await expect(applyStep).toBeHidden();
  await expect(steps).toHaveCount(3);
  await steps.nth(1).getByRole("button").click();
  await page.getByRole("button", { name: t.editStep }).click();
  await onError.selectOption({ label: t.reject });
  await applyChanges.click();
  await expect(steps.nth(1)).toContainText(t.stepStatus.failed);
  await expect(steps.nth(1).getByRole("alert")).toHaveText(castFailure);
  await expect(steps.nth(2)).toContainText(t.stepStatus.affected);
  await expect(steps.nth(2)).toContainText(t.stepAffected);
  await expect(applyChanges).toBeEnabled();

  // 4. Cancel: nothing is marked, and the earlier steps still preview.
  await cancel.click();
  await expect(applyChanges).toBeHidden();
  await expect(steps.filter({ hasText: t.stepStatus.failed })).toHaveCount(0);
  await steps.nth(0).getByRole("button").click();
  await expect(preview.getByRole("row")).toHaveCount(rows);
  await expect(page.getByRole("button", { name: t.save })).toBeEnabled();

  // 5. A filter comparing a text column with a number (#629). Country is a
  // decimal by now, App is still text.
  const addFilter = async (formula: string) => {
    await addStep.click();
    await operation.selectOption({ label: t.filter });
    // A complete condition switches to the formula, which is then rewritten.
    const condition = page.getByRole("group", {
      name: fill(t.builder.condition, { number: 1 }),
    });
    await condition
      .getByRole("combobox", { name: t.builder.column, ...exact })
      .selectOption({ label: "Revenue" });
    await condition
      .getByRole("combobox", { name: t.builder.operator })
      .selectOption({ label: t.builder.operators.gt });
    await condition.getByRole("textbox", { name: t.builder.literal }).fill("0");
    await page.getByRole("radio", { name: t.formula }).check();
    const keepWhen = page.getByRole("combobox", { name: t.builder.keepWhen });
    // A typed 0 reads as 0, not DECIMAL("0") (#630).
    await expect(keepWhen).toHaveValue("GT([Revenue], 0)");
    await keepWhen.fill(formula);
    await applyStep.click();
  };
  await steps.nth(2).getByRole("button").click();
  await addFilter("[App] > 0");
  const filterFailure =
    fill(t.stepFailed, { message: t.errors.numeric }) +
    " " +
    fill(t.stepFailedColumn, { column: "App" });
  const failedFilter = steps.filter({ hasText: t.stepStatus.failed });
  await expect(failedFilter.getByRole("alert")).toHaveText(filterFailure);
  await expect(page.getByText(t.errors.numeric)).toHaveCount(1);
  await expect(preview.getByRole("row")).toHaveCount(rows);
  await cancel.click();
  await expect(steps).toHaveCount(3);
  await expect(addStep).toBeEnabled();
  await expect(page.getByText(t.sampleOutdated)).toBeHidden();

  // 6. A reorder that would make a step fail is refused: the message shows
  // in the banner, nothing is marked, and the unchanged sample is current.
  // The filter needs Country as a decimal, so it cannot move before the cast.
  await addFilter("[Country] > 0");
  await expect(applyStep).toBeHidden();
  await addStep.click();
  await operation.selectOption({ label: t.deduplicate });
  await applyStep.click();
  await expect(applyStep).toBeHidden();
  await expect(steps).toHaveCount(5);
  const moveUp = page.getByRole("button", { name: t.moveStepUp });
  await steps.nth(3).getByRole("button").click();
  await expect(steps.nth(3).getByRole("button")).toHaveAttribute(
    "aria-current",
    "step",
  );
  await moveUp.click();
  // Now right after the type change; one more step up is refused.
  await expect(steps.nth(2)).toContainText(t.filter);
  await expect(steps.nth(2).getByRole("button")).toHaveAttribute(
    "aria-current",
    "step",
  );
  await moveUp.click();
  await expect(
    page.getByRole("alert").filter({ hasText: t.errors.numeric }),
  ).toBeVisible();
  await expect(steps.nth(2)).toContainText(t.filter);
  await expect(steps.filter({ hasText: t.stepStatus.failed })).toHaveCount(0);
  await expect(page.getByText(t.sampleOutdated)).toBeHidden();
  await expect(moveUp).toBeEnabled();
  await expect(page.getByRole("button", { name: t.undo })).toBeEnabled();
});
