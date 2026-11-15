import { expect, test } from "@playwright/test";
import type { SemanticModelDefinition } from "@netrics/domain";
import { createModel } from "./support/api.ts";
import type { Locale } from "./support/labels.ts";
import { ORIGIN } from "./support/origin.ts";
import { seedReferenceTable, startWorkspace } from "./support/session.ts";

/**
 * A ratings dashboard reads like the viewer's language (#619): the day
 * filter and the widget's footnote show dates in the locale's format, the
 * "Checked at" day too, and an average rating is rounded to two decimals
 * while the API still answers the exact value.
 */
test("a ratings dashboard shows locale dates and rounded ratings", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const de = locale === "de";
  const { workspaceId } = await startWorkspace(page, locale);
  const datasetId = await seedReferenceTable(page, workspaceId, {
    name: "Ratings",
    key: "ratings",
    keyFields: ["listing", "day"],
    fields: [
      { id: "listing", name: "Listing", type: "string", nullable: false },
      { id: "day", name: "Day", type: "date", nullable: false },
      {
        id: "rating",
        name: "Rating",
        type: "decimal",
        nullable: false,
        unit: "stars",
      },
    ],
    rows: [
      { listing: "Puzzle", day: "2026-01-03", rating: "4.1" },
      { listing: "Puzzle", day: "2026-01-06", rating: "4.2857" },
    ],
  });
  const definition: SemanticModelDefinition = {
    version: 1,
    datasets: [datasetId],
    relationships: [],
    dimensions: [
      { id: "listing", name: "Listing", datasetId, fieldId: "listing" },
      {
        id: "day",
        name: "Day",
        datasetId,
        fieldId: "day",
        timeAlignment: "reporting_date",
      },
    ],
    measures: [
      ["rating", "Rating", "rating"],
      ["checked", "Checked at", "day"],
    ].map(([id, name, fieldId]) => ({
      id: id!,
      name: name!,
      kind: "aggregate" as const,
      datasetId,
      aggregate: {
        id: id!,
        name: name!,
        op: "last" as const,
        fieldId: fieldId!,
        orderBy: "day",
      },
    })),
  };
  const modelId = await createModel(page, workspaceId, {
    name: "Ratings",
    definition,
  });
  const published = await page.request.post(
    `/v1/workspaces/${workspaceId}/data/models/${modelId}/publish`,
    { headers: { origin: ORIGIN }, data: { version: 1 } },
  );
  expect(published.status(), await published.text()).toBe(200);
  const created = await page.request.post(
    `/v1/workspaces/${workspaceId}/dashboards`,
    {
      headers: { origin: ORIGIN },
      data: {
        name: "Ratings",
        settings: {
          dataFilters: [
            {
              id: "day",
              name: "Day",
              type: "date",
              mode: "range",
              mappings: [{ modelId, dimensionId: "day" }],
              defaultValue: {
                kind: "range",
                from: "2026-01-01",
                to: "2026-01-07",
              },
            },
          ],
        },
        slides: [
          {
            widgets: [
              {
                type: "measure",
                x: 0,
                y: 0,
                w: 12,
                h: 4,
                title: "Ratings",
                binding: {
                  modelId,
                  measureIds: ["rating", "checked"],
                  groupBy: ["listing"],
                  exclusions: [],
                },
                options: { view: "table", limit: 20 },
              },
            ],
          },
        ],
      },
    },
  );
  expect(created.status(), await created.text()).toBe(200);
  const dashboardId = ((await created.json()) as { dashboard: { id: string } })
    .dashboard.id;

  // The stored value stays exact.
  const data = await page.request.post(
    `/v1/workspaces/${workspaceId}/dashboards/${dashboardId}/data`,
    { headers: { origin: ORIGIN }, data: { values: {} } },
  );
  expect(data.status(), await data.text()).toBe(200);
  const [widget] = (
    (await data.json()) as {
      widgets: Array<{
        result: {
          rows: Array<{ measures: Record<string, { value: unknown }> }>;
        };
      }>;
    }
  ).widgets;
  expect(widget!.result.rows[0]!.measures.rating!.value).toBe("4.2857");

  await page.goto(`/workspaces/${workspaceId}/dashboards/${dashboardId}`);
  const range = de ? "01.01.2026 – 07.01.2026" : "Jan 1, 2026 – Jan 7, 2026";
  // The filter chip.
  await expect(
    page.locator(".dashboard-filter-trigger").filter({ hasText: "Day" }),
  ).toContainText(range);
  const table = page.getByRole("table");
  await expect(table.getByRole("row").nth(1)).toContainText(
    de ? "4,29 ★" : "4.29 ★",
  );
  await expect(table).toContainText(de ? "06.01.2026" : "Jan 6, 2026");
  await expect(table).not.toContainText("4.2857");
  await expect(table).not.toContainText("4,2857");
  await expect(table).not.toContainText("2026-01-06");
  // The widget's footnote.
  await expect(page.getByText(`Day: ${range}`)).toBeVisible();
});
