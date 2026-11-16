import path from "node:path";
import { expect, test } from "@playwright/test";
import { commonDe } from "../apps/web/src/messages/common/de.ts";
import { commonEn } from "../apps/web/src/messages/common/en.ts";
import { studioDe } from "../apps/web/src/messages/studio/de.ts";
import { studioEn } from "../apps/web/src/messages/studio/en.ts";
import type { Locale } from "./support/labels.ts";
import { ORIGIN } from "./support/origin.ts";
import { startWorkspace } from "./support/session.ts";
import { installWithConnections } from "./support/store-template.ts";

const LOGO = path.join(
  import.meta.dirname,
  "..",
  "apps",
  "server",
  "src",
  "images",
  "fixtures",
  "plain.png",
);

/**
 * A slide about one app (#707): in the Studio's slide settings the editor
 * uploads a header logo for the slide and scopes it to one app of the App
 * portfolio; after saving, the slide keeps both, and its header shows the
 * slide's logo.
 */
test("a slide is scoped to one app and shows its own logo", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const rail = (locale === "de" ? studioDe : studioEn).studio.rail;
  const common = (locale === "de" ? commonDe : commonEn).common;

  const { workspaceId } = await startWorkspace(page, locale);
  const { dashboardId, connections } = await installWithConnections(
    page,
    workspaceId,
  );
  const app = `${connections.apple}:1234567890`;
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(
    `/workspaces/${workspaceId}/dashboards/${dashboardId}/studio`,
  );

  // The slide's settings show while no widget is selected.
  const logo = page.getByRole("combobox", { name: rail.logo, exact: true });
  await expect(logo).toBeVisible();
  await page.locator("#slide-logo-file").setInputFiles(LOGO);
  await expect(logo).not.toHaveValue("");
  const imageId = await logo.inputValue();

  const scope = page.getByRole("group", { name: rail.scope, exact: true });
  await scope.getByRole("textbox", { name: "App", exact: true }).fill(app);
  await scope.getByRole("textbox", { name: "App", exact: true }).press("Enter");
  await expect(scope.getByText(app)).toBeVisible();

  // The header of the slide shows its own logo.
  await expect(
    page.locator(`.editor-canvas .studio-logo[src*="${imageId}"]`),
  ).toBeVisible();

  await page.getByRole("button", { name: common.save, exact: true }).click();
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/v1/workspaces/${workspaceId}/dashboards/${dashboardId}`,
        { headers: { origin: ORIGIN } },
      );
      const { dashboard } = (await response.json()) as {
        dashboard: {
          slides: { logoImageId: string | null; scope: unknown }[];
        };
      };
      return dashboard.slides[0];
    })
    .toMatchObject({
      logoImageId: imageId,
      scope: { app: { kind: "values", values: [app] } },
    });

  // The dashboard's page shows the slide with its logo.
  await page.goto(`/workspaces/${workspaceId}/dashboards/${dashboardId}`);
  await expect(
    page.locator(`.studio-header .studio-logo[src*="${imageId}"]`),
  ).toBeVisible();
});
