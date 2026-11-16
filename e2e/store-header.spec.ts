import { expect, test } from "@playwright/test";
import { dashboardsDe } from "../apps/web/src/messages/dashboards/de.ts";
import { dashboardsEn } from "../apps/web/src/messages/dashboards/en.ts";
import type { Locale } from "./support/labels.ts";
import { startWorkspace } from "./support/session.ts";
import { installWithConnections } from "./support/store-template.ts";

/**
 * The App portfolio dashboard under its default name (#622): its only slide
 * carries the same name, and the slide header shows it once, not as
 * "App-Portfolio App-Portfolio".
 */
test("the app portfolio header shows its title once", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const name = (locale === "de" ? dashboardsDe : dashboardsEn).storeTemplate
    .defaultName;

  const { workspaceId } = await startWorkspace(page, locale);
  const { dashboardId } = await installWithConnections(page, workspaceId, {
    name,
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/workspaces/${workspaceId}/dashboards/${dashboardId}`);

  const header = page.locator(".studio-header");
  await expect(header.locator(".studio-header-name")).toHaveText(name);
  await expect(header.locator(".studio-header-slide")).toHaveCount(0);
  expect((await header.innerText()).split(name).length - 1).toBe(1);
});
