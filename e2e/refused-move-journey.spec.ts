import { expect, test } from "@playwright/test";
import type { PreparationGraph } from "@netrics/domain";
import { salesEu } from "./fixtures/journey.ts";
import { ORIGIN } from "./support/origin.ts";
import { labels, type Locale } from "./support/labels.ts";
import { seedReferenceTable, startWorkspace } from "./support/session.ts";

/**
 * A refused reorder leaves the graph as it was, and so the sample: when a
 * step already failed and the sample was out of date, it stays marked out
 * of date, with the failed step still marked (#654).
 */
test("a refused move keeps an earlier out-of-date sample", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = labels(locale);
  const exact = { exact: true } as const;

  const { workspaceId } = await startWorkspace(page, locale);
  const datasetId = await seedReferenceTable(page, workspaceId, salesEu);
  // A Score column from Revenue, Score to a number, App to a decimal
  // stopping on a failure ("app-1" fails), and the output.
  const graph: PreparationGraph = {
    version: 1,
    nodes: [
      { id: "source", type: "source", datasetId },
      {
        id: "score",
        type: "calculate",
        input: "source",
        fieldId: "score",
        name: "Score",
        expression: { kind: "field", fieldId: "revenue" },
      },
      {
        id: "score_number",
        type: "cast",
        input: "score",
        fieldId: "score",
        to: "number",
        onError: "null",
      },
      {
        id: "app",
        type: "cast",
        input: "score_number",
        fieldId: "app",
        to: "decimal",
        onError: "reject",
      },
      // The output keeps its identity, so it never moves itself.
      {
        id: "unique",
        type: "deduplicate",
        input: "app",
        keys: ["day"],
        keep: "first",
      },
    ],
    outputs: ["unique"],
  };
  const response = await page.request.post(
    `/v1/workspaces/${workspaceId}/data/preparations`,
    { headers: { origin: ORIGIN }, data: { name: "Failing sales", graph } },
  );
  expect(response.status(), await response.text()).toBe(200);
  const { preparation } = (await response.json()) as {
    preparation: { id: string };
  };
  await page.goto(
    `/workspaces/${workspaceId}/data?preparation=${preparation.id}`,
  );

  const steps = page.locator(".data-step-list > li");
  await expect(steps).toHaveCount(5);
  const preview = page.getByRole("table");
  const rows = salesEu.rows.length + 1;
  const outdated = page.getByText(t.sampleOutdated);
  // The failed step carries its message; an affected one only a note.
  const failed = steps.filter({ has: page.getByRole("alert") });
  const banner = page.locator("div.error[role=alert]");
  // The Score type change previews; the App type change then fails, so the
  // sample stays, out of date, and the Score step stays selected.
  const scoreType = steps.nth(2).getByRole("button");
  await scoreType.click();
  await expect(scoreType).toHaveAttribute("aria-current", "step");
  await expect(preview.getByRole("row")).toHaveCount(rows);
  await expect(outdated).toBeHidden();
  await steps.nth(3).getByRole("button").click();
  await expect(outdated).toBeVisible();
  await expect(failed).toHaveCount(1);
  await expect(failed).toContainText(t.cast);
  await expect(scoreType).toHaveAttribute("aria-current", "step");

  // Before the Score column exists its type change fails: refused. The
  // graph and its failed step are as before, so the sample stays marked.
  await page.getByRole("button", { name: t.moveStepUp }).click();
  await expect(banner).toBeVisible();
  await expect(steps.nth(1)).toContainText("Score");
  await expect(scoreType).toHaveAttribute("aria-current", "step");
  await expect(outdated).toBeVisible();
  await expect(failed).toHaveCount(1);
  await expect(failed.getByRole("alert")).toContainText("App");
  await expect(preview.getByRole("row")).toHaveCount(rows);
  await expect(
    page.getByRole("button", { name: t.undo, ...exact }),
  ).toBeDisabled();
});
