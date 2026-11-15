import { expect, test } from "@playwright/test";
import { labels, type Locale } from "./support/labels.ts";
import { startWorkspace } from "./support/session.ts";
import { installWithConnections } from "./support/store-template.ts";

/**
 * Shared dashboard filters (#624), in English and German: one filter
 * popover is open at a time, so a press meant for one never lands on
 * another; Escape and a press outside close it; focus moves into the
 * popover and back to its trigger; "Browse values" only expands the list.
 */
test("dashboard filter popovers open one at a time", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = labels(locale).dashboard;
  const currencyName = locale === "de" ? "Währung" : "Currency";

  const { workspaceId } = await startWorkspace(page, locale);
  const { dashboardId } = await installWithConnections(page, workspaceId);
  await page.goto(`/workspaces/${workspaceId}/dashboards/${dashboardId}`);

  const filters = page.getByRole("region", { name: t.sharedFilters });
  const trigger = (name: string) =>
    filters.locator(".dashboard-filter-trigger", {
      has: page.getByText(name, { exact: true }),
    });
  const popover = (name: string) =>
    filters.getByRole("group", { name, exact: true });
  const app = trigger("App"),
    currency = trigger(currencyName);

  // 1. Opening a filter moves focus into it; its values show at once,
  //    with a search field and no toggle that would close them.
  await currency.click();
  await expect(currency).toHaveAttribute("aria-expanded", "true");
  await expect(popover(currencyName)).toBeVisible();
  await expect(
    popover(currencyName).getByRole("searchbox", { name: t.searchValues }),
  ).toBeFocused();
  await expect(
    popover(currencyName).getByRole("button", { name: t.browseValues }),
  ).toHaveCount(0);

  // 2. Opening a second filter closes the first. (The App trigger sits in
  //    the first row, so the Currency popover never covers it; before, the
  //    Currency popover stayed open above the App popover and took its
  //    presses.)
  await app.click();
  await expect(popover("App")).toBeVisible();
  await expect(popover(currencyName)).toHaveCount(0);
  await expect(currency).toHaveAttribute("aria-expanded", "false");
  await expect(filters.locator(".dashboard-filter-popover")).toHaveCount(1);

  // 3. Its confirm button is the one pressed: it closes this popover,
  //    returns focus to its trigger and changes no filter.
  await popover("App").getByRole("button", { name: t.done }).click();
  await expect(filters.locator(".dashboard-filter-popover")).toHaveCount(0);
  await expect(app).toBeFocused();
  await expect(app).toHaveAttribute("aria-expanded", "false");
  await expect(app).toContainText(t.allValues);
  await expect(currency).toContainText(t.allValues);

  // 4. Keyboard: Enter opens, Escape closes and focus returns.
  await page.keyboard.press("Enter");
  await expect(popover("App")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popover("App")).toHaveCount(0);
  await expect(app).toBeFocused();

  // 5. A press outside closes.
  await currency.click();
  await expect(popover(currencyName)).toBeVisible();
  await page.getByRole("heading", { level: 1 }).click();
  await expect(popover(currencyName)).toHaveCount(0);
});
