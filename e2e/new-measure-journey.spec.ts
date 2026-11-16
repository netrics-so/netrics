import { expect, test } from "@playwright/test";
import type { SemanticModelDefinition } from "@netrics/domain";
import { salesEu } from "./fixtures/journey.ts";
import { createModel, readModel } from "./support/api.ts";
import { fill, labels, type Locale } from "./support/labels.ts";
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

/**
 * A sum of a text column, saved before the picker offered only numbers,
 * keeps its column, marked as not fitting and explained, and the rest of
 * the model can still be saved (#631).
 */
test("a stored column that no longer fits stays and the model saves", async ({
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
      {
        id: "countries",
        name: "Countries",
        kind: "aggregate",
        datasetId,
        aggregate: {
          id: "countries",
          name: "Countries",
          op: "sum",
          fieldId: "country",
        },
      },
    ],
  };
  const modelId = await createModel(page, workspaceId, {
    name: "Old sums",
    definition,
  });
  await page.goto(`/workspaces/${workspaceId}/data?model=${modelId}`);

  const card = page.locator(".data-measure").nth(1);
  const column = card.getByRole("combobox", { name: t.field, ...exact });
  const unfit = fill(t.unfitColumn, { name: "Country" });
  await expect(column.getByRole("option")).toHaveText([
    t.choose,
    "Revenue",
    unfit,
  ]);
  await expect(column).toHaveValue("country");
  const hint = fill(t.unfitColumnHint, { name: "Country", aggregate: t.sum });
  await expect(card.getByText(hint)).toBeVisible();
  await expect(column).toHaveAccessibleDescription(hint);

  // Another measure's rename saves.
  await page
    .getByRole("textbox", { name: t.measureName, ...exact })
    .first()
    .fill("All orders");
  await page.getByRole("button", { name: t.save, ...exact }).click();
  await expect(
    page.getByRole("status").filter({ hasText: t.saved }),
  ).toBeVisible();
  const model = await readModel(page, workspaceId, "Old sums");
  expect(model.value.measures.map((m) => m.name)).toEqual([
    "All orders",
    "Countries",
  ]);

  // Choosing a number column clears the hint.
  await column.selectOption({ label: "Revenue" });
  await expect(card.getByText(hint)).toHaveCount(0);
  await expect(column.getByRole("option")).toHaveText([t.choose, "Revenue"]);
});
