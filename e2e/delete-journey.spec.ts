import { expect, test } from "@playwright/test";
import type { SemanticModelDefinition } from "@netrics/domain";
import { salesEu } from "./fixtures/journey.ts";
import { createMeasureDashboard, createModel } from "./support/api.ts";
import { fill, labels, type Locale } from "./support/labels.ts";
import { ORIGIN } from "./support/origin.ts";
import { seedReferenceTable, startWorkspace } from "./support/session.ts";

/**
 * Deleting models (#671): an unused one goes after the app's own
 * confirmation; one a dashboard still shows is refused, and the refusal
 * names the dashboard.
 */
test("deletes an unused model and names what still uses another", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = labels(locale);
  const exact = { exact: true } as const;
  // Never a native browser dialog.
  page.on("dialog", (dialog) => {
    throw new Error(`unexpected native dialog: ${dialog.message()}`);
  });

  const { workspaceId } = await startWorkspace(page, locale);
  const datasetId = await seedReferenceTable(page, workspaceId, salesEu);
  const definition: SemanticModelDefinition = {
    version: 1,
    datasets: [datasetId],
    relationships: [],
    dimensions: [
      { id: "country", name: "Country", datasetId, fieldId: "country" },
    ],
    measures: [
      {
        id: "revenue",
        name: "Revenue",
        kind: "aggregate",
        datasetId,
        aggregate: {
          id: "revenue",
          name: "Revenue",
          op: "sum",
          fieldId: "revenue",
        },
      },
    ],
  };
  await createModel(page, workspaceId, { name: "Scratch model", definition });
  const usedId = await createModel(page, workspaceId, {
    name: "Revenue model",
    definition,
  });
  const published = await page.request.post(
    `/v1/workspaces/${workspaceId}/data/models/${usedId}/publish`,
    { headers: { origin: ORIGIN }, data: { version: 1 } },
  );
  expect(published.status(), await published.text()).toBe(200);
  await createMeasureDashboard(page, workspaceId, {
    name: "Sales board",
    modelId: usedId,
    measureId: "revenue",
  });

  await page.goto(`/workspaces/${workspaceId}/data`);
  await page
    .getByRole("navigation", { name: t.title })
    .getByRole("button", { name: new RegExp("^" + t.models) })
    .click();
  const rows = page.getByRole("table").getByRole("row");
  await expect(rows).toHaveCount(3);

  // 1. Cancel keeps the model.
  const deleteScratch = page.getByRole("button", {
    name: fill(t.delete.actionNamed, { name: "Scratch model" }),
  });
  await deleteScratch.click();
  const scratchDialog = page.getByRole("dialog", {
    name: fill(t.delete.modelTitle, { name: "Scratch model" }),
  });
  await scratchDialog
    .getByRole("button", { name: t.delete.cancel, ...exact })
    .click();
  await expect(scratchDialog).toHaveCount(0);
  await expect(rows).toHaveCount(3);

  // 2. Confirmed, an unused model goes.
  await deleteScratch.click();
  await scratchDialog
    .getByRole("button", { name: t.delete.confirm, ...exact })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: fill(t.delete.deleted, { name: "Scratch model" }) }),
  ).toBeVisible();
  await expect(rows).toHaveCount(2);
  await expect(deleteScratch).toHaveCount(0);

  // 3. A model a dashboard shows is refused, naming the dashboard.
  await page
    .getByRole("button", {
      name: fill(t.delete.actionNamed, { name: "Revenue model" }),
    })
    .click();
  await page
    .getByRole("dialog", {
      name: fill(t.delete.modelTitle, { name: "Revenue model" }),
    })
    .getByRole("button", { name: t.delete.confirm, ...exact })
    .click();
  const refusal = page
    .getByRole("alert")
    .filter({ hasText: fill(t.delete.inUse, { name: "Revenue model" }) });
  await expect(refusal).toBeVisible();
  await expect(
    refusal.getByRole("link", {
      name: fill(t.delete.dashboard, { name: "Sales board" }),
    }),
  ).toBeVisible();
  await expect(rows).toHaveCount(2);
  const left = await page.request.get(
    `/v1/workspaces/${workspaceId}/data/models/${usedId}`,
  );
  expect(left.status()).toBe(200);
});
