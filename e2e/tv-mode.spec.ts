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

  // A faked clock: the minute-long refresh cycles run on demand. 10:00:30
  // UTC, so two minutes later the clock shows another minute.
  await page.clock.install({ time: new Date("2026-11-16T10:00:30.000Z") });
  const tv = `/workspaces/${workspaceId}/dashboards/${dashboardId}/tv`;
  await page.goto(tv);
  const header = page.locator(".studio-header");
  await expect(header).toBeVisible();
  await expect(
    page.getByText(data.dashboard.viewer.noData).first(),
  ).toBeVisible();
  await expect(page.getByText(data.noRows)).toHaveCount(0);
  // "1 data warning. Check the model preview.": the instruction part.
  const instruction = /\{# [^.]+\. ([^}]+)\}/.exec(
    data.dashboard.resultWarnings,
  )![1]!;
  await expect(page.locator(".slide-screen")).not.toContainText(instruction);
  // The tiles' first load (after 100 ms).
  await page.clock.runFor(1_000);

  // Offline for more than a minute: the periodic refreshes find no server
  // and leave the page alone (a failed refresh would navigate to the
  // browser's error page), the tiles keep their last data, and the note
  // says when that was: two minutes before the clock.
  await context.setOffline(true);
  await page.clock.runFor(130_000);
  await expect(page).toHaveURL(new RegExp(`${escape(tv)}$`));
  await expect(header).toBeVisible();
  const [before, after] = screen.offlineSince.split("{time}");
  const note = header.locator(".studio-offline");
  await expect(note).toHaveText(
    new RegExp(`^⚠ ${escape(before!)}\\d{2}:\\d{2}${escape(after!)}$`),
  );
  const minutes = (text: string) => {
    const [h, m] = /(\d{2}):(\d{2})/.exec(text)!.slice(1).map(Number);
    return h! * 60 + m!;
  };
  const clock = await header.locator(".studio-header-clock").innerText();
  const noteText = await note.innerText();
  expect((minutes(clock) - minutes(noteText) + 1440) % 1440).toBe(2);
  await expect(
    page.getByText(data.dashboard.viewer.stale).first(),
  ).toBeVisible();
  await expect(page.getByText(data.dashboard.viewer.unavailable)).toHaveCount(
    0,
  );

  await context.setOffline(false);
  await page.clock.runFor(1_000);
  await expect(page.locator(".studio-offline")).toHaveCount(0);
});

/** The dashboard page refreshes alike, and stays when the network goes. */
test("an offline dashboard page stays on screen past its refresh", async ({
  page,
  context,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const { workspaceId } = await startWorkspace(page, locale);
  const { dashboardId } = await installWithConnections(page, workspaceId, {
    name: "Desk",
  });
  await page.clock.install({ time: new Date("2026-11-16T10:00:30.000Z") });
  const url = `/workspaces/${workspaceId}/dashboards/${dashboardId}`;
  await page.goto(url);
  await expect(page.locator(".studio-header")).toBeVisible();
  await context.setOffline(true);
  await page.clock.runFor(130_000);
  await expect(page).toHaveURL(new RegExp(`${escape(url)}$`));
  await expect(page.locator(".studio-header")).toBeVisible();
  await context.setOffline(false);
});
