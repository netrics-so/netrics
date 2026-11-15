import { expect, test } from "@playwright/test";
import { dashboardsDe } from "../apps/web/src/messages/dashboards/de.ts";
import { dashboardsEn } from "../apps/web/src/messages/dashboards/en.ts";
import { fill, labels, type Locale } from "./support/labels.ts";
import { ORIGIN } from "./support/origin.ts";
import { startWorkspace } from "./support/session.ts";
import {
  installWithUpdate,
  OLD_MEASURE_NAME,
  pairScreen,
  publishedMeasureName,
} from "./support/store-template.ts";

/** One branch of a `{count, plural, …}` message, e.g. `=0`. */
const pluralBranch = (message: string, branch: string) =>
  // A branch may hold `{name}` placeholders, one level deep.
  new RegExp(`${branch} \\{((?:[^{}]|\\{[^{}]*\\})*)\\}`).exec(message)![1]!;

const updateLabels = (locale: Locale) =>
  (locale === "de" ? dashboardsDe : dashboardsEn)
    .storeUpdate as (typeof dashboardsEn)["storeUpdate"];

/**
 * Template updates (11E) in the browser, in English and in German: the
 * template's dashboard says "Update available"; the customer reviews the
 * update, decides the one conflict (nothing is decided for them), applies
 * it as drafts, publishes the model draft in data settings through the
 * impact confirmation, creates the updated copy, swaps it onto the screens
 * (the original is archived) and switches back.
 */
test("a customer reviews and applies a store-template update", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const u = updateLabels(locale),
    data = labels(locale);
  const name = "App portfolio";

  const { workspaceId } = await startWorkspace(page, locale);
  const { requestId, dashboardId, modelId } = await installWithUpdate(
    page,
    workspaceId,
  );
  const updatePath = `/workspaces/${workspaceId}/dashboards/stores/updates/${requestId}`;
  // A paired screen shows the original throughout, until the swap.
  const servedOnLobby = await pairScreen(page, workspaceId, {
    name: "Lobby",
    dashboardId,
  });
  expect(await servedOnLobby()).toBe(dashboardId);
  const titles = async (id: string) => {
    const response = await page.request.get(
      `/v1/workspaces/${workspaceId}/dashboards/${id}`,
    );
    expect(response.status()).toBe(200);
    const body = (await response.json()) as {
      dashboard: { slides: { widgets: { title: string | null }[] }[] };
    };
    return body.dashboard.slides.flatMap((slide) =>
      slide.widgets.map((widget) => widget.title),
    );
  };
  const originalTitles = await titles(dashboardId);
  expect(originalTitles).toEqual(
    expect.arrayContaining(["My downloads", "Proceeds (v0)"]),
  );
  /** Nothing the customer's screens or dashboards use has changed yet. */
  const nothingChangedYet = async () => {
    expect(await publishedMeasureName(workspaceId, modelId)).toBe(
      OLD_MEASURE_NAME,
    );
    expect(await titles(dashboardId)).toEqual(originalTitles);
    expect(await servedOnLobby()).toBe(dashboardId);
  };
  // Swaps ask first, in the app's dialog (never a native one, #625); the
  // questions name the screens.
  page.on("dialog", (dialog) => {
    throw new Error(`native dialog: ${dialog.message()}`);
  });
  /** Answers the app's question with its confirm button; returns its text. */
  const confirmIn = async (confirm: string) => {
    const question = page.getByRole("dialog");
    await expect(question).toBeVisible();
    const text = (await question.locator("p").textContent()) ?? "";
    await question.getByRole("button", { name: confirm, exact: true }).click();
    await expect(question).toBeHidden();
    return text;
  };

  // 1. The dashboard says an update is available; the badge opens it.
  await page.goto(`/workspaces/${workspaceId}/dashboards`);
  const badge = page.getByRole("link", {
    name: fill(u.badgeNamed, { name }),
  });
  await expect(badge).toHaveText(u.badge);
  await badge.click();
  await expect(page).toHaveURL(updatePath);
  await expect(
    page.getByRole("heading", { level: 1, name: fill(u.title, { name }) }),
  ).toBeVisible();

  // 2. Review: each record says in a line what the template changes; the
  // item list is behind a disclosure. The conflict waits for the choice.
  await expect(
    page.getByText(
      fill(u.changes.fromTemplate, {
        changes: pluralBranch(u.changes.measure.changed, "one").replace(
          "#",
          "1",
        ),
      }),
    ),
  ).toBeVisible();
  await expect(
    page.locator("details.store-update-details").first(),
  ).not.toHaveAttribute("open");
  await expect(
    page.getByRole("heading", { name: u.groups.choose }),
  ).toBeVisible();
  await expect(page.getByText(u.why.both).first()).toBeVisible();
  const apply = page.getByRole("button", { name: u.apply });
  await expect(apply).toBeDisabled();
  for (const radio of await page.getByRole("radio").all())
    await expect(radio).not.toBeChecked();
  for (const choice of await page
    .getByRole("radio", { name: u.useTemplate })
    .all())
    await choice.check();
  for (const removal of await page
    .getByRole("radio", { name: u.keep, exact: true })
    .all())
    await removal.check();
  await expect(apply).toBeEnabled();
  await apply.click();
  // Applied: focus moves to the progress, which says what happened.
  await expect(
    page.getByRole("status").filter({ hasText: u.done.applied }),
  ).toBeVisible();
  await expect(page.locator(".store-update-progress")).toBeFocused();
  // Drafts only: the published model and the dashboard are as they were.
  await nothingChangedYet();

  // 3. The model draft is published in data settings, impact first.
  const publishStep = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: u.steps.publish }) });
  await expect(publishStep.getByText(u.progress.draft)).toBeVisible();
  const createCopy = page.getByRole("button", {
    name: u.progress.createCopy,
  });
  await expect(createCopy).toBeDisabled();
  await publishStep
    .getByRole("link", { name: u.progress.openDraft })
    .first()
    .click();
  await expect(page).toHaveURL(/\/data\?model=/);
  // The normal flow: preview the draft, then publish it. Store measures
  // keep stores separate; the editor already groups the preview by Store,
  // and only by Store (#603), so nothing needs choosing.
  const groupBy = page.getByRole("group", { name: data.groupBy });
  await expect(
    groupBy.getByRole("checkbox", { name: "Store", exact: true }),
  ).toBeChecked();
  await expect(groupBy.getByRole("checkbox", { checked: true })).toHaveCount(1);
  await page
    .getByRole("region", { name: data.preview, exact: true })
    .getByRole("button", { name: data.preview, exact: true })
    .click();
  const publish = page.getByRole("button", { name: data.publish, exact: true });
  await expect(publish).toBeEnabled();
  await publish.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: data.impact.confirm, exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: data.publishedNotice }),
  ).toBeVisible();
  expect(await publishedMeasureName(workspaceId, modelId)).not.toBe(
    OLD_MEASURE_NAME,
  );

  // 4. Back on the update: the copy is made from the published data.
  await page.goto(updatePath);
  await expect(publishStep.getByText(u.progress.published)).toBeVisible();
  await expect(createCopy).toBeEnabled();
  await createCopy.click();
  await expect(
    page.getByRole("status").filter({ hasText: u.done.copy }),
  ).toBeVisible();
  await expect(page.locator(".store-update-progress")).toBeFocused();
  const openCopy = page.getByRole("link", { name: u.progress.openCopy });
  await expect(openCopy).toBeVisible();
  const copyHref = await openCopy.getAttribute("href");
  const copyId = copyHref!.split("/").at(-2)!;
  expect(copyId).not.toBe(dashboardId);
  // The copy has the template's titles; the original and the screen are
  // untouched.
  expect(await titles(copyId)).not.toContain("My downloads");
  expect(await titles(copyId)).not.toContain("Proceeds (v0)");
  expect(await titles(dashboardId)).toEqual(originalTitles);
  expect(await servedOnLobby()).toBe(dashboardId);

  // 5. Compare in Studio: the copy says what it is.
  await openCopy.click();
  await expect(
    page.getByText(u.studioCopy.split(".")[0]!, { exact: false }),
  ).toBeVisible();
  await page.goto(updatePath);

  // 6. Swap onto the screens, after a question naming them.
  await expect(
    page.getByText(
      pluralBranch(u.progress.screens, "one")
        .replace("#", "1")
        .replace("{screens}", "Lobby"),
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: u.progress.swap }).click();
  expect(await confirmIn(u.progress.swap)).toContain(
    pluralBranch(u.progress.confirmSwap, "one")
      .replace("#", "1")
      .replace("{screens}", "Lobby"),
  );
  await expect(
    page.getByRole("status").filter({ hasText: u.done.swap }),
  ).toBeVisible();
  await expect(page.getByText(u.progress.swapped)).toBeVisible();
  await expect(page.getByText(u.progress.finished)).toBeVisible();
  expect(await servedOnLobby()).toBe(copyId);

  // The archived original opens read-only, never in the Studio.
  await page.goto(
    `/workspaces/${workspaceId}/dashboards/${dashboardId}/studio`,
  );
  await expect(page).toHaveURL(
    `/workspaces/${workspaceId}/dashboards/${dashboardId}`,
  );
  await expect(page.getByText(u.studioArchived)).toBeVisible();

  // 7. The original is archived: not in the grid, in its own section.
  await page.goto(`/workspaces/${workspaceId}/dashboards`);
  const grid = page.getByRole("list", {
    name: (locale === "de" ? dashboardsDe : dashboardsEn).dashboardsPage.list,
  });
  await expect(grid.getByText(name, { exact: true })).toHaveCount(0);
  const archived = page.locator("details.dashboards-archived");
  await archived.locator("summary").click();
  await expect(archived.getByText(name, { exact: true })).toBeVisible();
  await archived.getByRole("link", { name: u.switchBackLink }).click();
  await expect(page).toHaveURL(updatePath);

  // 8. Switch back: the original returns, the update is offered again.
  await page.getByRole("button", { name: u.progress.switchBack }).click();
  expect(await confirmIn(u.progress.switchBack)).toContain(
    pluralBranch(u.progress.confirmSwapBack, "one")
      .replace("#", "1")
      .replace("{screens}", "Lobby"),
  );
  await expect(
    page.getByRole("status").filter({ hasText: u.done.swapBack }),
  ).toBeVisible();
  await expect(page.getByText(u.progress.switchedBack)).toBeVisible();
  expect(await servedOnLobby()).toBe(dashboardId);
  await expect(
    page.getByRole("button", { name: u.progress.swapAgain }),
  ).toBeVisible();
  const list = await page.request.get(
    `/v1/workspaces/${workspaceId}/dashboards`,
  );
  const { dashboards } = (await list.json()) as {
    dashboards: { id: string }[];
  };
  expect(dashboards.map((d) => d.id)).toContain(dashboardId);
  expect(dashboards.map((d) => d.id)).not.toContain(copyId);
  // The archived copy is read-only too, and says why.
  await expect(
    page.getByRole("link", { name: u.progress.viewArchivedCopy }),
  ).toHaveAttribute("href", `/workspaces/${workspaceId}/dashboards/${copyId}`);
  await page.goto(`/workspaces/${workspaceId}/dashboards/${copyId}/studio`);
  await expect(page).toHaveURL(
    `/workspaces/${workspaceId}/dashboards/${copyId}`,
  );
  await expect(page.getByText(u.studioArchivedCopy)).toBeVisible();
});

/**
 * An update that changes data only (#625, #626): once its draft is
 * published it is finished and stays finished, also after an input of the
 * model is published again; no empty update is offered afterwards (no
 * badge, no data banner, no review), and stopping an update asks in the
 * app's dialog.
 */
test("a data-only update finishes and offers nothing empty afterwards", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const u = updateLabels(locale);
  const name = "App portfolio";
  page.on("dialog", (dialog) => {
    throw new Error(`native dialog: ${dialog.message()}`);
  });
  const { workspaceId } = await startWorkspace(page, locale);
  const { requestId, modelId } = await installWithUpdate(page, workspaceId, {
    dashboard: false,
  });
  const updatePath = `/workspaces/${workspaceId}/dashboards/stores/updates/${requestId}`;
  const api = `/v1/workspaces/${workspaceId}`;
  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(`${api}${path}`, {
      headers: { origin: ORIGIN },
      data,
    });
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  };
  const install = async () => {
    const response = await page.request.get(
      `${api}/dashboard-templates/stores/installs`,
    );
    expect(response.status()).toBe(200);
    const { installs } = (await response.json()) as {
      installs: {
        requestId: string;
        updateAvailable: boolean;
        openUpdate: unknown;
        preparationIds: string[];
      }[];
    };
    return installs.find((candidate) => candidate.requestId === requestId)!;
  };

  // Review and apply: one record, summarised.
  await page.goto(updatePath);
  await expect(
    page.getByText(
      fill(u.changes.fromTemplate, {
        changes: pluralBranch(u.changes.measure.changed, "one").replace(
          "#",
          "1",
        ),
      }),
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: u.apply }).click();
  await expect(
    page.getByRole("status").filter({ hasText: u.done.applied }),
  ).toBeVisible();
  await expect(page.getByText(u.progress.noDashboards)).toBeVisible();

  // Stopping asks in the app's dialog; cancelling keeps the update.
  await page.getByRole("button", { name: u.progress.close }).click();
  const question = page.getByRole("dialog");
  await expect(question).toBeVisible();
  await expect(
    question.getByRole("heading", { name: u.confirm.closeTitle }),
  ).toBeVisible();
  await question
    .getByRole("button", { name: u.confirm.cancel, exact: true })
    .click();
  await expect(question).toBeHidden();
  expect((await install()).openUpdate).not.toBeNull();

  // The model draft is published: the update is finished.
  const readModel = async () => {
    const response = await page.request.get(`${api}/data/models/${modelId}`);
    expect(response.status()).toBe(200);
    return ((await response.json()) as { model: { version: number } }).model;
  };
  await post(`/data/models/${modelId}/publish`, {
    version: (await readModel()).version,
  });
  await page.goto(updatePath);
  await expect(page.getByText(u.upToDate)).toBeVisible();
  await expect(page.getByRole("button", { name: u.apply })).toHaveCount(0);

  // An input of the model is published again, for another reason: the
  // finished update stays finished and nothing is offered.
  const [preparationId] = (await install()).preparationIds;
  const prepared = await page.request.get(
    `${api}/data/preparations/${preparationId}`,
  );
  const { preparation } = (await prepared.json()) as {
    preparation: { name: string; graph: unknown; version: number };
  };
  const saved = (await (
    await page.request.put(`${api}/data/preparations/${preparationId}`, {
      headers: { origin: ORIGIN },
      data: {
        name: `${preparation.name} (renamed)`,
        graph: preparation.graph,
        version: preparation.version,
      },
    })
  ).json()) as { preparation: { version: number } };
  await post(`/data/preparations/${preparationId}/publish`, {
    version: saved.preparation.version,
  });
  expect(await install()).toMatchObject({
    updateAvailable: false,
    openUpdate: null,
  });
  await page.goto(updatePath);
  await expect(page.getByText(u.upToDate)).toBeVisible();
  await page.goto(`/workspaces/${workspaceId}/dashboards`);
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  await expect(
    page.getByRole("link", { name: fill(u.badgeNamed, { name }) }),
  ).toHaveCount(0);
  await page.goto(`/workspaces/${workspaceId}/data`);
  await expect(
    page.getByRole("region", { name: fill(u.dataBanner, { name }) }),
  ).toHaveCount(0);
});
