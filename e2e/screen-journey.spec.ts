import { expect, test, type Response } from "@playwright/test";
import postgres from "postgres";
import { dashboardsDe } from "../apps/web/src/messages/dashboards/de.ts";
import { dashboardsEn } from "../apps/web/src/messages/dashboards/en.ts";
import { screenDe } from "../apps/web/src/messages/screen/de.ts";
import { screenEn } from "../apps/web/src/messages/screen/en.ts";
import { workspaceDe } from "../apps/web/src/messages/workspace/de.ts";
import { workspaceEn } from "../apps/web/src/messages/workspace/en.ts";
import { fill, labels, type Locale } from "./support/labels.ts";
import { API, ORIGIN } from "./support/origin.ts";
import { startWorkspace } from "./support/session.ts";
import {
  installWithUpdate,
  OLD_MEASURE_NAME,
  ownerUrl,
  publishedMeasureName,
} from "./support/store-template.ts";

const catalogs = (locale: Locale) => ({
  update: (locale === "de" ? dashboardsDe : dashboardsEn)
    .storeUpdate as (typeof dashboardsEn)["storeUpdate"],
  kiosk: (locale === "de" ? screenDe : screenEn).screen
    .kiosk as (typeof screenEn)["screen"]["kiosk"],
  approval: (locale === "de" ? workspaceDe : workspaceEn)
    .deviceApproval as (typeof workspaceEn)["deviceApproval"],
  data: labels(locale),
});

const isDashboardPoll = (response: Response) =>
  response.url().includes("/v1/device/dashboard");

/**
 * The browser kiosk (/kiosk) as a paired screen, end to end (milestone 11):
 *
 * 1. It pairs with a code approved on /devices/approve and plays the
 *    dashboard; cut off, it keeps the dashboard with an offline marker,
 *    also across a reload, and resyncs when the API answers again.
 * 2. Template-update drafts, their preview and the updated copy change
 *    nothing it is served (schemas 1–3, byte for byte); the swap moves it
 *    to the copy, the swap back returns it.
 * 3. Archiving the dashboard's project keeps it playing byte for byte and
 *    takes the dashboard out of the approval picker.
 *
 * The kiosk's page clock is installed so its 60 s poll runs on demand
 * (`clock.fastForward`) instead of in real time.
 *
 * Pairing is limited per IP (PAIRING_RATE_LIMIT: 10 per 10 minutes), and
 * every journey pairs from the same address. A full run makes 4 pairings
 * (this journey and store-update-journey, once per locale), so a third
 * local run within 10 minutes is refused with 429 and the kiosk shows no
 * code. This journey therefore pairs only once.
 */
test("a paired browser screen plays offline and changes only on publish or swap", async ({
  page,
  browser,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const { update: u, kiosk: k, approval: a, data } = catalogs(locale);

  const { workspaceId } = await startWorkspace(page, locale);
  const { requestId, dashboardId, modelId } = await installWithUpdate(
    page,
    workspaceId,
  );
  // The dashboard lives in a project (archived in step 3).
  const created = await page.request.post(
    `/v1/workspaces/${workspaceId}/projects`,
    { headers: { origin: ORIGIN }, data: { name: "Mobile apps" } },
  );
  expect(created.status(), await created.text()).toBe(200);
  const projectId = ((await created.json()) as { project: { id: string } })
    .project.id;
  const sql = postgres(ownerUrl(), { max: 1, onnotice: () => {} });
  try {
    await sql`update dashboards set project_id = ${projectId}
      where workspace_id = ${workspaceId} and id = ${dashboardId}`;
  } finally {
    await sql.end({ timeout: 5 });
  }

  // ── 1. Pair, play, go offline, come back ─────────────────────────────
  const kioskContext = await browser.newContext({
    locale: locale === "de" ? "de-DE" : "en-US",
    viewport: { width: 1920, height: 1080 },
  });
  try {
    const kiosk = await kioskContext.newPage();
    await kiosk.clock.install();
    await kiosk.goto("/kiosk");
    const code = (await kiosk.getByLabel(k.pairingCode).textContent())!.trim();

    await page.goto(`/devices/approve?code=${encodeURIComponent(code)}`);
    const picker = page.locator("#pairing-dashboard option");
    await expect(picker).toContainText(["App portfolio"]);
    await page.locator("#pairing-dashboard").selectOption(dashboardId);
    await page.locator("#pairing-name").fill("Lobby");
    await page.getByRole("button", { name: a.connect }).click();
    await expect(
      page.getByText(fill(a.connected, { name: "Lobby" })),
    ).toBeVisible();

    const original = kiosk.getByText("My downloads").first();
    await expect(original).toBeVisible();

    /** What the screen is served in schemas 1–3, read with its own token. */
    const token = () =>
      kiosk.evaluate(
        () =>
          (
            JSON.parse(
              window.localStorage.getItem("netrics.kiosk.credentials")!,
            ) as { accessToken: string }
          ).accessToken,
      );
    const served = async () => {
      const authorization = `Bearer ${await token()}`;
      const bodies: string[] = [];
      for (const schema of [1, 2, 3]) {
        const response = await page.request.get(
          `${API}/v1/device/dashboard?schema=${schema}`,
          { headers: { authorization } },
        );
        expect(response.status(), await response.text()).toBe(200);
        bodies.push(await response.text());
      }
      return bodies;
    };
    const servedId = async () =>
      (JSON.parse((await served())[2]!) as { dashboard: { id: string } })
        .dashboard.id;
    const refreshMs =
      (JSON.parse((await served())[2]!) as { refreshAfterSec: number })
        .refreshAfterSec * 1000;
    /** Runs the kiosk's next dashboard poll and waits for its answer. */
    const poll = async () => {
      const answered = kiosk.waitForResponse(isDashboardPoll);
      await kiosk.clock.fastForward(refreshMs);
      return answered;
    };

    // Cut off: the next poll fails, the dashboard stays, marked offline.
    const marker = kiosk.getByText(k.offline, { exact: false });
    await kioskContext.setOffline(true);
    const failed = kiosk.waitForEvent("requestfailed", (request) =>
      request.url().includes("/v1/device/dashboard"),
    );
    await kiosk.clock.fastForward(refreshMs);
    await failed;
    await expect(marker.first()).toBeVisible();
    await expect(original).toBeVisible();

    // A reload while the API is unreachable: the stored dashboard plays.
    await kioskContext.setOffline(false);
    await kiosk.route("**/v1/**", (route) => route.abort());
    await kiosk.reload();
    await expect(original).toBeVisible();
    await expect(marker.first()).toBeVisible();

    // Back: within the backoff (at most one refresh period) it resyncs.
    await kiosk.unroute("**/v1/**");
    let answer = await poll();
    for (let attempt = 0; !answer.ok() && attempt < 3; attempt++)
      answer = await poll();
    await expect(marker).toHaveCount(0);
    await expect(original).toBeVisible();

    // ── 2. Drafts, preview and the copy leave the screen alone ─────────
    const before = await served();
    /** The screen still shows exactly `expected` after its next poll. */
    const unchanged = async (expected: string[], because: string) => {
      expect(await served(), because).toEqual(expected);
      await poll();
      await expect(original, because).toBeVisible();
    };
    page.on("dialog", (dialog) => void dialog.accept());
    const updatePath = `/workspaces/${workspaceId}/dashboards/stores/updates/${requestId}`;
    await page.goto(updatePath);
    await expect(
      page.getByRole("heading", { name: u.groups.choose }),
    ).toBeVisible();
    for (const choice of await page
      .getByRole("radio", { name: u.useTemplate })
      .all())
      await choice.check();
    for (const removal of await page
      .getByRole("radio", { name: u.keep, exact: true })
      .all())
      await removal.check();
    const apply = page.getByRole("button", { name: u.apply });
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect(
      page.getByRole("status").filter({ hasText: u.done.applied }),
    ).toBeVisible();
    await unchanged(before, "after applying drafts");
    expect(await publishedMeasureName(workspaceId, modelId)).toBe(
      OLD_MEASURE_NAME,
    );

    // The model draft: previewed (nothing changes), then published.
    const publishStep = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: u.steps.publish }) });
    await publishStep
      .getByRole("link", { name: u.progress.openDraft })
      .first()
      .click();
    await expect(page).toHaveURL(/\/data\?model=/);
    await page
      .getByRole("region", { name: data.preview, exact: true })
      .getByRole("button", { name: data.preview, exact: true })
      .click();
    await unchanged(before, "after previewing the draft");
    await page.getByRole("button", { name: data.publish, exact: true }).click();
    const impact = page.getByRole("dialog");
    // The confirmation names the screen the publish reaches.
    await expect(impact.getByText("Lobby")).toBeVisible();
    await impact
      .getByRole("button", { name: data.impact.confirm, exact: true })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: data.publishedNotice }),
    ).toBeVisible();
    // Publishing is the moment the screen may change; it still shows the
    // original dashboard.
    const published = await served();
    expect(await servedId()).toBe(dashboardId);

    // The updated copy is made beside it; the screen keeps the original.
    await page.goto(updatePath);
    await page.getByRole("button", { name: u.progress.createCopy }).click();
    await expect(
      page.getByRole("status").filter({ hasText: u.done.copy }),
    ).toBeVisible();
    const copyId = (await page
      .getByRole("link", { name: u.progress.openCopy })
      .getAttribute("href"))!
      .split("/")
      .at(-2)!;
    expect(copyId).not.toBe(dashboardId);
    await unchanged(published, "after creating the updated copy");

    // The swap moves the screen to the copy at its next poll.
    await page.getByRole("button", { name: u.progress.swap }).click();
    await expect(
      page.getByRole("status").filter({ hasText: u.done.swap }),
    ).toBeVisible();
    expect(await servedId()).toBe(copyId);
    await poll();
    await expect(kiosk.getByText("My downloads")).toHaveCount(0);

    // And the swap back returns it.
    await page.getByRole("button", { name: u.progress.switchBack }).click();
    await expect(
      page.getByRole("status").filter({ hasText: u.done.swapBack }),
    ).toBeVisible();
    expect(await servedId()).toBe(dashboardId);
    await poll();
    await expect(original).toBeVisible();

    // ── 3. An archived project keeps its screens playing ───────────────
    const playing = await served();
    const archived = await page.request.post(
      `/v1/workspaces/${workspaceId}/projects/${projectId}/archive`,
      { headers: { origin: ORIGIN } },
    );
    expect(archived.status(), await archived.text()).toBe(200);
    await unchanged(playing, "after archiving the project");
    await expect(marker).toHaveCount(0);

    // Gone from the approval picker. The page needs no code to list it;
    // a second pairing would spend the per-IP pairing budget the other
    // journeys share (PAIRING_RATE_LIMIT).
    await page.goto("/devices/approve");
    await expect(page.locator("#pairing-dashboard")).toBeVisible();
    await expect(
      page.locator("#pairing-dashboard option", { hasText: "App portfolio" }),
    ).toHaveCount(0);
  } finally {
    await kioskContext.close();
  }
});
