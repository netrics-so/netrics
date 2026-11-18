import { generateKeyPairSync } from "node:crypto";
import { expect, test, type Route } from "@playwright/test";
import postgres from "postgres";

import { workspaceDe } from "../apps/web/src/messages/workspace/de.ts";
import { workspaceEn } from "../apps/web/src/messages/workspace/en.ts";
import type { Locale } from "./support/labels.ts";
import { startWorkspace } from "./support/session.ts";
import { ownerUrl } from "./support/store-template.ts";

// #715, in English and German: an owner uploads the Customer Support key
// meant for ratings and reviews into "Enable App Store analytics". The form
// offers it as the reviews key in place; on confirm the browser sends the
// key it still holds to the reviews key update, and the reviews card shows
// it as stored.
//
// The journeys' API reaches the real App Store Connect, which knows no test
// team, so App Store Connect's answers are played at the browser's API
// boundary: the analytics status, the offer, the reviews status and the
// stored key. The server side of the offer (both key roles, another team's
// key, a stored reviews key) runs against the App Store Connect fake in
// apps/server/src/app-store-analytics.test.ts.

const ISSUER = "57246542-96fe-1a63-e053-0824d011072a";
const KEY_ID = "CS5UPP0RT1";
const KEYS_URL = "https://appstoreconnect.apple.com/access/integrations/api";

function messages(locale: Locale) {
  return (locale === "de" ? workspaceDe : workspaceEn).connections;
}

/** A set-up App Store Connect connection (no network: it never syncs). */
async function seedConnection(workspaceId: string): Promise<string> {
  const sql = postgres(ownerUrl(), { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql<{ id: string }[]>`
      insert into connections (workspace_id, connector_id, name, setup_pending)
      values (${workspaceId}, 'app-store-connect', 'Apple team', false)
      returning id`;
    return row!.id;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

test("a Customer Support key uploaded for analytics is stored as the reviews key", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = messages(locale);
  const { workspaceId } = await startWorkspace(page, locale);
  const connectionId = await seedConnection(workspaceId);
  const base = `/v1/workspaces/${workspaceId}/connections/${connectionId}`;
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const connection = await page.request.get(base);
  expect(connection.status(), await connection.text()).toBe(200);
  const connectionBody = (await connection.json()) as unknown;

  let reviewsKey: string | null = null;
  const enableBodies: unknown[] = [];
  const updateBodies: unknown[] = [];
  await page.route(`**${base}/app-store-analytics`, (route) => {
    if (route.request().method() === "POST") {
      enableBodies.push(route.request().postDataJSON());
      // Not Admin, of this team, reads reviews: offered, nothing stored.
      return json(route, {
        apps: [],
        keysUrl: KEYS_URL,
        reviewsKeyOffer: { keyId: KEY_ID, replacesKeyId: null },
      });
    }
    return json(route, {
      apps: [
        {
          appId: "1001",
          name: "Focus",
          status: "not_enabled",
          latestDay: null,
          message: null,
        },
      ],
      keysUrl: KEYS_URL,
    });
  });
  await page.route(`**${base}/app-store-reviews`, (route) =>
    json(route, {
      status: reviewsKey ? "active" : "not_configured",
      keyId: reviewsKey,
      message: null,
      keysUrl: KEYS_URL,
    }),
  );
  await page.route(`**${base}`, (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    updateBodies.push(route.request().postDataJSON());
    reviewsKey = KEY_ID;
    return json(route, connectionBody);
  });

  await page.goto(`/workspaces/${workspaceId}/connections/${connectionId}`);
  // The two cards say apart what each key is for, by status (#771): no
  // reviews key yet, and an app whose analytics were never requested.
  await expect(
    page.getByText(t.appStoreReviews.lead.not_configured),
  ).toBeVisible();
  await expect(page.getByText(t.appStoreAnalytics.lead.enable)).toBeVisible();

  await page
    .getByRole("button", { name: t.appStoreAnalytics.enable, exact: true })
    .click();
  await expect(page.getByText(t.appStoreAnalytics.adminOnly)).toBeVisible();
  await page.locator("#admin-key-issuerId").fill(ISSUER);
  await page.locator("#admin-key-keyId").fill(KEY_ID);
  await page.locator("#app-store-analytics input[type=file]").setInputFiles({
    name: `AuthKey_${KEY_ID}.p8`,
    mimeType: "application/octet-stream",
    buffer: Buffer.from(pem),
  });
  await page
    .getByRole("button", { name: t.appStoreAnalytics.request, exact: true })
    .click();

  const offer = page.getByTestId("reviews-key-offer");
  await expect(offer).toContainText(t.appStoreAnalytics.offer.title);
  await expect(offer).toContainText(
    t.appStoreAnalytics.offer.detail.replace("{keyId}", KEY_ID),
  );
  // No other reviews key: nothing to replace.
  await expect(
    offer.getByRole("button", { name: t.appStoreAnalytics.offer.replace }),
  ).toHaveCount(0);
  await offer
    .getByRole("button", { name: t.appStoreAnalytics.offer.use })
    .click();

  await expect(
    page.getByText(t.appStoreAnalytics.offer.stored.replace("{keyId}", KEY_ID)),
  ).toBeVisible();
  // The key was uploaded once; the browser sent the same key as the
  // reviews key, without the issuer ID, which is the team's.
  expect(enableBodies).toHaveLength(1);
  expect(updateBodies).toEqual([
    { credentials: { reviews: { keyId: KEY_ID, privateKey: pem } } },
  ]);
  // The form is gone with the key, and the reviews card reads it as stored.
  await expect(
    page.locator("#app-store-analytics input[type=file]"),
  ).toHaveCount(0);
  await expect(
    page
      .locator("#app-store-reviews")
      .getByText(
        t.appStoreReviews.status.active.replace(
          "{key}",
          t.appStoreReviews.status.keySuffix.replace("{keyId}", KEY_ID),
        ),
      ),
  ).toBeVisible();
  // Its lead follows the stored key.
  await expect(
    page.locator("#app-store-reviews").getByText(t.appStoreReviews.lead.active),
  ).toBeVisible();
});
