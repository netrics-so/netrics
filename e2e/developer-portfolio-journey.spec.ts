import { expect, test } from "@playwright/test";
import postgres from "postgres";

import { dashboardsDe } from "../apps/web/src/messages/dashboards/de.ts";
import { dashboardsEn } from "../apps/web/src/messages/dashboards/en.ts";
import type { Locale } from "./support/labels.ts";
import { startWorkspace } from "./support/session.ts";
import { ownerUrl } from "./support/store-template.ts";

const catalog = (locale: Locale) =>
  (locale === "de" ? dashboardsDe : dashboardsEn) as typeof dashboardsEn;

/**
 * A project with a Railway connection and a PostHog connection in it, both
 * stored as set up (no network), and PostHog's daily and monthly active
 * users of its project on two days, as a sync writes them.
 */
async function seed(workspaceId: string) {
  const sql = postgres(ownerUrl(), { max: 1, onnotice: () => {} });
  try {
    const [project] = await sql<{ id: string }[]>`
      insert into projects (workspace_id, name) values (${workspaceId}, 'Shop')
      returning id`;
    const add = async (connectorId: string, name: string, resource: string) => {
      const [row] = await sql<{ id: string }[]>`
        insert into connections
          (workspace_id, connector_id, name, setup_pending, project_id)
        values (${workspaceId}, ${connectorId}, ${name}, false, ${project!.id})
        returning id`;
      await sql`insert into connection_resources
          (connection_id, workspace_id, resource_id, name, kind)
        values (${row!.id}, ${workspaceId}, ${resource}, 'shop-prod', 'project')`;
      return row!.id;
    };
    await add("railway", "Railway team", "rw-shop");
    const posthog = await add("posthog", "PostHog EU", "ph-shop");
    const today = new Date();
    const day = (offset: number) =>
      new Date(
        Date.UTC(
          today.getUTCFullYear(),
          today.getUTCMonth(),
          today.getUTCDate() - offset,
        ),
      ).toISOString();
    for (const [key, rows] of [
      [
        "posthog.dau",
        [
          [2, 50],
          [1, 70],
        ],
      ],
      ["posthog.mau", [[1, 900]]],
    ] as const)
      for (const [offset, value] of rows)
        await sql`
          insert into observations (workspace_id, connection_id,
            metric_definition_id, dimensions, source_timestamp, value)
          select ${workspaceId}, ${posthog}, m.id,
            ${sql.json({ resource: "ph-shop" })}, ${day(offset)}::timestamptz,
            ${value}
          from metric_definitions m
          where m.connector_id = 'posthog' and m.key = ${key}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * The Developer Portfolio (#876), in English and German: the customer
 * starts it from the dashboards page with a Railway and a PostHog source
 * in a project, and gets the overview (what is not up, deploys today,
 * spend this month, active users) and the project's slide. The overview's
 * active users are yesterday's complete UTC day from PostHog.
 */
test("the Developer portfolio installs with an overview and a slide per project", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const { developerTemplate: d } = catalog(locale);
  const { workspaceId } = await startWorkspace(page, locale);
  await seed(workspaceId);

  await page.goto(`/workspaces/${workspaceId}/dashboards`);
  await page.getByRole("link", { name: new RegExp(d.title) }).click();
  await expect(page).toHaveURL(
    new RegExp(`/workspaces/${workspaceId}/dashboards/developer$`),
  );
  await expect(page.getByRole("checkbox")).toHaveCount(2);
  for (const checkbox of await page.getByRole("checkbox").all())
    await expect(checkbox).toBeChecked();
  await page.getByRole("button", { name: d.install }).click();
  await expect(page).toHaveURL(
    new RegExp(`/workspaces/${workspaceId}/dashboards/[0-9a-f-]{36}$`),
  );

  await expect(page.getByRole("tab")).toHaveText([
    locale === "de" ? "Übersicht" : "Overview",
    "Shop",
  ]);
  const slide = page.locator(".slide-frame");
  for (const title of locale === "de"
    ? [
        "Alle Dienste",
        "Was nicht läuft",
        "Deploys heute",
        "Kosten diesen Monat",
        "Aktive Nutzer gestern",
      ]
    : [
        "All services",
        "What is not up",
        "Deploys today",
        "Spend this month",
        "Active users yesterday",
      ])
    await expect(slide.getByText(title, { exact: true })).toBeVisible();
  // Yesterday's complete UTC day (70), not a sum of days, and its month.
  await expect(slide.getByText("70", { exact: true })).toBeVisible();
  await expect(slide.getByText("900", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "Shop", exact: true }).click();
  await expect(
    slide.getByText(locale === "de" ? "Letzte Deploys" : "Latest deploys", {
      exact: true,
    }),
  ).toBeVisible();
});
