import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
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

/**
 * The focus is on an element, never dropped to the page (#854): asserted
 * after each update that follows a keyboard or pointer action, since any
 * of them may remove what had the focus.
 */
async function focusIsSomewhere(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const active = document.activeElement;
        return active !== null && active !== document.body;
      }),
    )
    .toBe(true);
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
  // Opened with the keyboard: the focus moves into the picker, onto the
  // chosen mode, instead of being dropped with the button.
  const change = panel.getByRole("button", { name: t.projects.check });
  await change.focus();
  await page.keyboard.press("Enter");
  await expect(
    panel.getByRole("radio", { name: t.projects.choose }),
  ).toBeFocused();

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
  await focusIsSomewhere(page);

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
  await save.focus();
  await page.keyboard.press("Enter");
  await expect(panel.getByText(t.projects.saved)).toBeVisible();
  expect(saved).toEqual([{ resources: ["prj_alpha"] }]);
  // The picker closed: the focus is back on the button that opens it.
  await expect(change).toBeFocused();
  await focusIsSomewhere(page);
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
  // Cancelled with the keyboard: the focus returns to the button that
  // opens the picker, and Enter opens it again.
  const cancel = panel.getByRole("button", { name: t.projects.cancel });
  const change = panel.getByRole("button", { name: t.projects.check });
  await cancel.focus();
  await page.keyboard.press("Enter");
  await expect(change).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(beta).toBeChecked();
  await expect(
    panel.getByRole("radio", { name: t.projects.choose }),
  ).toBeFocused();

  // A project that is not listed leaves the list once it is unticked; the
  // focus goes to the checkbox that is left, not to the page.
  await beta.focus();
  await page.keyboard.press("Space");
  await expect(beta).toHaveCount(0);
  await expect(
    panel.getByRole("checkbox", { name: /prj_alpha/ }),
  ).toBeFocused();
  await focusIsSomewhere(page);
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
  await focusIsSomewhere(page);
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
    // The focus is still on the control, which now closes the list: Enter
    // again, without touching the mouse or tabbing back.
    await expect(showFewer).toBeFocused();
    await expect(showFewer).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Enter");
    await expect(items).toHaveCount(21);
    await expect(showAll).toBeFocused();
    await focusIsSomewhere(page);
  }

  /** A very long list, in steps: the focus never leaves the controls. */
  async function stepsThrough() {
    const more = panel.getByRole("button", {
      name: t.projects.syncedShowMore.replace("{count}", "500"),
    });
    const all = panel.getByRole("button", {
      name: t.projects.syncedShowAll.replace("{count}", "540"),
    });
    await expect(items).toHaveCount(21);
    await more.focus();
    await page.keyboard.press("Enter");
    // 520 shown, "and 20 more"; the same button now offers the rest.
    await expect(items).toHaveCount(521);
    await expect(all).toBeFocused();
    // Closing half-way: that button goes, the focus moves to the other.
    await showFewer.focus();
    await page.keyboard.press("Enter");
    await expect(items).toHaveCount(21);
    await expect(more).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(all).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(items).toHaveCount(540);
    await expect(showFewer).toHaveCount(1);
    await expect(showFewer).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(items).toHaveCount(21);
    await expect(more).toBeFocused();
    await focusIsSomewhere(page);
  }

  // Someone who can change the connection: the list, and the form.
  await page.goto(url);
  await opensAndCloses();
  await expect(change).toBeVisible();
  const long = Array.from(
    { length: 540 },
    (_, index) => `prj_${String(index).padStart(3, "0")}`,
  );
  await saveSelection(connectionId, long);
  await page.goto(url);
  await stepsThrough();
  await saveSelection(connectionId, selection);

  // A viewer may read the connection: the same list, without the form.
  await becomeViewer(workspaceId);
  await page.goto(url);
  await expect(
    panel.getByRole("heading", { name: t.projects.heading }),
  ).toBeVisible();
  await opensAndCloses();
  await expect(panel.getByText(t.projects.syncedHelpViewer)).toBeVisible();
  await saveSelection(connectionId, long);
  await page.goto(url);
  await stepsThrough();
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

test("the focus is handed on only when an update took it away", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = messages(locale);
  const common = (locale === "de" ? commonDe : commonEn)
    .common as typeof commonEn.common;
  const { workspaceId } = await startWorkspace(page, locale);
  // 25 selected projects: the list has its "Show all" button.
  const selection = [
    "prj_alpha",
    "prj_beta",
    ...Array.from(
      { length: 23 },
      (_, index) => `prj_${String(index).padStart(2, "0")}`,
    ),
  ];
  const connectionId = await seedConnection(workspaceId, selection);
  const path = `/v1/workspaces/${workspaceId}/connections/${connectionId}`;
  const url = `/workspaces/${workspaceId}/connections/${connectionId}`;

  // The list, the save and the page's refresh after it answer only when
  // the test lets them: time to move the focus in between.
  const gate = () => {
    let open = () => {};
    const closed = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { closed, open };
  };
  let answer = gate();
  let refresh = gate();
  refresh.open();
  await page.route(`**${path}/preview`, async (route) => {
    await answer.closed;
    return route.fulfill({
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
        selection: ["prj_alpha", "prj_beta"],
      },
    });
  });
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const body = route.request().postDataJSON() as { resources: string[] };
    const current = await page.request.get(path);
    await answer.closed;
    await saveSelection(connectionId, body.resources);
    return route.fulfill({ json: await current.json() });
  });
  await page.route(
    (address) => address.pathname === url && address.searchParams.has("_rsc"),
    async (route) => {
      await refresh.closed;
      return route.continue();
    },
  );

  await page.goto(url);
  const panel = page.locator("#project-selection");
  const change = panel.getByRole("button", { name: t.projects.check });
  const loading = panel.getByRole("button", { name: t.projects.checking });
  const save = panel.getByRole("button", { name: t.projects.save });
  const saving = panel.getByRole("button", { name: common.saving });
  const cancel = panel.getByRole("button", { name: t.projects.cancel });
  const mode = panel.getByRole("radio", { name: t.projects.choose });
  const beta = panel.getByRole("checkbox", { name: /beta-site/ });
  const showAll = panel.getByRole("button", {
    name: t.projects.syncedShowAll.replace("{count}", "25"),
  });
  const items = panel.getByRole("listitem");

  /** Tabs back out of the panel and remembers where the focus went. */
  const tabOut = async (presses: number) => {
    for (let press = 0; press < presses; press += 1)
      await page.keyboard.press("Shift+Tab");
    const where = await page.evaluate(() => {
      const active = document.activeElement;
      (window as unknown as { kept: Element | null }).kept = active;
      return {
        tag: active?.tagName,
        inPanel: !!active?.closest("#project-selection button, fieldset"),
      };
    });
    // Somewhere real, and on nothing an update is about to remove.
    expect(where.tag).not.toBe("BODY");
    expect(where.inPanel).toBe(false);
  };
  const stayedThere = () =>
    page.evaluate(
      () =>
        document.activeElement ===
        (window as unknown as { kept: Element | null }).kept,
    );

  // Loading, and the focus moves to the list's own button: the picker
  // replaces the list with that button, so the focus goes into the picker.
  await change.focus();
  await page.keyboard.press("Enter");
  await expect(loading).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(showAll).toBeFocused();
  answer.open();
  await expect(beta).toBeChecked();
  await expect(showAll).toHaveCount(0);
  await expect(mode).toBeFocused();
  await focusIsSomewhere(page);

  // Cancelled: back on the button that opens the picker.
  await cancel.focus();
  await page.keyboard.press("Enter");
  await expect(change).toBeFocused();
  await focusIsSomewhere(page);

  // Loading, and the user tabs out of the panel: the picker opens, the
  // focus stays where they put it.
  answer = gate();
  await page.keyboard.press("Enter");
  await expect(loading).toBeFocused();
  await tabOut(2);
  answer.open();
  await expect(beta).toBeChecked();
  expect(await stayedThere()).toBe(true);
  await expect(mode).not.toBeFocused();
  await focusIsSomewhere(page);

  // Loading, and the user clicks on text of the page: that takes the focus
  // off the button, onto nothing. The picker opens and does not pull it in.
  await cancel.focus();
  await page.keyboard.press("Enter");
  await expect(change).toBeFocused();
  answer = gate();
  await page.keyboard.press("Enter");
  await expect(loading).toBeFocused();
  await page.getByRole("heading", { level: 1 }).click();
  await expect(loading).not.toBeFocused();
  answer.open();
  await expect(beta).toBeChecked();
  await expect(mode).not.toBeFocused();
  expect(
    await page.evaluate(() => document.activeElement === document.body),
  ).toBe(true);

  // Saving, and the user tabs out: the picker closes, the focus stays.
  answer = gate();
  await beta.uncheck();
  await focusIsSomewhere(page);
  await save.focus();
  await page.keyboard.press("Enter");
  await expect(saving).toBeFocused();
  await tabOut(1);
  answer.open();
  await expect(panel.getByText(t.projects.saved)).toBeVisible();
  await expect(change).toBeVisible();
  expect(await stayedThere()).toBe(true);
  await expect(change).not.toBeFocused();
  await focusIsSomewhere(page);

  // Staying in the panel through slow answers. The list opens: into the
  // picker.
  await saveSelection(connectionId, selection);
  await page.goto(url);
  await expect(showAll).toBeVisible();
  answer = gate();
  await change.focus();
  await page.keyboard.press("Enter");
  await expect(loading).toBeFocused();
  answer.open();
  await expect(mode).toBeFocused();
  await focusIsSomewhere(page);

  // Saved with Enter in the search field, which is disabled while saving:
  // the focus goes to Save, and from there back to the button that opens
  // the picker when it closes.
  answer = gate();
  refresh = gate();
  await beta.focus();
  await page.keyboard.press("Space");
  await expect(beta).not.toBeChecked();
  await expect(beta).toBeFocused();
  // The refresh after the save has started, and is held, before the focus
  // moves onto the list's button below.
  const refreshing = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === url &&
      new URL(request.url()).searchParams.has("_rsc"),
  );
  await panel.getByRole("searchbox", { name: t.projects.search }).focus();
  await page.keyboard.press("Enter");
  await expect(saving).toBeFocused();
  await focusIsSomewhere(page);
  answer.open();
  await expect(panel.getByText(t.projects.saved)).toBeVisible();
  await expect(change).toBeFocused();
  await focusIsSomewhere(page);

  // The page has not refreshed yet: the list still has its button. With
  // the focus on it, the saved selection arrives, short enough to need no
  // button: the focus goes to the button under the list, not to the page.
  await refreshing;
  await page.keyboard.press("Shift+Tab");
  await expect(showAll).toBeFocused();
  refresh.open();
  await expect(items).toHaveText(["alpha-site"]);
  await expect(showAll).toHaveCount(0);
  await expect(change).toBeFocused();
  await focusIsSomewhere(page);
});

test("the project list's pages by keyboard: the ends keep the focus", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = messages(locale);
  const { workspaceId } = await startWorkspace(page, locale);
  const connectionId = await seedConnection(workspaceId);
  const path = `/v1/workspaces/${workspaceId}/connections/${connectionId}`;
  // 120 projects: three pages of 50, 50 and 20.
  const projects = Array.from({ length: 120 }, (_, index) => ({
    id: `prj_${String(index).padStart(3, "0")}`,
    name: `site-${String(index).padStart(3, "0")}`,
    kind: "project",
    metadata: { accountId: "team_fixture", webAnalytics: true },
  }));
  await page.route(`**${path}/preview`, (route) =>
    route.fulfill({
      json: {
        check: { ok: true },
        resources: projects,
        selection: ["prj_000"],
      },
    }),
  );

  await page.goto(`/workspaces/${workspaceId}/connections/${connectionId}`);
  const panel = page.locator("#project-selection");
  const change = panel.getByRole("button", { name: t.projects.check });
  await change.focus();
  await page.keyboard.press("Enter");

  const pager = panel.getByRole("navigation", { name: t.projects.pages });
  const previous = pager.getByRole("button", { name: t.projects.previous });
  const next = pager.getByRole("button", { name: t.projects.next });
  // The page in words, in a live region: read out when it changes.
  const indicator = pager.getByRole("status");
  const pageOf = (current: number) =>
    t.projects.page.replace("{page}", String(current)).replace("{pages}", "3");
  const rows = panel.locator(".app-picker-list").getByRole("checkbox");
  const first = (name: string) =>
    expect(rows.first()).toHaveAccessibleName(new RegExp(name));

  await expect(indicator).toHaveText(pageOf(1));
  await expect(rows).toHaveCount(50);
  await first("site-000");
  await expect(previous).toHaveAttribute("aria-disabled", "true");
  await expect(next).toHaveAttribute("aria-disabled", "false");

  // At the first page "Previous" does nothing and keeps the focus.
  await previous.focus();
  await page.keyboard.press("Enter");
  await expect(indicator).toHaveText(pageOf(1));
  await first("site-000");
  await expect(previous).toBeFocused();
  await focusIsSomewhere(page);

  // Forward to the last page: the focus stays on "Next" throughout.
  await next.focus();
  await page.keyboard.press("Enter");
  await expect(indicator).toHaveText(pageOf(2));
  await first("site-050");
  await expect(next).toBeFocused();
  await expect(previous).toHaveAttribute("aria-disabled", "false");
  await page.keyboard.press("Enter");
  await expect(indicator).toHaveText(pageOf(3));
  await expect(rows).toHaveCount(20);
  await first("site-100");
  await expect(next).toBeFocused();
  await expect(next).toHaveAttribute("aria-disabled", "true");
  await focusIsSomewhere(page);

  // At the last page "Next" does nothing and keeps the focus.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  await expect(indicator).toHaveText(pageOf(3));
  await first("site-100");
  await expect(rows).toHaveCount(20);
  await expect(next).toBeFocused();
  await focusIsSomewhere(page);

  // And back.
  await previous.focus();
  await page.keyboard.press("Enter");
  await expect(indicator).toHaveText(pageOf(2));
  await expect(previous).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(indicator).toHaveText(pageOf(1));
  await expect(previous).toBeFocused();
  await expect(previous).toHaveAttribute("aria-disabled", "true");
  await focusIsSomewhere(page);

  // A search that leaves one page takes the page buttons away; the focus
  // is in the search field and stays there.
  const search = panel.getByRole("searchbox", { name: t.projects.search });
  await search.focus();
  await page.keyboard.type("site-11");
  await expect(rows).toHaveCount(10);
  await expect(pager).toHaveCount(0);
  await expect(search).toBeFocused();
});
