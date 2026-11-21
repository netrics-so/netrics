import { expect, test, type Page } from "@playwright/test";

import { customApiDe } from "../apps/web/src/messages/custom-api/de.ts";
import { customApiEn } from "../apps/web/src/messages/custom-api/en.ts";
import { CUSTOM_API_ORIGIN } from "./support/custom-api-origin.ts";
import type { Locale } from "./support/labels.ts";
import { startWorkspace } from "./support/session.ts";

/** The fixture server's OAuth client (FIXTURE_OAUTH_CLIENT). */
const CLIENT = {
  clientId: "fx-oauth-client",
  clientSecret: "fx-oauth-client-secret-0001",
};

const labels = (locale: Locale) =>
  ((locale === "de" ? customApiDe : customApiEn) as typeof customApiEn)
    .customApi;

// The authorize step runs on the fixture's self-signed https origin.
test.use({ ignoreHTTPSErrors: true });

/** Basics, then the OAuth login with the fixture's client, saved. */
async function oauthLogin(
  page: Page,
  locale: Locale,
  method: "oauth_authorization_code" | "oauth_client_credentials",
) {
  const c = labels(locale);
  const { workspaceId } = await startWorkspace(page, locale);
  // The OAuth redirect must not ask "Leave site?"; only leaving the
  // builder on purpose (`leave.allowed`) may.
  const leave = { allowed: false };
  page.on("dialog", (dialog) => {
    if (!leave.allowed) throw new Error(`Unexpected dialog: ${dialog.type()}`);
    void dialog.accept();
  });
  await page.goto(`/workspaces/${workspaceId}/custom-apis/new`);
  await page.locator("#custom-api-name").fill("Items API");
  await page.locator("#custom-api-base-url-0").fill(CUSTOM_API_ORIGIN);
  await page.getByRole("button", { name: c.nav.continue, exact: true }).click();
  await page.getByLabel(c.login.methods[method]).check();
  if (method === "oauth_authorization_code")
    await page
      .locator("#custom-api-authorize-url")
      .fill(`${CUSTOM_API_ORIGIN}/oauth/authorize`);
  await page
    .locator("#custom-api-token-url")
    .fill(`${CUSTOM_API_ORIGIN}/oauth/token`);
  await page.locator("#custom-api-scopes").fill("items.read");
  await page.locator("#custom-api-secret-clientId").fill(CLIENT.clientId);
  await page
    .locator("#custom-api-secret-clientSecret")
    .fill(CLIENT.clientSecret);
  await page.getByRole("button", { name: c.login.save }).click();
  await expect(page.getByText(c.login.secretSaved).first()).toBeVisible();
  return { workspaceId, leave };
}

/** Request step: the fixture's OAuth-protected items, tested. */
async function testItems(page: Page, locale: Locale) {
  const c = labels(locale);
  await page.getByRole("button", { name: c.nav.continue, exact: true }).click();
  await page.locator("#custom-api-path").fill("/oauth/api/items");
  await page.getByRole("button", { name: c.request.send }).click();
  await expect(page.getByText(c.test.ok)).toBeVisible();
  await expect(
    page.locator(".custom-api-log-entry").first().locator("td").nth(2),
  ).toHaveText("200");
  expect(await page.content()).not.toContain(CLIENT.clientSecret);
}

/**
 * OAuth in the builder (#807 with C-G4 #805), English and German, against
 * the fixture server's OAuth endpoints: authorization code with PKCE (the
 * redirect without a leave prompt, the outcomes, a test request with the
 * granted token) and client credentials.
 */
test("a member signs in a custom API with OAuth (authorization code)", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const c = labels(locale);
  const { leave } = await oauthLogin(page, locale, "oauth_authorization_code");
  // The redirect URL to register at the provider.
  await expect(page.locator(".custom-api-copy code")).toHaveText(
    /\/oauth\/custom\/callback$/,
  );
  // Without a grant, a test asks to sign in first.
  await page.getByRole("button", { name: c.nav.continue, exact: true }).click();
  await page.locator("#custom-api-path").fill("/oauth/api/items");
  await page.getByRole("button", { name: c.request.send }).click();
  await expect(page.locator(".custom-api-panel .error")).not.toBeEmpty();
  await page.getByRole("button", { name: c.nav.back }).click();

  // Denied at the provider: back in the builder with the message.
  await page.route(`${CUSTOM_API_ORIGIN}/oauth/authorize**`, async (route) => {
    const authorize = new URL(route.request().url());
    const callback = new URL(authorize.searchParams.get("redirect_uri")!);
    callback.searchParams.set("error", "access_denied");
    callback.searchParams.set("state", authorize.searchParams.get("state")!);
    await route.fulfill({
      status: 302,
      headers: { location: callback.toString() },
    });
  });
  await page.getByRole("button", { name: c.login.signIn }).click();
  await expect(page.getByText(c.oauth.denied)).toBeVisible();
  await expect(page).toHaveURL(/\/custom-apis\/new\?draft=[0-9a-f-]{36}$/);
  await page.unroute(`${CUSTOM_API_ORIGIN}/oauth/authorize**`);

  // Signed in: the builder comes back on Login, with the draft.
  await expect(
    page.getByRole("heading", { name: c.steps.login }),
  ).toBeVisible();
  await page.getByRole("button", { name: c.login.signIn }).click();
  await expect(page.getByText(c.oauth.connected)).toBeVisible();
  // The outcome is not kept in the address (a reload won't show it again).
  await expect(page).toHaveURL(/\/custom-apis\/new\?draft=[0-9a-f-]{36}$/);
  await expect(
    page.getByRole("heading", { name: c.steps.login }),
  ).toBeVisible();
  await testItems(page, locale);
  // A forged callback: refused as an invalid state. Leaving the builder
  // with its draft asks first, as it should.
  leave.allowed = true;
  await page.goto("/oauth/custom/callback?code=forged&state=forged");
  await expect(page).toHaveURL(/oauth=invalid_state/);
});

test("a member connects a custom API with OAuth (client credentials)", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  await oauthLogin(page, locale, "oauth_client_credentials");
  await testItems(page, locale);
});
