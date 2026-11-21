import { expect, test } from "@playwright/test";
import postgres from "postgres";

import { workspaceDe } from "../apps/web/src/messages/workspace/de.ts";
import { workspaceEn } from "../apps/web/src/messages/workspace/en.ts";
import { fill, type Locale } from "./support/labels.ts";
import { startWorkspace } from "./support/session.ts";

// "Reload history" on the connection page (#617), in English and German:
// the confirmation says what it does, the request queues a backfill, and
// the page then says the history is loading with the button disabled.

const ownerUrl = () =>
  process.env.DATABASE_MIGRATION_URL ??
  "postgres://netrics:netrics@localhost:5433/netrics";

function history(locale: Locale) {
  return (locale === "de" ? workspaceDe : workspaceEn).connections.history;
}

/** A set-up demo connection whose first backfill has finished. */
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
    return row!.id;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function pendingBackfills(connectionId: string): Promise<number> {
  const sql = postgres(ownerUrl(), { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from jobs
      where connection_id = ${connectionId}
        and kind = 'connection.backfill' and status = 'pending'`;
    return row!.count;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test("reloads a connection's history after a confirmation", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = history(locale);
  const { workspaceId } = await startWorkspace(page, locale);
  const connectionId = await seedConnection(workspaceId);

  await page.goto(`/workspaces/${workspaceId}/connections/${connectionId}`);
  const reload = page.getByRole("button", { name: t.reload, exact: true });
  await expect(reload).toBeEnabled();
  await expect(page.getByText(t.loading)).toHaveCount(0);

  await reload.click();
  const dialog = page.getByRole("dialog", {
    name: fill(t.confirmTitle, { name: "Demo site" }),
  });
  await expect(dialog).toBeVisible();
  // It says what it does: the whole window again, and that it takes a while.
  await expect(dialog).toContainText(locale === "de" ? "90 Tage" : "90 days");
  await dialog.getByRole("button", { name: t.confirm }).click();

  await expect(page.getByText(t.queued)).toBeVisible();
  await expect(page.getByText(t.loading)).toBeVisible();
  await expect(reload).toBeDisabled();
  expect(await pendingBackfills(connectionId)).toBe(1);

  // After a reload of the page: still loading, still disabled.
  await page.reload();
  await expect(page.getByText(t.loading)).toBeVisible();
  await expect(
    page.getByRole("button", { name: t.reload, exact: true }),
  ).toBeDisabled();
});

test("says the history is incomplete after a backfill that died, and reloads it (#787)", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = history(locale);
  const { workspaceId } = await startWorkspace(page, locale);
  const connectionId = await seedConnection(workspaceId);
  // As a backfill whose retries are used up leaves the connection, months
  // later: the job and its runs are pruned, incremental syncs succeed.
  const sql = postgres(ownerUrl(), { max: 1, onnotice: () => {} });
  try {
    await sql`
      update connection_state
      set last_success_at = now(), history_from = null,
        backfill_failed_at = now() - interval '100 days'
      where connection_id = ${connectionId}`;
  } finally {
    await sql.end({ timeout: 5 });
  }

  await page.goto(`/workspaces/${workspaceId}/connections/${connectionId}`);
  await expect(page.getByText(t.failed)).toBeVisible();
  await testInfo.attach(`history-incomplete-${locale}`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  const reload = page.getByRole("button", { name: t.reload, exact: true });
  await expect(reload).toBeEnabled();
  await reload.click();
  await page
    .getByRole("dialog", { name: fill(t.confirmTitle, { name: "Demo site" }) })
    .getByRole("button", { name: t.confirm })
    .click();

  // The reload waits: loading now, no longer "incomplete".
  await expect(page.getByText(t.loading)).toBeVisible();
  await expect(page.getByText(t.failed)).toHaveCount(0);
  expect(await pendingBackfills(connectionId)).toBe(1);
});
