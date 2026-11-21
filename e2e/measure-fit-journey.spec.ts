import { expect, test, type Page } from "@playwright/test";
import type { SemanticModelDefinition } from "@netrics/domain";
import { createModel } from "./support/api.ts";
import { labels, type Locale } from "./support/labels.ts";
import { ORIGIN } from "./support/origin.ts";
import { seedReferenceTable, startWorkspace } from "./support/session.ts";

/** A published model of installs by app and store: 20 apps in two stores. */
async function installsModel(page: Page, workspaceId: string): Promise<string> {
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
  return modelId;
}

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
  const modelId = await installsModel(page, workspaceId);
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

/**
 * Column heads keep their words whole (#780): in a third of a 16:9 screen
 * at font scale 1.3, "Downloads" is wider than an even share of the table.
 * Its column takes the room the word needs, the fit counts the rows with
 * those widths (none cut), and the screen's font is never swapped in over
 * a wider fallback.
 */
test("a column head does not break inside a word at font scale 1.3", async ({
  browser,
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const { workspaceId } = await startWorkspace(page, locale);
  const modelId = await installsModel(page, workspaceId);
  const theme = await page.request.post(
    `/v1/workspaces/${workspaceId}/themes`,
    {
      headers: { origin: ORIGIN },
      data: { name: "Large", base: "netrics_dark" },
    },
  );
  expect(theme.status(), await theme.text()).toBe(200);
  const made = (
    (await theme.json()) as {
      theme: { id: string; version: number; tokens: Record<string, unknown> };
    }
  ).theme;
  const scaled = await page.request.put(
    `/v1/workspaces/${workspaceId}/themes/${made.id}`,
    {
      headers: { origin: ORIGIN },
      data: {
        version: made.version,
        name: "Large",
        tokens: { ...made.tokens, fontScale: 1.3 },
      },
    },
  );
  expect(scaled.status(), await scaled.text()).toBe(200);
  const created = await page.request.post(
    `/v1/workspaces/${workspaceId}/dashboards`,
    {
      headers: { origin: ORIGIN },
      data: {
        name: "Downloads",
        settings: { themeId: made.id },
        slides: [
          {
            widgets: [
              {
                type: "measure",
                x: 0,
                y: 0,
                w: 4,
                h: 8,
                title: "Downloads by app and store",
                binding: {
                  modelId,
                  measureIds: ["installs"],
                  groupBy: ["app", "store"],
                  exclusions: [],
                },
                options: {
                  view: "table",
                  limit: 20,
                  labels: { installs: "Downloads" },
                },
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
  const context = await browser.newContext({
    storageState: await page.context().storageState(),
    viewport: { width: 1920, height: 1080 },
  });
  const tv = await context.newPage();
  await tv.goto(`/workspaces/${workspaceId}/dashboards/${dashboardId}/tv`);
  await expect(tv.locator(".sw-measure tbody tr").first()).toBeVisible();
  const table = await tv.evaluate(async () => {
    await document.fonts.ready;
    const widget = document.querySelector<HTMLElement>(".sw-measure")!;
    const heads = [...widget.querySelectorAll("th")].map((th) => {
      const range = document.createRange();
      range.selectNodeContents(th);
      return {
        text: th.textContent ?? "",
        // One box per line the head's text is drawn on.
        lines: new Set(
          [...range.getClientRects()].map((rect) => Math.round(rect.top)),
        ).size,
        width: th.getBoundingClientRect().width,
        fits: th.scrollWidth <= th.clientWidth,
      };
    });
    const scroll = widget.querySelector<HTMLElement>(
      ".sw-measure-table-scroll",
    )!;
    const bottom =
      widget.getBoundingClientRect().bottom -
      parseFloat(getComputedStyle(widget).paddingBottom);
    return {
      heads,
      scale: getComputedStyle(widget).getPropertyValue("--measure-scale"),
      clipped: [...widget.querySelectorAll("tbody tr")].filter(
        (row) =>
          row.getBoundingClientRect().bottom >
          scroll.getBoundingClientRect().bottom + 0.5,
      ).length,
      cut: [...widget.children].filter(
        (child) =>
          child.tagName === "P" &&
          child.getBoundingClientRect().bottom > bottom + 0.5,
      ).length,
      // The screen's faces hide text while they load (font-display).
      displays: [...document.fonts]
        .filter((face) => /plex/i.test(face.family))
        .map((face) => face.display),
    };
  });
  const where = JSON.stringify(table);
  expect(table.scale.trim(), where).toBe("1.3");
  expect(table.heads.map((head) => head.text)).toEqual([
    "App",
    "Store",
    "Downloads",
  ]);
  // Every head is one word: one line each, and the widest got more room.
  for (const head of table.heads) {
    expect(head.lines, where).toBe(1);
    expect(head.fits, where).toBe(true);
  }
  expect(table.heads[2]!.width, where).toBeGreaterThan(
    table.heads[0]!.width + 1,
  );
  expect(table.heads[0]!.width, where).toBeCloseTo(table.heads[1]!.width, 0);
  expect(table.clipped, where).toBe(0);
  expect(table.cut, where).toBe(0);
  expect(table.displays.length, where).toBeGreaterThan(0);
  expect(new Set(table.displays), where).toEqual(new Set(["block"]));
  await context.close();
});

/**
 * A value view's grouping in Studio (#788): the total with a line per
 * group (#784) shows what it is split by, and a switch to another view
 * and back keeps it.
 */
test("a value view shows its grouping in Studio and keeps it across views", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = labels(locale).dashboard;
  const { workspaceId } = await startWorkspace(page, locale);
  const modelId = await installsModel(page, workspaceId);
  const created = await page.request.post(
    `/v1/workspaces/${workspaceId}/dashboards`,
    {
      headers: { origin: ORIGIN },
      data: {
        name: "Installs",
        slides: [
          {
            widgets: [
              {
                type: "measure",
                x: 0,
                y: 0,
                w: 4,
                h: 4,
                title: "Installs",
                binding: {
                  modelId,
                  measureIds: ["installs"],
                  groupBy: ["store"],
                  exclusions: [],
                },
                options: { view: "value", limit: 2 },
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
  await page.goto(
    `/workspaces/${workspaceId}/dashboards/${dashboardId}/studio`,
  );
  const canvas = page.locator(".sw-measure").first();
  await expect(canvas.locator(".sw-measure-split li")).toHaveCount(2);
  await page.locator(".editor-widget").first().click();
  const fields = page.locator(".measure-fields");
  await expect(fields).toBeVisible();
  const view = fields.getByRole("combobox", { name: t.view, exact: true });
  const split = fields.getByRole("group", { name: t.splitBy, exact: true });
  const group = fields.getByRole("group", { name: t.groupBy, exact: true });
  const limit = fields.getByRole("spinbutton", { name: t.limit, exact: true });
  await expect(view).toHaveValue("value");
  await expect(split.getByRole("checkbox", { name: "Store" })).toBeChecked();
  await expect(split.getByRole("checkbox", { name: "App" })).not.toBeChecked();
  await expect(split.getByText(t.splitByHelp)).toBeVisible();
  await expect(limit).toHaveValue("2");

  // To a table and to a chart: the same grouping.
  await view.selectOption("table");
  await expect(group.getByRole("checkbox", { name: "Store" })).toBeChecked();
  await expect(canvas.locator("tbody tr")).toHaveCount(2);
  await view.selectOption("bar");
  await expect(group.getByRole("radio", { name: "Store" })).toBeChecked();
  // And back: the total with its two lines again.
  await view.selectOption("value");
  await expect(split.getByRole("checkbox", { name: "Store" })).toBeChecked();
  await expect(limit).toHaveValue("2");
  await expect(canvas.locator(".sw-measure-split li")).toHaveCount(2);
  await expect(canvas.locator(".sw-measure-total")).toBeVisible();

  // The split is a choice: none is a single value, without rows to limit.
  await split.getByRole("checkbox", { name: "Store" }).uncheck();
  await expect(canvas.locator(".sw-measure-split")).toHaveCount(0);
  await expect(canvas.locator(".sw-measure-value")).toBeVisible();
  await expect(limit).toHaveCount(0);
  await split.getByRole("checkbox", { name: "Store" }).check();
  await expect(canvas.locator(".sw-measure-split li")).toHaveCount(2);
});
