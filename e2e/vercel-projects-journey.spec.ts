import { expect, test } from "@playwright/test";
import postgres from "postgres";

import { workspaceDe } from "../apps/web/src/messages/workspace/de.ts";
import { workspaceEn } from "../apps/web/src/messages/workspace/en.ts";
import { type Locale } from "./support/labels.ts";
import { startWorkspace } from "./support/session.ts";
import { ownerUrl } from "./support/store-template.ts";

// A Vercel connection's projects after connecting (#782): the latest values
// name the projects, and the synced projects can be changed on the
// connection page, in English and German. Without network: the connection
// is written directly, and the two calls that would ask Vercel (the project
// list and the save, which checks the selection there) answer from
// fixtures; server tests cover them against a stand-in for Vercel.

const messages = (locale: Locale) =>
  (locale === "de" ? workspaceDe : workspaceEn).connections;

const PROJECTS = [
  { id: "prj_alpha", name: "alpha-site", analytics: true },
  { id: "prj_beta", name: "beta-site", analytics: true },
  { id: "prj_gamma", name: "gamma-docs", analytics: false },
];

/**
 * A Vercel connection syncing two projects, with visitors for both. Only
 * the first project has a stored name, as while a first backfill runs.
 */
async function seedConnection(workspaceId: string): Promise<string> {
  const sql = postgres(ownerUrl(), { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql<{ id: string }[]>`
      insert into connections
        (workspace_id, connector_id, name, setup_pending, config,
         credentials_encrypted)
      values (${workspaceId}, 'vercel', 'Websites', false,
        ${sql.json({ resourceSelection: ["prj_alpha", "prj_beta"] })},
        ${Buffer.from("not-a-real-envelope")})
      returning id`;
    const id = row!.id;
    // Never due: nothing syncs this connection during the journey.
    await sql`
      insert into connection_state (connection_id, workspace_id, next_due_at)
      values (${id}, ${workspaceId}, now() + interval '10 years')`;
    await sql`
      insert into connection_resources
        (connection_id, workspace_id, resource_id, name, kind)
      values (${id}, ${workspaceId}, 'prj_alpha', 'alpha-site', 'project')`;
    for (const [project, value] of [
      ["prj_alpha", 42],
      ["prj_beta", 17],
    ] as const)
      await sql`
        insert into observations
          (workspace_id, connection_id, metric_definition_id, dimensions,
           source_timestamp, value)
        select ${workspaceId}, ${id}, m.id,
          ${sql.json({ resource: project })}, '2026-01-05T00:00:00Z', ${value}
        from metric_definitions m
        where m.connector_id = 'vercel' and m.key = 'vercel.visitors'`;
    return id;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function saveSelection(connectionId: string, selection: string[]) {
  const sql = postgres(ownerUrl(), { max: 1, onnotice: () => {} });
  try {
    await sql`
      update connections
      set config = ${sql.json({ resourceSelection: selection })}
      where id = ${connectionId}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test("a Vercel connection names its projects and changes which are synced", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = messages(locale);
  const { workspaceId } = await startWorkspace(page, locale);
  const connectionId = await seedConnection(workspaceId);
  const path = `/v1/workspaces/${workspaceId}/connections/${connectionId}`;

  const saved: unknown[] = [];
  await page.route(`**${path}/preview`, (route) =>
    route.fulfill({
      json: {
        check: { ok: true },
        resources: PROJECTS.map((project) => ({
          id: project.id,
          name: project.name,
          kind: "project",
          metadata: {
            accountId: "team_fixture",
            webAnalytics: project.analytics,
          },
        })),
        selection: ["prj_alpha", "prj_beta"],
      },
    }),
  );
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const body = route.request().postDataJSON() as { resources: string[] };
    saved.push(body);
    // What the API answers after its check at the provider: the connection
    // with the new selection.
    const current = await page.request.get(path);
    await saveSelection(connectionId, body.resources);
    return route.fulfill({ json: await current.json() });
  });

  await page.goto(`/workspaces/${workspaceId}/connections/${connectionId}`);

  // Latest values: the project's name; its ID only while no name is known.
  const latest = page.locator(".card").filter({
    has: page.getByRole("heading", { name: t.detail.latestObservations }),
  });
  const rows = latest.getByRole("table").locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "42" })).toContainText("alpha-site");
  await expect(rows.filter({ hasText: "42" })).not.toContainText("prj_alpha");
  await expect(rows.filter({ hasText: "17" })).toContainText("prj_beta");

  // The synced projects, beside the token and settings form.
  const panel = page.locator("#project-selection");
  await expect(
    panel.getByRole("heading", { name: t.projects.heading }),
  ).toBeVisible();
  await expect(panel.getByText(t.projects.intro)).toBeVisible();
  await panel.getByRole("button", { name: t.projects.check }).click();

  // The projects by name; one without Web Analytics is not offered.
  const alpha = panel.getByRole("checkbox", { name: /alpha-site/ });
  const beta = panel.getByRole("checkbox", { name: /beta-site/ });
  await expect(alpha).toBeChecked();
  await expect(beta).toBeChecked();
  await expect(panel.getByText("gamma-docs")).toHaveCount(0);
  await expect(
    panel.getByText(
      locale === "de"
        ? /1 Projekt wird nicht aufgelistet/
        : /1 project is not listed/,
    ),
  ).toBeVisible();
  const save = panel.getByRole("button", { name: t.projects.save });
  await expect(save).toBeDisabled();

  await beta.uncheck();
  await save.click();
  await expect(panel.getByText(t.projects.saved)).toBeVisible();
  expect(saved).toEqual([{ resources: ["prj_alpha"] }]);
  // The removed project's values are still there.
  await expect(rows.filter({ hasText: "17" })).toBeVisible();
});

test("a refused check still lets the selection be reduced and saved", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = messages(locale);
  const { workspaceId } = await startWorkspace(page, locale);
  const connectionId = await seedConnection(workspaceId);
  const path = `/v1/workspaces/${workspaceId}/connections/${connectionId}`;
  const refusal = "None of the projects this token can see has Web Analytics.";

  const saved: unknown[] = [];
  // Web Analytics was turned off everywhere: the check refuses.
  await page.route(`**${path}/preview`, (route) =>
    route.fulfill({
      json: {
        check: { ok: false, message: refusal },
        resources: [],
        selection: ["prj_alpha", "prj_beta"],
      },
    }),
  );
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const body = route.request().postDataJSON() as { resources: string[] };
    saved.push(body);
    const current = await page.request.get(path);
    await saveSelection(connectionId, body.resources);
    return route.fulfill({ json: await current.json() });
  });

  await page.goto(`/workspaces/${workspaceId}/connections/${connectionId}`);
  const panel = page.locator("#project-selection");
  await panel.getByRole("button", { name: t.projects.check }).click();

  // The refusal, and the stored selection to repair below it.
  await expect(panel.getByRole("alert")).toContainText(refusal);
  await expect(panel.getByRole("alert")).toContainText(t.projects.refusedHelp);
  const beta = panel.getByRole("checkbox", { name: /prj_beta/ });
  await expect(beta).toBeChecked();
  await expect(
    panel.getByRole("checkbox", { name: /prj_alpha/ }),
  ).toBeChecked();

  // A project that is not listed leaves the list once it is unticked.
  await beta.click();
  await expect(beta).toHaveCount(0);
  await panel.getByRole("button", { name: t.projects.save }).click();
  await expect(panel.getByText(t.projects.saved)).toBeVisible();
  expect(saved).toEqual([{ resources: ["prj_alpha"] }]);
});
