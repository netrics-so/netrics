import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import postgres from "postgres";

const ORIGIN = "http://localhost:3000";

/**
 * The owner connection of the journeys' database (as `pnpm db:migrate`
 * uses it): seeding reaches past the API and row-level security.
 */
const ownerUrl = () =>
  process.env.DATABASE_MIGRATION_URL ??
  "postgres://netrics:netrics@localhost:5433/netrics";

type Json = Record<string, unknown>;
type Widget = Json & { title?: string | null };

/**
 * An App Store portfolio install with an update to offer, without network:
 * a store connection is stored as set up (no credentials are needed until
 * it syncs), the template is installed through the API, and the install is
 * then rewritten as if an older template version ("v0") had built two of
 * its records, which the current template now changes:
 *
 * - the downloads measure was "Downloads (v0)" (the customer kept it): the
 *   template's rename arrives as a model draft;
 * - the proceeds widget was titled "Proceeds (v0)" (kept): a template change;
 * - the downloads widget was titled "Downloads (v0)" and the customer
 *   retitled it "My downloads": a conflict the customer decides.
 *
 * Older versions are what the records' `template_version` 0 says; the
 * install itself stays at the current version, as the schema requires.
 */
export async function installWithUpdate(
  page: Page,
  workspaceId: string,
): Promise<{ requestId: string; dashboardId: string; modelId: string }> {
  const sql = postgres(ownerUrl(), { max: 1, onnotice: () => {} });
  try {
    const [connection] = await sql<{ id: string }[]>`
      insert into connections (workspace_id, connector_id, name, setup_pending)
      values (${workspaceId}, 'app-store-connect', 'Apple team', false)
      returning id`;
    const requestId = randomUUID();
    const response = await page.request.post(
      `/v1/workspaces/${workspaceId}/dashboard-templates/stores`,
      {
        headers: { origin: ORIGIN },
        data: {
          requestId,
          name: "App portfolio",
          connections: [connection!.id],
          groups: [],
        },
      },
    );
    expect(response.status(), await response.text()).toBe(200);
    const installed = (await response.json()) as {
      dashboardId: string;
      models: { downloads: string };
    };
    const modelId = installed.models.downloads,
      dashboardId = installed.dashboardId;

    // The downloads measure, as v0 named it, in the original and the model.
    const rename = (definition: Json) => {
      const measures = definition.measures as Json[];
      measures[0] = { ...measures[0], name: "Downloads (v0)" };
      if (measures[0]!.aggregate)
        measures[0]!.aggregate = {
          ...(measures[0]!.aggregate as Json),
          name: "Downloads (v0)",
        };
      return definition;
    };
    const [modelRecord] = await sql<{ original: { definition: Json } }[]>`
      select original from data_template_records
      where workspace_id = ${workspaceId} and request_id = ${requestId}
        and key = 'model:downloads'`;
    await sql`
      update data_template_records
      set template_version = 0,
          original = ${sql.json({ definition: rename(modelRecord!.original.definition) } as never)}
      where workspace_id = ${workspaceId} and request_id = ${requestId}
        and key = 'model:downloads'`;
    const [model] = await sql<
      { definition: Json; published_version: number }[]
    >`
      select definition, published_version from data_models
      where workspace_id = ${workspaceId} and id = ${modelId}`;
    const definition = sql.json(rename(model!.definition) as never);
    await sql`update data_models set definition = ${definition}
      where workspace_id = ${workspaceId} and id = ${modelId}`;
    await sql`update data_model_releases set definition = ${definition}
      where workspace_id = ${workspaceId} and model_id = ${modelId}
        and version = ${model!.published_version}`;

    // The dashboard's widgets, as v0 titled them, and the customer's title.
    const [dashboardRecord] = await sql<
      {
        original: {
          request: Json & { slides: { widgets: Widget[] }[] };
          widgetKeys: string[];
        };
        widget_keys: Record<string, string>;
      }[]
    >`
      select original, widget_keys from data_template_records
      where workspace_id = ${workspaceId} and request_id = ${requestId}
        and key = 'dashboard:portfolio'`;
    const { request, widgetKeys } = dashboardRecord!.original;
    const widgets = request.slides.flatMap((slide) => slide.widgets);
    const retitle = (key: string, title: string) => {
      const widget = widgets[widgetKeys.indexOf(key)];
      expect(widget, key).toBeDefined();
      widget!.title = title;
    };
    retitle("widget:downloads", "Downloads (v0)");
    retitle("widget:proceeds", "Proceeds (v0)");
    await sql`
      update data_template_records
      set template_version = 0,
          original = ${sql.json({ request, widgetKeys } as never)}
      where workspace_id = ${workspaceId} and request_id = ${requestId}
        and key = 'dashboard:portfolio'`;
    const widgetId = (key: string) =>
      Object.entries(dashboardRecord!.widget_keys).find(
        ([, value]) => value === key,
      )![0];
    await sql`update dashboard_widgets set title = 'My downloads'
      where workspace_id = ${workspaceId} and id = ${widgetId("widget:downloads")}`;
    await sql`update dashboard_widgets set title = 'Proceeds (v0)'
      where workspace_id = ${workspaceId} and id = ${widgetId("widget:proceeds")}`;
    return { requestId, dashboardId, modelId };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
