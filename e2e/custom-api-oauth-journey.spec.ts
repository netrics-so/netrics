import { expect, test, type Page } from "@playwright/test";

import { apiErrorsDe } from "../apps/web/src/messages/api-errors/de.ts";
import { apiErrorsEn } from "../apps/web/src/messages/api-errors/en.ts";
import { customApiDe } from "../apps/web/src/messages/custom-api/de.ts";
import { customApiEn } from "../apps/web/src/messages/custom-api/en.ts";
import { workspaceDe } from "../apps/web/src/messages/workspace/de.ts";
import { workspaceEn } from "../apps/web/src/messages/workspace/en.ts";
import { FIXTURE_OAUTH_CLIENT } from "../packages/connectors/src/custom-api/testing/fixture-server.ts";
import { formatMessage } from "../packages/domain/src/i18n/message-format.ts";
import { CUSTOM_API_ORIGIN } from "./support/custom-api-origin.ts";
import { ORIGIN } from "./support/origin.ts";
import type { Locale } from "./support/labels.ts";
import { startWorkspace } from "./support/session.ts";

/** The fixture server's OAuth client. */
const CLIENT = FIXTURE_OAUTH_CLIENT;

const labels = (locale: Locale) =>
  ((locale === "de" ? customApiDe : customApiEn) as typeof customApiEn)
    .customApi;

const apiErrors = (locale: Locale) =>
  (locale === "de" ? apiErrorsDe : apiErrorsEn).apiErrors;

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
  // builder on purpose (`leave.allowed`) may. Every other dialog is
  // recorded and the journey asserts there was none (a throw inside the
  // listener would not fail the test).
  const leave = { allowed: false };
  const unexpected: string[] = [];
  page.on("dialog", (dialog) => {
    if (!leave.allowed)
      unexpected.push(`${dialog.type()}: ${dialog.message()}`);
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
  return { workspaceId, leave, unexpected };
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
  const { leave, unexpected } = await oauthLogin(
    page,
    locale,
    "oauth_authorization_code",
  );
  // The redirect URL to register at the provider.
  await expect(page.locator(".custom-api-copy code")).toHaveText(
    /\/oauth\/custom\/callback$/,
  );
  // Without a grant, a test asks to sign in first.
  await page.getByRole("button", { name: c.nav.continue, exact: true }).click();
  await page.locator("#custom-api-path").fill("/oauth/api/items");
  await page.getByRole("button", { name: c.request.send }).click();
  await expect(page.locator(".custom-api-panel .error")).toHaveText(
    apiErrors(locale).custom_api_secret_missing,
  );
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
  expect(unexpected).toEqual([]);
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
  const { unexpected } = await oauthLogin(
    page,
    locale,
    "oauth_client_credentials",
  );
  await testItems(page, locale);
  expect(unexpected).toEqual([]);
});

/**
 * A custom OAuth connection waiting for its first sign-in (#808 review):
 * no generic setup card, token field or "not in the deployed bundle";
 * the login panel is the one place to sign in.
 */
test("a custom OAuth connection waiting for its sign-in offers only the sign-in", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const c = labels(locale);
  const w = (locale === "de" ? workspaceDe : workspaceEn) as typeof workspaceEn;
  const { workspaceId } = await startWorkspace(page, locale);
  const base = `/v1/workspaces/${workspaceId}/custom-api/definitions`;
  const created = await page.request.post(base, {
    headers: { origin: ORIGIN },
    data: {
      document: {
        schemaVersion: 1,
        name: "Items API",
        environments: [
          { id: "production", name: "Production", baseUrl: CUSTOM_API_ORIGIN },
        ],
        auth: {
          type: "oauth_authorization_code",
          authorizeUrl: `${CUSTOM_API_ORIGIN}/oauth/authorize`,
          tokenUrl: `${CUSTOM_API_ORIGIN}/oauth/token`,
          scopes: ["items.read"],
        },
        streams: [
          {
            key: "items",
            name: "Items",
            request: { path: "/oauth/api/items" },
            records: "items",
            fields: [
              {
                id: "id",
                name: "ID",
                path: "id",
                type: "integer",
                nullable: false,
              },
            ],
            keyFields: ["id"],
            mode: "snapshot",
          },
        ],
      },
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const definitionId = (
    (await created.json()) as { definition: { id: string } }
  ).definition.id;
  const connected = await page.request.post(
    `${base}/${definitionId}/connections`,
    {
      headers: { origin: ORIGIN },
      data: { name: "Items", environmentId: "production", credentials: CLIENT },
    },
  );
  expect(connected.status(), await connected.text()).toBe(201);
  const connectionId = (
    (await connected.json()) as { connection: { id: string } }
  ).connection.id;
  await page.goto(`/workspaces/${workspaceId}/connections/${connectionId}`);
  const panel = page.locator(".custom-api-connection-login");
  await expect(
    panel.getByRole("button", { name: c.connectionLogin.signIn }),
  ).toBeVisible();
  await expect(page.locator("#finish-setup")).toHaveCount(0);
  await expect(page.locator("#edit-token")).toHaveCount(0);
  // Visible text only (the page's scripts carry every message).
  const text = await page.locator("main, body").first().innerText();
  expect(text).not.toContain(
    formatMessage(locale, w.connections.edit.connectorMissing, {
      connector: "custom-api",
    }),
  );
  expect(text).not.toContain(w.connections.finishSetup.title);
});
