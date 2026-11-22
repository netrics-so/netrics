import { expect, test, type Page } from "@playwright/test";
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
// the line as it was.

const CONNECTOR = "app-store-connect";
const HOUR = 3_600_000;
const MINUTE = 60_000;

/** The UTC day before `now`, as a provider's YYYY-MM-DD. */
const yesterday = (now: number) =>
  new Date(now - 24 * HOUR).toISOString().slice(0, 10);
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
    // Sales: the reports reach the day before yesterday; the next is due
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
      /^Last reporting day: \w{3} \d{1,2} · fetched \d+ min\. ago · next [^~]*~/,
    narrow: /^Up to \w{3} \d{1,2} · fetched \d+ min\. ago · next [^~]*~/,
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
      /^Letzter Berichtstag: \d{1,2}\. \S+ · abgerufen vor \d+ Min\. · nächste [^~]*~/,
    narrow: /^Bis \d{1,2}\. \S+ · abgerufen vor \d+ Min\. · nächste [^~]*~/,
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

test("widgets and the connection page say how far the data reaches", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const w = wording[locale];
  const { workspaceId } = await startWorkspace(page, locale);
  const now = Date.now();
  const seeded = await seedConnection(workspaceId, now);
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
  const created = await page.request.post(
    `/v1/workspaces/${workspaceId}/dashboards`,
    {
      headers: { origin: ORIGIN },
      data: {
        name: "Freshness",
        slides: [
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
        ],
      },
    },
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
        freshness?: unknown;
        result?: { receivedAt?: string | null } | null;
      }[];
    };
    for (const widget of body.widgets) {
      if (widget.result) {
        widget.result.receivedAt = new Date(now - 72 * HOUR).toISOString();
        injected += 1;
      }
      if (widget.widgetId === control) delete widget.freshness;
    }
    await route.fulfill({ response, json: body });
  });

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
  // A tile without room for that keeps the line it had, parts dropped
  // from the end by the stylesheet.
  await expect(
    widget("Narrow").locator(".sw-measure-freshness"),
  ).toHaveAttribute("title", w.narrow);
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
});
