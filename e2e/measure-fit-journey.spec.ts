import { expect, test } from "@playwright/test";
import type { SemanticModelDefinition } from "@netrics/domain";
import { createModel } from "./support/api.ts";
import type { Locale } from "./support/labels.ts";
import { ORIGIN } from "./support/origin.ts";
import { seedReferenceTable, startWorkspace } from "./support/session.ts";

/**
 * Measure tables fit their tiles (#768): on a TV screen and a portrait
 * one, every table shows the rows that fit above its footer lines, none of
 * them cut, "Showing N of M" counts the rows on screen, and the room left
 * under the footer is less than one more row (the fit is not wasteful).
 */
test("measure tables show the rows that fit their tiles, and no fewer", async ({
  browser,
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const { workspaceId } = await startWorkspace(page, locale);
  const apps = Array.from({ length: 20 }, (_, n) => `App ${n + 1}`);
  const datasetId = await seedReferenceTable(page, workspaceId, {
    name: "Installs",
    key: "installs",
    keyFields: ["app", "store"],
    fields: [
      { id: "app", name: "App", type: "string", nullable: false },
      { id: "store", name: "Store", type: "string", nullable: false },
      { id: "installs", name: "Installs", type: "integer", nullable: false },
    ],
    rows: apps.flatMap((app, n) => [
      { app, store: "App Store", installs: 1000 - n * 10 },
      { app, store: "Google Play", installs: 900 - n * 10 },
    ]),
  });
  const definition: SemanticModelDefinition = {
    version: 1,
    datasets: [datasetId],
    relationships: [],
    dimensions: [
      { id: "app", name: "App", datasetId, fieldId: "app" },
      { id: "store", name: "Store", datasetId, fieldId: "store" },
    ],
    measures: [
      {
        id: "installs",
        name: "Installs over the reporting period",
        kind: "aggregate",
        datasetId,
        aggregate: {
          id: "installs",
          name: "Installs",
          op: "sum",
          fieldId: "installs",
        },
      },
    ],
  };
  const modelId = await createModel(page, workspaceId, {
    name: "Installs",
    definition,
  });
  const published = await page.request.post(
    `/v1/workspaces/${workspaceId}/data/models/${modelId}/publish`,
    { headers: { origin: ORIGIN }, data: { version: 1 } },
  );
  expect(published.status(), await published.text()).toBe(200);
  const table = (
    x: number,
    y: number,
    w: number,
    h: number,
    labels?: Record<string, string>,
  ) => ({
    type: "measure",
    x,
    y,
    w,
    h,
    title: "Installs by app and store",
    binding: {
      modelId,
      measureIds: ["installs"],
      groupBy: ["app", "store"],
      exclusions: [],
    },
    options: {
      view: "table",
      limit: 20,
      order: { measureId: "installs", direction: "desc" },
      ...(labels ? { labels } : {}),
    },
  });
  const created = await page.request.post(
    `/v1/workspaces/${workspaceId}/dashboards`,
    {
      headers: { origin: ORIGIN },
      data: {
        name: "Installs",
        slides: [
          {
            widgets: [
              table(0, 0, 4, 4, { installs: "Installs" }),
              table(4, 0, 4, 4),
              table(8, 0, 4, 4, { installs: "Installs" }),
              table(0, 4, 12, 4, { installs: "Installs" }),
            ],
          },
        ],
      },
    },
  );
  expect(created.status(), await created.text()).toBe(200);
  const dashboardId = ((await created.json()) as { dashboard: { id: string } })
    .dashboard.id;
  const state = await page.context().storageState();
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1080, height: 1920 },
  ]) {
    const context = await browser.newContext({ storageState: state, viewport });
    const tv = await context.newPage();
    await tv.goto(`/workspaces/${workspaceId}/dashboards/${dashboardId}/tv`);
    await expect(tv.locator(".sw-measure-table").first()).toBeVisible();
    await expect(tv.locator(".sw-measure tbody tr").first()).toBeVisible();
    // Measured once the screen's fonts are in, as viewers see it.
    const tables = await tv.evaluate(async () => {
      await document.fonts.ready;
      return [...document.querySelectorAll<HTMLElement>(".sw-measure")]
        .filter((el) => el.getBoundingClientRect().height > 0)
        .map((el) => {
          const box = el.getBoundingClientRect();
          const bottom =
            box.bottom - parseFloat(getComputedStyle(el).paddingBottom);
          const scroll = el.querySelector<HTMLElement>(
            ".sw-measure-table-scroll",
          )!;
          const rows = [...el.querySelectorAll("tbody tr")].map((tr) =>
            tr.getBoundingClientRect(),
          );
          const lines = [...el.children].filter(
            (child) => child.tagName === "P",
          );
          const last = [...el.children].at(-1)!.getBoundingClientRect().bottom;
          const gap = parseFloat(getComputedStyle(el).rowGap) || 0;
          return {
            rows: rows.length,
            clipped: rows.filter(
              (row) => row.bottom > scroll.getBoundingClientRect().bottom + 0.5,
            ).length,
            cut: lines.filter(
              (line) => line.getBoundingClientRect().bottom > bottom + 0.5,
            ).length,
            line:
              lines
                .map((line) => line.textContent ?? "")
                .find((text) => /(of|von) 40\b/.test(text)) ?? "",
            leftover: bottom - last,
            rowHeight: Math.min(...rows.map((row) => row.height)),
            gap,
          };
        });
    });
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      const where = `${viewport.width}×${viewport.height} ${JSON.stringify(table)}`;
      expect(table.rows, where).toBeGreaterThan(0);
      expect(table.clipped, where).toBe(0);
      expect(table.cut, where).toBe(0);
      expect(table.line, where).toMatch(
        new RegExp(`\\b${table.rows} (of|von) 40\\b`),
      );
      // Not wasteful: one more row would not have fit. The fit keeps one
      // pixel of rounding room per line of a row and of the heads (a
      // 1080-line screen has one pixel per unit): the explicit tolerance.
      expect(table.leftover, where).toBeLessThan(
        table.rowHeight + table.rows + 2,
      );
    }
    await context.close();
  }
});
