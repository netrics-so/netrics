import { expect, test } from "@playwright/test";
import type { SemanticModelDefinition } from "@netrics/domain";
import { createModel } from "./support/api.ts";
import { labels, type Locale } from "./support/labels.ts";
import { seedReferenceTable, startWorkspace } from "./support/session.ts";

/**
 * A model preview filter on a dimension with a display name (#627): people
 * type the name the preview shows (`[Store] = "Google Play"`), not the stable
 * value behind it, and the preview finds the rows.
 */
test("a preview filter matches a dimension by the name it shows", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = labels(locale);
  const exact = { exact: true } as const;

  const { workspaceId } = await startWorkspace(page, locale);
  const datasetId = await seedReferenceTable(page, workspaceId, {
    name: "Store downloads",
    key: "store_downloads",
    fields: [
      { id: "store", name: "Store", type: "string", nullable: false },
      { id: "store_name", name: "Store name", type: "string", nullable: false },
      { id: "downloads", name: "Downloads", type: "integer", nullable: false },
    ],
    rows: [
      { store: "google_play", store_name: "Google Play", downloads: 7 },
      { store: "app_store", store_name: "App Store", downloads: 11 },
    ],
  });
  const definition: SemanticModelDefinition = {
    version: 1,
    datasets: [datasetId],
    relationships: [],
    dimensions: [
      {
        id: "store",
        name: "Store",
        datasetId,
        fieldId: "store",
        labelFieldId: "store_name",
      },
    ],
    measures: [
      {
        id: "downloads",
        name: "Downloads",
        kind: "aggregate",
        datasetId,
        aggregate: {
          id: "downloads",
          name: "Downloads",
          op: "sum",
          fieldId: "downloads",
        },
      },
    ],
  };
  const modelId = await createModel(page, workspaceId, {
    name: "Downloads by store",
    definition,
  });
  await page.goto(`/workspaces/${workspaceId}/data?model=${modelId}`);

  const preview = page.getByRole("region", { name: t.preview, ...exact });
  await preview
    .getByRole("group", { name: t.groupBy })
    .getByRole("checkbox", { name: "Store" })
    .check();
  await preview
    .getByLabel(t.sharedFilter, exact)
    .fill('[Store] = "Google Play"');
  await preview.getByRole("button", { name: t.preview, ...exact }).click();
  const rows = preview.getByRole("table").getByRole("row");
  // The header and the one Google Play row.
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("Google Play");
  await expect(rows.nth(1)).toContainText("7");
  await expect(preview.getByText("App Store")).toHaveCount(0);
});
