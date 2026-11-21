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
  return {
    items: studio.items,
    addType: studio.addMenu.addType,
    save: ((de ? commonDe : commonEn).common as (typeof commonEn)["common"])
      .save,
    kiosk: ((de ? screenDe : screenEn).screen as (typeof screenEn)["screen"])
      .kiosk,
    approval: (
      (de ? workspaceDe : workspaceEn)
        .deviceApproval as (typeof workspaceEn)["deviceApproval"]
    ).connect,
  };
};

/** "Add {type, select, … items {latest items} …}" for the items type. */
const addItemsLabel = (message: string) =>
  message
    .replace(
      /\{type, select,.*\}\}/,
      (select) => /items \{([^}]*)\}/.exec(select)![1]!,
    )
    .trim();

/**
 * The latest-items widget end to end (#810): added in the Studio from a
 * published model with an image field, configured in the inspector,
 * saved, drawn on the canvas as a grid and one at a time, and played by a
 * paired browser screen (the kiosk asks with `features=items`). Images
 * need a custom API sync, which the server suites cover; every item here
 * shows the placeholder tile.
 *
 * Pairing is limited per IP (PAIRING_RATE_LIMIT, shared by every journey):
 * this journey removes its pairing row once the screen is paired, so it
 * spends none of that budget.
 */
test("a latest items widget is added, configured and played on a screen", async ({
  page,
  browser,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = catalogs(locale);
  page.on("dialog", (dialog) => {
    throw new Error(`native dialog: ${dialog.message()}`);
  });
  const { workspaceId } = await startWorkspace(page, locale);
  const titles = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
  const datasetId = await seedReferenceTable(page, workspaceId, {
    name: "Photos",
    key: "photos",
    keyFields: ["id"],
    fields: [
      { id: "id", name: "ID", type: "string", nullable: false },
      { id: "taken_at", name: "Taken", type: "timestamp", nullable: false },
      { id: "title", name: "Title", type: "string", nullable: false },
      {
        id: "photo",
        name: "Photo",
        type: "string",
        nullable: true,
        role: "image",
      },
    ],
    rows: titles.map((title, index) => ({
      id: `p${index}`,
      taken_at: `2026-11-0${index + 1}T08:00:00.000Z`,
      title,
      photo: `https://img.example/${index}.png`,
    })),
  });
  const definition: SemanticModelDefinition = {
    version: 1,
    datasets: [datasetId],
    relationships: [],
    dimensions: [
      {
        id: "taken_at",
        name: "Taken",
        datasetId,
        fieldId: "taken_at",
        timeAlignment: "instant",
      },
      { id: "title", name: "Title", datasetId, fieldId: "title" },
      { id: "photo", name: "Photo", datasetId, fieldId: "photo" },
    ],
    measures: [
      {
        id: "photos",
        name: "Photos",
        kind: "aggregate",
        datasetId,
        aggregate: { id: "photos", name: "Photos", op: "count" },
      },
    ],
  };
  const modelId = await createModel(page, workspaceId, {
    name: "Photos",
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
      data: { name: "Latest photos", slides: [{ widgets: [] }] },
    },
  );
  expect(created.status(), await created.text()).toBe(200);
  const dashboardId = ((await created.json()) as { dashboard: { id: string } })
    .dashboard.id;

  // ── Studio: add, configure, save ──────────────────────────────────────
  await page.goto(
    `/workspaces/${workspaceId}/dashboards/${dashboardId}/studio`,
  );
  await page
    .getByRole("button", { name: addItemsLabel(fill(t.addType, {})) })
    .click();
  const fields = page.locator(".items-fields");
  await expect(fields).toBeVisible();
  await fields
    .getByRole("combobox", { name: t.items.model, exact: true })
    .selectOption({ label: "Photos" });
  await fields
    .getByRole("combobox", { name: t.items.image, exact: true })
    .selectOption({ label: "Photo" });
  await fields
    .getByRole("combobox", { name: t.items.title, exact: true })
    .selectOption({ label: "Title" });
  await fields
    .getByRole("spinbutton", { name: t.items.count, exact: true })
    .fill("3");
  const canvas = page.locator(".sw-items").first();
  const shown = canvas.locator(".sw-items-title");
  await expect(shown).toHaveText(["Echo", "Delta", "Charlie"]);
  await expect(canvas.locator(".sw-items-noimage")).toHaveCount(3);
  // Seconds per item only for one at a time.
  await expect(
    fields.getByRole("spinbutton", { name: t.items.rotateSeconds }),
  ).toHaveCount(0);
  await fields
    .getByRole("combobox", { name: t.items.layout, exact: true })
    .selectOption({ label: t.items.rotate });
  await expect(
    fields.getByRole("spinbutton", { name: t.items.rotateSeconds }),
  ).toBeVisible();
  await expect(shown).toHaveCount(1);
  await expect(shown).toHaveText("Echo");
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
    const asked = kiosk.waitForRequest((request) =>
      request.url().includes("/v1/device/dashboard?"),
    );
    await kiosk.goto("/kiosk");
    const code = (await kiosk
      .getByLabel(t.kiosk.pairingCode)
      .textContent())!.trim();
    await page.goto(`/devices/approve?code=${encodeURIComponent(code)}`);
    await page.locator("#pairing-dashboard").selectOption(dashboardId);
    await page.locator("#pairing-name").fill("Gallery");
    await page.getByRole("button", { name: t.approval }).click();
    await expect(page.getByText("Gallery").first()).toBeVisible();
    expect((await asked).url()).toContain("features=measure_split,items");
    await expect(kiosk.locator(".sw-items-title")).toHaveText("Echo");
    await expect(kiosk.locator(".sw-items-noimage")).toHaveCount(1);
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
