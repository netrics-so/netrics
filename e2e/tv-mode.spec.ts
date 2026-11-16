import { expect, test } from "@playwright/test";
import { screenDe } from "../apps/web/src/messages/screen/de.ts";
import { screenEn } from "../apps/web/src/messages/screen/en.ts";
import { labels, type Locale } from "./support/labels.ts";
import { startWorkspace } from "./support/session.ts";
import { installWithConnections } from "./support/store-template.ts";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The signed-in TV mode hangs on a wall like a paired screen (#681): its
 * measure tiles use the kiosk's viewer wording, without the editor's
 * instructions, and offline its header says when the data last updated.
 */
test("TV mode speaks to the wall and says when it last updated", async ({
  page,
  context,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const data = labels(locale);
  const screen = (locale === "de" ? screenDe : screenEn).screen.widget;

  const { workspaceId } = await startWorkspace(page, locale);
  // The store template's tiles: its connections have not synced yet.
  const { dashboardId } = await installWithConnections(page, workspaceId, {
    name: "Wall",
  });
  await page.setViewportSize({ width: 1920, height: 1080 });

  // The dashboard itself keeps the editor's wording.
  await page.goto(`/workspaces/${workspaceId}/dashboards/${dashboardId}`);
  await expect(page.getByText(data.noRows).first()).toBeVisible();

  await page.goto(`/workspaces/${workspaceId}/dashboards/${dashboardId}/tv`);
  await expect(page.locator(".studio-header")).toBeVisible();
  await expect(
    page.getByText(data.dashboard.viewer.noData).first(),
  ).toBeVisible();
  await expect(page.getByText(data.noRows)).toHaveCount(0);
  // "1 data warning. Check the model preview.": the instruction part.
  const instruction = /\{# [^.]+\. ([^}]+)\}/.exec(
    data.dashboard.resultWarnings,
  )![1]!;
  await expect(page.locator(".slide-screen")).not.toContainText(instruction);

  // Offline: the header's note carries the last update's time.
  await context.setOffline(true);
  const since = screen.offlineSince.split("{time}")[0]!;
  await expect(page.locator(".studio-header")).toContainText(
    new RegExp(`${escape(since)}\\d{1,2}:\\d{2}`),
  );
  await context.setOffline(false);
  await expect(page.locator(".studio-offline")).toHaveCount(0);
});
