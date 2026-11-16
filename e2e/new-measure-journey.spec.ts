import { expect, test } from "@playwright/test";
import type { SemanticModelDefinition } from "@netrics/domain";
import { salesEu } from "./fixtures/journey.ts";
import { createModel, readModel } from "./support/api.ts";
import { labels, type Locale } from "./support/labels.ts";
import { seedReferenceTable, startWorkspace } from "./support/session.ts";

/**
 * A new measure starts with an empty name that typing fills, and a sum
 * offers only number columns (#631).
 */
test("a new measure is named by typing and sums only numbers", async ({
  page,
}, testInfo) => {
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
    name: "Measures",
    definition,
  });
  await page.goto(`/workspaces/${workspaceId}/data?model=${modelId}`);

  const names = page.getByRole("textbox", { name: t.measureName, ...exact });
  await expect(names).toHaveCount(1);
  await page.getByRole("button", { name: t.addMeasure, ...exact }).click();
  await expect(names).toHaveCount(2);
  const added = names.nth(1);
  // Empty, explained by its placeholder, and ready for typing.
  await expect(added).toHaveValue("");
  await expect(added).toHaveAttribute("placeholder", t.measureNamePlaceholder);
  await expect(added).toBeFocused();
  await page.keyboard.type("Total revenue");
  await expect(added).toHaveValue("Total revenue");

  const card = page.locator(".data-measure").nth(1);
  const column = card.getByRole("combobox", { name: t.field, ...exact });
  // Count reads any column.
  await expect(column.getByRole("option")).toHaveText([
    t.choose,
    ...salesEu.fields.map((f) => f.name),
  ]);
  await column.selectOption({ label: "Country" });
  // Sum offers numbers only, and drops the text column chosen for count.
  await card
    .getByRole("combobox", { name: t.aggregate, ...exact })
    .selectOption({ label: t.sum });
  await expect(column.getByRole("option")).toHaveText([t.choose, "Revenue"]);
  await expect(column).toHaveValue("");
  await column.selectOption({ label: "Revenue" });

  await page.getByRole("button", { name: t.save, ...exact }).click();
  await expect(
    page.getByRole("status").filter({ hasText: t.saved }),
  ).toBeVisible();
  const model = await readModel(page, workspaceId, "Measures");
  expect(model.value.measures[1]).toMatchObject({
    name: "Total revenue",
    kind: "aggregate",
    aggregate: { name: "Total revenue", op: "sum", fieldId: "revenue" },
  });
});
