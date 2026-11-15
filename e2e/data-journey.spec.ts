import { expect, test, type Locator, type Page } from "@playwright/test";
import type { PreparationNode } from "@netrics/domain";
import { apps, expected, salesEu, salesUs } from "./fixtures/journey.ts";
import {
  createMeasureDashboard,
  readDashboardValue,
  readModel,
  readPreparation,
} from "./support/api.ts";
import { fill, labels, type Locale } from "./support/labels.ts";
import { seedReferenceTable, startWorkspace } from "./support/session.ts";

/**
 * The 11C gate (#442) in the browser: derive a boolean field, filter
 * records, append sources, confirm an entity mapping and publish a named
 * calculation without writing code, in English and in German. The formula
 * text areas are never typed into: the visual builders do all the work.
 * Visual and formula views store the same definition, and a saved draft
 * never changes what a published dashboard shows.
 */
test("a customer builds and publishes without code", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = labels(locale);
  const b = t.builder;
  const exact = { exact: true } as const;
  const preparationName = "Sales journey";

  const { workspaceId } = await startWorkspace(page, locale);
  await seedReferenceTable(page, workspaceId, salesEu);
  await seedReferenceTable(page, workspaceId, salesUs);
  await page.goto(`/workspaces/${workspaceId}/data`);
  await expect(
    page.getByRole("heading", { level: 1, name: t.title }),
  ).toBeVisible();

  // The mapping table is pasted into the reference editor.
  await page.getByRole("button", { name: t.newReference }).click();
  await page.getByRole("textbox", { name: t.referenceName }).fill(apps.name);
  // The disclosure's summary; its text area's label repeats the text.
  await page.getByText(t.pasteTable, exact).first().click();
  await page.getByRole("textbox", { name: t.pasteTable }).fill(apps.tsv);
  await page.getByRole("button", { name: t.importTable }).click();
  await page.getByRole("button", { name: t.saveReference }).click();
  const sourceList = page.getByRole("complementary");
  await expect(
    sourceList.getByRole("button", { name: apps.name }),
  ).toBeVisible();

  // 1. A preparation from Sales EU, with Sales US appended.
  await sourceList.getByRole("button", { name: salesEu.name }).click();
  await page.getByRole("button", { name: t.prepare }).click();
  await page
    .getByRole("textbox", { name: t.preparationName })
    .fill(preparationName);
  const preview = page.getByRole("table");
  await expect(preview.getByRole("row")).toHaveCount(salesEu.rows.length + 1);

  const operation = page.getByRole("combobox", { name: t.operation });
  const applyStep = page.getByRole("button", { name: t.applyStep });
  const addStep = async (kind: string) => {
    await page.getByRole("button", { name: t.addStep }).click();
    await operation.selectOption({ label: kind });
  };

  await addStep(t.append);
  await page
    .getByRole("combobox", { name: fill(t.appendInput, { number: 2 }) })
    .selectOption({ label: fill(t.datasetInput, { name: salesUs.name }) });
  await page.getByRole("checkbox", { name: t.matchAppendColumns }).check();
  // The suggested matches by name are accepted as they are.
  const secondInput = page.getByRole("group", {
    name: fill(t.appendInput, { number: 2 }),
  });
  await expect(
    secondInput.getByRole("combobox", { name: "Revenue" }),
  ).toHaveValue("revenue");
  await applyStep.click();
  await expect(preview.getByRole("row")).toHaveCount(expected.appendedRows + 1);

  // 2. Derive a boolean column: Germany is true when Country is DE.
  await addStep(t.calculate);
  await page.getByRole("textbox", { name: t.newName }).fill("Germany");
  await expect(
    page.getByRole("combobox", { name: b.newValue }),
  ).not.toBeVisible();
  await page
    .getByRole("combobox", { name: b.kind })
    .selectOption({ label: b.kinds.boolean });
  await page
    .getByRole("combobox", { name: b.column, ...exact })
    .selectOption({ label: "Country" });
  await page
    .getByRole("combobox", { name: b.operator })
    .selectOption({ label: b.operators.eq });
  await page.getByRole("textbox", { name: b.literal }).fill("DE");
  await applyStep.click();
  await expect(
    page.getByRole("columnheader", { name: /^Germany/ }),
  ).toBeVisible();
  const rowsWith = (text: string) =>
    preview
      .getByRole("row")
      .filter({ has: page.getByRole("cell", { name: text, ...exact }) });
  await expect(rowsWith("DE")).toHaveCount(expected.germanRows);
  for (const row of await rowsWith("DE").all())
    await expect(row.getByRole("cell", { name: t.true, ...exact })).toHaveCount(
      1,
    );
  for (const country of ["AT", "US"])
    for (const row of await rowsWith(country).all())
      await expect(
        row.getByRole("cell", { name: t.false, ...exact }),
      ).toHaveCount(1);

  // 3. Filter rows: revenue above zero, from 2026 on.
  await addStep(t.filter);
  await expect(
    page.getByRole("combobox", { name: b.keepWhen }),
  ).not.toBeVisible();
  const condition = (number: number) =>
    page.getByRole("group", { name: fill(b.condition, { number }) });
  await condition(1)
    .getByRole("combobox", { name: b.column, ...exact })
    .selectOption({ label: "Revenue" });
  await condition(1)
    .getByRole("combobox", { name: b.operator })
    .selectOption({ label: b.operators.gt });
  await condition(1).getByRole("textbox", { name: b.literal }).fill("0");
  await page.getByRole("button", { name: b.addCondition }).click();
  await condition(2)
    .getByRole("combobox", { name: b.column, ...exact })
    .selectOption({ label: "Day" });
  await condition(2)
    .getByRole("combobox", { name: b.operator })
    .selectOption({ label: b.operators.gte });
  await condition(2).getByLabel(b.literal).fill("2026-01-01");
  await applyStep.click();
  await expect(preview.getByRole("row")).toHaveCount(expected.filteredRows + 1);

  // 4. Confirm the entity mapping: merge Apps, one match per source row.
  await addStep(t.join);
  await page
    .getByRole("combobox", { name: t.otherDataset })
    .selectOption({ label: fill(t.datasetInput, { name: apps.name }) });
  await page
    .getByRole("combobox", { name: t.leftKey })
    .selectOption({ label: "App" });
  await page
    .getByRole("combobox", { name: t.rightKey })
    .selectOption({ label: "id" });
  await page
    .getByRole("combobox", { name: t.cardinality })
    .selectOption({ label: t.manyToOne });
  await applyStep.click();
  await expect(
    page.getByRole("columnheader", { name: /^Product/ }),
  ).toBeVisible();
  await expect(preview.getByRole("row")).toHaveCount(expected.filteredRows + 1);
  await expect(
    preview.getByRole("cell", { name: t.nullValue, ...exact }),
  ).toHaveCount(0);
  await expect(
    preview.getByRole("cell", { name: apps.products[0], ...exact }),
  ).toHaveCount(2);
  await expect(
    preview.getByRole("cell", { name: apps.products[1], ...exact }),
  ).toHaveCount(4);

  // 5. Reopen the derived column and apply it unchanged, once directly and
  // once after switching to the formula view and back: the definition and
  // the undo history stay as they are.
  const germanyStep = page.getByRole("button", {
    name: `${t.calculate} Germany`,
  });
  const applyChanges = page.getByRole("button", { name: t.applyStepChanges });
  // While the applied step previews, its button reads "Preparing preview…"
  // and the form is still open (unsaved, so leaving asks to confirm). The
  // step is applied once the form, here its literal field, is gone (#598).
  const applied = async () => {
    await expect(applyChanges).not.toBeVisible();
    await expect(page.getByRole("textbox", { name: b.literal })).toHaveCount(0);
  };
  for (const switchViews of [false, true]) {
    await germanyStep.click();
    await expect(germanyStep).toHaveAttribute("aria-current", "step");
    await page.getByRole("button", { name: t.editStep }).click();
    await expect(page.getByRole("textbox", { name: b.literal })).toHaveValue(
      "DE",
    );
    if (switchViews) {
      await page.getByRole("radio", { name: t.formula }).check();
      await expect(
        page.getByRole("combobox", { name: b.newValue }),
      ).toHaveValue(expected.germanyFormula);
      await page.getByRole("radio", { name: b.visual }).check();
      await expect(
        page.getByRole("combobox", { name: b.newValue }),
      ).not.toBeVisible();
      await expect(page.getByRole("textbox", { name: b.literal })).toHaveValue(
        "DE",
      );
    }
    await applyChanges.click();
    await applied();
    await expect(preview.getByRole("row")).toHaveCount(
      expected.appendedRows + 1,
    );
    await expect(rowsWith("DE")).toHaveCount(expected.germanRows);
  }
  // One undo takes back the merge, the last real change.
  const mergeStep = page.getByRole("button", { name: t.join, ...exact });
  await page.getByRole("button", { name: t.undo, ...exact }).click();
  await expect(mergeStep).toHaveCount(0);
  await expect(germanyStep).toBeVisible();
  await page.getByRole("button", { name: t.redo, ...exact }).click();
  await expect(mergeStep).toBeVisible();
  await mergeStep.click();
  await expect(
    page.getByRole("columnheader", { name: /^Product/ }),
  ).toBeVisible();

  // 6. Save, then publish through the impact confirmation. The draft is
  // saved first, so the preparation exists and the dialog must open.
  const saveDraft = page.getByRole("button", { name: t.save, ...exact });
  await saveDraft.click();
  await expect(
    page.getByRole("status").filter({ hasText: t.saved }),
  ).toBeVisible();
  await publish(page, t, fill(t.impact.title, { name: preparationName }));
  await expect(
    page.getByRole("status").filter({ hasText: t.publishedNotice }),
  ).toBeVisible();

  // The stored step is the condition the rows described.
  const published = await readPreparation(page, workspaceId, preparationName);
  const germanyNode = published.value.nodes.find(
    (node): node is Extract<PreparationNode, { type: "calculate" }> =>
      node.type === "calculate" && node.name === "Germany",
  );
  expect(germanyNode?.expression).toEqual(expected.germanyExpression);
  // Reapplied after a formula round trip, the step leaves the stored
  // preparation byte for byte as it was, at the same version.
  await germanyStep.click();
  await page.getByRole("button", { name: t.editStep }).click();
  await page.getByRole("radio", { name: t.formula }).check();
  await expect(page.getByRole("combobox", { name: b.newValue })).toHaveValue(
    expected.germanyFormula,
  );
  await page.getByRole("radio", { name: b.visual }).check();
  await applyChanges.click();
  await applied();
  await expect(page.getByText(t.changed)).toHaveCount(0);
  await expect(saveDraft).toBeDisabled();
  const reapplied = await readPreparation(page, workspaceId, preparationName);
  expect(reapplied.version).toBe(published.version);
  expect(reapplied.json).toBe(published.json);

  // 7. A model on the published output with three named measures.
  await page.getByRole("button", { name: t.back }).click();
  await page
    .getByRole("navigation", { name: t.title })
    .getByRole("button", { name: t.models })
    .click();
  await page.getByRole("button", { name: t.newModel }).click();
  await page.getByRole("textbox", { name: t.modelName }).fill("Sales");
  await page.getByRole("checkbox", { name: preparationName }).check();

  // Measure blocks have no accessible name of their own; a new measure is
  // always the last one, so its fields are the last of their kind.
  const addMeasure = async (name: string) => {
    await page.getByRole("button", { name: t.addMeasure }).click();
    await page.getByRole("textbox", { name: t.measureName }).last().fill(name);
  };
  const sumOfRevenue = async () => {
    await page
      .getByRole("combobox", { name: t.aggregate, ...exact })
      .last()
      .selectOption({ label: t.sum });
    await page
      .getByRole("combobox", { name: t.field, ...exact })
      .last()
      .selectOption({ label: "Revenue" });
  };
  await addMeasure("Revenue");
  await sumOfRevenue();

  await addMeasure("German revenue");
  await sumOfRevenue();
  await page.getByRole("button", { name: t.addMeasureFilter }).last().click();
  await expect(
    page.getByRole("combobox", { name: t.measureFilter }),
  ).not.toBeVisible();
  await page
    .getByRole("combobox", { name: b.column, ...exact })
    .last()
    .selectOption({ label: "Germany" });
  await page
    .getByRole("combobox", { name: b.operator })
    .last()
    .selectOption({ label: b.operators.eq });
  const germany = page.getByRole("switch", { name: b.literal }).last();
  await germany.click();
  await expect(germany).toHaveAttribute("aria-checked", "true");

  await addMeasure("German share");
  await page
    .getByRole("combobox", { name: t.measureKind, ...exact })
    .last()
    .selectOption({ label: t.formulaMeasure });
  await expect(page.getByRole("combobox", { name: t.formula })).toHaveCount(0);
  await operand(page.getByRole("group", { name: b.value, ...exact }), b, {
    measure: "German revenue",
    noun: b.measure,
  });
  await page
    .getByRole("combobox", { name: b.operation })
    .selectOption({ label: b.arithmetic.divide });
  await operand(page.getByRole("group", { name: b.secondValue }), b, {
    measure: "Revenue",
    noun: b.measure,
  });
  await page
    .getByRole("combobox", { name: b.result })
    .selectOption({ label: b.wrap.round });
  await page.getByRole("spinbutton", { name: b.digits, ...exact }).fill("2");

  await page.getByRole("button", { name: t.preview, ...exact }).click();
  const shareColumn = page.getByRole("columnheader", {
    name: /^German share/,
  });
  await expect(shareColumn).toBeVisible();
  await expect(
    page.getByRole("table").getByRole("cell", {
      name: expected.germanShare,
      ...exact,
    }),
  ).toBeVisible();

  const modelTitle = fill(t.impact.title, { name: "Sales" });
  await saveDraft.click();
  await expect(
    page.getByRole("status").filter({ hasText: t.saved }),
  ).toBeVisible();
  // Saved first, so the dialog opens; nothing uses the model yet.
  await publish(page, t, modelTitle, (dialog) =>
    expect(dialog.getByText(t.impact.none)).toBeVisible(),
  );
  await expect(
    page.getByRole("status").filter({ hasText: t.publishedNotice }),
  ).toBeVisible();

  // 8. A dashboard shows the published German share.
  const firstModel = await readModel(page, workspaceId, "Sales");
  const measureId = (name: string) =>
    firstModel.value.measures.find((measure) => measure.name === name)!.id;
  const dashboardName = "Sales overview";
  const dashboardId = await createMeasureDashboard(page, workspaceId, {
    name: dashboardName,
    modelId: firstModel.id,
    measureId: measureId("German share"),
  });
  expect(await readDashboardValue(page, workspaceId, dashboardId)).toBe(
    expected.germanShare,
  );

  // 9. A saved draft does not change the dashboard: German revenue becomes
  // the largest German sale instead of their sum.
  // Revenue, German revenue, German share: the second aggregation.
  await page
    .getByRole("combobox", { name: t.aggregate, ...exact })
    .nth(1)
    .selectOption({ label: t.max });
  await saveDraft.click();
  await expect(
    page.getByRole("status").filter({ hasText: t.saved }),
  ).toBeVisible();
  expect((await readModel(page, workspaceId, "Sales")).version).toBeGreaterThan(
    firstModel.version,
  );
  expect(await readDashboardValue(page, workspaceId, dashboardId)).toBe(
    expected.germanShare,
  );
  await page.getByRole("button", { name: t.preview, ...exact }).click();
  await expect(
    page.getByRole("table").getByRole("cell", {
      name: expected.changedGermanShare,
      ...exact,
    }),
  ).toBeVisible();
  // Publishing lists the dashboard that will change, then changes it.
  await publish(page, t, modelTitle, (dialog) =>
    expect(
      dialog.getByRole("listitem").filter({ hasText: dashboardName }),
    ).toBeVisible(),
  );
  await expect(
    page.getByRole("status").filter({ hasText: t.publishedNotice }),
  ).toBeVisible();
  expect(await readDashboardValue(page, workspaceId, dashboardId)).toBe(
    expected.changedGermanShare,
  );

  // 10. Stored as built: the measure filter and the calculation are the
  // expected expressions.
  const model = await readModel(page, workspaceId, "Sales");
  const germanRevenue = model.value.measures.find(
    (measure) => measure.name === "German revenue",
  );
  const germanyFieldId = germanyNode!.fieldId;
  expect(
    germanRevenue?.kind === "aggregate" ? germanRevenue.aggregate.filter : null,
  ).toEqual(expected.germanRevenueFilter(germanyFieldId));
  const share = model.value.measures.find(
    (measure) => measure.name === "German share",
  );
  expect(share?.kind === "formula" ? share.expression : null).toEqual(
    expected.germanShareExpression(
      measureId("German revenue"),
      measureId("Revenue"),
    ),
  );

  // 11. The same calculation read as a formula, and back: nothing to save,
  // and the stored model stays byte for byte as published.
  // German revenue's filter and German share each have a view switch;
  // German share's is the last.
  const shareViews = page.getByRole("radiogroup", { name: b.view }).last();
  await shareViews.getByRole("radio", { name: t.formula }).check();
  await expect(page.getByRole("combobox", { name: t.formula })).toHaveValue(
    expected.germanShareFormula,
  );
  await shareViews.getByRole("radio", { name: b.visual }).check();
  await expect(page.getByRole("combobox", { name: t.formula })).toHaveCount(0);
  await expect(saveDraft).toBeDisabled();
  const reread = await readModel(page, workspaceId, "Sales");
  expect(reread.version).toBe(model.version);
  expect(reread.json).toBe(model.json);
});

/**
 * Publishes a saved draft. The impact confirmation must open (a saved draft
 * always has a record to check); `check` inspects it, then it is accepted.
 */
async function publish(
  page: Page,
  t: ReturnType<typeof labels>,
  title: string,
  check?: (dialog: Locator) => Promise<void>,
) {
  const confirm = t.impact.confirm;
  await page.getByRole("button", { name: t.publish, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: title });
  await expect(dialog).toBeVisible();
  await check?.(dialog);
  await dialog.getByRole("button", { name: confirm, exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

/** Points one operand of a calculated measure at a measure. */
async function operand(
  group: Locator,
  b: ReturnType<typeof labels>["builder"],
  { measure, noun }: { measure: string; noun: string },
) {
  await group
    .getByRole("combobox", { name: b.source })
    .selectOption({ label: noun });
  await group
    .getByRole("combobox", { name: noun, exact: true })
    .selectOption({ label: measure });
}
