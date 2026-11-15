import { expect, test } from "@playwright/test";
import type { SemanticModelDefinition } from "@netrics/domain";
import { salesEu } from "./fixtures/journey.ts";
import { createModel, readModel } from "./support/api.ts";
import { fill, labels, type Locale } from "./support/labels.ts";
import { seedReferenceTable, startWorkspace } from "./support/session.ts";

/**
 * A model whose measure keeps one dimension separate, like a store
 * portfolio's per-store measures (#603): it previews and publishes without
 * the customer choosing a grouping, and a preview that leaves the dimension
 * out says so, with a one-click fix.
 */
test("a scoped model publishes without guessing the grouping", async ({
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
    dimensions: [
      { id: "country", name: "Country", datasetId, fieldId: "country" },
      { id: "app", name: "App", datasetId, fieldId: "app" },
    ],
    measures: [
      {
        id: "revenue",
        name: "Revenue per country",
        kind: "aggregate",
        datasetId,
        requiredDimensions: ["country"],
        aggregate: {
          id: "revenue",
          name: "Revenue",
          op: "sum",
          fieldId: "revenue",
        },
      },
    ],
  };
  const modelId = await createModel(page, workspaceId, {
    name: "Per country",
    definition,
  });
  await page.goto(`/workspaces/${workspaceId}/data?model=${modelId}`);

  const preview = page.getByRole("region", { name: t.preview, ...exact });
  const groupBy = preview.getByRole("group", { name: t.groupBy });
  const publish = page.getByRole("button", { name: t.publish, ...exact });
  // 1. The preview already groups by the required dimension, and only it.
  await expect(
    groupBy.getByRole("checkbox", { name: "Country" }),
  ).toBeChecked();
  await expect(
    groupBy.getByRole("checkbox", { name: "App" }),
  ).not.toBeChecked();
  await expect(publish).toBeDisabled();
  await preview.getByRole("button", { name: t.preview, ...exact }).click();
  // DE and AT: one row per country.
  await expect(preview.getByRole("table").getByRole("row")).toHaveCount(3);
  await expect(publish).toBeEnabled();

  // 2. Leaving the dimension out explains why, and one click fixes it.
  await groupBy.getByRole("checkbox", { name: "Country" }).uncheck();
  await expect(publish).toBeDisabled();
  const scope = preview
    .getByRole("status")
    .filter({ hasText: fill(t.previewScope, { dimensions: "Country" }) });
  await expect(scope).toBeVisible();
  await scope
    .getByRole("button", {
      name: fill(t.previewScopeFix, { dimensions: "Country" }),
    })
    .click();
  await expect(scope).not.toBeVisible();
  await expect(
    groupBy.getByRole("checkbox", { name: "Country" }),
  ).toBeChecked();
  await expect(preview.getByText(t.freshPreview)).toBeVisible();
  await expect(preview.getByRole("alert")).toHaveCount(0);

  // 3. Publish: the impact confirmation, then the published model.
  await publish.click();
  const dialog = page.getByRole("dialog", {
    name: fill(t.impact.title, { name: "Per country" }),
  });
  await dialog
    .getByRole("button", { name: t.impact.confirm, ...exact })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: t.publishedNotice }),
  ).toBeVisible();
  const model = await readModel(page, workspaceId, "Per country");
  expect(model.publishedVersion).toBe(model.version);
});
