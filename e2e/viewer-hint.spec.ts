import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import postgres from "postgres";

import { workspaceDe } from "../apps/web/src/messages/workspace/de.ts";
import { workspaceEn } from "../apps/web/src/messages/workspace/en.ts";
import { type Locale } from "./support/labels.ts";
import { startWorkspace } from "./support/session.ts";

// A viewer learns why actions are missing (#636): on the home, Sources and
// Dashboards pages a short note names the role and who can change it, with
// a link to the Team page. Owners see no such note.

const ownerUrl = () =>
  process.env.DATABASE_MIGRATION_URL ??
  "postgres://netrics:netrics@localhost:5433/netrics";

function hint(locale: Locale) {
  return (locale === "de" ? workspaceDe : workspaceEn).workspace.viewerHint;
}

/** Makes the signed-in owner a viewer; another account keeps the workspace. */
async function becomeViewer(workspaceId: string): Promise<void> {
  const sql = postgres(ownerUrl(), { max: 1, onnotice: () => {} });
  try {
    const [other] = await sql<{ id: string }[]>`
      insert into users (email, display_name)
      values (${`e2e-owner-${randomUUID()}@example.com`}, 'Other owner')
      returning id`;
    await sql`
      insert into memberships (workspace_id, user_id, role)
      values (${workspaceId}, ${other!.id}, 'owner')`;
    await sql`
      update memberships set role = 'viewer'
      where workspace_id = ${workspaceId} and user_id <> ${other!.id}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test("viewers see why actions are missing", async ({ page }, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = hint(locale);
  const { workspaceId } = await startWorkspace(page, locale);
  const note = page.getByRole("note").filter({ hasText: t.text });

  // As owner: no note.
  await page.goto(`/workspaces/${workspaceId}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(note).toHaveCount(0);

  await becomeViewer(workspaceId);
  for (const area of ["", "/sources", "/dashboards"]) {
    await page.goto(`/workspaces/${workspaceId}${area}`);
    await expect(note).toBeVisible();
  }
  await note.getByRole("link", { name: t.team }).click();
  await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaceId}/team$`));
});
