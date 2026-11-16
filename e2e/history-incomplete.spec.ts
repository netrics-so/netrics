import { expect, test } from "@playwright/test";
import postgres from "postgres";

import { dataDe } from "../apps/web/src/messages/data/de.ts";
import { dataEn } from "../apps/web/src/messages/data/en.ts";
import { salesEu } from "./fixtures/journey.ts";
import { createMeasureDashboard, createModel } from "./support/api.ts";
import { type Locale } from "./support/labels.ts";
import { ORIGIN } from "./support/origin.ts";
import { seedReferenceTable, startWorkspace } from "./support/session.ts";
import { ownerUrl } from "./support/store-template.ts";

// "History incomplete" (#635): a source dataset whose connection has not
// read it with a backfill yet (a connector update added it) says so in the
// Data page's preview and on a dashboard tile that reads it, in English and
// German. Without network: the stored table is moved onto a connection
// whose backfill record lacks it.

const messages = (locale: Locale) => (locale === "de" ? dataDe : dataEn).data;

/**
 * Sales EU as a demo connection's source dataset, which the connection's
 * backfills have not read (`backfilled_datasets` without it).
 */
async function moveToConnection(workspaceId: string, datasetId: string) {
  const sql = postgres(ownerUrl(), { max: 1, onnotice: () => {} });
  try {
    const [connection] = await sql<{ id: string }[]>`
      insert into connections (workspace_id, connector_id, name, setup_pending)
      values (${workspaceId}, 'demo', 'Demo site', false)
      returning id`;
    await sql`
      insert into connection_state (connection_id, workspace_id,
        last_success_at, backfilled_datasets)
      values (${connection!.id}, ${workspaceId}, now(), '{}'::jsonb)`;
    await sql`
      update data_datasets set kind = 'source', connection_id = ${connection!.id}
      where id = ${datasetId}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test("says a source's history is incomplete on the Data page and tiles", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = messages(locale);
  const { workspaceId } = await startWorkspace(page, locale);
  const datasetId = await seedReferenceTable(page, workspaceId, salesEu);
  await moveToConnection(workspaceId, datasetId);

  // The Data page's preview of the source.
  await page.goto(`/workspaces/${workspaceId}/data`);
  await page
    .getByRole("complementary")
    .getByRole("button", { name: salesEu.name })
    .click();
  await expect(
    page.getByText(t.warningLabels.source_history_incomplete),
  ).toBeVisible();

  // A dashboard tile summing its revenue.
  const modelId = await createModel(page, workspaceId, {
    name: "Revenue",
    definition: {
      version: 1,
      datasets: [datasetId],
      relationships: [],
      dimensions: [],
      measures: [
        {
          id: "revenue",
          name: "Revenue",
          kind: "aggregate",
          datasetId,
          aggregate: {
            id: "revenue",
            name: "Revenue",
            op: "sum",
            fieldId: "revenue",
          },
        },
      ],
    },
  } as Parameters<typeof createModel>[2]);
  const published = await page.request.post(
    `/v1/workspaces/${workspaceId}/data/models/${modelId}/publish`,
    { headers: { origin: ORIGIN }, data: { version: 1 } },
  );
  expect(published.status(), await published.text()).toBe(200);
  const dashboardId = await createMeasureDashboard(page, workspaceId, {
    name: "Revenue",
    modelId,
    measureId: "revenue",
  });
  await page.goto(`/workspaces/${workspaceId}/dashboards/${dashboardId}`);
  const tile = page.locator("article.sw-measure");
  await expect(tile.locator(".sw-measure-value")).toHaveText(/180/);
  await expect(tile.getByText(t.dashboard.historyIncomplete)).toBeVisible();
  await testInfo.attach(`tile-${locale}`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
});
