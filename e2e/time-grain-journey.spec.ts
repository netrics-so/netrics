import { expect, test } from "@playwright/test";
import { commonDe } from "../apps/web/src/messages/common/de.ts";
import { commonEn } from "../apps/web/src/messages/common/en.ts";
import type { SemanticModelDefinition } from "@netrics/domain";
import { createModel } from "./support/api.ts";
import { labels, type Locale } from "./support/labels.ts";
import { ORIGIN } from "./support/origin.ts";
import { seedReferenceTable, startWorkspace } from "./support/session.ts";

/**
 * "New photos per day" without a preparation (#838): a table grouped by a
 * timestamp has a row per second; choosing "Day" next to the dimension in
 * Studio makes it a row per day of the workspace's calendar, worded as a
 * date. The choice stays with the grouping across view switches and is
 * saved with the widget. A timestamp ticked in Studio starts per day (#853);
 * one a saved widget already groups by keeps what it has.
 */
test("a timestamp grouped per day in Studio shows one row per day", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const de = locale === "de";
  const t = labels(locale).dashboard;
  const { workspaceId } = await startWorkspace(page, locale);
  // Berlin days: 23:30 UTC on 1 November is already 2 November there.
  const zone = await page.request.patch(`/v1/workspaces/${workspaceId}`, {
    headers: { origin: ORIGIN },
    data: { timeZone: "Europe/Berlin" },
  });
  expect(zone.status(), await zone.text()).toBe(200);
  const datasetId = await seedReferenceTable(page, workspaceId, {
    name: "Photos",
    key: "photos",
    fields: [
      { id: "id", name: "ID", type: "integer", nullable: false },
      { id: "taken_at", name: "Taken at", type: "timestamp", nullable: false },
      { id: "day", name: "Day", type: "date", nullable: false },
    ],
    rows: [
      "2026-11-01T23:30:00Z",
      "2026-11-02T08:00:00Z",
      "2026-11-02T08:00:01Z",
      "2026-11-03T12:00:00Z",
      "2026-11-09T12:00:00Z",
    ].map((taken_at, id) => ({ id, taken_at, day: taken_at.slice(0, 10) })),
  });
  const definition: SemanticModelDefinition = {
    version: 1,
    datasets: [datasetId],
    relationships: [],
    dimensions: [
      { id: "taken", name: "Taken", datasetId, fieldId: "taken_at" },
      {
        id: "day",
        name: "Upload day",
        datasetId,
        fieldId: "day",
        timeAlignment: "reporting_date",
      },
    ],
    measures: [
      {
        id: "photos",
        name: "Photos",
        kind: "aggregate",
        datasetId,
        aggregate: { id: "photos", name: "Photos", op: "count" },
      },
      {
        id: "photos7",
        name: "Photos in 7 days",
        kind: "rolling",
        baseMeasureId: "photos",
        timeDimensionId: "day",
        window: { unit: "day", length: 7 },
      },
    ],
  };
  const modelId = await createModel(page, workspaceId, {
    name: "Photos",
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
        name: "Photos",
        slides: [
          {
            widgets: [
              {
                type: "measure",
                x: 0,
                y: 0,
                w: 6,
                h: 6,
                title: "New photos",
                binding: {
                  modelId,
                  measureIds: ["photos"],
                  groupBy: ["taken"],
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

  await page.goto(
    `/workspaces/${workspaceId}/dashboards/${dashboardId}/studio`,
  );
  const canvas = page.locator(".sw-measure").first();
  // A row per photo: each has its own second.
  await expect(canvas.locator("tbody tr")).toHaveCount(5);
  await page.locator(".editor-widget").first().click();
  const fields = page.locator(".measure-fields");
  const view = fields.getByRole("combobox", { name: t.view, exact: true });
  const group = fields.getByRole("group", { name: t.groupBy, exact: true });
  const grain = fields.getByRole("combobox", {
    name: t.grain.label.replace("{name}", "Taken"),
    exact: true,
  });
  const taken = group.getByRole("checkbox", { name: "Taken" });
  await expect(taken).toBeChecked();
  // A widget saved per instant (here: made through the API) stays so.
  await expect(grain).toHaveValue("");
  const rows = canvas.locator("tbody tr");

  // Ticked in Studio, a timestamp starts per day (#853): three days in
  // Berlin, worded as dates. A date next to it has no grain to start with.
  const firstDay = group.getByRole("checkbox", { name: "Upload day" });
  await firstDay.check();
  await expect(grain).toHaveValue("");
  await taken.uncheck();
  await expect(grain).toHaveCount(0);
  await taken.check();
  await expect(grain).toHaveValue("day");
  await expect(
    fields.getByRole("combobox", {
      name: t.grain.label.replace("{name}", "Upload day"),
      exact: true,
    }),
  ).toHaveValue("");
  await firstDay.uncheck();
  await expect(grain).toHaveValue("day");
  await expect(rows).toHaveCount(3);
  // "Each time" stays a choice, and stays chosen.
  await grain.selectOption({ label: t.grain.none });
  await expect(grain).toHaveValue("");
  await expect(rows).toHaveCount(5);

  // Per day, chosen by hand.
  await grain.selectOption({ label: t.grain.day });
  await expect(rows).toHaveCount(3);
  const day = (n: number) =>
    de ? `${String(n).padStart(2, "0")}.11.2026` : `Nov ${n}, 2026`;
  await expect(rows.nth(0)).toContainText(day(2));
  await expect(rows.nth(0)).toContainText("3");
  await expect(rows.nth(1)).toContainText(day(3));
  await expect(rows.nth(2)).toContainText(day(9));
  await expect(canvas).not.toContainText("2026-11-02");
  await expect(canvas).not.toContainText("08:00");

  // Per week (Monday): the week of 2 November, then that of 9 November.
  await grain.selectOption({ label: t.grain.week });
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText(day(2));
  await expect(rows.nth(0)).toContainText("4");
  await expect(rows.nth(1)).toContainText(day(9));

  // The grain stays with the grouping across views.
  await view.selectOption("line");
  await expect(group.getByRole("radio", { name: "Taken" })).toBeChecked();
  await expect(grain).toHaveValue("week");
  await expect(canvas.locator(".sw-measure-line")).toBeVisible();
  await view.selectOption("table");
  await expect(grain).toHaveValue("week");
  await expect(rows).toHaveCount(2);

  // A rolling measure is calculated per day of its date: Studio offers no
  // week or month of that date with it, and takes one back when the
  // measure is added, so the widget never becomes one the server refuses.
  const measures = fields.getByRole("group", {
    name: t.measures,
    exact: true,
  });
  const uploadDay = group.getByRole("checkbox", { name: "Upload day" });
  const dayGrain = fields.getByRole("combobox", {
    name: t.grain.label.replace("{name}", "Upload day"),
    exact: true,
  });
  const fixedHelp = fields.getByText(
    t.grain.fixed.replace("{name}", "Upload day"),
  );
  await uploadDay.check();
  await dayGrain.selectOption({ label: t.grain.month });
  await expect(dayGrain).toHaveValue("month");
  await expect(fixedHelp).toHaveCount(0);
  await measures.getByRole("checkbox", { name: "Photos in 7 days" }).check();
  await expect(dayGrain).toHaveValue("");
  await expect(
    dayGrain.getByRole("option", { name: t.grain.week }),
  ).toBeDisabled();
  await expect(
    dayGrain.getByRole("option", { name: t.grain.month }),
  ).toBeDisabled();
  await expect(fixedHelp).toBeVisible();
  // The preview still has its rows, with the new column.
  await expect(canvas.locator("thead th")).toHaveCount(4);
  await expect(rows.first()).toBeVisible();
  // No refusal in place of the table (a short history is only a notice).
  await expect(canvas.locator('.sw-notice[role="status"]')).toHaveCount(0);
  // The timestamp next to it keeps every choice.
  await expect(
    grain.getByRole("option", { name: t.grain.month }),
  ).toBeEnabled();
  await measures.getByRole("checkbox", { name: "Photos in 7 days" }).uncheck();
  await expect(
    dayGrain.getByRole("option", { name: t.grain.week }),
  ).toBeEnabled();
  await uploadDay.uncheck();
  await expect(dayGrain).toHaveCount(0);
  await expect(rows).toHaveCount(2);

  // Saved with the widget: viewers and screens get a row per day.
  await grain.selectOption({ label: t.grain.day });
  await expect(rows).toHaveCount(3);
  const saved = page.waitForResponse(
    (response) =>
      response.url().includes(`/dashboards/${dashboardId}`) &&
      response.request().method() === "PUT",
  );
  const save = (
    (de ? commonDe : commonEn).common as (typeof commonEn)["common"]
  ).save;
  await page.getByRole("button", { name: save, exact: true }).click();
  expect((await saved).status()).toBe(200);
  const data = await page.request.post(
    `/v1/workspaces/${workspaceId}/dashboards/${dashboardId}/data`,
    { headers: { origin: ORIGIN }, data: { values: {} } },
  );
  expect(data.status(), await data.text()).toBe(200);
  const [widget] = (
    (await data.json()) as {
      widgets: Array<{
        metadata: { dimensions: Array<{ id: string; type: string }> };
        result: {
          rows: Array<{
            dimensions: Record<string, unknown>;
            measures: Record<string, { value: unknown }>;
          }>;
        };
      }>;
    }
  ).widgets;
  expect(
    widget!.result.rows.map((row) => [
      row.dimensions.taken,
      row.measures.photos!.value,
    ]),
  ).toEqual([
    ["2026-11-02", 3],
    ["2026-11-03", 1],
    ["2026-11-09", 1],
  ]);
  expect(widget!.metadata.dimensions).toEqual([
    expect.objectContaining({ id: "taken", type: "date" }),
    expect.objectContaining({ id: "day", type: "date" }),
  ]);

  // The viewer's page words the days too.
  await page.goto(`/workspaces/${workspaceId}/dashboards/${dashboardId}`);
  const table = page.getByRole("table");
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table).toContainText(day(2));
  await expect(table).not.toContainText("2026-11-02");
});
