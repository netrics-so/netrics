import { expect, test } from "@playwright/test";
import { dashboardsDe } from "../apps/web/src/messages/dashboards/de.ts";
import { dashboardsEn } from "../apps/web/src/messages/dashboards/en.ts";
import { fill, type Locale } from "./support/labels.ts";
import { startWorkspace } from "./support/session.ts";
import {
  installWithConnections,
  templateRecords,
} from "./support/store-template.ts";

const catalog = (locale: Locale) =>
  (locale === "de" ? dashboardsDe : dashboardsEn) as typeof dashboardsEn;

/**
 * Changing the apps of an installed store template (11E), in English and
 * German: from the dashboard, the customer adds a connection and removes
 * another without connecting anything again, reviews the scope plan (the
 * removed connection's preparations are a choice, nothing else asks), and
 * applies it as drafts; the removed preparations are detached, not deleted.
 */
test("a customer adds and removes a store connection of a template dashboard", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const { storeTemplate: s, storeUpdate: u } = catalog(locale);
  const name = "App portfolio";

  const { workspaceId } = await startWorkspace(page, locale);
  const { requestId, dashboardId, connections } = await installWithConnections(
    page,
    workspaceId,
  );
  const before = await templateRecords(workspaceId, requestId);
  const scopeOf = async () => {
    const response = await page.request.get(
      `/v1/workspaces/${workspaceId}/dashboard-templates/stores/installs/${requestId}/scope`,
    );
    expect(response.status()).toBe(200);
    return (await response.json()) as { connections: string[] };
  };

  // 1. The dashboard links to changing its apps.
  await page.goto(`/workspaces/${workspaceId}/dashboards/${dashboardId}`);
  await page.getByRole("link", { name: u.changeApps }).click();
  await expect(page).toHaveURL(
    `/workspaces/${workspaceId}/dashboards/stores?install=${requestId}`,
  );
  await expect(
    page.getByRole("heading", { level: 1, name: fill(s.editTitle, { name }) }),
  ).toBeVisible();

  // 2. Its connections are chosen; one is added, one removed.
  const box = (connection: string) =>
    page.getByRole("checkbox", { name: new RegExp(connection) });
  await expect(box("Apple team")).toBeChecked();
  await expect(box("Play account")).toBeChecked();
  await expect(box("Second Play")).not.toBeChecked();
  await expect(page.getByRole("button", { name: s.addGroup })).toHaveCount(0);
  await box("Second Play").check();
  await box("Play account").uncheck();
  await page.getByRole("button", { name: s.reviewChanges }).click();

  // 3. The plan: only the removed connection's preparations ask.
  await expect(
    page.getByRole("heading", { name: s.editReviewTitle }),
  ).toBeVisible();
  await expect(page.getByText(u.why.scopeRemoval).first()).toBeVisible();
  await expect(page.getByText(u.why.both)).toHaveCount(0);
  const apply = page.getByRole("button", { name: u.apply });
  await expect(apply).toBeDisabled();
  const keep = await page
    .getByRole("radio", { name: u.keep, exact: true })
    .all();
  expect(keep.length).toBeGreaterThan(0);
  for (const radio of keep) await radio.check();
  await expect(apply).toBeEnabled();
  // Nothing changed before applying.
  expect(await scopeOf()).toEqual(
    expect.objectContaining({
      connections: [connections.apple, connections.play].sort(),
    }),
  );
  await apply.click();

  // 4. Applied as drafts: the update page shows the drafts to publish.
  await expect(page).toHaveURL(
    `/workspaces/${workspaceId}/dashboards/stores/updates/${requestId}`,
  );
  await expect(
    page.getByRole("heading", { name: u.steps.publish }),
  ).toBeVisible();
  expect((await scopeOf()).connections).toEqual(
    [connections.apple, connections.second].sort(),
  );
  const after = await templateRecords(workspaceId, requestId);
  const removed = after.filter((record) =>
    record.key.startsWith(`preparation:source:${connections.play}:`),
  );
  expect(removed.length).toBeGreaterThan(0);
  for (const record of removed) {
    expect(record.detached).toBe(true);
    // Kept, as the same record the install created.
    expect(before.map((b) => b.recordId)).toContain(record.recordId);
    const response = await page.request.get(
      `/v1/workspaces/${workspaceId}/data/preparations/${record.recordId}`,
    );
    expect(response.status()).toBe(200);
  }
  expect(
    after.some((record) =>
      record.key.startsWith(`preparation:source:${connections.second}:`),
    ),
  ).toBe(true);
});
