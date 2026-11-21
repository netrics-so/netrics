import { expect, test, type Locator, type Page } from "@playwright/test";
import { labels, type Locale } from "./support/labels.ts";
import { startWorkspace } from "./support/session.ts";
import { installWithConnections } from "./support/store-template.ts";

/**
 * Shared dashboard filters (#624), in English and German: one filter
 * popover is open at a time and never covers another trigger, so a press
 * meant for one never lands on another; Escape and a press outside close
 * it; focus moves into the popover and back to its trigger; "Browse
 * values" only expands the list; choosing a value moves no button.
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

/**
 * A locator's box once it is laid out: the dashboard may still re-render
 * right after loading, when a box read at once can come back empty.
 */
async function boxOf(locator: Locator) {
  let box: Awaited<ReturnType<Locator["boundingBox"]>> = null;
  await expect
    .poll(async () => (box = await locator.boundingBox()))
    .not.toBeNull();
  return box!;
}

/**
 * The triggers' boxes once the filter bar's layout has settled (#685): web
 * fonts loaded, and the same boxes on two reads in a row. Read earlier,
 * while a font or label still swaps in, the bar can look unwrapped.
 */
async function settledBoxes(page: Page, triggers: Locator) {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  let previous = "",
    boxes: NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>[] = [];
  await expect
    .poll(
      async () => {
        const read = await triggers.evaluateAll((elements) =>
          elements.map((element) => {
            const { x, y, width, height } = element.getBoundingClientRect();
            return { x, y, width, height };
          }),
        );
        const key = JSON.stringify(read);
        const settled =
          read.length > 0 &&
          read.every((box) => box.width > 0 && box.height > 0) &&
          key === previous;
        previous = key;
        boxes = read;
        return settled;
      },
      { intervals: [50, 100, 100, 250] },
    )
    .toBe(true);
  return boxes;
}

/** The open popover overlaps none of the filter triggers. */
async function coversNoTrigger(popover: Locator, triggers: Locator) {
  const box = await boxOf(popover);
  for (const trigger of await triggers.all()) {
    const other = await boxOf(trigger);
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

  // 6. Choosing a value adds its chip but moves no button (#835): before,
  //    Done slid down under the new chip and a press where it had been
  //    landed on nothing, leaving the popover open.
  await app.click();
  const done = popover("App").getByRole("button", { name: t.done });
  const before = await boxOf(done);
  await popover("App")
    .getByRole("textbox", { name: "App", exact: true })
    .fill("Example app");
  await page.keyboard.press("Enter");
  await expect(
    popover("App").locator(".dashboard-filter-chips button"),
  ).toHaveCount(1);
  expect(await boxOf(done)).toEqual(before);
  await page.mouse.click(
    before.x + before.width / 2,
    before.y + before.height / 2,
  );
  await expect(popovers).toHaveCount(0);
  await expect(app).not.toContainText(t.allValues);
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
    // The bar wraps: find a trigger on a lower row than the first, once
    // the layout has settled.
    const first = triggers.first();
    const boxes = await settledBoxes(page, triggers);
    const firstBox = boxes[0]!;
    const lower = boxes.findIndex(
      (box) => box.y >= firstBox.y + firstBox.height,
    );
    const second: Locator | null = lower > 0 ? triggers.nth(lower) : null;
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

test("adding a shared filter in the Studio leaves the page in place", async ({
  page,
}, testInfo) => {
  // The exit gate's window (#835): the Studio's columns each scroll; the
  // page itself must not. Before, the hidden labels of every filter's
  // value field made the page taller than the window, so a control scrolled
  // into view took the whole page with it: the top bar went out of sight
  // and a blank band showed below.
  const locale = testInfo.project.name as Locale;
  const t = labels(locale).dashboard;
  const { workspaceId } = await startWorkspace(page, locale);
  const { dashboardId } = await installWithConnections(page, workspaceId);
  await page.setViewportSize({ width: 1372, height: 900 });
  await page.goto(
    `/workspaces/${workspaceId}/dashboards/${dashboardId}/studio`,
  );
  const add = page.getByRole("button", { name: t.addFilter, exact: true });
  await expect(add).toBeVisible();
  const filters = page.locator(".studio-inspector fieldset legend");
  const before = await filters.count();
  await add.click();
  await expect(filters).not.toHaveCount(before);
  const page_ = () =>
    page.evaluate(() => ({
      scrollY: window.scrollY,
      overflow: document.documentElement.scrollHeight - window.innerHeight,
    }));
  await expect.poll(page_).toEqual({ scrollY: 0, overflow: 0 });
  // The newest filter's name field scrolls into the inspector, not the page.
  await page.locator(".studio-inspector input").last().focus();
  await expect.poll(page_).toEqual({ scrollY: 0, overflow: 0 });
});
