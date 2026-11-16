import { expect, test } from "@playwright/test";
import type { SemanticModelDefinition } from "@netrics/domain";
import { salesEu } from "./fixtures/journey.ts";
import { createModel, readModel } from "./support/api.ts";
import { fill, labels, type Locale } from "./support/labels.ts";
import { seedReferenceTable, startWorkspace } from "./support/session.ts";

/**
 * A new dimension starts with an empty name that typing fills, as a new
 * measure does, and pickers name it neutrally until it is named (#698).
 */
test("a new dimension is named by typing", async ({ page }, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = labels(locale);
  const exact = { exact: true } as const;

  const { workspaceId } = await startWorkspace(page, locale);
  const datasetId = await seedReferenceTable(page, workspaceId, salesEu);
  const definition: SemanticModelDefinition = {
    version: 1,
    datasets: [datasetId],
    relationships: [],
    dimensions: [],
    measures: [
      {
        id: "orders",
        name: "Orders",
        kind: "aggregate",
        datasetId,
        aggregate: { id: "orders", name: "Orders", op: "count" },
      },
    ],
  };
  const modelId = await createModel(page, workspaceId, {
    name: "Dimensions",
    definition,
  });
  await page.goto(`/workspaces/${workspaceId}/data?model=${modelId}`);

  const names = page.getByRole("textbox", { name: t.dimensionName, ...exact });
  await expect(names).toHaveCount(0);
  await page.getByRole("button", { name: t.addDimension, ...exact }).click();
  await expect(names).toHaveCount(1);
  const added = names.first();
  // Empty, explained by its placeholder, and ready for typing.
  await expect(added).toHaveValue("");
  await expect(added).toHaveAttribute(
    "placeholder",
    t.dimensionNamePlaceholder,
  );
  await expect(added).toBeFocused();
  // The preview's grouping names it neutrally until it has a name.
  const groupBy = page.getByRole("group", { name: t.groupBy, ...exact });
  await expect(
    groupBy.getByRole("checkbox", {
      name: fill(t.unnamedDimension, { number: 1 }),
      ...exact,
    }),
  ).toBeVisible();
  await page.keyboard.type("Country");
  await expect(added).toHaveValue("Country");
  await expect(
    groupBy.getByRole("checkbox", { name: "Country", ...exact }),
  ).toBeVisible();

  await page
    .locator(".data-model-row--dimension")
    .getByRole("combobox", { name: t.field, ...exact })
    .selectOption({ label: "Country" });
  await page.getByRole("button", { name: t.save, ...exact }).click();
  await expect(
    page.getByRole("status").filter({ hasText: t.saved }),
  ).toBeVisible();
  const model = await readModel(page, workspaceId, "Dimensions");
  expect(model.value.dimensions).toMatchObject([
    { name: "Country", datasetId, fieldId: "country" },
  ]);
});
