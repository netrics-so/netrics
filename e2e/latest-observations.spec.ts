import { expect, test } from "@playwright/test";
import postgres from "postgres";

import { workspaceDe } from "../apps/web/src/messages/workspace/de.ts";
import { workspaceEn } from "../apps/web/src/messages/workspace/en.ts";
import { type Locale } from "./support/labels.ts";
import { startWorkspace } from "./support/session.ts";

// "Latest observations" on the connection page (#623): values of 0 (days
// without signups, reviews or downloads) are not listed, and the card says so.

const ownerUrl = () =>
  process.env.DATABASE_MIGRATION_URL ??
  "postgres://netrics:netrics@localhost:5433/netrics";

function detail(locale: Locale) {
  return (locale === "de" ? workspaceDe : workspaceEn).connections.detail;
}

/** A set-up demo connection with signups of 0, 0 and 42 on three days. */
async function seedConnection(workspaceId: string): Promise<string> {
  const sql = postgres(ownerUrl(), { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql<{ id: string }[]>`
      insert into connections (workspace_id, connector_id, name, setup_pending)
      values (${workspaceId}, 'demo', 'Demo site', false)
      returning id`;
    await sql`
      insert into connection_state (connection_id, workspace_id, backfilled_datasets)
      values (${row!.id}, ${workspaceId}, '{}'::jsonb)`;
    const values: Array<[string, number]> = [
      ["2026-01-05T00:00:00Z", 42],
      ["2026-01-06T00:00:00Z", 0],
      ["2026-01-07T00:00:00Z", 0],
    ];
    for (const [day, value] of values)
      await sql`
        insert into observations
          (workspace_id, connection_id, metric_definition_id, dimensions,
           source_timestamp, value)
        select ${workspaceId}, ${row!.id}, m.id,
          ${sql.json({ resource: "demo-site-1" })}, ${day}, ${value}
        from metric_definitions m
        where m.connector_id = 'demo' and m.key = 'demo.signups'`;
    return row!.id;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test("latest observations leave out values of 0", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = detail(locale);
  const { workspaceId } = await startWorkspace(page, locale);
  const connectionId = await seedConnection(workspaceId);

  await page.goto(`/workspaces/${workspaceId}/connections/${connectionId}`);
  const card = page.locator(".card").filter({
    has: page.getByRole("heading", { name: t.latestObservations }),
  });
  await expect(card.getByText(t.zeroObservationsHidden)).toBeVisible();
  const rows = card.getByRole("table").locator("tbody tr");
  // Only the day with 42 signups; the two days with 0 are not listed.
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("2026-01-05");
  await expect(rows.first()).toContainText("42");
});
