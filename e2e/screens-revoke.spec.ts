import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { screensDe } from "../apps/web/src/messages/screens/de.ts";
import { screensEn } from "../apps/web/src/messages/screens/en.ts";
import { workspaceDe } from "../apps/web/src/messages/workspace/de.ts";
import { workspaceEn } from "../apps/web/src/messages/workspace/en.ts";
import type { Locale } from "./support/labels.ts";
import { startWorkspace } from "./support/session.ts";
import { ownerUrl } from "./support/store-template.ts";

/**
 * Revoking a screen on the Screens page (#835): once confirmed, its card
 * and its panel say "Revoked" at once, not "Online" until the page's data
 * has reloaded.
 */
test("a revoked screen stops showing online at once", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = (locale === "de" ? screensDe : screensEn).screens;
  const d = (locale === "de" ? workspaceDe : workspaceEn).devices;
  const { workspaceId } = await startWorkspace(page, locale);
  const sql = postgres(ownerUrl(), { max: 1, onnotice: () => {} });
  try {
    await sql`insert into devices (workspace_id, name, last_seen_at, platform)
      values (${workspaceId}, 'Lobby TV', now(), 'tvos')`;
  } finally {
    await sql.end({ timeout: 5 });
  }
  await page.goto(`/workspaces/${workspaceId}/screens`);
  const card = page.locator(".screen-card", { hasText: "Lobby TV" });
  await expect(card).toContainText(t.online);
  await card.click();
  const panel = page.getByRole("complementary", { name: t.details });
  await expect(panel).toContainText(t.online);
  // The page's data reloads after the revocation (router.refresh). Slowed
  // down here, as on a slow network, the page must say "Revoked" before.
  await page.route(
    (url) => url.pathname.endsWith("/screens"),
    async (route) => {
      if (route.request().headers()["rsc"])
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      await route.continue();
    },
  );
  await panel.getByRole("button", { name: d.revoke, exact: true }).click();
  await panel.getByRole("button", { name: d.confirm, exact: true }).click();
  const soon = { timeout: 4_000 };
  await expect(panel).toContainText(t.revoked, soon);
  await expect(panel).not.toContainText(t.online, soon);
  await expect(card).toContainText(t.revoked, soon);
  await expect(card).not.toContainText(t.online, soon);
});
