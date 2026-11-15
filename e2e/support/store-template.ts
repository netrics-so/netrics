import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import postgres from "postgres";

const ORIGIN = "http://localhost:3000";
/** The API itself, as screens reach it (not through the web app). */
const API = "http://localhost:3001";

/**
 * The owner connection of the journeys' database (as `pnpm db:migrate`
 * uses it): seeding reaches past the API and row-level security.
 */
const ownerUrl = () =>
  process.env.DATABASE_MIGRATION_URL ??
  "postgres://netrics:netrics@localhost:5433/netrics";

type Json = Record<string, unknown>;

/** The template's downloads measure, and its name in the older version. */
const DOWNLOADS_MEASURE = "downloads";
export const OLD_MEASURE_NAME = "Downloads (v0)";

/**
 * The downloads measure's name in the model's published release, read past
 * the API: the definition screens and dashboards use until a publish.
 */
export async function publishedMeasureName(
  workspaceId: string,
  modelId: string,
): Promise<unknown> {
  const sql = postgres(ownerUrl(), { max: 1, onnotice: () => {} });
  try {
    const [release] = await sql<{ definition: Json }[]>`
      select r.definition from data_model_releases r
      join data_models m on m.id = r.model_id and m.workspace_id = r.workspace_id
      where m.workspace_id = ${workspaceId} and m.id = ${modelId}
        and r.version = m.published_version`;
    return (release!.definition.measures as Json[]).find(
      (measure) => measure.id === DOWNLOADS_MEASURE,
    )?.name;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * A screen paired the way the TV app pairs (code, approve, poll), showing
 * `dashboardId`. Answers a reader of the dashboard the screen is served.
 */
export async function pairScreen(
  page: Page,
  workspaceId: string,
  input: { name: string; dashboardId: string },
): Promise<() => Promise<string | null>> {
  const created = await page.request.post(`${API}/v1/device/pairings`, {
    data: { platform: { os: "tvos", osVersion: "27.0" } },
  });
  expect(created.status(), await created.text()).toBe(200);
  const pairing = (await created.json()) as {
    pairingId: string;
    code: string;
    pollSecret: string;
  };
  const approved = await page.request.post(
    `/v1/workspaces/${workspaceId}/devices/approve`,
    {
      headers: { origin: ORIGIN },
      data: {
        code: pairing.code,
        name: input.name,
        dashboardId: input.dashboardId,
      },
    },
  );
  expect(approved.status(), await approved.text()).toBe(200);
  const polled = await page.request.post(`${API}/v1/device/pairings/poll`, {
    data: { pairingId: pairing.pairingId, pollSecret: pairing.pollSecret },
  });
  expect(polled.status(), await polled.text()).toBe(200);
  const { credentials } = (await polled.json()) as {
    credentials: { accessToken: string };
  };
  return async () => {
    const response = await page.request.get(
      `${API}/v1/device/dashboard?schema=3`,
      { headers: { authorization: `Bearer ${credentials.accessToken}` } },
    );
    expect(response.status(), await response.text()).toBe(200);
    const body = (await response.json()) as {
      dashboard: { id: string } | null;
    };
    return body.dashboard?.id ?? null;
  };
}
type Widget = Json & { title?: string | null };

/**
 * An App Store portfolio install with an update to offer, without network:
 * a store connection is stored as set up (no credentials are needed until
 * it syncs), the template is installed through the API, and the install is
 * then rewritten as if an older template version ("v0") had built two of
 * its records, which the current template now changes:
 *
 * - the downloads measure was OLD_MEASURE_NAME (the customer kept it): the
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
      const measure = (definition.measures as Json[]).find(
        (candidate) => candidate.id === DOWNLOADS_MEASURE,
      );
      expect(measure, `measure ${DOWNLOADS_MEASURE}`).toBeDefined();
      measure!.name = OLD_MEASURE_NAME;
      if (measure!.aggregate)
        measure!.aggregate = {
          ...(measure!.aggregate as Json),
          name: OLD_MEASURE_NAME,
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
