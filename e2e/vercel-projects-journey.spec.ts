import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import postgres from "postgres";

import { commonDe } from "../apps/web/src/messages/common/de.ts";
import { commonEn } from "../apps/web/src/messages/common/en.ts";
import { workspaceDe } from "../apps/web/src/messages/workspace/de.ts";
import { workspaceEn } from "../apps/web/src/messages/workspace/en.ts";
import { type Locale } from "./support/labels.ts";
import { ORIGIN } from "./support/origin.ts";
import { startWorkspace } from "./support/session.ts";
import { ownerUrl } from "./support/store-template.ts";

// A Vercel connection's projects after connecting (#782): the latest values
// name the projects, and the synced projects can be changed on the
// connection page, in English and German. Without network: the connection
// is written directly, and the two calls that would ask Vercel (the project
// list and the save, which checks the selection there) answer from
// fixtures; server tests cover them against a stand-in for Vercel.
// The page shows what is synced before the list is loaded, and a selection
// without a project cannot be saved (#854).

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
async function seedConnection(
  workspaceId: string,
  selection: string[] = ["prj_alpha", "prj_beta"],
): Promise<string> {
  const sql = postgres(ownerUrl(), { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql<{ id: string }[]>`
      insert into connections
        (workspace_id, connector_id, name, setup_pending, config,
         credentials_encrypted)
      values (${workspaceId}, 'vercel', 'Websites', false,
        ${sql.json({ resourceSelection: selection })},
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
  const common = (locale === "de" ? commonDe : commonEn)
    .common as typeof commonEn.common;
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
  // What is synced, before the list is loaded (#854): the name where one
  // is known, the ID otherwise.
  const synced = panel.getByRole("listitem");
  await expect(
    panel.getByText(
      locale === "de" ? "Ausgewählte Projekte (2):" : "Selected projects (2):",
    ),
  ).toBeVisible();
  await expect(synced).toHaveText(["alpha-site", "prj_beta"]);
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

  // No project selected: nothing to save, and the reason (#854).
  await panel.getByRole("button", { name: t.projects.clear }).click();
  await expect(alpha).not.toBeChecked();
  await expect(save).toBeDisabled();
  await expect(panel.getByText(t.projects.noneHelp)).toBeVisible();
  await expect(save).toHaveAccessibleDescription(t.projects.noneHelp);
  await alpha.check();
  await expect(save).toBeEnabled();
  await expect(panel.getByText(t.projects.noneHelp)).toHaveCount(0);

  // Unsaved: an in-app link asks in the app's own dialog. Stay keeps the
  // page and the change, Leave follows the link.
  const back = page.getByRole("link", { name: t.detail.back });
  const dialog = page.getByRole("dialog", { name: t.projects.unsaved });
  await back.click();
  await expect(dialog).toHaveCount(1);
  await dialog.getByRole("button", { name: common.stay, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(beta).not.toBeChecked();
  await back.click();
  await dialog.getByRole("button", { name: common.leave, exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`/workspaces/${workspaceId}/sources`),
  );
  expect(saved).toEqual([]);

  // Back on the page: change and save.
  await page.goto(`/workspaces/${workspaceId}/connections/${connectionId}`);
  await panel.getByRole("button", { name: t.projects.check }).click();
  await beta.uncheck();
  await save.click();
  await expect(panel.getByText(t.projects.saved)).toBeVisible();
  expect(saved).toEqual([{ resources: ["prj_alpha"] }]);
  // The page shows the new selection without another click.
  await expect(
    panel.getByText(
      locale === "de" ? "Ausgewähltes Projekt (1):" : "Selected project (1):",
    ),
  ).toBeVisible();
  await expect(synced).toHaveText(["alpha-site"]);
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

  // Reduced to nothing it cannot be saved (#854); the list is loaded again.
  const save = panel.getByRole("button", { name: t.projects.save });
  await panel.getByRole("button", { name: t.projects.clear }).click();
  await expect(save).toBeDisabled();
  await expect(panel.getByText(t.projects.noneHelp)).toBeVisible();
  await panel.getByRole("button", { name: t.projects.cancel }).click();
  await panel.getByRole("button", { name: t.projects.check }).click();
  await expect(beta).toBeChecked();

  // A project that is not listed leaves the list once it is unticked.
  await beta.click();
  await expect(beta).toHaveCount(0);
  await save.click();
  await expect(panel.getByText(t.projects.saved)).toBeVisible();
  expect(saved).toEqual([{ resources: ["prj_alpha"] }]);
});

test("a connection without a selected project says so and is repaired by choosing one", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = messages(locale);
  const { workspaceId } = await startWorkspace(page, locale);
  // Saved empty before a project was required (#854): it is not migrated.
  const connectionId = await seedConnection(workspaceId, []);
  const path = `/v1/workspaces/${workspaceId}/connections/${connectionId}`;

  // The API refuses to save an empty selection, before asking Vercel.
  const refused = await page.request.patch(path, {
    headers: { origin: ORIGIN },
    data: { resources: [] },
  });
  expect(refused.status(), await refused.text()).toBe(400);
  expect(((await refused.json()) as { error: string }).error).toBe(
    "resource_selection_empty",
  );

  const saved: unknown[] = [];
  await page.route(`**${path}/preview`, (route) =>
    route.fulfill({
      json: {
        check: { ok: true },
        resources: PROJECTS.filter((project) => project.analytics).map(
          (project) => ({
            id: project.id,
            name: project.name,
            kind: "project",
            metadata: { accountId: "team_fixture", webAnalytics: true },
          }),
        ),
        selection: [],
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
  // The page still works: the collected values are there.
  const latest = page.locator(".card").filter({
    has: page.getByRole("heading", { name: t.detail.latestObservations }),
  });
  await expect(latest.getByRole("table").locator("tbody tr")).toHaveCount(2);

  // Nothing is synced, and what to do about it.
  const panel = page.locator("#project-selection");
  const none = t.projects.syncedNone.replace("{action}", t.projects.check);
  await expect(panel.getByRole("status")).toHaveText(none);
  await expect(panel.getByRole("listitem")).toHaveCount(0);

  await panel.getByRole("button", { name: t.projects.check }).click();
  const save = panel.getByRole("button", { name: t.projects.save });
  const alpha = panel.getByRole("checkbox", { name: /alpha-site/ });
  await expect(alpha).not.toBeChecked();
  await expect(save).toBeDisabled();
  await expect(panel.getByText(t.projects.noneHelp)).toBeVisible();
  await alpha.check();
  await save.click();
  await expect(panel.getByText(t.projects.saved)).toBeVisible();
  expect(saved).toEqual([{ resources: ["prj_alpha"] }]);
  await expect(panel.getByText(none)).toHaveCount(0);
  await expect(panel.getByRole("listitem")).toHaveText(["alpha-site"]);
});

test("a long selection opens in place, and a viewer sees what is selected", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const de = locale === "de";
  const t = messages(locale);
  const { workspaceId } = await startWorkspace(page, locale);
  // 25 selected projects; only prj_alpha has a stored name. No route is
  // stubbed: nothing here asks Vercel (the stored token is not even valid).
  const selection = [
    "prj_alpha",
    ...Array.from(
      { length: 24 },
      (_, index) => `prj_${String(index).padStart(2, "0")}`,
    ),
  ];
  const connectionId = await seedConnection(workspaceId, selection);
  const url = `/workspaces/${workspaceId}/connections/${connectionId}`;
  const panel = page.locator("#project-selection");
  const items = panel.getByRole("listitem");
  const heading = panel.getByText(
    de ? "Ausgewählte Projekte (25):" : "Selected projects (25):",
  );
  const showAll = panel.getByRole("button", {
    name: t.projects.syncedShowAll.replace("{count}", "25"),
  });
  const showFewer = panel.getByRole("button", {
    name: t.projects.syncedShowFewer,
  });
  const change = panel.getByRole("button", { name: t.projects.check });

  /** The compact list, opened with the keyboard and closed again. */
  async function opensAndCloses() {
    await expect(heading).toBeVisible();
    // 20 projects and "and 5 more".
    await expect(items).toHaveCount(21);
    await expect(items.first()).toHaveText("alpha-site");
    await expect(items.last()).toHaveText(
      t.projects.syncedMore.replace("{count}", "5"),
    );
    await expect(showAll).toHaveAttribute("aria-expanded", "false");
    await showAll.focus();
    await page.keyboard.press("Enter");
    await expect(items).toHaveCount(25);
    await expect(items.last()).toHaveText("prj_23");
    await expect(showAll).toHaveCount(0);
    await showFewer.focus();
    await page.keyboard.press("Enter");
    await expect(items).toHaveCount(21);
    await expect(showAll).toBeVisible();
  }

  // Someone who can change the connection: the list, and the form.
  await page.goto(url);
  await opensAndCloses();
  await expect(change).toBeVisible();

  // A viewer may read the connection: the same list, without the form.
  await becomeViewer(workspaceId);
  await page.goto(url);
  await expect(
    panel.getByRole("heading", { name: t.projects.heading }),
  ).toBeVisible();
  await opensAndCloses();
  await expect(panel.getByText(t.projects.syncedHelpViewer)).toBeVisible();
  await expect(change).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: t.projects.save }),
  ).toHaveCount(0);
  await expect(page.locator("#edit-connection")).toHaveCount(0);

  // A stored empty selection: why nothing syncs, and whom to ask.
  await saveSelection(connectionId, []);
  await page.goto(url);
  await expect(panel.getByRole("status")).toHaveText(
    t.projects.syncedNoneViewer,
  );
  await expect(items).toHaveCount(0);
  await expect(change).toHaveCount(0);
});
