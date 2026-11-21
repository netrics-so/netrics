import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { commonDe } from "../apps/web/src/messages/common/de.ts";
import { commonEn } from "../apps/web/src/messages/common/en.ts";
import { dashboardsDe } from "../apps/web/src/messages/dashboards/de.ts";
import { dashboardsEn } from "../apps/web/src/messages/dashboards/en.ts";
import type { Locale } from "./support/labels.ts";
import { startWorkspace } from "./support/session.ts";
import { installWithConnections, ownerUrl } from "./support/store-template.ts";

const catalog = (locale: Locale) =>
  (locale === "de" ? dashboardsDe : dashboardsEn) as typeof dashboardsEn;

// A 1×1 PNG, stored as the App Store app's icon.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * App identity of a template dashboard (#708), in English and German: on
 * the screen that changes its apps, each app shows its stored App Store
 * icon and starts at automatic paid or free (free: no proceeds yet) without
 * a website. The customer sets one app to paid and links the other to a
 * Vercel Web Analytics project; both are saved without a review.
 */
test("a customer sets an app to paid and links a website", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const { storeTemplate: s } = catalog(locale);

  const { workspaceId } = await startWorkspace(page, locale);
  const { requestId, connections } = await installWithConnections(
    page,
    workspaceId,
  );
  const sql = postgres(ownerUrl(), { max: 1, onnotice: () => {} });
  try {
    const resource = (connectionId: string, id: string, name: string) =>
      sql`insert into connection_resources
          (connection_id, workspace_id, resource_id, name, kind)
        values (${connectionId}, ${workspaceId}, ${id}, ${name}, 'app')`;
    await resource(connections.apple, "1001", "Focus");
    await resource(connections.play, "com.timer", "Timer");
    const [vercel] = await sql<{ id: string }[]>`
      insert into connections (workspace_id, connector_id, name, setup_pending)
      values (${workspaceId}, 'vercel', 'Websites', false)
      returning id`;
    await sql`insert into connection_resources
        (connection_id, workspace_id, resource_id, name, kind)
      values (${vercel!.id}, ${workspaceId}, 'prj_timer', 'timer.example', 'project')`;
    await sql`insert into workspace_images
        (workspace_id, name, content_type, bytes, width, height, sha256,
         content, origin, connection_id, resource_id)
      values (${workspaceId}, 'Focus icon', 'image/png', ${PNG.length}, 1, 1,
        ${createHash("sha256").update(PNG).digest("hex")}, ${PNG},
        'resource_icon', ${connections.apple}, '1001')`;
  } finally {
    await sql.end({ timeout: 5 });
  }

  await page.goto(
    `/workspaces/${workspaceId}/dashboards/stores?install=${requestId}`,
  );
  await expect(page.getByRole("heading", { name: s.identity })).toBeVisible();
  const focus = page.locator(`[data-product="${connections.apple}:1001"]`);
  const timer = page.locator(`[data-product="${connections.play}:com.timer"]`);
  await expect(focus.locator("img")).toHaveAttribute("src", /\/images\//);
  // No icon stored for the Play app: it offers to get one.
  await expect(timer.getByRole("button", { name: s.useIcon })).toBeVisible();
  const pricing = focus.getByLabel(s.pricing);
  await expect(pricing).toHaveValue("auto");
  await expect(pricing.locator("option:checked")).toHaveText(s.pricingAutoFree);

  const save = page.getByRole("button", { name: s.identitySave });
  await expect(save).toBeDisabled();
  await pricing.selectOption("paid");
  await timer.getByLabel(s.website).selectOption({ label: "timer.example" });
  await save.click();
  await expect(page.getByText(s.identitySaved)).toBeVisible();
  await expect(save).toBeDisabled();

  const response = await page.request.get(
    `/v1/workspaces/${workspaceId}/dashboard-templates/stores/installs/${requestId}/products`,
  );
  expect(response.status()).toBe(200);
  const { products } = (await response.json()) as {
    products: {
      productId: string;
      pricing: string;
      paid: boolean;
      website: { projectId: string; name: string } | null;
    }[];
  };
  const of = (id: string) => products.find((p) => p.productId === id)!;
  expect(of(`${connections.apple}:1001`)).toMatchObject({
    pricing: "paid",
    paid: true,
    website: null,
  });
  expect(of(`${connections.play}:com.timer`)).toMatchObject({
    pricing: "auto",
    paid: false,
    website: { projectId: "prj_timer", name: "timer.example" },
  });

  // After a reload the saved choices are what the screen shows.
  await page.reload();
  await expect(focus.getByLabel(s.pricing)).toHaveValue("paid");
  await expect(
    timer.getByLabel(s.website).locator("option:checked"),
  ).toHaveText("timer.example");
});

/**
 * Unsaved app identity changes are not lost when the scope change applies
 * and moves on to the update page: an in-page confirmation saves them (or
 * discards them) first.
 */
test("applying a scope change saves unsaved app identity first", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const { storeTemplate: s, storeUpdate: u } = catalog(locale);

  const { workspaceId } = await startWorkspace(page, locale);
  const { requestId, connections } = await installWithConnections(
    page,
    workspaceId,
  );
  const sql = postgres(ownerUrl(), { max: 1, onnotice: () => {} });
  try {
    await sql`insert into connection_resources
        (connection_id, workspace_id, resource_id, name, kind)
      values (${connections.apple}, ${workspaceId}, '1001', 'Focus', 'app')`;
  } finally {
    await sql.end({ timeout: 5 });
  }

  await page.goto(
    `/workspaces/${workspaceId}/dashboards/stores?install=${requestId}`,
  );
  const focus = page.locator(`[data-product="${connections.apple}:1001"]`);
  await focus.getByLabel(s.pricing).selectOption("free");
  // Not saved; the scope change is reviewed and applied.
  await page.getByRole("checkbox", { name: /Second Play/ }).check();
  await page.getByRole("button", { name: s.reviewChanges }).click();
  await page.getByRole("button", { name: u.apply }).click();

  // The page stays and asks, in the page itself.
  const ask = page.getByRole("alertdialog", { name: s.identityPending });
  await expect(ask).toBeVisible();
  await expect(page).toHaveURL(/\?install=/);
  // Saving is held: the whole save-and-apply is one pending operation, so
  // nothing can cancel it halfway (it would navigate anyway).
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/installs\/[^/]+\/products$/, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    await held;
    await route.continue();
  });
  await ask.getByRole("button", { name: s.identitySaveAndApply }).click();
  for (const name of [
    s.identitySaveAndApply,
    s.identityDiscardAndApply,
    s.identityKeepEditing,
  ])
    await expect(ask.getByRole("button", { name })).toBeDisabled();
  // The review's own apply button is busy too (it shows progress).
  await expect(
    page.getByRole("button", { name: u.apply, disabled: false }),
  ).toHaveCount(0);
  release();

  await expect(page).toHaveURL(
    `/workspaces/${workspaceId}/dashboards/stores/updates/${requestId}`,
  );
  const response = await page.request.get(
    `/v1/workspaces/${workspaceId}/dashboard-templates/stores/installs/${requestId}/products`,
  );
  expect(response.status()).toBe(200);
  const { products } = (await response.json()) as {
    products: { productId: string; pricing: string }[];
  };
  expect(
    products.find((p) => p.productId === `${connections.apple}:1001`),
  ).toMatchObject({ pricing: "free" });
});

/**
 * While the scope change is applied (and the page moves on), app identity
 * cannot be edited: such an edit would be lost with the navigation.
 */
test("app identity is locked while a scope change applies", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const { storeTemplate: s, storeUpdate: u } = catalog(locale);

  const { workspaceId } = await startWorkspace(page, locale);
  const { requestId, connections } = await installWithConnections(
    page,
    workspaceId,
  );
  const sql = postgres(ownerUrl(), { max: 1, onnotice: () => {} });
  try {
    await sql`insert into connection_resources
        (connection_id, workspace_id, resource_id, name, kind)
      values (${connections.apple}, ${workspaceId}, '1001', 'Focus', 'app')`;
  } finally {
    await sql.end({ timeout: 5 });
  }

  await page.goto(
    `/workspaces/${workspaceId}/dashboards/stores?install=${requestId}`,
  );
  const pricing = page
    .locator(`[data-product="${connections.apple}:1001"]`)
    .getByLabel(s.pricing);
  await expect(pricing).toBeEnabled();
  await page.getByRole("checkbox", { name: /Second Play/ }).check();
  await page.getByRole("button", { name: s.reviewChanges }).click();

  // Hold the scope change until the lock is checked.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/installs\/[^/]+\/scope$/, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    await held;
    await route.continue();
  });
  await page.getByRole("button", { name: u.apply }).click();
  await expect(pricing).toBeDisabled();
  await expect(
    page.getByRole("button", { name: s.identitySave }),
  ).toBeDisabled();
  release();
  await expect(page).toHaveURL(
    `/workspaces/${workspaceId}/dashboards/stores/updates/${requestId}`,
  );
});

/**
 * When app identity cannot be read (more website projects than the
 * workspace's row limit), the page still changes the apps; the identity
 * section explains the limit in place.
 */
test("the apps can still be changed when app identity is over the row limit", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const { storeTemplate: s } = catalog(locale);

  const { workspaceId } = await startWorkspace(page, locale);
  const { requestId } = await installWithConnections(page, workspaceId);
  const sql = postgres(ownerUrl(), { max: 1, onnotice: () => {} });
  try {
    const [vercel] = await sql<{ id: string }[]>`
      insert into connections (workspace_id, connector_id, name, setup_pending)
      values (${workspaceId}, 'vercel', 'Websites', false)
      returning id`;
    for (const index of [1, 2, 3, 4, 5])
      await sql`insert into connection_resources
          (connection_id, workspace_id, resource_id, name, kind)
        values (${vercel!.id}, ${workspaceId}, ${"prj_" + index},
          ${"site" + index + ".example"}, 'project')`;
    await sql`select admin_set_data_policy(${workspaceId}::uuid,
      ${sql.json({ queryRows: 3 })})`;
  } finally {
    await sql.end({ timeout: 5 });
  }

  await page.goto(
    `/workspaces/${workspaceId}/dashboards/stores?install=${requestId}`,
  );
  await expect(page.getByRole("heading", { name: s.identity })).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: s.identityTooLarge }),
  ).toBeVisible();
  // The scope editor is there and works.
  await page.getByRole("checkbox", { name: /Second Play/ }).check();
  await page.getByRole("button", { name: s.reviewChanges }).click();
  await expect(
    page.getByRole("heading", { name: s.editReviewTitle }),
  ).toBeVisible();
});

/**
 * The scope form and the app identity share one leave guard (#723):
 * leaving by a link in the app asks once, however many of them have unsaved
 * changes, and not at all without any.
 */
test("leaving with unsaved scope and identity asks once", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const { storeTemplate: s } = catalog(locale);

  const { workspaceId } = await startWorkspace(page, locale);
  const { requestId, connections } = await installWithConnections(
    page,
    workspaceId,
  );
  const sql = postgres(ownerUrl(), { max: 1, onnotice: () => {} });
  try {
    await sql`insert into connection_resources
        (connection_id, workspace_id, resource_id, name, kind)
      values (${connections.apple}, ${workspaceId}, '1001', 'Focus', 'app')`;
  } finally {
    await sql.end({ timeout: 5 });
  }

  // The guard asks in the app's own dialog, as on every editor page, and
  // never with the browser's (#798).
  const common = (locale === "de" ? commonDe : commonEn)
    .common as typeof commonEn.common;
  const native: string[] = [];
  page.on("dialog", (dialog) => {
    native.push(dialog.type());
    void dialog.dismiss();
  });
  const question = page.getByRole("dialog", { name: s.unsaved });
  const leave = async (change: { scope: boolean; identity: boolean }) => {
    await page.goto(
      `/workspaces/${workspaceId}/dashboards/stores?install=${requestId}`,
    );
    const pricing = page
      .locator(`[data-product="${connections.apple}:1001"]`)
      .getByLabel(s.pricing);
    await expect(pricing).toBeEnabled();
    if (change.identity) await pricing.selectOption("free");
    if (change.scope)
      await page.getByRole("checkbox", { name: /Second Play/ }).check();
    const link = page.getByRole("link", { name: s.editMappingLink });
    await link.click();
    if (change.scope || change.identity) {
      // One question, on Stay: staying keeps the page and its changes.
      await expect(question).toHaveCount(1);
      const stay = question.getByRole("button", {
        name: common.stay,
        exact: true,
      });
      await expect(stay).toBeFocused();
      await stay.click();
      await expect(question).toHaveCount(0);
      await expect(page).toHaveURL(/install=/);
      await link.click();
      await expect(question).toHaveCount(1);
      await question
        .getByRole("button", { name: common.leave, exact: true })
        .click();
    }
    // Without changes nothing asks: the link leaves at once.
    await expect(page).toHaveURL(`/workspaces/${workspaceId}/data`);
    await expect(question).toHaveCount(0);
  };

  await leave({ scope: false, identity: false });
  await leave({ scope: false, identity: true });
  await leave({ scope: true, identity: false });
  await leave({ scope: true, identity: true });
  expect(native).toEqual([]);
});
