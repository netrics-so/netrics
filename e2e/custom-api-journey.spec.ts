import { expect, test, type Page } from "@playwright/test";

import { customApiDe } from "../apps/web/src/messages/custom-api/de.ts";
import { customApiEn } from "../apps/web/src/messages/custom-api/en.ts";
import { sourcesDe } from "../apps/web/src/messages/sources/de.ts";
import { sourcesEn } from "../apps/web/src/messages/sources/en.ts";
import { formatMessage } from "../packages/domain/src/i18n/message-format.ts";
import { CUSTOM_API_ORIGIN } from "./support/custom-api-origin.ts";
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
