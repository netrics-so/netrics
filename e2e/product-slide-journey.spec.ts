import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { commonDe } from "../apps/web/src/messages/common/de.ts";
import { commonEn } from "../apps/web/src/messages/common/en.ts";
import { studioDe } from "../apps/web/src/messages/studio/de.ts";
import { studioEn } from "../apps/web/src/messages/studio/en.ts";
import { labels, type Locale } from "./support/labels.ts";
import { ORIGIN } from "./support/origin.ts";
import { startWorkspace } from "./support/session.ts";
import { ownerUrl } from "./support/store-template.ts";

interface CatalogModel {
  modelId: string;
  modelName: string;
  dimensions: { id: string; name: string; type: string }[];
}

/**
 * A product slide built by hand (#777): a dashboard without shared filters
 * is opened in the Studio, the editor adds the first App filter in the
 * draft and scopes the slide to a linked product. Its metric widget, which
 * is fixed to no app and excludes nothing, follows the product through its
 * app, so Save goes through, as the server accepts it. Before, the Studio
 * knew only the products the opened dashboard came with (none) and blocked
 * the save.
 */
test("a first App filter added in the Studio scopes a slide to a linked product", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const rail = (locale === "de" ? studioDe : studioEn).studio.rail;
  const common = (locale === "de" ? commonDe : commonEn).common;
  const t = labels(locale).dashboard;
  const headers = { origin: ORIGIN };

  const { workspaceId } = await startWorkspace(page, locale);
  // An App portfolio whose one product links an app of each store.
  const sql = postgres(ownerUrl(), { max: 1, onnotice: () => {} });
  let apple: string, play: string;
  try {
    const add = async (connectorId: string, name: string) => {
      const [row] = await sql<{ id: string }[]>`
        insert into connections (workspace_id, connector_id, name, setup_pending)
        values (${workspaceId}, ${connectorId}, ${name}, false)
        returning id`;
      return row!.id;
    };
    apple = await add("app-store-connect", "Apple team");
    play = await add("google-play", "Play account");
  } finally {
    await sql.end({ timeout: 5 });
  }
  const groupId = randomUUID();
  const product = `product:${groupId}`;
  const installed = await page.request.post(
    `/v1/workspaces/${workspaceId}/dashboard-templates/stores`,
    {
      headers,
      timeout: 90_000,
      data: {
        requestId: randomUUID(),
        name: "App portfolio",
        connections: [apple, play],
        groups: [
          {
            id: groupId,
            name: "Wurfel",
            apps: [
              { connectionId: apple, appId: "1234567890" },
              { connectionId: play, appId: "com.example.wurfel" },
            ],
          },
        ],
      },
    },
  );
  expect(installed.status(), await installed.text()).toBe(200);

  // A model of the install with a text dimension, and an App Store metric
  // by app, for a dashboard that has no shared filter yet.
  const catalog = (await (
    await page.request.get(
      `/v1/workspaces/${workspaceId}/dashboards/published-models`,
      { headers },
    )
  ).json()) as { models: CatalogModel[] };
  const model = catalog.models.find((candidate) =>
    candidate.dimensions.some((dimension) => dimension.type === "string"),
  )!;
  const dimension = model.dimensions.find(
    (candidate) => candidate.type === "string",
  )!;
  const { metrics } = (await (
    await page.request.get(`/v1/workspaces/${workspaceId}/metrics`, {
      headers,
    })
  ).json()) as {
    metrics: { connectionId: string; key: string; dimensions: string[] }[];
  };
  const metric = metrics.find(
    (candidate) =>
      candidate.connectionId === apple &&
      candidate.dimensions.includes("resource"),
  )!;
  const created = await page.request.post(
    `/v1/workspaces/${workspaceId}/dashboards`,
    {
      headers,
      data: {
        name: "By hand",
        slides: [
          {
            widgets: [
              {
                type: "metric",
                x: 0,
                y: 0,
                w: 4,
                h: 3,
                connectionId: apple,
                metricKey: metric.key,
                period: "last_7_days",
              },
            ],
          },
        ],
      },
    },
  );
  expect(created.status(), await created.text()).toBe(200);
  const { dashboard } = (await created.json()) as {
    dashboard: { id: string; productApps?: unknown };
  };
  expect(dashboard.productApps).toBeUndefined();

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(
    `/workspaces/${workspaceId}/dashboards/${dashboard.id}/studio`,
  );

  // 1. The first shared filter, added in the draft: text values, mapped to
  //    the model's dimension, named "App".
  const asked = page.waitForResponse(
    (response) =>
      response.url().endsWith("/dashboards/product-apps") &&
      response.request().postData()?.includes(model.modelId) === true,
  );
  await page.getByRole("button", { name: t.addFilter, exact: true }).click();
  const editor = page
    .locator(".inspector-section", {
      has: page.getByRole("heading", { name: t.sharedFilters, exact: true }),
    })
    .locator("fieldset")
    .first();
  await editor.getByLabel(t.type, { exact: true }).selectOption("string");
  await editor
    .getByLabel(model.modelName, { exact: true })
    .selectOption(dimension.id);
  await editor.getByLabel(t.name, { exact: true }).fill("App");
  // The draft's products are asked for by its filters' models.
  expect((await asked).status()).toBe(200);

  // 2. The slide is scoped to the linked product.
  const scope = page.getByRole("group", { name: rail.scope, exact: true });
  await scope.getByRole("textbox", { name: "App", exact: true }).fill(product);
  await scope.getByRole("textbox", { name: "App", exact: true }).press("Enter");
  await expect(scope.getByText(product)).toBeVisible();

  // 3. Save goes through: the widget follows the product, no exclusion.
  const save = page.getByRole("button", { name: common.save, exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/v1/workspaces/${workspaceId}/dashboards/${dashboard.id}`,
        { headers },
      );
      const body = (await response.json()) as {
        dashboard: {
          slides: {
            scope: unknown;
            widgets: { filterExclusions?: unknown }[];
          }[];
          productApps?: Record<string, string[]>;
        };
      };
      return {
        // Under the new filter's generated id.
        scope: Object.values(body.dashboard.slides[0]!.scope as object),
        excluded: body.dashboard.slides[0]!.widgets[0]!.filterExclusions,
        apps: body.dashboard.productApps?.[product],
      };
    })
    .toEqual({
      scope: [{ kind: "values", values: [product] }],
      excluded: undefined,
      apps: [`${apple}:1234567890`, `${play}:com.example.wurfel`].sort(),
    });
});
