import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { customApiDe } from "../apps/web/src/messages/custom-api/de.ts";
import { customApiEn } from "../apps/web/src/messages/custom-api/en.ts";
import { sourcesDe } from "../apps/web/src/messages/sources/de.ts";
import { sourcesEn } from "../apps/web/src/messages/sources/en.ts";
import { formatMessage } from "../packages/domain/src/i18n/message-format.ts";
import { CUSTOM_API_ORIGIN } from "./support/custom-api-origin.ts";
import { ORIGIN } from "./support/origin.ts";
import type { Locale } from "./support/labels.ts";
import { startWorkspace } from "./support/session.ts";

/** The fixture server's bearer token (FIXTURE_SECRETS.token). */
const TOKEN = "fx-bearer-token-0001";

const labels = (locale: Locale) =>
  ((locale === "de" ? customApiDe : customApiEn) as typeof customApiEn)
    .customApi;
const sources = (locale: Locale) =>
  ((locale === "de" ? sourcesDe : sourcesEn) as typeof sourcesEn).sources;

/** The page never holds the token once it was sent. */
async function noToken(page: Page) {
  expect(await page.content()).not.toContain(TOKEN);
}

/**
 * The custom API builder (#807) in the browser, in English and German: a
 * member builds a custom API against the local fixture server, signs in
 * with a bearer token, tests the request, picks the records and fields,
 * tests the cursor paging, and saves it with its first connection. The
 * token never shows on a page or in an answer of the custom API routes.
 */
test("a member builds, tests and connects a custom API", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const c = labels(locale);
  const s = sources(locale);
  const answers: Promise<string>[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/custom-api/"))
      answers.push(response.text().catch(() => ""));
  });

  const { workspaceId } = await startWorkspace(page, locale);
  await page.goto(`/workspaces/${workspaceId}/sources`);
  await page.getByRole("link", { name: s.customApi.buildName }).click();
  await expect(page).toHaveURL(/\/custom-apis\/new/);

  // 1. Basics
  await page.locator("#custom-api-name").fill("Shop API");
  await page.locator("#custom-api-base-url-0").fill(CUSTOM_API_ORIGIN);
  await page.getByRole("button", { name: c.nav.continue, exact: true }).click();

  // 2. Login: the draft is created now and kept in the URL.
  await expect(
    page.getByRole("heading", { name: c.steps.login }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\?draft=[0-9a-f-]{36}/);
  await page.getByLabel(c.login.methods.bearer).check();
  await page.locator("#custom-api-secret-token").fill(TOKEN);
  await page.getByRole("button", { name: c.login.save }).click();
  await expect(page.getByText(c.login.secretSaved)).toBeVisible();
  await noToken(page);
  await page.getByRole("button", { name: c.nav.continue, exact: true }).click();

  // 3. Request
  await expect(
    page.getByRole("heading", { name: c.steps.request }),
  ).toBeVisible();
  await page.locator("#custom-api-path").fill("/builder/stats");
  const query = page.locator("fieldset", {
    has: page.locator("legend", { hasText: c.request.query }),
  });
  for (const [index, [name, value]] of [
    ["from", "{{window.start}}"],
    ["to", "{{window.end}}"],
  ].entries()) {
    await query.getByRole("button", { name: c.request.addRow }).click();
    await page
      .getByLabel(`${c.request.query} ${index + 1}: ${c.request.name}`)
      .fill(name!);
    await page
      .getByLabel(`${c.request.query} ${index + 1}: ${c.request.value}`)
      .fill(value!);
  }
  await page.getByRole("button", { name: c.request.send }).click();
  const log = page.locator(".custom-api-log-entry");
  await expect(log).toHaveCount(1);
  await expect(log.first().locator("td").nth(2)).toHaveText("200");
  await expect(page.getByText(c.test.ok)).toBeVisible();
  await noToken(page);
  await page.getByRole("button", { name: c.nav.continue, exact: true }).click();

  // 4. Response: the record list, then the fields.
  await expect(
    page.getByRole("heading", { name: c.steps.response }),
  ).toBeVisible();
  await page.locator('[data-pick="data"]').click();
  await expect(
    page.getByText(
      formatMessage(locale, c.response.recordsAt, { path: "data", count: 3 }),
    ),
  ).toBeVisible();
  for (const path of ["date", "orders", "revenue.amount"])
    await page.getByRole("checkbox", { name: path, exact: true }).check();
  for (const type of [
    c.response.types.date,
    c.response.types.integer,
    c.response.types.decimal,
  ])
    await expect(
      page.getByText(formatMessage(locale, c.response.suggested, { type })),
    ).toBeVisible();
  await page.getByRole("button", { name: c.response.updatePreview }).click();
  await expect(
    page.getByRole("heading", {
      name: formatMessage(locale, c.response.preview, { count: 3 }),
    }),
  ).toBeVisible();
  await expect(page.locator(".data-table tbody tr")).toHaveCount(3);
  await noToken(page);
  await page.getByRole("button", { name: c.nav.continue, exact: true }).click();

  // 5. Paging: a cursor picked in the response.
  await expect(
    page.getByRole("heading", { name: c.steps.paging }),
  ).toBeVisible();
  await page.getByLabel(c.paging.styles.cursor).check();
  await page.locator('[data-pick="meta.next"]').click();
  await page.getByRole("button", { name: c.paging.test }).click();
  await expect(
    page.getByText(
      formatMessage(locale, c.paging.fetched, { pages: 2, records: 6 }),
    ),
  ).toBeVisible();
  await noToken(page);
  await page.getByRole("button", { name: c.nav.continue, exact: true }).click();

  // 6. Schedule and review, save and connect.
  await expect(
    page.getByRole("heading", { name: c.steps.review }),
  ).toBeVisible();
  await page.locator("#custom-api-refresh").fill("60");
  await page.locator("#custom-api-backfill").fill("30");
  await expect(
    page.getByText(
      formatMessage(locale, c.review.hosts, {
        hosts: new URL(CUSTOM_API_ORIGIN).host,
      }),
      { exact: false },
    ),
  ).toBeVisible();
  await noToken(page);
  await page.getByRole("button", { name: c.review.save }).click();
  await expect(page).toHaveURL(
    new RegExp(`/workspaces/${workspaceId}/connections/[0-9a-f-]{36}$`),
  );
  await expect(
    page.getByRole("heading", { name: "Shop API", exact: false }).first(),
  ).toBeVisible();
  await noToken(page);

  // Editing without the API's credentials: a schedule-only change saves a
  // new version (review #824).
  await page.goto(`/workspaces/${workspaceId}/custom-apis`);
  await page.getByRole("link", { name: c.list.edit }).click();
  await page.getByRole("button", { name: c.steps.review }).click();
  await page.locator("#custom-api-refresh").fill("30");
  await page.getByRole("button", { name: c.review.saveVersion }).click();
  await expect(page).toHaveURL(
    new RegExp(`/workspaces/${workspaceId}/custom-apis$`),
  );
  await expect(
    page.getByText(formatMessage(locale, c.list.version, { version: 2 })),
  ).toBeVisible();

  for (const body of await Promise.all(answers))
    expect(body).not.toContain(TOKEN);
});

/** The Task 12 result as a document: daily stats by cursor, bearer login. */
function shopDocument(withCurrency: boolean) {
  return {
    schemaVersion: 1,
    name: "Shop API",
    environments: [
      { id: "production", name: "Production", baseUrl: CUSTOM_API_ORIGIN },
    ],
    variables: [],
    auth: { type: "bearer" },
    defaults: { refreshMinutes: 60, timeZone: "UTC" },
    streams: [
      {
        key: "daily_stats",
        name: "Daily stats",
        request: {
          path: "/builder/stats",
          query: { from: "{{window.start}}", to: "{{window.end}}" },
        },
        pagination: {
          type: "cursor",
          cursorPath: "meta.next",
          param: "cursor",
        },
        records: "data",
        fields: [
          {
            id: "date",
            name: "Date",
            path: "date",
            type: "date",
            nullable: false,
          },
          { id: "orders", name: "Orders", path: "orders", type: "integer" },
          {
            id: "revenue_amount",
            name: "Revenue",
            path: "revenue.amount",
            type: "decimal",
          },
          ...(withCurrency
            ? [
                {
                  id: "revenue_currency",
                  name: "Currency",
                  path: "revenue.currency",
                  type: "string",
                },
              ]
            : []),
        ],
        keyFields: ["date"],
        mode: "upsert",
        reportingField: "date",
        window: {
          type: "date",
          stepDays: 31,
          lookbackDays: 3,
          backfillDays: 30,
          paramFormat: "date",
        },
      },
    ],
  };
}

/**
 * Versions, connection updates, export and import (#808), in English and
 * German: a saved custom API gets a second version; its connection is
 * offered the update and takes it; version 1 is restored as version 3;
 * the export holds no login; the file is imported into another workspace
 * and connected there.
 */
test("a member versions, updates, exports and imports a custom API", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const c = labels(locale);
  const t = (message: string, values: Record<string, unknown> = {}) =>
    formatMessage(locale, message, values);
  const { workspaceId } = await startWorkspace(page, locale);
  const base = `/v1/workspaces/${workspaceId}/custom-api/definitions`;
  const created = await page.request.post(base, {
    headers: { origin: ORIGIN },
    data: { document: shopDocument(false) },
  });
  expect(created.status(), await created.text()).toBe(201);
  const definitionId = (
    (await created.json()) as { definition: { id: string } }
  ).definition.id;
  const connected = await page.request.post(
    `${base}/${definitionId}/connections`,
    {
      headers: { origin: ORIGIN },
      data: {
        name: "Shop API",
        environmentId: "production",
        credentials: { token: TOKEN },
      },
    },
  );
  expect(connected.status(), await connected.text()).toBe(201);
  const connectionId = (
    (await connected.json()) as { connection: { id: string } }
  ).connection.id;
  // The edit: revenue.currency is ticked, saved as version 2.
  const saved = await page.request.post(`${base}/${definitionId}/versions`, {
    headers: { origin: ORIGIN },
    data: { baseVersion: 1, document: shopDocument(true) },
  });
  expect(saved.status(), await saved.text()).toBe(201);

  // History: versions 1 and 2 with the member's name.
  const definitionPage = `/workspaces/${workspaceId}/custom-apis/${definitionId}`;
  await page.goto(definitionPage);
  const history = page.locator(".custom-api-history");
  for (const version of [1, 2])
    await expect(
      history.locator(`li[data-version="${version}"]`),
    ).toContainText(`Version ${version} · Journey ${locale} · `);
  await expect(page.locator(".custom-api-connections")).toContainText(
    c.connections.updateAvailable,
  );

  // The connection is offered the update, reviews and takes it.
  const connectionPage = `/workspaces/${workspaceId}/connections/${connectionId}`;
  await page.goto(connectionPage);
  const banner = page.locator(".custom-api-update-banner");
  await expect(banner).toContainText(
    t(c.update.banner, { name: "Shop API", version: 2 }),
  );
  await banner.getByRole("link", { name: c.update.review }).click();
  await expect(
    page.getByText(
      t(c.update.changes.field_added, {
        field: "revenue_currency",
        stream: "Daily stats",
      }),
    ),
  ).toBeVisible();
  await expect(page.getByText(c.update.login.kept)).toBeVisible();
  await page.getByRole("button", { name: c.update.apply }).click();
  await expect(page.getByText(t(c.update.done, { version: 2 }))).toBeVisible();
  await page.getByRole("link", { name: c.update.back }).click();
  await expect(page).toHaveURL(new RegExp(`${connectionPage}$`));
  await expect(page.getByRole("heading", { name: "Shop API" })).toBeVisible();
  await expect(page.locator(".custom-api-update-banner")).toHaveCount(0);

  // Restore version 1: it comes back as version 3.
  await page.goto(definitionPage);
  await history
    .locator('li[data-version="1"]')
    .getByRole("button", { name: c.history.restore })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    t(c.history.restoreConfirm, { version: 1 }),
  );
  await dialog.getByRole("button", { name: c.history.restore }).click();
  await expect(
    page.locator('.custom-api-history li[data-version="3"]'),
  ).toContainText(t(c.history.sameAs, { version: 1 }));

  // Export: the definition only, no login.
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: c.export.button }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("shop-api.netrics-api.json");
  const path = await download.path();
  const text = readFileSync(path, "utf8");
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain(connectionId);
  expect(text).not.toContain(workspaceId);
  const file = JSON.parse(text) as Record<string, unknown>;
  expect(file).toMatchObject({
    format: "netrics.custom-api-definition",
    schemaVersion: 1,
  });

  // Import it in another workspace, connect it there (exit gate 5 in
  // miniature).
  const other = await startWorkspace(page, locale);
  await page.goto(`/workspaces/${other.workspaceId}/custom-apis`);
  await page.locator("#custom-api-import-file").setInputFiles(path);
  await page.getByRole("button", { name: c.import.button }).click();
  await expect(page).toHaveURL(
    new RegExp(`/workspaces/${other.workspaceId}/custom-apis/[0-9a-f-]{36}$`),
  );
  await page.getByRole("link", { name: c.list.connect, exact: true }).click();
  await page.locator("#custom-api-connect-secret-token").fill(TOKEN);
  await page.getByRole("button", { name: c.connect.submit }).click();
  await expect(page).toHaveURL(
    new RegExp(`/workspaces/${other.workspaceId}/connections/[0-9a-f-]{36}`),
  );
  await expect(page.getByText("Shop API").first()).toBeVisible();
  await noToken(page);
});
