import {
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
 * How many parts of a measure tile's freshness line are on its one visible
 * line, as drawn and with the day worded the other way (named or plain),
 * measured in place on a copy.
 */
async function visibleParts(line: Locator, named: RegExp, plainDay: string) {
  return line.evaluate(
    (element, { named, plainDay }) => {
      const count = (p: Element) => {
        const parts = [...p.children] as HTMLElement[];
        const top = parts[0]?.offsetTop;
        return parts.filter((part) => part.offsetTop === top).length;
      };
      const shown = count(element);
      const copy = element.cloneNode(true) as HTMLElement;
      const first = copy.children[0] as HTMLElement;
      const text = first.textContent ?? "";
      const pattern = new RegExp(named);
      const isNamed = pattern.test(text);
      // The plain wording of the same day; a plain line is copied as it is.
      first.textContent = isNamed ? text.replace(pattern, plainDay) : text;
      copy.style.position = "absolute";
      copy.style.visibility = "hidden";
      copy.style.width = `${element.getBoundingClientRect().width}px`;
      element.after(copy);
      const plain = count(copy);
      copy.remove();
      return { shown, plain, isNamed, total: element.children.length };
    },
    { named: named.source, plainDay },
  );
}

// Two zones: the wording must not depend on where the journey runs.
for (const timezoneId of ["Europe/Berlin", "Asia/Dhaka"]) {
  test.describe(timezoneId, () => {
    test.use({ timezoneId });
    test(
      "widgets and the connection page say how far the data reaches",
      journey,
    );
  });
}

async function journey(
  { page }: { page: Page },
  testInfo: TestInfo,
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
      const drawn = await visibleParts(line, w.named, w.plainDay);
      expect(drawn.plain, title).toBeGreaterThan(0);
      expect(drawn.shown, `${title} ${JSON.stringify(drawn)}`).toBe(
        drawn.plain,
      );
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
    for (const [property, value] of [
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
  const wide = await visibleParts(periodic, w.named, w.plainDay);
  expect(wide).toEqual({ shown: 3, plain: 3, isNamed: true, total: 3 });
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
}
