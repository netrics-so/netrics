import { expect, test } from "@playwright/test";
import postgres from "postgres";

import { workspaceDe } from "../apps/web/src/messages/workspace/de.ts";
import { workspaceEn } from "../apps/web/src/messages/workspace/en.ts";
import { posthogManifest } from "../packages/connectors/src/posthog/index.ts";
import { type Locale } from "./support/labels.ts";
import { startWorkspace } from "./support/session.ts";
import { ownerUrl } from "./support/store-template.ts";

// PostHog's saved insights are chosen in a picker per project (#891), in
// English and German: after the key check each project lists its saved
// trends insights with none chosen, at most 20 in all, and the choice is
// what the connection stores. An existing connection's pasted link shows
// as chosen, and a change is saved. Without network: the calls that would
// ask PostHog (the check, the insight lists, the create and the save,
// which check the key there) answer from fixtures; the connector's
// contract tests and apps/server's posthog-insight-picker.test.ts cover
// them against a stand-in for PostHog.

const messages = (locale: Locale) =>
  (locale === "de" ? workspaceDe : workspaceEn).connections;

const fill = (text: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
    text,
  );

const PROJECTS = [
  { id: "1000", name: "Website", kind: "project" },
  { id: "1001", name: "Mobile app", kind: "project" },
];

const INSIGHTS: Record<string, Array<{ value: string; label: string }>> = {
  "1000": [
    { value: "1000/AbCd1234", label: "Signups" },
    { value: "1000/EfGh5678", label: "Weekly revenue" },
  ],
  "1001": [{ value: "1001/IjKl9012", label: "App opens" }],
};

const listing = (
  resourceId: string,
  selected: Array<{ value: string; resourceId: string }> = [],
) => ({
  options: (INSIGHTS[resourceId] ?? []).map((option) => ({
    ...option,
    description: option.value.split("/")[1],
  })),
  selected,
});

/** A PostHog connection syncing the first project, with a pasted link. */
async function seedConnection(workspaceId: string): Promise<string> {
  const sql = postgres(ownerUrl(), { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql<{ id: string }[]>`
      insert into connections
        (workspace_id, connector_id, name, setup_pending, config,
         credentials_encrypted)
      values (${workspaceId}, 'posthog', 'PostHog', false,
        ${sql.json({
          host: "us.posthog.com",
          insights: "https://us.posthog.com/project/1000/insights/AbCd1234",
          resourceSelection: ["1000"],
        })},
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
      values (${id}, ${workspaceId}, '1000', 'Website', 'project')`;
    return id;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test("new PostHog connection: insights are chosen per project, none at first", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = messages(locale);
  const { workspaceId } = await startWorkspace(page, locale);
  const connectionId = await seedConnection(workspaceId);
  const base = `/v1/workspaces/${workspaceId}/connections`;

  const listed: Array<Record<string, unknown>> = [];
  const created: Array<Record<string, unknown>> = [];
  await page.route(`**${base}/preview`, (route) =>
    route.fulfill({ json: { check: { ok: true }, resources: PROJECTS } }),
  );
  await page.route(`**${base}/config-options`, (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    listed.push(body);
    return route.fulfill({ json: listing(String(body.resourceId)) });
  });
  await page.route(`**${base}`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    created.push(route.request().postDataJSON() as Record<string, unknown>);
    // What the API answers once PostHog accepted the key: a connection.
    const current = await page.request.get(`${base}/${connectionId}`);
    const { connection } = (await current.json()) as { connection: unknown };
    return route.fulfill({ json: { connection } });
  });

  await page.goto(`/workspaces/${workspaceId}/connections/new`);
  await page
    .getByRole("button", { name: /PostHog/ })
    .first()
    .click();
  const insightsTitle =
    posthogManifest.translations?.[locale]?.config?.insights?.title ??
    "Saved insights";
  // Typed no more: the field is a picker once the key is checked.
  await expect(page.locator("#config-insights")).toHaveCount(0);
  await page.locator("#connection-token").fill("phx_not_a_real_key");
  await page.getByRole("button", { name: t.wizard.test }).click();

  const picker = page.getByTestId("config-options-insights");
  await expect(picker.locator("legend")).toContainText(insightsTitle);
  await expect(
    picker.getByText(t.configOptions.noneChosen, { exact: true }),
  ).toBeVisible();
  // Nothing is listed before a project is opened.
  expect(listed).toEqual([]);
  await expect(picker.getByRole("checkbox")).toHaveCount(0);

  await picker
    .getByRole("button", {
      name: fill(t.configOptions.show, { resource: "Website" }),
    })
    .click();
  const signups = picker.getByRole("checkbox", { name: /Signups/ });
  const revenue = picker.getByRole("checkbox", { name: /Weekly revenue/ });
  await expect(signups).not.toBeChecked();
  await expect(revenue).not.toBeChecked();
  // One listing, for that project, with the draft key and settings.
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({
    connectorId: "posthog",
    key: "insights",
    resourceId: "1000",
    credentials: { token: "phx_not_a_real_key" },
  });

  await revenue.check();
  await picker
    .getByRole("button", {
      name: fill(t.configOptions.show, { resource: "Mobile app" }),
    })
    .click();
  await picker.getByRole("checkbox", { name: /App opens/ }).check();
  await expect(
    picker.getByText(fill(t.configOptions.chosen, { count: 2, max: 20 }), {
      exact: true,
    }),
  ).toBeVisible();
  // Chosen insights are listed apart from the project lists, each
  // removable (#891 review).
  const chosen = picker.getByRole("list", { name: t.configOptions.chosenList });
  await expect(chosen.getByRole("listitem")).toHaveCount(2);
  await expect(chosen).toContainText("App opens (Mobile app)");

  // Unticking a project leaves it out of the connection, and its chosen
  // insights with it.
  await page.getByRole("checkbox", { name: /^Mobile app/ }).uncheck();
  await expect(chosen.getByRole("listitem")).toHaveCount(1);
  await expect(chosen).toContainText("Weekly revenue (Website)");
  await expect(
    picker.getByText(fill(t.configOptions.chosen, { count: 1, max: 20 }), {
      exact: true,
    }),
  ).toBeVisible();

  await page.getByRole("button", { name: t.wizard.create }).click();
  await expect(page).toHaveURL(
    new RegExp(`/workspaces/${workspaceId}/connections/${connectionId}`),
  );
  expect(created).toHaveLength(1);
  expect((created[0]!.config as Record<string, unknown>).insights).toBe(
    "1000/EfGh5678",
  );
});

test("existing PostHog connection: a pasted insight shows as chosen and the choice is saved", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = messages(locale);
  const { workspaceId } = await startWorkspace(page, locale);
  const connectionId = await seedConnection(workspaceId);
  const path = `/v1/workspaces/${workspaceId}/connections/${connectionId}`;

  const listed: Array<Record<string, unknown>> = [];
  const saved: Array<Record<string, unknown>> = [];
  await page.route(`**${path}/config-options`, (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    listed.push(body);
    // The pasted link, read by the connector into the picker's value.
    return route.fulfill({
      json: listing(String(body.resourceId), [
        { value: "1000/AbCd1234", resourceId: "1000" },
      ]),
    });
  });
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    saved.push(route.request().postDataJSON() as Record<string, unknown>);
    const current = await page.request.get(path);
    return route.fulfill({ json: await current.json() });
  });

  await page.goto(`/workspaces/${workspaceId}/connections/${connectionId}`);
  const form = page.locator("#edit-connection");
  const picker = form.getByTestId("config-options-insights");
  // One synced project: its list opens by itself, with the stored draft.
  const signups = picker.getByRole("checkbox", { name: /Signups/ });
  const revenue = picker.getByRole("checkbox", { name: /Weekly revenue/ });
  await expect(signups).toBeChecked();
  await expect(revenue).not.toBeChecked();
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({
    key: "insights",
    resourceId: "1000",
    config: {
      host: "us.posthog.com",
      insights: "https://us.posthog.com/project/1000/insights/AbCd1234",
    },
  });
  await expect(
    picker.getByText(fill(t.configOptions.chosen, { count: 1, max: 20 }), {
      exact: true,
    }),
  ).toBeVisible();

  // The stored choice is removed from the chosen list, not only from its
  // project's list (#891 review).
  await picker
    .getByRole("button", {
      name: fill(t.configOptions.remove, { choice: "Signups" }),
    })
    .click();
  await expect(signups).not.toBeChecked();
  await revenue.check();
  await form.getByRole("button", { name: t.edit.saveChanges }).click();
  await expect(form.getByText(t.edit.updated)).toBeVisible();
  expect(saved).toHaveLength(1);
  expect((saved[0]!.config as Record<string, unknown>).insights).toBe(
    "1000/EfGh5678",
  );
});

test("existing PostHog connection: a choice removed while the first list loads stays removed (#937)", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = messages(locale);
  const { workspaceId } = await startWorkspace(page, locale);
  const connectionId = await seedConnection(workspaceId);
  const path = `/v1/workspaces/${workspaceId}/connections/${connectionId}`;
  const pasted = "https://us.posthog.com/project/1000/insights/AbCd1234";

  const listed: Array<Record<string, unknown>> = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${path}/config-options`, async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    listed.push(body);
    // The first answer is delayed until the stored choice was removed.
    if (listed.length === 1) await held;
    // As the connector reads the draft it was sent: the pasted link is
    // chosen while the draft still names it.
    const insights = String(
      (body.config as Record<string, unknown>).insights ?? "",
    );
    return route.fulfill({
      json: listing(
        String(body.resourceId),
        insights.includes("AbCd1234")
          ? [{ value: "1000/AbCd1234", resourceId: "1000" }]
          : [],
      ),
    });
  });

  await page.goto(`/workspaces/${workspaceId}/connections/${connectionId}`);
  const form = page.locator("#edit-connection");
  const picker = form.getByTestId("config-options-insights");
  await expect.poll(() => listed.length).toBe(1);
  await picker
    .getByRole("button", {
      name: fill(t.configOptions.remove, { choice: pasted }),
    })
    .click();
  release();

  // Listed again with the draft of now, which no longer names it.
  await expect.poll(() => listed.length).toBe(2);
  expect(
    (listed[1]!.config as Record<string, unknown>).insights,
  ).toBeUndefined();
  const signups = picker.getByRole("checkbox", { name: /Signups/ });
  await expect(signups).toBeVisible();
  await expect(signups).not.toBeChecked();
  await expect(
    picker.getByText(fill(t.configOptions.chosen, { count: 0, max: 20 }), {
      exact: true,
    }),
  ).toBeVisible();
});

test("new PostHog connection: a project ID spelled anew keeps its chosen insights (#937)", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = messages(locale);
  const { workspaceId } = await startWorkspace(page, locale);
  const connectionId = await seedConnection(workspaceId);
  const base = `/v1/workspaces/${workspaceId}/connections`;

  const created: Array<Record<string, unknown>> = [];
  // A key limited to projects: the projects are the IDs typed, spelled as
  // typed, and a choice belongs to the project as the draft spells it.
  const projectOf = (body: Record<string, unknown>) =>
    String((body.config as Record<string, unknown>).projects ?? "");
  await page.route(`**${base}/preview`, (route) => {
    const id = projectOf(route.request().postDataJSON());
    return route.fulfill({
      json: {
        check: { ok: true },
        resources: [{ id, name: id, kind: "project" }],
      },
    });
  });
  await page.route(`**${base}/config-options`, (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const insights = String(
      (body.config as Record<string, unknown>).insights ?? "",
    );
    return route.fulfill({
      json: {
        ...listing("1000"),
        selected: insights
          .split(/\s+/)
          .filter((value) => value !== "")
          .map((value) => ({ value, resourceId: projectOf(body) })),
      },
    });
  });
  await page.route(`**${base}`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    created.push(route.request().postDataJSON() as Record<string, unknown>);
    const current = await page.request.get(`${base}/${connectionId}`);
    const { connection } = (await current.json()) as { connection: unknown };
    return route.fulfill({ json: { connection } });
  });

  await page.goto(`/workspaces/${workspaceId}/connections/new`);
  await page
    .getByRole("button", { name: /PostHog/ })
    .first()
    .click();
  await page.locator("#connection-token").fill("phx_not_a_real_key");
  await page.locator("#config-projects").fill("01000");
  await page.getByRole("button", { name: t.wizard.test }).click();

  const picker = page.getByTestId("config-options-insights");
  // One project: its list opens by itself.
  await picker.getByRole("checkbox", { name: /Weekly revenue/ }).check();
  const chosen = picker.getByRole("list", { name: t.configOptions.chosenList });
  await expect(chosen).toContainText("Weekly revenue (01000)");

  // The same project, spelled without its leading zero, checked again.
  await page.locator("#config-projects").fill("1000");
  await page.getByRole("button", { name: t.wizard.test }).click();
  await expect(
    picker.getByRole("checkbox", { name: /Weekly revenue/ }),
  ).toBeChecked();
  await expect(chosen).toContainText("Weekly revenue (1000)");
  await expect(
    picker.getByText(fill(t.configOptions.chosen, { count: 1, max: 20 }), {
      exact: true,
    }),
  ).toBeVisible();

  await page.getByRole("button", { name: t.wizard.create }).click();
  await expect(page).toHaveURL(
    new RegExp(`/workspaces/${workspaceId}/connections/${connectionId}`),
  );
  expect(created).toHaveLength(1);
  expect((created[0]!.config as Record<string, unknown>).insights).toBe(
    "1000/EfGh5678",
  );
});

test("new PostHog connection: project IDs changed to others drop a project's insights before create (#937 review)", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = messages(locale);
  const { workspaceId } = await startWorkspace(page, locale);
  const connectionId = await seedConnection(workspaceId);
  const base = `/v1/workspaces/${workspaceId}/connections`;

  const listed: Array<Record<string, unknown>> = [];
  const created: Array<Record<string, unknown>> = [];
  const configOf = (body: Record<string, unknown>) =>
    body.config as Record<string, unknown>;
  // A key limited to projects: the projects are the IDs typed.
  await page.route(`**${base}/preview`, (route) => {
    const ids = String(configOf(route.request().postDataJSON()).projects)
      .split(/\s+/)
      .filter((id) => id !== "");
    return route.fulfill({
      json: {
        check: { ok: true },
        resources: ids.map((id) => ({ id, name: id, kind: "project" })),
      },
    });
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${base}/config-options`, async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    listed.push(body);
    // The listing after the IDs changed waits, so create is tried first.
    if (listed.length === 2) await held;
    // An insight belongs to its own project, named or not.
    const insights = String(configOf(body).insights ?? "");
    return route.fulfill({
      json: {
        ...listing(String(body.resourceId)),
        selected: insights
          .split(/\s+/)
          .filter((value) => value !== "")
          .map((value) => ({ value, resourceId: value.split("/")[0]! })),
      },
    });
  });
  await page.route(`**${base}`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    created.push(route.request().postDataJSON() as Record<string, unknown>);
    const current = await page.request.get(`${base}/${connectionId}`);
    const { connection } = (await current.json()) as { connection: unknown };
    return route.fulfill({ json: { connection } });
  });

  await page.goto(`/workspaces/${workspaceId}/connections/new`);
  await page
    .getByRole("button", { name: /PostHog/ })
    .first()
    .click();
  await page.locator("#connection-token").fill("phx_not_a_real_key");
  await page.locator("#config-projects").fill("1000");
  await page.getByRole("button", { name: t.wizard.test }).click();
  const picker = page.getByTestId("config-options-insights");
  await picker.getByRole("checkbox", { name: /Weekly revenue/ }).check();

  // Two other projects: no list opens by itself.
  await page.locator("#config-projects").fill("1001 1002");
  await page.getByRole("button", { name: t.wizard.test }).click();
  await expect(
    picker.getByRole("button", {
      name: fill(t.configOptions.show, { resource: "1001" }),
    }),
  ).toBeVisible();
  // The chosen insight's project is in neither: one listing settles it,
  // and nothing is created meanwhile.
  await expect.poll(() => listed.length).toBe(2);
  expect(configOf(listed[1]!).insights).toBe("1000/EfGh5678");
  const create = page.getByRole("button", { name: t.wizard.create });
  await expect(create).toBeDisabled();
  release();
  await expect(
    picker.getByText(fill(t.configOptions.chosen, { count: 0, max: 20 }), {
      exact: true,
    }),
  ).toBeVisible();
  await expect(picker.getByRole("checkbox")).toHaveCount(0);

  await create.click();
  await expect(page).toHaveURL(
    new RegExp(`/workspaces/${workspaceId}/connections/${connectionId}`),
  );
  expect(created).toHaveLength(1);
  expect(configOf(created[0]!).insights).toBeUndefined();
});
