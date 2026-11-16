import { expect, test, type Page } from "@playwright/test";
import type { SemanticModelDefinition } from "@netrics/domain";
import { salesEu } from "./fixtures/journey.ts";
import { createModel, readModel, readPreparation } from "./support/api.ts";
import { ORIGIN } from "./support/origin.ts";
import { fill, labels, type Locale } from "./support/labels.ts";
import { seedReferenceTable, startWorkspace } from "./support/session.ts";

/**
 * "Unpublished changes" compares what the editor shows with the published
 * definition, so undoing back to it clears the mark, also after a draft was
 * saved in between. A first publish asks like any other (#632).
 */
test("undoing back to the published definition clears the mark", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = labels(locale);
  const b = t.builder;
  const exact = { exact: true } as const;
  const name = "Marked sales";

  const { workspaceId } = await startWorkspace(page, locale);
  await seedReferenceTable(page, workspaceId, salesEu);
  await page.goto(`/workspaces/${workspaceId}/data`);
  await page
    .getByRole("complementary")
    .getByRole("button", { name: salesEu.name })
    .click();
  await page.getByRole("button", { name: t.prepare }).click();
  await page.getByRole("textbox", { name: t.preparationName }).fill(name);
  const preview = page.getByRole("table");
  await expect(preview.getByRole("row")).toHaveCount(salesEu.rows.length + 1);

  // 1. A new preparation asks before its first publish, as a model does.
  await page.getByRole("button", { name: t.publish, ...exact }).click();
  const dialog = page.getByRole("dialog", {
    name: fill(t.impact.title, { name }),
  });
  await expect(dialog.getByText(t.impact.none)).toBeVisible();
  await dialog
    .getByRole("button", { name: t.impact.confirm, ...exact })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: t.publishedNotice }),
  ).toBeVisible();
  const meta = page.locator(".data-editor-header .page-meta");
  const published = fill(t.published, { version: 1 });
  await expect(meta).toHaveText(published);

  // 2. A filter step, saved as a draft: unpublished changes.
  await page.getByRole("button", { name: t.addStep }).click();
  await page
    .getByRole("combobox", { name: t.operation })
    .selectOption({ label: t.filter });
  const condition = page.getByRole("group", {
    name: fill(b.condition, { number: 1 }),
  });
  await condition
    .getByRole("combobox", { name: b.column, ...exact })
    .selectOption({ label: "Revenue" });
  await condition
    .getByRole("combobox", { name: b.operator })
    .selectOption({ label: b.operators.gt });
  await condition.getByRole("textbox", { name: b.literal }).fill("0");
  await page.getByRole("button", { name: t.applyStep }).click();
  await expect(preview.getByRole("row")).toHaveCount(salesEu.rows.length);
  const changed = `${published} · ${t.changed}`;
  await expect(meta).toHaveText(changed);
  await page.getByRole("button", { name: t.save, ...exact }).click();
  await expect(
    page.getByRole("status").filter({ hasText: t.saved }),
  ).toBeVisible();
  await expect(meta).toHaveText(changed);

  // 3. Undo back to the published graph: the mark goes, though the saved
  // draft still has the step; redo brings it back.
  await page.getByRole("button", { name: t.undo, ...exact }).click();
  await expect(meta).toHaveText(published);
  await page.getByRole("button", { name: t.redo, ...exact }).click();
  await expect(meta).toHaveText(changed);

  // 4. A published model on the published preparation: a renamed measure is
  // marked until undone.
  const preparation = await readPreparation(page, workspaceId, name);
  const prepared = `prepared:${preparation.id}:${preparation.value.outputs[0]}`;
  const definition: SemanticModelDefinition = {
    version: 1,
    datasets: [prepared],
    relationships: [],
    dimensions: [],
    measures: [
      {
        id: "revenue",
        name: "Revenue",
        kind: "aggregate",
        datasetId: prepared,
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
    name: "Marked model",
    definition,
  });
  await publishModel(page, workspaceId, modelId, 1);
  expect(
    (await readModel(page, workspaceId, "Marked model")).publishedVersion,
  ).toBe(1);
  await page.goto(`/workspaces/${workspaceId}/data?model=${modelId}`);
  await expect(meta).toHaveText(published);
  const measureName = page.getByRole("textbox", {
    name: t.measureName,
    ...exact,
  });
  await measureName.fill("Revenue total");
  await expect(meta).toHaveText(changed);
  await page.getByRole("button", { name: t.undo, ...exact }).click();
  await expect(measureName).toHaveValue("Revenue");
  await expect(meta).toHaveText(published);

  // 5. Published from a restore of v1, it reads v1's pinned inputs. Once
  // the preparation is published again, using the latest published inputs
  // keeps the definition but reads another version: marked (#697).
  const restored = await page.request.post(
    `/v1/workspaces/${workspaceId}/data/models/${modelId}/restore`,
    { headers: { origin: ORIGIN }, data: { version: 1, publishedVersion: 1 } },
  );
  expect(restored.status(), await restored.text()).toBe(200);
  await publishModel(page, workspaceId, modelId, 2);
  await page.goto(`/workspaces/${workspaceId}/data?model=${modelId}`);
  const publishedRestore = fill(t.published, { version: 2 });
  await expect(meta).toHaveText(publishedRestore);
  const republished = await page.request.post(
    `/v1/workspaces/${workspaceId}/data/preparations/${preparation.id}/publish`,
    { headers: { origin: ORIGIN }, data: { version: preparation.version } },
  );
  expect(republished.status(), await republished.text()).toBe(200);
  // Still on v1's pins: unmarked.
  await page.reload();
  await expect(meta).toHaveText(publishedRestore);
  await page.getByRole("button", { name: t.adoptLatestInputs }).click();
  await expect(
    page.getByRole("status").filter({ hasText: t.latestInputsNotice }),
  ).toBeVisible();
  await expect(meta).toHaveText(`${publishedRestore} · ${t.changed}`);
});

/**
 * The list marks a model whose saved draft differs from its release by
 * content, not one that was only saved again (#697).
 */
test("the list marks drafts that differ from the release", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = labels(locale);
  const name = "Listed model";

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
  const modelId = await createModel(page, workspaceId, { name, definition });
  await publishModel(page, workspaceId, modelId, 1);
  const save = async (version: number, next: SemanticModelDefinition) => {
    const response = await page.request.put(
      `/v1/workspaces/${workspaceId}/data/models/${modelId}`,
      {
        headers: { origin: ORIGIN },
        data: { name, definition: next, version },
      },
    );
    expect(response.status(), await response.text()).toBe(200);
  };
  const row = async () => {
    await page.goto(`/workspaces/${workspaceId}/data`);
    await page
      .getByRole("navigation", { name: t.title })
      .getByRole("button", { name: t.models })
      .click();
    return page.getByRole("row").filter({ hasText: name });
  };
  const published = fill(t.published, { version: 1 });

  // Saved again unchanged: version 2, still equal to the release.
  await save(1, definition);
  expect((await readModel(page, workspaceId, name)).version).toBe(2);
  let listed = await row();
  await expect(listed).toContainText(published);
  await expect(listed).not.toContainText(t.changed);

  // A renamed measure differs.
  const renamed = structuredClone(definition);
  renamed.measures[0]!.name = "All orders";
  await save(2, renamed);
  listed = await row();
  await expect(listed).toContainText(`${published} · ${t.changed}`);

  // Saved back to the released definition: unmarked again.
  await save(3, definition);
  listed = await row();
  await expect(listed).toContainText(published);
  await expect(listed).not.toContainText(t.changed);
});

async function publishModel(
  page: Page,
  workspaceId: string,
  id: string,
  version: number,
) {
  const response = await page.request.post(
    `/v1/workspaces/${workspaceId}/data/models/${id}/publish`,
    { headers: { origin: ORIGIN }, data: { version } },
  );
  expect(response.status(), await response.text()).toBe(200);
}
