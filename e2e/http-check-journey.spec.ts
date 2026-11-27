import { expect, test } from "@playwright/test";

import { workspaceDe } from "../apps/web/src/messages/workspace/de.ts";
import { workspaceEn } from "../apps/web/src/messages/workspace/en.ts";
import { httpCheckManifest } from "../packages/connectors/src/http-check/index.ts";
import { providerMessageForCode } from "../packages/domain/src/i18n/shared/index.ts";
import { CUSTOM_API_ORIGIN } from "./support/custom-api-origin.ts";
import { type Locale } from "./support/labels.ts";
import { ORIGIN } from "./support/origin.ts";
import { startWorkspace } from "./support/session.ts";

// Creating HTTP checks (#874) in English and German against the local
// https fixture server the journeys start (playwright.config.ts, on
// 127.0.0.1, allowed through NETRICS_CUSTOM_API_PRIVATE_HOSTS): the wizard
// edits a list of checks, refuses a secret request header and a secret in
// a URL's query with the reason's text in the viewer's language, lists the
// checks as resources without a selection and creates the connection;
// its page then saves a changed list naming another host. The journeys run no sync worker: the requests themselves
// (every down reason through the real egress guard) are covered by
// apps/server/src/http-check-sync.test.ts.

test("a member creates HTTP checks against the fixture server", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const { workspaceId } = await startWorkspace(page, locale);
  const wizard = (locale === "de" ? workspaceDe : workspaceEn).connections;
  const name = httpCheckManifest.translations?.[locale]?.name ?? "HTTP checks";
  await page.goto(`/workspaces/${workspaceId}/connections/new`);
  await page
    .getByRole("button", { name: new RegExp(name) })
    .first()
    .click();

  // The first entry is there; a second one is added.
  await page.locator("#config-checks-0-name").fill("Fixture health");
  await page
    .locator("#config-checks-0-url")
    .fill(`${CUSTOM_API_ORIGIN}/health`);
  await page.getByRole("button", { name: wizard.config.addItem }).click();
  await page.locator("#config-checks-1-name").fill("Fixture login");
  await page.locator("#config-checks-1-url").fill(`${CUSTOM_API_ORIGIN}/login`);
  await page.locator("#config-checks-1-method").selectOption("HEAD");
  await page
    .locator("#config-checks-1-headers")
    .fill("Authorization: Bearer not-here");

  await page.getByRole("button", { name: wizard.wizard.test }).click();
  await expect(page.locator("div.error[role=alert]")).toContainText(
    providerMessageForCode("http_check.headers_invalid", locale)!,
  );

  // A secret in the URL's query is refused too (#874 review).
  await page.locator("#config-checks-1-headers").fill("Accept: text/html");
  await page
    .locator("#config-checks-1-url")
    .fill(`${CUSTOM_API_ORIGIN}/login?api_key=not-here`);
  await page.getByRole("button", { name: wizard.wizard.test }).click();
  await expect(page.locator("div.error[role=alert]")).toContainText(
    providerMessageForCode("http_check.url_secret", locale)!,
  );

  // So is a fragment, which may carry a token (#898).
  await page
    .locator("#config-checks-1-url")
    .fill(`${CUSTOM_API_ORIGIN}/login#access_token=not-here`);
  await page.getByRole("button", { name: wizard.wizard.test }).click();
  await expect(page.locator("div.error[role=alert]")).toContainText(
    providerMessageForCode("http_check.url_fragment", locale)!,
  );

  await page.locator("#config-checks-1-url").fill(`${CUSTOM_API_ORIGIN}/login`);
  await page.getByRole("button", { name: wizard.wizard.test }).click();
  // The checks are listed, not offered for selection: every one is synced.
  await expect(page.getByText("Fixture health")).toBeVisible();
  await expect(page.getByText("Fixture login")).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await page.getByRole("button", { name: wizard.wizard.create }).click();
  await page.waitForURL(/\/connections\/[0-9a-f-]{36}$/);
  const connectionId = page.url().split("/").at(-1)!;

  const read = async () => {
    const response = await page.request.get(
      `/v1/workspaces/${workspaceId}/connections/${connectionId}`,
    );
    expect(response.status()).toBe(200);
    return ((await response.json()) as { connection: { config: unknown } })
      .connection.config;
  };
  expect(await read()).toEqual({
    checks: [
      {
        name: "Fixture health",
        url: `${CUSTOM_API_ORIGIN}/health`,
        method: "GET",
        timeoutSeconds: 10,
      },
      {
        name: "Fixture login",
        url: `${CUSTOM_API_ORIGIN}/login`,
        method: "HEAD",
        timeoutSeconds: 10,
        headers: "Accept: text/html",
      },
    ],
  });

  // Without credentials, a check may move to another host.
  const changed = await page.request.patch(
    `/v1/workspaces/${workspaceId}/connections/${connectionId}`,
    {
      headers: { origin: ORIGIN },
      data: {
        config: {
          checks: [
            { name: "Fixture health", url: "https://status.example.com/" },
          ],
        },
      },
    },
  );
  expect(changed.status(), await changed.text()).toBe(200);
  expect(await read()).toEqual({
    checks: [
      {
        name: "Fixture health",
        url: "https://status.example.com/",
        method: "GET",
        timeoutSeconds: 10,
      },
    ],
  });
});
