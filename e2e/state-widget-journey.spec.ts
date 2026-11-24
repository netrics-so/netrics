import { expect, test } from "@playwright/test";
import postgres from "postgres";
import type { SemanticModelDefinition } from "@netrics/domain";

import { commonDe } from "../apps/web/src/messages/common/de.ts";
import { commonEn } from "../apps/web/src/messages/common/en.ts";
import { screenDe } from "../apps/web/src/messages/screen/de.ts";
import { screenEn } from "../apps/web/src/messages/screen/en.ts";
import { studioDe } from "../apps/web/src/messages/studio/de.ts";
import { studioEn } from "../apps/web/src/messages/studio/en.ts";
import { workspaceDe } from "../apps/web/src/messages/workspace/de.ts";
import { workspaceEn } from "../apps/web/src/messages/workspace/en.ts";
import { createModel } from "./support/api.ts";
import { fill, type Locale } from "./support/labels.ts";
import { ORIGIN } from "./support/origin.ts";
import { seedReferenceTable, startWorkspace } from "./support/session.ts";
import { ownerUrl } from "./support/store-template.ts";

const catalogs = (locale: Locale) => {
  const de = locale === "de";
  const studio = (de ? studioDe : studioEn)
    .studio as (typeof studioEn)["studio"];
  const screen = (de ? screenDe : screenEn)
    .screen as (typeof screenEn)["screen"];
  return {
    fields: studio.state,
    addType: studio.addMenu.addType,
    words: screen.state,
    save: ((de ? commonDe : commonEn).common as (typeof commonEn)["common"])
      .save,
    kiosk: screen.kiosk,
    approval: (
      (de ? workspaceDe : workspaceEn)
        .deviceApproval as (typeof workspaceEn)["deviceApproval"]
    ).connect,
  };
};

/** "Add {type, select, … state {service status} …}" for the state type. */
const addStateLabel = (message: string) =>
  message
    .replace(
      /\{type, select,.*\}\}/,
      (select) => /state \{([^}]*)\}/.exec(select)![1]!,
    )
    .trim();

/**
 * The state widget end to end (#875): added in the Studio from a published
 * model with a state field, drawn as a list (problems first, every state a
 * word and an icon), mapped (an unknown source value given a state), made a
 * single item, saved, and played by a paired browser screen (the kiosk asks
 * with `features=state`).
 *
 * Pairing is limited per IP (PAIRING_RATE_LIMIT, shared by every journey):
 * this journey removes its pairing row once the screen is paired.
 */
test("a state widget is added, configured and played on a screen", async ({
  page,
  browser,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = catalogs(locale);
  page.on("dialog", (dialog) => {
    throw new Error(`native dialog: ${dialog.message()}`);
  });
  const { workspaceId } = await startWorkspace(page, locale);
  const services: Array<[string, string, boolean]> = [
    ["web", "up", false],
    ["api", "failed", false],
    ["site", "up", true],
    ["db", "degraded", false],
  ];
  const datasetId = await seedReferenceTable(page, workspaceId, {
    name: "Services",
    key: "services",
    keyFields: ["id"],
    fields: [
      { id: "id", name: "ID", type: "string", nullable: false },
      { id: "service", name: "Service", type: "string", nullable: false },
      { id: "state", name: "State", type: "string", nullable: false },
      { id: "changed_at", name: "Changed", type: "timestamp", nullable: true },
      {
        id: "rolled_back",
        name: "Rolled back",
        type: "boolean",
        nullable: true,
      },
    ],
    rows: services.map(([service, state, rolled], index) => ({
      id: `s${index}`,
      service,
      state,
      changed_at: `2026-11-0${index + 1}T08:00:00.000Z`,
      rolled_back: rolled,
    })),
  });
  const definition: SemanticModelDefinition = {
    version: 1,
    datasets: [datasetId],
    relationships: [],
    dimensions: [
      { id: "service", name: "Service", datasetId, fieldId: "service" },
      { id: "state", name: "State", datasetId, fieldId: "state" },
      {
        id: "changed_at",
        name: "Changed",
        datasetId,
        fieldId: "changed_at",
        timeAlignment: "instant",
      },
      {
        id: "rolled_back",
        name: "Rolled back",
        datasetId,
        fieldId: "rolled_back",
      },
    ],
    measures: [
      {
        id: "services",
        name: "Services",
        kind: "aggregate",
        datasetId,
        aggregate: { id: "services", name: "Services", op: "count" },
      },
    ],
  };
  const modelId = await createModel(page, workspaceId, {
    name: "Services",
    definition,
  });
  const published = await page.request.post(
    `/v1/workspaces/${workspaceId}/data/models/${modelId}/publish`,
    { headers: { origin: ORIGIN }, data: { version: 1 } },
  );
  expect(published.status(), await published.text()).toBe(200);
  const created = await page.request.post(
    `/v1/workspaces/${workspaceId}/dashboards`,
    {
      headers: { origin: ORIGIN },
      data: { name: "Operations", slides: [{ widgets: [] }] },
    },
  );
  expect(created.status(), await created.text()).toBe(200);
  const dashboardId = ((await created.json()) as { dashboard: { id: string } })
    .dashboard.id;

  // ── Studio: add, see the list, map, single item, save ─────────────────
  await page.goto(
    `/workspaces/${workspaceId}/dashboards/${dashboardId}/studio`,
  );
  await page
    .getByRole("button", { name: addStateLabel(fill(t.addType, {})) })
    .click();
  const fields = page.locator(".state-fields");
  await expect(fields).toBeVisible();
  await expect(
    fields.getByRole("combobox", { name: t.fields.model, exact: true }),
  ).toHaveValue(modelId);
  await expect(
    fields.getByRole("combobox", { name: t.fields.state, exact: true }),
  ).toHaveValue("state");
  const canvas = page.locator(".sw-svc").first();
  const rows = canvas.locator(".sw-svc-row");
  // Not healthy first, each a word and an icon.
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toHaveAttribute(
    "aria-label",
    `api: ${t.words.failed}`,
  );
  await expect(rows.nth(1)).toHaveAttribute(
    "aria-label",
    `db: ${t.words.unknown}`,
  );
  await expect(rows.nth(2)).toHaveAttribute(
    "aria-label",
    `site: ${t.words.up} · ${t.words.rolledBack}`,
  );
  await expect(canvas.locator(".sw-svc-icon")).toHaveCount(4);
  // "degraded" is no built-in word: map it to down.
  await fields
    .getByRole("combobox", { name: "degraded", exact: true })
    .selectOption({ label: t.words.down });
  await expect(rows.nth(0)).toHaveAttribute(
    "aria-label",
    `db: ${t.words.down}`,
  );
  // One item at a large size.
  await fields
    .getByRole("combobox", { name: t.fields.layout, exact: true })
    .selectOption({ label: t.fields.single });
  // No item chosen: a summary of every item, the worst state first.
  await expect(canvas.locator(".sw-svc-word")).toHaveText(
    fill(t.words.summaryWorst, {
      count: 1,
      total: 4,
      state: t.words.lowerDown,
    }),
  );
  await fields
    .getByRole("combobox", { name: t.fields.item, exact: true })
    .fill("site");
  // The name is committed on leaving the field (it may hold spaces).
  await fields
    .getByRole("combobox", { name: t.fields.item, exact: true })
    .press("Tab");
  await expect(canvas.locator(".sw-svc-word")).toHaveText(t.words.up);
  await expect(canvas.locator(".sw-svc-single")).toHaveAttribute(
    "aria-label",
    `site: ${t.words.up} · ${t.words.rolledBack}`,
  );
  const saved = page.waitForResponse(
    (response) =>
      response.url().includes(`/dashboards/${dashboardId}`) &&
      response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: t.save, exact: true }).click();
  expect((await saved).status()).toBe(200);

  // ── A paired browser screen plays it ──────────────────────────────────
  const kioskContext = await browser.newContext({
    locale: locale === "de" ? "de-DE" : "en-US",
    viewport: { width: 1920, height: 1080 },
  });
  try {
    const kiosk = await kioskContext.newPage();
    const asked = kiosk.waitForResponse(
      (response) =>
        response.url().includes("/v1/device/dashboard?") &&
        response.status() === 200,
    );
    await kiosk.goto("/kiosk");
    const code = (await kiosk
      .getByLabel(t.kiosk.pairingCode)
      .textContent())!.trim();
    await page.goto(`/devices/approve?code=${encodeURIComponent(code)}`);
    await page.locator("#pairing-dashboard").selectOption(dashboardId);
    await page.locator("#pairing-name").fill("Operations");
    await page.getByRole("button", { name: t.approval }).click();
    await expect(page.getByText("Operations").first()).toBeVisible();
    const served = await asked;
    expect(served.url()).toContain("features=measure_split,items,state");
    // Paired, the kiosk speaks the payload's language (the workspace's
    // screen language), whatever the editor's.
    const screen = catalogs(
      ((await served.json()) as { locale: Locale }).locale,
    );
    await expect(kiosk.locator(".sw-svc-word")).toHaveText(screen.words.up);
    await expect(kiosk.locator(".sw-svc-icon")).toHaveCount(1);
  } finally {
    await kioskContext.close();
    // Give back the pairing (PAIRING_RATE_LIMIT is per IP, shared).
    const sql = postgres(ownerUrl(), { max: 1, onnotice: () => {} });
    try {
      await sql`delete from device_pairings
        where workspace_id = ${workspaceId}`;
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
});
