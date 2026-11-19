import { expect, test } from "@playwright/test";
import postgres from "postgres";

import { workspaceDe } from "../apps/web/src/messages/workspace/de.ts";
import { workspaceEn } from "../apps/web/src/messages/workspace/en.ts";
import { type Locale } from "./support/labels.ts";
import { startWorkspace } from "./support/session.ts";
import { ownerUrl } from "./support/store-template.ts";

// A provider's rate limit (#781): a connection that waits for the reset
// says so on the sources list and its own page ("… limit reached,
// continuing at …"), in English and German, instead of an outage, and the
// failed run's error is in the viewer's language. Without network: the
// state the sync engine records is written directly.

const messages = (locale: Locale) =>
  locale === "de" ? workspaceDe : workspaceEn;

/** A demo connection waiting 40 minutes for its provider's reset. */
async function seedRateLimited(workspaceId: string): Promise<string> {
  const sql = postgres(ownerUrl(), { max: 1, onnotice: () => {} });
  try {
    const [connection] = await sql<{ id: string }[]>`
      insert into connections (workspace_id, connector_id, name, setup_pending)
      values (${workspaceId}, 'demo', 'Limited site', false)
      returning id`;
    const id = connection!.id;
    await sql`
      insert into connection_state (connection_id, workspace_id,
        last_success_at, next_due_at, consecutive_failures, rate_limited_until)
      values (${id}, ${workspaceId}, now() - interval '1 hour',
        now() + interval '40 minutes', 3, now() + interval '40 minutes')`;
    await sql`
      insert into sync_runs (workspace_id, connection_id, mode, requested_from,
        requested_to, attempt, status, started_at, finished_at, error_class,
        error_message)
      values (${workspaceId}, ${id}, 'backfill', now() - interval '30 days',
        now(), 1, 'failed', now() - interval '1 minute', now(), 'rate_limited',
        'The rate limit is used up (429). netrics continues after the reset.')`;
    return id;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test("a rate-limited connection says when syncing continues, not an outage", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = messages(locale);
  const { workspaceId } = await startWorkspace(page, locale);
  const connectionId = await seedRateLimited(workspaceId);
  const limitReached =
    locale === "de"
      ? /-Limit erreicht, weiter um \d{1,2}:\d{2}/
      : /limit reached, continuing at \d{1,2}:\d{2}/;

  await page.goto(`/workspaces/${workspaceId}/sources`);
  const row = page.getByRole("row", { name: /Limited site/ });
  await expect(row.getByText(limitReached)).toBeVisible();
  await expect(row.getByText(t.health.states.outage)).toHaveCount(0);

  await page.goto(`/workspaces/${workspaceId}/connections/${connectionId}`);
  await expect(page.locator(".subtitle").getByText(limitReached)).toBeVisible();
  await expect(
    page.getByText(t.connections.detail.errorClass.rate_limited),
  ).toBeVisible();
  await expect(page.getByText("rate_limited:")).toHaveCount(0);
});
