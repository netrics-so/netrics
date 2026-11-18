import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { dashboardsDe } from "../apps/web/src/messages/dashboards/de.ts";
import { dashboardsEn } from "../apps/web/src/messages/dashboards/en.ts";
import type { Locale } from "./support/labels.ts";
import { startWorkspace } from "./support/session.ts";
import { ownerUrl } from "./support/store-template.ts";

const catalog = (locale: Locale) =>
  (locale === "de" ? dashboardsDe : dashboardsEn) as typeof dashboardsEn;

// A 1×1 PNG, stored as each app's icon: no fetch is needed.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Store connections stored as set up (no network) with `apps`, each with
 * its icon stored; answers the icon image of each app by name.
 */
async function seedApps(
  workspaceId: string,
  apps: { connector: "apple" | "play"; id: string; name: string }[],
): Promise<Map<string, string>> {
  const sql = postgres(ownerUrl(), { max: 1, onnotice: () => {} });
  try {
    const add = async (connectorId: string, name: string) => {
      const [row] = await sql<{ id: string }[]>`
        insert into connections (workspace_id, connector_id, name, setup_pending)
        values (${workspaceId}, ${connectorId}, ${name}, false)
        returning id`;
      return row!.id;
    };
    const connections = {
      apple: await add("app-store-connect", "Apple team"),
      play: await add("google-play", "Play account"),
    };
    const icons = new Map<string, string>();
    for (const app of apps) {
      const connectionId = connections[app.connector];
      await sql`insert into connection_resources
          (connection_id, workspace_id, resource_id, name, kind)
        values (${connectionId}, ${workspaceId}, ${app.id}, ${app.name}, 'app')`;
      const content = Buffer.concat([PNG, Buffer.from(app.id)]);
      const [image] = await sql<{ id: string }[]>`
        insert into workspace_images
          (workspace_id, name, content_type, bytes, width, height, sha256,
           content, origin, connection_id, resource_id)
        values (${workspaceId}, ${app.name + " icon"}, 'image/png',
          ${content.length}, 1, 1,
          ${createHash("sha256").update(content).digest("hex")}, ${content},
          'resource_icon', ${connectionId}, ${app.id})
        returning id`;
      icons.set(app.name, image!.id);
    }
    return icons;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * App Portfolio version 4 (#709), in English and German: the customer
 * creates the dashboard from the stores page and sees the overview first,
 * then one slide per app (by name), each with the app's icon in its header.
 */
test("the App portfolio shows an overview and one slide per app with its icon", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const { storeTemplate: s } = catalog(locale);
  const { workspaceId } = await startWorkspace(page, locale);
  const icons = await seedApps(workspaceId, [
    { connector: "apple", id: "1001", name: "Focus" },
    { connector: "apple", id: "1002", name: "Notes" },
    { connector: "play", id: "com.timer", name: "Timer" },
  ]);

  await page.goto(`/workspaces/${workspaceId}/dashboards/stores`);
  await page.getByRole("button", { name: s.review, exact: true }).click();
  await expect(page.getByText(s.slidesDefinition)).toBeVisible();
  await page.getByRole("button", { name: s.create }).click();
  await expect(page).toHaveURL(
    new RegExp(`/workspaces/${workspaceId}/dashboards/[0-9a-f-]{36}$`),
  );

  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveText([
    locale === "de" ? "App-Portfolio" : "App portfolio",
    "Focus",
    "Notes",
    "Timer",
  ]);
  // The overview has the dashboard's header; each app slide its icon.
  for (const name of ["Focus", "Notes", "Timer"]) {
    await page.getByRole("tab", { name, exact: true }).click();
    await expect(
      page.locator(`.slide-frame .studio-logo[src*="${icons.get(name)}"]`),
    ).toBeVisible();
  }
});

/**
 * More apps than slides: the install names the apps that appear on the
 * overview only, then opens the dashboard of 12 slides.
 */
test("the apps past the 12 slides are named at install", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const { storeTemplate: s } = catalog(locale);
  const { workspaceId } = await startWorkspace(page, locale);
  const names = Array.from(
    { length: 12 },
    (_, n) => `App ${String(n + 1).padStart(2, "0")}`,
  );
  await seedApps(
    workspaceId,
    names.map((name, n) => ({ connector: "play", id: `com.app${n}`, name })),
  );

  await page.goto(`/workspaces/${workspaceId}/dashboards/stores`);
  await page.getByRole("button", { name: s.review, exact: true }).click();
  await expect(
    page.getByText(s.tooManyApps.replace("{count}", "12")),
  ).toBeVisible();
  await page.getByRole("button", { name: s.create }).click();
  await expect(
    page.getByText(s.omittedApps.replace("{apps}", "App 12")),
  ).toBeVisible();
  await page.getByRole("link", { name: s.openDashboard }).click();
  await expect(page.getByRole("tab")).toHaveCount(12);
  await expect(page.getByRole("tab").last()).toHaveText("App 11");
});
