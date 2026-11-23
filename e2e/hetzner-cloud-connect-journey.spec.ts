import { expect, test } from "@playwright/test";

import { workspaceDe } from "../apps/web/src/messages/workspace/de.ts";
import { workspaceEn } from "../apps/web/src/messages/workspace/en.ts";
import { hetznerCloudManifest } from "../packages/connectors/src/hetzner-cloud/index.ts";
import { type Locale } from "./support/labels.ts";
import { startWorkspace } from "./support/session.ts";

// Connecting Hetzner Cloud (#872) up to the token check, in English and
// German, without network: the wizard offers the connector, explains how
// to create a Read token, and asks for the token before it can test. The
// checks against Hetzner itself are covered by the connector's contract
// tests.

test("Hetzner Cloud asks for a Read token of one project", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const { workspaceId } = await startWorkspace(page, locale);
  await page.goto(`/workspaces/${workspaceId}/connections/new`);

  await page
    .getByRole("button", { name: /Hetzner Cloud/ })
    .first()
    .click();
  const strategy = hetznerCloudManifest.authStrategies[0]!;
  const steps =
    hetznerCloudManifest.translations?.[locale]?.setupSteps ??
    (strategy.strategy === "token" ? strategy.setup!.steps : []);
  for (const step of steps) {
    await expect(page.getByText(step)).toBeVisible();
  }

  const wizard = (locale === "de" ? workspaceDe : workspaceEn).connections
    .wizard;
  const token = page.locator("#connection-token");
  await expect(token).toBeVisible();
  await expect(token).toHaveValue("");
  await expect(page.getByRole("button", { name: wizard.test })).toBeVisible();
});
