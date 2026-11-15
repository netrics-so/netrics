import { expect, test, type Locator, type Page } from "@playwright/test";
import { labels, type Locale } from "./support/labels.ts";
import { startWorkspace } from "./support/session.ts";
import { installWithConnections } from "./support/store-template.ts";

/**
 * Shared dashboard filters (#624), in English and German: one filter
 * popover is open at a time and never covers another trigger, so a press
 * meant for one never lands on another; Escape and a press outside close
 * it; focus moves into the popover and back to its trigger; "Browse
 * values" only expands the list.
 */
async function openDashboard(page: Page, locale: Locale) {
  const t = labels(locale).dashboard;
  const { workspaceId } = await startWorkspace(page, locale);
  const { dashboardId } = await installWithConnections(page, workspaceId);
  await page.goto(`/workspaces/${workspaceId}/dashboards/${dashboardId}`);
  const filters = page.getByRole("region", { name: t.sharedFilters });
  await expect(
    filters.locator(".dashboard-filter-trigger").first(),
  ).toBeVisible();
  return {
    t,
    filters,
    triggers: filters.locator(".dashboard-filter-trigger"),
    trigger: (name: string) =>
      filters.locator(".dashboard-filter-trigger", {
        has: page.getByText(name, { exact: true }),
      }),
    popover: (name: string) =>
      filters.getByRole("group", { name, exact: true }),
    popovers: filters.locator(".dashboard-filter-popover"),
  };
}

/** The open popover overlaps none of the filter triggers. */
async function coversNoTrigger(popover: Locator, triggers: Locator) {
  const box = (await popover.boundingBox())!;
  for (const trigger of await triggers.all()) {
    const other = (await trigger.boundingBox())!;
    const overlaps =
      box.x < other.x + other.width &&
      other.x < box.x + box.width &&
      box.y < other.y + other.height &&
      other.y < box.y + box.height;
    expect(overlaps, await trigger.innerText()).toBe(false);
  }
}

test("dashboard filter popovers open one at a time", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const currencyName = locale === "de" ? "Währung" : "Currency";
  const { t, triggers, trigger, popover, popovers } = await openDashboard(
    page,
    locale,
  );
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

  // 2. Opening a second filter closes the first. Before, both stayed open
  //    and the later one took the presses meant for the other.
  await app.click();
  await expect(popover("App")).toBeVisible();
  await expect(popover(currencyName)).toHaveCount(0);
  await coversNoTrigger(popover("App"), triggers);
  await expect(currency).toHaveAttribute("aria-expanded", "false");
  await expect(popovers).toHaveCount(1);

  // 3. Its confirm button is the one pressed: it closes this popover,
  //    returns focus to its trigger and changes no filter.
  await popover("App").getByRole("button", { name: t.done }).click();
  await expect(popovers).toHaveCount(0);
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

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("a filter popover never covers the next row's triggers", async ({
    page,
  }, testInfo) => {
    const locale = testInfo.project.name as Locale;
    const { t, triggers, popover, popovers } = await openDashboard(
      page,
      locale,
    );
    // The bar wraps: find a trigger on a lower row than the first.
    const first = triggers.first();
    const firstBox = (await first.boundingBox())!;
    let second: Locator | null = null;
    for (const candidate of await triggers.all()) {
      const box = (await candidate.boundingBox())!;
      if (box.y >= firstBox.y + firstBox.height) {
        second = candidate;
        break;
      }
    }
    expect(second, "the filter bar wraps at 390px").not.toBeNull();
    const firstName = (await first.locator("span").first().innerText()).trim();
    const secondName = (
      await second!.locator("span").first().innerText()
    ).trim();

    // 1. The first filter opens below the whole bar, covering no trigger.
    //    On a touch screen focus goes to the popover, not its search field,
    //    so no on-screen keyboard covers the values.
    await first.click();
    await expect(popover(firstName)).toBeVisible();
    await expect(popover(firstName)).toBeFocused();
    await coversNoTrigger(popover(firstName), triggers);

    // 2. One press on the lower-row trigger opens it and closes the first.
    await second!.click();
    await expect(popover(secondName)).toBeVisible();
    await expect(popover(firstName)).toHaveCount(0);
    await expect(popovers).toHaveCount(1);
    await expect(second!).toHaveAttribute("aria-expanded", "true");
    await expect(first).toHaveAttribute("aria-expanded", "false");
    await coversNoTrigger(popover(secondName), triggers);

    // 3. No value changed on the way.
    for (const trigger of await triggers.all())
      await expect(trigger).toContainText(t.allValues);
  });
});
