import { expect, test } from "@playwright/test";
import { labels, type Locale } from "./support/labels.ts";
import { startWorkspace } from "./support/session.ts";

test("opens the data page in the project's language", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const { workspaceId } = await startWorkspace(page, locale);
  await page.goto(`/workspaces/${workspaceId}/data`);
  await expect(
    page.getByRole("heading", { level: 1, name: labels(locale).title }),
  ).toBeVisible();
});
