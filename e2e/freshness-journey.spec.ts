import {
  chromium,
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import postgres from "postgres";

import { createModel } from "./support/api.ts";
import { type Locale } from "./support/labels.ts";
import { ORIGIN } from "./support/origin.ts";
import { startWorkspace } from "./support/session.ts";
import { ownerUrl } from "./support/store-template.ts";

// How far the numbers reach (ADR 0025 section 8, #705): a dashboard shows
// a periodic stream's footer ("Up to Nov 15 · fetched 10 min. ago · next
// ~9:00 PM") and a continuous one's ("Checked 10 min. ago · next check
// ~2:30 PM"), a signed-in metric widget the same line from its live query
// (#727), and the connection's page lists its streams by name. The
// freshness rows are seeded as a succeeded sync leaves them. The sales
// report reaches a day older than the day of the check, so a tile with room
// names it ("Last reporting day: Nov 15 · …", #791) and a narrow one shows
// the line as it was. The browser's clock and time zone are pinned, and
// the freshness rows are seeded around that clock, so the wording does not
// depend on when or where the journey runs.

const CONNECTOR = "app-store-connect";
const HOUR = 3_600_000;
const MINUTE = 60_000;

/** The UTC day before `now`, as a provider's YYYY-MM-DD. */
const yesterday = (now: number) =>
  new Date(now - 24 * HOUR).toISOString().slice(0, 10);
/**
 * The browser's clock on the dashboards, fixed: Friday, 13 Feb 2026, 11:00
 * in Berlin and 16:00 in Dhaka, the zones the journey runs in. The
 * freshness rows are moved around it (`pinFreshness`): checked 10 minutes
 * before, the next report three hours later (the same day in both zones),
 * the reports reaching 11 Feb. The connection's page, which the server
 * words first, is read before that, by the real clock.
 */
const CLOCK = Date.parse("2026-02-13T10:00:30Z");
const REPORTING_DAY = "2026-02-11";

/** Two UTC days back: before the day of the check in every time zone. */
const reportingDay = (now: number) =>
  new Date(now - 48 * HOUR).toISOString().slice(0, 10);

/**
 * An App Store Connect connection that synced 10 minutes ago, with a
 * downloads and a reviews number for yesterday, and its `sales` (periodic)
 * and `reviews` (continuous) streams as that sync reported them. Answers
 * the connection and the two metrics' definition ids.
 */
async function seedConnection(workspaceId: string, now: number) {
  const sql = postgres(ownerUrl(), { max: 1, onnotice: () => {} });
  try {
    const [connection] = await sql<{ id: string }[]>`
      insert into connections (workspace_id, connector_id, name, setup_pending)
      values (${workspaceId}, ${CONNECTOR}, 'Apple team', false)
      returning id`;
    const id = connection!.id;
    const checked = new Date(now - 10 * MINUTE);
    await sql`
      insert into connection_state (connection_id, workspace_id,
        last_success_at, poll_interval_seconds, next_due_at)
      values (${id}, ${workspaceId}, ${checked}, 21600,
        ${new Date(now + 40 * MINUTE)})`;
    const definitions = await sql<{ id: string; key: string }[]>`
      select id, key from metric_definitions
      where connector_id = ${CONNECTOR}
        and (key like '%.downloads' or key like '%.reviews')`;
    const downloads = definitions.find((d) => d.key.endsWith(".downloads"));
    const reviews = definitions.find((d) => d.key.endsWith(".reviews"));
    expect(downloads, "downloads metric").toBeDefined();
    expect(reviews, "reviews metric").toBeDefined();
    for (const [definition, value] of [
      [downloads!.id, 42],
      [reviews!.id, 3],
    ] as const)
      await sql`
        insert into observations (workspace_id, connection_id,
          metric_definition_id, dimensions, source_timestamp, value)
        values (${workspaceId}, ${id}, ${definition},
          ${sql.json({ resource: "1" })},
          ${`${yesterday(now)}T00:00:00Z`}::timestamptz, ${value})`;
    // Sales: the reports reach two days before the check; the next is due
    // in three hours.
    await sql`
      insert into connection_freshness (workspace_id, connection_id, stream,
        resource, data_through, time_zone, next_expected_at, checked_at,
        advanced_at)
      values (${workspaceId}, ${id}, 'sales', '', ${reportingDay(now)},
        'America/Los_Angeles', ${new Date(now + 3 * HOUR)}, ${checked},
        ${checked})`;
    // Reviews: read by that sync, nothing to expect.
    await sql`
      insert into connection_freshness (workspace_id, connection_id, stream,
        resource, checked_at)
      values (${workspaceId}, ${id}, 'reviews', '', ${checked})`;
    return {
      connectionId: id,
      downloads: downloads!.id,
      downloadsKey: downloads!.key,
      reviews: reviews!.id,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Moves the connection's freshness rows around the browser's fixed clock,
 * so the dashboards word the same line on every run. The connection's own
 * state stays on the real clock, which its status and the scheduler go by.
 */
async function pinFreshness(
  connectionId: string,
  reportingDay: string = REPORTING_DAY,
) {
  const sql = postgres(ownerUrl(), { max: 1, onnotice: () => {} });
  try {
    const checked = new Date(CLOCK - 10 * MINUTE);
    await sql`
      update connection_freshness
      set checked_at = ${checked}, advanced_at = ${checked}
      where connection_id = ${connectionId}`;
    await sql`
      update connection_freshness
      set data_through = ${reportingDay},
        next_expected_at = ${new Date(CLOCK + 3 * HOUR)}
      where connection_id = ${connectionId} and stream = 'sales'`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** A published model summing one metric's observations. */
async function metricModel(
  page: Page,
  workspaceId: string,
  name: string,
  datasetId: string,
): Promise<string> {
  const modelId = await createModel(page, workspaceId, {
    name,
    definition: {
      version: 1,
      datasets: [datasetId],
      relationships: [],
      dimensions: [
        {
          id: "day",
          name: "Day",
          datasetId,
          fieldId: "time",
          timeAlignment: "reporting_date",
        },
      ],
      measures: [
        {
          id: "total",
          name,
          kind: "aggregate",
          datasetId,
          aggregate: { id: "total", name, op: "sum", fieldId: "value" },
        },
      ],
    },
  } as Parameters<typeof createModel>[2]);
  const published = await page.request.post(
    `/v1/workspaces/${workspaceId}/data/models/${modelId}/publish`,
    { headers: { origin: ORIGIN }, data: { version: 1 } },
  );
  expect(published.status(), await published.text()).toBe(200);
  return modelId;
}

const measureWidget = (x: number, title: string, modelId: string) => ({
  type: "measure",
  title,
  x,
  y: 0,
  w: 6,
  h: 4,
  binding: { modelId, measureIds: ["total"], groupBy: [], exclusions: [] },
  options: { view: "value", limit: 20 },
});

const wording = {
  en: {
    periodic:
      /^Last reporting day: \w{3} \d{1,2} · fetched 10 min\. ago · next ~\d/,
    metricDay: /^(?:Last reporting day:|Up to) \w{3} \d{1,2}/,
    scrollView: "Scroll view",
    screenView: "Screen view",
    namedDay: "Last reporting day: ",
    sept30: "Sep 30",
    named: /^Last reporting day: /,
    cardDay: /^Last reporting day: Sep 30 · fetched 10 min\. ago · next ~\d/,
    plainDay: "Up to ",
    continuous: /^Checked \d+ min\. ago · next check [^~]*~/,
    metric:
      /^(?:Last reporting day:|Up to) \w{3} \d{1,2} · fetched \d+ min\. ago/,
    title: "Data freshness",
    sales: /^Sales up to \w{3} \d{1,2} · next [^~]*~/,
    reviews: /^Reviews checked \d+ min\. ago · next check [^~]*~/,
    notChecked: /not checked yet$/,
    oldest: "Oldest source refresh",
  },
  de: {
    periodic:
      /^Letzter Berichtstag: \d{1,2}\. \S+ · abgerufen vor 10 Min\. · nächste ~\d/,
    metricDay: /^(?:Letzter Berichtstag:|Bis) \d{1,2}\. \S+/,
    scrollView: "Scroll-Ansicht",
    screenView: "Bildschirm-Ansicht",
    namedDay: "Letzter Berichtstag: ",
    sept30: "30. Sept.",
    named: /^Letzter Berichtstag: /,
    cardDay:
      /^Letzter Berichtstag: 30\. Sept\. · abgerufen vor 10 Min\. · nächste ~\d/,
    plainDay: "Bis ",
    continuous: /^Geprüft vor \d+ Min\. · nächste Prüfung [^~]*~/,
    metric:
      /^(?:Letzter Berichtstag:|Bis) \d{1,2}\. \S+ · abgerufen vor \d+ Min\./,
    title: "Datenstand",
    sales: / bis \d{1,2}\. \S+ · nächste [^~]*~/,
    reviews: / geprüft vor \d+ Min\. · nächste Prüfung [^~]*~/,
    notChecked: /noch nicht geprüft$/,
    oldest: "Älteste Quellenaktualisierung",
  },
} as const;

/**
 * Which parts of a measure tile's freshness line are fully visible: inside
 * the line's box on all four sides, so neither on the hidden second line
 * nor cut at the right edge or at the bottom. As drawn, and for both
 * wordings of the day (named and plain), each measured in place on a copy
 * of the line at its layout width. The copies live where the line does, so
 * every rect is in the same space, also in a scaled preview.
 */
async function visibleParts(
  line: Locator,
  wording: { named: RegExp; namedDay: string; plainDay: string },
) {
  return line.evaluate(
    (element, { named, namedDay, plainDay }) => {
      const visible = (p: Element) => {
        const box = p.getBoundingClientRect();
        // Half a layout pixel, as the browser lays out: in a scaled
        // preview a drawn pixel is several of them.
        const layout = p as HTMLElement;
        const x =
          0.5 * (layout.offsetWidth ? box.width / layout.offsetWidth : 1);
        const y =
          0.5 * (layout.offsetHeight ? box.height / layout.offsetHeight : 1);
        return ([...p.children] as HTMLElement[]).map((part) => {
          const rect = part.getBoundingClientRect();
          return (
            rect.left >= box.left - x &&
            rect.right <= box.right + x &&
            rect.top >= box.top - y &&
            rect.bottom <= box.bottom + y
          );
        });
      };
      const text = element.children[0]!.textContent ?? "";
      const pattern = new RegExp(named);
      const isNamed = pattern.test(text);
      const day = isNamed
        ? text.replace(pattern, "")
        : text.slice(plainDay.length);
      const worded = (first: string) => {
        const copy = element.cloneNode(true) as HTMLElement;
        copy.children[0]!.textContent = first;
        copy.style.position = "absolute";
        copy.style.visibility = "hidden";
        // The layout width: not the drawn one, which a transform scales.
        copy.style.width = `${(element as HTMLElement).offsetWidth}px`;
        element.after(copy);
        const parts = visible(copy);
        copy.remove();
        return parts;
      };
      return {
        shown: visible(element),
        plain: worded(plainDay + day),
        named: worded(namedDay + day),
        isNamed,
        first: text,
      };
    },
    {
      named: wording.named.source,
      namedDay: wording.namedDay,
      plainDay: wording.plainDay,
    },
  );
}

/**
 * The rule as drawn: every part the plain wording shows whole, the line
 * shows whole; and its first part, the day, is never cut. And the day is
 * named exactly where that holds: not withheld where there is room.
 */
function expectNothingLost(
  drawn: Awaited<ReturnType<typeof visibleParts>>,
  where: string,
) {
  const message = `${where} ${JSON.stringify(drawn)}`;
  expect(drawn.plain[0], message).toBe(true);
  drawn.plain.forEach((whole, index) => {
    if (whole) expect(drawn.shown[index], message).toBe(true);
  });
  expect(drawn.isNamed, message).toBe(
    drawn.named[0] === true &&
      drawn.plain.every((whole, index) => !whole || drawn.named[index]),
  );
}

/** The time zone the page words its times in. */
const resolvedZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// Two zones: the wording must not depend on where the journey runs.
for (const timezoneId of ["Europe/Berlin", "Asia/Dhaka"]) {
  test.describe(timezoneId, () => {
    test.use({ timezoneId });
    test("widgets and the connection page say how far the data reaches", ({
      page,
    }, testInfo) => journey({ page }, testInfo, timezoneId));
  });
}

async function journey(
  { page }: { page: Page },
  testInfo: TestInfo,
  timezoneId: string,
): Promise<void> {
  const locale = testInfo.project.name as Locale;
  const w = wording[locale];
  const { workspaceId } = await startWorkspace(page, locale);
  const now = Date.now();
  const seeded = await seedConnection(workspaceId, now);

  // The connection's page lists every stream by name.
  await page.goto(
    `/workspaces/${workspaceId}/connections/${seeded.connectionId}`,
  );
  const card = page.locator("#freshness");
  await expect(card.getByRole("heading", { name: w.title })).toBeVisible();
  const lines = card.getByTestId("freshness-line");
  await expect(lines.filter({ hasText: w.sales })).toHaveCount(1);
  await expect(lines.filter({ hasText: w.reviews })).toHaveCount(1);
  // Streams no sync has reported yet (analytics, listing ratings).
  await expect(lines.filter({ hasText: w.notChecked })).toHaveCount(2);
  await testInfo.attach(`connection-${locale}`, {
    body: await card.screenshot(),
    contentType: "image/png",
  });

  // The dashboards, on the pinned clock.
  await pinFreshness(seeded.connectionId);
  await page.clock.setFixedTime(CLOCK);
  expect(await page.evaluate(resolvedZone)).toBe(timezoneId);
  const downloads = await metricModel(
    page,
    workspaceId,
    "Downloads",
    `observation:${seeded.connectionId}:${seeded.downloads}`,
  );
  const reviews = await metricModel(
    page,
    workspaceId,
    "Reviews",
    `observation:${seeded.connectionId}:${seeded.reviews}`,
  );
  const slides = [
    {
      widgets: [
        measureWidget(0, "Downloads", downloads),
        measureWidget(6, "Reviews", reviews),
        // The control: its data loses its freshness on the way (#769).
        {
          ...measureWidget(6, "Without freshness", downloads),
          x: 4,
          y: 4,
          w: 4,
        },
        // Too narrow to name the day: the line as it was (#791).
        { ...measureWidget(8, "Narrow", downloads), y: 4, w: 4 },
        // A signed-in metric widget: its live query's freshness (#727).
        {
          type: "metric",
          title: "Downloads metric",
          x: 0,
          y: 4,
          w: 4,
          h: 4,
          connectionId: seeded.connectionId,
          metricKey: seeded.downloadsKey,
          period: "last_7_days",
        },
      ],
    },
  ];
  const created = await page.request.post(
    `/v1/workspaces/${workspaceId}/dashboards`,
    { headers: { origin: ORIGIN }, data: { name: "Freshness", slides } },
  );
  expect(created.status(), await created.text()).toBe(200);
  const { dashboard } = (await created.json()) as {
    dashboard: {
      id: string;
      slides: { widgets: { id: string; title?: string | null }[] }[];
    };
  };
  const dashboardId = dashboard.id;
  const control = dashboard.slides
    .flatMap((slide) => slide.widgets)
    .find((widget) => widget.title === "Without freshness")?.id;
  expect(control, "control widget").toBeDefined();

  // No journey seeds data generations, so the API sends no oldest source
  // refresh here; the widgets' data gets one, as a connector's synced
  // dataset gives it, and the control widget loses its freshness (#769).
  let injected = 0;
  await page.route("**/dashboards/data/preview", async (route) => {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const body = (await response.json()) as {
      widgets: {
        widgetId: string;
        freshness?: { nextCheckAt?: string };
        result?: { receivedAt?: string | null } | null;
      }[];
    };
    for (const widget of body.widgets) {
      if (widget.result) {
        widget.result.receivedAt = new Date(now - 72 * HOUR).toISOString();
        injected += 1;
      }
      if (widget.widgetId === control) delete widget.freshness;
      // The next sync is scheduled by the real clock; on the browser's it
      // is 40 minutes ahead.
      else if (widget.freshness?.nextCheckAt)
        widget.freshness.nextCheckAt = new Date(
          CLOCK + 40 * MINUTE,
        ).toISOString();
    }
    await route.fulfill({ response, json: body });
  });

  // Naming the day never costs a part a tile shows with the plain wording,
  // as the browser draws it (not as the fit estimates it): each measure
  // tile shows as many parts as "Up to …" has room for, and the metric
  // tile's footer is whole, never cut by an ellipsis for the longer wording.
  const drawnAsBefore = async () => {
    for (const title of ["Downloads", "Narrow"]) {
      const line = widget(title).locator(".sw-measure-freshness");
      await expect(line).toHaveAttribute("title", /~\d/);
      const drawn = await visibleParts(line, w);
      expectNothingLost(drawn, title);
    }
    const footer = page.locator("article.sw-metric .sw-footer").first();
    await expect(footer).toHaveText(w.metricDay);
    expect(
      await footer.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return (
          range.getBoundingClientRect().width -
          element.getBoundingClientRect().width
        );
      }),
    ).toBeLessThanOrEqual(0.5);
    // A named footer the browser would cut gives way to the plain line of
    // the same parts, and comes back when there is room again: when its
    // box gets narrower, and when its font gets larger in the same box (a
    // theme with a larger font scale, a larger default font size). Each
    // change settles in a bounded number of redraws.
    const text = (await footer.textContent()) ?? "";
    if (!w.named.test(text)) return false;
    const plain = text.replace(w.named, w.plainDay);
    await footer.evaluate((element) => {
      const counter = { redraws: 0 };
      new MutationObserver((records) => {
        counter.redraws += records.length;
      }).observe(element, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      (window as unknown as { footerRedraws: typeof counter }).footerRedraws =
        counter;
    });
    const redraws = () =>
      page.evaluate(() => {
        const counter = (
          window as unknown as { footerRedraws: { redraws: number } }
        ).footerRedraws;
        const count = counter.redraws;
        counter.redraws = 0;
        return count;
      });
    // Twice each: the named line comes back every time, not only the
    // first time a size is seen.
    for (const [property, value] of [
      ["width", "150px"],
      ["fontSize", "64px"],
      ["width", "150px"],
      ["fontSize", "64px"],
    ] as const) {
      await footer.evaluate(
        (element, [property, value]) => {
          element.style[property] = value;
        },
        [property, value] as const,
      );
      await expect(footer, property).toHaveText(plain);
      await page.waitForTimeout(250);
      expect(await redraws(), `redraws after ${property}`).toBeLessThanOrEqual(
        3,
      );
      await footer.evaluate((element, property) => {
        element.style[property] = "";
      }, property);
      await expect(footer, property).toHaveText(text);
      await page.waitForTimeout(250);
      expect(await redraws(), `redraws after ${property}`).toBeLessThanOrEqual(
        3,
      );
    }
    // The font grows while the footer's box stays as it is (a short tile
    // whose flex layout holds the line's size): the named line no longer
    // fits and gives way, though nothing about the box changed.
    await footer.evaluate((element) => {
      const box = element.getBoundingClientRect();
      element.style.width = `${box.width}px`;
      element.style.height = `${box.height}px`;
      element.style.flex = "none";
    });
    const larger = await page.addStyleTag({
      content:
        "article.sw-metric .sw-footer, article.sw-metric .sw-font-sentinel" +
        " { font-size: 48px !important; }",
    });
    expect(
      await footer.evaluate((element) => getComputedStyle(element).fontSize),
    ).toBe("48px");
    await expect(footer, "a larger font in the same box").toHaveText(plain);
    await larger.evaluate((style) => (style as HTMLElement).remove());
    await expect(footer, "the font as before").toHaveText(text);
    await footer.evaluate((element) => {
      element.style.width = "";
      element.style.height = "";
      element.style.flex = "";
    });
    return true;
  };

  // The dashboard: a periodic and a continuous footer, muted.
  await page.goto(`/workspaces/${workspaceId}/dashboards/${dashboardId}`);
  const widget = (title: string) =>
    page.locator("article.sw-measure").filter({
      has: page.getByRole("heading", { name: title, exact: true }),
    });
  const periodic = widget("Downloads").locator(".sw-measure-freshness");
  const continuous = widget("Reviews").locator(".sw-measure-freshness");
  await expect(widget("Downloads").locator(".sw-measure-value")).toHaveText(
    /42/,
  );
  // The day is older than the day of the check: named, and on one line.
  await expect(periodic).toHaveAttribute("title", w.periodic);
  await expect(periodic).toHaveText(w.periodic);
  const box = await periodic.evaluate((line) => ({
    line: line.getBoundingClientRect().bottom,
    parts: [...line.children].map(
      (part) => part.getBoundingClientRect().bottom,
    ),
  }));
  expect(box.parts.length).toBe(3);
  for (const bottom of box.parts)
    expect(bottom).toBeLessThanOrEqual(box.line + 1);
  const wide = await visibleParts(periodic, w);
  expect(wide.isNamed).toBe(true);
  expect(wide.shown).toEqual([true, true, true]);
  await drawnAsBefore();
  await expect(continuous).toHaveAttribute("title", w.continuous);
  await expect(periodic).not.toHaveClass(/sw-notice/);
  // The freshness line replaces the oldest source refresh, as on tvOS
  // (#769); the control without freshness shows it, so the injected value
  // did reach the page.
  await expect(
    widget("Without freshness").getByText(w.oldest, { exact: false }),
  ).toHaveCount(1);
  await expect(
    widget("Without freshness").locator(".sw-measure-freshness"),
  ).toHaveCount(0);
  expect(injected, "widget data with a result").toBeGreaterThan(0);
  for (const title of ["Downloads", "Reviews"])
    await expect(widget(title).getByText(w.oldest)).toHaveCount(0);
  // The metric widget's footer comes from its live query, as on screens.
  const metric = page.locator("article.sw-metric").filter({
    has: page.getByRole("heading", { name: "Downloads metric", exact: true }),
  });
  await expect(metric.locator(".sw-value")).toHaveText(/42/);
  await expect(metric.locator(".sw-footer")).toHaveText(w.metric);
  await expect(metric.locator(".sw-notice")).toHaveCount(0);
  await testInfo.attach(`dashboard-${locale}`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });

  // Studio's device preview: the slide at a device's real size, scaled
  // into its frame by a transform. The wording is the one that screen
  // shows: both are measured at the same width, whatever the scale.
  let footersSqueezed = 0;
  const previews = async (id: string) => {
    await page.goto(`/workspaces/${workspaceId}/dashboards/${id}/studio`);
    for (const target of ["21x9", "4x3"]) {
      await page.locator(`[role="tab"][data-target="${target}"]`).click();
      const viewport = page.locator(".device-viewport");
      await expect(viewport).toBeVisible();
      const scale = await viewport.evaluate(
        (element) =>
          element.getBoundingClientRect().width /
          (element as HTMLElement).offsetWidth,
      );
      expect(scale, target).toBeLessThan(0.95);
      expect(scale, target).toBeGreaterThan(0);
      const previewLines = viewport.locator(
        "article.sw-measure .sw-measure-freshness",
      );
      await expect(previewLines.first()).toHaveAttribute("title", /~\d/);
      let periodicLines = 0;
      for (const line of await previewLines.all()) {
        if (!/~\d/.test((await line.getAttribute("title")) ?? "")) continue;
        if ((await line.locator("span").count()) < 3) continue;
        periodicLines += 1;
        const where = `${target} preview at scale ${scale.toFixed(2)}`;
        const drawn = await visibleParts(line, w);
        expectNothingLost(drawn, where);
        if (!drawn.isNamed || drawn.shown.includes(false)) continue;
        // The named line a layout pixel and a half too narrow for its last
        // part: less than half a drawn pixel at this scale, but the browser
        // lays out in layout pixels and drops the part. The plain wording
        // still shows all three, so the tile goes back to it.
        const named = (await line.getAttribute("title"))!;
        await line.evaluate((element) => {
          const layout = element as HTMLElement;
          const scale =
            element.getBoundingClientRect().width / layout.offsetWidth;
          const parts = [...element.children].reduce(
            (sum, part) => sum + part.getBoundingClientRect().width / scale,
            0,
          );
          element.parentElement!.style.width = `${parts - 1.5}px`;
        });
        await expect(line, where).not.toHaveAttribute("title", w.named);
        const narrow = await visibleParts(line, w);
        expect(narrow.plain, where).toEqual([true, true, true]);
        expect(narrow.named[2], where).toBe(false);
        expectNothingLost(narrow, where);
        await line.evaluate((element) => {
          element.parentElement!.style.width = "";
        });
        await expect(line, where).toHaveAttribute("title", named);
      }
      expect(periodicLines, target).toBeGreaterThan(0);
      // The same for a footer, which the browser ends with an ellipsis: a
      // named footer two layout pixels too narrow is less than half a drawn
      // pixel over at this scale, and still cut. The plain one fits.
      const previewFooter = viewport.locator("article.sw-metric .sw-footer");
      await expect(previewFooter).toHaveText(w.metricDay);
      const footerText = (await previewFooter.textContent()) ?? "";
      if (w.named.test(footerText)) {
        footersSqueezed += 1;
        const over = await previewFooter.evaluate((element) => {
          const layout = element as HTMLElement;
          const box = element.getBoundingClientRect();
          const scale = box.width / layout.offsetWidth;
          const range = document.createRange();
          range.selectNodeContents(element);
          const text = range.getBoundingClientRect().width / scale;
          // Up to two layout pixels over, and under half a drawn pixel.
          const layoutPixels = Math.min(2, 0.45 / scale);
          layout.style.width = `${text - layoutPixels}px`;
          layout.style.flex = "none";
          return { scale, layoutPixels, drawn: layoutPixels * scale };
        });
        expect(over.layoutPixels, JSON.stringify(over)).toBeGreaterThanOrEqual(
          1,
        );
        expect(over.drawn, JSON.stringify(over)).toBeLessThan(0.5);
        await expect(previewFooter, target).toHaveText(
          footerText.replace(w.named, w.plainDay),
        );
        await previewFooter.evaluate((element) => {
          (element as HTMLElement).style.width = "";
          (element as HTMLElement).style.flex = "";
        });
        await expect(previewFooter, target).toHaveText(footerText);
      }
    }
  };
  await previews(dashboardId);

  // The same slide at font scale 1.3, where the estimate and the drawn
  // widths differ most: the rule holds as drawn.
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
  const large = await page.request.post(
    `/v1/workspaces/${workspaceId}/dashboards`,
    {
      headers: { origin: ORIGIN },
      data: { name: "Freshness large", settings: { themeId: made.id }, slides },
    },
  );
  expect(large.status(), await large.text()).toBe(200);
  const largeId = ((await large.json()) as { dashboard: { id: string } })
    .dashboard.id;
  await page.goto(`/workspaces/${workspaceId}/dashboards/${largeId}`);
  await expect(widget("Downloads").locator(".sw-measure-value")).toHaveText(
    /42/,
  );
  expect(await drawnAsBefore(), "a named footer at this scale").toBe(true);
  await testInfo.attach(`dashboard-large-${locale}`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  // The previews again at this font scale, where the metric footer names
  // the day.
  await previews(largeId);
  expect(footersSqueezed, "a named footer in a preview").toBeGreaterThan(0);

  // The scroll view on a narrow phone with a large default font: a card
  // wraps, also inside a part, so "Letzter Berichtstag: 30. Sept." is
  // never cut where "Bis 30. Sept." fit.
  await pinFreshness(seeded.connectionId, "2025-09-30");
  const session = await page.context().newCDPSession(page);
  await session.send("Page.setFontSizes", {
    fontSizes: { standard: 32, fixed: 26 },
  });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`/workspaces/${workspaceId}/dashboards/${dashboardId}`);
  await page.getByRole("button", { name: w.scrollView, exact: true }).click();
  // The three measure cards with a line (two periodic, one continuous)
  // and the metric card's footer.
  const cardLines = page.locator(".sw-measure-freshness");
  await expect(cardLines).toHaveCount(3);
  await expect(page.locator(".sw-footer")).toHaveCount(1);
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).fontSize,
    ),
  ).toBe("32px");
  for (const line of [...(await cardLines.all()), page.locator(".sw-footer")]) {
    await expect(line).toBeVisible();
    const drawn = await line.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(element);
      const text = range.getBoundingClientRect();
      const cardBox = element.closest("article")!.getBoundingClientRect();
      return {
        text: element.textContent,
        // The text is inside its line, and the line inside its card. A
        // space that ends a wrapped line hangs past the edge unseen.
        space: parseFloat(getComputedStyle(element).fontSize) * 0.35,
        cutRight: text.right - box.right,
        cutBottom: text.bottom - box.bottom,
        outside: box.right - cardBox.right,
        scroll: element.scrollWidth - element.clientWidth,
      };
    });
    const where = JSON.stringify(drawn);
    expect(drawn.cutRight, where).toBeLessThanOrEqual(drawn.space);
    expect(drawn.cutBottom, where).toBeLessThanOrEqual(0.5);
    expect(drawn.outside, where).toBeLessThanOrEqual(0.5);
    expect(drawn.scroll, where).toBeLessThanOrEqual(1);
  }
  await expect(cardLines.first()).toHaveText(w.cardDay);
  await testInfo.attach(`scroll-320-${locale}`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });

  // A browser with a minimum font size (26 px here, for this tile's width;
  // reported at 18 px on a narrower one): on the narrow tile "Up
  // to Sep 30" fits its line, the named day is wider than the line. Both
  // would be "one part on the first line"; only the plain one is whole, so
  // the tile keeps it and the date is never cut.
  const minimum = await chromium.launch({
    args: ["--blink-settings=minimumFontSize=26,minimumLogicalFontSize=26"],
  });
  try {
    const context = await minimum.newContext({
      storageState: await page.context().storageState(),
      locale: locale === "de" ? "de-DE" : "en-US",
      // Launched by hand, it inherits nothing from the project.
      timezoneId,
      viewport: { width: 1280, height: 720 },
    });
    const tab = await context.newPage();
    await tab.clock.setFixedTime(CLOCK);
    expect(await tab.evaluate(resolvedZone)).toBe(timezoneId);
    await tab.goto(`/workspaces/${workspaceId}/dashboards/${dashboardId}`);
    // The scroll view was chosen above and is remembered: back to slides.
    await tab.getByRole("button", { name: w.screenView, exact: true }).click();
    const tile = (title: string) =>
      tab
        .locator("article.sw-measure")
        .filter({ has: tab.getByRole("heading", { name: title, exact: true }) })
        .locator(".sw-measure-freshness");
    await expect(tile("Narrow")).toHaveAttribute("title", /~\d/);
    expect(
      await tile("Narrow").evaluate((element) =>
        parseFloat(getComputedStyle(element).fontSize),
      ),
    ).toBe(26);
    const narrow = await visibleParts(tile("Narrow"), w);
    expectNothingLost(narrow, "Narrow at a minimum font size");
    // One line of text is whole at the font size in use, top to bottom.
    expect(narrow.shown[0], JSON.stringify(narrow)).toBe(true);
    expect(
      await tile("Narrow").evaluate((element) => {
        const box = element.getBoundingClientRect();
        const day = element.children[0]!.getBoundingClientRect();
        return {
          above: box.top - day.top,
          below: day.bottom - box.bottom,
        };
      }),
    ).toEqual({ above: expect.closeTo(0, 0), below: expect.closeTo(0, 0) });
    // The case itself: the plain day is whole, the named one would not be.
    expect(narrow.isNamed, JSON.stringify(narrow)).toBe(false);
    expect(narrow.first).toBe(w.plainDay + w.sept30);
    const named = await tile("Narrow").evaluate((element, text) => {
      const copy = element.cloneNode(true) as HTMLElement;
      copy.children[0]!.textContent = text;
      copy.style.position = "absolute";
      copy.style.visibility = "hidden";
      copy.style.width = `${element.getBoundingClientRect().width}px`;
      element.after(copy);
      const cut =
        copy.children[0]!.getBoundingClientRect().right -
        copy.getBoundingClientRect().right;
      copy.remove();
      return cut;
    }, w.namedDay + w.sept30);
    expect(named, "the named day is wider than the line").toBeGreaterThan(0.5);
    expectNothingLost(
      await visibleParts(tile("Downloads"), w),
      "Downloads at a minimum font size",
    );
    // A wide, short metric tile at that font size: the named footer fits
    // across, but the tile has no room for a line that high and its box
    // is shorter than the text. A footer cut like that is not named: the
    // tile keeps the plain line, as it did before.
    const made = await page.request.post(
      `/v1/workspaces/${workspaceId}/dashboards`,
      {
        headers: { origin: ORIGIN },
        data: {
          name: "Wide",
          slides: [
            {
              widgets: [
                {
                  type: "metric",
                  title: "Wide metric",
                  x: 0,
                  y: 0,
                  w: 12,
                  h: 2,
                  connectionId: seeded.connectionId,
                  metricKey: seeded.downloadsKey,
                  period: "last_7_days",
                },
              ],
            },
          ],
        },
      },
    );
    expect(made.status(), await made.text()).toBe(200);
    const wideId = ((await made.json()) as { dashboard: { id: string } })
      .dashboard.id;
    await tab.goto(`/workspaces/${workspaceId}/dashboards/${wideId}`);
    const wideFooter = tab.locator("article.sw-metric .sw-footer");
    await expect(wideFooter).toHaveText(
      new RegExp(`^${w.plainDay}${w.sept30.replace(".", "\\.")} · `),
    );
    const wide = await wideFooter.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const text = range.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return {
        // Room across for the named wording too; none down for a line.
        across: box.width - text.width,
        text: text.height,
        box: box.height,
      };
    });
    expect(wide.across, JSON.stringify(wide)).toBeGreaterThan(150);
    expect(wide.box, JSON.stringify(wide)).toBeLessThan(wide.text / 2);
    await testInfo.attach(`minimum-font-${locale}`, {
      body: await tab.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  } finally {
    await minimum.close();
  }
}
