import { expect, test } from "@playwright/test";

import { workspaceDe } from "../apps/web/src/messages/workspace/de.ts";
import { workspaceEn } from "../apps/web/src/messages/workspace/en.ts";
import { posthogManifest } from "../packages/connectors/src/posthog/index.ts";
import { providerMessageForCode } from "../packages/domain/src/i18n/shared/index.ts";
import { type Locale } from "./support/labels.ts";
import { startWorkspace } from "./support/session.ts";

// Connecting PostHog (#873) up to the key check, in English and German,
// without network: a self-hosted connection whose host is no public name
// is refused before anything is sent, with the reason's text in the
// viewer's language. The checks against PostHog itself are covered by the
// connector's contract tests.

test("a self-hosted PostHog without a valid host is refused before any request", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const { workspaceId } = await startWorkspace(page, locale);
  await page.goto(`/workspaces/${workspaceId}/connections/new`);

  await page
    .getByRole("button", { name: /PostHog/ })
    .first()
    .click();
  const translation = posthogManifest.translations?.[locale];
  const steps =
    translation?.setupSteps ??
    (posthogManifest.authStrategies[0]!.strategy === "token"
      ? posthogManifest.authStrategies[0]!.setup!.steps
      : []);
  await expect(page.getByText(steps[2]!)).toBeVisible();

  const region = translation?.config?.region?.title ?? "Region";
  await page.getByLabel(region, { exact: false }).selectOption("self-hosted");
  const host = translation?.config?.host?.title ?? "Host (self-hosted)";
  await page.getByLabel(host, { exact: false }).fill("localhost");
  // The wizard's token field, under its own label.
  await page.locator("#connection-token").fill("phx_not_a_real_key");
  const wizard = (locale === "de" ? workspaceDe : workspaceEn).connections
    .wizard;
  await page.getByRole("button", { name: wizard.test }).click();

  await expect(page.locator("div.error[role=alert]")).toContainText(
    providerMessageForCode("posthog.host_invalid", locale)!,
  );
});
