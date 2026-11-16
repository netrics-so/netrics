import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import postgres from "postgres";
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
